use std::path::Path;
use std::process::Command;

use gc_jj::{abandon, describe, edit, enable, new_commit, split, squash, status};

fn git(dir: &Path, args: &[&str]) -> String {
    let o = Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8(o.stdout).unwrap().trim_end().to_string()
}

fn write(p: &Path, f: &str, c: &str) {
    if let Some(d) = Path::new(f).parent() {
        std::fs::create_dir_all(p.join(d)).unwrap();
    }
    std::fs::write(p.join(f), c).unwrap();
}

/// main에 c0(a.txt=v0), c1(a.txt=v1); jj 켬
fn repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    for i in 0..2 {
        write(p, "a.txt", &format!("v{i}\n"));
        git(p, &["add", "."]);
        git(p, &["commit", "-q", "-m", &format!("c{i}")]);
    }
    enable(p).unwrap();
    d
}

fn wc(p: &Path) -> String {
    status(p).unwrap().working_copy.unwrap()
}
fn parents(p: &Path, sha: &str) -> Vec<String> {
    git(p, &["rev-parse", &format!("{sha}^@")]).lines().map(String::from).collect()
}
fn tree_files(p: &Path, sha: &str) -> Vec<String> {
    git(p, &["ls-tree", "-r", "--name-only", sha]).lines().map(String::from).collect()
}
fn blob(p: &Path, sha: &str, f: &str) -> String {
    git(p, &["show", &format!("{sha}:{f}")])
}
fn msg(p: &Path, sha: &str) -> String {
    git(p, &["log", "-1", "--format=%B", sha])
}
fn fsck(p: &Path) {
    git(p, &["fsck", "--strict"]);
}
/// git HEAD는 detached이고 `@`의 첫 부모를 가리키며, 인덱스는 그 트리와 같다(작업 파일 차이는 unstaged로만)
fn head_is_wc_parent(p: &Path) {
    let w = wc(p);
    let first = parents(p, &w)[0].clone();
    assert_eq!(git(p, &["rev-parse", "HEAD"]), first);
    assert_eq!(git(p, &["rev-parse", "--abbrev-ref", "HEAD"]), "HEAD", "detached");
}
fn code(e: gc_i18n::Coded) -> String {
    e.code.to_string()
}

#[test]
fn new_on_parent_makes_empty_working_copy_and_moves_head() {
    let d = repo();
    let p = d.path();
    let main = git(p, &["rev-parse", "main"]);
    let c0 = git(p, &["rev-parse", "main~1"]);
    let before = wc(p);
    new_commit(p, std::slice::from_ref(&c0)).unwrap();
    let w = wc(p);
    assert_ne!(w, before);
    assert_eq!(parents(p, &w), vec![c0.clone()]);
    // 같은 트리(빈 커밋), git HEAD = c0, 작업 폴더는 c0 내용
    assert_eq!(git(p, &["rev-parse", &format!("{w}^{{tree}}")]), git(p, &["rev-parse", &format!("{c0}^{{tree}}")]));
    assert_eq!(git(p, &["rev-parse", "HEAD"]), c0);
    assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "v0\n");
    // 브랜치 main은 그대로
    assert_eq!(git(p, &["rev-parse", "main"]), main);
    // 이전 @(빈 커밋·설명 없음)는 버려진다(jj와 같게)
    assert!(!status(p).unwrap().change_ids.contains_key(&before));
    fsck(p);
}

#[test]
fn new_with_two_parents_dedups_and_head_is_first_parent() {
    let d = repo();
    let p = d.path();
    let c0 = git(p, &["rev-parse", "main~1"]);
    git(p, &["checkout", "-q", "-b", "topic", &c0]);
    write(p, "t.txt", "t\n");
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "t"]);
    let topic = git(p, &["rev-parse", "topic"]);
    git(p, &["checkout", "-q", "main"]);
    let main = git(p, &["rev-parse", "main"]);
    new_commit(p, &[main.clone(), topic.clone(), main.clone()]).unwrap();
    let w = wc(p);
    assert_eq!(parents(p, &w), vec![main.clone(), topic.clone()]);
    assert_eq!(git(p, &["rev-parse", "HEAD"]), main);
    let files = tree_files(p, &w);
    assert!(files.contains(&"a.txt".into()) && files.contains(&"t.txt".into()));
    assert_eq!(std::fs::read_to_string(p.join("t.txt")).unwrap(), "t\n");
    assert!(status(p).unwrap().conflicted.is_empty());
    fsck(p);
}

