//! jj를 저장소에서 떼어 낸다(`jj_disable`): git HEAD를 브랜치로 되돌리고, `refs/jj/*`와 `.jj`를 지운다. 작업 폴더 파일·인덱스·사용자 ref는 건드리지 않는다.
//!
//! 순서(부분 실패해도 git 저장소가 멀쩡하도록): ① git HEAD를 브랜치로(그 시점부터 git은 jj 없이도 완전히 유효) → ② `refs/jj/*` 삭제(jj 전용 ref;
//! 실패해도 남는 건 무해한 ref뿐) → ③ `.jj` 삭제(마지막: 지우다 끊기면 `.jj`가 망가진 채 남지만 git은 이미 정상이고, 다시 disable하면 이어서 지운다).
//! 지우기 전에 snapshot은 하지 않는다: jj CLI에서 `.jj`를 지우는 것(`rm -rf .jj`)도 snapshot 없이 파일을 그대로 두며, snapshot은 지워질 jj 저장소 안에만 기록되어 의미가 없다.
//! 작업 폴더의 미저장 변경은 파일 그대로 남아 git에서 일반 변경(unstaged)으로 보인다.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use gc_i18n::{coded, Coded};
use gix::refs::transaction::{Change, LogChange, PreviousValue, RefEdit, RefLog};
use gix::refs::Target;

use futures::StreamExt as _;
use jj_lib::object_id::ObjectId;
use jj_lib::repo::Repo;
use jj_lib::revset::RevsetExpression;

use crate::{check_root, fail, load, repo_lock, SHORT_CHANGE_ID_LEN};

/// 사용자 ref에서 **안 닿는** 보이는 커밋을 훑는 수 상한: 넘으면 판정할 수 없으니 거절한다(`jj.disableUnknown`). 닿는 커밋 수에는 상한이 없다.
const ORPHAN_SCAN_LIMIT: usize = 100_000;
/// jj가 모르는(마지막 가져오기 뒤 git에서 생긴) 커밋을 조상 방향으로 따라가는 수 상한. 넘으면 거절(`jj.disableUnknown`)
const UNKNOWN_WALK_LIMIT: usize = 100_000;
/// jj 커밋 중 어느 브랜치·태그에서도 닿지 않는 것을 남겨 두는 ref 이름 접두
pub const KEEP_PREFIX: &str = "refs/git403/jj-orphans";

/// 사용자 ref에서 닿지 않는 jj 커밋
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Orphan {
    pub sha: String,
    /// jj change ID 전체(역 hex)
    pub change_id: String,
    pub description: String,
}

/// `jj_disable_check` 결과: 확인창에 보여 줄 것. 아무것도 바꾸지 않고 얻는다.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisableCheck {
    /// 사용자 ref(HEAD·`refs/jj/` 밖)에서 닿지 않는 내용 있는(변경·설명이 있거나 머지인) 보이는 커밋. 설명이 있거나 머지인 `@`도 포함
    pub orphans: Vec<Orphan>,
    /// `@`에 설명이 있다(작업 폴더 파일은 남지만 설명은 git에 없다 — disable이 보존 ref로 남긴다)
    pub working_copy_described: bool,
    /// `@`가 머지다(git HEAD에는 첫 부모만 남는다)
    pub working_copy_merge: bool,
    /// 이 `.jj/repo`를 공유하는 다른 작업 공간 수(0이어야 disable할 수 있다)
    pub other_workspaces: usize,
    /// 판정한 시점의 jj head operation ID(전체 16진수). `disable`에 `expect`로 넘기면 그 사이 jj에서 뭔가 바뀐 경우 거절된다
    pub op_id: String,
}

/// 켜져 있는 jj를 읽어 확인창용 정보를 만든다. 아무것도 바꾸지 않는다(저장소 잠금 안에서 읽기만).
pub fn disable_check(repo_path: &Path) -> Result<DisableCheck, Coded> {
    let root = check_root(repo_path)?;
    require_jj_dir(&root)?;
    let _gate = repo_lock(&root);
    let git = gix::open(&root).map_err(|e| fail("disable-open", e))?;
    analyze(&git, &root)
}

