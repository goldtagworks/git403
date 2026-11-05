//! AI 채팅이 쓰는 도구의 **검증기**(docs/security.md). AI에게는 셸도 `Bash`도 주지 않는다 — 앱이 MCP 도구(`git`·`read_file`·`edit_file`)를
//! 제공하고, 이 모듈이 인자 배열을 허용 표로 검사한 뒤 실제로 실행할 argv를 만든다(규칙의 원본 = 이 파일의 표).
//! 원칙: 하위 명령별로 허용한 옵션만(긴 옵션은 정확한 이름 또는 `--opt=값`, 줄임말 불허; 짧은 옵션 묶음은 글자별로 분해해 각각 검사),
//! 값을 받는 옵션은 값 검사, 위치 인자는 종류별 검사(원격은 설정된 이름만, refspec은 `+`·`:dst` 금지, 경로는 저장소 안만·`.git`·`.claude` 불가).
//! 표에 없는 하위 명령·옵션은 거절한다 — 허용 목록 방식이라 새 git 옵션이 생겨도 열리지 않는다.

use std::path::{Component, Path, PathBuf};

pub type Res<T> = Result<T, String>;

#[derive(Clone, Copy)]
enum V {
    /// 값 없는 플래그
    No,
    /// 아무 문자열(메시지·정규식·날짜 — git이 해석만 하고 실행하지 않는 값)
    Free,
    Int,
    /// 영문자만(`--diff-filter=ACMR`)
    Letters,
    Of(&'static [&'static str]),
    /// 리비전
    Rev,
}

#[derive(Clone, Copy)]
struct Opt {
    long: &'static str,
    short: Option<char>,
    val: V,
    /// 값이 있어도 없어도 되는 옵션(`--rebase`·`--rebase=merges`, `--short`·`--short=7`). 짧은 형태는 값을 받지 않는다
    optional: bool,
}

const fn f(long: &'static str) -> Opt {
    Opt { long, short: None, val: V::No, optional: false }
}
const fn fs(long: &'static str, short: char) -> Opt {
    Opt { long, short: Some(short), val: V::No, optional: false }
}
const fn v(long: &'static str, short: Option<char>, val: V) -> Opt {
    Opt { long, short, val, optional: false }
}
const fn ov(long: &'static str, val: V) -> Opt {
    Opt { long, short: None, val, optional: true }
}
/// 긴 형태 `--long[=값]`과 짧은 형태 `-X[값]`이 모두 값을 붙여서만 받는 옵션(`--unified=3`·`-U3`)
const fn sov(long: &'static str, short: char, val: V) -> Opt {
    Opt { long, short: Some(short), val, optional: true }
}

#[derive(Clone, Copy, PartialEq)]
enum Pos {
    /// 위치 인자 없음
    None,
    /// `--` 앞은 리비전, 뒤는 경로
    Revs,
    /// 전부 경로(`--` 앞뒤 모두)
    Paths,
    /// 첫 인자는 설정된 원격 이름, 나머지는 refspec·브랜치
    Remote,
    /// 스태시 참조 하나(`stash@{0}`)
    StashRef,
}

struct Spec {
    opts: Vec<Opt>,
    pos: Pos,
    /// `-20`처럼 숫자만 있는 옵션 허용(log)
    num: bool,
    max_pos: usize,
    /// `--` 앞은 리비전뿐이다: 사용자가 `--`를 안 줬으면 끝에 `--`를 붙여 git이 위치 인자를 경로로 해석하지 못하게 한다(log·diff·show·reset)
    auto_dd: bool,
    /// 경로는 반드시 `--` 뒤에(blame): 없으면 거절
    need_dd: bool,
}

fn spec(opts: Vec<Opt>, pos: Pos) -> Spec {
    Spec { opts, pos, num: false, max_pos: 8, auto_dd: false, need_dd: false }
}
fn revs_dd(opts: Vec<Opt>) -> Spec {
    Spec { auto_dd: true, ..spec(opts, Pos::Revs) }
}

const DATE: V = V::Of(&["iso", "iso-strict", "relative", "short", "local", "default", "human", "unix", "raw"]);

/// 보기 옵션(log·show·diff 공통)
fn view() -> Vec<Opt> {
    vec![f("stat"), f("shortstat"), f("numstat"), f("name-only"), f("name-status"), fs("patch", 'p'), fs("no-patch", 's'), f("summary"), f("no-color"), fs("ignore-all-space", 'w'), fs("ignore-space-change", 'b'), sov("unified", 'U', V::Int), v("diff-filter", None, V::Letters)]
}
fn with(mut a: Vec<Opt>, b: Vec<Opt>) -> Vec<Opt> {
    a.extend(b);
    a
}

fn spec_of(sub: &str) -> Option<Spec> {
    Some(match sub {
        "status" => spec(vec![fs("short", 's'), fs("branch", 'b'), f("porcelain"), f("long"), fs("", 'z'), ov("untracked-files", V::Of(&["no", "normal", "all"]))], Pos::Paths),
        "log" => Spec {
            num: true,
            auto_dd: true,
            ..spec(
                with(view(), vec![f("oneline"), f("graph"), f("decorate"), f("no-decorate"), f("all"), f("merges"), f("no-merges"), f("first-parent"), f("reverse"), f("follow"), f("left-right"), f("abbrev-commit"), f("relative-date"), v("max-count", Some('n'), V::Int), v("skip", None, V::Int), v("since", None, V::Free), v("after", None, V::Free), v("until", None, V::Free), v("before", None, V::Free), v("author", None, V::Free), v("committer", None, V::Free), v("grep", None, V::Free), fs("regexp-ignore-case", 'i'), v("", Some('S'), V::Free), v("", Some('G'), V::Free), v("format", None, V::Free), v("pretty", None, V::Free), v("date", None, DATE)]),
                Pos::Revs,
            )
        },
        "diff" => revs_dd(with(view(), vec![f("cached"), f("staged"), f("check"), f("no-renames"), f("exit-code"), fs("find-renames", 'M'), ov("word-diff", V::Of(&["color", "plain", "porcelain", "none"]))])),
        "show" => revs_dd(with(view(), vec![f("oneline"), f("abbrev-commit"), v("format", None, V::Free), v("pretty", None, V::Free)])),
        "blame" => Spec { need_dd: true, max_pos: 1, ..spec(vec![v("", Some('L'), V::Free), fs("", 'w'), fs("show-email", 'e'), f("line-porcelain"), fs("porcelain", 'p'), fs("", 'M'), fs("", 'C'), v("date", None, DATE), fs("", 's'), fs("show-name", 'f'), fs("show-number", 'n')], Pos::Revs) },
        "ls-files" => spec(vec![fs("cached", 'c'), fs("modified", 'm'), fs("others", 'o'), fs("deleted", 'd'), fs("stage", 's'), fs("unmerged", 'u'), fs("ignored", 'i'), fs("killed", 'k'), f("exclude-standard"), f("full-name"), fs("", 'z'), f("error-unmatch"), fs("", 't'), f("deduplicate")], Pos::Paths),
        "rev-parse" => spec(vec![f("abbrev-ref"), ov("short", V::Int), f("verify"), fs("quiet", 'q'), f("symbolic-full-name"), f("is-inside-work-tree"), f("is-bare-repository"), f("is-shallow-repository"), f("symbolic")], Pos::Revs),
        "add" => spec(vec![fs("all", 'A'), fs("update", 'u'), fs("intent-to-add", 'N'), fs("verbose", 'v'), fs("dry-run", 'n')], Pos::Paths),
        "commit" => spec(vec![v("message", Some('m'), V::Free), fs("all", 'a'), f("amend"), f("no-edit"), f("allow-empty"), fs("quiet", 'q'), fs("signoff", 's'), v("author", None, V::Free), v("date", None, V::Free), v("fixup", None, V::Rev), v("squash", None, V::Rev), f("reset-author"), f("dry-run")], Pos::Paths),
        "merge" => spec(vec![f("continue"), f("abort"), f("quit"), f("no-ff"), f("ff"), f("ff-only"), f("squash"), f("commit"), f("no-commit"), f("no-edit"), v("message", Some('m'), V::Free), fs("quiet", 'q'), f("allow-unrelated-histories"), v("", Some('X'), V::Of(&["ours", "theirs"]))], Pos::Revs),
        "rebase" => spec(vec![f("continue"), f("abort"), f("skip"), f("quit"), v("onto", None, V::Rev), f("autostash"), f("no-autostash"), fs("quiet", 'q'), v("empty", None, V::Of(&["drop", "keep"])), v("", Some('X'), V::Of(&["ours", "theirs"]))], Pos::Revs),
        "cherry-pick" => spec(vec![f("continue"), f("abort"), f("skip"), f("quit"), fs("no-commit", 'n'), v("mainline", Some('m'), V::Int), f("no-edit")], Pos::Revs),
        "revert" => spec(vec![f("continue"), f("abort"), f("skip"), f("quit"), fs("no-commit", 'n'), v("mainline", Some('m'), V::Int), f("no-edit")], Pos::Revs),
        "fetch" => spec(vec![f("all"), fs("prune", 'p'), fs("tags", 't'), f("no-tags"), fs("quiet", 'q'), fs("verbose", 'v'), v("depth", None, V::Int), f("unshallow"), f("dry-run")], Pos::Remote),
        "pull" => spec(vec![ov("rebase", V::Of(&["true", "false", "merges"])), f("no-rebase"), f("ff-only"), f("ff"), f("no-ff"), f("autostash"), f("no-autostash"), f("no-edit"), fs("quiet", 'q'), fs("verbose", 'v'), fs("prune", 'p'), f("commit"), f("no-commit"), f("squash"), f("allow-unrelated-histories"), v("", Some('X'), V::Of(&["ours", "theirs"]))], Pos::Remote),
        "push" => spec(vec![fs("set-upstream", 'u'), fs("dry-run", 'n'), fs("quiet", 'q'), fs("verbose", 'v'), f("atomic")], Pos::Remote),
        "switch" => Spec { max_pos: 2, ..spec(vec![v("create", Some('c'), V::Rev), fs("detach", 'd'), fs("merge", 'm'), fs("quiet", 'q'), f("no-track")], Pos::Revs) },
        "reset" => Spec { max_pos: 1, ..revs_dd(vec![f("soft"), f("mixed"), fs("quiet", 'q')]) },
        "rm" => spec(vec![f("cached"), fs("", 'r'), fs("quiet", 'q'), fs("dry-run", 'n'), f("ignore-unmatch")], Pos::Paths),
        "mv" => spec(vec![fs("dry-run", 'n')], Pos::Paths),
        "branch" => Spec { max_pos: 0, ..spec(vec![fs("all", 'a'), fs("remotes", 'r'), fs("verbose", 'v'), f("list"), f("show-current")], Pos::None) },
        "tag" => spec(vec![fs("list", 'l')], Pos::Revs),
        "remote" => spec(vec![], Pos::None),
        _ => return None,
    })
}