#[test]
fn describe_rewrites_and_rebases_descendants_and_branches() {
    let d = repo();
    let p = d.path();
    let main = git(p, &["rev-parse", "main"]);
    let c0 = git(p, &["rev-parse", "main~1"]);
    let tree = git(p, &["rev-parse", "main^{tree}"]);
    describe(p, &c0, "first changed").unwrap();
    // c0이 새 커밋으로, 자손 c1(=main)도 rebase되어 main 브랜치가 옮겨 갔다
    let new_main = git(p, &["rev-parse", "main"]);
    assert_ne!(new_main, main);
    assert_eq!(git(p, &["rev-parse", "main^{tree}"]), tree);
    assert_eq!(msg(p, "main~1"), "first changed");
    assert_eq!(msg(p, "main"), "c1");
    // @도 새 main 위
    assert_eq!(parents(p, &wc(p)), vec![new_main.clone()]);
    assert_eq!(git(p, &["rev-parse", "HEAD"]), new_main);
    // @ 설명: 끝 줄바꿈 보장, 비우기
    let w = wc(p);
    describe(p, &w, "wip").unwrap();
    assert_eq!(git(p, &["cat-file", "-p", &wc(p)]).lines().last().unwrap(), "wip");
    describe(p, &wc(p), "").unwrap();
    assert_eq!(msg(p, &wc(p)), "");
    assert_eq!(git(p, &["status", "--porcelain"]), "");
    fsck(p);
}

#[test]
fn describe_snapshots_dirty_working_copy_into_at() {
    let d = repo();
    let p = d.path();
    write(p, "a.txt", "dirty\n");
    write(p, "new.txt", "n\n");
    describe(p, &wc(p), "with changes").unwrap();
    let w = wc(p);
    assert_eq!(blob(p, &w, "a.txt"), "dirty");
    assert_eq!(blob(p, &w, "new.txt"), "n");
    // 작업 파일은 그대로, git HEAD는 main
    assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "dirty\n");
    assert_eq!(git(p, &["rev-parse", "HEAD"]), git(p, &["rev-parse", "main"]));
    fsck(p);
}

#[test]
fn edit_checks_out_commit_and_keeps_old_changes() {
    let d = repo();
    let p = d.path();
    let c0 = git(p, &["rev-parse", "main~1"]);
    let c1 = git(p, &["rev-parse", "main"]);
    write(p, "new.txt", "n\n");
    let old_change = status(p).unwrap().change_ids[&wc(p)].full.clone();
    edit(p, &c1).unwrap();
    assert_eq!(wc(p), c1);
    // 이전 @의 변경은 그 커밋에 snapshot되어 남고, 작업 폴더에서는 사라진다
    assert!(!p.join("new.txt").exists());
    let old_at = status(p).unwrap().change_ids.iter().find(|(_, c)| c.full == old_change).map(|(k, _)| k.clone()).expect("old @ kept");
    assert_eq!(blob(p, &old_at, "new.txt"), "n");
    // git HEAD = c1의 부모
    assert_eq!(git(p, &["rev-parse", "HEAD"]), c0);
    head_is_wc_parent(p);
    // 이제 @=c1을 고치면(파일 수정) c1이 다시 쓰이고 main 브랜치가 따라온다
    write(p, "a.txt", "edited\n");
    describe(p, &wc(p), "c1 edited").unwrap();
    assert_eq!(git(p, &["rev-parse", "main"]), wc(p));
    assert_eq!(blob(p, "main", "a.txt"), "edited");
    fsck(p);
    // 루트 커밋 거절
    assert_eq!(code(edit(p, &"0".repeat(40)).unwrap_err()), "jj.immutable");
}