/// `expect_op`(필수): `disable_check`가 돌려준 `op_id`. 16진수 1~128자가 아니면 `jj.badOpId`, 지금 jj head operation과 다르면 `jj.disableChanged`로 거절한다(아무것도 안 바꾼 채).
pub fn disable(repo_path: &Path, expect_op: &str) -> Result<Vec<Coded>, Coded> {
    if expect_op.is_empty() || expect_op.len() > 128 || !expect_op.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(coded!("jj.badOpId", "Invalid operation id: {id}", id = expect_op.chars().take(64).collect::<String>()));
    }
    let root = check_root(repo_path)?;
    let jj = require_jj_dir(&root)?;
    let _gate = repo_lock(&root);
    let git = gix::open(&root).map_err(|e| fail("disable-open", e))?;
    let mut warnings = Vec::new();

    // 0. 판정·계획은 아무것도 바꾸기 전에 끝낸다(거절은 흔적을 남기지 않는다). `.jj`가 남아 있는 동안은 refs/jj가 이미 지워졌어도 jj 저장소로 판정한다.
    let check = if jj.join("repo").exists() { analyze(&git, &root)? } else { DisableCheck::default() };
    if jj.join("repo").exists() && !check.op_id.eq_ignore_ascii_case(expect_op) {
        return Err(coded!("jj.disableChanged", "jj changed since the confirmation; check again"));
    }
    if check.other_workspaces > 0 {
        return Err(coded!("jj.otherWorkspaces", "{count} other workspaces share this jj repository; remove them first", count = check.other_workspaces.to_string()));
    }
    let head = plan_head(&git)?;

    // ① 보존 ref: 어느 브랜치·태그에서도 안 닿는 jj 커밋(설명 있는 `@` 포함)을 지우기 전에 남긴다. 다시 실행해도 이미 남긴 것은 다시 만들지 않는다.
    let created = keep_orphans(&git, &check.orphans).map_err(|e| partial("keep", e))?;
    let total = count_kept(&git);
    if total > 0 {
        warnings.push(coded!(
            "jj.disableKept",
            "{count} jj commits were kept this time ({total} in total) as refs under {prefix}. Recover with: git log --glob='{prefix}/*', then git branch <name> <ref>. jj's operation log, undo and old versions are gone; a conflicted commit shows as .jjconflict-* trees.",
            count = created.to_string(),
            total = total.to_string(),
            prefix = KEEP_PREFIX.to_string()
        ));
    }
    // ② HEAD
    match head {
        HeadPlan::Keep => {}
        HeadPlan::Detached => warnings.push(coded!("jj.disableDetached", "HEAD could not be attached to a branch")),
        HeadPlan::Attach(name) => set_head_symbolic(&git, &name).map_err(|e| partial("HEAD", e))?,
        HeadPlan::Unborn { name, fallback } => {
            set_head_symbolic(&git, &name).map_err(|e| partial("HEAD", e))?;
            if fallback {
                warnings.push(coded!("jj.disableUnbornBranch", "HEAD now points to the new, empty branch {name} because the usual names are taken", name = name.trim_start_matches("refs/heads/").to_string()));
            }
        }
    }
    // ③ refs/jj/*
    delete_jj_refs(&git).map_err(|e| partial("refs/jj", e))?;
    drop(git);
    // ④ .jj
    if let Some(w) = remove_jj_dir(&root, &root.join(".git"))? {
        warnings.push(w);
    }
    Ok(warnings)
}