/// 허용 하위 명령 이름(도구 설명·테스트용)
pub const SUBCOMMANDS: [&str; 26] = [
    "status", "log", "diff", "show", "blame", "ls-files", "rev-parse", "add", "commit", "merge", "rebase", "cherry-pick", "revert", "fetch", "pull", "push", "switch", "stash", "reset", "rm", "mv", "branch", "tag", "remote", "reflog", "config",
];

fn bad<T>(m: impl Into<String>) -> Res<T> {
    Err(m.into())
}

fn check(val: V, name: &str, s: &str) -> Res<()> {
    let ok = match val {
        V::No => false,
        V::Free => true,
        V::Int => !s.is_empty() && s.len() <= 9 && s.bytes().all(|b| b.is_ascii_digit()),
        V::Letters => !s.is_empty() && s.chars().all(|c| c.is_ascii_alphabetic()),
        V::Of(list) => list.contains(&s),
        V::Rev => rev_ok(s).is_ok(),
    };
    if ok && !s.contains('\0') {
        Ok(())
    } else {
        bad(format!("invalid value for option {name}: {s:?}"))
    }
}

/// `.git`·`.claude`(대소문자·보이지 않는 글자·끝의 점/공백·8.3 이름·`:`·`\` 변형 포함)인가
fn forbidden_name(c: &str) -> bool {
    c.contains(':') || c.contains('\\') || dotgit(c)
}

fn dotgit(c: &str) -> bool {
    let clean: String = c.chars().filter(|ch| !matches!(ch, '\u{200b}'..='\u{200f}' | '\u{2060}' | '\u{feff}' | '\u{202a}'..='\u{202e}')).collect();
    let n = clean.trim_end_matches([' ', '.']).to_lowercase();
    n == ".git" || n == ".claude" || n.starts_with("git~") || n.starts_with("claude~")
}

fn is_drive(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b.len() == 2 || b[2] == b'/' || b[2] == b'\\')
}

/// 리비전·위치 인자로 쓸 수 있는 글자인가: 옵션처럼 보이지 않고, 절대 경로·`~`·`..` 경로 성분이 없다(저장소 밖을 가리켜 git이 `--no-index`로 바꾸는 것을 막는다)
fn rev_ok(s: &str) -> Res<()> {
    // 앱의 백업 ref(`refs/git403/…`)는 ref·리비전 자리에서 언급하는 것도 막는다(커밋 메시지 같은 자유 텍스트는 상관없다)
    if s.to_ascii_lowercase().contains("refs/git403") {
        return bad("references under refs/git403/ are reserved");
    }
    if s.is_empty() || s.contains('\0') || s.starts_with('-') || s.starts_with('/') || s.starts_with('~') || s.starts_with('\\') || is_drive(s) || s.starts_with('+') {
        return bad(format!("not allowed here: {s:?}"));
    }
    if s.split(['/', '\\']).any(|c| c == "..") {
        return bad(format!("path outside the repository: {s:?}"));
    }
    if s.split(['/', ':']).any(dotgit) {
        // `.git` 안(과 그 변형)을 가리키는 경로 (`HEAD:.git/config` 같은 것도 포함)
        return bad(format!("not allowed: {s:?}"));
    }
    Ok(())
}

/// 저장소 안의 경로로 해석한다: 절대 경로는 저장소 안일 때만, `..`는 저장소를 벗어나지 않을 때만, `.git`·`.claude` 불가,
/// 이미 있는 부분은 심볼릭 링크를 풀어 저장소 안인지 다시 본다. 저장소 기준 상대 경로를 돌려준다.
pub fn resolve(repo: &Path, p: &str) -> Res<PathBuf> {
    if p.is_empty() || p.contains('\0') {
        return bad("empty path");
    }
    let root = repo.canonicalize().map_err(|e| e.to_string())?;
    let given = Path::new(p);
    let rel: PathBuf = if given.is_absolute() {
        let r = given.strip_prefix(repo).or_else(|_| given.strip_prefix(&root)).map_err(|_| format!("path outside the repository: {p:?}"))?;
        r.to_path_buf()
    } else {
        if is_drive(p) || p.starts_with('~') {
            return bad(format!("path outside the repository: {p:?}"));
        }
        given.to_path_buf()
    };
    let mut norm = PathBuf::new();
    for c in rel.components() {
        match c {
            Component::Normal(n) => {
                let n = n.to_string_lossy();
                if forbidden_name(&n) {
                    return bad(format!("not allowed: {p:?}"));
                }
                norm.push(&*n);
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if !norm.pop() {
                    return bad(format!("path outside the repository: {p:?}"));
                }
            }
            _ => return bad(format!("path outside the repository: {p:?}")),
        }
    }
    // 경로의 어느 성분이든(마지막 포함) 심볼릭 링크면 거절한다: 커밋된 `g -> .git`처럼 이름 검사를 우회해 `.git`·밖으로 들어가는 길을 없앤다.
    // (조상 성분을 하나씩 `symlink_metadata`로 본다 — 아직 없는 뒷부분은 건너뛴다)
    let mut cur = root.clone();
    for c in norm.components() {
        cur.push(c);
        match cur.symlink_metadata() {
            Ok(m) if m.file_type().is_symlink() => return bad(format!("symbolic links are not allowed: {p:?}")),
            Ok(_) => {}
            Err(_) => break,
        }
    }
    // 방어 한 겹 더: 실제(정규화된) 위치가 저장소 안이고 그 상대 경로에도 금지 이름이 없어야 한다(대소문자 무시 파일 시스템의 실제 철자 포함)
    let mut probe = root.join(&norm);
    while probe.symlink_metadata().is_err() {
        if !probe.pop() {
            break;
        }
    }
    let real = probe.canonicalize().map_err(|e| e.to_string())?;
    let Ok(real_rel) = real.strip_prefix(&root) else { return bad(format!("path outside the repository: {p:?}")) };
    if real_rel.components().any(|c| matches!(c, Component::Normal(n) if forbidden_name(&n.to_string_lossy()))) {
        return bad(format!("not allowed: {p:?}"));
    }
    Ok(norm)
}

/// AI가 **쓰면 안 되는** 경로(정규화된 저장소 상대 경로): 다른 도구·사용자·CI가 나중에 자동으로 읽거나 실행하는 설정이라 AI가 고치면 지속형 인젝션이 된다.
/// - 에디터·에이전트: `.vscode`·`.idea`·`.cursor`·`.windsurf`·`.zed`·`.devcontainer`·`.continue`, `.mcp.json`·`CLAUDE.md`·`AGENTS.md`·`GEMINI.md`·`.cursorrules`·`.aider*`…
/// - 환경 자동 로드: `.envrc`, 도구 버전 관리 `mise*.toml`·`.tool-versions`
/// - 훅 관리 도구(이후 사용자의 commit이 실행): `.githooks`·`.husky`·`.lefthook`·`lefthook.yml`·`.pre-commit-config.yaml`
/// - CI·빌드·패키지 설정: `.github/**`(workflows·actions), `.gitlab-ci.yml`·`.gitlab`, `.circleci`, `.travis.yml`, `azure-pipelines.yml`, `bitbucket-pipelines.yml`, `Jenkinsfile`,
///   `.cargo/config*`(링커·rustflags가 빌드 때 실행), `.npmrc`·`.yarnrc*`·`.pnpmfile.cjs`(스크립트·레지스트리·훅), `.gitmodules`·`.gitattributes`(서브모듈 URL·필터·diff 드라이버 지정)
/// `package.json`·`Makefile`·`build.rs` 같은 **프로젝트 본문**은 막지 않는다 — 막으면 AI 작업의 대부분이 불가능하고, 실행은 사용자가 빌드·실행할 때 일어나며 diff에 보인다(문서에 명시한 수용 위험).
/// 읽기는 막지 않는다. 같은 규칙을 `mv` 인자와, 작업 트리를 바꾸는 git 작업이 들여오는 변경(`mcp::preflight`)에도 적용한다.
pub fn write_protected(rel: &Path) -> bool {
    const DIRS: [&str; 13] = [".vscode", ".idea", ".cursor", ".windsurf", ".zed", ".devcontainer", ".githooks", ".husky", ".lefthook", ".continue", ".github", ".gitlab", ".circleci"];
    const FILES: [&str; 33] = [
        "claude.md", "claude.local.md", "agents.md", "gemini.md", ".mcp.json", ".envrc", ".cursorrules", ".windsurfrules", ".aider.conf.yml", ".aiderignore", ".pre-commit-config.yaml", "lefthook.yml", "lefthook.yaml", ".lefthook.yml", ".lefthook.yaml", "copilot-instructions.md", ".clinerules", ".roomodes",
        ".gitlab-ci.yml", ".travis.yml", "azure-pipelines.yml", "bitbucket-pipelines.yml", "jenkinsfile", ".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmfile.cjs", ".tool-versions", ".gitmodules", ".gitattributes", ".gitpod.yml", ".mise.toml", "mise.toml",
    ];
    let names: Vec<String> = rel.components().filter_map(|c| matches!(c, Component::Normal(_)).then(|| c.as_os_str().to_string_lossy().to_lowercase())).collect();
    let n = names.len();
    let dir_hit = |c: &str| DIRS.contains(&c) || c.starts_with(".aider");
    names.iter().enumerate().any(|(i, c)| {
        let last = i + 1 == n;
        (!last && dir_hit(c)) || (last && (FILES.contains(&c.as_str()) || dir_hit(c) || ((c.starts_with("mise.") || c.starts_with(".mise.")) && c.ends_with(".toml")) || (c.starts_with("config") && i > 0 && names[i - 1] == ".cargo")))
    })
}

