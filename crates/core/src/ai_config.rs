//! AI 채팅 시작 전·도구 호출마다 **저장소 쪽 git 설정을 허용 목록으로 판정**한다(docs/security.md "저장소는 신뢰하지 않는다").
//! 판정 대상: 상위 저장소의 local·worktree 설정(include 포함), 공통 git 폴더의 `modules/**/config`(서브모듈), `worktrees/*/config.worktree`,
//! 그리고 `rev-parse`가 알려 주는 최상위 폴더·git 폴더(core.worktree·꾸며 낸 `.git` 파일로 저장소 밖을 가리키는지).
//! 모든 키가 아래 안전 목록에 있어야 "깨끗함". 목록 밖 키는 `review`(사용자 확인 필요, 키 이름 표시),
//! 확인으로도 허용할 수 없는 것(`refuse`: 저장소 밖 worktree·bare·mirror·비기본 fetch/push refspec·백업 이름공간 언급)은 거절한다.
//! 순수 판정(`judge`)과 git을 실행해 모으는 부분(`check`, 동기 `std::process::Command`)을 나눠, 앱과 MCP 서버가 같은 판정·같은 지문을 쓴다.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Verdict {
    /// 확인으로도 허용할 수 없는 사유(영어, 사용자·모델에게 그대로 보인다)
    pub refuse: Vec<String>,
    /// 안전 목록 밖 키 이름(값 없음, 중복 제거·정렬). 비어 있지 않으면 사용자 확인이 필요하다
    pub review: Vec<String>,
    /// 판정에 쓴 설정 전체(원본 키·값, 출처 포함)의 지문. 앱이 확인한 값과 서버가 호출 때마다 다시 계산한 값이 같아야 한다
    pub fingerprint: String,
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

fn judge_entry(key: &str, value: &str, src: &Source, repo: &Path) -> J {
    // 앱의 백업 이름공간을 가리키는 설정은 키든 값이든 어디서나 거절
    if key.contains("refs/git403") || value.to_ascii_lowercase().contains("refs/git403") {
        return J::Refuse(format!("{key} refers to the app's backup namespace (refs/git403/)"));
    }
    let parts: Vec<&str> = key.split('.').collect();
    let (section, var) = (parts[0], parts[parts.len() - 1]);
    let sub = if parts.len() > 2 { parts[1..parts.len() - 1].join(".") } else { String::new() };
    let truthy = |v: &str| !matches!(v.to_ascii_lowercase().as_str(), "false" | "no" | "off" | "0" | "");
    let ok = |b: bool| if b { J::Safe } else { J::Review };
    match section {
        "core" if parts.len() == 2 => match var {
            "bare" if truthy(value) => J::Refuse("core.bare=true (a bare repository has no working tree to protect)".into()),
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
            "repositoryformatversion" | "bare" | "filemode" | "logallrefupdates" | "ignorecase" | "precomposeunicode" | "symlinks" | "autocrlf" | "eol" | "safecrlf" | "quotepath" | "untrackedcache" | "preloadindex" | "commitgraph" | "sparsecheckout" | "sparsecheckoutcone" | "abbrev" | "hookspath" | "fsmonitor" | "pager" | "longpaths" | "protectntfs" | "protecthfs" => J::Safe,
            _ => J::Review,
        },
        "extensions" => J::Safe,
        "remote" if parts.len() >= 3 => match var {
            "url" | "pushurl" | "prune" | "prunetags" | "promisor" | "partialclonefilter" => J::Safe,
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
            _ => J::Review,
        },
        "branch" if parts.len() >= 3 => ok(matches!(var, "remote" | "merge" | "rebase" | "pushremote" | "description") || var.starts_with("vscode")),
        "user" => ok(matches!(var, "name" | "email" | "signingkey" | "useconfigonly")),
        "init" => ok(var == "defaultbranch"),
        "filter" if parts.len() >= 3 => ok(sub == "lfs" && lfs_standard(key, value)),
        "lfs" => ok(!key.contains("customtransfer") && !key.contains("standalonetransferagent")),
        "submodule" if parts.len() >= 3 => ok(matches!(var, "url" | "active" | "branch" | "path" | "ignore") || (var == "update" && !value.starts_with('!'))),
        "submodule" => J::Safe,
        "pull" | "push" | "rebase" | "color" | "status" | "log" | "gc" | "tag" | "advice" | "i18n" | "include" | "includeif" | "alias" | "url" | "fetch" => {
            // 이름이 알려진 무해한 묶음. 단 파일을 읽거나(`status.*template`…) 프로그램을 가리키는 것은 아래에서 거른다
            if matches!(var, "editor" | "program" | "command" | "cmd" | "helper" | "external" | "textconv" | "driver") { J::Review } else { J::Safe }
        }
        "merge" if parts.len() == 2 => ok(matches!(var, "ff" | "conflictstyle" | "renormalize" | "directoryrenames" | "renames" | "verifysignatures" | "stat")),
        "diff" if parts.len() == 2 => ok(matches!(var, "renames" | "algorithm" | "colormoved" | "context" | "ignoresubmodules" | "mnemonicprefix" | "noprefix")),
        "commit" => ok(var == "gpgsign"),
        "credential" if parts.len() >= 3 => ok(matches!(var, "username" | "usehttppath")),
        "credential" => ok(var == "usehttppath" || (var == "helper" && value.trim().is_empty())),
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
    Verdict { refuse, review, fingerprint: String::new() }
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
    let mut c = Command::new(git);
    c.args(args).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    // 저장소 밖을 가리키는 git 환경 변수는 지운다 (실행 환경은 MCP 서버와 같다)
    for k in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE"] {
        c.env_remove(k);
    }
    c.env("GIT_TERMINAL_PROMPT", "0").env("LC_ALL", "C");
    let o = c.output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).into_owned())
}