/// `.jj`를 지운다. 지우기 직전에 다시 확인하고(검사 뒤 링크로 바뀐 경우), 먼저 `<trash_parent>/jj-removing-<nanos>`로 이름을 바꿔 한 번에 "꺼짐"으로 만든 뒤 지운다
/// (지우다 끊겨도 `.jj`는 이미 없어 jj는 꺼진 상태이고 재실행 때 망가진 jj 저장소를 읽을 일이 없다. 기본 위치는 `.git/` 안이라 git status에 안 보인다).
/// 이름 바꾸기가 실패하면(다른 파일시스템 등) 제자리에서 `remove_dir_all`로 지운다(이때도 직전 재확인을 거친다).
/// `remove_dir_all`은 링크를 따라가지 않고 링크 자체만 지우므로, 바꿔치기된 링크여도 밖은 안전하다.
/// 남은 폴더를 지우지 못하면 경고 `jj.disableLeftover`를 돌려준다.
fn remove_jj_dir(root: &Path, trash_parent: &Path) -> Result<Option<Coded>, Coded> {
    let again = require_jj_dir(root).map_err(|e| partial(".jj", e.message))?;
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let trash = trash_parent.join(format!("jj-removing-{nanos}"));
    if fs::rename(&again, &trash).is_ok() {
        return Ok(fs::remove_dir_all(&trash).err().map(|e| {
            coded!("jj.disableLeftover", "jj is off, but the folder {path} could not be fully deleted ({detail}); delete it by hand", path = trash.to_string_lossy().into_owned(), detail = e.to_string())
        }));
    }
    // 이름 바꾸기 실패: 제자리에서 지운다(직전 재확인 한 번 더)
    let again = require_jj_dir(root).map_err(|e| partial(".jj", e.message))?;
    fs::remove_dir_all(&again).map_err(|e| partial(".jj", e))?;
    Ok(None)
}

/// `.jj`가 저장소 루트 바로 아래의 실제 디렉터리(링크 아님)이고 `.jj/repo`가 파일(다른 작업 공간과 저장소 공유)이 아님을 확인하고 그 경로를 돌려준다.
fn require_jj_dir(root: &Path) -> Result<PathBuf, Coded> {
    let jj = root.join(".jj");
    let md = fs::symlink_metadata(&jj).map_err(|_| coded!("jj.notEnabled", "jj is not enabled for this repository"))?;
    let invalid = || coded!("jj.partial", "A .jj entry exists but is not a valid jj workspace");
    if !md.is_dir() {
        return Err(invalid());
    }
    let canon = fs::canonicalize(&jj).map_err(|_| invalid())?;
    if !is_direct_jj_child(&canon, root) {
        return Err(invalid());
    }
    if let Ok(m) = fs::symlink_metadata(jj.join("repo")) {
        if !m.is_dir() {
            return Err(invalid());
        }
    }
    Ok(jj)
}

/// 윈도 `canonicalize`는 `\\?\C:\...` 접두를 붙인다. `check_root`가 정규화한 루트도 같은 방식이라 보통 같지만, 어느 한쪽만 접두가 있어도 맞도록 비교 전에 접두를 뗀다.
pub(crate) fn strip_verbatim(p: &Path) -> String {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\UNC\").map(|r| format!(r"\\{r}")).or_else(|| s.strip_prefix(r"\\?\").map(String::from)).unwrap_or_else(|| s.into_owned())
}

/// `canon_jj`가 `root` 바로 아래의 `.jj`인가(구분자는 `/`·`\` 모두, 접두 무시)
pub(crate) fn is_direct_jj_child(canon_jj: &Path, root: &Path) -> bool {
    let (a, b) = (strip_verbatim(canon_jj), strip_verbatim(root));
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_string();
    let (a, b) = (norm(&a), norm(&b));
    a.strip_prefix(&b).is_some_and(|rest| rest == "/.jj")
}

