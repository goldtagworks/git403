//! git 실행기: 명령 구성(환경·로캘·프로세스 그룹)과 짧은 조회. 긴 작업의 프로세스 수명은 `job`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::process::Stdio;

use tokio::process::Command;
use tokio::sync::mpsc;

use crate::job::run_job;
use crate::{Error, JobEvent, JobHandle, Result};

#[derive(Debug, Clone)]
pub struct GitRunner {
    git: PathBuf,
    /// 모든 git 프로세스에 넣을 환경 변수 (예: 인증 입력용 GIT_ASKPASS)
    envs: Vec<(String, String)>,
    /// 로그인 셸에서 얻은 PATH (앱 시작 뒤 백그라운드에서 한 번 채워진다). 복제본끼리 공유한다.
    path: Arc<OnceLock<String>>,
}

impl Default for GitRunner {
    fn default() -> Self {
        Self { git: PathBuf::from("git"), envs: Vec::new(), path: Arc::default() }
    }
}

impl GitRunner {
    pub fn new(git: impl Into<PathBuf>) -> Self {
        Self { git: git.into(), envs: Vec::new(), path: Arc::default() }
    }

    pub fn with_env(mut self, key: &str, value: impl Into<String>) -> Self {
        self.envs.push((key.to_owned(), value.into()));
        self
    }

    /// 이 실행기가 쓰는 git 실행 파일 경로 (`rebase`의 `exec` 줄처럼 git이 다시 git을 부를 때 쓴다).
    pub fn git_path(&self) -> &Path {
        &self.git
    }

    /// PATH 보정값을 나중에 채울 수 있는 공유 칸. 채우면 이후 실행하는 모든 프로세스가 쓴다.
    pub fn path_cell(&self) -> Arc<OnceLock<String>> {
        self.path.clone()
    }

    /// 보정된 PATH (아직 없으면 None)
    pub fn path_override(&self) -> Option<&str> {
        self.path.get().map(String::as_str)
    }

    fn command(&self, repo: &Path, args: &[&str]) -> Command {
        let mut cmd = Command::new(&self.git);
        // (테스트처럼 git 대신 다른 실행 파일을 쓰면 `-c` 설정을 붙이지 않는다)
        let is_git = Path::new(&self.git).file_stem().is_some_and(|s| s == "git");
        // 한글 같은 비ASCII 경로를 `"\355\225..."`로 인용하지 않고 그대로 출력하게 한다 (파서가 경로를 깨뜨리지 않게).
        if is_git {
            cmd.args(["-c", "core.quotepath=false"]);
        }
        // macOS 파일 시스템은 한글 이름을 자모 분리형(NFD)으로 돌려준다. 저장소 설정과 무관하게
        // 완성형(NFC)으로 기록해 Windows에서 자모가 갈라져 보이지 않게 한다.
        #[cfg(target_os = "macos")]
        if is_git {
            cmd.args(["-c", "core.precomposeunicode=true"]);
        }
        // 편집기를 띄우지 않는다 (stdin이 없어 멈춘다): 머지·squash·`--continue` 메시지는 기본값을 그대로 쓴다.
        cmd.args(args).env("LC_ALL", "C").env("GIT_EDITOR", "true").env("GIT_MERGE_AUTOEDIT", "no");
        self.configure(cmd, repo)
    }

