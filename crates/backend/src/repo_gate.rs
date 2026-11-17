//! AI 차례 중 쓰기 막기(백엔드 강제, docs/security.md). 같은 저장소에서 AI 차례가 도는 동안(`Ai::repos` 잠금) 사용자·다른 창·VS Code 확장이
//! IPC로 시작하는 쓰기는 `dispatch` 진입부에서 `aiChat.repoBusy`로 거절한다 — AI가 실행하는 git(별도 MCP 프로세스)과 FETCH_HEAD·index·ref를 같이 쓰면 깨지기 때문.
//!
//! - **읽기 허용 목록**: `class`가 읽기라고 적은 명령만 통과한다. 목록에 없는 명령(새로 추가한 IPC 포함)은 쓰기로 보고 막는다(fail closed).
//!   **새 IPC를 추가하면 읽기인지 여기 `Class::Read`에 적어야 한다**(`every_dispatch_command_is_classified` 테스트가 목록 밖 이름을 잡는다).
//! - `git`·`run_detached`는 argv로 판정한다(`git_writes`): 전역 옵션을 건너뛴 하위 명령이 읽기 허용 목록에 있고 쓰는 옵션이 없을 때만 읽기.
//! - 저장소 판정: `repo`(문자열·객체)·`localRepo`·argv의 `-C`·`--git-dir`·`--work-tree`를 `gc_pathkey::real`로 풀고(심볼릭 링크·`..`·끝 `/`·윈도 접두),
//!   **git common dir**(`resolve_keys`/`lock_key`)로 비교한다: 같은 저장소의 연결된 worktree(`git worktree add`)는 본 저장소와 같은 잠금이다(양방향). common dir은 git을 실행하지 않고
//!   파일(`.git` 폴더·`.git` 파일의 `gitdir:`·`commondir`)만 읽어 구한다(gix·Android도 같다). 그 저장소 자신의 `config`·`config.worktree`에 `core.worktree`가 있으면 그 작업 트리도 판정에 넣는다.
//!   다른 저장소는 영향이 없다.
//! - **어느 저장소인지 알 수 없는 요청은 AI 차례 중이면 막는다**(`unknown`): 드라이브 상대(`C:foo`)·루트 상대(`\foo`) 경로, 위치를 정하는 git 옵션(`-c`·`--config-env`의
//!   `core.worktree|core.bare|core.gitdir`, `include.path`, `includeIf.*` — `-c core.worktree=`는 값을 경로로도 판정한다), 값을 정확히 풀 수 없는 `core.worktree`
//!   (따옴표·이스케이프·`~`·주석·`include` 섹션·큰 파일), 불신 `.git` 파일·`commondir`가 가리키는 장치 경로·(원래 경로가 UNC가 아닐 때의) UNC 경로 — 이런 경로는 열지도 않는다.
//!   검사는 파일 시스템을 읽으므로 `spawn_blocking`에서 한다.
//! - AI 자신의 명령(`ai_chat_*`)은 막지 않는다. AI가 실행하는 git은 `dispatch`를 거치지 않으므로 애초에 걸리지 않는다.
//! - 한계: `start_shell`의 셸 문자열은 해석하지 않는다(사용자가 직접 쓴 명령, `repo` 폴더 기준으로만 판정).

use std::path::PathBuf;

use serde_json::Value;

use crate::util::Res;
use crate::Backend;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Class {
    /// 저장소를 바꾸지 않는다(또는 AI 차례와 무관한 읽기·AI 자신의 명령)
    Read,
    /// git 인자(`args`)로 판정
    Git,
    /// 쓰기(또는 목록에 없음): 잠긴 저장소를 가리키면 막는다
    Write,
}

pub(crate) fn class(cmd: &str) -> Class {
    match cmd {
        "git" | "run_detached" => Class::Git,
        "set_locale" | "git_version" | "capabilities" | "initial_repo" | "load_graph" | "load_refs" | "load_submodules" | "load_worktrees" | "lfs_status" | "load_status" | "changed_files"
        | "file_diff" | "file_blob" | "worktree_diff" | "last_message" | "commit_message" | "co_authors" | "committer" | "file_log" | "compare_refs" | "search_content" | "blame"
        | "conflict_inputs" | "find_repos" | "repos_root" | "jj_disable_check" | "jj_status" | "jj_op_log" | "jj_bookmarks" | "repo_stats" | "cancel_stats" | "watch_repo" | "watch_add"
        | "watch_remove" | "eol_rule_exists" | "staged_crlf" | "patch_is_mail" | "home_dir" | "ignore_read" | "global_ignore_read" | "ssh_keys" | "accounts_list" | "remote_info"
        | "author_avatars" | "pr_list" | "pr_inbox" | "pr_detail" | "gh_accounts" | "gh_repo_account" | "gh_probe" | "pr_web_url" | "commit_web_url" | "settings_export"
        | "stale_lock_check" | "settings_read_file" | "settings_import_preview" | "ai_status" | "ai_run" | "ai_cancel" | "cancel_detached" | "cancel_job" | "askpass_reply"
        // AI 자신의 명령: 차례 시작·중단·위험 확인·이력·설정 (되돌리기 `ai_backup_restore`는 저장소를 쓰므로 쓰기)
        | "ai_chat_start" | "ai_chat_risk" | "ai_chat_cancel" | "ai_history_list" | "ai_history_read" | "ai_history_clear" | "ai_history_prune" | "ai_chat_settings" | "ai_chat_settings_set" => Class::Read,
        _ => Class::Write,
    }
}

/// 윈도 장치 경로(`\\.\pipe\…`·`\\?\GLOBALROOT\…`·`//./pipe/…`)인가. 드라이브(`\\?\C:\`)·UNC(`\\?\UNC\`) 접두는 장치가 아니다.
/// 윈도에는 FIFO가 없고 named pipe가 같은 위험(열면 멈춤·서버와 연결됨)이라, 불신 저장소가 가리키는 이런 경로는 열지도 `metadata`를 부르지도 않고 거절한다.
fn is_device_path(s: &str) -> bool {
    let n = s.replace('\\', "/");
    let Some(rest) = n.strip_prefix("//./").or_else(|| n.strip_prefix("//?/")) else { return false };
    let drive = rest.as_bytes().get(1) == Some(&b':') && rest.as_bytes()[0].is_ascii_alphabetic();
    // 바이트 비교(`rest[..4]` 슬라이스는 여러 바이트 문자 한가운데에서 panic): 불신 문자열이 들어온다
    !(drive || rest.as_bytes().get(..4).is_some_and(|b| b.eq_ignore_ascii_case(b"unc/")))
}

/// **일반 파일만** 연다. 열린 핸들로 다시 판정한다(fstat): 사전 검사 뒤 파일을 FIFO·장치로 바꿔치기해도 열린 핸들 기준으로 거절한다.
/// 유닉스는 `O_NONBLOCK | O_NOCTTY`로 열어 FIFO를 열어도 쓰는 쪽을 기다리며 멈추지 않는다(링크는 따라간다 — `.git`·`commondir`는 링크일 수 있다). 윈도는 장치 경로(`is_device_path`)를 열기 전에 거절한다.
fn open_regular(p: &std::path::Path) -> Option<std::fs::File> {
    if is_device_path(&p.to_string_lossy()) {
        return None;
    }
    let mut o = std::fs::OpenOptions::new();
    o.read(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut o, libc::O_NONBLOCK | libc::O_NOCTTY); // 장치(tty)를 열어도 제어 터미널이 되지 않게
    let f = o.open(p).ok()?;
    f.metadata().ok()?.is_file().then_some(f)
}

/// 작은 텍스트 파일의 첫 줄. 일반 파일만 연다(`open_regular`: 불신 저장소의 `gitdir:`·`commondir`가 FIFO를 가리키면 열다가 IPC 스레드가 멈추는 것을 막는다).
/// 4KB를 넘는 첫 줄은 잘라 읽지 않고 거절한다(잘린 경로로 엉뚱한 곳을 가리키지 않게).
fn first_line(p: &std::path::Path) -> Option<String> {
    use std::io::Read;
    let mut buf = Vec::new();
    open_regular(p)?.take(4097).read_to_end(&mut buf).ok()?;
    let line = String::from_utf8_lossy(&buf).lines().next()?.to_owned();
    (line.len() <= 4096).then(|| line.trim().to_owned())
}

/// git 폴더처럼 생겼나: `HEAD` 파일과 `objects` 폴더(또는 연결된 worktree의 `commondir` 파일)가 있다. `.git` 파일이 가리키는 곳·`--git-dir=` 값이 이 모양이어야 한다
fn looks_like_gitdir(g: &std::path::Path) -> bool {
    g.join("HEAD").is_file() && (g.join("objects").is_dir() || g.join("commondir").is_file())
}

/// UNC 경로(`\\host\share`·`\\?\UNC\…`·`//host/share`)인가(장치 경로는 아니다)
fn is_unc(s: &str) -> bool {
    let n = s.replace('\\', "/");
    match n.strip_prefix("//?/").or_else(|| n.strip_prefix("//./")) {
        Some(r) => r.as_bytes().get(..4).is_some_and(|b| b.eq_ignore_ascii_case(b"unc/")), // `\\?\UNC\…`만 UNC, `\\?\C:\`·장치는 아니다
        None => n.starts_with("//"),
    }
}