#[test]
fn squash_wc_into_parent_and_with_paths() {
    let d = repo();
    let p = d.path();
    let c0 = git(p, &["rev-parse", "main~1"]);
    // @ = main 위에 a.txt·b.txt 변경
    write(p, "a.txt", "v2\n");
    write(p, "b.txt", "b\n");
    squash(p, None, &["b.txt".into()]).unwrap();
    // main(=부모)이 b.txt를 흡수, @는 a.txt 변경만 남음
    let main = git(p, &["rev-parse", "main"]);
    assert_eq!(blob(p, &main, "b.txt"), "b");
    assert_eq!(blob(p, &main, "a.txt"), "v1");
    assert_eq!(parents(p, &main), vec![c0.clone()]);
    let w = wc(p);
    assert_eq!(parents(p, &w), vec![main.clone()]);
    assert_eq!(blob(p, &w, "a.txt"), "v2");
    assert_eq!(blob(p, &w, "b.txt"), "b");
    assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "v2\n");
    assert_eq!(git(p, &["rev-parse", "HEAD"]), main);
    fsck(p);
    // 전체 squash: @가 사라지고 새 빈 @가 생긴다
    squash(p, None, &[]).unwrap();
    let main2 = git(p, &["rev-parse", "main"]);
    assert_eq!(blob(p, &main2, "a.txt"), "v2");
    assert_eq!(parents(p, &wc(p)), vec![main2.clone()]);
    assert_eq!(git(p, &["rev-parse", "HEAD"]), main2);
    assert_eq!(git(p, &["status", "--porcelain"]), "");
    fsck(p);
}

#[test]
fn squash_middle_commit_rebases_child_and_rejects_merge() {
    let d = repo();
    let p = d.path();
    let c0 = git(p, &["rev-parse", "main~1"]);
    let c1 = git(p, &["rev-parse", "main"]);
    // c1을 부모 c0로 squash → main이 옮겨 가고 @도 따라온다
    squash(p, Some(&c1), &[]).unwrap();
    let main = git(p, &["rev-parse", "main"]);
    assert_eq!(parents(p, &main), parents(p, &c0));
    assert_eq!(blob(p, &main, "a.txt"), "v1");
    assert_eq!(parents(p, &wc(p)), vec![main.clone()]);
    fsck(p);
    // 머지 커밋 거절
    let a = git(p, &["rev-parse", "main"]);
    new_commit(p, std::slice::from_ref(&a)).unwrap();
    write(p, "x.txt", "x\n");
    describe(p, &wc(p), "x").unwrap();
    let x = wc(p);
    new_commit(p, &[a.clone(), x.clone()]).unwrap();
    describe(p, &wc(p), "merge").unwrap();
    let m = wc(p);
    assert_eq!(parents(p, &m).len(), 2);
    assert_eq!(code(squash(p, Some(&m), &[]).unwrap_err()), "jj.mergeCommit");
    // 지정 경로에 변경이 없으면 아무 일도 안 일어난다
    let before = git(p, &["rev-parse", "main"]);
    assert_eq!(code(squash(p, Some(&x), &["nothing.txt".into()]).unwrap_err()), "jj.nothingToSquash");
    assert_eq!(git(p, &["rev-parse", "main"]), before);
    fsck(p);
}

#[test]
fn split_by_files() {
    let d = repo();
    let p = d.path();
    write(p, "x.txt", "x\n");
    write(p, "y.txt", "y\n");
    describe(p, &wc(p), "both").unwrap();
    let orig = wc(p);
    let orig_change = status(p).unwrap().change_ids[&orig].full.clone();
    let main = git(p, &["rev-parse", "main"]);
    split(p, &orig, &["x.txt".into()]).unwrap();
    let second = wc(p); // @는 둘째로 옮겨 온다
    let st = status(p).unwrap();
    assert_ne!(second, orig);
    let first = parents(p, &second)[0].clone();
    assert_eq!(parents(p, &first), vec![main.clone()]);
    assert_eq!(tree_files(p, &first), vec!["a.txt".to_string(), "x.txt".to_string()]);
    assert_eq!(tree_files(p, &second), vec!["a.txt".to_string(), "x.txt".to_string(), "y.txt".to_string()]);
    // 첫 커밋이 원래 change ID, 둘째는 새 ID
    assert_eq!(st.change_ids[&first].full, orig_change);
    assert_ne!(st.change_ids[&second].full, orig_change);
    assert_eq!(msg(p, &first), "both");
    assert_eq!(git(p, &["rev-parse", "HEAD"]), first);
    // y.txt는 작업 폴더에 그대로, git에서는 HEAD(first) 대비 y.txt만 변경으로 보인다
    // (jj는 새 파일을 intent-to-add `A`로 남긴다)
    assert!(git(p, &["status", "--porcelain", "--", "y.txt"]).ends_with("y.txt"));
    fsck(p);
    // 전부/아무것도 선택하지 않으면 거절
    let w = wc(p);
    assert_eq!(code(split(p, &w, &["y.txt".into()]).unwrap_err()), "jj.nothingToSplit");
    assert_eq!(code(split(p, &w, &[]).unwrap_err()), "jj.nothingToSplit");
    assert_eq!(code(split(p, &w, &["zzz.txt".into()]).unwrap_err()), "jj.nothingToSplit");
}