/// jj 저장소를 읽어 확인창 정보와 보존 대상을 만든다. 판정할 수 없으면 거절(`jj.disableUnknown`).
/// 후보 = jj에서 보이는 커밋 중 사용자 ref(HEAD·`refs/jj/` 밖)에서 안 닿는 것(revset `::visible_heads() ~ ::사용자_ref_tips`, 인덱스로 평가 — 닿는 커밋 수는 상관없다)
/// 중 내용이 있는 것. change ID·설명은 jj에서 얻는다(헤더에 의존하지 않으므로 git으로 만든 뒤 브랜치를 지운 커밋도 잡힌다).
fn analyze(git: &gix::Repository, root: &Path) -> Result<DisableCheck, Coded> {
    let unknown = |reason: &str| coded!("jj.disableUnknown", "Cannot tell which jj commits would be lost: {reason}", reason = reason.to_string());
    let (ws, repo) = load(root).map_err(|e| unknown(&e.message))?;
    let name = ws.workspace_name().to_owned();
    let mut out = DisableCheck {
        other_workspaces: repo.view().wc_commit_ids().len().saturating_sub(1),
        op_id: repo.operation().id().hex(),
        ..Default::default()
    };
    // 사용자 ref tips: HEAD + `refs/jj/` 밖 ref가 가리키는 커밋 중 jj가 아는 것(모르는 커밋은 jj에서 보이는 커밋의 조상일 수 없다)
    let mut tips = Vec::new();
    let mut add_tip = |id: gix::ObjectId| tips.push(id);
    if let Ok(id) = git.head_id() {
        add_tip(id.detach());
    }
    for r in git.references().map_err(|_| unknown("cannot read refs"))?.all().map_err(|_| unknown("cannot read refs"))? {
        let Ok(mut r) = r else { return Err(unknown("cannot read refs")) };
        if r.name().as_bstr().starts_with(b"refs/jj/") {
            continue;
        }
        if let Ok(id) = r.peel_to_id() {
            add_tip(id.detach());
        }
    }
    pollster::block_on(async {
        // jj가 모르는 tip(jj 작업 뒤의 git commit·fetch·브랜치 이동)은 git에서 조상을 따라가 처음 만나는 jj가 아는 커밋들로 바꾼다.
        // 아는 커밋에서는 멈춘다. 모르는 커밋을 훑는 수에 상한을 두고 넘으면 판정할 수 없으니 거절한다.
        let mut tip_ids: Vec<jj_lib::backend::CommitId> = Vec::new();
        let mut seen: std::collections::HashSet<gix::ObjectId> = std::collections::HashSet::new();
        let mut queue: Vec<gix::ObjectId> = tips;
        let mut unknown_walked = 0usize;
        while let Some(t) = queue.pop() {
            if !seen.insert(t) {
                continue;
            }
            let Ok(c) = git.find_commit(t) else { continue }; // 커밋이 아닌 tip(트리·blob을 가리키는 태그)은 무시
            let id = jj_lib::backend::CommitId::from_bytes(t.as_bytes());
            if repo.index().has_id(&id).await.unwrap_or(false) {
                tip_ids.push(id);
                continue;
            }
            unknown_walked += 1;
            if unknown_walked > UNKNOWN_WALK_LIMIT {
                return Err(unknown("too many commits made outside jj since its last import"));
            }
            queue.extend(c.parent_ids().map(|p| p.detach()));
        }
        let visible = RevsetExpression::visible_heads().ancestors();
        let reachable = RevsetExpression::commits(tip_ids).ancestors();
        let revset = visible.minus(&reachable).evaluate(&*repo).map_err(|e| unknown(&e.to_string()))?;
        let wc_id = repo.view().get_wc_commit_id(&name).cloned();
        if let Some(w) = &wc_id {
            let wc = repo.store().get_commit_async(w).await.map_err(|e| unknown(&e.to_string()))?;
            out.working_copy_described = !wc.description().trim().is_empty();
            out.working_copy_merge = wc.parent_ids().len() > 1;
        }
        let mut stream = revset.stream();
        let mut scanned = 0usize;
        while let Some(id) = stream.next().await {
            let id = id.map_err(|e| unknown(&e.to_string()))?;
            if id == *repo.store().root_commit_id() {
                continue;
            }
            scanned += 1;
            if scanned > ORPHAN_SCAN_LIMIT {
                return Err(unknown("too many commits unreachable from any branch or tag"));
            }
            let c = repo.store().get_commit_async(&id).await.map_err(|e| unknown(&e.to_string()))?;
            let described = !c.description().trim().is_empty();
            let merge = c.parent_ids().len() > 1;
            // `@`는 파일 내용이 작업 폴더에 남으므로 설명이 있거나 머지일 때만
            let keep = if wc_id.as_ref() == Some(&id) {
                described || merge
            } else {
                described || merge || c.has_conflict() || !c.is_empty(repo.index()).await.map_err(|e| unknown(&e.to_string()))?
            };
            if keep {
                // 보존하려면 git에 객체가 있어야 한다(jj 백엔드는 모든 커밋을 git에 쓴다)
                let sha = id.hex();
                let oid = gix::ObjectId::from_hex(sha.as_bytes()).map_err(|_| unknown("bad commit id"))?;
                if git.find_commit(oid).is_err() {
                    return Err(unknown("a commit is missing from git"));
                }
                out.orphans.push(Orphan { sha, change_id: c.change_id().reverse_hex(), description: c.description().to_string() });
            }
        }
        Ok::<(), Coded>(())
    })?;
    out.orphans.sort_by(|a, b| a.sha.cmp(&b.sha));
    Ok(out)
}

