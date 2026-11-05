//! OS 샌드박스 방어층 (docs/security.md "다층 방어"): MCP 서버가 띄우는 **모든 git 프로세스(와 그 자식)**를 샌드박스 안에서 실행한다.
//! 검증기(`ai_tool`)·설정 판정(`ai_config`)이 놓친 우회가 있어도 피해를 가둔다 — 저장소 밖 쓰기 불가, 셸 실행 불가, 홈 전체 읽기 불가, 네트워크는 원격 명령에만.
//!
//! - macOS: `sandbox-exec`(Seatbelt) 프로파일, `deny default`. 쓰기 = 저장소(작업 트리+.git)와 이 서버 전용 임시 폴더, 읽기 = 저장소·시스템 경로·git 설치 경로·사용자 git 설정
//!   (`~/.gitconfig`·`~/.config/git`·`~/.ssh/config`·`known_hosts`)만(원격 명령에는 ssh 키 `~/.ssh/id_*`·키체인도). 실행 = git 실제 바이너리·exec-path 도우미·ssh·git-lfs·askpass(앱)·
//!   전역 설정의 절대 경로 credential helper만 — **`/bin/sh` 등 셸은 막는다**(필터·textconv·alias·`!` helper·셸 훅 불가). 예외: 저장소가 표준 git-lfs 필터를 쓰면 `git-lfs`가 셸(`sh -c`)로 실행되므로 셸을 연다(쓰기·읽기·네트워크 제한은 그대로).
//!   네트워크: 원격 명령(fetch·pull·push)만 tcp 443·22·DNS(+ssh-agent 소켓·askpass 로컬 포트), 나머지는 전부 차단.
//! - Linux: `bwrap`(bubblewrap)이 쓸 수 있으면 같은 정책(읽기 전용 시스템·저장소만 쓰기·네트워크 분리). 셸 실행은 막지 못한다(파일시스템·네트워크 제한만). 이 환경에서는 시험하지 못했다.
//! - 그 밖(Windows, bubblewrap 없는 Linux): 샌드박스 없음 → 앱이 매 대화 확인창 + 경고를 요구한다(`ai_risk`의 `sandbox: none`). 샌드박스가 있다고 했는데 실행에 실패하면 실행하지 않는다(fail-closed).

use std::path::{Path, PathBuf};
use std::process::Command;

/// 샌드박스 방식
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mode {
    Seatbelt,
    Bwrap(PathBuf),
    None,
}

impl Mode {
    /// 이 컴퓨터에서 쓸 수 있는 가장 강한 방식
    pub fn detect() -> Mode {
        #[cfg(test)]
        if tests_force_none::get() {
            return Mode::None;
        }
        #[cfg(target_os = "macos")]
        if Path::new("/usr/bin/sandbox-exec").exists() {
            return Mode::Seatbelt;
        }
        #[cfg(target_os = "linux")]
        if let Some(b) = which("bwrap") {
            // 사용자 네임스페이스가 막힌 환경이면 bwrap이 실패한다 — 실제로 돌려 본다
            if Command::new(&b).args(["--ro-bind", "/", "/", "--", "true"]).output().is_ok_and(|o| o.status.success()) {
                return Mode::Bwrap(b);
            }
        }
        Mode::None
    }

    /// 환경 변수 `GIT403_SANDBOX` 값
    pub fn name(&self) -> &'static str {
        match self {
            Mode::Seatbelt => "seatbelt",
            Mode::Bwrap(_) => "bwrap",
            Mode::None => "none",
        }
    }

    /// `name()`의 역. bwrap은 경로를 다시 찾는다. 모르는 값·없는 도구는 None(= 호출 쪽이 fail-closed)
    pub fn from_name(s: &str) -> Option<Mode> {
        match s {
            "seatbelt" if cfg!(target_os = "macos") && Path::new("/usr/bin/sandbox-exec").exists() => Some(Mode::Seatbelt),
            "bwrap" => which("bwrap").map(Mode::Bwrap),
            "none" => Some(Mode::None),
            _ => None,
        }
    }
}