/// FNV-1a 64비트
fn fnv(text: &str) -> String {
    format!("{:016x}", text.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)))
}

/// 저장소의 git 설정을 모아 판정한다. `git`은 실행 파일. git을 못 돌리거나 저장소가 아니면 `refuse`.
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
    let mut entries: Vec<(Source, String, String)> = parse_listing(&run(git, repo, &["config", "--list", "--includes", "--show-scope", "-z"]).unwrap_or_default(), true).into_iter().map(|(k, v)| (Source::Top, k, v)).collect();
    // 서브모듈(modules/**/config)·다른 worktree(worktrees/*/config.worktree) 설정 파일
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
    files.sort();
    for f in &files {
        let dir = f.parent().map(Path::to_path_buf).unwrap_or_default();
        let listing = run(git, repo, &["config", "--file", &f.to_string_lossy(), "--list", "--includes", "-z"]).unwrap_or_default();
        entries.extend(parse_listing(&listing, false).into_iter().map(|(k, v)| (Source::Other(dir.clone()), k, v)));
    }
    let mut v = judge(&entries, repo);
    v.refuse.extend(refuse);
    v.refuse.sort();
    v.refuse.dedup();
    let mut raw: Vec<String> = entries.iter().map(|(s, k, val)| format!("{}|{k}={val}", match s { Source::Top => "top".to_string(), Source::Other(d) => d.to_string_lossy().into_owned() })).collect();
    raw.sort();
    v.fingerprint = fnv(&format!("{}\n{}\n{}\n{}", top.trim(), gitdir.display(), common.display(), raw.join("\n")));
    v
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

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
        let clean = e(&[("core.repositoryformatversion", "0"), ("core.filemode", "true"), ("core.bare", "false"), ("core.logallrefupdates", "true"), ("core.ignorecase", "true"), ("core.precomposeunicode", "true"), ("core.autocrlf", "input"), ("remote.origin.url", "https://x/y"), ("remote.origin.pushurl", "https://x/y"), ("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"), ("remote.origin.mirror", "false"), ("remote.origin.push", ""), ("branch.main.remote", "origin"), ("branch.main.merge", "refs/heads/main"), ("branch.feat/x.rebase", "true"), ("user.name", "t"), ("user.email", "t@t"), ("filter.lfs.clean", "git-lfs clean -- %f"), ("filter.lfs.smudge", "git-lfs smudge -- %f"), ("filter.lfs.process", "git-lfs filter-process"), ("filter.lfs.required", "true"), ("lfs.url", "https://l"), ("submodule.sm.url", "../sm"), ("submodule.sm.active", "true"), ("pull.rebase", "true"), ("push.default", "simple"), ("merge.ff", "only"), ("diff.renames", "true"), ("commit.gpgsign", "false"), ("credential.helper", ""), ("url.https://github.com/.insteadof", "gh:"), ("include.path", "x.cfg"), ("extensions.worktreeconfig", "true"), ("alias.st", "status"), ("init.defaultbranch", "main"), ("color.ui", "auto")]);
        let v = judge(&clean, &r);
        assert!(v.refuse.is_empty() && v.review.is_empty(), "{v:?}");
        let review = e(&[("filter.lfs.clean", "sh -c id"), ("filter.x.smudge", "x"), ("core.sshcommand", "x"), ("core.editor", "vim"), ("diff.external", "x"), ("diff.d.textconv", "x"), ("merge.d.driver", "x"), ("credential.helper", "!x"), ("credential.https://h.helper", "!x"), ("gpg.program", "x"), ("gpg.ssh.program", "x"), ("remote.o.uploadpack", "x"), ("remote.o.vcs", "x"), ("remote.o.tagopt", "--no-tags"), ("sequence.editor", "x"), ("trailer.t.command", "x"), ("blame.ignorerevsfile", "/etc/passwd"), ("submodule.sm.update", "!x"), ("lfs.customtransfer.x.path", "x"), ("core.excludesfile", "/x"), ("http.proxy", "x"), ("custom.unknown", "1"), ("pager.log", "x"), ("alias.x", "x"), ("pull.editor", "x")]);
        let v = judge(&review, &r);
        // alias.x는 무해(안전), 나머지는 전부 review
        assert!(v.refuse.is_empty(), "{v:?}");
        for k in ["filter.lfs.clean", "filter.x.smudge", "core.sshcommand", "core.editor", "diff.external", "diff.d.textconv", "merge.d.driver", "credential.helper", "credential.https://h.helper", "gpg.program", "gpg.ssh.program", "remote.o.uploadpack", "remote.o.vcs", "remote.o.tagopt", "sequence.editor", "trailer.t.command", "blame.ignorerevsfile", "submodule.sm.update", "lfs.customtransfer.x.path", "core.excludesfile", "http.proxy", "custom.unknown", "pager.log", "pull.editor"] {
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
}
