//! AI 채팅 시작 전·도구 호출마다 **저장소 쪽 git 설정을 허용 목록으로 판정**한다(docs/security.md "저장소는 신뢰하지 않는다").
//! 판정 대상: 상위 저장소의 local·worktree 설정(include 포함), 공통 git 폴더의 `modules/**/config`(서브모듈), `worktrees/*/config.worktree`,
//! 그리고 `rev-parse`가 알려 주는 최상위 폴더·git 폴더(core.worktree·꾸며 낸 `.git` 파일로 저장소 밖을 가리키는지).
//! 모든 키가 아래 안전 목록에 있어야 "깨끗함". 목록 밖 키는 `review`(사용자 확인 필요, 키 이름 표시),
//! 확인으로도 허용할 수 없는 것(`refuse`: 저장소 밖 worktree·bare·mirror·비기본 fetch/push refspec·백업 이름공간 언급)은 거절한다.
//! 순수 판정(`judge`)과 git을 실행해 모으는 부분(`check`, 동기 `std::process::Command`)을 나눠, 앱과 MCP 서버가 같은 판정·같은 지문을 쓴다.

use std::path::{Path, PathBuf};
use std::process::Stdio;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Verdict {
    /// 확인으로도 허용할 수 없는 사유(영어, 사용자·모델에게 그대로 보인다)
    pub refuse: Vec<String>,
    /// 안전 목록 밖 키 이름(값 없음, 중복 제거·정렬). 비어 있지 않으면 사용자 확인이 필요하다
    pub review: Vec<String>,
    /// 판정에 쓴 설정 전체(원본 키·값, 출처 포함)의 지문. 앱이 확인한 값과 서버가 호출 때마다 다시 계산한 값이 같아야 한다
    pub fingerprint: String,
    /// 설정(상위·서브모듈·worktree·include 전부)이 가리키는 훅 폴더(`core.hooksPath`)의 저장소 상대 경로. AI는 여기를 쓰지 못한다(`ai_tool::set_extra_protected`)
    pub hooks_dirs: Vec<String>,
    /// include 대상 설정 파일 중 **저장소 안**의 경로(저장소 상대, 아직 없는 파일 포함). 여기에 `core.fsmonitor` 같은 것을 심으면 설정이 바뀌므로 AI는 쓰지 못한다
    pub config_files: Vec<String>,
}

impl Verdict {
    /// AI가 쓰면 안 되는 설정 의존 경로 전부(`ai_tool::set_extra_protected`에 넘긴다)
    pub fn protected_paths(&self) -> Vec<String> {
        self.hooks_dirs.iter().chain(&self.config_files).cloned().collect()
    }
}

/// 설정 항목 하나의 출처: 상위 저장소 설정, 또는 서브모듈·다른 worktree 설정 파일(그 파일이 있는 폴더)
#[derive(Clone)]
pub enum Source {
    Top,
    Other(PathBuf),
}

/// 표준 git-lfs 필터 정의(`git lfs install`이 쓰는 값)
fn lfs_standard(key: &str, value: &str) -> bool {
    matches!((key, value), ("filter.lfs.clean", "git-lfs clean -- %f") | ("filter.lfs.smudge", "git-lfs smudge -- %f") | ("filter.lfs.process", "git-lfs filter-process") | ("filter.lfs.required", _))
}

enum J {
    Safe,
    Review,
    Refuse(String),
}

/// 값 형식. 실행·경로를 담을 수 있는 자유 문자열은 안전 목록에 넣지 않는다: bool·정수·열거형·이름꼴만.
#[derive(Clone, Copy)]
enum Vk {
    Bool,
    Int,
    /// bool 또는 나열한 값 중 하나
    BoolOr(&'static [&'static str]),
    Enum(&'static [&'static str]),
    /// 이름꼴(`[A-Za-z0-9._/@{}-]`, 200자까지, `.`·`/`·`-`로 시작 불가, `..` 불가) — 브랜치·원격 이름 등
    Word,
}

fn val_ok(vk: Vk, v: &str) -> bool {
    let l = v.to_ascii_lowercase();
    let boolean = |l: &str| matches!(l, "true" | "false" | "yes" | "no" | "on" | "off" | "1" | "0" | "");
    match vk {
        Vk::Bool => boolean(&l),
        Vk::Int => !l.is_empty() && l.trim_end_matches(['k', 'm', 'g']).chars().all(|c| c.is_ascii_digit()) && l.len() <= 12,
        Vk::BoolOr(x) => boolean(&l) || x.contains(&l.as_str()),
        Vk::Enum(x) => x.contains(&l.as_str()),
        Vk::Word => !v.is_empty() && v.len() <= 200 && !v.starts_with(['.', '/', '-']) && !v.contains("..") && v.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '@' | '{' | '}' | '-')),
    }
}

/// 같은 컴퓨터의 경로를 가리키는 원격 URL인가(절대·상대 경로, `~`, `file://`, Windows 드라이브). AI 차례에서는 쓰지 않는다:
/// 대상 저장소의 설정(`core.alternateRefsCommand` 등)이 push·fetch 때 실행되고, fetch로 밖을 읽고 push로 밖에 쓸 수 있다.
pub fn is_local_url(u: &str) -> bool {
    let b = u.as_bytes();
    u.starts_with(['/', '.', '~', '\\']) || u.to_ascii_lowercase().starts_with("file:") || (b.len() > 2 && b[1] == b':' && b[0].is_ascii_alphabetic() && (b[2] == b'\\' || b[2] == b'/'))
}

/// 경로를 정규화(심볼릭 링크 해석, 아직 없으면 있는 조상까지)
fn canon(p: &Path) -> PathBuf {
    let mut probe = p.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while probe.symlink_metadata().is_err() {
        match (probe.file_name().map(|n| n.to_owned()), probe.pop()) {
            (Some(n), true) => tail.push(n),
            _ => break,
        }
    }
    let mut real = probe.canonicalize().unwrap_or(probe);
    real.extend(tail.iter().rev());
    real
}

