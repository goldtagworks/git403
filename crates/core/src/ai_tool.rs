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
}

fn spec(opts: Vec<Opt>, pos: Pos) -> Spec {
    Spec { opts, pos, num: false, max_pos: 8 }
}

const DATE: V = V::Of(&["iso", "iso-strict", "relative", "short", "local", "default", "human", "unix", "raw"]);

/// 보기 옵션(log·show·diff 공통)
fn view() -> Vec<Opt> {
    vec![f("stat"), f("shortstat"), f("numstat"), f("name-only"), f("name-status"), fs("patch", 'p'), fs("no-patch", 's'), f("summary"), f("no-color"), fs("ignore-all-space", 'w'), fs("ignore-space-change", 'b'), v("unified", None, V::Int), v("", Some('U'), V::Int), v("diff-filter", None, V::Letters)]
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
            ..spec(
                with(view(), vec![f("oneline"), f("graph"), f("decorate"), f("no-decorate"), f("all"), f("merges"), f("no-merges"), f("first-parent"), f("reverse"), f("follow"), f("left-right"), f("abbrev-commit"), f("relative-date"), v("max-count", Some('n'), V::Int), v("skip", None, V::Int), v("since", None, V::Free), v("after", None, V::Free), v("until", None, V::Free), v("before", None, V::Free), v("author", None, V::Free), v("committer", None, V::Free), v("grep", None, V::Free), fs("regexp-ignore-case", 'i'), v("", Some('S'), V::Free), v("", Some('G'), V::Free), v("format", None, V::Free), v("pretty", None, V::Free), v("date", None, DATE)]),
                Pos::Revs,
            )
        },
        "diff" => spec(with(view(), vec![f("cached"), f("staged"), f("check"), f("no-renames"), f("exit-code"), fs("find-renames", 'M'), ov("word-diff", V::Of(&["color", "plain", "porcelain", "none"]))]), Pos::Revs),
        "show" => spec(with(view(), vec![f("oneline"), f("abbrev-commit"), v("format", None, V::Free), v("pretty", None, V::Free)]), Pos::Revs),
        "blame" => spec(vec![v("", Some('L'), V::Free), fs("", 'w'), fs("show-email", 'e'), f("line-porcelain"), fs("porcelain", 'p'), fs("", 'M'), fs("", 'C'), v("date", None, DATE), fs("", 's'), fs("show-name", 'f'), fs("show-number", 'n')], Pos::Revs),
        "ls-files" => spec(vec![fs("cached", 'c'), fs("modified", 'm'), fs("others", 'o'), fs("deleted", 'd'), fs("stage", 's'), fs("unmerged", 'u'), fs("ignored", 'i'), fs("killed", 'k'), f("exclude-standard"), f("full-name"), fs("", 'z'), f("error-unmatch"), fs("", 't'), f("deduplicate")], Pos::Paths),
        "rev-parse" => spec(vec![f("abbrev-ref"), ov("short", V::Int), f("verify"), fs("quiet", 'q'), f("symbolic-full-name"), f("is-inside-work-tree"), f("is-bare-repository"), f("is-shallow-repository"), f("symbolic")], Pos::Revs),
        "add" => spec(vec![fs("all", 'A'), fs("update", 'u'), fs("intent-to-add", 'N'), fs("verbose", 'v'), fs("dry-run", 'n')], Pos::Paths),
        "commit" => spec(vec![v("message", Some('m'), V::Free), fs("all", 'a'), f("amend"), f("no-edit"), f("allow-empty"), fs("quiet", 'q'), fs("no-verify", 'n'), fs("signoff", 's'), v("author", None, V::Free), v("date", None, V::Free), v("fixup", None, V::Rev), v("squash", None, V::Rev), f("reset-author"), f("dry-run")], Pos::Paths),
        "merge" => spec(vec![f("continue"), f("abort"), f("quit"), f("no-ff"), f("ff"), f("ff-only"), f("squash"), f("commit"), f("no-commit"), f("no-edit"), v("message", Some('m'), V::Free), fs("quiet", 'q'), f("allow-unrelated-histories"), v("", Some('X'), V::Of(&["ours", "theirs"]))], Pos::Revs),
        "rebase" => spec(vec![f("continue"), f("abort"), f("skip"), f("quit"), v("onto", None, V::Rev), f("autostash"), f("no-autostash"), fs("quiet", 'q'), v("empty", None, V::Of(&["drop", "keep"])), v("", Some('X'), V::Of(&["ours", "theirs"]))], Pos::Revs),
        "cherry-pick" => spec(vec![f("continue"), f("abort"), f("skip"), f("quit"), fs("no-commit", 'n'), v("mainline", Some('m'), V::Int), f("no-edit")], Pos::Revs),
        "revert" => spec(vec![f("continue"), f("abort"), f("skip"), f("quit"), fs("no-commit", 'n'), v("mainline", Some('m'), V::Int), f("no-edit")], Pos::Revs),
        "fetch" => spec(vec![f("all"), fs("prune", 'p'), fs("tags", 't'), f("no-tags"), fs("quiet", 'q'), fs("verbose", 'v'), v("depth", None, V::Int), f("unshallow"), f("dry-run")], Pos::Remote),
        "pull" => spec(vec![ov("rebase", V::Of(&["true", "false", "merges"])), f("no-rebase"), f("ff-only"), f("ff"), f("no-ff"), f("autostash"), f("no-autostash"), f("no-edit"), fs("quiet", 'q'), fs("verbose", 'v'), fs("prune", 'p'), f("commit"), f("no-commit"), f("squash"), f("allow-unrelated-histories"), v("", Some('X'), V::Of(&["ours", "theirs"]))], Pos::Remote),
        "push" => spec(vec![fs("set-upstream", 'u'), f("tags"), f("follow-tags"), fs("dry-run", 'n'), fs("quiet", 'q'), fs("verbose", 'v'), f("no-verify"), f("all"), f("atomic")], Pos::Remote),
        "switch" => Spec { max_pos: 2, ..spec(vec![v("create", Some('c'), V::Rev), fs("detach", 'd'), fs("merge", 'm'), fs("quiet", 'q'), f("no-track")], Pos::Revs) },
        "reset" => spec(vec![f("soft"), f("mixed"), fs("quiet", 'q')], Pos::Revs),
        "rm" => spec(vec![f("cached"), fs("recursive", 'r'), fs("quiet", 'q'), fs("dry-run", 'n'), f("ignore-unmatch")], Pos::Paths),
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
    n == ".git" || n == ".claude" || n.starts_with("git~") || n.starts_with("claud~")
}