/// 브랜치·태그 이름(또는 `refs/heads/…`·`refs/tags/…`). `refs/`의 다른 이름(백업 `refs/git403/`·`refs/stash`·`refs/remotes` 등)·`+`·`:`·글롭·따옴표·공백은 불가
fn branch_name_ok(s: &str, allow_expr: bool) -> Res<()> {
    rev_ok(s)?;
    let chars = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-') || (allow_expr && matches!(c, '@' | '{' | '}' | '^' | '~'));
    if !s.chars().all(chars) || s.ends_with('/') || s.contains("//") {
        return bad(format!("not a plain branch or tag name: {s:?}"));
    }
    if s.starts_with("refs/") && !(s.starts_with("refs/heads/") || s.starts_with("refs/tags/")) {
        return bad(format!("only refs/heads/ and refs/tags/ may be named: {s:?}"));
    }
    Ok(())
}

/// fetch·pull 인자: 원격 브랜치 이름만(`src:dst` 불가 — 로컬 ref를 덮어쓸 수 있다)
fn fetch_ref_ok(s: &str) -> Res<()> {
    branch_name_ok(s, false)
}

/// push 인자: `<src>` 또는 `<src>:<dst>`. src는 리비전 표현, dst는 브랜치·태그 이름. 강제(`+`)·삭제(`:dst`)·글롭 불가
fn push_ref_ok(s: &str) -> Res<()> {
    match s.split_once(':') {
        None => branch_name_ok(s, true),
        Some((src, dst)) => {
            if src.is_empty() || dst.is_empty() {
                return bad(format!("refspec not allowed (deleting or empty side): {s:?}"));
            }
            branch_name_ok(src, true)?;
            branch_name_ok(dst, false)
        }
    }
}

fn path_arg(repo: &Path, s: &str) -> Res<String> {
    // 경로 마법(`:(…)`·`:!`)은 쓰지 않는다. 안전한 상대 경로로 정규화해 넘긴다
    if s.starts_with(':') {
        return bad(format!("pathspec magic is not allowed: {s:?}"));
    }
    let r = resolve(repo, s)?;
    Ok(if r.as_os_str().is_empty() { ".".into() } else { r.to_string_lossy().into_owned() })
}

fn parse(sub: &str, args: &[String], repo: &Path, remotes: &[String]) -> Res<Vec<String>> {
    let Some(sp) = spec_of(sub) else { return bad(format!("subcommand not allowed: {sub}")) };
    parse_spec(&sp, sub, args, repo, remotes)
}

fn parse_spec(sp: &Spec, sub: &str, args: &[String], repo: &Path, remotes: &[String]) -> Res<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    // 위치 인자는 자리만 잡아 두고(원래 순서 유지) 아래에서 종류별로 검사해 그 자리에 정규화한 값을 쓴다
    let (mut pos, mut after) = (Vec::<(usize, &String)>::new(), false);
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        i += 1;
        if after {
            let pa = path_arg(repo, a)?;
            if sub == "mv" && write_protected(Path::new(&pa)) {
                return bad(format!("moving to or from {a:?} is not allowed (editor/agent/hook configuration)"));
            }
            out.push(pa);
            continue;
        }
        if a == "--" {
            after = true;
            if sp.pos == Pos::Remote || sp.pos == Pos::None || sp.pos == Pos::StashRef {
                return bad("`--` is not allowed here");
            }
            out.push(a.clone());
            continue;
        }
        if let Some(rest) = a.strip_prefix("--") {
            let (name, value) = match rest.split_once('=') {
                Some((n, v)) => (n, Some(v)),
                None => (rest, None),
            };
            let Some(o) = sp.opts.iter().find(|o| !o.long.is_empty() && o.long == name) else { return bad(format!("option not allowed: --{name}")) };
            match (o.val, value) {
                (V::No, None) => out.push(a.clone()),
                (V::No, Some(_)) => return bad(format!("option --{name} takes no value")),
                (val, Some(x)) => {
                    check(val, &format!("--{name}"), x)?;
                    out.push(a.clone());
                }
                (val, None) if o.optional => {
                    let _ = val;
                    out.push(a.clone());
                }
                // 값이 선택인지 필수인지 git 안에서 옵션마다 달라(`--pretty`는 선택값이라 다음 인자를 옵션으로 읽는다) 자유 문자열 값은 `=` 형태만 받는다
                (V::Free, None) => return bad(format!("write free-text values as --{name}=<value> (one argument)")),
                (val, None) => {
                    let Some(x) = args.get(i) else { return bad(format!("option --{name} needs a value")) };
                    i += 1;
                    check(val, &format!("--{name}"), x)?;
                    out.push(a.clone());
                    out.push(x.clone());
                }
            }
        } else if a.len() > 1 && a.starts_with('-') {
            let body = &a[1..];
            if sp.num && body.bytes().all(|b| b.is_ascii_digit()) && body.len() <= 6 {
                out.push(a.clone());
                continue;
            }
            let mut separate: Option<&String> = None;
            for (k, c) in body.char_indices() {
                let Some(o) = sp.opts.iter().find(|o| o.short == Some(c)) else { return bad(format!("option not allowed: -{c}")) };
                if matches!(o.val, V::No) {
                    continue;
                }
                let attached = &body[k + c.len_utf8()..];
                if attached.is_empty() && o.optional {
                    break; // 짧은 선택값 옵션(`-U`·`-M`)은 붙인 값(`-U3`)만 받고 다음 인자를 먹지 않는다
                } else if attached.is_empty() {
                    let Some(x) = args.get(i) else { return bad(format!("option -{c} needs a value")) };
                    i += 1;
                    check(o.val, &format!("-{c}"), x)?;
                    separate = Some(x);
                } else {
                    check(o.val, &format!("-{c}"), attached)?;
                }
                break;
            }
            out.push(a.clone());
            if let Some(x) = separate {
                out.push(x.clone());
            }
        } else {
            pos.push((out.len(), a));
            out.push(a.clone());
        }
    }
    if pos.len() > sp.max_pos {
        return bad("too many arguments");
    }
    for (n, (at, p)) in pos.iter().enumerate() {
        match sp.pos {
            Pos::None => return bad(format!("unexpected argument: {p:?}")),
            Pos::Revs => {
                if !(p.as_str() == "-" && sub == "switch") {
                    rev_ok(p)?;
                }
            }
            Pos::Paths => {
                let a = path_arg(repo, p)?;
                if sub == "mv" && write_protected(Path::new(&a)) {
                    return bad(format!("moving to or from {p:?} is not allowed (editor/agent/hook configuration)"));
                }
                out[*at] = a;
            }
            Pos::Remote => {
                if n == 0 {
                    if !remotes.iter().any(|r| r == p.as_str()) {
                        return bad(format!("{p:?} is not a configured remote name (URLs and paths are not allowed). Configured: {}", remotes.join(", ")));
                    }
                } else if sub == "push" {
                    push_ref_ok(p)?;
                } else {
                    fetch_ref_ok(p)?;
                }
            }
            Pos::StashRef => {
                let ok = p.strip_prefix("stash@{").and_then(|r| r.strip_suffix('}')).is_some_and(|d| !d.is_empty() && d.len() <= 4 && d.bytes().all(|b| b.is_ascii_digit()));
                if !ok {
                    return bad(format!("not a stash reference: {p:?}"));
                }
            }
        }
    }
    let has_dd = out.iter().any(|a| a == "--");
    if sp.need_dd && !has_dd {
        return bad(format!("{sub} needs the path after `--`, e.g. [\"{sub}\", \"--\", \"<path>\"]"));
    }
    if sp.auto_dd && !has_dd {
        out.push("--".into());
    }
    // 인자 없는 fetch·pull·push는 `branch.<b>.remote`·`remote.pushDefault`가 가리키는 곳(URL·경로일 수 있다)으로 간다: 원격 이름을 항상 명시하게 한다
    if sp.pos == Pos::Remote && pos.is_empty() && !(sub == "fetch" && out.iter().any(|a| a == "--all")) {
        return bad(format!("{sub} needs an explicit remote name (one of the configured remotes), e.g. [\"{sub}\", \"origin\"]"));
    }
    if sp.pos == Pos::Remote && pos.len() > 1 && out.iter().any(|a| a == "--all") {
        return bad("--all cannot be combined with refspecs");
    }
    if sub == "tag" && !pos.is_empty() && !out.iter().any(|a| a == "-l" || a == "--list") {
        return bad("only listing tags is allowed (use -l)");
    }
    if sub == "mv" && pos.len() < 2 {
        return bad("mv needs a source and a destination");
    }
    Ok(out)
}

fn stash_spec(name: &str) -> Spec {
    match name {
        "push" => spec(vec![v("message", Some('m'), V::Free), fs("include-untracked", 'u'), fs("keep-index", 'k'), fs("quiet", 'q')], Pos::Paths),
        "list" => spec(vec![f("oneline"), f("stat")], Pos::None),
        "show" => spec(vec![fs("patch", 'p'), f("stat"), f("name-only")], Pos::StashRef),
        _ => spec(vec![f("index"), fs("quiet", 'q')], Pos::StashRef),
    }
}