fn partial(step: &str, e: impl std::fmt::Display) -> Coded {
    coded!("jj.disablePartial", "jj could only be partly removed (failed at {step}): {detail}. The git repository is intact; run it again to finish", step = step.to_string(), detail = e.to_string())
}

enum HeadPlan {
    Keep,
    Detached,
    Attach(String),
    /// 아직 없는 브랜치로(커밋 없는 상태). `fallback`: 평소 이름이 모두 있어 `main-2` 같은 이름을 골랐다
    Unborn { name: String, fallback: bool },
}

/// 신뢰하는 범위(system·global)의 `init.defaultBranch`, 없으면 `main`. 저장소 로컬 설정은 신뢰하지 않는다.
fn default_branch_candidates(git: &gix::Repository) -> Vec<String> {
    use gix::config::Source;
    let snap = git.config_snapshot();
    let configured = snap
        .plumbing()
        .string_filter("init.defaultBranch", |m| matches!(m.source, Source::System | Source::Git | Source::User | Source::GitInstallation))
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty() && s.len() < 200 && gix::validate::reference::name_partial(format!("refs/heads/{s}").as_str().into()).is_ok());
    configured.into_iter().chain(["main".to_string()]).collect()
}

/// HEAD가 어디로 갈지 정한다(바꾸지 않는다). 못 정하는 경우(`refs/jj/*`를 향한 HEAD에 쓸 빈 기본 브랜치 이름이 없음)는 거절.
fn plan_head(git: &gix::Repository) -> Result<HeadPlan, Coded> {
    use gix::head::Kind;
    let head = git.head().map_err(|e| fail("disable-head", e))?;
    match &head.kind {
        Kind::Detached { target, .. } => {
            Ok(match local_branches(git, Some(*target))?.as_slice() {
                [one] => HeadPlan::Attach(one.clone()),
                _ => HeadPlan::Detached,
            })
        }
        Kind::Symbolic(r) if r.name.as_bstr().starts_with(b"refs/jj/") => plan_unborn(git),
        Kind::Unborn(n) if n.as_bstr().starts_with(b"refs/jj/") => plan_unborn(git),
        _ => Ok(HeadPlan::Keep),
    }
}

/// HEAD가 커밋 없음(루트 위 `@`)을 가리킬 때: `refs/jj/*`를 지우면 HEAD가 깨지므로 아직 없는 브랜치 이름으로 둔다. 이미 있는 브랜치는 쓰지 않는다(없던 상태를 있는 브랜치에 붙이면 인덱스와 어긋난다).
/// 이름은 `init.defaultBranch`(신뢰 범위만)·`main`, 둘 다 있으면 `main-2`, `main-3`…
fn plan_unborn(git: &gix::Repository) -> Result<HeadPlan, Coded> {
    let free = |name: &str| -> Result<bool, Coded> { Ok(git.try_find_reference(format!("refs/heads/{name}").as_str()).map_err(|e| fail("disable-refs", e))?.is_none()) };
    let preferred = default_branch_candidates(git);
    for (i, name) in preferred.iter().enumerate() {
        if free(name)? {
            return Ok(HeadPlan::Unborn { name: format!("refs/heads/{name}"), fallback: i > 0 });
        }
    }
    for n in 2..1000 {
        let name = format!("main-{n}");
        if free(&name)? {
            return Ok(HeadPlan::Unborn { name: format!("refs/heads/{name}"), fallback: true });
        }
    }
    Err(coded!("jj.disableUnknown", "Cannot tell which jj commits would be lost: {reason}", reason = "no free branch name for HEAD".to_string()))
}