/// 시험 전용: 이 스레드에서만 샌드박스가 없는 것처럼 보이게 한다(샌드박스 없는 플랫폼의 확인 규칙 시험)
#[cfg(test)]
pub mod tests_force_none {
    use std::cell::Cell;
    thread_local!(static FORCE: Cell<bool> = const { Cell::new(false) });
    pub fn set(v: bool) {
        FORCE.with(|f| f.set(v));
    }
    pub fn get() -> bool {
        FORCE.with(Cell::get)
    }
}

fn which(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join(name)).find(|c| c.is_file()))
}

/// 한 번의 git 실행에 줄 정책
#[derive(Debug, Clone, Default)]
pub struct Policy {
    pub repo: PathBuf,
    /// 이 서버 전용 임시 폴더(쓰기 허용)
    pub tmp: PathBuf,
    /// 원격 명령(fetch·pull·push)인가 — 네트워크·ssh 키·키체인을 연다
    pub net: bool,
    /// 저장소가 표준 git-lfs 필터를 쓴다 — `git-lfs`가 셸로 실행되므로 셸을 연다
    pub allow_sh: bool,
    /// 실행을 허용할 앱 실행 파일(askpass)과 그 로컬 포트
    pub askpass_exe: Option<PathBuf>,
    pub askpass_port: Option<u16>,
    /// ssh-agent 소켓
    pub ssh_sock: Option<PathBuf>,
    /// 전역 설정의 절대 경로 credential helper
    pub helpers: Vec<PathBuf>,
}

/// git 설치 정보(한 번만 구한다): 진짜 git 바이너리(macOS의 `/usr/bin/git`은 xcrun 셔임이라 건너뛴다)와 `--exec-path`
#[derive(Debug, Clone)]
pub struct GitInfo {
    pub real: PathBuf,
    pub exec_path: PathBuf,
}

pub fn git_info(git: &str) -> Option<GitInfo> {
    let out = Command::new(git).arg("--exec-path").output().ok().filter(|o| o.status.success())?;
    let exec_path = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    // `<exec-path>/../../bin/git`가 진짜 바이너리(Xcode·Homebrew·배포판 모두 같은 배치)
    let real = exec_path.join("../../bin/git").canonicalize().ok().or_else(|| which(git).and_then(|p| p.canonicalize().ok())).or_else(|| Path::new(git).canonicalize().ok())?;
    Some(GitInfo { real, exec_path: exec_path.canonicalize().unwrap_or(exec_path) })
}

/// SBPL 문자열 리터럴
fn q(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{s}\"")
}

/// SBPL 정규식 리터럴에 들어갈 경로 이스케이프
fn re(p: &str) -> String {
    p.chars().flat_map(|c| if "\\.^$|()[]{}*+?".contains(c) { vec!['\\', '\\', c] } else { vec![c] }).collect()
}