/// 설정 키 하나를 **하위 키 단위 허용 목록**으로 판정한다(묶음 단위 허용 없음 — `gc.recentObjectsHook` 같은 실행형 하위 키가 묶음에 숨지 못하게).
/// 목록에 없는 키·형식이 틀린 값은 `Review`. 확인으로도 못 넘기는 것은 `Refuse`.
fn judge_entry(key: &str, value: &str, src: &Source, repo: &Path) -> J {
    // 앱의 백업 이름공간을 가리키는 설정은 키든 값이든 어디서나 거절
    if key.contains("refs/git403") || value.to_ascii_lowercase().contains("refs/git403") {
        return J::Refuse(format!("{key} refers to the app's backup namespace (refs/git403/)"));
    }
    let parts: Vec<&str> = key.split('.').collect();
    let (section, var) = (parts[0], parts[parts.len() - 1]);
    let sub = if parts.len() > 2 { parts[1..parts.len() - 1].join(".") } else { String::new() };
    let two = parts.len() == 2;
    let truthy = |v: &str| !matches!(v.to_ascii_lowercase().as_str(), "false" | "no" | "off" | "0" | "");
    let v = |vk: Vk| if val_ok(vk, value) { J::Safe } else { J::Review };
    match (section, two) {
        ("core", true) => match var {
            "bare" if truthy(value) => J::Refuse("core.bare=true (a bare repository has no working tree to protect)".into()),
            "bare" => J::Safe,
            "worktree" => {
                let base = match src {
                    Source::Top => None,
                    Source::Other(d) => Some(d.clone()),
                };
                // 상대 경로는 그 설정 파일이 있는 git 폴더 기준. 상위 저장소는 이 저장소 폴더와 같아야 하고, 서브모듈은 저장소 안이어야 한다
                let abs = if Path::new(value).is_absolute() { PathBuf::from(value) } else { base.clone().unwrap_or_else(|| repo.join(".git")).join(value) };
                let (abs, root) = (canon(&abs), canon(repo));
                let allowed = if base.is_none() { abs == root } else { abs.starts_with(&root) };
                if allowed { J::Safe } else { J::Refuse(format!("core.worktree points outside the repository folder ({value})")) }
            }
            "repositoryformatversion" => v(Vk::Int),
            "filemode" | "ignorecase" | "precomposeunicode" | "symlinks" | "quotepath" | "preloadindex" | "commitgraph" | "sparsecheckout" | "sparsecheckoutcone" | "longpaths" | "protectntfs" | "protecthfs" | "fsmonitor" => v(Vk::Bool),
            "logallrefupdates" => v(Vk::BoolOr(&["always"])),
            "autocrlf" => v(Vk::BoolOr(&["input"])),
            "eol" => v(Vk::Enum(&["lf", "crlf", "native"])),
            "safecrlf" => v(Vk::BoolOr(&["warn"])),
            "untrackedcache" => v(Vk::BoolOr(&["keep"])),
            "abbrev" => if val_ok(Vk::Int, value) || matches!(value, "auto" | "no") { J::Safe } else { J::Review },
            // 훅 폴더는 사용자의 다음 commit이 실행한다(AI 차례에는 앱이 `-c core.hooksPath=<null 장치>`로 덮어쓰지만 그 뒤에는 아니다) — 비어 있지 않으면 검토 대상
            "hookspath" => if value.is_empty() { J::Safe } else { J::Review },
            _ => J::Review,
        },
        ("extensions", true) => match var {
            "objectformat" => v(Vk::Enum(&["sha1", "sha256"])),
            "refstorage" => v(Vk::Enum(&["files", "reftable"])),
            "worktreeconfig" | "preciousobjects" => v(Vk::Bool),
            _ => J::Review,
        },
        ("remote", false) => match var {
            "url" | "pushurl" => {
                if is_local_url(value) { J::Refuse(format!("remote {sub} points to a local path or file:// URL ({value}): the target repository's own configuration could run programs")) } else { J::Safe }
            }
            "fetch" => {
                if value == format!("+refs/heads/*:refs/remotes/{sub}/*") || value == format!("refs/heads/*:refs/remotes/{sub}/*") {
                    J::Safe
                } else {
                    J::Refuse(format!("remote.{sub}.fetch is not the default refspec ({value}): fetch could overwrite or delete local refs"))
                }
            }
            "mirror" if truthy(value) => J::Refuse(format!("remote.{sub}.mirror is enabled: push could delete or force-update remote branches")),
            "mirror" => J::Safe,
            "push" if !value.is_empty() => J::Refuse(format!("remote.{sub}.push is set ({value}): push could update unexpected remote refs")),
            "push" => J::Safe,
            "prune" | "prunetags" | "promisor" => v(Vk::Bool),
            "tagopt" => v(Vk::Enum(&["--no-tags", "--tags"])),
            "partialclonefilter" => if !value.is_empty() && value.len() <= 80 && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '=' | '.' | '_' | '-')) { J::Safe } else { J::Review },
            _ => J::Review,
        },
        ("branch", false) => match var {
            "remote" | "pushremote" => v(Vk::Word),
            "merge" | "vscode-merge-base" => v(Vk::Word),
            "rebase" => v(Vk::BoolOr(&["merges", "interactive", "i", "m"])),
            "description" => J::Safe,
            _ => J::Review,
        },
        ("user", true) => match var {
            "name" | "email" => J::Safe,
            "useconfigonly" => v(Vk::Bool),
            _ => J::Review,
        },
        ("init", true) if var == "defaultbranch" => v(Vk::Word),
        ("filter", false) => {
            if sub == "lfs" && (lfs_standard(key, value) || (var == "required" && val_ok(Vk::Bool, value))) { J::Safe } else { J::Review }
        }
        // `lfs.url`: git-lfs 서버(대용량 파일을 보내고 받는 곳). 같은 컴퓨터의 경로는 거절, http(s)만 안전
        ("lfs", true) if var == "url" => {
            if is_local_url(value) { J::Refuse(format!("lfs.url points to a local path or file:// URL ({value})")) } else if value.starts_with("https://") || value.starts_with("http://") { J::Safe } else { J::Review }
        }
        ("submodule", false) => match var {
            "url" => J::Safe,
            "active" => v(Vk::Bool),
            "branch" | "path" => v(Vk::Word),
            "update" => v(Vk::Enum(&["checkout", "rebase", "merge", "none"])),
            "ignore" => v(Vk::Enum(&["all", "dirty", "untracked", "none"])),
            "fetchrecurse" => v(Vk::BoolOr(&["on-demand"])),
            _ => J::Review,
        },
        ("submodule", true) if var == "recurse" => v(Vk::Bool),
        ("pull", true) => match var {
            "rebase" => v(Vk::BoolOr(&["merges", "interactive", "i", "m"])),
            "ff" => v(Vk::BoolOr(&["only"])),
            _ => J::Review,
        },
        ("push", true) => match var {
            "default" => v(Vk::Enum(&["nothing", "current", "upstream", "tracking", "simple", "matching"])),
            "followtags" | "autosetupremote" => v(Vk::Bool),
            _ => J::Review,
        },
        ("merge", true) => match var {
            "ff" => v(Vk::BoolOr(&["only"])),
            "conflictstyle" => v(Vk::Enum(&["merge", "diff3", "zdiff3"])),
            "renormalize" => v(Vk::Bool),
            "directoryrenames" => v(Vk::BoolOr(&["conflict"])),
            "renames" => v(Vk::BoolOr(&["copies", "copy"])),
            "stat" => v(Vk::BoolOr(&["compact"])),
            _ => J::Review,
        },
        ("rebase", true) => match var {
            "autostash" | "autosquash" | "updaterefs" | "stat" => v(Vk::Bool),
            _ => J::Review,
        },
        ("diff", true) => match var {
            "renames" => v(Vk::BoolOr(&["copies", "copy"])),
            "algorithm" => v(Vk::Enum(&["default", "myers", "minimal", "patience", "histogram"])),
            "context" => v(Vk::Int),
            "ignoresubmodules" => v(Vk::Enum(&["none", "untracked", "dirty", "all"])),
            "mnemonicprefix" | "noprefix" => v(Vk::Bool),
            _ => J::Review,
        },
        ("commit", true) if var == "gpgsign" => v(Vk::Bool),
        ("tag", true) => match var {
            "gpgsign" => v(Vk::Bool),
            "sort" => v(Vk::Word),
            _ => J::Review,
        },
        ("color", true) => match var {
            "ui" => v(Vk::BoolOr(&["auto", "always", "never"])),
            "diff" | "status" | "branch" | "interactive" => v(Vk::BoolOr(&["auto", "always", "never"])),
            "pager" => v(Vk::Bool),
            _ => J::Review,
        },
        ("status", true) => match var {
            "showuntrackedfiles" => v(Vk::Enum(&["no", "normal", "all"])),
            "branch" | "short" | "submodulesummary" | "aheadbehind" => v(Vk::Bool),
            _ => J::Review,
        },
        ("log", true) => match var {
            "date" => J::Safe,
            "abbrevcommit" | "mailmap" | "follow" => v(Vk::Bool),
            "decorate" => v(Vk::BoolOr(&["short", "full", "auto", "no"])),
            _ => J::Review,
        },
        // `gc.recentObjectsHook`(auto gc가 실행)·`gc.bigPackThreshold` 등은 목록에 없다. 앱은 `gc.auto=0`·`maintenance.auto=false`도 덮어쓴다
        ("gc", true) => match var {
            "auto" => v(Vk::Int),
            "autodetach" | "writecommitgraph" => v(Vk::Bool),
            "pruneexpire" | "reflogexpire" => if !value.is_empty() && value.len() <= 40 && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | ' ' | '_')) { J::Safe } else { J::Review },
            _ => J::Review,
        },
        ("maintenance", true) if var == "auto" => v(Vk::Bool),
        ("i18n", true) => match var {
            "commitencoding" | "logoutputencoding" => v(Vk::Word),
            _ => J::Review,
        },
        ("advice", true) => v(Vk::Bool),
        ("alias", true) => if value.starts_with('!') { J::Review } else { J::Safe },
        ("fetch", true) => match var {
            "prune" | "prunetags" | "fsckobjects" | "writecommitgraph" => v(Vk::Bool),
            "parallel" => v(Vk::Int),
            "recursesubmodules" => v(Vk::BoolOr(&["on-demand"])),
            _ => J::Review,
        },
        ("transfer", true) if var == "fsckobjects" => v(Vk::Bool),
        ("credential", true) => match var {
            "usehttppath" => v(Vk::Bool),
            "helper" => if value.trim().is_empty() { J::Safe } else { J::Review },
            _ => J::Review,
        },
        ("credential", false) => match var {
            "usehttppath" => v(Vk::Bool),
            "username" => J::Safe,
            "helper" => if value.trim().is_empty() { J::Safe } else { J::Review },
            _ => J::Review,
        },
        ("url", false) if matches!(var, "insteadof" | "pushinsteadof") => J::Safe,
        // include·includeIf는 대상 파일 내용을 따로 판정하지만(조건과 무관하게 `check`가 읽는다) 키 자체도 확인 대상이다
        _ => J::Review,
    }
}