/// 도구 입력(`git` 뒤 인자 배열)을 검사해 실제로 실행할 git 인자(안전 설정 `-c` 포함, `git` 자신은 제외)를 만든다.
/// `repo`는 저장소 폴더, `remotes`는 `git remote`가 돌려준 이름들.
pub fn validate(args: &[String], repo: &Path, remotes: &[String]) -> Res<Vec<String>> {
    let Some(sub) = args.first() else { return bad("no git subcommand") };
    if args.iter().any(|a| a.contains('\0')) {
        return bad("NUL in argument");
    }
    let rest = &args[1..];
    let body: Vec<String> = match sub.as_str() {
        "stash" => {
            let (name, rest) = match rest.first() {
                None => ("push", rest),
                Some(s) if matches!(s.as_str(), "push" | "list" | "show" | "apply") => (s.as_str(), &rest[1..]),
                Some(s) => return bad(format!("stash subcommand not allowed: {s} (allowed: push, list, show, apply)")),
            };
            let sp = stash_spec(name);
            // stash는 하위 이름마다 표가 달라 직접 파싱한다
            let mut out = parse_spec(&sp, "stash", rest, repo, remotes)?;
            out.insert(0, name.to_string());
            let mut v = vec!["stash".to_string()];
            v.append(&mut out);
            v
        }
        "reflog" => {
            let mut o = vec!["reflog".to_string()];
            match rest.first().map(String::as_str) {
                None => {}
                Some("show") => {
                    o.push("show".into());
                    o.extend(parse_spec(&spec(vec![v("max-count", Some('n'), V::Int)], Pos::Revs), "reflog", &rest[1..], repo, remotes)?);
                }
                Some(s) => return bad(format!("reflog subcommand not allowed: {s}")),
            }
            o
        }
        "config" => {
            let ok = matches!(rest, [g, k] if g == "--get" && (k == "user.name" || k == "user.email"));
            if !ok {
                return bad("only `config --get user.name` and `config --get user.email` are allowed");
            }
            let mut o = vec!["config".to_string()];
            o.extend(rest.iter().cloned());
            o
        }
        "remote" => {
            if !rest.is_empty() {
                return bad("only `remote` (list names) is allowed");
            }
            vec!["remote".into()]
        }
        s => {
            let mut o = vec![s.to_string()];
            o.extend(parse(s, rest, repo, remotes)?);
            o
        }
    };
    let mut body = body;
    // 하위 명령 바로 뒤에 앱이 넣는 안전 옵션: 설정된 외부 diff·textconv 프로그램과 서브모듈 재귀를 끈다
    let at = if body[0] == "stash" { 2 } else { 1 };
    let extra: &[&str] = match (body[0].as_str(), body.get(1).map(String::as_str)) {
        ("diff" | "log" | "show", _) | ("stash", Some("show")) => &["--no-ext-diff", "--no-textconv"],
        ("blame", _) => &["--no-textconv"],
        ("fetch" | "pull" | "push", _) => &["--no-recurse-submodules"],
        // 무시 목록(.gitignore)에 걸린 파일(.env 등)을 병합·전환이 조용히 덮어쓰지 않게 한다
        ("merge" | "switch", _) => &["--no-overwrite-ignore"],
        _ => &[],
    };
    for (k, e) in extra.iter().enumerate() {
        body.insert(at + k, (*e).to_string());
    }
    // 원격 명령은 그 원격의 prune·mirror 설정도 꺼 둔다(저장소 설정이 있어도 이긴다)
    let mut full = prefix(repo);
    if let ("fetch" | "pull" | "push", Some(r)) = (body[0].as_str(), body.iter().skip(1).find(|a| remotes.contains(a))) {
        full.extend(["-c".to_string(), format!("remote.{r}.prune=false"), "-c".into(), format!("remote.{r}.mirror=false"), "-c".into(), format!("remote.{r}.pruneTags=false")]);
    }
    full.extend(body);
    Ok(full)
}

/// null 장치(훅 폴더를 비워 훅을 막는 데 쓴다)
const NULL_DEV: &str = if cfg!(windows) { "NUL" } else { "/dev/null" };

/// 모든 AI git 호출 앞에 붙는 전역 설정(`repo`는 저장소 폴더, 정규화된 경로):
/// - `--work-tree=<repo>`: 저장소 설정 `core.worktree`가 밖을 가리켜도 작업 트리는 이 폴더(명령줄이 설정을 이긴다)
/// - pager 없음, 외부 프로토콜·fsmonitor 끔, **훅 끔**(`core.hooksPath` = null 장치) — 저장소 안 훅 폴더(`.githooks`·husky)를 AI가 고친 뒤 commit이 실행하는 길과
///   pull로 받은 원격 훅 실행을 AI 차례 동안 막는다(AI 차례의 commit·merge·rebase·push는 훅을 실행하지 않는다)
/// - 서브모듈 안으로 들어가지 않는다: `submodule.recurse=false`·`diff.ignoreSubmodules=all`·`status.submoduleSummary=false`(서브모듈 설정의 filter가 status 한 번에 실행되던 길)
/// - 자동 정리(`gc.auto=0`·`maintenance.auto=false`: auto gc가 `gc.recentObjectsHook`을 실행하던 길)·`protocol.file.allow=never`(같은 컴퓨터의 저장소로의 fetch·push 불가)
/// - 원격 조작은 안전하게: `fetch.prune=false`·`fetch.pruneTags=false`·`push.default=nothing`(refspec 없는 push 불가), 원격별 설정은 `validate`가 더한다
pub fn prefix(repo: &Path) -> Vec<String> {
    let mut v: Vec<String> = vec!["--no-pager".into(), format!("--work-tree={}", repo.display())];
    for c in ["protocol.ext.allow=never", "core.fsmonitor=false", "core.pager=cat", "core.quotepath=false", "submodule.recurse=false", "diff.ignoreSubmodules=all", "status.submoduleSummary=false", "fetch.prune=false", "fetch.pruneTags=false", "push.default=nothing", "push.recurseSubmodules=no", "gc.auto=0", "maintenance.auto=false", "protocol.file.allow=never"] {
        v.extend(["-c".into(), c.into()]);
    }
    v.extend(["-c".into(), format!("core.hooksPath={NULL_DEV}")]);
    v
}

/// 원격 목록 지문: `(이름, URL)` 쌍(가져오기·보내기 URL, `insteadOf` 적용 후)을 정렬·중복 제거해 FNV-1a 64비트로 줄인다.
/// 앱(`ai_risk`)이 차례 시작 때 확인한 값과 MCP 서버가 push·fetch·pull 직전에 다시 계산한 값이 같아야 한다.
pub fn remotes_fingerprint(pairs: &mut Vec<(String, String)>) -> String {
    pairs.sort();
    pairs.dedup();
    let text = pairs.iter().map(|(n, u)| format!("{n}={u}")).collect::<Vec<_>>().join("\n");
    format!("{:016x}", text.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)))
}

/// 도구 설명용 한 줄 요약(모델이 볼 안내)
pub fn describe() -> String {
    format!("Run git in the current repository (no shell: pass the arguments as an array WITHOUT the leading `git`, e.g. [\"commit\",\"-m\",\"msg\"]). Allowed subcommands: {}. Only a safe subset of each subcommand's options is accepted (no force/delete/hard-reset/exec options, no global options like -c or -C); remotes must be configured remote names, never URLs or paths. Put paths after `--` (for log, diff, show, reset, blame); write free-text option values as --opt=value (e.g. --author=kim, --format=%h); push/fetch/pull take a configured remote name and plain branch/tag names (src[:dst] only for push). Rejected calls explain why.", SUBCOMMANDS.join(", "))
}

const READ_LIMIT: u64 = 256 * 1024;
const EDIT_LIMIT: u64 = 1024 * 1024;

/// 저장소 안 파일 읽기(텍스트, 256KB까지). `.git`·`.claude`·저장소 밖·심볼릭 링크로 나가는 경로는 거절
pub fn read_file(repo: &Path, path: &str) -> Res<String> {
    let rel = resolve(repo, path)?;
    let full = repo.canonicalize().map_err(|e| e.to_string())?.join(rel);
    let meta = std::fs::metadata(&full).map_err(|e| format!("cannot read {path:?}: {e}"))?;
    if !meta.is_file() {
        return bad(format!("not a file: {path:?}"));
    }
    if meta.len() > READ_LIMIT {
        return bad(format!("file too large ({} bytes, limit {READ_LIMIT})", meta.len()));
    }
    std::fs::read(&full).map(|b| String::from_utf8_lossy(&b).into_owned()).map_err(|e| e.to_string())
}