#[test]
fn split_middle_commit_moves_descendants_to_second() {
    let d = repo();
    let p = d.path();
    // c1 위에 두 파일을 가진 커밋 m, 그 위에 @
    new_commit(p, &[git(p, &["rev-parse", "main"])]).unwrap();
    write(p, "x.txt", "x\n");
    write(p, "y.txt", "y\n");
    describe(p, &wc(p), "m").unwrap();
    let m = wc(p);
    new_commit(p, std::slice::from_ref(&m)).unwrap();
    let top = wc(p);
    split(p, &m, &["y.txt".into()]).unwrap();
    let w = wc(p);
    assert_ne!(w, top); // 자손 @가 둘째 위로 rebase
    let second = parents(p, &w)[0].clone();
    let first = parents(p, &second)[0].clone();
    assert_eq!(tree_files(p, &first), vec!["a.txt".to_string(), "y.txt".to_string()]);
    assert_eq!(tree_files(p, &w), vec!["a.txt".to_string(), "x.txt".to_string(), "y.txt".to_string()]);
    assert_eq!(git(p, &["rev-parse", "HEAD"]), second);
    fsck(p);
}

#[test]
fn abandon_rebases_children_and_moves_branch() {
    let d = repo();
    let p = d.path();
    let c0 = git(p, &["rev-parse", "main~1"]);
    let c1 = git(p, &["rev-parse", "main"]);
    abandon(p, &c1).unwrap();
    // main 브랜치는 부모로, @는 c0 위, 작업 폴더는 c0 내용
    assert_eq!(git(p, &["rev-parse", "main"]), c0);
    assert_eq!(parents(p, &wc(p)), vec![c0.clone()]);
    assert_eq!(git(p, &["rev-parse", "HEAD"]), c0);
    assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "v0\n");
    assert!(!status(p).unwrap().change_ids.contains_key(&c1));
    fsck(p);
    // @를 버리면 새 빈 @가 생긴다
    let w = wc(p);
    abandon(p, &w).unwrap();
    assert_ne!(wc(p), w);
    assert_eq!(parents(p, &wc(p)), vec![c0]);
    fsck(p);
}

#[test]
fn rejects_bad_sha_paths_and_leaves_repo_untouched() {
    let d = repo();
    let p = d.path();
    let ops = |p: &Path| std::fs::read_dir(p.join(".jj/repo/op_heads/heads")).unwrap().map(|e| e.unwrap().file_name()).collect::<Vec<_>>();
    let refs = git(p, &["for-each-ref"]);
    let heads = ops(p);
    let main = git(p, &["rev-parse", "main"]);
    for bad in ["", "--all", "abc", "main", "@", &main[..39], &format!("{main}0"), &format!("{}g", &main[..39]), "../.git"] {
        assert_eq!(code(describe(p, bad, "x").unwrap_err()), "jj.badSha", "{bad}");
        assert_eq!(code(edit(p, bad).unwrap_err()), "jj.badSha");
        assert_eq!(code(abandon(p, bad).unwrap_err()), "jj.badSha");
        assert_eq!(code(new_commit(p, &[bad.to_string()]).unwrap_err()), "jj.badSha");
        assert_eq!(code(split(p, bad, &["a.txt".into()]).unwrap_err()), "jj.badSha");
        if !bad.is_empty() {
            assert_eq!(code(squash(p, Some(bad), &[]).unwrap_err()), "jj.badSha");
        }
    }
    assert_eq!(code(new_commit(p, &[]).unwrap_err()), "jj.badSha");
    for bad in [
        "", "/etc/passwd", "../x", "a/../b", "./a", "a/./b", "a//b", "a/", "..", ".git/config", ".GIT/x", "a/.jj/b", ".jj", "C:\\x", "C:x", "a\\b", "a\0b",
    ] {
        assert_eq!(code(squash(p, None, &[bad.to_string()]).unwrap_err()), "jj.badPath", "{bad:?}");
        assert_eq!(code(split(p, &main, &[bad.to_string()]).unwrap_err()), "jj.badPath", "{bad:?}");
    }
    assert_eq!(code(describe(p, &main, "a\0b").unwrap_err()), "jj.badMessage");
    // 존재하지 않는 SHA
    assert_eq!(code(describe(p, &"1".repeat(40), "x").unwrap_err()), "jj.noCommit");
    assert_eq!(git(p, &["for-each-ref"]), refs);
    assert_eq!(ops(p), heads, "operation이 늘지 않았다");
    // jj가 꺼진 저장소
    let off = tempfile::tempdir().unwrap();
    git(off.path(), &["init", "-q"]);
    assert_eq!(code(abandon(off.path(), &main).unwrap_err()), "jj.notEnabled");
}