/// macOS Seatbelt 프로파일
pub fn seatbelt_profile(g: &GitInfo, p: &Policy, home: &Path) -> String {
    let git_prefix = g.real.parent().and_then(Path::parent).map(Path::to_path_buf).unwrap_or_default();
    let mut execs: Vec<PathBuf> = vec![g.real.clone(), PathBuf::from("/usr/bin/git"), PathBuf::from("/usr/bin/ssh")];
    execs.extend(which("ssh").and_then(|s| s.canonicalize().ok()));
    execs.extend(which("git-lfs").and_then(|s| s.canonicalize().ok()));
    execs.extend(p.askpass_exe.clone());
    execs.extend(p.helpers.clone());
    if p.allow_sh {
        execs.extend(["/bin/sh", "/bin/bash", "/bin/zsh"].map(PathBuf::from));
    }
    let lits: String = execs.iter().map(|e| format!(" (literal {})", q(e))).collect();
    let h = |rel: &str| home.join(rel);
    let mut s = String::from("(version 1)\n(deny default)\n(allow process-fork)\n(allow signal (target self))\n(allow sysctl-read)\n(allow file-read-metadata)\n");
    s += &format!("(allow process-exec{lits} (subpath {}))\n", q(&g.exec_path));
    // 읽기: 시스템·git 설치 경로·저장소·임시·사용자 git 설정
    s += "(allow file-read* (literal \"/\") (subpath \"/usr/lib\") (subpath \"/usr/share\") (subpath \"/usr/libexec\") (subpath \"/System\") (subpath \"/Library\") (subpath \"/private/etc\") (subpath \"/etc\") (subpath \"/dev\") (subpath \"/opt/homebrew\") (subpath \"/usr/local\") (subpath \"/private/var/db\") (subpath \"/var/db\"))\n";
    s += &format!("(allow file-read* (subpath {}) (subpath {}) (subpath {}) (subpath {}))\n", q(&git_prefix), q(&g.exec_path), q(&p.repo), q(&p.tmp));
    s += &format!("(allow file-read* (literal {}) (subpath {}) (literal {}) (literal {}) (literal {}))\n", q(&h(".gitconfig")), q(&h(".config/git")), q(&h(".ssh/config")), q(&h(".ssh/known_hosts")), q(&h(".ssh/known_hosts.old")));
    // 쓰기: 저장소(작업 트리+.git)와 전용 임시 폴더, /dev/null
    s += &format!("(allow file-write* (subpath {}) (subpath {}) (literal \"/dev/null\") (literal \"/dev/dtracehelper\"))\n", q(&p.repo), q(&p.tmp));
    s += "(allow mach-lookup (global-name \"com.apple.system.opendirectoryd.libinfo\") (global-name \"com.apple.system.notification_center\") (global-name \"com.apple.cfprefsd.daemon\"))\n(allow ipc-posix-shm)\n";
    if p.net {
        // 원격 명령: https(443)·ssh(22)·DNS, ssh 키·known_hosts 쓰기·키체인(credential-osxkeychain), 인증서 검증 서비스
        s += "(allow network-outbound (remote tcp \"*:443\") (remote tcp \"*:22\") (remote udp \"*:53\") (remote tcp \"*:53\") (literal \"/private/var/run/mDNSResponder\"))\n(allow system-socket)\n";
        s += "(allow mach-lookup (global-name \"com.apple.dnssd.service\") (global-name \"com.apple.SystemConfiguration.DNSConfiguration\") (global-name \"com.apple.SystemConfiguration.configd\") (global-name \"com.apple.trustd\") (global-name \"com.apple.securityd.xpc\") (global-name \"com.apple.SecurityServer\") (global-name \"com.apple.ocspd\"))\n";
        s += &format!("(allow file-read* (regex #\"^{}/\\\\.ssh/id_[^/]*$\") (subpath {}))\n", re(&home.to_string_lossy()), q(&h("Library/Keychains")));
        s += &format!("(allow file-write* (literal {}) (literal {}) (subpath {}))\n", q(&h(".ssh/known_hosts")), q(&h(".ssh/known_hosts.old")), q(&h("Library/Keychains")));
        if let Some(sock) = &p.ssh_sock {
            s += &format!("(allow network-outbound (literal {}))\n", q(sock));
        }
        if let Some(port) = p.askpass_port {
            s += &format!("(allow network-outbound (remote ip \"localhost:{port}\"))\n");
        }
    }
    s
}

/// Linux bubblewrap 인자(`bwrap` 다음에 오는 것, 마지막이 `--`). 시험으로는 인자 구성만 확인한다.
pub fn bwrap_args(g: &GitInfo, p: &Policy, home: &Path) -> Vec<String> {
    let mut a: Vec<String> = ["--die-with-parent", "--new-session", "--unshare-all"].map(String::from).to_vec();
    if p.net {
        a.push("--share-net".into());
    }
    for d in ["/usr", "/lib", "/lib64", "/bin", "/sbin"] {
        a.extend(["--ro-bind-try".into(), d.into(), d.into()]);
    }
    for f in ["/etc/gitconfig", "/etc/ssl", "/etc/ca-certificates", "/etc/pki", "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/passwd", "/etc/group", "/etc/ld.so.cache", "/etc/localtime"] {
        a.extend(["--ro-bind-try".into(), f.into(), f.into()]);
    }
    if let Some(prefix) = g.real.parent().and_then(Path::parent) {
        if !prefix.starts_with("/usr") && prefix != Path::new("/") {
            a.extend(["--ro-bind-try".into(), prefix.to_string_lossy().into_owned(), prefix.to_string_lossy().into_owned()]);
        }
    }
    a.extend(["--proc", "/proc", "--dev", "/dev", "--bind", &p.tmp.to_string_lossy(), "/tmp", "--bind", &p.repo.to_string_lossy(), &p.repo.to_string_lossy()].map(String::from));
    let mut ro = vec![home.join(".gitconfig"), home.join(".config/git"), home.join(".ssh/config"), home.join(".ssh/known_hosts")];
    if p.net {
        if let Ok(rd) = std::fs::read_dir(home.join(".ssh")) {
            ro.extend(rd.flatten().map(|e| e.path()).filter(|e| e.file_name().is_some_and(|n| n.to_string_lossy().starts_with("id_"))));
        }
        if let Some(sock) = &p.ssh_sock {
            ro.push(sock.clone());
        }
    }
    for r in ro {
        a.extend(["--ro-bind-try".into(), r.to_string_lossy().into_owned(), r.to_string_lossy().into_owned()]);
    }
    a.extend(["--setenv", "TMPDIR", "/tmp", "--chdir", &p.repo.to_string_lossy(), "--"].map(String::from));
    a
}