/// 순수 판정: `(출처, 키, 값)` 항목들 → `Verdict`(지문 제외). 키는 소문자여야 한다.
pub fn judge(entries: &[(Source, String, String)], repo: &Path) -> Verdict {
    let (mut refuse, mut review) = (Vec::<String>::new(), Vec::<String>::new());
    for (src, key, value) in entries {
        match judge_entry(key, value, src, repo) {
            J::Safe => {}
            J::Review => review.push(key.clone()),
            J::Refuse(why) => refuse.push(why),
        }
    }
    refuse.sort();
    refuse.dedup();
    review.sort();
    review.dedup();
    Verdict { refuse, review, ..Default::default() }
}

/// `git config --list [--show-scope] -z` 출력 파싱. `scoped`면 `범위\0키\n값\0` 쌍, 아니면 `키\n값\0`. 범위가 있으면 local·worktree만 남긴다.
pub fn parse_listing(text: &str, scoped: bool) -> Vec<(String, String)> {
    let toks: Vec<&str> = text.split('\0').collect();
    let kv = |s: &str| {
        let (k, v) = s.split_once('\n').unwrap_or((s, ""));
        (k.to_ascii_lowercase(), v.to_owned())
    };
    if scoped {
        toks.chunks(2).filter_map(|p| match p {
            [scope, s] if *scope == "local" || *scope == "worktree" => Some(kv(s)),
            _ => None,
        }).collect()
    } else {
        toks.iter().filter(|s| !s.is_empty()).map(|s| kv(s)).collect()
    }
}

fn run(git: &str, cwd: &Path, args: &[&str]) -> Option<String> {
    // 신뢰하지 않는 설정을 읽는 일이라 fsmonitor·훅 등이 프로그램을 실행하지 못하는 git 명령(`ai_tool::git_command`)으로 돌린다
    // (`-c`는 command 범위라 `--show-scope`에서 걸러져 판정·지문에 안 들어간다)
    let o = crate::ai_tool::git_command(git, Some(cwd)).args(args).stdout(Stdio::piped()).stderr(Stdio::null()).output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).into_owned())
}

/// FNV-1a 64비트
fn fnv(text: &str) -> String {
    format!("{:016x}", text.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)))
}

/// `include.path`·`includeIf.<조건>.path` 항목이 가리키는 파일들(조건과 무관하게: 지금 안 맞는 includeIf도 조건이 바뀌면 켜진다)
fn include_targets(entries: &[(String, String)], base: &Path) -> Vec<PathBuf> {
    entries.iter().filter(|(k, _)| k == "include.path" || (k.starts_with("includeif.") && k.ends_with(".path"))).filter_map(|(_, v)| {
        let p = if v.starts_with('~') {
            expand_tilde(v)?
        } else if Path::new(v).is_absolute() {
            PathBuf::from(v)
        } else {
            base.join(v)
        };
        Some(p)
    }).collect()
}

/// git이 경로 설정에서 풀어 주는 `~`·`~/x`·`~user/x`(홈 폴더). 풀 수 없으면 None
fn expand_tilde(v: &str) -> Option<PathBuf> {
    let rest = v.strip_prefix('~')?;
    let (user, tail) = rest.split_once('/').map_or((rest, ""), |(u, t)| (u, t));
    let home = if user.is_empty() { PathBuf::from(std::env::var_os("HOME")?) } else { user_home(user)? };
    Some(if tail.is_empty() { home } else { home.join(tail) })
}

#[cfg(unix)]
fn user_home(user: &str) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(user).ok()?;
    // SAFETY: getpwnam은 스레드 안전하지 않지만 반환 값을 바로 복사하고, 이 함수는 판정 스레드에서만 부른다
    let pw = unsafe { libc::getpwnam(name.as_ptr()) };
    if pw.is_null() {
        return None;
    }
    let dir = unsafe { std::ffi::CStr::from_ptr((*pw).pw_dir) };
    Some(PathBuf::from(std::ffi::OsStr::from_bytes(dir.to_bytes())))
}
#[cfg(not(unix))]
fn user_home(_: &str) -> Option<PathBuf> {
    None
}

/// 경로를 어휘적으로 정규화해(`.`·`..` 처리) 저장소(`root`) 안이면 저장소 상대 경로(`/` 구분)로. 밖이면 None
fn rel_in_repo(p: &Path, root: &Path) -> Option<String> {
    let mut norm = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                norm.pop();
            }
            std::path::Component::CurDir => {}
            c => norm.push(c.as_os_str()),
        }
    }
    let rel = norm.strip_prefix(root).ok().or_else(|| norm.strip_prefix(canon(root)).ok())?;
    let parts: Vec<String> = rel.components().filter_map(|c| matches!(c, std::path::Component::Normal(_)).then(|| c.as_os_str().to_string_lossy().into_owned())).collect();
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// 설정 항목 중 `core.hookspath`가 가리키는 폴더를 저장소 상대 경로로(저장소 밖은 쓸 수 없는 곳이라 뺀다). 풀이 규칙:
/// `~`·`~user`는 홈으로 전개, 절대 경로는 그대로, 상대 경로는 훅을 돌리는 **작업 트리 기준** — 서브모듈 설정(`.git/modules/<이름>/config`·`<서브모듈>/.git/config`)에서 온 값은
/// 그 서브모듈의 작업 트리(`core.worktree`, 없으면 알 수 없으므로 저장소 루트 기준도 함께) 기준이다.
fn hooks_dirs(entries: &[(Source, String, String)], root: &Path, dotgit: &Path, common: &Path) -> Vec<String> {
    let modules = common.join("modules");
    let mut out: Vec<String> = Vec::new();
    for (src, k, v) in entries.iter().filter(|(_, k, v)| k == "core.hookspath" && !v.is_empty()) {
        let _ = k;
        let mut bases: Vec<PathBuf> = vec![root.to_path_buf()];
        if let Source::Other(dir) = src {
            let is_sub = dir.starts_with(&modules) || (dir.file_name().is_some_and(|n| n == ".git") && dir != dotgit);
            if is_sub {
                bases.clear();
                let wt = entries.iter().find(|(s, k, _)| matches!(s, Source::Other(d) if d == dir) && k == "core.worktree").map(|(_, _, w)| w.clone());
                match wt {
                    Some(w) => bases.push(if Path::new(&w).is_absolute() { PathBuf::from(w) } else { dir.join(w) }),
                    None if dir.file_name().is_some_and(|n| n == ".git") => bases.extend(dir.parent().map(Path::to_path_buf)),
                    None => bases.push(root.to_path_buf()), // 흡수된 서브모듈인데 작업 트리를 모르면 저장소 루트 기준으로 넓게 보호
                }
            }
        }
        let expanded = if v.starts_with('~') { expand_tilde(v) } else { None };
        let candidates: Vec<PathBuf> = match (&expanded, Path::new(v).is_absolute()) {
            (Some(p), _) => vec![p.clone()],
            (None, true) => vec![PathBuf::from(v)],
            (None, false) if v.starts_with('~') => vec![],
            (None, false) => bases.iter().map(|b| b.join(v)).collect(),
        };
        out.extend(candidates.iter().filter_map(|c| rel_in_repo(c, root)));
    }
    out.sort();
    out.dedup();
    out
}