/// `commit`(None이면 전부)을 가리키는 로컬 브랜치의 전체 이름
fn local_branches(git: &gix::Repository, commit: Option<gix::ObjectId>) -> Result<Vec<String>, Coded> {
    let refs = git.references().map_err(|e| fail("disable-refs", e))?;
    let mut out = Vec::new();
    for r in refs.local_branches().map_err(|e| fail("disable-refs", e))? {
        let mut r = r.map_err(|e| fail("disable-refs", e))?;
        let name = r.name().as_bstr().to_string();
        if let Some(c) = commit {
            match r.peel_to_id() {
                Ok(id) if id.detach() == c => {}
                _ => continue,
            }
        }
        out.push(name);
    }
    Ok(out)
}

fn set_head_symbolic(git: &gix::Repository, branch: &str) -> Result<(), Box<dyn std::error::Error>> {
    let target = gix::refs::FullName::try_from(branch)?;
    git.edit_reference(RefEdit {
        change: Change::Update {
            log: LogChange { mode: RefLog::AndReference, force_create_reflog: false, message: "jj disable: attach HEAD to branch".into() },
            expected: PreviousValue::Any,
            new: Target::Symbolic(target),
        },
        name: "HEAD".try_into()?,
        deref: false,
    })?;
    Ok(())
}

fn delete_jj_refs(git: &gix::Repository) -> Result<(), Box<dyn std::error::Error>> {
    let mut edits = Vec::new();
    for r in git.references()?.prefixed("refs/jj/")? {
        let r = r?;
        edits.push(RefEdit {
            change: Change::Delete { expected: PreviousValue::Any, log: RefLog::AndReference },
            name: r.name().to_owned(),
            deref: false,
        });
    }
    if !edits.is_empty() {
        git.edit_references(edits)?;
    }
    Ok(())
}

/// 보존 ref 접두 아래의 기존 ref(이름 → 커밋)
fn existing_kept(git: &gix::Repository) -> HashMap<String, gix::ObjectId> {
    let mut out = HashMap::new();
    if let Ok(refs) = git.references() {
        if let Ok(it) = refs.prefixed(format!("{KEEP_PREFIX}/").as_str()) {
            for r in it.flatten() {
                let mut r = r;
                let name = r.name().as_bstr().to_string();
                if let Ok(id) = r.peel_to_id() {
                    out.insert(name, id.detach());
                }
            }
        }
    }
    out
}

fn count_kept(git: &gix::Repository) -> usize {
    existing_kept(git).len()
}