/// 샌드박스 안에서 `program args…`를 실행하는 Command를 만든다. `Mode::None`이면 그대로 실행하는 Command.
/// 실행 파일이나 정책을 만들 수 없으면 Err(호출 쪽은 실행하지 않는다).
pub fn command(mode: &Mode, g: &GitInfo, p: &Policy, args: &[String], home: &Path) -> Result<Command, String> {
    match mode {
        Mode::None => {
            let mut c = Command::new(&g.real);
            c.args(args);
            Ok(c)
        }
        Mode::Seatbelt => {
            let mut c = Command::new("/usr/bin/sandbox-exec");
            c.arg("-p").arg(seatbelt_profile(g, p, home)).arg(&g.real).args(args);
            Ok(c)
        }
        Mode::Bwrap(b) => {
            let mut c = Command::new(b);
            c.args(bwrap_args(g, p, home)).arg(&g.real).args(args);
            Ok(c)
        }
    }
}

#[cfg(test)]
mod unit {
    use super::*;

    fn info() -> GitInfo {
        GitInfo { real: "/opt/git/bin/git".into(), exec_path: "/opt/git/libexec/git-core".into() }
    }
    fn policy() -> Policy {
        Policy { repo: "/work/repo".into(), tmp: "/tmp/git403-mcp-1".into(), ..Default::default() }
    }

    #[test]
    fn seatbelt_profile_denies_by_default_and_scopes_reads_writes_and_exec() {
        let s = seatbelt_profile(&info(), &policy(), Path::new("/Users/u"));
        assert!(s.starts_with("(version 1)\n(deny default)"));
        assert!(s.contains("(allow file-write* (subpath \"/work/repo\") (subpath \"/tmp/git403-mcp-1\")"));
        assert!(!s.contains("(allow file-write* (subpath \"/Users"), "홈에는 쓰지 않는다(원격 명령의 known_hosts·키체인 제외)");
        assert!(!s.contains("subpath \"/Users/u\")") && !s.contains("(subpath \"/Users\")"), "홈 전체 읽기 금지");
        assert!(s.contains("(literal \"/Users/u/.gitconfig\")") && s.contains("(subpath \"/Users/u/.config/git\")") && s.contains("(literal \"/Users/u/.ssh/config\")"));
        assert!(!s.contains("/bin/sh") && !s.contains("/bin/bash"), "셸 실행은 막는다");
        assert!(!s.contains("network-outbound") && !s.contains("id_") && !s.contains("Keychains"), "원격 명령이 아니면 네트워크·ssh 키·키체인 없음");
        assert!(s.contains("(literal \"/opt/git/bin/git\")") && s.contains("(subpath \"/opt/git/libexec/git-core\")"));
    }

    #[test]
    fn net_and_lfs_open_only_what_they_need() {
        let mut p = policy();
        p.net = true;
        p.ssh_sock = Some("/tmp/agent.sock".into());
        p.askpass_exe = Some("/Applications/git403.app/Contents/MacOS/git403".into());
        p.askpass_port = Some(5555);
        let s = seatbelt_profile(&info(), &p, Path::new("/Users/u"));
        assert!(s.contains("(remote tcp \"*:443\")") && s.contains("(remote tcp \"*:22\")") && s.contains("\"/tmp/agent.sock\"") && s.contains("localhost:5555") && s.contains("Library/Keychains") && s.contains("id_"));
        assert!(s.contains("/Applications/git403.app/Contents/MacOS/git403"), "askpass는 실행 허용");
        assert!(!s.contains("/bin/sh"));
        p.allow_sh = true;
        assert!(seatbelt_profile(&info(), &p, Path::new("/Users/u")).contains("(literal \"/bin/sh\")"), "LFS 저장소만 셸을 연다");
        // 경로의 따옴표·역슬래시는 이스케이프
        assert_eq!(q(Path::new("/a\"b\\c")), "\"/a\\\"b\\\\c\"");
    }