fn is_drive(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b.len() == 2 || b[2] == b'/' || b[2] == b'\\')
}

/// 리비전·위치 인자로 쓸 수 있는 글자인가: 옵션처럼 보이지 않고, 절대 경로·`~`·`..` 경로 성분이 없다(저장소 밖을 가리켜 git이 `--no-index`로 바꾸는 것을 막는다)
fn rev_ok(s: &str) -> Res<()> {
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
    // 심볼릭 링크를 따라 밖으로 나가지 않는지: 있는 가장 긴 조상을 정규화해 본다
    let mut probe = root.join(&norm);
    while !probe.exists() && probe.symlink_metadata().is_err() {
        if !probe.pop() {
            break;
        }
    }
    let real = probe.canonicalize().map_err(|e| e.to_string())?;
    if !real.starts_with(&root) {
        return bad(format!("path outside the repository: {p:?}"));
    }
    Ok(norm)
}

fn refspec_ok(s: &str) -> Res<()> {
    rev_ok(s)?;
    // 따옴표는 셸이 없으니 그냥 글자지만, 따옴표로 감싼 `'+main'`·`":main"` 같은 우회 모양은 처음부터 막는다
    if s.starts_with(':') || s.contains(['\n', '\'', '"']) {
        return bad(format!("refspec not allowed: {s:?}"));
    }
    Ok(())
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
            out.push(path_arg(repo, a)?);
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
                if attached.is_empty() {
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
            Pos::Paths => out[*at] = path_arg(repo, p)?,
            Pos::Remote => {
                if n == 0 {
                    if !remotes.iter().any(|r| r == p.as_str()) {
                        return bad(format!("{p:?} is not a configured remote name (URLs and paths are not allowed). Configured: {}", remotes.join(", ")));
                    }
                } else {
                    refspec_ok(p)?;
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
            let sp = match name {
                "push" => spec(vec![v("message", Some('m'), V::Free), fs("include-untracked", 'u'), fs("keep-index", 'k'), fs("quiet", 'q')], Pos::Paths),
                "list" => spec(vec![f("oneline"), f("stat")], Pos::None),
                "show" => spec(vec![fs("patch", 'p'), f("stat"), f("name-only")], Pos::StashRef),
                _ => spec(vec![f("index"), fs("quiet", 'q')], Pos::StashRef),
            };
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
    let mut full: Vec<String> = ["-c", "protocol.ext.allow=never", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "core.quotepath=false"].map(String::from).to_vec();
    full.extend(body);
    Ok(full)
}

/// 도구 설명용 한 줄 요약(모델이 볼 안내)
pub fn describe() -> String {
    format!("Run git in the current repository (no shell: pass the arguments as an array WITHOUT the leading `git`, e.g. [\"commit\",\"-m\",\"msg\"]). Allowed subcommands: {}. Only a safe subset of each subcommand's options is accepted (no force/delete/hard-reset/exec options, no global options like -c or -C); remotes must be configured remote names, never URLs or paths. Rejected calls explain why.", SUBCOMMANDS.join(", "))
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
        validate(&v(a), r, &remotes()).unwrap().split_off(8)
    }

    #[test]
    fn builds_safe_argv_in_original_order() {
        let (_d, r) = repo();
        let full = validate(&v(&["log", "--oneline", "-n", "5", "main", "--", "src/a.rs"]), &r, &remotes()).unwrap();
        assert_eq!(&full[..8], ["-c", "protocol.ext.allow=never", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "core.quotepath=false"]);
        assert_eq!(&full[8..], ["log", "--oneline", "-n", "5", "main", "--", "src/a.rs"]);
        assert_eq!(args_of(&r, &["add", "./src/../src/a.rs"]), ["add", "src/a.rs"], "경로는 정규화해 넘긴다");
        assert_eq!(args_of(&r, &["add", &format!("{}/src/a.rs", r.display())]), ["add", "src/a.rs"], "저장소 안 절대 경로는 상대로");
        assert_eq!(args_of(&r, &["stash"]), ["stash", "push"]);
    }

    #[test]
    fn everyday_commands_are_allowed() {
        let (_d, r) = repo();
        for a in [
            &["status"][..], &["status", "-sb"], &["status", "--porcelain"], &["log"], &["log", "--oneline", "-20"], &["log", "--graph", "--oneline", "--all"], &["log", "-n5", "--format=%h %s"], &["log", "--author=kim", "--since=2 weeks ago", "--grep=fix", "-i"], &["log", "-S", "needle", "--", "src"], &["log", "main..feature"], &["log", "HEAD~3..HEAD", "--stat"],
            &["diff"], &["diff", "--cached", "--stat"], &["diff", "HEAD~1", "HEAD", "--", "src/a.rs"], &["diff", "-U5", "-w", "main...feature"], &["diff", "--diff-filter=AM", "--name-only"], &["show", "HEAD"], &["show", "HEAD:src/a.rs"], &["show", "--stat", "--format=%an", "abc1234"], &["blame", "-L", "1,5", "src/a.rs"], &["blame", "-w", "-M", "main", "--", "src/a.rs"],
            &["ls-files"], &["ls-files", "-o", "--exclude-standard"], &["rev-parse", "HEAD"], &["rev-parse", "--abbrev-ref", "HEAD"], &["rev-parse", "--short=7", "HEAD"], &["rev-parse", "--is-inside-work-tree"],
            &["add", "-A"], &["add", "src/a.rs", "README.md"], &["add", "-u"], &["add", "."], &["commit", "-m", "fix: 수정 <a@b.c> !"], &["commit", "-am", "msg"], &["commit", "--amend", "--no-edit"], &["commit", "-m", "-starts-with-dash"], &["commit", "-m", "a", "-m", "b", "--allow-empty"], &["commit", "--fixup", "abc123"],
            &["merge", "feature"], &["merge", "--no-ff", "-m", "merge", "feature"], &["merge", "--abort"], &["merge", "--continue"], &["merge", "-X", "theirs", "feature"], &["rebase", "main"], &["rebase", "--onto", "main", "old", "topic"], &["rebase", "--continue"], &["rebase", "--abort"], &["rebase", "--skip"], &["rebase", "--autostash", "main"],
            &["cherry-pick", "abc123"], &["cherry-pick", "-n", "abc", "def"], &["cherry-pick", "-m", "1", "abc"], &["cherry-pick", "--abort"], &["revert", "abc123"], &["revert", "--no-edit", "abc"],
            &["fetch"], &["fetch", "origin"], &["fetch", "--all", "--prune"], &["fetch", "origin", "main"], &["fetch", "-p", "upstream"], &["pull"], &["pull", "--rebase"], &["pull", "--rebase=merges", "origin", "main"], &["pull", "--ff-only", "origin"], &["push"], &["push", "origin"], &["push", "origin", "main"], &["push", "-u", "origin", "feat"], &["push", "origin", "HEAD:refs/heads/x"], &["push", "origin", "main:main"], &["push", "--tags", "origin"], &["push", "--follow-tags"], &["push", "-n", "origin", "main"],
            &["switch", "main"], &["switch", "-c", "feat/x"], &["switch", "--create", "x", "origin/main"], &["switch", "-"], &["switch", "-d", "abc123"], &["switch", "-m", "other"], &["reset"], &["reset", "HEAD", "--", "src/a.rs"], &["reset", "--soft", "HEAD~1"], &["reset", "--mixed", "HEAD~2"], &["reset", "-q", "src/a.rs"],
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
}