/// 보존 ref 이름: `refs/git403/jj-orphans/<change-id 앞 12자>`, 이미 다른 커밋이 쓰고 있으면 `-2`·`-3`… 접미사
fn keep_orphans(git: &gix::Repository, orphans: &[Orphan]) -> Result<usize, Box<dyn std::error::Error>> {
    let mut existing = existing_kept(git);
    let mut created = 0;
    for o in orphans {
        let id = gix::ObjectId::from_hex(o.sha.as_bytes())?;
        if existing.values().any(|v| *v == id) {
            continue; // 이미 남겨 둠(재실행)
        }
        let short: String = o.change_id.chars().filter(|c| c.is_ascii_lowercase()).take(SHORT_CHANGE_ID_LEN).collect();
        let base = format!("{KEEP_PREFIX}/{}", if short.is_empty() { "unknown" } else { &short });
        let mut name = base.clone();
        let mut n = 2;
        while existing.contains_key(&name) {
            name = format!("{base}-{n}");
            n += 1;
        }
        git.reference(name.as_str(), id, PreviousValue::MustNotExist, "jj disable: keep commit not reachable from any branch or tag")?;
        existing.insert(name, id);
        created += 1;
    }
    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_prefix_is_ignored_when_comparing_locations() {
        assert_eq!(strip_verbatim(Path::new(r"\\?\C:\repo")), r"C:\repo");
        assert_eq!(strip_verbatim(Path::new(r"\\?\UNC\srv\share\r")), r"\\srv\share\r");
        assert_eq!(strip_verbatim(Path::new("/tmp/r")), "/tmp/r");
        // 접두가 한쪽에만 있어도, 구분자가 달라도 같은 곳
        assert!(is_direct_jj_child(Path::new(r"\\?\C:\repo\.jj"), Path::new(r"C:\repo")));
        assert!(is_direct_jj_child(Path::new(r"C:\repo\.jj"), Path::new(r"\\?\C:\repo")));
        assert!(is_direct_jj_child(Path::new(r"\\?\UNC\srv\share\r\.jj"), Path::new(r"\\srv\share\r")));
        assert!(is_direct_jj_child(Path::new("/tmp/r/.jj"), Path::new("/tmp/r")));
        assert!(is_direct_jj_child(Path::new("/tmp/r/.jj"), Path::new("/tmp/r/")));
        // 바로 아래의 `.jj`만
        assert!(!is_direct_jj_child(Path::new("/tmp/r/sub/.jj"), Path::new("/tmp/r")));
        assert!(!is_direct_jj_child(Path::new("/tmp/r/.jj/x"), Path::new("/tmp/r")));
        assert!(!is_direct_jj_child(Path::new("/tmp/other/.jj"), Path::new("/tmp/r")));
        assert!(!is_direct_jj_child(Path::new("/tmp/r2/.jj"), Path::new("/tmp/r")));
        assert!(!is_direct_jj_child(Path::new("/tmp/r/.jjx"), Path::new("/tmp/r")));
        assert!(!is_direct_jj_child(Path::new(r"D:\repo\.jj"), Path::new(r"C:\repo")));
    }
}

#[cfg(test)]
mod remove_tests {
    use super::*;

    fn jj_dir(root: &Path) {
        fs::create_dir_all(root.join(".jj/repo/store")).unwrap();
        fs::write(root.join(".jj/repo/store/f"), "x").unwrap();
    }

    #[test]
    fn removes_via_rename_into_trash_parent() {
        let d = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(d.path()).unwrap();
        jj_dir(&root);
        fs::create_dir(root.join("trash")).unwrap();
        assert!(remove_jj_dir(&root, &root.join("trash")).unwrap().is_none());
        assert!(!root.join(".jj").exists());
        assert_eq!(fs::read_dir(root.join("trash")).unwrap().count(), 0);
    }

    /// 이름 바꾸기가 실패(대상 폴더가 없음 — 다른 파일시스템 때처럼)하면 제자리에서 지운다
    #[test]
    fn falls_back_to_in_place_removal_when_rename_fails() {
        let d = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(d.path()).unwrap();
        jj_dir(&root);
        let missing = root.join("no-such-dir");
        assert!(remove_jj_dir(&root, &missing).unwrap().is_none());
        assert!(!root.join(".jj").exists());
        assert!(!missing.exists());
    }

    #[cfg(unix)]
    #[test]
    fn fallback_still_does_not_follow_links_and_rechecks() {
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("keep"), "k").unwrap();
        let d = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(d.path()).unwrap();
        jj_dir(&root);
        std::os::unix::fs::symlink(outside.path(), root.join(".jj/repo/link")).unwrap();
        remove_jj_dir(&root, &root.join("no-such-dir")).unwrap();
        assert!(outside.path().join("keep").exists());
        // 직전 재확인: `.jj`가 링크로 바뀌어 있으면 거절(밖은 그대로)
        let d = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(d.path()).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join(".jj")).unwrap();
        assert!(remove_jj_dir(&root, &root.join("no-such-dir")).is_err());
        assert!(outside.path().join("keep").exists());
    }
}