#[test]
fn immutable_commits_are_refused() {
    let d = repo();
    let p = d.path();
    let c0 = git(p, &["rev-parse", "main~1"]);
    let c1 = git(p, &["rev-parse", "main"]);
    // 태그의 조상
    git(p, &["tag", "v1", &c0]);
    enable(p).unwrap();
    assert_eq!(code(describe(p, &c0, "x").unwrap_err()), "jj.immutable");
    assert_eq!(code(abandon(p, &c0).unwrap_err()), "jj.immutable");
    // c1은 아직 고칠 수 있다. 그런데 부모(c0)가 불변이라 squash는 거절
    assert_eq!(code(squash(p, Some(&c1), &[]).unwrap_err()), "jj.immutable");
    describe(p, &c1, "ok").unwrap();
    // 원격에 올라간(추적 안 하는 원격 북마크) 커밋도 불변
    let remote = tempfile::tempdir().unwrap();
    git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
    git(p, &["remote", "add", "origin", remote.path().to_str().unwrap()]);
    git(p, &["push", "-q", "origin", "main"]);
    git(p, &["fetch", "-q", "origin"]);
    let main = git(p, &["rev-parse", "main"]);
    assert_eq!(code(describe(p, &main, "no").unwrap_err()), "jj.immutable");
    assert_eq!(code(edit(p, &main).unwrap_err()), "jj.immutable");
    // 그 위의 새 커밋은 고칠 수 있다
    new_commit(p, std::slice::from_ref(&main)).unwrap();
    describe(p, &wc(p), "mine").unwrap();
    assert_eq!(git(p, &["rev-parse", "main"]), main);
    fsck(p);
}

#[test]
fn conflicts_show_up_in_status() {
    let d = repo();
    let p = d.path();
    let c0 = git(p, &["rev-parse", "main~1"]);
    let c1 = git(p, &["rev-parse", "main"]);
    // c0 위의 X(a.txt=x), c1 위의 Y(a.txt=y)
    new_commit(p, std::slice::from_ref(&c0)).unwrap();
    write(p, "a.txt", "x\n");
    describe(p, &wc(p), "X").unwrap();
    let x = wc(p);
    new_commit(p, std::slice::from_ref(&c1)).unwrap();
    write(p, "a.txt", "y\n");
    describe(p, &wc(p), "Y").unwrap();
    let y = wc(p);
    assert!(status(p).unwrap().conflicted.is_empty());
    // 머지: 같은 줄을 다르게 바꾼 두 커밋 → 충돌 커밋
    new_commit(p, &[x.clone(), y.clone()]).unwrap();
    let m = wc(p);
    let s = status(p).unwrap();
    assert_eq!(s.conflicted, vec![m.clone()]);
    let text = std::fs::read_to_string(p.join("a.txt")).unwrap();
    assert!(text.contains("<<<<<<<") && text.contains(">>>>>>>"), "{text}");
    // 해결하면(파일 고침) 다음 작업의 snapshot에서 충돌이 사라진다
    write(p, "a.txt", "z\n");
    describe(p, &wc(p), "resolved").unwrap();
    assert!(status(p).unwrap().conflicted.is_empty());
    assert_eq!(blob(p, &wc(p), "a.txt"), "z");
    fsck(p);
}

#[test]
fn rebase_conflict_is_detected_on_descendants() {
    let d = repo();
    let p = d.path();
    let c0 = git(p, &["rev-parse", "main~1"]);
    // c0 위에 a.txt를 바꾼 커밋 C, 그 위에 같은 줄을 또 바꾼 D
    new_commit(p, std::slice::from_ref(&c0)).unwrap();
    write(p, "a.txt", "c\n");
    describe(p, &wc(p), "C").unwrap();
    let c = wc(p);
    new_commit(p, std::slice::from_ref(&c)).unwrap();
    write(p, "a.txt", "d\n");
    describe(p, &wc(p), "D").unwrap();
    new_commit(p, &[wc(p)]).unwrap();
    assert!(status(p).unwrap().conflicted.is_empty());
    // C를 버리면 D(c→d)가 c0(v0)로 rebase되어 base가 맞지 않아 충돌 커밋이 된다
    abandon(p, &c).unwrap();
    let s = status(p).unwrap();
    let w = wc(p);
    let d_new = parents(p, &w)[0].clone();
    assert_eq!(msg(p, &d_new), "D");
    assert!(s.conflicted.contains(&d_new), "{:?}", s.conflicted);
    // 빈 @는 충돌을 물려받는다
    assert!(s.conflicted.contains(&w));
    fsck(p);
}