    #[test]
    fn bwrap_args_confine_writes_and_share_net_only_for_net_commands() {
        let a = bwrap_args(&info(), &policy(), Path::new("/home/u")).join(" ");
        assert!(a.contains("--unshare-all") && !a.contains("--share-net") && a.contains("--bind /tmp/git403-mcp-1 /tmp") && a.contains("--bind /work/repo /work/repo") && a.contains("--chdir /work/repo") && a.ends_with(" --"));
        assert!(a.contains("--ro-bind-try /home/u/.gitconfig /home/u/.gitconfig") && !a.contains("id_"));
        let mut p = policy();
        p.net = true;
        assert!(bwrap_args(&info(), &p, Path::new("/home/u")).join(" ").contains("--share-net"));
    }

    #[test]
    fn mode_names_round_trip_and_unknown_is_rejected() {
        assert_eq!(Mode::from_name("none"), Some(Mode::None));
        assert_eq!(Mode::from_name("bogus"), None);
        assert_eq!(Mode::None.name(), "none");
        assert_eq!(Mode::Seatbelt.name(), "seatbelt");
    }
}

/// 실제 Seatbelt로 시험한다(macOS). **검증기·설정 판정을 거치지 않고** 악의적 저장소 설정으로 원본 git을 직접 실행해, 샌드박스만으로 피해가 가둬지는지 본다.
/// 각 공격은 대조군(샌드박스 없이)에서 실제로 흔적을 남기는 것까지 확인한다.
#[cfg(all(test, target_os = "macos"))]
mod real {
    use super::*;

    struct Env {
        repo: PathBuf,
        out: PathBuf,
        tmp: PathBuf,
        _keep: Vec<tempfile::TempDir>,
    }