/// 저장소의 git 설정을 모아 판정한다. `git`은 실행 파일. git을 못 돌리거나 저장소가 아니면 `refuse`.
/// 구조 검사: `.git`은 저장소 안의 실제 디렉터리여야 하고(gitfile·심볼릭 링크·`commondir` 리다이렉트로 밖의 저장소를 쓰지 못하게 — 연결된 worktree·서브모듈 작업 폴더에서
/// 직접 여는 것도 이 때문에 AI 차례에서는 안 된다), 그 최상위에 심볼릭 링크가 없고 `objects/info/alternates`가 없어야 한다. 원격 URL은 `insteadOf` 적용 뒤의 값으로 보고,
/// 같은 컴퓨터의 경로·`file://`이면 거절한다. 설정 파일은 상위·서브모듈(`modules/**`)·worktree·**흡수되지 않은 서브모듈**(작업 트리 gitlink의 `.git` 디렉터리)·include 대상 전부.
pub fn check(repo: &Path, git: &str) -> Verdict {
    let root = canon(repo);
    let Some(top) = run(git, repo, &["rev-parse", "--show-toplevel"]) else {
        return Verdict { refuse: vec!["not a usable git repository".into()], ..Default::default() };
    };
    let mut refuse = Vec::new();
    if canon(Path::new(top.trim())) != root {
        refuse.push(format!("the git working tree is {} instead of the repository folder (core.worktree or a crafted .git file)", top.trim()));
    }
    let gitdir = run(git, repo, &["rev-parse", "--absolute-git-dir"]).map(|s| PathBuf::from(s.trim())).unwrap_or_default();
    let common = run(git, repo, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).map(|s| PathBuf::from(s.trim())).unwrap_or_else(|| gitdir.clone());
    // 구조: <repo>/.git이 실제 디렉터리이고 git 폴더·공통 폴더가 그 아래여야 한다
    let dotgit = root.join(".git");
    match dotgit.symlink_metadata() {
        Ok(m) if m.is_dir() => {
            let dg = canon(&dotgit);
            if !canon(&gitdir).starts_with(&dg) || !canon(&common).starts_with(&dg) {
                refuse.push(format!("the git directory ({}) is outside <repo>/.git (commondir/gitdir redirect)", gitdir.display()));
            }
            if let Ok(rd) = std::fs::read_dir(&dotgit) {
                for e in rd.flatten() {
                    if e.file_type().is_ok_and(|t| t.is_symlink()) {
                        refuse.push(format!(".git/{} is a symbolic link", e.file_name().to_string_lossy()));
                    }
                }
            }
            for d in [dotgit.clone(), common.clone()] {
                if d.join("objects/info/alternates").exists() {
                    refuse.push("objects/info/alternates exists: objects would be read from (or written next to) another repository".into());
                }
                if d.join("commondir").exists() && d != dotgit {
                    refuse.push("commondir redirect".into());
                }
            }
            if dotgit.join("commondir").exists() {
                refuse.push(".git/commondir exists: the repository shares another repository's refs and objects".into());
            }
        }
        _ => refuse.push("<repo>/.git is not a plain directory (gitfile or symbolic link: linked worktree, submodule folder or a redirect to another repository)".into()),
    }
    let mut entries: Vec<(Source, String, String)> = parse_listing(&run(git, repo, &["config", "--list", "--includes", "--show-scope", "-z"]).unwrap_or_default(), true).into_iter().map(|(k, v)| (Source::Top, k, v)).collect();
    // 설정 파일들: 서브모듈(modules/**/config)·다른 worktree(worktrees/*/config.worktree)
    let mut files: Vec<PathBuf> = Vec::new();
    fn walk(dir: &Path, depth: usize, files: &mut Vec<PathBuf>) {
        if depth > 8 || files.len() > 300 {
            return;
        }
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                walk(&p, depth + 1, files);
            } else if ft.is_file() && p.file_name().is_some_and(|n| n == "config") {
                files.push(p);
            }
        }
    }
    walk(&common.join("modules"), 0, &mut files);
    if let Ok(rd) = std::fs::read_dir(common.join("worktrees")) {
        for e in rd.flatten() {
            let p = e.path().join("config.worktree");
            if p.is_file() {
                files.push(p);
            }
        }
    }
    // 흡수되지 않은 서브모듈: 인덱스의 gitlink(모드 160000) 경로의 `.git`
    for rec in run(git, repo, &["ls-files", "--stage", "-z"]).unwrap_or_default().split('\0') {
        let Some((meta, path)) = rec.split_once('\t') else { continue };
        if !meta.starts_with("160000") {
            continue;
        }
        let sub = root.join(path).join(".git");
        match sub.symlink_metadata() {
            Ok(m) if m.is_dir() => files.push(sub.join("config")),
            Ok(m) if m.is_file() => {
                // gitfile: `gitdir: <경로>`는 이 저장소의 .git/modules 아래여야 한다
                let t = std::fs::read_to_string(&sub).unwrap_or_default();
                let target = t.trim().strip_prefix("gitdir:").map(|x| x.trim().to_string()).unwrap_or_default();
                let abs = canon(&root.join(path).join(&target));
                if !abs.starts_with(canon(&dotgit.join("modules"))) {
                    refuse.push(format!("submodule {path} has a .git file pointing outside <repo>/.git/modules"));
                }
            }
            Ok(_) => refuse.push(format!("submodule {path}/.git is a symbolic link")),
            Err(_) => {}
        }
    }
    // 저장소가 담은 `.lfsconfig`(git-lfs가 읽는 `lfs.url` 등): 설정 파일과 같은 규칙으로 판정하고 지문에도 넣는다(심볼릭 링크면 거절)
    match root.join(".lfsconfig").symlink_metadata() {
        Ok(m) if m.file_type().is_symlink() => refuse.push(".lfsconfig is a symbolic link".into()),
        Ok(m) if m.is_file() => files.push(root.join(".lfsconfig")),
        _ => {}
    }
    // include 대상(조건과 무관하게)을 따라가며 파일을 더한다(깊이 5)
    let base = if gitdir.as_os_str().is_empty() { repo.join(".git") } else { gitdir.clone() };
    let mut pending: Vec<(PathBuf, usize)> = include_targets(&entries.iter().map(|(_, k, v)| (k.clone(), v.clone())).collect::<Vec<_>>(), &base).into_iter().map(|p| (p, 1)).collect();
    let mut seen: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    let mut config_files: Vec<String> = Vec::new();
    let mut idx = 0;
    while idx < pending.len() && idx < 200 {
        let (p, depth) = pending[idx].clone();
        idx += 1;
        // 저장소 안의 include 대상은(아직 없는 파일도) AI가 쓰지 못하게 모은다
        config_files.extend(rel_in_repo(&p, &root));
        if !p.is_file() || !seen.insert(canon(&p)) {
            continue;
        }
        files.push(p.clone());
        if depth < 5 {
            let listing = run(git, repo, &["config", "--file", &p.to_string_lossy(), "--list", "-z"]).unwrap_or_default();
            let inner = parse_listing(&listing, false);
            let dir = p.parent().map(Path::to_path_buf).unwrap_or_default();
            pending.extend(include_targets(&inner, &dir).into_iter().map(|q| (q, depth + 1)));
        }
    }
    files.sort();
    files.dedup();
    for f in &files {
        let dir = f.parent().map(Path::to_path_buf).unwrap_or_default();
        let listing = run(git, repo, &["config", "--file", &f.to_string_lossy(), "--list", "--includes", "-z"]).unwrap_or_default();
        entries.extend(parse_listing(&listing, false).into_iter().map(|(k, v)| (Source::Other(dir.clone()), k, v)));
    }
    let mut v = judge(&entries, repo);
    // 원격 URL(`insteadOf` 적용 뒤): 같은 컴퓨터의 경로·file://이면 거절
    for n in run(git, repo, &["remote"]).unwrap_or_default().lines().map(str::trim).filter(|l| !l.is_empty()) {
        for push in [false, true] {
            let mut a = vec!["remote", "get-url", "--all"];
            if push {
                a.push("--push");
            }
            a.push(n);
            for u in run(git, repo, &a).unwrap_or_default().lines().map(str::trim) {
                if is_local_url(u) {
                    v.refuse.push(format!("remote {n} points to a local path or file:// URL ({u}): the target repository's own configuration could run programs"));
                }
            }
        }
    }
    v.refuse.extend(refuse);
    v.refuse.sort();
    v.refuse.dedup();
    let mut raw: Vec<String> = entries.iter().map(|(s, k, val)| format!("{}|{k}={val}", match s { Source::Top => "top".to_string(), Source::Other(d) => d.to_string_lossy().into_owned() })).collect();
    raw.sort();
    config_files.sort();
    config_files.dedup();
    v.hooks_dirs = hooks_dirs(&entries, &root, &dotgit, &common);
    v.config_files = config_files;
    v.fingerprint = fnv(&format!("{}\n{}\n{}\n{}", top.trim(), gitdir.display(), common.display(), raw.join("\n")));
    v
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Command;

    fn e(rows: &[(&str, &str)]) -> Vec<(Source, String, String)> {
        rows.iter().map(|(k, v)| (Source::Top, k.to_string(), v.to_string())).collect()
    }
    fn sh(dir: &Path, a: &[&str]) -> String {
        let o = Command::new("git").current_dir(dir).args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always"]).args(a).output().unwrap();
        assert!(o.status.success(), "git {a:?}: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).trim().to_owned()
    }
    fn repo() -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().canonicalize().unwrap();
        sh(&p, &["init", "-q", "-b", "main"]);
        std::fs::write(p.join("a.txt"), "1\n").unwrap();
        sh(&p, &["add", "."]);
        sh(&p, &["commit", "-qm", "a"]);
        (d, p)
    }

    #[test]
    fn plain_config_is_clean_and_unknown_keys_need_review() {
        let (_d, r) = repo();
        let v = check(&r, "git");
        assert!(v.refuse.is_empty() && v.review.is_empty() && v.fingerprint.len() == 16, "{v:?}");
        sh(&r, &["remote", "add", "origin", "https://github.com/o/r.git"]);
        sh(&r, &["config", "branch.main.remote", "origin"]);
        sh(&r, &["config", "branch.main.merge", "refs/heads/main"]);
        sh(&r, &["config", "pull.rebase", "true"]);
        assert!(check(&r, "git").review.is_empty(), "{:?}", check(&r, "git"));
        let before = check(&r, "git").fingerprint;
        sh(&r, &["config", "diff.evil.textconv", "sh -c id"]);
        sh(&r, &["config", "core.sshCommand", "ssh -v"]);
        sh(&r, &["config", "custom.thing", "x"]);
        let v = check(&r, "git");
        assert_eq!((v.review, v.refuse.is_empty()), (vec!["core.sshcommand".to_string(), "custom.thing".into(), "diff.evil.textconv".into()], true));
        assert_ne!(v.fingerprint, before, "설정이 바뀌면 지문이 바뀐다");
    }

    #[test]
    fn dangerous_repo_settings_are_refused_not_confirmable() {
        let (_d, r) = repo();
        let outside = tempfile::tempdir().unwrap();
        // core.worktree가 저장소 밖 / bare / mirror / 비기본 fetch·push / 백업 이름공간
        sh(&r, &["config", "core.worktree", &outside.path().to_string_lossy()]);
        let v = check(&r, "git");
        assert!(v.refuse.iter().any(|x| x.contains("core.worktree") || x.contains("working tree")), "{v:?}");
        sh(&r, &["config", "--unset", "core.worktree"]);
        assert!(check(&r, "git").refuse.is_empty());
        sh(&r, &["remote", "add", "origin", "https://x/y.git"]);
        for (k, val) in [("remote.origin.mirror", "true"), ("remote.origin.push", "refs/heads/*:refs/heads/*"), ("remote.origin.fetch", "+refs/heads/main:refs/git403/ai-backup/1"), ("core.bare", "true")] {
            let old = Command::new("git").current_dir(&r).args(["config", "--get-all", k]).output().unwrap();
            sh(&r, &["config", "--add", k, val]);
            let v = check(&r, "git");
            assert!(!v.refuse.is_empty(), "{k}={val}: {v:?}");
            if k == "remote.origin.fetch" || k == "core.bare" {
                sh(&r, &["config", "--unset-all", k, &regex_escape(val)]);
            } else {
                sh(&r, &["config", "--unset", k]);
            }
            let _ = old;
            assert!(check(&r, "git").refuse.is_empty(), "{k} 되돌린 뒤: {:?}", check(&r, "git"));
        }
        // 값이 false인 mirror·빈 push는 안전
        sh(&r, &["config", "remote.origin.mirror", "false"]);
        assert!(check(&r, "git").refuse.is_empty());
    }

    fn regex_escape(s: &str) -> String {
        s.chars().flat_map(|c| if "+*.?[]()|^$\\".contains(c) { vec!['\\', c] } else { vec![c] }).collect()
    }

    #[test]
    fn core_worktree_pointing_elsewhere_and_crafted_gitfile_are_refused() {
        let (_d, r) = repo();
        let other = tempfile::tempdir().unwrap();
        let o = other.path().canonicalize().unwrap();
        // 저장소와 같은 worktree를 가리키는 core.worktree는 안전
        sh(&r, &["config", "core.worktree", &r.to_string_lossy()]);
        assert!(check(&r, "git").refuse.is_empty());
        sh(&r, &["config", "core.worktree", &o.to_string_lossy()]);
        assert!(!check(&r, "git").refuse.is_empty());
        // 꾸며 낸 .git 파일: 다른 저장소의 git 폴더를 가리킨다
        let (_d2, victim) = repo();
        let crafted = tempfile::tempdir().unwrap();
        let c = crafted.path().canonicalize().unwrap();
        std::fs::write(c.join(".git"), format!("gitdir: {}/.git\n", victim.display())).unwrap();
        sh(&victim, &["config", "core.worktree", &o.to_string_lossy()]);
        assert!(!check(&c, "git").refuse.is_empty(), "{:?}", check(&c, "git"));
        let _ = crafted;
    }

    /// 서브모듈 설정(modules/*/config)의 filter가 상위 설정 판정에서 빠지던 길
    #[test]
    fn submodule_config_is_judged_too() {
        let (_d, sub) = repo();
        let (_d2, r) = repo();
        sh(&r, &["submodule", "add", "-q", &sub.to_string_lossy(), "sm"]);
        sh(&r, &["commit", "-qm", "sm"]);
        // 서브모듈 원격이 같은 컴퓨터의 경로면 AI 차례에서는 거절(대상 저장소 설정이 실행될 수 있다)
        assert!(check(&r, "git").refuse.iter().any(|x| x.contains("local path")), "{:?}", check(&r, "git"));
        sh(&r, &["config", "--file", ".git/modules/sm/config", "remote.origin.url", "https://example.com/sm.git"]);
        let v = check(&r, "git");
        assert!(v.refuse.is_empty() && v.review.is_empty(), "정상 서브모듈은 깨끗함: {v:?}");
        let before = v.fingerprint;
        let modcfg = r.join(".git/modules/sm/config");
        assert!(modcfg.exists());
        let mut t = std::fs::read_to_string(&modcfg).unwrap();
        t.push_str("[filter \"evil\"]\n\tclean = sh -c id\n");
        std::fs::write(&modcfg, t).unwrap();
        let v = check(&r, "git");
        assert_eq!(v.review, vec!["filter.evil.clean".to_string()], "{v:?}");
        assert_ne!(v.fingerprint, before);
        // 서브모듈 core.worktree가 저장소 밖이면 거절
        let outside = tempfile::tempdir().unwrap();
        let mut t = std::fs::read_to_string(&modcfg).unwrap();
        t.push_str(&format!("[core]\n\tworktree = {}\n", outside.path().display()));
        std::fs::write(&modcfg, t).unwrap();
        assert!(!check(&r, "git").refuse.is_empty());
    }

    #[test]
    fn judge_covers_the_allow_list_by_key() {
        let (_d, r) = repo();
        let clean = e(&[("core.repositoryformatversion", "0"), ("core.filemode", "true"), ("core.bare", "false"), ("core.logallrefupdates", "true"), ("core.ignorecase", "true"), ("core.precomposeunicode", "true"), ("core.autocrlf", "input"), ("remote.origin.url", "https://x/y"), ("remote.origin.pushurl", "https://x/y"), ("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"), ("remote.origin.mirror", "false"), ("remote.origin.push", ""), ("branch.main.remote", "origin"), ("branch.main.merge", "refs/heads/main"), ("branch.feat/x.rebase", "true"), ("user.name", "t"), ("user.email", "t@t"), ("filter.lfs.clean", "git-lfs clean -- %f"), ("filter.lfs.smudge", "git-lfs smudge -- %f"), ("filter.lfs.process", "git-lfs filter-process"), ("filter.lfs.required", "true"), ("lfs.url", "https://l"), ("submodule.sm.url", "../sm"), ("submodule.sm.active", "true"), ("pull.rebase", "true"), ("push.default", "simple"), ("merge.ff", "only"), ("diff.renames", "true"), ("commit.gpgsign", "false"), ("credential.helper", ""), ("url.https://github.com/.insteadof", "gh:"), ("extensions.worktreeconfig", "true"), ("alias.st", "status"), ("init.defaultbranch", "main"), ("color.ui", "auto")]);
        let v = judge(&clean, &r);
        assert!(v.refuse.is_empty() && v.review.is_empty(), "{v:?}");
        let review = e(&[("filter.lfs.clean", "sh -c id"), ("filter.x.smudge", "x"), ("core.sshcommand", "x"), ("core.editor", "vim"), ("diff.external", "x"), ("diff.d.textconv", "x"), ("merge.d.driver", "x"), ("credential.helper", "!x"), ("credential.https://h.helper", "!x"), ("gpg.program", "x"), ("gpg.ssh.program", "x"), ("remote.o.uploadpack", "x"), ("remote.o.vcs", "x"), ("remote.o.tagopt", "--evil"), ("sequence.editor", "x"), ("trailer.t.command", "x"), ("blame.ignorerevsfile", "/etc/passwd"), ("submodule.sm.update", "!x"), ("lfs.customtransfer.x.path", "x"), ("core.excludesfile", "/x"), ("http.proxy", "x"), ("custom.unknown", "1"), ("pager.log", "x"), ("alias.x", "x"), ("pull.editor", "x"), ("include.path", "x.cfg"), ("includeif.gitdir:/x/.path", "y.cfg")]);
        let v = judge(&review, &r);
        // alias.x는 무해(안전), 나머지는 전부 review
        assert!(v.refuse.is_empty(), "{v:?}");
        for k in ["filter.lfs.clean", "filter.x.smudge", "core.sshcommand", "core.editor", "diff.external", "diff.d.textconv", "merge.d.driver", "credential.helper", "credential.https://h.helper", "gpg.program", "gpg.ssh.program", "remote.o.uploadpack", "remote.o.vcs", "remote.o.tagopt", "sequence.editor", "trailer.t.command", "blame.ignorerevsfile", "submodule.sm.update", "lfs.customtransfer.x.path", "core.excludesfile", "http.proxy", "custom.unknown", "pager.log", "pull.editor", "include.path", "includeif.gitdir:/x/.path"] {
            assert!(v.review.contains(&k.to_string()), "{k}: {v:?}");
        }
        assert!(!v.review.contains(&"alias.x".to_string()));
        // 리뷰도 거절도 키·값 어디서든 백업 이름공간을 언급하면 거절
        assert!(!judge(&e(&[("alias.x", "!git update-ref refs/git403/ai-backup/1 x")]), &r).refuse.is_empty());
    }

    #[test]
    fn parse_listing_handles_scopes_and_values_with_equals() {
        let t = "global\0user.name\nx\0local\0Remote.Origin.URL\nhttps://a?b=c\0worktree\0core.x\n\0command\0core.y\nz\0";
        assert_eq!(parse_listing(t, true), vec![("remote.origin.url".to_string(), "https://a?b=c".to_string()), ("core.x".to_string(), String::new())]);
        assert_eq!(parse_listing("a.b\nc\0d.e\n\0", false), vec![("a.b".to_string(), "c".to_string()), ("d.e".to_string(), String::new())]);
        assert!(parse_listing("", true).is_empty() && parse_listing("garbage", true).is_empty());
    }

    #[test]
    fn executable_subkeys_inside_known_groups_are_not_safe_and_values_are_format_checked() {
        let (_d, r) = repo();
        // 묶음 단위 허용은 없다: gc.recentObjectsHook(auto gc가 실행)·log.showSignature(gpg 실행)·color 슬롯 등은 목록에 없다
        let v = judge(&e(&[("gc.recentobjectshook", "sh -c id"), ("gc.bigpackthreshold", "1"), ("log.showsignature", "true"), ("status.relativepaths", "x"), ("color.diff.old", "red"), ("core.pager", "sh"), ("core.editor", "x"), ("push.pushoption", "x"), ("pull.twohead", "x"), ("diff.external", "x"), ("merge.tool", "x"), ("rebase.instructionformat", "x"), ("tag.forcesignannotated", "true"), ("fetch.negotiationalgorithm", "x")]), &r);
        assert_eq!(v.review.len(), 14, "{v:?}");
        // 안전한 하위 키라도 값 형식이 틀리면 review(셸 조각이 숨지 못한다)
        let v = judge(&e(&[("gc.auto", "$(id)"), ("core.filemode", "sh -c id"), ("core.eol", "x"), ("branch.main.remote", "../evil"), ("branch.main.merge", "a b"), ("push.default", "all"), ("core.hookspath", "../../x"), ("core.hookspath", "/etc/hooks"), ("diff.context", "x"), ("remote.o.tagopt", "--evil")]), &r);
        assert_eq!(v.review.len(), 9, "{v:?}"); // core.hookspath는 두 값이 같은 키라 하나로 센다
        let ok = judge(&e(&[("gc.auto", "0"), ("gc.autodetach", "false"), ("maintenance.auto", "false"), ("branch.main.remote", "origin"), ("diff.context", "5"), ("core.autocrlf", "input"), ("advice.detachedhead", "false"), ("alias.st", "status -sb")]), &r);
        assert!(ok.review.is_empty() && ok.refuse.is_empty(), "{ok:?}");
        assert_eq!(judge(&e(&[("alias.x", "!sh -c id")]), &r).review, vec!["alias.x".to_string()]);
        // 훅 폴더(상대 경로여도)는 검토 대상 — 사용자의 다음 commit이 실행한다. 빈 값(훅 끔)은 안전
        assert_eq!(judge(&e(&[("core.hookspath", "scripts/hooks")]), &r).review, vec!["core.hookspath".to_string()]);
        assert!(judge(&e(&[("core.hookspath", "")]), &r).review.is_empty());
    }

    /// 7→8차: 설정이 가리키는 훅 폴더는 저장소 상대 경로로 `hooks_dirs`에 모인다(include·상대·절대·`./`·`..` 정규화, 저장소 밖은 제외)
    #[test]
    fn hooks_dirs_come_from_every_config_source() {
        let (_d, r) = repo();
        sh(&r, &["config", "core.hooksPath", "./scripts/hooks/"]);
        std::fs::write(r.join(".git/inc.cfg"), format!("[core]\n\thooksPath = {}/abs/h\n", r.display())).unwrap();
        sh(&r, &["config", "include.path", "inc.cfg"]);
        sh(&r, &["config", "extensions.worktreeConfig", "true"]);
        sh(&r, &["config", "--worktree", "core.hooksPath", "a/../wt/hooks"]);
        let v = check(&r, "git");
        assert!(v.review.contains(&"core.hookspath".to_string()), "{v:?}");
        assert_eq!(v.hooks_dirs, vec!["abs/h".to_string(), "scripts/hooks".to_string(), "wt/hooks".to_string()], "{v:?}");
        sh(&r, &["config", "--unset-all", "core.hooksPath"]);
    }

    /// 6차 리뷰: 지금 조건이 안 맞는 includeIf 대상 파일의 내용도 판정한다
    #[test]
    fn include_and_inactive_includeif_targets_are_judged() {
        let (_d, r) = repo();
        std::fs::write(r.join(".git/extra.cfg"), "[core]\n\tsshCommand = ssh -v\n[include]\n\tpath = nested.cfg\n").unwrap();
        std::fs::write(r.join(".git/nested.cfg"), "[filter \"evil\"]\n\tclean = sh -c id\n[remote \"origin\"]\n\turl = ./evil.git\n").unwrap();
        sh(&r, &["config", "includeIf.gitdir:/nonexistent/.path", "extra.cfg"]); // 조건이 안 맞아 git은 읽지 않는다
        let v = check(&r, "git");
        assert!(v.review.contains(&"core.sshcommand".to_string()) && v.review.contains(&"filter.evil.clean".to_string()) && v.review.contains(&"includeif.gitdir:/nonexistent/.path".to_string()), "{v:?}");
        assert!(v.refuse.iter().any(|x| x.contains("local path")), "중첩 include의 로컬 경로 원격: {v:?}");
    }

    #[test]
    fn local_path_and_file_remotes_are_refused_including_through_insteadof() {
        let (_d, r) = repo();
        for url in ["./evil.git", "../evil.git", "/srv/evil.git", "file:///srv/evil.git", "~/evil.git"] {
            sh(&r, &["remote", "add", "o", url]);
            let v = check(&r, "git");
            assert!(v.refuse.iter().any(|x| x.contains("local path")), "{url}: {v:?}");
            sh(&r, &["remote", "remove", "o"]);
        }
        sh(&r, &["remote", "add", "o", "https://example.com/x.git"]);
        assert!(check(&r, "git").refuse.is_empty());
        sh(&r, &["remote", "set-url", "--push", "o", "/srv/evil.git"]);
        assert!(!check(&r, "git").refuse.is_empty(), "pushurl");
        sh(&r, &["config", "--unset", "remote.o.pushurl"]);
        sh(&r, &["config", "url./srv/evil/.insteadOf", "https://example.com/"]);
        assert!(!check(&r, "git").refuse.is_empty(), "insteadOf로 로컬 경로가 되는 URL");
    }

    /// 6차 리뷰 높음3: `.git/commondir`·gitfile·alternates·.git 안 심볼릭 링크로 다른 저장소의 ref·객체를 읽거나 쓰던 길
    #[test]
    fn git_directory_redirects_are_refused() {
        let (_d, r) = repo();
        let (_d2, victim) = repo();
        assert!(check(&r, "git").refuse.is_empty());
        // commondir (상대 경로 포함)
        std::fs::write(r.join(".git/commondir"), format!("{}\n", victim.join(".git").display())).unwrap();
        assert!(!check(&r, "git").refuse.is_empty(), "{:?}", check(&r, "git"));
        std::fs::remove_file(r.join(".git/commondir")).unwrap();
        std::fs::write(r.join(".git/commondir"), "../../../x/.git\n").unwrap();
        assert!(!check(&r, "git").refuse.is_empty());
        std::fs::remove_file(r.join(".git/commondir")).unwrap();
        // alternates
        std::fs::write(r.join(".git/objects/info/alternates"), format!("{}/.git/objects\n", victim.display())).unwrap();
        assert!(check(&r, "git").refuse.iter().any(|x| x.contains("alternates")));
        std::fs::remove_file(r.join(".git/objects/info/alternates")).unwrap();
        // .git 안 심볼릭 링크
        std::os::unix::fs::symlink(victim.join(".git/refs"), r.join(".git/refs_link")).unwrap();
        assert!(check(&r, "git").refuse.iter().any(|x| x.contains("symbolic link")));
        std::fs::remove_file(r.join(".git/refs_link")).unwrap();
        assert!(check(&r, "git").refuse.is_empty());
        // gitfile(연결된 worktree·꾸며 낸 .git 파일)과 .git 심볼릭 링크
        let wt = tempfile::tempdir().unwrap();
        let w = wt.path().canonicalize().unwrap().join("w");
        sh(&r, &["worktree", "add", "-q", &w.to_string_lossy(), "-b", "wt"]);
        assert!(!check(&w, "git").refuse.is_empty(), "연결된 worktree는 AI 차례 불가: {:?}", check(&w, "git"));
        let sl = tempfile::tempdir().unwrap();
        let s = sl.path().canonicalize().unwrap();
        std::os::unix::fs::symlink(victim.join(".git"), s.join(".git")).unwrap();
        assert!(!check(&s, "git").refuse.is_empty());
    }

    #[test]
    fn unabsorbed_submodule_config_is_judged() {
        let (_d, r) = repo();
        let (_d2, sub) = repo();
        // 흡수되지 않은 서브모듈: 작업 트리 안 폴더가 자기 .git 디렉터리를 가진 gitlink
        let dest = r.join("sm2");
        sh(&r, &["clone", "-q", &sub.to_string_lossy(), &dest.to_string_lossy()]);
        let sha = sh(&dest, &["rev-parse", "HEAD"]);
        sh(&r, &["update-index", "--add", "--cacheinfo", &format!("160000,{sha},sm2")]);
        sh(&dest, &["remote", "set-url", "origin", "https://example.com/sm2.git"]);
        assert!(check(&r, "git").review.is_empty() && check(&r, "git").refuse.is_empty(), "{:?}", check(&r, "git"));
        let mut t = std::fs::read_to_string(dest.join(".git/config")).unwrap();
        t.push_str("[filter \"evil\"]\n\tclean = sh -c id\n");
        std::fs::write(dest.join(".git/config"), t).unwrap();
        let v = check(&r, "git");
        assert_eq!(v.review, vec!["filter.evil.clean".to_string()], "{v:?}");
        // 로컬 경로 원격이 그대로면 거절
        sh(&dest, &["remote", "set-url", "origin", &sub.to_string_lossy()]);
        assert!(!check(&r, "git").refuse.is_empty());
    }

    /// 7차 리뷰: `.lfsconfig`의 `lfs.url`(로컬 경로 거절·http(s)만 안전, 목록 밖 `lfs.*`는 확인)
    #[test]
    fn lfsconfig_is_judged_like_a_config_file() {
        let (_d, r) = repo();
        let base = check(&r, "git");
        std::fs::write(r.join(".lfsconfig"), "[lfs]\n\turl = https://lfs.example.com/o/r.git/info/lfs\n").unwrap();
        let v = check(&r, "git");
        assert!(v.refuse.is_empty() && v.review.is_empty(), "{v:?}");
        assert_ne!(v.fingerprint, base.fingerprint, ".lfsconfig는 지문에 들어간다");
        std::fs::write(r.join(".lfsconfig"), "[lfs]\n\turl = /srv/evil-lfs\n").unwrap();
        assert!(check(&r, "git").refuse.iter().any(|x| x.contains("lfs.url")));
        std::fs::write(r.join(".lfsconfig"), "[lfs]\n\tstandalonetransferagent = evil\n[lfs \"customtransfer.evil\"]\n\tpath = /bin/sh\n").unwrap();
        let v = check(&r, "git");
        assert!(v.review.iter().any(|k| k.contains("standalonetransferagent")) && v.review.iter().any(|k| k.contains("customtransfer")), "{v:?}");
        std::fs::remove_file(r.join(".lfsconfig")).unwrap();
        std::os::unix::fs::symlink("/etc/hosts", r.join(".lfsconfig")).unwrap();
        assert!(check(&r, "git").refuse.iter().any(|x| x.contains(".lfsconfig")));
    }

    /// 8차: 판정(`check`)은 샌드박스 밖에서 git(`rev-parse`·`config`·`ls-files`·`remote`)을 돌린다 — 저장소 설정이 fsmonitor·훅·필터로 프로그램을 실행하면 안 된다
    #[test]
    fn checking_a_malicious_repository_runs_nothing() {
        let (_d, r) = repo();
        let mark = tempfile::tempdir().unwrap();
        let m = mark.path().canonicalize().unwrap();
        let fsm = m.join("fsm.sh");
        std::fs::write(&fsm, format!("#!/bin/sh\ntouch {}/fsmonitor\nprintf '\\0'\n", m.display())).unwrap();
        Command::new("chmod").args(["+x", &fsm.display().to_string()]).status().unwrap();
        sh(&r, &["config", "core.fsmonitor", &fsm.display().to_string()]);
        sh(&r, &["config", "core.hooksPath", ".hooks"]);
        sh(&r, &["config", "diff.evil.textconv", &format!("touch {}/textconv", m.display())]);
        sh(&r, &["config", "remote.origin.url", "https://example.invalid/x.git"]);
        let v = check(&r, "git");
        assert!(v.review.contains(&"core.fsmonitor".to_string()), "{v:?}");
        let ran: Vec<String> = std::fs::read_dir(&m).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n != "fsm.sh").collect();
        assert!(ran.is_empty(), "판정이 프로그램을 실행했다: {ran:?}");
    }

    /// 9차 M1: `~`·`~user` 전개, 서브모듈 출처의 상대 경로는 그 서브모듈 작업 트리 기준, include 출처는 저장소 루트 기준
    #[test]
    fn hooks_dirs_expand_home_and_resolve_submodule_relative_paths() {
        let (_d, r) = repo();
        let home = PathBuf::from(std::env::var_os("HOME").expect("HOME"));
        let fake = home.join("git403-fake-proj"); // 없는 폴더: 어휘적 정규화만 쓴다
        let (dotgit, common) = (fake.join(".git"), fake.join(".git"));
        let top = |k: &str, v: &str| (Source::Top, k.to_string(), v.to_string());
        let other = |d: &Path, k: &str, v: &str| (Source::Other(d.to_path_buf()), k.to_string(), v.to_string());
        let h = |e: &[(Source, String, String)]| hooks_dirs(e, &fake, &dotgit, &common);
        assert_eq!(h(&[top("core.hookspath", "~/git403-fake-proj/scripts/hooks")]), vec!["scripts/hooks".to_string()]);
        assert!(h(&[top("core.hookspath", "~/elsewhere/hooks")]).is_empty(), "저장소 밖 홈 경로는 쓸 수 없는 곳");
        if let Ok(u) = std::env::var("USER") {
            if user_home(&u).is_some_and(|d| d == home) {
                assert_eq!(h(&[top("core.hookspath", &format!("~{u}/git403-fake-proj/h2"))]), vec!["h2".to_string()]);
            }
        }
        // 서브모듈: 흡수된 설정(modules/<이름>, core.worktree)과 흡수되지 않은 `<서브모듈>/.git/config`
        let m = common.join("modules/sm");
        assert_eq!(h(&[other(&m, "core.worktree", "../../../libs/sm"), other(&m, "core.hookspath", "hk")]), vec!["libs/sm/hk".to_string()]);
        let plain = fake.join("libs/plain/.git");
        assert_eq!(h(&[other(&plain, "core.hookspath", "githooks")]), vec!["libs/plain/githooks".to_string()]);
        // 작업 트리를 모르는 흡수된 서브모듈은 저장소 루트 기준으로 넓게 보호
        assert_eq!(h(&[other(&m, "core.hookspath", "hk")]), vec!["hk".to_string()]);
        // include 파일(저장소 밖·안의 일반 파일)에서 온 상대 경로는 저장소 루트 기준
        assert_eq!(h(&[other(&fake.join("cfgs"), "core.hookspath", "inc/hooks")]), vec!["inc/hooks".to_string()]);
        let _ = r;
    }

    /// 9차 M2: include 대상 중 저장소 안의 설정 파일(없는 파일 포함)은 `config_files`로 모인다
    #[test]
    fn include_targets_inside_the_repository_are_collected_even_when_missing() {
        let (_d, r) = repo();
        sh(&r, &["config", "include.path", "../local.cfg"]);
        sh(&r, &["config", "--add", "include.path", "../sub/dir/other.cfg"]);
        sh(&r, &["config", "--add", "include.path", "/nonexistent-outside/x.cfg"]);
        let v = check(&r, "git");
        assert_eq!(v.config_files, vec!["local.cfg".to_string(), "sub/dir/other.cfg".to_string()], "{v:?}");
        assert!(v.protected_paths().contains(&"local.cfg".to_string()));
        // 재현: 나중에 그 파일에 fsmonitor를 심으면 지문이 달라진다
        let before = v.fingerprint.clone();
        std::fs::write(r.join("local.cfg"), "[core]\n\tfsmonitor = /bin/true\n").unwrap();
        assert_ne!(check(&r, "git").fingerprint, before);
    }
}