#[test]
fn picks_up_external_git_commit_and_checkout() {
    let d = repo();
    let p = d.path();
    // git으로 직접 커밋
    write(p, "g.txt", "g\n");
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "via git"]);
    let g = git(p, &["rev-parse", "HEAD"]);
    new_commit(p, std::slice::from_ref(&g)).unwrap();
    assert_eq!(parents(p, &wc(p)), vec![g.clone()]);
    assert_eq!(git(p, &["rev-parse", "HEAD"]), g);
    // git checkout으로 HEAD 이동 후 jj 작업: @가 새 HEAD 위로
    let c0 = git(p, &["rev-parse", "main~2"]);
    git(p, &["checkout", "-q", &c0]);
    // 화면이 보던 옛 @ SHA로 온 요청은 거절(UI가 새로고침). 새 @로 다시 하면 된다
    let old_at = wc(p);
    assert_eq!(code(describe(p, &old_at, "late").unwrap_err()), "jj.stale");
    assert_eq!(git(p, &["rev-parse", "HEAD"]), c0);
    describe(p, &wc(p), "after checkout").unwrap();
    assert_eq!(parents(p, &wc(p)), vec![c0.clone()]);
    assert_eq!(git(p, &["rev-parse", "HEAD"]), c0);
    fsck(p);
}

#[test]
fn global_and_info_excludes_are_not_tracked() {
    let d = repo();
    let p = d.path();
    std::fs::write(p.join(".git/info/exclude"), "secret.txt\n").unwrap();
    write(p, "secret.txt", "s\n");
    write(p, "ok.txt", "o\n");
    describe(p, &wc(p), "x").unwrap();
    let files = tree_files(p, &wc(p));
    assert!(files.contains(&"ok.txt".to_string()) && !files.contains(&"secret.txt".to_string()), "{files:?}");
    // 1MiB 넘는 새 파일은 추적하지 않는다(jj CLI 기본)
    write(p, "big.bin", &"x".repeat((1 << 20) + 1));
    describe(p, &wc(p), "y").unwrap();
    assert!(!tree_files(p, &wc(p)).contains(&"big.bin".to_string()));
}

#[test]
fn author_comes_from_git_config() {
    let d = repo();
    let p = d.path();
    git(p, &["config", "user.name", "Alice"]);
    git(p, &["config", "user.email", "alice@example.com"]);
    describe(p, &wc(p), "hi").unwrap();
    assert_eq!(git(p, &["log", "-1", "--format=%an <%ae> / %cn", &wc(p)]), "Alice <alice@example.com> / Alice");
}