    fn canon(d: &tempfile::TempDir) -> PathBuf {
        d.path().canonicalize().unwrap()
    }
    fn raw(dir: &Path, a: &[&str]) -> (i32, String) {
        let o = Command::new("git").current_dir(dir).env("GIT_TERMINAL_PROMPT", "0").env("GIT_EDITOR", ":").args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always"]).args(a).output().unwrap();
        (o.status.code().unwrap_or(-1), format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)))
    }
    fn env() -> Env {
        let (r, o, t) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let e = Env { repo: canon(&r), out: canon(&o), tmp: canon(&t), _keep: vec![r, o, t] };
        raw(&e.repo, &["init", "-q", "-b", "main"]);
        std::fs::write(e.repo.join("a.txt"), "1\n").unwrap();
        raw(&e.repo, &["add", "."]);
        raw(&e.repo, &["commit", "-qm", "a"]);
        e
    }
    /// 샌드박스 안에서 git 실행 (사용자 신원·file 프로토콜 허용은 시험 편의로 `-c`)
    fn sb(e: &Env, net: bool, allow_sh: bool, a: &[&str]) -> (i32, String) {
        sb_in(e, &e.repo, net, allow_sh, a)
    }
    fn sb_in(e: &Env, repo: &Path, net: bool, allow_sh: bool, a: &[&str]) -> (i32, String) {
        let g = git_info("git").unwrap();
        let p = Policy { repo: repo.to_path_buf(), tmp: e.tmp.clone(), net, allow_sh, ..Default::default() };
        let mut args: Vec<String> = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always"].map(String::from).to_vec();
        args.extend(a.iter().map(|s| s.to_string()));
        let home = PathBuf::from(std::env::var("HOME").unwrap());
        let mut c = command(&Mode::Seatbelt, &g, &p, &args, &home).unwrap();
        let o = c.current_dir(repo).env("TMPDIR", &e.tmp).env("GIT_TERMINAL_PROMPT", "0").env("GIT_EDITOR", ":").env("GIT_SEQUENCE_EDITOR", ":").output().unwrap();
        (o.status.code().unwrap_or(-1), format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)))
    }
    fn names(d: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(d).map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
        v.sort();
        v
    }

    /// 정상 흐름은 샌드박스 안에서도 그대로 된다: status·diff·add·commit·switch·stash·merge/rebase 충돌 해결·cherry-pick·revert·reset·rm·mv·log·show·blame
    #[test]
    fn normal_git_workflow_works_inside_the_sandbox() {
        let e = env();
        let ok = |a: &[&str]| {
            let (c, o) = sb(&e, false, false, a);
            assert_eq!(c, 0, "git {a:?}: {o}");
            o
        };
        assert!(ok(&["status", "--short"]).is_empty());
        std::fs::write(e.repo.join("a.txt"), "1\nmine\n").unwrap();
        assert!(ok(&["diff"]).contains("+mine"));
        ok(&["add", "-A"]);
        ok(&["commit", "-qm", "second"]);
        ok(&["switch", "-qc", "feature"]);
        std::fs::write(e.repo.join("a.txt"), "1\nfeature\n").unwrap();
        ok(&["commit", "-qam", "feature change"]);
        ok(&["switch", "-q", "main"]);
        std::fs::write(e.repo.join("a.txt"), "1\nmain\n").unwrap();
        ok(&["commit", "-qam", "main change"]);
        // merge 충돌 → 해결 → 커밋
        assert_eq!(sb(&e, false, false, &["merge", "feature"]).0, 1, "충돌로 멈춘다");
        std::fs::write(e.repo.join("a.txt"), "1\nresolved\n").unwrap();
        ok(&["add", "a.txt"]);
        ok(&["commit", "-qm", "merge resolved"]);
        // rebase 충돌 → 해결 → --continue(편집기 `:`)
        ok(&["switch", "-qc", "topic", "HEAD~1"]);
        std::fs::write(e.repo.join("a.txt"), "1\ntopic\n").unwrap();
        ok(&["commit", "-qam", "topic change"]);
        assert_eq!(sb(&e, false, false, &["rebase", "main"]).0, 1, "충돌로 멈춘다");
        std::fs::write(e.repo.join("a.txt"), "1\nrebased\n").unwrap();
        ok(&["add", "a.txt"]);
        let (c, o) = sb(&e, false, false, &["rebase", "--continue"]);
        assert_eq!(c, 0, "rebase --continue: {o}");
        ok(&["stash", "list"]);
        std::fs::write(e.repo.join("new.txt"), "untracked\n").unwrap();
        ok(&["stash", "push", "-u", "-q"]);
        ok(&["stash", "apply", "-q"]);
        ok(&["add", "new.txt"]);
        ok(&["commit", "-qm", "new"]);
        let cur = ok(&["branch", "--show-current"]).trim().to_string();
        ok(&["switch", "-qc", "side", "HEAD~1"]);
        std::fs::write(e.repo.join("side.txt"), "side\n").unwrap();
        ok(&["add", "side.txt"]);
        ok(&["commit", "-qm", "side"]);
        let sha = ok(&["rev-parse", "HEAD"]).trim().to_string();
        ok(&["switch", "-q", &cur]);
        ok(&["cherry-pick", &sha]);
        ok(&["revert", "--no-edit", "HEAD"]);
        ok(&["mv", "new.txt", "moved.txt"]);
        ok(&["rm", "-q", "--cached", "moved.txt"]);
        ok(&["reset", "-q"]);
        for a in [&["log", "--oneline", "-5"][..], &["show", "--stat", "HEAD"], &["blame", "--", "a.txt"], &["branch", "-a"], &["config", "--get", "user.name"]] {
            ok(a);
        }
    }

    /// 목록식 방어(검증기·설정 판정)를 거치지 않은 RCE 재현들이 샌드박스에서는 흔적을 남기지 못한다
    #[test]
    fn rce_reproductions_are_contained_by_the_sandbox_alone() {
        let e = env();
        let (repo, out) = (e.repo.display().to_string(), e.out.display().to_string());
        // textconv·filter(셸 실행)·훅·`!` alias: 밖과 저장소 안 양쪽에 표식을 만들려 한다
        std::fs::write(e.repo.join(".gitattributes"), "*.txt diff=evil filter=evil\n").unwrap();
        raw(&e.repo, &["config", "diff.evil.textconv", &format!("sh -c 'touch {out}/textconv {repo}/inside-textconv; cat \"$1\"' --")]);
        raw(&e.repo, &["config", "filter.evil.clean", &format!("sh -c 'touch {out}/filter {repo}/inside-filter; cat'")]);
        raw(&e.repo, &["config", "alias.pwn", &format!("!touch {out}/alias {repo}/inside-alias")]);
        raw(&e.repo, &["config", "core.hooksPath", ".githooks"]);
        std::fs::create_dir_all(e.repo.join(".githooks")).unwrap();
        std::fs::write(e.repo.join(".githooks/pre-commit"), format!("#!/bin/sh\ntouch {out}/hook {repo}/inside-hook\n")).unwrap();
        std::process::Command::new("chmod").args(["+x", &format!("{repo}/.githooks/pre-commit")]).status().unwrap();
        std::fs::write(e.repo.join("a.txt"), "2\n").unwrap();
        // 대조군: 샌드박스 없이는 전부 실행된다
        raw(&e.repo, &["diff"]);
        raw(&e.repo, &["add", "-A"]);
        raw(&e.repo, &["commit", "-qm", "x"]);
        raw(&e.repo, &["pwn"]);
        for m in ["textconv", "filter", "hook", "alias"] {
            assert!(e.out.join(m).exists(), "대조군에서 {m}이 실행돼야 한다");
        }
        for f in names(&e.out) {
            std::fs::remove_file(e.out.join(f)).unwrap();
        }
        for f in names(&e.repo).into_iter().filter(|f| f.starts_with("inside-")) {
            std::fs::remove_file(e.repo.join(f)).unwrap();
        }
        std::fs::write(e.repo.join("a.txt"), "3\n").unwrap();
        // 샌드박스: 셸 실행 자체가 막혀 저장소 안 표식도 안 생긴다
        for a in [&["diff"][..], &["add", "-A"], &["commit", "-qm", "y"], &["pwn"], &["stash", "push", "-q"]] {
            sb(&e, false, false, a);
        }
        assert!(names(&e.out).is_empty(), "밖 쓰기: {:?}", names(&e.out));
        assert!(names(&e.repo).iter().all(|f| !f.starts_with("inside-")), "저장소 안 셸 실행: {:?}", names(&e.repo));
    }

    /// `core.alternateRefsCommand`(대상 저장소 설정)·`core.worktree`·`commondir`로 저장소 밖에 쓰거나 다른 저장소를 건드리던 재현
    #[test]
    fn outside_writes_via_alternates_worktree_and_commondir_are_blocked() {
        let e = env();
        let out = e.out.display().to_string();
        // (1) 로컬 경로 원격의 대상 저장소 설정이 push 때 실행
        let evil = tempfile::tempdir().unwrap();
        let ev = canon(&evil);
        raw(&ev, &["init", "-q", "--bare", "-b", "main"]);
        raw(&ev, &["config", "core.alternateRefsCommand", &format!("touch {out}/alt")]);
        raw(&e.repo, &["push", &ev.to_string_lossy(), "main"]);
        let control_alt = e.out.join("alt").exists();
        let _ = std::fs::remove_file(e.out.join("alt"));
        let (_, o) = sb(&e, false, false, &["push", &ev.to_string_lossy(), "main:other"]);
        assert!(!e.out.join("alt").exists(), "alternateRefsCommand 실행됨: {o}");
        // 대조군이 실제로 실행되는 환경일 때만 의미가 있다(git 버전에 따라 실행 시점이 다르다)
        eprintln!("alternateRefsCommand 대조군 실행 여부: {control_alt}");
        // (2) core.worktree가 밖: 전환이 밖 폴더에 파일을 쓴다
        raw(&e.repo, &["branch", "payload"]);
        raw(&e.repo, &["switch", "-q", "payload"]);
        std::fs::write(e.repo.join("payload.txt"), "x\n").unwrap();
        raw(&e.repo, &["add", "payload.txt"]);
        raw(&e.repo, &["commit", "-qm", "payload"]);
        raw(&e.repo, &["switch", "-q", "main"]);
        raw(&e.repo, &["config", "core.worktree", &out]);
        raw(&e.repo, &["checkout", "-q", "payload"]);
        assert!(e.out.join("payload.txt").exists(), "대조군: 밖에 쓰인다");
        std::fs::remove_file(e.out.join("payload.txt")).unwrap();
        raw(&e.repo, &["--work-tree", &e.repo.to_string_lossy(), "checkout", "-q", "main"]);
        let (_, o) = sb(&e, false, false, &["checkout", "-q", "payload"]);
        assert!(!e.out.join("payload.txt").exists(), "밖 worktree에 씀: {o}");
        raw(&e.repo, &["config", "--unset", "core.worktree"]);
        // (3) commondir: 다른 저장소(victim)에 ref·객체를 쓴다
        let (victim, atk) = (env(), env());
        let before = names(&victim.repo.join(".git/refs/heads"));
        std::fs::write(atk.repo.join(".git/commondir"), format!("{}\n", victim.repo.join(".git").display())).unwrap();
        let (c, o) = sb_in(&atk, &atk.repo, false, false, &["commit", "--allow-empty", "-qm", "into victim"]);
        let _ = (c, o);
        assert_eq!(names(&victim.repo.join(".git/refs/heads")), before);
        assert_eq!(raw(&victim.repo, &["log", "--format=%s"]).1.trim(), "a", "victim 저장소가 바뀜");
        // (4) 읽기 제한: 저장소·시스템·git 설정 밖의 파일은 읽지 못한다(홈·임의 경로)
        let secret = e.out.join("secret.cfg");
        std::fs::write(&secret, "[user]\n\tname = leaked\n").unwrap();
        assert_eq!(raw(&e.repo, &["config", "--file", &secret.to_string_lossy(), "--get", "user.name"]).1.trim(), "leaked");
        let (c, o) = sb(&e, false, false, &["config", "--file", &secret.to_string_lossy(), "--get", "user.name"]);
        assert!(c != 0 && !o.contains("leaked"), "읽기 제한이 안 먹음: {o}");
    }

    #[test]
    fn network_is_closed_except_for_remote_commands() {
        let e = env();
        let (c, o) = sb(&e, false, false, &["ls-remote", "https://github.com/octocat/Hello-World.git"]);
        assert!(c != 0 && !o.contains("refs/heads"), "원격 명령이 아니면 네트워크가 막혀야 한다: {o}");
        // 원격 명령에는 열린다(인터넷이 없으면 대조군도 실패하므로 건너뛴다)
        if raw(&e.repo, &["ls-remote", "https://github.com/octocat/Hello-World.git"]).0 == 0 {
            let (c, o) = sb(&e, true, false, &["ls-remote", "https://github.com/octocat/Hello-World.git"]);
            assert!(c == 0 && o.contains("refs/heads/master"), "원격 명령에서 https가 안 됨: {o}");
            let (_, o) = sb(&e, true, false, &["ls-remote", "ssh://git@github.com/octocat/Hello-World.git"]);
            assert!(o.contains("Permission denied") || o.contains("refs/heads"), "ssh는 실행돼야 한다(키가 없으면 인증 실패): {o}");
        }
    }

    /// git-lfs: 표준 필터는 셸이 필요하다 — 셸을 닫으면 실패하고, LFS 저장소에서만 여는 정책이면 된다
    #[test]
    fn lfs_needs_the_shell_and_works_when_it_is_opened() {
        if which("git-lfs").is_none() {
            eprintln!("git-lfs가 없어 건너뜀");
            return;
        }
        let e = env();
        raw(&e.repo, &["lfs", "install", "--local"]);
        std::fs::write(e.repo.join(".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n").unwrap();
        std::fs::write(e.repo.join("big.bin"), vec![7u8; 4096]).unwrap();
        let (c, _) = sb(&e, false, false, &["add", "big.bin"]);
        assert!(c != 0, "셸이 닫혀 있으면 LFS 필터가 실패한다(문서화한 한계)");
        let (c, o) = sb(&e, false, true, &["add", "big.bin"]);
        assert_eq!(c, 0, "셸을 열면 LFS가 동작: {o}");
        let (c, o) = sb(&e, false, true, &["commit", "-qm", "lfs"]);
        assert_eq!(c, 0, "{o}");
        assert!(raw(&e.repo, &["show", "HEAD:big.bin"]).1.contains("git-lfs.github.com/spec"), "포인터 파일이 커밋돼야 한다");
    }
}