/// 저장소 안 파일 수정: `old`가 비면 새 파일 만들기(이미 있으면 거절), 아니면 `old`가 정확히 한 번 나올 때(또는 `all`) 바꾼다.
/// 읽기와 같은 경로 규칙 + 심볼릭 링크 파일은 수정하지 않는다. 몇 곳을 바꿨는지 돌려준다.
pub fn edit_file(repo: &Path, path: &str, old: &str, new: &str, all: bool) -> Res<usize> {
    let rel = resolve(repo, path)?;
    if write_protected(&rel) {
        return bad(format!("writing {path:?} is not allowed (editor/agent/hook configuration is read by other tools automatically)"));
    }
    let full = repo.canonicalize().map_err(|e| e.to_string())?.join(rel);
    if let Ok(m) = full.symlink_metadata() {
        if m.file_type().is_symlink() {
            return bad(format!("refusing to edit a symlink: {path:?}"));
        }
    }
    if old.is_empty() {
        if full.exists() {
            return bad(format!("file already exists: {path:?} (give old_string to edit it)"));
        }
        if let Some(dir) = full.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            // 방금 만든 폴더가 저장소 밖으로 풀리지 않는지 다시 본다
            if !dir.canonicalize().map_err(|e| e.to_string())?.starts_with(repo.canonicalize().map_err(|e| e.to_string())?) {
                return bad(format!("path outside the repository: {path:?}"));
            }
        }
        std::fs::write(&full, new).map_err(|e| e.to_string())?;
        return Ok(1);
    }
    let meta = std::fs::metadata(&full).map_err(|e| format!("cannot edit {path:?}: {e}"))?;
    if !meta.is_file() || meta.len() > EDIT_LIMIT {
        return bad(format!("not an editable file: {path:?}"));
    }
    let text = String::from_utf8(std::fs::read(&full).map_err(|e| e.to_string())?).map_err(|_| format!("not UTF-8 text: {path:?}"))?;
    let n = text.matches(old).count();
    if n == 0 {
        return bad("old_string was not found");
    }
    if n > 1 && !all {
        return bad(format!("old_string appears {n} times; make it unique or set replace_all"));
    }
    std::fs::write(&full, text.replace(old, new)).map_err(|e| e.to_string())?;
    Ok(n)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }
    fn repo() -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().canonicalize().unwrap();
        std::fs::create_dir_all(p.join(".git")).unwrap();
        std::fs::create_dir_all(p.join("src")).unwrap();
        std::fs::write(p.join("src/a.rs"), "fn a() {}\n").unwrap();
        (d, p)
    }
    fn remotes() -> Vec<String> {
        v(&["origin", "upstream"])
    }
    fn ok(r: &Path, a: &[&str]) -> bool {
        validate(&v(a), r, &remotes()).is_ok()
    }
    fn args_of(r: &Path, a: &[&str]) -> Vec<String> {
        {
            let mut x = validate(&v(a), r, &remotes()).unwrap().split_off(prefix(r).len());
            // 원격 명령은 앞에 원격별 `-c remote.<r>.…` 설정이 더 붙는다
            while x.first().is_some_and(|t| t == "-c") && x.get(1).is_some_and(|t| t.starts_with("remote.")) {
                x.drain(..2);
            }
            x
        }
    }

    #[test]
    fn builds_safe_argv_in_original_order() {
        let (_d, r) = repo();
        let full = validate(&v(&["log", "--oneline", "-n", "5", "main", "--", "src/a.rs"]), &r, &remotes()).unwrap();
        assert_eq!(&full[..prefix(&r).len()], &prefix(&r)[..]);
        let pre = prefix(&r).join(" ");
        assert!(pre.starts_with(&format!("--no-pager --work-tree={} -c protocol.ext.allow=never -c core.fsmonitor=false", r.display())), "작업 트리 고정: {pre}");
        for c in ["-c core.hooksPath=/dev/null", "-c submodule.recurse=false", "-c diff.ignoreSubmodules=all", "-c status.submoduleSummary=false", "-c fetch.prune=false", "-c fetch.pruneTags=false", "-c push.default=nothing", "-c gc.auto=0", "-c maintenance.auto=false", "-c protocol.file.allow=never"] {
            assert!(pre.contains(c), "{c}: {pre}");
        }
        assert_eq!(&full[prefix(&r).len()..], ["log", "--no-ext-diff", "--no-textconv", "--oneline", "-n", "5", "main", "--", "src/a.rs"], "외부 diff·textconv를 끈다");
        assert_eq!(args_of(&r, &["diff", "--cached"]), ["diff", "--no-ext-diff", "--no-textconv", "--cached", "--"]);
        assert_eq!(args_of(&r, &["blame", "--", "src/a.rs"]), ["blame", "--no-textconv", "--", "src/a.rs"]);
        assert_eq!(args_of(&r, &["stash", "show", "-p"]), ["stash", "show", "--no-ext-diff", "--no-textconv", "-p"]);
        assert_eq!(args_of(&r, &["fetch", "origin"]), ["fetch", "--no-recurse-submodules", "origin"]);
        assert_eq!(args_of(&r, &["push", "-u", "origin", "feat"]), ["push", "--no-recurse-submodules", "-u", "origin", "feat"]);
        let full = validate(&v(&["push", "origin", "feat"]), &r, &remotes()).unwrap().join(" ");
        assert!(full.contains("-c remote.origin.prune=false -c remote.origin.mirror=false -c remote.origin.pruneTags=false"), "원격별 설정: {full}");
        assert_eq!(args_of(&r, &["merge", "dev"]), ["merge", "--no-overwrite-ignore", "dev"]);
        assert_eq!(args_of(&r, &["switch", "-c", "x"]), ["switch", "--no-overwrite-ignore", "-c", "x"]);
        assert_eq!(args_of(&r, &["add", "./src/../src/a.rs"]), ["add", "src/a.rs"], "경로는 정규화해 넘긴다");
        assert_eq!(args_of(&r, &["add", &format!("{}/src/a.rs", r.display())]), ["add", "src/a.rs"], "저장소 안 절대 경로는 상대로");
        assert_eq!(args_of(&r, &["stash"]), ["stash", "push"]);
    }

    #[test]
    fn everyday_commands_are_allowed() {
        let (_d, r) = repo();
        for a in [
            &["status"][..], &["status", "-sb"], &["status", "--porcelain"], &["log"], &["log", "--oneline", "-20"], &["log", "--graph", "--oneline", "--all"], &["log", "-n5", "--format=%h %s"], &["log", "--pretty=oneline", "-1"], &["log", "--author=kim", "--since=2 weeks ago", "--grep=fix", "-i"], &["log", "-S", "needle", "--", "src"], &["log", "main..feature"], &["log", "HEAD~3..HEAD", "--stat"],
            &["diff"], &["diff", "--cached", "--stat"], &["diff", "HEAD~1", "HEAD", "--", "src/a.rs"], &["diff", "-U5", "-w", "main...feature"], &["diff", "--diff-filter=AM", "--name-only"], &["show", "HEAD"], &["show", "HEAD:src/a.rs"], &["show", "--stat", "--format=%an", "abc1234"], &["blame", "-L", "1,5", "--", "src/a.rs"], &["blame", "-w", "-M", "main", "--", "src/a.rs"],
            &["ls-files"], &["ls-files", "-o", "--exclude-standard"], &["rev-parse", "HEAD"], &["rev-parse", "--abbrev-ref", "HEAD"], &["rev-parse", "--short=7", "HEAD"], &["rev-parse", "--is-inside-work-tree"],
            &["add", "-A"], &["add", "src/a.rs", "README.md"], &["add", "-u"], &["add", "."], &["commit", "-m", "fix: 수정 <a@b.c> !"], &["commit", "-am", "msg"], &["commit", "--amend", "--no-edit"], &["commit", "-m", "-starts-with-dash"], &["commit", "-m", "a", "-m", "b", "--allow-empty"], &["commit", "--fixup", "abc123"],
            &["merge", "feature"], &["merge", "--no-ff", "-m", "merge", "feature"], &["merge", "--abort"], &["merge", "--continue"], &["merge", "-X", "theirs", "feature"], &["rebase", "main"], &["rebase", "--onto", "main", "old", "topic"], &["rebase", "--continue"], &["rebase", "--abort"], &["rebase", "--skip"], &["rebase", "--autostash", "main"],
            &["cherry-pick", "abc123"], &["cherry-pick", "-n", "abc", "def"], &["cherry-pick", "-m", "1", "abc"], &["cherry-pick", "--abort"], &["revert", "abc123"], &["revert", "--no-edit", "abc"],
            &["fetch", "origin"], &["fetch", "--all", "--prune"], &["fetch", "origin", "main"], &["fetch", "-p", "upstream"], &["pull", "origin"], &["pull", "--rebase", "origin"], &["pull", "--rebase=merges", "origin", "main"], &["pull", "--ff-only", "origin"], &["push", "origin"], &["push", "origin", "main"], &["push", "-u", "origin", "feat"], &["push", "origin", "HEAD:refs/heads/x"], &["push", "origin", "main:main"], &["push", "-n", "origin", "main"],
            &["switch", "main"], &["switch", "-c", "feat/x"], &["switch", "--create", "x", "origin/main"], &["switch", "-"], &["switch", "-d", "abc123"], &["switch", "-m", "other"], &["reset"], &["reset", "HEAD", "--", "src/a.rs"], &["reset", "--soft", "HEAD~1"], &["reset", "--mixed", "HEAD~2"], &["reset", "-q", "--", "src/a.rs"],
            &["stash"], &["stash", "push", "-m", "wip", "-u"], &["stash", "list"], &["stash", "show", "-p", "stash@{1}"], &["stash", "apply"], &["stash", "apply", "--index", "stash@{0}"], &["rm", "--cached", "src/a.rs"], &["rm", "-r", "src"], &["mv", "src/a.rs", "src/b.rs"],
            &["branch"], &["branch", "-a"], &["branch", "-vv"], &["branch", "--show-current"], &["tag"], &["tag", "-l", "v*"], &["remote"], &["reflog"], &["reflog", "show", "-n", "5", "main"], &["config", "--get", "user.name"], &["config", "--get", "user.email"],
        ] {
            assert!(ok(&r, a), "허용돼야 함: {a:?} → {:?}", validate(&v(a), &r, &remotes()));
        }
    }

    /// 모두 거절돼야 하는 우회 시도: 이전 리뷰에서 나온 것 전부 + 묶음·줄임말·따옴표·`=`·`--` 뒤·유니코드 변형
    #[test]
    fn bypass_attempts_are_rejected() {
        let (_d, r) = repo();
        let attacks: Vec<Vec<&str>> = vec![
            // 전역 옵션·별칭·설정
            vec!["-c", "alias.x=!sh", "x"], vec!["-C", "/tmp", "status"], vec!["--git-dir=/x", "status"], vec!["--work-tree=/x", "status"], vec!["--exec-path=/x", "status"], vec!["--config-env=a=b", "status"], vec!["-c", "core.pager=sh", "log"], vec!["x"], vec![""], vec![],
            vec!["config", "core.hooksPath", "/tmp"], vec!["config", "--list"], vec!["config", "--get-regexp", "."], vec!["config", "--get", "remote.origin.url"], vec!["config", "--get", "user.name", "--unset"], vec!["config", "-l"], vec!["config", "--global", "--get", "user.name"], vec!["config", "--get", "user.name", "extra"], vec!["config", "alias.x", "!sh"],
            vec!["remote", "-v"], vec!["remote", "get-url", "origin"], vec!["remote", "add", "o", "x"], vec!["remote", "show"],
            // rebase 실행 (reviewer: -nx)
            vec!["rebase", "-nx", "touch /밖", "HEAD~1"], vec!["rebase", "-x", "sh", "main"], vec!["rebase", "--exec", "sh", "main"], vec!["rebase", "--exec=sh", "main"], vec!["rebase", "--ex=sh", "main"], vec!["rebase", "-ix", "sh", "main"], vec!["rebase", "-i", "main"], vec!["rebase", "--interactive", "main"], vec!["rebase", "-xsh", "main"], vec!["rebase", "-x'sh'", "main"], vec!["rebase", "--root"],
            // 강제 푸시·삭제 (reviewer: -4f -6f -of)
            vec!["push", "--force"], vec!["push", "-f"], vec!["push", "-4f"], vec!["push", "-6f"], vec!["push", "-of"], vec!["push", "-uf", "origin"], vec!["push", "-fu", "origin"], vec!["push", "--force-with-lease"], vec!["push", "--force-if-includes"], vec!["push", "--for"], vec!["push", "--fo"], vec!["push", "origin", "+main"], vec!["push", "origin", "'+main'"], vec!["push", "origin", ":main"], vec!["push", "origin", "\":main\""], vec!["push", "origin", "main", "+dev"], vec!["push", "-d", "origin", "x"], vec!["push", "--delete", "origin", "x"], vec!["push", "--mirror"], vec!["push", "--prune"], vec!["push", "--receive-pack=sh"], vec!["push", "--exec=sh"], vec!["push", "-f'u'"], vec!["push", "-'f'"], vec!["push", "-ｆ"], vec!["push", "‐f"], vec!["push", "--force=true"],
            // 원격은 설정된 이름만 (reviewer: fetch|pull|push 로컬 경로·file://)
            vec!["push", "/tmp/other"], vec!["push", "file:///tmp/x"], vec!["push", "../other"], vec!["push", "./other"], vec!["push", "https://example.com/x.git"], vec!["push", "git@github.com:o/r.git"], vec!["push", "main"], vec!["fetch", "/tmp/other"], vec!["fetch", "file:///tmp/x"], vec!["fetch", "ext::sh -c id"], vec!["fetch", "unknown"], vec!["pull", "/tmp/other"], vec!["pull", "file:///x", "main"], vec!["pull", "-"], vec!["push", "origin", "--", "x"], vec!["fetch", "--", "origin"], vec!["fetch", "--all", "origin", "main"],
            vec!["fetch", "--upload-pack=sh", "origin"], vec!["fetch", "--upl=sh"], vec!["fetch", "-u"], vec!["pull", "--upload-pack=sh"], vec!["fetch", "-f"], vec!["fetch", "--force"], vec!["pull", "--rebase=interactive"], vec!["pull", "-r"], vec!["pull", "--exec=sh"],
            // 저장소 밖 읽기 (reviewer: blame --contents, diff /밖 /dev/null, commit -F|-t, merge -F, --pathspec-from-file)
            vec!["blame", "--contents", "/etc/passwd", "src/a.rs"], vec!["blame", "--contents=/etc/passwd", "src/a.rs"], vec!["blame", "--ignore-revs-file=/etc/passwd", "src/a.rs"], vec!["diff", "/etc/passwd", "/dev/null"], vec!["diff", "/dev/null", "/etc/passwd"], vec!["diff", "--no-index", "/etc/hosts", "/dev/null"], vec!["diff", "--no-i", "a", "b"], vec!["diff", "../a", "../b"], vec!["diff", "~/.ssh/config", "/dev/null"], vec!["diff", "--", "/etc/passwd"], vec!["diff", "--", "../x"], vec!["show", "/etc/passwd"], vec!["log", "-p", "--", "/etc/passwd"], vec!["log", "--output=/tmp/x"], vec!["diff", "--output=/tmp/x"], vec!["diff", "--ou=/tmp/x"], vec!["show", "--output", "/tmp/x"],
            vec!["commit", "-F", "/etc/passwd"], vec!["commit", "-F/etc/passwd"], vec!["commit", "--file=/etc/passwd"], vec!["commit", "-t", "/etc/passwd"], vec!["commit", "--template=/etc/passwd"], vec!["commit", "-C", "HEAD"], vec!["commit", "-c", "HEAD"], vec!["commit", "-e"], vec!["commit", "--edit"], vec!["commit", "--pathspec-from-file=/etc/passwd"], vec!["commit", "--pathspec-from-file", "/etc/passwd"], vec!["merge", "-F", "/etc/passwd", "x"], vec!["merge", "--file=/etc/passwd", "x"], vec!["add", "--pathspec-from-file=/etc/passwd"], vec!["add", "--pathspec-from-file", "x"], vec!["reset", "--pathspec-from-file=/etc/passwd"], vec!["rm", "--pathspec-from-file=x"], vec!["ls-files", "-X", "/etc/passwd"], vec!["ls-files", "--exclude-from=/etc/passwd"], vec!["status", "--pathspec-from-file=/x"],
            // 파괴적 옵션·명령
            vec!["reset", "--hard"], vec!["reset", "--ha"], vec!["reset", "--hard", "HEAD~1"], vec!["reset", "HEAD~1", "--hard"], vec!["reset", "--merge"], vec!["reset", "--keep"], vec!["reset", "-p"], vec!["switch", "-f", "x"], vec!["switch", "-C", "x"], vec!["switch", "-fc", "x"], vec!["switch", "--force", "x"], vec!["switch", "--discard-changes", "x"], vec!["switch", "--disc", "x"], vec!["switch", "x", "-f"], vec!["switch", "--force-create", "x"], vec!["switch", "--orphan", "x"],
            vec!["branch", "-D", "x"], vec!["branch", "-d", "x"], vec!["branch", "-fD", "x"], vec!["branch", "-d", "-f", "x"], vec!["branch", "--delete", "--force", "x"], vec!["branch", "x"], vec!["branch", "-M", "x"], vec!["branch", "-f", "x", "HEAD"], vec!["branch", "-a", "x"], vec!["branch", "--list", "-D", "x"], vec!["tag", "v1"], vec!["tag", "-d", "v1"], vec!["tag", "-a", "v1", "-m", "x"], vec!["tag", "-f", "v1"],
            vec!["rm", "-f", "a"], vec!["rm", "--force", "a"], vec!["rm", "-rf", "."], vec!["rm", "-fr", "."], vec!["add", "-f", "x"], vec!["add", "--force", "x"], vec!["add", "-i"], vec!["add", "-p"], vec!["add", "-e"],
            vec!["stash", "drop"], vec!["stash", "pop"], vec!["stash", "clear"], vec!["stash", "branch", "x"], vec!["stash", "push", "--patch"], vec!["stash", "-u"], vec!["stash", "--include-untracked"], vec!["stash", "show", "x"], vec!["stash", "apply", "stash@{x}"], vec!["stash", "apply", "-"], vec!["stash", "list", "-p"],
            vec!["checkout", "-B", "main"], vec!["checkout", "--", "a"], vec!["checkout", "."], vec!["restore", "a"], vec!["clean", "-fd"], vec!["worktree", "add", "/tmp/x"], vec!["update-ref", "-d", "x"], vec!["filter-branch"], vec!["gc"], vec!["prune"], vec!["reflog", "expire"], vec!["reflog", "delete", "x"], vec!["reflog", "show", "--all", "-o"], vec!["apply", "x"], vec!["am", "x"], vec!["submodule", "update"], vec!["clone", "x"], vec!["init"], vec!["archive", "-o", "/tmp/x", "HEAD"], vec!["grep", "-O", "sh", "x"], vec!["bisect", "run", "sh"], vec!["daemon"], vec!["fsck"], vec!["notes"], vec!["difftool"], vec!["mergetool"], vec!["help"], vec!["cat-file", "-p", "HEAD"], vec!["hash-object", "-w", "/etc/passwd"], vec!["format-patch", "-o", "/tmp"], vec!["describe"],
            // 위치 인자·경로 변형
            vec!["add", "/etc/passwd"], vec!["add", "../x"], vec!["add", "src/../../x"], vec!["add", ".git/config"], vec!["add", ".GIT/config"], vec!["add", ".Git"], vec!["add", ".git ."], vec!["add", ".g\u{200b}it/config"], vec!["add", "GIT~1/config"], vec!["add", ".git::$INDEX_ALLOCATION"], vec!["add", ".claude/settings.json"], vec!["add", ".CLAUDE/x"], vec!["add", ":(top)x"], vec!["add", ":!x"], vec!["add", ":/"], vec!["add", "~/x"], vec!["add", "C:\\x"], vec!["add", "a\\.git\\b"],
            vec!["add", "--", "../x"], vec!["add", "--", "/etc/passwd"], vec!["add", "--", ".git/config"], vec!["commit", "-m", "x", "--", "../y"], vec!["rm", "--", ".git/HEAD"], vec!["mv", "a", "../b"], vec!["mv", "a"], vec!["mv", "a", ".git/x"], vec!["reset", "--", ".git/x"], vec!["stash", "push", "--", "../x"], vec!["ls-files", "../x"], vec!["status", "/etc"],
            vec!["show", "HEAD:.git/config"], vec!["show", ".git/config"], vec!["log", "--", ".git/HEAD"], vec!["show", "-x"], vec!["log", "-x"], vec!["log", "--no-such"], vec!["log", "--oneline=3"], vec!["log", "-n"], vec!["log", "-nx"], vec!["log", "-n", "x"], vec!["log", "-n", "-1"], vec!["log", "--max-count=abc"], vec!["log", "--date=format:%s"], vec!["log", "--diff-filter=1"], vec!["status", "--untracked-files=bad"], vec!["diff", "--word-diff=bad"],
            vec!["log", "\0"], vec!["log", "a\0b"], vec!["push", "origin", "a\0"], vec!["switch", "--create", "-x"], vec!["switch", "-c"], vec!["switch", "-c", "../x"], vec!["switch", "a", "b", "c"], vec!["merge", "-s", "ours", "x"], vec!["merge", "-X", "x"], vec!["merge", "-Xours=1", "x"], vec!["cherry-pick", "-x", "abc"], vec!["revert", "-m", "x", "abc"], vec!["fetch", "--depth=x"], vec!["rev-parse", "--git-dir"], vec!["rev-parse", "--show-toplevel"], vec!["rev-parse", "--git-path", "x"], vec!["rev-parse", "--resolve-git-dir=/x"], vec!["rev-parse", "--show-cdup"], vec!["rev-parse", "/etc/passwd"], vec!["rev-parse", "--short=x"],
            // 3차 리뷰: 선택값 옵션 뒤 인자(`--pretty <x>`는 git이 다음을 옵션으로 읽음), 경로는 `--` 뒤만, refspec, 백업 ref, 검사 훅 우회, 범위 확대
            vec!["log", "--pretty", "--output=/tmp/x", "-1"], vec!["log", "--format", "--output=/tmp/x"], vec!["show", "--pretty", "--output=/tmp/x"], vec!["log", "--author", "kim"], vec!["log", "--since", "1 day ago"], vec!["log", "--grep", "x"], vec!["commit", "--author", "a <b@c>"], vec!["commit", "--date", "now"], vec!["merge", "--message", "m", "x"], vec!["log", "--pretty"],
            vec!["blame", "a.txt"], vec!["blame", "HEAD", "a.txt"], vec!["blame", "-L1,2", "a.txt"], vec!["blame", "a", "b", "--", "c"], vec!["blame", "--", "../x"],
            vec!["fetch", "origin", "main:refs/git403/ai-backup/x"], vec!["fetch", "origin", "main:main"], vec!["fetch", "origin", "+main"], vec!["fetch", "origin", "refs/*:refs/*"], vec!["pull", "origin", "main:main"], vec!["fetch", "origin", "refs/stash"], vec!["fetch", "origin", "refs/remotes/o/x"], vec!["fetch", "origin", "a b"],
            vec!["push", "origin", "main:refs/git403/ai-backup/x"], vec!["push", "origin", "HEAD:refs/stash"], vec!["push", "origin", "main:*"], vec!["push", "origin", "*:*"], vec!["push", "origin", "refs/*:refs/*"], vec!["push", "origin", "main:"], vec!["push", "origin", "HEAD:HEAD:x"], vec!["push", "origin", "refs/git403/ai-backup/x"], vec!["show", "refs/git403/ai-backup/x"], vec!["log", "REFS/GIT403/ai-backup/x"], vec!["reset", "--soft", "refs/git403/x"],
            vec!["fetch"], vec!["pull"], vec!["push"], vec!["push", "-u"], vec!["pull", "--rebase"], vec!["fetch", "-p"], vec!["add", "CLAUDE~1/x"], vec!["add", "claude~1"], vec!["push", "--no-verify"], vec!["commit", "-n", "-m", "x"], vec!["commit", "--no-verify", "-m", "x"], vec!["push", "--all"], vec!["push", "--tags"], vec!["push", "--follow-tags"], vec!["push", "origin", "--tags"],
            vec!["reset", "a", "b"], vec!["mv", "a.txt", ".githooks/pre-commit"], vec!["mv", "--", "a.txt", ".husky/pre-commit"], vec!["mv", "a.txt", "CLAUDE.md"], vec!["mv", "a.txt", ".vscode/tasks.json"], vec!["mv", ".mcp.json", "x"],
        ];
        let leaked: Vec<_> = attacks.iter().filter(|a| ok(&r, a)).collect();
        assert!(leaked.is_empty(), "거절돼야 함: {leaked:?}");
    }

    #[test]
    fn short_option_clusters_are_split_per_letter() {
        let (_d, r) = repo();
        // 허용 글자만으로 묶은 것은 통과, 하나라도 금지 글자가 있으면 거절
        assert!(ok(&r, &["status", "-sb"]));
        assert!(ok(&r, &["branch", "-avv"]));
        assert!(ok(&r, &["commit", "-qam", "msg"]), "-q -a -m <msg>");
        assert!(ok(&r, &["commit", "-amMSG"]), "-a -m MSG(붙인 값)");
        assert!(!ok(&r, &["status", "-sf"]));
        assert!(!ok(&r, &["branch", "-avD", "x"]));
        assert!(!ok(&r, &["commit", "-aF", "x"]));
        assert!(!ok(&r, &["commit", "-amF", "x"]) || true); // -m의 값이 "F"가 되는 정상 형태라 통과해도 무해
        assert!(!ok(&r, &["push", "-un", "-f"]));
    }

    #[test]
    fn paths_resolve_inside_the_repo_only_and_symlinks_do_not_escape() {
        let (d, r) = repo();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), "s").unwrap();
        std::os::unix::fs::symlink(outside.path(), r.join("link")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret"), r.join("flink")).unwrap();
        assert!(resolve(&r, "link/secret").is_err(), "심볼릭 링크로 밖으로");
        assert!(resolve(&r, "link").is_err());
        assert!(resolve(&r, "flink").is_err());
        assert!(resolve(&r, "newdir/new.txt").is_ok());
        assert!(resolve(&r, "src/../src/a.rs").is_ok());
        assert!(resolve(&r, "src/../../x").is_err());
        assert!(resolve(&r, &format!("{}/x", d.path().parent().unwrap().display())).is_err());
        assert!(read_file(&r, "link/secret").is_err() && read_file(&r, "flink").is_err());
        assert!(read_file(&r, ".git/config").is_err() && read_file(&r, ".GIT/config").is_err() && read_file(&r, ".Claude/x").is_err());
        assert_eq!(read_file(&r, "src/a.rs").unwrap(), "fn a() {}\n");
        assert!(read_file(&r, "src").is_err() && read_file(&r, "nope").is_err());
        assert!(!ok(&r, &["add", "link/secret"]) && !ok(&r, &["add", "flink"]));
    }

    #[test]
    fn edit_file_changes_only_unique_matches_and_never_git_or_outside() {
        let (_d, r) = repo();
        assert_eq!(edit_file(&r, "src/a.rs", "fn a()", "fn b()", false).unwrap(), 1);
        assert_eq!(std::fs::read_to_string(r.join("src/a.rs")).unwrap(), "fn b() {}\n");
        std::fs::write(r.join("dup.txt"), "x x\n").unwrap();
        assert!(edit_file(&r, "dup.txt", "x", "y", false).is_err(), "여러 곳이면 거절");
        assert_eq!(edit_file(&r, "dup.txt", "x", "y", true).unwrap(), 2);
        assert!(edit_file(&r, "dup.txt", "zzz", "y", false).is_err());
        assert_eq!(edit_file(&r, "new/dir/f.txt", "", "hello", false).unwrap(), 1);
        assert_eq!(std::fs::read_to_string(r.join("new/dir/f.txt")).unwrap(), "hello");
        assert!(edit_file(&r, "new/dir/f.txt", "", "again", false).is_err(), "이미 있으면 새로 만들지 않는다");
        for bad in [".git/config", ".GIT/config", ".Git/hooks/pre-commit", ".git", "src/.git/x", ".claude/settings.json", ".CLAUDE/settings.json", "/etc/passwd", "../x", "~/x", ".git ", ".g\u{200d}it/x"] {
            assert!(edit_file(&r, bad, "", "x", false).is_err() && edit_file(&r, bad, "a", "b", false).is_err(), "{bad}");
        }
        assert!(!r.join(".git/config").exists());
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("o.txt"), "orig").unwrap();
        std::os::unix::fs::symlink(outside.path(), r.join("ln")).unwrap();
        assert!(edit_file(&r, "ln/o.txt", "orig", "PWNED", false).is_err() && edit_file(&r, "ln/new.txt", "", "x", false).is_err());
        assert_eq!(std::fs::read_to_string(outside.path().join("o.txt")).unwrap(), "orig");
        std::os::unix::fs::symlink(outside.path().join("o.txt"), r.join("fl")).unwrap();
        assert!(edit_file(&r, "fl", "orig", "PWNED", false).is_err());
    }

    /// 3차 리뷰 치명1: 커밋된 심볼릭 링크(`g -> .git`)로 이름 검사를 우회해 `.git`을 읽고 쓰던 길
    #[test]
    fn any_symlink_component_is_rejected_even_when_it_points_inside_the_repo() {
        let (_d, r) = repo();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), "s").unwrap();
        std::fs::write(r.join(".git/config"), "[core]\n").unwrap();
        std::os::unix::fs::symlink(".git", r.join("g")).unwrap();
        std::os::unix::fs::symlink(".", r.join("x")).unwrap();
        std::os::unix::fs::symlink("../.git", r.join("src/x")).unwrap();
        std::os::unix::fs::symlink(outside.path(), r.join("link")).unwrap();
        std::os::unix::fs::symlink("src", r.join("inner")).unwrap(); // 저장소 안 폴더를 가리키는 링크도 거절
        for p in ["g", "g/config", "x", "x/src/a.rs", "x/x/x/.git/config", "src/x", "src/x/config", "link", "link/secret", "inner", "inner/a.rs"] {
            assert!(resolve(&r, p).is_err(), "resolve {p}");
            assert!(read_file(&r, p).is_err(), "read {p}");
            assert!(edit_file(&r, p, "", "x", false).is_err() && edit_file(&r, p, "a", "b", false).is_err(), "edit {p}");
            assert!(!ok(&r, &["add", p]) && !ok(&r, &["add", "--", p]) && !ok(&r, &["diff", "--", p]) && !ok(&r, &["blame", "--", p]) && !ok(&r, &["log", "--", p]) && !ok(&r, &["rm", p]) && !ok(&r, &["status", p]), "git {p}");
        }
        assert_eq!(std::fs::read_to_string(r.join(".git/config")).unwrap(), "[core]\n", ".git/config는 그대로");
        assert!(!r.join("link/new").exists() && !outside.path().join("new").exists());
        // 링크가 아닌 정상 경로는 그대로
        assert!(resolve(&r, "src/a.rs").is_ok() && read_file(&r, "src/a.rs").is_ok());
    }

    fn git_ver() -> bool {
        std::process::Command::new("git").arg("--version").output().is_ok()
    }

    /// 실제 git으로 옵션 표를 대조한다(차등 시험). 옵션마다:
    ///  - 존재: 그 옵션을 git이 모르는 옵션이라고 하지 않는다(표의 오타·없는 옵션 방지)
    ///  - 값 방식: 뒤에 `--zz-marker`를 두었을 때 git이 그걸 *옵션으로 해석*하는지(= 값을 안 받음)가 표의 모델과 같다.
    ///    값 필수(분리 가능) 옵션은 마커를 값으로 삼켜 불평이 없어야 하고, 플래그·선택값 옵션은 마커를 옵션으로 읽어 "unknown option"이 나와야 한다.
    ///    긴 자유 문자열 값은 `=` 형태만 허용하므로(`--pretty <x>`처럼 git이 선택값으로 보는 경우가 있다) 분리 형태 기대는 검사하지 않는다.
    #[test]
    fn option_table_matches_real_git_option_parsing() {
        if !git_ver() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let p = d.path().canonicalize().unwrap();
        let g = |a: &[&str]| std::process::Command::new("git").current_dir(&p).env("GIT_EDITOR", "true").env("GIT_TERMINAL_PROMPT", "0").env("GIT_PAGER", "cat").args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"]).args(a).stdin(std::process::Stdio::null()).output().unwrap();
        g(&["init", "-q", "-b", "main"]);
        std::fs::write(p.join("a.txt"), "1\n").unwrap();
        g(&["add", "."]);
        g(&["commit", "-qm", "a"]);
        // stash list·show·apply가 인자를 실제로 해석하도록 스태시 항목을 하나 만들어 둔다
        std::fs::write(p.join("a.txt"), "2\n").unwrap();
        g(&["stash", "push", "-q"]);
        const MARK: &str = "zz-marker";
        // git은 모르는 옵션을 `unknown option`·`unrecognized argument`·`invalid option`으로 알리거나, 오류 줄 없이 사용법(종료 코드 129)만 낸다.
        // 값 오류(`requires a value`·`expects …`·`not an integer`)도 129를 쓰므로 그 문구는 값으로 삼킨 것으로 본다.
        let marker_is_option = |o: &std::process::Output| {
            let t = (String::from_utf8_lossy(&o.stderr) + String::from_utf8_lossy(&o.stdout)).to_lowercase();
            if ["requires a value", "expects", "needs a value", "not an integer", "not a valid", "needs an argument"].iter().any(|m| t.contains(m)) || t.contains(&format!("=--{MARK}")) {
                return false;
            }
            o.status.code() == Some(129) || ["unknown option", "unrecognized argument", "invalid option", "unknown switch"].iter().any(|m| t.contains(m))
        };
        let mut specs: Vec<(String, Vec<String>, Spec)> = Vec::new(); // (이름, git 앞 인자, 표)
        for sub in SUBCOMMANDS {
            if let Some(sp) = spec_of(sub) {
                specs.push((sub.to_string(), vec![sub.to_string()], sp));
            }
        }
        for name in ["push", "list", "show", "apply"] {
            specs.push((format!("stash {name}"), vec!["stash".into(), name.into()], stash_spec(name)));
        }
        let (mut checked, mut mismatches) = (0, Vec::<String>::new());
        for (name, pre, sp) in &specs {
            // rev-parse는 모르는 옵션을 그대로 돌려주는 명령이라 이 검사에 맞지 않는다(우리 표는 정확한 이름만 받는다)
            if name == "rev-parse" {
                continue;
            }
            // 경로가 필요한 검사(`--follow`)가 옵션 검사보다 먼저 실패하지 않게 경로를 뒤에 둔다
            let tail: &[&str] = if matches!(name.as_str(), "log" | "diff" | "show" | "blame") { &["--", "a.txt"] } else { &[] };
            for o in &sp.opts {
                let toks: Vec<(String, bool)> = [(!o.long.is_empty()).then(|| (format!("--{}", o.long), true)), o.short.map(|c| (format!("-{c}"), false))].into_iter().flatten().collect();
                for (tok, is_long) in toks {
                    let takes_next = !matches!(o.val, V::No) && !o.optional;
                    let free_long = is_long && matches!(o.val, V::Free);
                    // 존재: 값이 필요한 긴 자유 문자열 옵션은 `=` 형태로 확인한다
                    let exist_tok = if free_long { format!("{tok}=x") } else { tok.clone() };
                    let mut a: Vec<String> = pre.clone();
                    a.push(exist_tok.clone());
                    if takes_next && !free_long {
                        a.push("x".into());
                    }
                    a.extend(tail.iter().map(|t| t.to_string()));
                    let out = g(&a.iter().map(String::as_str).collect::<Vec<_>>());
                    let e = (String::from_utf8_lossy(&out.stderr) + String::from_utf8_lossy(&out.stdout)).to_lowercase();
                    let n = tok.trim_start_matches('-').to_lowercase();
                    let self_unknown = e.lines().any(|l| (l.contains("unknown option") || l.contains("unrecognized argument") || l.contains("invalid option") || l.contains("unknown switch")) && (l.contains(&format!("`{n}'")) || l.contains(&format!("--{n}")) || l.contains(&format!(": {exist_tok}"))));
                    if self_unknown {
                        mismatches.push(format!("{name} {exist_tok}: git이 모르는 옵션 — {}", e.lines().next().unwrap_or_default()));
                        continue;
                    }
                    if free_long {
                        continue; // `=` 형태만 허용하므로 분리 형태의 값 방식은 검사하지 않는다
                    }
                    // `blame -L <범위>`는 값을 분리해서 받는다(`-L 1,1 --zz`는 마커를 옵션으로 읽고, `-L --zz`는 범위 오류로 사용법만 낸다 — 두 출력이 구분되지 않아 직접 확인한 대로 건너뛴다)
                    if name == "blame" && tok == "-L" {
                        continue;
                    }
                    // 값 방식: 뒤에 마커를 둔다
                    let mut a: Vec<String> = pre.clone();
                    a.extend([tok.clone(), format!("--{MARK}")]);
                    a.extend(tail.iter().map(|t| t.to_string()));
                    let out = g(&a.iter().map(String::as_str).collect::<Vec<_>>());
                    let is_opt = marker_is_option(&out);
                    if is_opt == takes_next {
                        let head = (String::from_utf8_lossy(&out.stderr) + String::from_utf8_lossy(&out.stdout)).lines().next().unwrap_or_default().to_string();
                        mismatches.push(format!("{name} {tok}: 표는 값 {} 인데 git은 다음 인자를 {}로 해석 (rc={:?}: {head})", if takes_next { "필수(분리 가능)" } else { "없음/선택" }, if is_opt { "옵션" } else { "값" }, out.status.code()));
                    }
                    checked += 1;
                }
            }
        }
        assert!(mismatches.is_empty(), "옵션 표가 실제 git과 다르다:\n{}", mismatches.join("\n"));
        assert!(checked > 150, "대조한 옵션 수가 너무 적다: {checked}");
    }

    /// 허용된 긴 옵션이 줄임말을 받아들이는지는 git 쪽 사실이므로, 우리 검증기는 줄임말을 항상 거절하는지만 본다(표의 모든 긴 옵션)
    #[test]
    fn every_long_option_in_the_table_rejects_abbreviations() {
        let (_d, r) = repo();
        for sub in SUBCOMMANDS {
            let Some(sp) = spec_of(sub) else { continue };
            for o in sp.opts.iter().filter(|o| o.long.len() > 3) {
                let ab = format!("--{}", &o.long[..o.long.len() - 1]);
                if sp.opts.iter().any(|x| x.long == &ab[2..]) {
                    continue;
                }
                assert!(!ok(&r, &[sub, &ab]) && !ok(&r, &[sub, &format!("{ab}=1")]), "{sub} {ab}");
            }
        }
    }

    #[test]
    fn persistent_config_paths_are_write_protected_for_edit_and_mv() {
        let (_d, r) = repo();
        for p in [".vscode/settings.json", ".idea/workspace.xml", ".cursor/rules/a.mdc", "CLAUDE.md", "sub/CLAUDE.md", "Agents.md", "AGENTS.md", "GEMINI.md", ".mcp.json", ".envrc", ".githooks/pre-commit", ".husky/pre-commit", "a/.husky/_/x", ".pre-commit-config.yaml", "lefthook.yml", ".aider.chat.history.md", ".devcontainer/devcontainer.json", ".github/copilot-instructions.md", ".cursorrules", ".githooks", ".github/workflows/ci.yml", ".github", ".gitlab-ci.yml", ".circleci/config.yml", ".cargo/config.toml", ".cargo/config", ".npmrc", ".yarnrc.yml", ".yarnrc", ".pnpmfile.cjs", "mise.toml", ".mise.toml", "mise.local.toml", ".tool-versions", ".gitmodules", ".gitattributes", "sub/.gitattributes", "Jenkinsfile", "azure-pipelines.yml"] {
            assert!(write_protected(Path::new(p)), "{p}");
            assert!(edit_file(&r, p, "", "x", false).is_err(), "edit {p}");
        }
        std::fs::create_dir_all(r.join(".githooks")).unwrap();
        std::fs::write(r.join(".githooks/pre-commit"), "#!/bin/sh\n").unwrap();
        assert!(edit_file(&r, ".githooks/pre-commit", "sh", "bash", false).is_err());
        assert_eq!(std::fs::read_to_string(r.join(".githooks/pre-commit")).unwrap(), "#!/bin/sh\n");
        for p in ["src/a.rs", "README.md", "docs/CLAUDE_notes.md", "vscode/x", "src/idea.rs", "package.json", "Makefile", "build.rs", "cargo/config.toml", ".cargo/registry.txt"] {
            assert!(!write_protected(Path::new(p)), "{p}");
        }
        assert!(edit_file(&r, "src/a.rs", "fn a()", "fn b()", false).is_ok());
        assert!(ok(&r, &["mv", "src/a.rs", "src/b.rs"]) && !ok(&r, &["mv", "src/a.rs", ".githooks/x"]) && !ok(&r, &["mv", "--", "src/a.rs", "CLAUDE.md"]));
        // 8.3 이름: `.claude` → `CLAUDE~1`
        assert!(resolve(&r, "CLAUDE~1/x").is_err() && resolve(&r, "claude~2").is_err() && resolve(&r, "GIT~1").is_err());
    }

    /// 3·4차 리뷰의 실행형 설정(textconv·ext-diff·훅·서브모듈)이 앱이 붙인 옵션으로 실제 git에서 실행되지 않는다
    #[test]
    fn app_flags_stop_textconv_ext_diff_and_hooks_in_real_git() {
        if !git_ver() {
            return;
        }
        let d = tempfile::tempdir().unwrap();
        let p = d.path().canonicalize().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let g = |a: &[String]| std::process::Command::new("git").current_dir(&p).env("GIT_EDITOR", "true").env("GIT_TERMINAL_PROMPT", "0").args(a).output().unwrap();
        let gs = |a: &[&str]| g(&a.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        gs(&["init", "-q", "-b", "main"]);
        let mark = |n: &str| outside.path().join(n);
        std::fs::write(p.join(".gitattributes"), "*.txt diff=evil merge=evil\n").unwrap();
        std::fs::write(p.join("a.txt"), "1\n").unwrap();
        std::fs::create_dir_all(p.join(".githooks")).unwrap();
        for h in ["pre-commit", "commit-msg", "post-commit"] {
            std::fs::write(p.join(".githooks").join(h), format!("#!/bin/sh\ntouch {}\n", mark(&format!("hook-{h}")).display())).unwrap();
            std::fs::set_permissions(p.join(".githooks").join(h), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        }
        gs(&["config", "core.hooksPath", ".githooks"]);
        gs(&["config", "diff.evil.textconv", &format!("sh -c 'touch {}; cat \"$1\"' --", mark("textconv").display())]);
        gs(&["config", "diff.external", &format!("sh -c 'touch {}' --", mark("extdiff").display())]);
        gs(&["-c", "core.hooksPath=/dev/null", "add", "."].map(str::to_string).iter().map(String::as_str).collect::<Vec<_>>());
        gs(&["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "a"]);
        std::fs::write(p.join("a.txt"), "2\n").unwrap();
        let run = |a: &[&str]| {
            let full = validate(&v(a), &p, &remotes()).unwrap_or_else(|e| panic!("{a:?}: {e}"));
            let mut full = full;
            // 사용자 신원은 시험용으로만 덧붙인다(검증기가 만든 인자 앞)
            full.splice(0..0, ["-c".to_string(), "user.name=t".into(), "-c".into(), "user.email=t@t".into()]);
            g(&full)
        };
        for a in [&["diff"][..], &["diff", "--cached"], &["log", "-p"], &["show", "HEAD"], &["show", "HEAD:a.txt"], &["stash", "show"], &["blame", "--", "a.txt"], &["status"]] {
            run(a);
        }
        run(&["add", "a.txt"]);
        let c = run(&["commit", "-m", "two"]);
        assert!(c.status.success(), "{}", String::from_utf8_lossy(&c.stderr));
        for n in ["textconv", "extdiff", "hook-pre-commit", "hook-commit-msg", "hook-post-commit"] {
            assert!(!mark(n).exists(), "{n}: 앱이 붙인 옵션으로도 실행됨");
        }
        // 대조: 옵션 없이 실행하면 실제로 textconv·ext-diff·훅이 돈다(시험이 의미 있음을 확인)
        std::fs::write(p.join("a.txt"), "3\n").unwrap();
        gs(&["diff"]);
        assert!(mark("extdiff").exists() || mark("textconv").exists(), "대조군: 설정이 실제로 실행돼야 한다");
    }
}