/// 설치된 jj CLI가 있으면 같은 작업의 결과(트리·git HEAD·브랜치)를 맞대 본다. 없으면 건너뜀.
#[test]
fn cross_check_with_jj_cli() {
    if Command::new("jj").arg("--version").output().map(|o| !o.status.success()).unwrap_or(true) {
        eprintln!("jj CLI 없음: 교차 비교 건너뜀");
        return;
    }
    let jj = |dir: &Path, args: &[&str]| {
        let o = Command::new("jj")
            .args(["--config", "user.name=t", "--config", "user.email=t@t", "--no-pager"])
            .args(args)
            .env("JJ_EDITOR", "true") // 설명 편집기를 띄우지 않고 그대로 받는다
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(o.status.success(), "jj {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    };
    let snapshot = |p: &Path| {
        (
            git(p, &["rev-parse", "HEAD^{tree}"]),
            git(p, &["rev-parse", "main^{tree}"]),
            git(p, &["log", "-1", "--format=%s", "main"]),
            git(p, &["symbolic-ref", "-q", "HEAD"]).is_empty(),
        )
    };
    let ours = repo();
    let theirs = tempfile::tempdir().unwrap();
    let t = theirs.path();
    git(t, &["init", "-q", "-b", "main"]);
    for i in 0..2 {
        write(t, "a.txt", &format!("v{i}\n"));
        git(t, &["add", "."]);
        git(t, &["commit", "-q", "-m", &format!("c{i}")]);
    }
    jj(t, &["git", "init", "--colocate"]);
    let p = ours.path();
    // describe 과거 커밋
    describe(p, &git(p, &["rev-parse", "main~1"]), "X").unwrap();
    jj(t, &["describe", "-m", "X", "main~"]);
    assert_eq!(snapshot(p), snapshot(t));
    // 새 커밋 + 변경 + abandon
    let main = git(p, &["rev-parse", "main"]);
    new_commit(p, std::slice::from_ref(&main)).unwrap();
    jj(t, &["new", "main"]);
    write(p, "b.txt", "b\n");
    write(t, "b.txt", "b\n");
    describe(p, &wc(p), "B").unwrap();
    jj(t, &["describe", "-m", "B"]);
    abandon(p, &main).unwrap();
    jj(t, &["abandon", "main"]);
    assert_eq!(snapshot(p), snapshot(t));
    // split(파일 지정)·squash(경로 지정)·edit·머지 new. @ 트리와 HEAD 트리를 맞댄다(커밋 해시는 시각 때문에 다르다)
    for (d, is_ours) in [(p, true), (t, false)] {
        write(d, "x.txt", "x\n");
        write(d, "y.txt", "y\n");
        if is_ours {
            describe(p, &wc(p), "xy").unwrap();
            split(p, &wc(p), &["x.txt".into()]).unwrap();
        } else {
            jj(t, &["describe", "-m", "xy"]);
            jj(t, &["split", "x.txt"]);
        }
    }
    assert_eq!(snapshot(p), snapshot(t));
    assert_eq!(git(p, &["status", "--porcelain"]), git(t, &["status", "--porcelain"]));
    squash(p, None, &["y.txt".into()]).unwrap();
    jj(t, &["squash", "y.txt"]);
    assert_eq!(snapshot(p), snapshot(t));
    let parent = git(p, &["rev-parse", "HEAD"]);
    edit(p, &parent).unwrap();
    jj(t, &["edit", "@-"]);
    assert_eq!(snapshot(p), snapshot(t));
    assert_eq!(std::fs::read_dir(p).unwrap().count(), std::fs::read_dir(t).unwrap().count());
}

/// jj-lib로 operation만 커밋하고 작업 사본은 갱신하지 않아, 커밋 뒤 체크아웃 전에 끊긴 작업을 흉내 낸다.
fn interrupt_after_commit(p: &Path) {
    use jj_lib::config::StackedConfig;
    use jj_lib::default_backend_factories::{default_backend_factories, default_working_copy_factories, default_workspace_loader_factory};
    
    use jj_lib::repo::Repo;
    use jj_lib::settings::UserSettings;
    let settings = UserSettings::from_config_and_home_dir(StackedConfig::with_defaults(), None).unwrap();
    let ws = default_workspace_loader_factory()
        .create(p)
        .unwrap()
        .load(&settings, &default_backend_factories(), &default_working_copy_factories())
        .unwrap();
    pollster::block_on(async {
        let repo = ws.load_at_head().await.unwrap();
        let name = ws.workspace_name().to_owned();
        let wc = repo.store().get_commit_async(repo.view().get_wc_commit_id(&name).unwrap()).await.unwrap();
        let parent = wc.parents().await.unwrap().remove(0).parents().await.unwrap().remove(0); // c0
        let mut tx = repo.start_transaction();
        let m = tx.repo_mut();
        let new = m.new_commit(vec![parent.id().clone()], parent.tree()).write().await.unwrap();
        m.edit(name, &new).await.unwrap();
        m.rebase_descendants().await.unwrap();
        tx.commit("interrupted").await.unwrap();
    });
}

#[test]
fn stale_working_copy_is_updated_when_clean_and_refused_when_dirty() {
    let d = repo();
    let p = d.path();
    interrupt_after_commit(p);
    // 파일은 아직 v1(c1), jj의 @는 c0 위. 사용자 변경이 없으니 update-stale처럼 체크아웃하고 작업을 진행한다
    assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "v1\n");
    describe(p, &wc(p), "after interrupt").unwrap();
    assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "v0\n");
    assert_eq!(msg(p, &wc(p)), "after interrupt");
    fsck(p);
    // 두 번째: 이번엔 작업 파일에 사용자 변경이 있다 → 덮어쓰지 않고 거절, 파일 그대로
    interrupt_after_commit(p);
    write(p, "a.txt", "mine\n");
    assert_eq!(code(describe(p, &wc(p), "x").unwrap_err()), "jj.stale");
    assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "mine\n");
}