/// 불신 `.git` 파일·`commondir`가 가리키는 값을 열어 봐도 되는가: 장치 경로(`\\.\pipe\…`)는 항상 안 되고, UNC(`\\localhost\pipe\…`·`\\127.0.0.1\…`는 서버 이름으로 named pipe·원격 공유에 닿는다)는
/// **원래 저장소 경로(`origin`)가 UNC일 때만** 된다(저장소가 UNC 공유에 있는 정상 경우와 구분)
fn target_allowed(target: &str, origin: &str) -> bool {
    !is_device_path(target) && (!is_unc(target) || is_unc(origin))
}

/// `.git/config`(와 `config.worktree`)의 `core.worktree`
#[derive(Debug, PartialEq, Eq)]
enum WorktreeCfg {
    None,
    Path(PathBuf),
    /// 값을 정확히 풀 수 없다(따옴표·이스케이프·`~`·주석·`include` 섹션·큰 파일 …): 막는 쪽으로 처리한다
    Unknown,
}

/// git config 문법으로 `[core] worktree`의 값을 읽는다(git과 같은 규칙: 첫 줄 UTF-8 BOM 무시, `[섹션]`은 대소문자 무시·`[core "x"]`·`[core.x]`는 core가 아님, 섹션 머리와 같은 줄에 이어지는 변수,
/// 값의 `"`는 따옴표 상태 전환·따옴표 밖 `;`·`#`는 주석·이스케이프는 `\\` `\"` `\n` `\t` `\b`와 줄 끝 `\`(이어붙이기)만·따옴표 밖 앞뒤 공백 제거). 마지막 값이 이긴다.
/// 파싱할 수 없으면(git도 오류로 보는 줄·모르는 이스케이프·닫히지 않은 따옴표·값 없는 `worktree`) 또는 `include`·`includeIf` 섹션이 있으면 `Err`(호출 측이 막는 쪽으로 처리).
fn parse_core_worktree(text: &str) -> Result<Option<String>, ()> {
    let c: Vec<char> = text.strip_prefix('\u{feff}').unwrap_or(text).chars().collect();
    let n = c.len();
    let (mut i, mut in_core, mut found) = (0usize, false, None);
    while i < n {
        match c[i] {
            ' ' | '\t' | '\r' | '\n' => i += 1,
            ';' | '#' => {
                while i < n && c[i] != '\n' {
                    i += 1;
                }
            }
            '[' => {
                i += 1;
                let start = i;
                while i < n && (c[i].is_ascii_alphanumeric() || c[i] == '-' || c[i] == '.') {
                    i += 1;
                }
                let name: String = c[start..i].iter().collect::<String>().to_ascii_lowercase();
                let mut sub = false;
                if i < n && c[i] == ']' {
                    i += 1;
                } else if i < n && (c[i] == ' ' || c[i] == '\t') {
                    while i < n && (c[i] == ' ' || c[i] == '\t') {
                        i += 1;
                    }
                    if i >= n || c[i] != '"' {
                        return Err(());
                    }
                    i += 1;
                    loop {
                        match c.get(i) {
                            None | Some('\n') => return Err(()),
                            Some('"') => break,
                            Some('\\') => i += 2, // 하위 섹션 이름 안의 `\x`는 x 그대로
                            Some(_) => i += 1,
                        }
                    }
                    i += 1;
                    if c.get(i) != Some(&']') {
                        return Err(());
                    }
                    i += 1;
                    sub = true;
                } else {
                    return Err(());
                }
                if name == "include" || name.starts_with("includeif") {
                    return Err(());
                }
                in_core = name == "core" && !sub; // `core.x`는 이름에 `.`이 있어 core가 아니다
            }
            _ => {
                let start = i;
                while i < n && (c[i].is_ascii_alphanumeric() || c[i] == '-') {
                    i += 1;
                }
                if i == start {
                    return Err(());
                }
                let key = c[start..i].iter().collect::<String>().to_ascii_lowercase();
                while i < n && (c[i] == ' ' || c[i] == '\t') {
                    i += 1;
                }
                let value = match c.get(i) {
                    Some('=') => {
                        i += 1;
                        Some(parse_config_value(&c, &mut i)?)
                    }
                    None | Some('\n' | '\r' | ';' | '#') => None, // 값 없는 변수(불리언 true)
                    Some(_) => return Err(()),
                };
                if in_core && key == "worktree" {
                    found = Some(value.ok_or(())?);
                }
            }
        }
    }
    Ok(found)
}

/// `=` 뒤의 값 하나를 읽는다(`i`는 값 끝(줄바꿈 앞·EOF)으로 간다)
fn parse_config_value(c: &[char], i: &mut usize) -> Result<String, ()> {
    let n = c.len();
    while *i < n && (c[*i] == ' ' || c[*i] == '\t') {
        *i += 1;
    }
    let (mut out, mut pending, mut quote) = (String::new(), String::new(), false);
    while *i < n {
        let ch = c[*i];
        match ch {
            '\n' => {
                if quote {
                    return Err(());
                }
                break;
            }
            '\r' if c.get(*i + 1) == Some(&'\n') => *i += 1,
            '\\' => {
                *i += 1;
                let lit = match c.get(*i) {
                    Some('\n') => None, // 줄 끝 `\`: 다음 줄 이어붙이기
                    Some('\r') if c.get(*i + 1) == Some(&'\n') => {
                        *i += 1;
                        None
                    }
                    Some('t') => Some('\t'),
                    Some('b') => Some('\u{8}'),
                    Some('n') => Some('\n'),
                    Some('"') => Some('"'),
                    Some('\\') => Some('\\'),
                    _ => return Err(()), // 모르는 이스케이프·EOF
                };
                if let Some(l) = lit {
                    out.push_str(&std::mem::take(&mut pending));
                    out.push(l);
                }
            }
            '"' => quote = !quote,
            ';' | '#' if !quote => {
                while *i < n && c[*i] != '\n' {
                    *i += 1;
                }
                break;
            }
            ' ' | '\t' if !quote => pending.push(ch),
            _ => {
                out.push_str(&std::mem::take(&mut pending));
                out.push(ch);
            }
        }
        *i += 1;
    }
    if quote {
        return Err(());
    }
    Ok(out)
}

/// git을 실행하지 않고 설정 파일을 읽어 `[core] worktree`를 찾는다(`open_regular`: 일반 파일만, 256KB까지). 상대 값은 설정이 있는 git 폴더 기준(git과 같다).
/// 파싱할 수 없거나(`parse_core_worktree`가 `Err`)·`~`·`%(…)`로 시작하는 값(git이 전개한다)·빈 값·UTF-8이 아닌 값이면 `Unknown`
fn core_worktree(gitdir: &std::path::Path, file: &std::path::Path) -> WorktreeCfg {
    use std::io::Read;
    let Some(f) = open_regular(file) else { return if file.symlink_metadata().is_ok() { WorktreeCfg::Unknown } else { WorktreeCfg::None } };
    let mut buf = Vec::new();
    if f.take(256 * 1024 + 1).read_to_end(&mut buf).is_err() || buf.len() > 256 * 1024 {
        return WorktreeCfg::Unknown;
    }
    match parse_core_worktree(&String::from_utf8_lossy(&buf)) {
        Err(()) => WorktreeCfg::Unknown,
        Ok(None) => WorktreeCfg::None,
        Ok(Some(v)) if v.is_empty() || v.starts_with('~') || v.starts_with("%(") || v.contains('\u{fffd}') || v.contains('\0') => WorktreeCfg::Unknown,
        Ok(Some(v)) => WorktreeCfg::Path(gitdir.join(v)),
    }
}

/// 요청 경로 하나의 판정 재료: 잠금 키들(common dir + 그 저장소 설정의 `core.worktree`가 가리키는 작업 트리)과, 어느 저장소인지 알 수 없어 막아야 하는지
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Resolved {
    pub keys: Vec<String>,
    pub unknown: bool,
}