    /// 공통 설정: 작업 폴더, 프롬프트 차단, 환경 변수, 입출력 파이프.
    fn configure(&self, mut cmd: Command, repo: &Path) -> Command {
        cmd.current_dir(repo)
            // 자격 증명 프롬프트로 멈추지 않게 한다 (askpass는 추후 UI로 연결).
            .env("GIT_TERMINAL_PROMPT", "0")
            .envs(self.envs.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(p) = self.path.get() {
            cmd.env("PATH", p);
        }
        // 새 프로세스 그룹: 취소할 때 셸·difftool이 띄운 손자 프로세스까지 함께 끝낸다
        #[cfg(unix)]
        cmd.process_group(0);
        cmd
    }

    /// 셸 명령 한 줄(`sh -c` / `cmd /C`). 사용자 정의 명령용. 로캘은 건드리지 않는다.
    fn shell_command(&self, repo: &Path, script: &str) -> Command {
        #[cfg(windows)]
        let cmd = {
            let mut c = Command::new("cmd");
            // cmd는 Rust의 인자 인용 규칙을 모르므로 그대로 넘기고, 바깥을 한 번 더 감싼다.
            c.arg("/C").raw_arg(format!("\"{script}\""));
            c
        };
        #[cfg(not(windows))]
        let cmd = {
            let mut c = Command::new("sh");
            c.arg("-c").arg(script);
            c
        };
        self.configure(cmd, repo)
    }

    /// 짧은 조회용: 끝날 때까지 기다렸다가 stdout 전체를 돌려준다.
    pub async fn output(&self, repo: &Path, args: &[&str]) -> Result<Vec<u8>> {
        self.output_allow(repo, args, &[]).await
    }

    /// 읽기 전용 조회(status·diff 등): `GIT_OPTIONAL_LOCKS=0`으로 index 갱신·`index.lock`을 잡지 않는다.
    /// 쓰기 명령과 동시에 돌아도 서로 막지 않게, 조회는 `output` 대신 이것을 쓴다.
    pub async fn query(&self, repo: &Path, args: &[&str]) -> Result<Vec<u8>> {
        self.output_env(repo, args, &[("GIT_OPTIONAL_LOCKS", "0")]).await
    }

    /// 이번 실행에만 환경 변수를 더해서 실행한다 (예: interactive rebase의 편집기 대체).
    pub async fn output_env(&self, repo: &Path, args: &[&str], envs: &[(&str, &str)]) -> Result<Vec<u8>> {
        let mut cmd = self.command(repo, args);
        cmd.envs(envs.iter().copied());
        let out = cmd.output().await?;
        if !out.status.success() {
            return Err(Error::Exit {
                code: out.status.code(),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        Ok(out.stdout)
    }

    /// stdin으로 `input`을 넘기고 끝날 때까지 기다린다 (`git apply`, `git commit -F -`).
    pub async fn output_stdin(&self, repo: &Path, args: &[&str], input: &[u8]) -> Result<Vec<u8>> {
        use tokio::io::AsyncWriteExt;
        let mut cmd = self.command(repo, args);
        cmd.stdin(Stdio::piped());
        let mut child = cmd.spawn()?;
        let mut stdin = child.stdin.take().expect("piped stdin");
        stdin.write_all(input).await?;
        drop(stdin);
        let out = child.wait_with_output().await?;
        if !out.status.success() {
            return Err(Error::Exit {
                code: out.status.code(),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        Ok(out.stdout)
    }

    /// `output`과 같지만 `ok_codes`에 있는 종료 코드도 성공으로 본다 (예: `diff --no-index`의 1).
    pub async fn output_allow(&self, repo: &Path, args: &[&str], ok_codes: &[i32]) -> Result<Vec<u8>> {
        let out = self.command(repo, args).output().await?;
        let allowed = out.status.code().is_some_and(|c| ok_codes.contains(&c));
        if !out.status.success() && !allowed {
            return Err(Error::Exit {
                code: out.status.code(),
                stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            });
        }
        Ok(out.stdout)
    }

    /// 오래 걸리는 작업용 (pull, fetch, push…).
    /// 즉시 반환하고, 진행 이벤트는 `events`로 흘려보낸다.
    pub fn spawn(
        &self,
        repo: &Path,
        args: &[&str],
        events: mpsc::UnboundedSender<JobEvent>,
    ) -> Result<(JobHandle, tokio::task::JoinHandle<Result<()>>)> {
        run_job(self.command(repo, args), events)
    }

    /// 사용자 입력 없이 도는 백그라운드 작업(자동 fetch)용 `spawn`: GIT_ASKPASS·SSH_ASKPASS를 제거해 인증 창이
    /// 뜨지 않게 하고(실패로 끝남), `ssh_batch`면 `GIT_SSH_COMMAND="ssh -o BatchMode=yes"`로 ssh 암호 질문도 막는다.
    /// 호출 측은 사용자가 `core.sshCommand`·`GIT_SSH_COMMAND`를 설정해 뒀으면 `ssh_batch=false`로 존중한다.
    pub fn spawn_batch(
        &self,
        repo: &Path,
        args: &[&str],
        ssh_batch: bool,
        events: mpsc::UnboundedSender<JobEvent>,
    ) -> Result<(JobHandle, tokio::task::JoinHandle<Result<()>>)> {
        let mut cmd = self.command(repo, args);
        cmd.env_remove("GIT_ASKPASS").env_remove("SSH_ASKPASS").env_remove("SSH_ASKPASS_REQUIRE");
        if ssh_batch {
            cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
        }
        run_job(cmd, events)
    }

    /// `spawn`과 같은 이벤트·취소 규칙으로 셸 명령을 실행한다 (사용자 정의 명령).
    pub fn spawn_shell(
        &self,
        repo: &Path,
        script: &str,
        events: mpsc::UnboundedSender<JobEvent>,
    ) -> Result<(JobHandle, tokio::task::JoinHandle<Result<()>>)> {
        run_job(self.shell_command(repo, script), events)
    }
}

/// 사용자가 준 이름·rev·URL이 `-`로 시작하면 git이 옵션으로 읽는다 (예: `--upload-pack=...`). 그런 값은 거부한다.
pub fn reject_option(arg: &str) -> Result<&str> {
    if arg.trim_start().starts_with('-') {
        return Err(gc_i18n::coded!("git.badArg", "invalid argument (must not start with '-'): {arg}", arg = arg).into());
    }
    Ok(arg)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn query는_optional_locks를_끈다() {
        let dir = tempfile_dir("query");
        let git = GitRunner::default();
        let args = ["-c", "alias.e=!echo lock=$GIT_OPTIONAL_LOCKS", "e"];
        assert_eq!(String::from_utf8_lossy(&git.query(&dir, &args).await.unwrap()).trim(), "lock=0");
        assert_eq!(String::from_utf8_lossy(&git.output(&dir, &args).await.unwrap()).trim(), "lock=");
    }

    #[tokio::test]
    async fn 편집기를_끄고_한글_경로를_인용하지_않는다() {
        let dir = tempfile_dir("env");
        let git = GitRunner::default();
        let args = ["-c", "alias.e=!echo $GIT_EDITOR $GIT_MERGE_AUTOEDIT", "e"];
        assert_eq!(String::from_utf8_lossy(&git.output(&dir, &args).await.unwrap()).trim(), "true no");
        git.output(&dir, &["init", "-q"]).await.unwrap();
        std::fs::write(dir.join("한글.txt"), "x").unwrap();
        git.output(&dir, &["add", "-A"]).await.unwrap();
        assert_eq!(String::from_utf8(git.output(&dir, &["ls-files"]).await.unwrap()).unwrap(), "한글.txt\n");
    }

    #[test]
    fn 옵션처럼_보이는_인자는_거부한다() {
        assert!(reject_option("--upload-pack=x").is_err());
        assert!(reject_option(" -x").is_err());
        assert_eq!(reject_option("main").unwrap(), "main");
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn 저장소_설정이_꺼져_있어도_한글_파일_이름을_완성형으로_기록한다() {
        let dir = tempfile_dir("nfc");
        let git = GitRunner::default();
        git.output(&dir, &["init", "-q"]).await.unwrap();
        git.output(&dir, &["config", "core.precomposeunicode", "false"]).await.unwrap();
        // NFD(자모 분리) 이름: ㅎ ㅏ ㄴ ㄱ ㅡ ㄹ
        std::fs::write(dir.join("\u{1112}\u{1161}\u{11ab}\u{1100}\u{1173}\u{11af}.txt"), "x").unwrap();
        git.output(&dir, &["add", "-A"]).await.unwrap();
        let out = git.output(&dir, &["ls-files", "-z"]).await.unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), "한글.txt\0");
    }

    fn tempfile_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gc-runner-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
}