#[test]
fn concurrent_requests_do_not_fork_operations() {
    let d = repo();
    let p = d.path().to_path_buf();
    let ts: Vec<_> = (0..4)
        .map(|i| {
            let p = p.clone();
            std::thread::spawn(move || {
                for j in 0..3 {
                    let w = status(&p).unwrap().working_copy.unwrap();
                    // 다른 스레드가 먼저 @를 바꿨을 수 있다(noCommit/stale은 정상 거절)
                    match describe(&p, &w, &format!("t{i}-{j}")) {
                        Ok(_) => {}
                        Err(e) => assert!(["jj.noCommit", "jj.stale"].contains(&e.code), "{}", e.code),
                    }
                    let main = git(&p, &["rev-parse", "main"]);
                    let _ = new_commit(&p, &[main]);
                }
            })
        })
        .collect();
    for t in ts {
        t.join().unwrap();
    }
    let heads = std::fs::read_dir(p.join(".jj/repo/op_heads/heads")).unwrap().count();
    assert_eq!(heads, 1, "operation head가 갈라졌다");
    fsck(&p);
}

#[test]
fn trunk_remote_bookmark_is_immutable_even_when_tracked_and_prefix_paths() {
    let d = repo();
    let p = d.path();
    let remote = tempfile::tempdir().unwrap();
    git(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
    git(p, &["remote", "add", "origin", remote.path().to_str().unwrap()]);
    git(p, &["push", "-q", "origin", "main"]);
    git(p, &["fetch", "-q", "origin"]);
    let c0 = git(p, &["rev-parse", "main~1"]);
    // 추적 중인 main@origin(upstream 설정은 git 쪽에서 해도 jj는 import 때 추적 안 함 → jj-lib로 추적 상태를 만든다)
    track_origin_main(p);
    assert_eq!(code(describe(p, &c0, "no").unwrap_err()), "jj.immutable");
    // 디렉터리 접두 squash/split
    let main = git(p, &["rev-parse", "main"]);
    new_commit(p, std::slice::from_ref(&main)).unwrap();
    write(p, "dir/x.txt", "x\n");
    write(p, "dir/sub/y.txt", "y\n");
    write(p, "z.txt", "z\n");
    describe(p, &wc(p), "w").unwrap();
    let w = wc(p);
    split(p, &w, &["dir".into()]).unwrap();
    let second = wc(p);
    let first = parents(p, &second)[0].clone();
    assert!(tree_files(p, &first).contains(&"dir/sub/y.txt".to_string()) && !tree_files(p, &first).contains(&"z.txt".to_string()));
    assert!(tree_files(p, &second).contains(&"z.txt".to_string()));
    fsck(p);
}

fn track_origin_main(p: &Path) {
    use jj_lib::config::StackedConfig;
    use jj_lib::default_backend_factories::{default_backend_factories, default_working_copy_factories, default_workspace_loader_factory};
    use jj_lib::ref_name::{RefName, RemoteName, RemoteRefSymbol};
    
    use jj_lib::settings::UserSettings;
    let settings = UserSettings::from_config_and_home_dir(StackedConfig::with_defaults(), None).unwrap();
    let ws = default_workspace_loader_factory().create(p).unwrap().load(&settings, &default_backend_factories(), &default_working_copy_factories()).unwrap();
    pollster::block_on(async {
        let repo = ws.load_at_head().await.unwrap();
        let mut tx = repo.start_transaction();
        let m = tx.repo_mut();
        m.track_remote_bookmark(RemoteRefSymbol { name: RefName::new("main"), remote: RemoteName::new("origin") }).await.unwrap();
        tx.commit("track").await.unwrap();
    });
}

#[test]
fn windows_style_reserved_paths_are_refused() {
    let d = repo();
    let p = d.path();
    for bad in [".git.", ".git ", ".GIT. .", "GIT~1", "git~12/x", "a/JJ~1", ".jj.", "...", " ", "a/ ", ".git::$INDEX_ALLOCATION", "x:y"] {
        assert_eq!(code(squash(p, None, &[bad.to_string()]).unwrap_err()), "jj.badPath", "{bad:?}");
    }
    // 평범한 이름은 통과(변경이 없어 nothingToSquash)
    assert_eq!(code(squash(p, None, &["git~x.txt".to_string()]).unwrap_err()), "jj.nothingToSquash");
}