/// 저장소의 **공통 git 폴더**와 부가 판정. 연결된 worktree는 본 저장소의 `.git`, 서브모듈·일반 저장소는 자기 git 폴더. 위로 올라가며 `.git`(폴더 또는 `gitdir: <경로>` 파일)이나
/// git 폴더 자체(`HEAD`와 `objects`·`commondir`가 있는 폴더 — `--git-dir=` 용)를 찾는다. git을 실행하지 않는 파일 해석이라 gix·Android에서도 같다.
/// `.git` 파일·`commondir`가 장치·UNC(원래 경로가 UNC가 아닐 때) 경로를 가리키면 열지 않고 `unknown`(막는 쪽). 저장소가 아니면 `None`.
fn resolve_dirs(p: &std::path::Path) -> (Option<PathBuf>, Vec<PathBuf>, bool) {
    let p = gc_pathkey::real(p);
    let origin = p.to_string_lossy().into_owned();
    for a in p.ancestors() {
        let dotgit = a.join(".git");
        let gitdir = match std::fs::metadata(&dotgit).ok().filter(|_| !is_device_path(&dotgit.to_string_lossy())).ok_or(()) {
            Ok(m) if m.is_dir() => Some(dotgit),
            // `.git` 파일: `gitdir: <경로>` 한 줄(일반 파일만 읽는다). 줄이 없거나 가리키는 곳이 git 폴더가 아니면 이 단계는 저장소가 아니다
            Ok(m) if m.is_file() => match first_line(&dotgit).and_then(|l| l.strip_prefix("gitdir:").map(|r| r.trim().to_owned())) {
                // 원문 값과 합친 경로를 둘 다 본다(윈도에서 절대 경로는 합치면 앞이 바뀌고, 상대 값은 원문에서만 드러난다)
                Some(raw) if !target_allowed(&raw, &origin) || !target_allowed(&a.join(&raw).to_string_lossy(), &origin) => return (None, vec![], true),
                Some(raw) => Some(gc_pathkey::real(a.join(raw))).filter(|g| looks_like_gitdir(g)),
                None => None,
            },
            _ => None,
        }
        .or_else(|| looks_like_gitdir(a).then(|| a.to_path_buf()));
        if let Some(g) = gitdir {
            let common = match first_line(&g.join("commondir")) {
                Some(c) if !c.is_empty() => {
                    let t = g.join(&c);
                    if !target_allowed(&c, &origin) || !target_allowed(&t.to_string_lossy(), &origin) {
                        return (None, vec![], true);
                    }
                    gc_pathkey::real(t)
                }
                _ => gc_pathkey::real(&g),
            };
            // `commondir`는 불신 저장소가 쓴 값이다: git 폴더처럼 생긴 곳(`HEAD`와 `objects`)이 아니면 저장소로 인정하지 않고 막는 쪽(`unknown`)으로 처리한다
            // (홈 같은 임의 폴더가 common dir이 돼 그 안의 파일을 지우거나 잠금 키를 오염시키지 못하게)
            if !looks_like_gitdir(&common) {
                return (None, vec![], true);
            }
            return (Some(common.clone()), vec![common, g], false);
        }
    }
    (None, vec![], false)
}

/// `resolve_dirs`의 공개판: (common dir, [common dir, 이 작업 트리의 git 폴더], 알 수 없음)
pub(crate) fn dirs_of(p: &std::path::Path) -> (Option<PathBuf>, Vec<PathBuf>, bool) {
    resolve_dirs(p)
}

pub(crate) fn common_dir(p: &std::path::Path) -> Option<PathBuf> {
    resolve_dirs(p).0
}

/// AI 차례 잠금 키: 저장소의 common dir(같은 저장소의 worktree끼리 같은 키), 저장소가 아니면 실제 경로. 대소문자 무시 키(막는 쪽 판정)
pub(crate) fn lock_key(p: &std::path::Path) -> String {
    gc_pathkey::key(common_dir(p).unwrap_or_else(|| gc_pathkey::real(p)))
}

/// 요청 경로 하나의 잠금 키들. 그 저장소 자신의 `config`·`config.worktree`에 `core.worktree`가 있으면 그 작업 트리의 키도 넣고(불신 저장소가 설정으로 다른 작업 트리를 가리키는 길),
/// 값을 정확히 풀 수 없으면 `unknown`. 파일 시스템을 읽으므로 호출 측이 블로킹 스레드에서 부른다
pub(crate) fn resolve_keys(p: &std::path::Path) -> Resolved {
    let (common, dirs, unknown) = resolve_dirs(p);
    let mut out = Resolved { keys: vec![], unknown };
    let Some(common) = common else {
        out.keys.push(gc_pathkey::key(gc_pathkey::real(p)));
        return out;
    };
    out.keys.push(gc_pathkey::key(&common));
    let mut files = vec![common.join("config")];
    files.extend(dirs.iter().filter(|d| **d != common).map(|d| d.join("config.worktree")));
    files.push(common.join("config.worktree"));
    for f in files {
        let base = f.parent().unwrap_or(&common).to_path_buf();
        match core_worktree(&base, &f) {
            WorktreeCfg::None => {}
            WorktreeCfg::Unknown => out.unknown = true,
            WorktreeCfg::Path(w) => {
                let w = gc_pathkey::real(w);
                out.keys.push(lock_key(&w));
                out.keys.push(gc_pathkey::key(&w));
            }
        }
    }
    out
}

/// 전역 옵션을 건너뛴 git 인자
#[derive(Default)]
struct Parsed<'a> {
    cmd: Option<&'a str>,
    rest: &'a [String],
    /// `-C` 값들(앞에서부터)
    c_dirs: Vec<&'a str>,
    /// 다른 저장소·작업 트리를 가리킬 수 있는 값: `--git-dir`·`--work-tree`·`-c core.worktree=`
    redirects: Vec<&'a str>,
    /// 저장소 위치를 환경 변수·설정으로 정하는 옵션(`--config-env core.worktree|core.bare=VAR`, `-c core.bare=`): 어느 저장소인지 알 수 없다
    hides_location: bool,
    /// 알 수 없는 옵션·값 없는 옵션(git이 거절할 인자 — 쓰기로 본다)
    bad: bool,
}

/// 저장소(작업 트리·git 폴더) 위치를 바꾸는 설정 키
fn is_location_key(k: &str) -> bool {
    let k = k.to_ascii_lowercase();
    // include로 다른 설정 파일을 끌어들이면 그 안에서 위치를 정할 수 있다
    ["core.worktree", "core.bare", "core.gitdir", "include.path"].contains(&k.as_str()) || k.starts_with("includeif.")
}

/// argv가 저장소 위치를 환경 변수로 정하는가(`--config-env core.worktree=VAR` 등)
pub(crate) fn hides_location(argv: &[String]) -> bool {
    parse(argv).hides_location
}

fn parse(argv: &[String]) -> Parsed<'_> {
    const FLAGS: &[&str] = &[
        "-p", "--paginate", "-P", "--no-pager", "--no-replace-objects", "--no-lazy-fetch", "--no-optional-locks", "--no-advice", "--bare", "--literal-pathspecs", "--glob-pathspecs",
        "--noglob-pathspecs", "--icase-pathspecs", "--version", "--help", "-h", "--html-path", "--man-path", "--info-path", "--exec-path",
    ];
    const VALUED: &[&str] = &["--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source"];
    let mut p = Parsed::default();
    let mut i = 0;
    while i < argv.len() {
        let a = argv[i].as_str();
        let next = argv.get(i + 1).map(String::as_str);
        match a {
            "-c" => match next {
                Some(kv) => {
                    if let Some((k, v)) = kv.split_once('=') {
                        if k.eq_ignore_ascii_case("core.worktree") {
                            p.redirects.push(v);
                        }
                        p.hides_location |= is_location_key(k);
                    }
                    i += 2;
                }
                None => return Parsed { bad: true, ..p },
            },
            "-C" => match next {
                Some(d) => {
                    p.c_dirs.push(d);
                    i += 2;
                }
                None => return Parsed { bad: true, ..p },
            },
            _ if VALUED.contains(&a) => match next {
                Some(v) => {
                    if a == "--config-env" {
                        p.hides_location |= v.split_once('=').is_some_and(|(k, _)| is_location_key(k));
                    }
                    if a == "--git-dir" || a == "--work-tree" {
                        p.redirects.push(v);
                    }
                    i += 2;
                }
                None => return Parsed { bad: true, ..p },
            },
            _ if FLAGS.contains(&a) => i += 1,
            _ if a.starts_with("--config-env=") => {
                p.hides_location |= a["--config-env=".len()..].split_once('=').is_some_and(|(k, _)| is_location_key(k));
                i += 1;
            }
            _ if a.starts_with("--exec-path=") || a.starts_with("--namespace=") || a.starts_with("--super-prefix=") || a.starts_with("--attr-source=") => i += 1,
            _ if a.starts_with("--git-dir=") || a.starts_with("--work-tree=") => {
                p.redirects.push(a.split_once('=').map_or("", |x| x.1));
                i += 1;
            }
            _ if a.starts_with('-') => return Parsed { bad: true, ..p },
            _ => {
                p.cmd = Some(a);
                p.rest = &argv[i + 1..];
                return p;
            }
        }
    }
    p
}

/// `--name`이 `full`의 줄임(또는 같음)인가. git의 긴 옵션은 모호하지 않은 접두사로 줄여 쓸 수 있어서 줄임말도 같은 옵션으로 본다(`--del` = `--delete`)
fn is_long(arg: &str, full: &str) -> bool {
    let name = arg.split('=').next().unwrap_or(arg);
    name.starts_with("--") && name.len() >= 3 && full.starts_with(name)
}

/// 인자 중 `--` 앞에서 긴 옵션 `fulls` 중 하나(줄임말 포함)가 있는가
fn has_long(rest: &[String], fulls: &[&str]) -> bool {
    rest.iter().take_while(|a| *a != "--").any(|a| fulls.iter().any(|f| is_long(a, f)))
}

/// 짧은 옵션 묶음(`-rd`)에 `chars` 중 하나가 있는가. 긴 옵션·`--` 뒤는 보지 않는다
fn has_short(rest: &[String], chars: &str) -> bool {
    rest.iter().take_while(|a| *a != "--").any(|a| a.len() > 1 && a.starts_with('-') && !a.starts_with("--") && a[1..].chars().any(|c| chars.contains(c)))
}

/// 옵션이 아닌 인자 수(`--` 뒤는 모두 인자). 값을 따로 받는 옵션은 호출 측이 목록 판정에서 감안한다
fn positionals(rest: &[String]) -> usize {
    let dd = rest.iter().position(|a| a == "--");
    let (opts, tail) = rest.split_at(dd.unwrap_or(rest.len()));
    opts.iter().filter(|a| !a.starts_with('-')).count() + tail.len().saturating_sub(1)
}

/// 파일로 쓰는 출력 옵션: `--output[=파일]`·`--output-directory` (줄임말 포함). `--output-indicator-*`는 아니다.
/// `-o<폴더>`는 `format-patch`에서만 출력 폴더다(`ls-files -o`·`grep -o`는 읽기).
fn writes_output(rest: &[String], short_o: bool) -> bool {
    has_long(rest, &["--output", "--output-directory"]) || (short_o && rest.iter().take_while(|a| *a != "--").any(|a| a.starts_with("-o") && !a.starts_with("--")))
}

/// git 인자가 저장소·ref·설정을 쓰는가. 읽기 허용 목록 밖이거나 판단이 안 되면 쓰기(true)
pub(crate) fn git_writes(argv: &[String]) -> bool {
    let p = parse(argv);
    if p.bad {
        return true;
    }
    let Some(cmd) = p.cmd else { return false }; // `git --version` 같은 것
    let rest = p.rest;
    match cmd {
        "log" | "show" | "diff" | "rev-parse" | "rev-list" | "merge-base" | "ls-files" | "ls-tree" | "cat-file" | "status" | "for-each-ref" | "blame" | "annotate" | "describe" | "name-rev"
        | "grep" | "shortlog" | "check-ignore" | "check-attr" | "var" | "version" | "count-objects" | "diff-tree" | "diff-index" | "diff-files" | "show-ref" | "ls-remote" | "cherry"
        | "range-diff" | "whatchanged" | "verify-commit" | "verify-tag" | "show-branch" => writes_output(rest, false),
        // 기본은 파일(`0001-….patch`)을 작업 폴더에 쓴다. `--stdout`일 때만 읽기
        "format-patch" => !has_long(rest, &["--stdout"]) || writes_output(rest, true),
        "config" => config_writes(rest),
        "stash" => !matches!(rest.first().map(String::as_str), Some("list" | "show")),
        "branch" => {
            const W: &[&str] = &["--delete", "--move", "--copy", "--set-upstream-to", "--unset-upstream", "--edit-description", "--set-upstream"];
            if has_long(rest, W) || has_short(rest, "dDmMcCu") {
                return true;
            }
            let list = has_long(rest, &["--list", "--show-current", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"]) || has_short(rest, "l");
            !list && positionals(rest) > 0
        }
        "tag" => {
            const W: &[&str] = &["--delete", "--annotate", "--sign", "--local-user", "--force", "--message", "--file", "--edit", "--cleanup"];
            if has_long(rest, W) || has_short(rest, "dasufmFe") {
                return true;
            }
            let list = has_long(rest, &["--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--verify"]) || has_short(rest, "lv");
            !list && positionals(rest) > 0
        }
        "remote" => {
            let mut r = rest;
            while r.first().is_some_and(|a| a == "-v" || a == "--verbose") {
                r = &r[1..];
            }
            match r.first().map(String::as_str) {
                None => false,
                Some("get-url") => false,
                // 이름 없이 `show`는 목록만. 이름을 주면 `-n` 없이는 원격에 접속한다
                Some("show") => r[1..].iter().any(|a| !a.starts_with('-')) && !r[1..].iter().any(|a| a == "-n"),
                Some(_) => true,
            }
        }
        "symbolic-ref" => has_long(rest, &["--delete"]) || has_short(rest, "dm") || has_long(rest, &["--message"]) || positionals(rest) != 1,
        "worktree" => rest.first().map(String::as_str) != Some("list"),
        "submodule" => !matches!(rest.iter().find(|a| !a.starts_with('-')).map(String::as_str), None | Some("status" | "summary")),
        "reflog" => matches!(rest.iter().find(|a| !a.starts_with('-')).map(String::as_str), Some("expire" | "delete")),
        "lfs" => match rest.first().map(String::as_str) {
            Some("version" | "env" | "ls-files" | "status" | "locks") => false,
            Some("track") => positionals(&rest[1..]) > 0, // 패턴을 주면 .gitattributes를 쓴다
            _ => true,
        },
        "apply" => has_long(rest, &["--apply"]) || !has_long(rest, &["--check", "--stat", "--numstat", "--summary"]),
        _ => true,
    }
}

fn config_writes(rest: &[String]) -> bool {
    const W: &[&str] = &["--add", "--replace-all", "--unset", "--unset-all", "--edit", "--remove-section", "--rename-section"];
    if has_long(rest, W) || has_short(rest, "e") || matches!(rest.first().map(String::as_str), Some("set" | "unset" | "edit" | "rename-section" | "remove-section")) {
        return true;
    }
    if has_long(rest, &["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "--get-color", "--get-colorbool"]) || has_short(rest, "l") || matches!(rest.first().map(String::as_str), Some("get" | "list")) {
        return false;
    }
    // `git config <키>`는 읽기, `<키> <값>`은 쓰기. 값을 따로 받는 옵션(`-f 파일`)의 값은 세지 않는다
    let mut n = 0;
    let mut i = 0;
    while i < rest.len() {
        let a = rest[i].as_str();
        if matches!(a, "-f" | "--file" | "--blob" | "--default" | "--type" | "-t") {
            i += 1;
        } else if !a.starts_with('-') {
            n += 1;
        }
        i += 1;
    }
    n != 1
}

fn str_of(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| !s.is_empty())
}

/// 요청이 가리키는 로컬 경로들: `repo`(문자열 또는 객체의 경로 키)·`localRepo` + git 인자가 다른 곳을 가리키게 하는 값
fn targets(args: &Value, argv: Option<&[String]>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    match args.get("repo") {
        Some(Value::String(s)) if !s.is_empty() => out.push(s.into()),
        Some(Value::Object(o)) => out.extend(["path", "localRepo", "dir", "root"].iter().filter_map(|k| o.get(*k).and_then(str_of)).map(PathBuf::from)),
        _ => {}
    }
    if let Some(s) = args.get("localRepo").and_then(str_of) {
        out.push(s.into());
    }
    if let Some(argv) = argv {
        let p = parse(argv);
        let mut cwd = out.first().cloned().unwrap_or_default();
        for c in &p.c_dirs {
            cwd = cwd.join(c);
            out.push(cwd.clone());
        }
        out.extend(p.redirects.iter().map(|r| cwd.join(r)));
    }
    out
}

impl Backend {
    /// 쓰기 요청을 시작하기 전에 부른다(`dispatch` 진입부 한 곳). 읽기·AI 자신의 명령은 `Ok(None)`. 쓰기는 **작업으로 등록**하고(`jobs::register_job`, 종류 `Short`) AI 차례 잠금을 다시 확인한다 —
    /// 그 저장소에서 AI 차례가 도는 중이면(또는 어느 저장소인지 알 수 없으면) `aiChat.repoBusy`. 돌려준 표지(`JobReg`)를 요청이 끝날 때까지 들고 있으면 `ai_chat_start`의 겹침 확인이 이 쓰기를 본다.
    /// `start_job`·`start_shell`·`run_detached`는 자기 등록을 직접 한다(`Ok(None)`).
    pub(crate) async fn begin_write(&self, cmd: &str, args: &Value) -> Res<Option<crate::jobs::JobReg>> {
        if matches!(cmd, "start_job" | "start_shell" | "run_detached") {
            return Ok(None);
        }
        let argv: Option<Vec<String>> = args.get("args").and_then(|v| serde_json::from_value(v.clone()).ok());
        let mut paths = match class(cmd) {
            Class::Read => return Ok(None),
            Class::Git => match &argv {
                Some(a) if !git_writes(a) => return Ok(None),
                a => targets(args, a.as_deref().or(Some(&[]))),
            },
            Class::Write => targets(args, None),
        };
        if paths.is_empty() {
            return Ok(None);
        }
        if argv.as_deref().is_some_and(hides_location) {
            paths.push(PathBuf::from(UNKNOWN_LOCATION));
        }
        self.register_job(paths, crate::jobs::Kind::Short).await.map(Some)
    }

    /// 이 키들 중 하나라도 AI 차례가 도는 저장소이거나 어느 저장소인지 알 수 없으면(`unknown`) true. 메모리 확인뿐이다(키는 등록 때 이미 풀었다)
    pub(crate) fn keys_locked_by_ai(&self, keys: &[String], unknown: bool) -> bool {
        let busy = self.ai.repos.lock();
        !busy.is_empty() && (unknown || keys.iter().any(|k| busy.contains(k)))
    }
}

/// 위치를 알 수 없는 요청(위치를 환경 변수·include로 정하는 git 옵션)의 대리 경로. 드라이브 상대 경로라 어느 저장소와도 겹치는 것으로 본다(`is_drive_relative`가 `unknown`으로 만든다)
const UNKNOWN_LOCATION: &str = "C:unknown-location";

pub(crate) fn busy_error() -> String {
    gc_i18n::coded!("aiChat.repoBusy", "The AI is working in this repository. Try again when it finishes.").json()
}

/// 작업(`start_job`·`run_detached`)이 건드릴 수 있는 경로들: `repo`와 argv의 `-C`·`--git-dir`·`--work-tree`·`-c core.worktree` 대상(게이트와 같은 규칙)
pub(crate) fn job_targets(repo: &std::path::Path, argv: &[String]) -> Vec<PathBuf> {
    let mut t = targets(&serde_json::json!({"repo": repo.to_string_lossy()}), Some(argv));
    if hides_location(argv) {
        t.push(PathBuf::from(UNKNOWN_LOCATION)); // 위치를 알 수 없는 작업: 어느 저장소와도 겹치는 것으로 본다
    }
    t
}

/// 의도적으로 쓰기인 IPC 명령 전부(테스트용 목록: `dispatch`의 모든 이름은 읽기 목록이거나 여기 있어야 한다)
#[cfg(test)]
pub(crate) const WRITES: &[&str] = &[
    "jj_enable", "jj_disable", "jj_new", "jj_describe", "jj_edit", "jj_squash", "jj_split", "jj_abandon", "jj_undo", "jj_op_restore", "jj_bookmark_set", "jj_bookmark_delete", "jj_bookmark_track",
    "stage", "unstage", "discard", "trash_files", "restore_file", "apply_partial", "commit", "rebase_interactive", "fix_crlf", "append_line", "remove_git_dir", "write_in_repo", "ignore_write",
    "global_ignore_write", "global_ignore_ensure", "ssh_generate", "account_add", "account_remove", "pr_create", "pr_review_submit", "gh_switch", "gh_bind", "settings_export_file",
    "settings_import_apply", "stale_lock_remove", "ai_settings_set", "ai_key_set", "ai_key_delete", "ai_backup_restore", "open_in", "start_job", "start_shell", "ensure_commit_graph",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn w(s: &str) -> bool {
        git_writes(&s.split_whitespace().map(String::from).collect::<Vec<_>>())
    }

    #[test]
    fn reads() {
        for s in [
            "status --porcelain=v2", "log --oneline -5", "show HEAD:a.txt", "diff --cached --stat", "rev-parse --verify -q HEAD", "rev-list --count a..b", "merge-base a b",
            "ls-files -u -- x", "cat-file blob abc", "for-each-ref refs/heads", "blame -- a", "describe --dirty", "name-rev HEAD", "grep -n foo", "shortlog -sn", "check-ignore a",
            "var GIT_AUTHOR_IDENT", "version", "--version", "--no-pager log", "-P log", "-c core.quotepath=false diff --name-status a b", "-C /x -c a=b log", "--git-dir=/x/.git log",
            "--git-dir /x/.git --work-tree /x status", "--no-optional-locks status", "--no-pager -c color.ui=never log", "log -- --output", "format-patch --stdout -1", "diff --output-indicator-new=+",
            "log --output-indicator-new=+", "config --get user.name", "config --get-regexp ^git403", "config user.name", "config --local --get x", "config -l", "config --list", "config get user.name",
            "config list", "config -f .gitmodules --get-regexp x", "config --global --get-all x", "stash list", "stash show -p", "branch", "branch -r", "branch -a -v", "branch --list x*",
            "branch -r --contains abc", "branch --show-current", "branch --merged main", "branch --points-at HEAD", "tag", "tag -l", "tag --list v*", "tag -n", "tag --contains abc", "tag -v v1",
            "remote", "remote -v", "remote get-url origin", "remote show", "remote show -n origin", "remote -v show -n origin", "symbolic-ref --short refs/remotes/origin/HEAD", "symbolic-ref -q HEAD",
            "symbolic-ref --short -q HEAD", "worktree list", "worktree list --porcelain", "submodule", "submodule status", "submodule summary", "reflog", "reflog show HEAD", "lfs version", "lfs ls-files -l",
            "lfs track", "ls-files -o --exclude-standard", "grep -o foo", "apply --check p.patch", "apply --stat p", "ls-remote origin", "show-ref --verify refs/heads/x", "diff-tree -r HEAD",
        ] {
            assert!(!w(s), "읽기여야 함: git {s}");
        }
    }

    #[test]
    fn writes() {
        for s in [
            "commit -m x", "add .", "checkout main", "switch x", "reset --hard", "push", "pull", "fetch", "merge x", "rebase x", "cherry-pick x", "revert x", "clean -fd", "gc", "init", "clone u d",
            "stash", "stash push", "stash pop", "stash drop", "stash store -m x abc", "stash create", "branch x", "branch x main", "branch -d x", "branch -D x", "branch -m a b", "branch --move a b", "branch --del x",
            "branch -rd x", "branch -u origin/x", "branch --set-upstream-to=origin/x", "branch --unset-upstream", "branch -c a b", "tag v1", "tag -a v1 -m x", "tag -d v1", "tag --delete v1", "tag -s v1", "tag -f v1",
            "remote add o u", "remote -v add o u", "remote update", "remote -v update", "remote prune origin", "remote -v prune origin", "remote rm o", "remote remove o", "remote rename a b", "remote set-url o u",
            "remote show origin", "remote -v show origin", "symbolic-ref -d refs/remotes/origin/HEAD", "symbolic-ref --delete HEAD", "symbolic-ref -qd HEAD", "symbolic-ref HEAD refs/heads/x", "symbolic-ref -m r HEAD refs/heads/x",
            "worktree add ../x", "worktree remove x", "submodule update --init", "submodule foreach x", "submodule add u p", "reflog expire --all", "reflog delete HEAD@{1}", "lfs install", "lfs pull", "lfs track *.psd",
            "apply p.patch", "apply --index p", "apply --check --apply p", "config user.name x", "config --global user.name x", "config --local --unset x", "config --unset-all x", "config --add a b", "config -e",
            "config set a b", "config unset a", "config --replace-all a b", "config --remove-section a", "config --rename-section a b", "config", "config --local git403.issue.x v",
            "log --output=out.txt", "log --output out.txt", "show --output=x", "diff --output=x", "log --outp=x", "diff --ou=x", "format-patch -1", "format-patch -o dir -1", "format-patch -o. -1", "format-patch --output-directory=d -1",
            "format-patch --stdout -o d -1", "format-patch --output-dir d -1", "ls-files --with-tree=x --output", "frobnicate", "alias-x status", "--frob status", "-c", "-C", "--git-dir", "notes add", "update-ref -d x", "update-index --refresh",
            "reflog expire", "maintenance run", "prune", "repack", "fsck --lost-found", "am x", "bisect start", "sparse-checkout set a", "restore .", "mv a b", "rm a"
        ] {
            assert!(w(s), "쓰기여야 함: git {s}");
        }
    }

    #[test]
    fn empty_argv_reads_and_global_option_values_do_not_hide_the_command() {
        assert!(!git_writes(&[]));
        // 옵션 값이 하위 명령처럼 보여도(`-C log`) 진짜 하위 명령(`commit`)으로 판정한다
        assert!(w("-C log commit -m x"));
        assert!(w("-c log.x=y commit"));
        assert!(w("--git-dir log commit"));
        assert!(w("-P -C /r --no-optional-locks commit"));
        assert!(!w("-C commit log"));
        // `--`·인자 뒤의 `--output`은 옵션이 아니다 / 앞에 있으면 쓰기
        assert!(!w("log -- --output=x"));
        assert!(w("log --oneline --output=x"));
    }

    #[test]
    fn targets_follow_dash_c_git_dir_work_tree_and_core_worktree() {
        let a = |v: serde_json::Value, argv: &[&str]| {
            let argv: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
            targets(&v, Some(&argv))
        };
        let t = a(serde_json::json!({"repo": "/a"}), &["-C", "/b", "-C", "c", "commit"]);
        assert_eq!(t, vec![PathBuf::from("/a"), "/b".into(), "/b/c".into()]);
        let t = a(serde_json::json!({"repo": "/a"}), &["--git-dir=/b/.git", "--work-tree", "/b", "-c", "core.worktree=/d", "status"]);
        assert_eq!(t, vec![PathBuf::from("/a"), "/b/.git".into(), "/b".into(), "/d".into()]);
        let t = a(serde_json::json!({"repo": {"owner": "o", "name": "n", "path": "/p"}, "localRepo": "/l"}), &[]);
        assert_eq!(t, vec![PathBuf::from("/p"), "/l".into()]);
        assert!(a(serde_json::json!({"repo": {"owner": "o", "name": "n"}}), &[]).is_empty());
    }

    #[test]
    fn config_env_and_dash_c_that_move_the_repository_are_detected() {
        let v = |s: &str| s.split_whitespace().map(String::from).collect::<Vec<_>>();
        for s in [
            "--config-env core.worktree=WT commit", "--config-env=core.worktree=WT commit", "--config-env core.bare=B tag x", "--config-env=CORE.BARE=B tag x", "--config-env=core.gitdir=G tag x",
            "-c core.bare=true tag x", "-c core.worktree=/x tag x", "--no-pager --config-env core.worktree=W -C /r commit",
        ] {
            assert!(hides_location(&v(s)), "{s}");
            assert!(git_writes(&v(s)) || s.contains("status"), "{s}");
        }
        for s in ["--config-env user.name=N commit", "--config-env=user.name=N commit", "-c user.name=n commit", "commit --config-env core.worktree=W", "--config-env core.worktree", "status"] {
            assert!(!hides_location(&v(s)), "{s}");
        }
        // 옵션 값이 없으면 git이 거절할 인자: 쓰기로 본다
        assert!(git_writes(&v("--config-env")));
    }

    #[test]
    fn common_dir_follows_dot_git_files_and_commondir_without_running_git() {
        let d = tempfile::tempdir().unwrap();
        let root = gc_pathkey::real(d.path());
        let (main, wt, sub) = (root.join("main"), root.join("wt"), root.join("sub"));
        for p in [main.join(".git/worktrees/wt"), wt.clone(), sub.join("deep/er"), root.join("gitfile-sub")] {
            std::fs::create_dir_all(p).unwrap();
        }
        std::fs::create_dir_all(main.join(".git/objects")).unwrap();
        std::fs::write(main.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(main.join(".git/worktrees/wt/HEAD"), "ref: refs/heads/wt\n").unwrap();
        std::fs::write(main.join(".git/worktrees/wt/commondir"), "../..\n").unwrap();
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", main.join(".git/worktrees/wt").display())).unwrap();
        // 상대 gitdir(서브모듈 형태), commondir 없음 = 자기 git 폴더
        std::fs::create_dir_all(sub.join(".gitdata/objects")).unwrap();
        std::fs::write(sub.join(".gitdata/HEAD"), "x").unwrap();
        std::fs::write(sub.join(".git"), "gitdir: .gitdata\n").unwrap();
        let main_git = main.join(".git");
        assert_eq!(common_dir(&main), Some(main_git.clone()));
        assert_eq!(common_dir(&wt), Some(main_git.clone()));
        assert_eq!(common_dir(&wt.join("nope/x")), Some(main_git.clone()));
        assert_eq!(common_dir(&main.join(".git/worktrees/wt")), Some(main_git.clone()), "--git-dir=<worktree의 git 폴더>");
        assert_eq!(common_dir(&main_git), Some(main_git.clone()), "--git-dir=<.git>");
        assert_eq!(common_dir(&sub.join("deep/er")), Some(sub.join(".gitdata")));
        assert_eq!(common_dir(&root.join("gitfile-sub")), None, "저장소 아님");
        assert_eq!(lock_key(&wt), lock_key(&main));
        assert_ne!(lock_key(&sub), lock_key(&main));
    }

    /// 불신 저장소가 만든 `.git`·`commondir`: 멈추거나(FIFO) 엉뚱한 곳을 가리키지(잘린 줄·밖·순환) 않고, 5초 안에 끝난다
    #[test]
    fn common_dir_survives_hostile_git_files() {
        fn within(f: impl FnOnce() -> Option<PathBuf> + Send + 'static) -> Option<PathBuf> {
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || drop(tx.send(f())));
            rx.recv_timeout(std::time::Duration::from_secs(5)).expect("common_dir가 5초 안에 끝나지 않음(FIFO 등에서 멈춤)")
        }
        let d = tempfile::tempdir().unwrap();
        let root = gc_pathkey::real(d.path());
        let mk = |name: &str| {
            let p = root.join(name);
            std::fs::create_dir_all(&p).unwrap();
            p
        };
        // 1. `.git` 파일에 `gitdir:` 줄이 없다 → 저장소 아님
        let a = mk("no-gitdir-line");
        std::fs::write(a.join(".git"), "hello\nworld\n").unwrap();
        assert_eq!(within({ let a = a.clone(); move || common_dir(&a) }), None);
        // 2. 저장소 밖(없는 곳·폴더가 아닌 파일)을 가리킨다 → 저장소 아님(위 폴더에도 .git이 없으므로)
        let b = mk("outside");
        std::fs::write(b.join(".git"), "gitdir: /nonexistent/elsewhere\n").unwrap();
        assert_eq!(within({ let b = b.clone(); move || common_dir(&b) }), None);
        let c = mk("points-at-file");
        std::fs::write(c.join(".git"), format!("gitdir: {}\n", b.join(".git").display())).unwrap();
        assert_eq!(within({ let c = c.clone(); move || common_dir(&c) }), None);
        // 2b. 여러 바이트 문자(한글·이모지·결합 문자)·잘못된 UTF-8: panic 없이 끝난다(장치 경로 판정·접두 처리 포함)
        for (i, line) in ["gitdir: //./가나", "gitdir: //./유니코드/pipe", "gitdir: \\\\?\\가", "gitdir: //?/U🎉", "gitdir: //./UN가/", "gitdir: //./\u{301}é", "gitdir: 🎉🎉🎉", "gitdir: C:가나", "gitdir:", "gitdir: \u{301}\u{301}"].iter().enumerate() {
            let u = mk(&format!("unicode-{i}"));
            std::fs::write(u.join(".git"), line).unwrap();
            let u2 = u.clone();
            assert_eq!(within(move || common_dir(&u2)), None, "{line}");
        }
        let bad = mk("invalid-utf8");
        std::fs::write(bad.join(".git"), b"gitdir: \xff\xfe//./\xe3\x81\n").unwrap();
        assert_eq!(within({ let b = bad.clone(); move || common_dir(&b) }), None);
        let hangul = mk("한글-저장소");
        std::fs::create_dir_all(hangul.join(".git/objects")).unwrap();
        std::fs::write(hangul.join(".git/HEAD"), "x").unwrap();
        std::fs::write(hangul.join(".git/commondir"), "//./가나\n").unwrap();
        let _ = within({ let h = hangul.clone(); move || common_dir(&h) }); // 끝나기만 하면 된다(panic·멈춤 없음)
        // 3. 첫 줄이 4KB를 넘는다 → 잘라 읽지 않고 거절
        let e = mk("long-line");
        std::fs::create_dir_all(e.join("g/objects")).unwrap();
        std::fs::write(e.join("g/HEAD"), "x").unwrap();
        std::fs::write(e.join(".git"), format!("gitdir: {}/{}\n", e.join("g").display(), "../g/".repeat(1500))).unwrap();
        assert_eq!(within({ let e = e.clone(); move || common_dir(&e) }), None);
        std::fs::write(e.join(".git"), "gitdir: ".to_string() + &"a".repeat(5000)).unwrap(); // 줄바꿈 없이 4KB 초과
        assert_eq!(within({ let e = e.clone(); move || common_dir(&e) }), None);
        // 4. 순환 링크: `.git` 자신, 서로를 가리키는 링크, commondir 순환
        #[cfg(unix)]
        {
            let l = mk("loop");
            std::os::unix::fs::symlink(l.join(".git"), l.join(".git")).unwrap();
            assert_eq!(within({ let l = l.clone(); move || common_dir(&l) }), None);
            let m = mk("loop2");
            std::os::unix::fs::symlink(m.join("y"), m.join("x")).unwrap();
            std::os::unix::fs::symlink(m.join("x"), m.join("y")).unwrap();
            std::os::unix::fs::symlink(m.join("x"), m.join(".git")).unwrap();
            assert_eq!(within({ let m = m.clone(); move || common_dir(&m) }), None);
            let g = mk("cd-loop");
            std::fs::create_dir_all(g.join(".git/objects")).unwrap();
            std::fs::write(g.join(".git/HEAD"), "x").unwrap();
            std::os::unix::fs::symlink(g.join(".git/commondir"), g.join(".git/commondir")).unwrap();
            assert_eq!(within({ let g = g.clone(); move || common_dir(&g) }), Some(g.join(".git")), "commondir를 못 읽으면 자기 git 폴더");
            // 5. FIFO: `commondir`·`.git` 파일·그것을 가리키는 링크 — 열지 않고 끝난다
            let fifo = |p: &std::path::Path| {
                let c = std::ffi::CString::new(p.to_str().unwrap()).unwrap();
                extern "C" {
                    fn mkfifo(path: *const std::os::raw::c_char, mode: u32) -> i32;
                }
                assert_eq!(unsafe { mkfifo(c.as_ptr(), 0o600) }, 0);
            };
            let f = mk("fifo-commondir");
            std::fs::create_dir_all(f.join(".git/objects")).unwrap();
            std::fs::write(f.join(".git/HEAD"), "x").unwrap();
            fifo(&f.join(".git/commondir"));
            assert_eq!(within({ let f = f.clone(); move || common_dir(&f) }), Some(f.join(".git")), "FIFO commondir는 열지 않고 자기 git 폴더");
            let f2 = mk("fifo-dotgit");
            fifo(&f2.join(".git"));
            assert_eq!(within({ let f2 = f2.clone(); move || common_dir(&f2) }), None);
            let f3 = mk("fifo-link");
            fifo(&f3.join("pipe"));
            std::os::unix::fs::symlink(f3.join("pipe"), f3.join(".git")).unwrap();
            assert_eq!(within({ let f3 = f3.clone(); move || common_dir(&f3) }), None);
            let f4 = mk("fifo-commondir-link");
            std::fs::create_dir_all(f4.join(".git/objects")).unwrap();
            std::fs::write(f4.join(".git/HEAD"), "x").unwrap();
            fifo(&f4.join("pipe"));
            std::os::unix::fs::symlink(f4.join("pipe"), f4.join(".git/commondir")).unwrap();
            assert_eq!(within({ let f4 = f4.clone(); move || common_dir(&f4) }), Some(f4.join(".git")));
        }
    }

    #[test]
    fn device_paths_are_detected_and_open_regular_judges_the_opened_handle() {
        for p in [r"\\.\pipe\x", "//./pipe/x", r"\\?\GLOBALROOT\Device\x", r"\\.\COM1", "//?/pipe/x"] {
            assert!(is_device_path(p), "{p}");
        }
        for p in [r"\\?\C:\repo", r"\\.\C:\repo", r"\\?\UNC\srv\share", "//?/unc/srv/share", r"C:\repo", "/tmp/x", r"\\srv\share", "x"] {
            assert!(!is_device_path(p), "{p}");
        }
        let d = tempfile::tempdir().unwrap();
        let root = gc_pathkey::real(d.path());
        std::fs::write(root.join("f"), "hi\n").unwrap();
        assert!(open_regular(&root.join("f")).is_some());
        assert_eq!(first_line(&root.join("f")).as_deref(), Some("hi"));
        assert!(open_regular(&root).is_none(), "폴더는 열려도(유닉스) 일반 파일이 아니다");
        assert!(open_regular(&root.join("missing")).is_none());
        #[cfg(unix)]
        {
            extern "C" {
                fn mkfifo(path: *const std::os::raw::c_char, mode: u32) -> i32;
            }
            let c = std::ffi::CString::new(root.join("pipe").to_str().unwrap()).unwrap();
            assert_eq!(unsafe { mkfifo(c.as_ptr(), 0o600) }, 0);
            std::os::unix::fs::symlink(root.join("pipe"), root.join("link")).unwrap();
            // 사전 `metadata` 검사 없이 곧바로 열어도(= 검사 뒤 바꿔치기와 같은 상태) 멈추지 않고 fstat이 거절한다. 쓰는 쪽이 있든 없든 같다
            let t = std::time::Instant::now();
            assert!(open_regular(&root.join("pipe")).is_none() && open_regular(&root.join("link")).is_none());
            use std::os::unix::fs::OpenOptionsExt;
            let _r = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(root.join("pipe")).unwrap();
            let _w = std::fs::OpenOptions::new().write(true).open(root.join("pipe")).unwrap();
            assert!(open_regular(&root.join("pipe")).is_none() && first_line(&root.join("link")).is_none());
            assert!(t.elapsed() < std::time::Duration::from_secs(3));
        }
    }

    /// 무작위 불신 문자열(한글·이모지·결합 문자·장치/UNC 접두·옵션 조각)로 판정 함수들이 panic하지 않는다(간단한 xorshift 반복 생성, 새 의존성 없음)
    #[test]
    fn random_hostile_strings_never_panic() {
        const TOK: &[&str] = &[
            "", " ", "\\", "/", "//", ":", ".", "..", "?", "-", "--", "=", "C", "c:", "C:", "UNC", "unc/", "\\\\?\\", "\\\\.\\", "//./", "//?/", "가", "나다", "🎉", "e\u{301}", "\u{301}", "\u{200b}", "é",
            "\0", "\n", "-c", "-C", "--git-dir", "--git-dir=", "--work-tree", "--config-env", "--config-env=core.worktree=X", "core.worktree=가", "commit", "remote", "show", "-n", "-v", "update", "branch", "-d", "tag",
            "config", "--get", "stash", "symbolic-ref", "format-patch", "-o", "--output", "--output=x", "log", "lfs", "track", "--", "-rd", "--del", "--o", "gitdir:", "x",
        ];
        let mut seed = 0x9E37_79B9_7F4A_7C15u64;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for _ in 0..30_000 {
            let n = (next() % 9) as usize;
            let toks: Vec<String> = (0..n).map(|_| TOK[(next() % TOK.len() as u64) as usize].to_owned()).collect();
            let joined = toks.concat();
            // pathkey
            let (a, b) = (joined.as_str(), toks.first().map_or("", String::as_str));
            let _ = (gc_pathkey::key_str(a), gc_pathkey::strip_verbatim(a), gc_pathkey::is_drive_relative(a), gc_pathkey::key_strict(a));
            let _ = (gc_pathkey::rel_folded(a, b), gc_pathkey::rel_strict(a, b), gc_pathkey::contains_strict(b, a), gc_pathkey::same_folded(a, b), gc_pathkey::same_strict(b, a));
            // repo_gate
            let _ = is_device_path(a);
            let _ = (git_writes(&toks), hides_location(&toks), parse(&toks).cmd);
            let _ = targets(&serde_json::json!({"repo": a, "localRepo": b, "args": toks}), Some(&toks));
            let _ = targets(&serde_json::json!({"repo": {"path": a, "dir": b}}), None);
            let _ = class(a);
            // 파일 시스템을 거치는 함수는 횟수를 줄여 몇 번만(상대 경로·이상한 이름도 panic 없이)
            if next() % 300 == 0 {
                let _ = (gc_pathkey::real(a), lock_key(std::path::Path::new(a)));
            }
        }
    }

    #[test]
    fn unc_and_device_targets_are_rejected_unless_the_repository_itself_is_on_unc() {
        for t in [r"\\localhost\pipe\x", r"\\127.0.0.1\pipe\x", r"\\host\share\r\.git", "//host/share/x", r"\\?\UNC\host\share\x", r"\\.\pipe\x", "//?/GLOBALROOT/x"] {
            assert!(!target_allowed(t, r"C:\repo"), "{t}");
            assert!(!target_allowed(t, "/home/me/repo"), "{t}");
        }
        // 저장소 자체가 UNC 공유에 있으면 UNC gitdir은 허용(장치 경로는 언제나 거절)
        assert!(target_allowed(r"\\srv\share\r\.git\worktrees\w", r"\\srv\share\r"));
        assert!(target_allowed(r"\\?\UNC\srv\share\r\.git", r"\\srv\share\r"));
        assert!(!target_allowed(r"\\.\pipe\x", r"\\srv\share\r"));
        for t in [r"C:\repo\.git", r"\\?\C:\repo\.git", "/tmp/r/.git", "../../.git", ".gitdata"] {
            assert!(target_allowed(t, r"C:\repo"), "{t}");
        }
        assert!(is_unc(r"\\h\s") && is_unc("//h/s") && is_unc(r"\\?\unc\h\s") && !is_unc(r"\\?\C:\x") && !is_unc(r"\\.\pipe\x") && !is_unc("/tmp/x") && !is_unc(r"C:\x") && !is_unc("가나"));
    }

    #[test]
    fn hostile_gitfile_pointing_at_unc_or_device_makes_the_request_unknown() {
        let d = tempfile::tempdir().unwrap();
        let root = gc_pathkey::real(d.path());
        for (i, target) in [r"\\localhost\pipe\x", "//127.0.0.1/pipe/x", r"\\.\pipe\x", r"\\host\share\r\.git"].iter().enumerate() {
            let r = root.join(format!("r{i}"));
            std::fs::create_dir_all(&r).unwrap();
            std::fs::write(r.join(".git"), format!("gitdir: {target}\n")).unwrap();
            let got = resolve_keys(&r);
            assert!(got.unknown, "{target}: {got:?}");
        }
        // commondir가 UNC를 가리키는 경우
        let r = root.join("cd");
        std::fs::create_dir_all(r.join(".git/objects")).unwrap();
        std::fs::write(r.join(".git/HEAD"), "x").unwrap();
        std::fs::write(r.join(".git/commondir"), "//127.0.0.1/pipe/x\n").unwrap();
        assert!(resolve_keys(&r).unknown);
        // 정상 저장소는 unknown이 아니다
        let ok = root.join("ok");
        std::fs::create_dir_all(ok.join(".git/objects")).unwrap();
        std::fs::write(ok.join(".git/HEAD"), "x").unwrap();
        assert_eq!(resolve_keys(&ok), Resolved { keys: vec![gc_pathkey::key(ok.join(".git"))], unknown: false });
    }

    #[test]
    fn core_worktree_in_the_repository_own_config_is_read_without_running_git() {
        let d = tempfile::tempdir().unwrap();
        let root = gc_pathkey::real(d.path());
        let g = root.join("evil/.git");
        std::fs::create_dir_all(g.join("objects")).unwrap();
        std::fs::write(g.join("HEAD"), "x").unwrap();
        let busy = root.join("busy");
        std::fs::create_dir_all(busy.join(".git/objects")).unwrap();
        std::fs::write(busy.join(".git/HEAD"), "x").unwrap();
        let cfg = |t: &str| {
            std::fs::write(g.join("config"), t).unwrap();
            core_worktree(&g, &g.join("config"))
        };
        assert_eq!(cfg("[core]\n\tbare = false\n"), WorktreeCfg::None);
        assert_eq!(cfg(&format!("[core]\n\tworktree = {}\n", busy.display())), WorktreeCfg::Path(PathBuf::from(&busy)));
        assert_eq!(cfg("[CORE]\n  WorkTree=../../busy\n"), WorktreeCfg::Path(g.join("../../busy")));
        assert_eq!(cfg("[remote \"o\"]\n\tworktree = x\n"), WorktreeCfg::None, "다른 섹션의 같은 이름 키");
        assert_eq!(cfg("[core \"x\"]\n\tworktree = /x\n"), WorktreeCfg::None, "하위 섹션은 core가 아니다");
        assert_eq!(cfg("[core.x]\n\tworktree = /x\n"), WorktreeCfg::None);
        assert_eq!(cfg("[core]\n\tworktree = /a\n\tworktree = /b\n"), WorktreeCfg::Path(PathBuf::from("/b")), "마지막 값이 이긴다");
        // git 문법: BOM·따옴표·이스케이프·주석·이어붙이기·같은 줄 값
        assert_eq!(cfg("\u{feff}[core]\n\tworktree = /bom\n"), WorktreeCfg::Path(PathBuf::from("/bom")), "첫 줄 BOM은 git이 건너뛴다");
        assert_eq!(cfg("[core]\n\tworktree = \"/x y\"\n"), WorktreeCfg::Path(PathBuf::from("/x y")));
        assert_eq!(cfg("[core]\n\tworktree = /x # c\n"), WorktreeCfg::Path(PathBuf::from("/x")));
        assert_eq!(cfg("[core]\n\tworktree = /x ; c\n"), WorktreeCfg::Path(PathBuf::from("/x")));
        assert_eq!(cfg("[core]\n\tworktree = \"/x#y\" # c\n"), WorktreeCfg::Path(PathBuf::from("/x#y")), "따옴표 안의 #는 주석이 아니다");
        assert_eq!(cfg("[core]\n\tworktree = C:\\\\Users\\\\x\n"), WorktreeCfg::Path(g.join("C:\\Users\\x")), "윈도 경로의 이스케이프된 역슬래시");
        assert_eq!(cfg("[core]\n\tworktree = /a\\\n/b\n"), WorktreeCfg::Path(PathBuf::from("/a/b")), "줄 끝 \\는 이어붙이기");
        assert_eq!(cfg("[core] worktree = /same-line\n"), WorktreeCfg::Path(PathBuf::from("/same-line")), "섹션 머리와 같은 줄");
        assert_eq!(cfg("[core]\n\tworktree = \"a\\tb\"\n"), WorktreeCfg::Path(g.join("a\tb")));
        assert_eq!(cfg("[core]\n\tworktree =   /sp  \n"), WorktreeCfg::Path(PathBuf::from("/sp")), "따옴표 밖 앞뒤 공백 제거");
        for t in [
            "[core]\n\tworktree = C:\\path\n", "[core]\n\tworktree = \"/unterminated\n", "[core]\n\tworktree = /x\\q\n", "[core]\n\tworktree = ~/x\n", "[core]\n\tworktree\n", "[include]\n\tpath = /elsewhere\n",
            "[includeIf \"gitdir:/\"]\n\tpath = x\n", "[core]\n\tworktree = \n", "[core\n", "[core]\n\t= x\n", "[core]\n\tworktree = %(prefix)/x\n", "[core]\n\tworktree /x\n",
        ] {
            assert_eq!(cfg(t), WorktreeCfg::Unknown, "{t}");
        }
        std::fs::write(g.join("config"), "x".repeat(300_000)).unwrap();
        assert_eq!(core_worktree(&g, &g.join("config")), WorktreeCfg::Unknown, "너무 큰 설정");
        // resolve_keys: 설정이 가리키는 작업 트리의 키가 들어간다(그 값으로 잠긴 저장소와 겹치는지 본다)
        std::fs::write(g.join("config"), format!("[core]\n\tworktree = {}\n", busy.display())).unwrap();
        let r = resolve_keys(&root.join("evil"));
        assert!(!r.unknown && r.keys.contains(&lock_key(&busy)), "{r:?}");
        std::fs::write(g.join("config"), "[core]\n\tworktree = \"x\\q\"\n").unwrap();
        assert!(resolve_keys(&root.join("evil")).unknown, "git도 읽지 못하는 값은 막는다");
        // FIFO config는 열지 않고 알 수 없음으로(막는 쪽)
        #[cfg(unix)]
        {
            std::fs::remove_file(g.join("config")).unwrap();
            extern "C" {
                fn mkfifo(path: *const std::os::raw::c_char, mode: u32) -> i32;
            }
            let c = std::ffi::CString::new(g.join("config").to_str().unwrap()).unwrap();
            assert_eq!(unsafe { mkfifo(c.as_ptr(), 0o600) }, 0);
            assert_eq!(core_worktree(&g, &g.join("config")), WorktreeCfg::Unknown);
        }
    }

    /// 실제 `git config --file … --get core.worktree`와 같은 값을 읽는다(git의 BOM·따옴표·이스케이프·주석·이어붙이기·섹션 규칙 교차 확인).
    /// git이 오류로 끝내는 입력은 우리도 알 수 없음(`Err`)이어야 한다
    #[test]
    fn core_worktree_parser_agrees_with_real_git_config() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("cfg");
        let cases: &[&str] = &[
            "[core]\n\tworktree = /a/b\n", "[core]\nworktree=/a/b\n", "[CoRe]\n  WORKTREE  =  /a/b  \n", "\u{feff}[core]\n\tworktree = /bom\n", "[core]\n\tworktree = \"/q a\"\n", "[core]\n\tworktree = /a\" b\"\n",
            "[core]\n\tworktree = \"/a#b\"\n", "[core]\n\tworktree = /a # c\n", "[core]\n\tworktree = /a ; c\n", "[core]\n\tworktree = /a\\\\b\n", "[core]\n\tworktree = C:\\\\Users\\\\x\n",
            "[core]\n\tworktree = /a\\\n/b\n", "[core]\n\tworktree = \"a\\tb\"\n", "[core]\n\tworktree = a\\\"b\n", "[core]\n\tworktree = /a\n\tworktree = /b\n", "[core] worktree = /same\n",
            "[core]\n\tbare = false\n", "[core \"x\"]\n\tworktree = /x\n", "[core.x]\n\tworktree = /x\n", "[remote \"o\"]\n\tworktree = /x\n", "# c\n[core]\n; c\n\tworktree = /c\n",
            "[core]\n\tworktree = /a   b\n", "[core]\n\tworktree = \"  lead\"\n", "[core]\n\tworktree = \"/x\"\n\tworktree = /y\n", "[core]\r\n\tworktree = /crlf\r\n",
            "[core]\n\tworktree = /x\\q\n", "[core]\n\tworktree = \"/unterminated\n", "[core]\n\tworktree = C:\\path\n", "[core\n\tworktree = /x\n", "[core]\n\t= x\n", "[core]\n\tworktree /x\n",
        ];
        let mut compared = 0;
        for t in cases {
            std::fs::write(&f, t).unwrap();
            let out = std::process::Command::new("git").args(["config", "--file"]).arg(&f).args(["--get", "core.worktree"]).output().unwrap();
            let mine = parse_core_worktree(t);
            match out.status.code() {
                Some(0) => assert_eq!(mine, Ok(Some(String::from_utf8_lossy(&out.stdout).trim_end_matches('\n').to_owned())), "git이 읽은 값과 다름: {t:?}"),
                Some(1) => assert_eq!(mine, Ok(None), "git은 값 없음: {t:?}"),
                // git이 설정 오류로 끝내는 입력: 우리도 풀 수 없다고 해야 한다
                _ => assert_eq!(mine, Err(()), "git은 오류({}): {t:?}", String::from_utf8_lossy(&out.stderr).trim()),
            }
            compared += 1;
        }
        assert_eq!(compared, cases.len());
    }

    #[test]
    fn include_options_hide_the_repository_location() {
        let v = |s: &str| s.split_whitespace().map(String::from).collect::<Vec<_>>();
        for s in ["-c include.path=/x commit", "-c INCLUDE.PATH=/x commit", "-c includeIf.gitdir:/r.path=/x commit", "--config-env include.path=VAR commit", "--config-env=includeif.onbranch:x.path=VAR commit"] {
            assert!(hides_location(&v(s)), "{s}");
        }
        for s in ["-c includes.x=1 commit", "-c user.name=n commit", "--config-env user.name=VAR commit"] {
            assert!(!hides_location(&v(s)), "{s}");
        }
    }

    #[test]
    fn unknown_commands_are_writes_and_ai_own_commands_are_not() {
        assert_eq!(class("brand_new_ipc"), Class::Write);
        assert_eq!(class("ai_chat_start"), Class::Read);
        assert_eq!(class("ai_backup_restore"), Class::Write);
        assert_eq!(class("git"), Class::Git);
        assert_eq!(class("start_job"), Class::Write);
        assert_eq!(class("load_status"), Class::Read);
    }

    /// `dispatch`의 모든 명령 이름이 읽기 목록에 있거나 의도적으로 쓰기 목록(아래)에 있다: 새 IPC를 읽기로 표시하지 않고 쓰기 목록에도 안 넣으면 실패해서 판단을 강제한다
    #[test]
    fn every_dispatch_command_is_classified() {
        let src = include_str!("dispatch.rs");
        let mut seen = 0;
        for line in src.lines() {
            let t = line.trim_start();
            let Some(rest) = t.strip_prefix('"') else { continue };
            let Some((names, after)) = rest.split_once("=>") else { continue };
            if !names.trim_end().ends_with('"') {
                continue;
            }
            for n in names.split('|').map(|n| n.trim().trim_matches('"')) {
                if n.is_empty() || n.contains(' ') || n.chars().any(|c| !(c.is_ascii_lowercase() || c == '_')) {
                    continue;
                }
                let _ = after;
                seen += 1;
                assert!(class(n) != Class::Write || super::WRITES.contains(&n), "dispatch 명령 `{n}`이 읽기 목록(`class`)에도 쓰기 목록(이 테스트의 WRITES)에도 없다 — 읽기인지 판단해서 적어라");
            }
        }
        assert!(seen > 100, "dispatch 파싱이 깨짐: {seen}");
        for n in super::WRITES {
            assert_eq!(class(n), Class::Write, "{n}");
            assert!(src.contains(&format!("\"{n}\"")), "WRITES의 `{n}`은 dispatch에 없다");
        }
    }
}
