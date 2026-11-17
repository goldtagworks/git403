use std::path::Path;
use std::process::Command;

use gc_jj::{abandon, bookmark_delete, bookmark_set, bookmark_track, bookmarks, describe, edit, enable, new_commit, op_log, op_restore, split, squash, status, undo};

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
    // jj CLI처럼 버려진 커밋의 북마크는 지워진다. @는 c0 위, 작업 폴더는 c0 내용
    assert_eq!(git(p, &["for-each-ref", "refs/heads/main"]), "");
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
        String::from_utf8(o.stdout).unwrap()
    };
    // 커밋 모양(설명·부모 설명·빈 커밋 여부·북마크·바뀐 파일). 커밋·change ID 해시는 시각·난수라 빼고 정렬해 비교한다
    let shape = |d: &Path| {
        let t = r#"description ++ "|" ++ parents.map(|c| c.description()).join(",") ++ "|" ++ empty ++ "|" ++ bookmarks ++ "|" ++ self.diff().files().map(|f| f.path()).join(",") ++ "\n--\n""#;
        let mut v: Vec<String> = jj(d, &["log", "-r", "all()", "--no-graph", "-T", t]).split("\n--\n").map(String::from).collect();
        v.sort();
        v
    };
    let snapshot = |p: &Path| {
        (
            git(p, &["rev-parse", "HEAD^{tree}"]),
            git(p, &["for-each-ref", "--format=%(refname) %(tree) %(contents:subject)", "refs/heads"]),
            git(p, &["rev-parse", "--abbrev-ref", "HEAD"]),
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
    jj(t, &["describe", "-m", "X", "main-"]);
    assert_eq!(snapshot(p), snapshot(t));
    assert_eq!(shape(p), shape(t), "describe");
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
    assert_eq!(shape(p), shape(t), "new+abandon");
    // split(파일 지정)·squash(경로 지정)·edit·머지 new. @ 트리와 HEAD 트리를 맞댄다(커밋 해시는 시각 때문에 다르다)
    let mut split_ids = Vec::new();
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
        // change ID 배분: 원래 change ID는 첫 커밋(x.txt), 둘째(나머지)는 새 ID — jj는 @(= 둘째)의 부모가 첫 커밋
        let id = |r: &str| jj(d, &["log", "-r", r, "--no-graph", "-T", "change_id"]);
        split_ids.push((id("@-") != id("@"), id("@-").len()));
    }
    assert_eq!(split_ids[0], split_ids[1]);
    assert_eq!(snapshot(p), snapshot(t));
    assert_eq!(git(p, &["status", "--porcelain"]), git(t, &["status", "--porcelain"]));
    assert_eq!(shape(p), shape(t), "split");
    squash(p, None, &["y.txt".into()]).unwrap();
    jj(t, &["squash", "y.txt"]);
    assert_eq!(snapshot(p), snapshot(t));
    assert_eq!(shape(p), shape(t), "squash");
    let parent = git(p, &["rev-parse", "HEAD"]);
    edit(p, &parent).unwrap();
    jj(t, &["edit", "@-"]);
    assert_eq!(snapshot(p), snapshot(t));
    assert_eq!(shape(p), shape(t), "edit");
    assert_eq!(std::fs::read_dir(p).unwrap().count(), std::fs::read_dir(t).unwrap().count());
    // 머지 new: X 위에 갈라진 L·R, 그 둘의 머지
    let sha_by = |d: &Path, m: &str| jj(d, &["log", "-r", &format!("description(exact:\"{m}\\n\")"), "--no-graph", "-T", "commit_id"]);
    let xsha = sha_by(p, "X");
    for (name, f) in [("L", "l.txt"), ("R", "r.txt")] {
        new_commit(p, std::slice::from_ref(&xsha)).unwrap();
        write(p, f, name);
        describe(p, &wc(p), name).unwrap();
        jj(t, &["new", "description(exact:\"X\\n\")"]);
        write(t, f, name);
        jj(t, &["describe", "-m", name]);
    }
    let (l, r) = (sha_by(p, "L"), sha_by(p, "R"));
    new_commit(p, &[l, r]).unwrap();
    jj(t, &["new", "description(exact:\"L\\n\")", "description(exact:\"R\\n\")"]);
    assert_eq!(snapshot(p), snapshot(t));
    assert_eq!(shape(p), shape(t), "merge new");
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

// ---- 30f: operation log·undo·restore·북마크 ----

fn branch(p: &Path, name: &str) -> String {
    git(p, &["for-each-ref", "--format=%(objectname)", &format!("refs/heads/{name}")])
}
fn all_refs(p: &Path) -> String {
    git(p, &["for-each-ref", "--format=%(refname) %(objectname)"])
}

#[test]
fn bookmark_set_move_delete_export_to_git_branches() {
    let d = repo();
    let p = d.path();
    let (c1, c0) = (git(p, &["rev-parse", "main"]), git(p, &["rev-parse", "main~1"]));
    assert_eq!(bookmark_set(p, "feat/a", &c0, false).unwrap().len(), 0);
    assert_eq!(branch(p, "feat/a"), c0);
    // 앞으로(자손)는 플래그 없이
    bookmark_set(p, "feat/a", &c1, false).unwrap();
    assert_eq!(branch(p, "feat/a"), c1);
    // 뒤로는 플래그 필요
    assert_eq!(code(bookmark_set(p, "feat/a", &c0, false).unwrap_err()), "jj.bookmarkBackwards");
    assert_eq!(branch(p, "feat/a"), c1);
    bookmark_set(p, "feat/a", &c0, true).unwrap();
    assert_eq!(branch(p, "feat/a"), c0);
    let b = bookmarks(p).unwrap();
    let a = b.iter().find(|b| b.name == "feat/a").unwrap();
    assert_eq!((a.target.clone(), a.local, a.targets.clone()), (Some(c0.clone()), true, vec![c0.clone()]));
    bookmark_delete(p, "feat/a").unwrap();
    assert_eq!(branch(p, "feat/a"), "");
    assert_eq!(code(bookmark_delete(p, "feat/a").unwrap_err()), "jj.noBookmark");
    // 보이지 않는/없는 커밋·잘못된 SHA
    assert_eq!(code(bookmark_set(p, "x", &"1".repeat(40), false).unwrap_err()), "jj.noCommit");
    assert_eq!(code(bookmark_set(p, "x", "main", false).unwrap_err()), "jj.badSha");
    fsck(p);
}

#[test]
fn bookmark_names_are_validated_before_touching_the_repo() {
    let d = repo();
    let p = d.path();
    let c1 = git(p, &["rev-parse", "main"]);
    let (refs, ops) = (all_refs(p), op_log(p, Some(1000)).unwrap().len());
    let long = "a".repeat(256);
    let long_uni = "é".repeat(128); // 256바이트
    for bad in [
        "", "-x", "--force", "a..b", "a b", "a\tb", "a@b", "@", "a@{1}", "x:y", "a~1", "a^", "a?", "a*", "a[", "a\\b", "/a", "a/", "a//b", ".a", "a/.b", "a.", "a.lock",
        "a/b.lock", "HEAD", ".git", "a/.git", "refs/heads/..", "a\nb", "a\0b", long.as_str(), "git~1", "a/GIT~1",
        long_uni.as_str(), "a\u{200B}b", "a\u{200E}", "\u{202E}evil", "a\u{2060}b", "a\u{FEFF}", "a\u{00AD}b", "a\u{2066}", "a\u{E0020}", "a\u{00A0}b", "a\u{2028}b", "a\u{85}b",
    ] {
        assert_eq!(code(bookmark_set(p, bad, &c1, true).unwrap_err()), "jj.badBookmark", "set {bad:?}");
        assert_eq!(code(bookmark_delete(p, bad).unwrap_err()), "jj.badBookmark", "delete {bad:?}");
        assert_eq!(code(bookmark_track(p, bad, "origin").unwrap_err()), "jj.badBookmark", "track {bad:?}");
    }
    assert_eq!((all_refs(p), op_log(p, Some(1000)).unwrap().len()), (refs, ops));
    // 경계: 255바이트는 되고(ASCII·한글 섞인 멀티바이트 포함) 256은 안 된다. 평범한 유니코드는 허용
    for ok in ["a".repeat(255), format!("{}a", "é".repeat(127)), "브랜치/기능-1".to_string(), "feat_é".to_string()] {
        let n = bookmark_set(p, &ok, &c1, false);
        assert!(n.is_ok(), "{ok:?}: {n:?}");
        bookmark_delete(p, &ok).unwrap();
    }
    let (refs, ops) = (all_refs(p), op_log(p, Some(1000)).unwrap().len());
    for bad in ["", "git", "-o", "a/b", "a b", "o@x", "o:x", "a\\b", "a\0"] {
        assert_eq!(code(bookmark_track(p, "main", bad).unwrap_err()), "jj.badRemote", "remote {bad:?}");
    }
    for bad in ["", "zz", "--help", "@-", "root()", &"a".repeat(129), "abc def", "../x"] {
        assert_eq!(code(op_restore(p, bad).unwrap_err()), "jj.badOpId", "op {bad:?}");
    }
    assert_eq!(code(op_restore(p, "ffffffffffff").unwrap_err()), "jj.noOperation");
    // 거절된 뒤 git ref·operation 불변
    assert_eq!((all_refs(p), op_log(p, Some(1000)).unwrap().len()), (refs, ops));
}

#[test]
fn undo_reverts_tree_and_git_refs() {
    let d = repo();
    let p = d.path();
    let c1 = git(p, &["rev-parse", "main"]);
    let c0 = git(p, &["rev-parse", "main~1"]);
    // main을 다시 쓰는 describe → undo하면 main·HEAD·트리가 원래대로
    let w0 = wc(p);
    describe(p, &c1, "rewritten").unwrap();
    assert_ne!(branch(p, "main"), c1);
    undo(p).unwrap();
    assert_eq!(branch(p, "main"), c1);
    assert_eq!(wc(p), w0);
    assert_eq!(git(p, &["rev-parse", "HEAD"]), c1);
    assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "v1\n");
    // edit으로 작업 폴더가 바뀐 것도 되돌린다
    edit(p, &c0).unwrap();
    assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "v0\n");
    undo(p).unwrap();
    assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "v1\n");
    assert_eq!(wc(p), w0);
    head_is_wc_parent(p);
    // 북마크 생성 undo → git 브랜치 삭제, 이동 undo → 옛 위치
    bookmark_set(p, "t", &c0, false).unwrap();
    bookmark_set(p, "t", &c1, false).unwrap();
    undo(p).unwrap();
    assert_eq!(branch(p, "t"), c0);
    // 연속 undo는 더 거슬러 간다
    undo(p).unwrap();
    assert_eq!(branch(p, "t"), "");
    // 아무것도 안 남으면 거절(루트 위 add workspace·import까지만)
    for _ in 0..20 {
        if undo(p).is_err() {
            break;
        }
    }
    let e = undo(p).unwrap_err();
    assert_eq!(code(e.clone()), "jj.cannotUndo", "{e:?}");
    fsck(p);
}

#[test]
fn undo_with_dirty_working_copy_undoes_the_snapshot_like_jj_cli() {
    let d = repo();
    let p = d.path();
    let c0 = git(p, &["rev-parse", "main~1"]);
    bookmark_set(p, "keepme", &c0, false).unwrap();
    write(p, "keep.txt", "mine\n");
    undo(p).unwrap();
    // jj CLI처럼: 먼저 snapshot operation이 생기고, undo는 그 snapshot을 취소한다(북마크는 그대로, 작업 폴더의 새 파일은 사라짐)
    let ops = op_log(p, None).unwrap();
    assert!(ops[0].description.starts_with("undo: restore to operation "), "{ops:?}");
    assert_eq!(ops[1].description, "snapshot working copy");
    assert!(!ops[0].id.is_empty() && ops[0].short.len() == 12 && ops[0].time > 0);
    assert_eq!(branch(p, "keepme"), c0);
    assert!(!p.join("keep.txt").exists());
    // 변경은 snapshot operation 시점으로 restore하면 돌아온다
    op_restore(p, &ops[1].id).unwrap();
    assert_eq!(std::fs::read_to_string(p.join("keep.txt")).unwrap(), "mine\n");
    fsck(p);
}

#[test]
fn op_restore_returns_to_that_state() {
    let d = repo();
    let p = d.path();
    let (c1, c0) = (git(p, &["rev-parse", "main"]), git(p, &["rev-parse", "main~1"]));
    bookmark_set(p, "r", &c0, false).unwrap();
    let target = op_log(p, None).unwrap()[0].id.clone();
    bookmark_set(p, "r", &c1, false).unwrap();
    bookmark_set(p, "s", &c1, false).unwrap();
    edit(p, &c0).unwrap();
    op_restore(p, &target).unwrap();
    assert_eq!(branch(p, "r"), c0);
    assert_eq!(branch(p, "s"), "");
    assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "v1\n");
    head_is_wc_parent(p);
    // 접두로도, 대문자도
    let o = op_log(p, None).unwrap();
    assert!(o[0].description.starts_with("restore to operation "));
    let first = o.iter().find(|e| e.description.starts_with("create bookmark r")).unwrap().id.to_uppercase();
    op_restore(p, &first[..20]).unwrap();
    assert_eq!(branch(p, "r"), c0);
    fsck(p);
}

#[test]
fn remote_bookmark_listing_and_track() {
    let d = repo();
    let p = d.path();
    let c0 = git(p, &["rev-parse", "main~1"]);
    git(p, &["update-ref", "refs/remotes/origin/dev", &c0]);
    bookmark_set(p, "z", &c0, false).unwrap(); // 아무 jj 작업이든 밖에서 바뀐 ref를 가져온다
    let b = bookmarks(p).unwrap();
    let dev = b.iter().find(|b| b.name == "dev").unwrap();
    assert!(!dev.local);
    assert_eq!((dev.remotes[0].remote.as_str(), dev.remotes[0].sha.clone(), dev.remotes[0].tracked), ("origin", Some(c0.clone()), false));
    assert!(b.iter().all(|b| b.remotes.iter().all(|r| r.remote != "git")));
    assert_eq!(code(bookmark_track(p, "nope", "origin").unwrap_err()), "jj.noBookmark");
    bookmark_track(p, "dev", "origin").unwrap();
    let b = bookmarks(p).unwrap();
    let dev = b.iter().find(|b| b.name == "dev").unwrap();
    assert!(dev.local && dev.target.as_deref() == Some(c0.as_str()) && dev.remotes[0].tracked);
    assert_eq!(branch(p, "dev"), c0);
    bookmark_track(p, "dev", "origin").unwrap(); // 멱등
    fsck(p);
}

#[test]
fn concurrent_bookmark_writes_stay_linear() {
    let d = repo();
    let p = d.path().to_path_buf();
    let c1 = git(&p, &["rev-parse", "main"]);
    let hs: Vec<_> = (0..8)
        .map(|i| {
            let (p, c1) = (p.clone(), c1.clone());
            std::thread::spawn(move || bookmark_set(&p, &format!("t{i}"), &c1, false).unwrap())
        })
        .collect();
    for h in hs {
        h.join().unwrap();
    }
    for i in 0..8 {
        assert_eq!(branch(&p, &format!("t{i}")), c1);
    }
    // operation 사슬이 갈라지지 않았다(jj가 head 하나로 읽는다) 
    assert!(op_log(&p, Some(1000)).unwrap().iter().filter(|o| o.description.starts_with("create bookmark")).count() == 8);
    let w = status(&p).unwrap();
    assert!(w.working_copy.is_some());
    fsck(&p);
}

/// 같은 순서를 jj CLI로 해 보고 git 브랜치·HEAD 트리·커밋 모양이 같은지 맞댄다(CLI 없으면 건너뜀).
#[test]
fn cross_check_undo_restore_bookmarks_with_jj_cli() {
    if Command::new("jj").arg("--version").output().map(|o| !o.status.success()).unwrap_or(true) {
        return;
    }
    let jj = |dir: &Path, args: &[&str]| {
        let o = Command::new("jj")
            .args(["--config", "user.name=t", "--config", "user.email=t@t", "--no-pager"])
            .args(args)
            .env("JJ_EDITOR", "true")
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(o.status.success(), "jj {args:?}: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8(o.stdout).unwrap()
    };
    let refs = |p: &Path| (git(p, &["for-each-ref", "--format=%(refname) %(tree) %(contents:subject)", "refs/heads"]), git(p, &["rev-parse", "--abbrev-ref", "HEAD"]), git(p, &["rev-parse", "HEAD^{tree}"]));
    let ours = repo();
    let theirs = tempfile::tempdir().unwrap();
    let (p, t) = (ours.path(), theirs.path());
    git(t, &["init", "-q", "-b", "main"]);
    for i in 0..2 {
        write(t, "a.txt", &format!("v{i}\n"));
        git(t, &["add", "."]);
        git(t, &["commit", "-q", "-m", &format!("c{i}")]);
    }
    jj(t, &["git", "init", "--colocate"]);
    let c1 = git(p, &["rev-parse", "main"]);
    let c0 = git(p, &["rev-parse", "main~1"]);
    // 북마크 생성·이동(뒤로)·삭제
    bookmark_set(p, "b", &c1, false).unwrap();
    jj(t, &["bookmark", "create", "b", "-r", "main"]);
    assert_eq!(refs(p), refs(t));
    assert_eq!(code(bookmark_set(p, "b", &c0, false).unwrap_err()), "jj.bookmarkBackwards");
    assert!(Command::new("jj").args(["--config", "user.name=t", "--config", "user.email=t@t", "bookmark", "set", "b", "-r", "main-"]).current_dir(t).output().map(|o| !o.status.success()).unwrap());
    bookmark_set(p, "b", &c0, true).unwrap();
    jj(t, &["bookmark", "set", "b", "-r", "main-", "--allow-backwards"]);
    assert_eq!(refs(p), refs(t));
    // undo(북마크 이동 되돌리기) · 한 번 더(생성 되돌리기)
    undo(p).unwrap();
    jj(t, &["undo"]);
    assert_eq!(refs(p), refs(t));
    undo(p).unwrap();
    jj(t, &["undo"]);
    assert_eq!(refs(p), refs(t));
    // describe → undo, edit → undo(작업 폴더·HEAD)
    describe(p, &c1, "rw").unwrap();
    jj(t, &["describe", "-m", "rw", "main"]);
    assert_eq!(refs(p), refs(t));
    undo(p).unwrap();
    jj(t, &["undo"]);
    assert_eq!(refs(p), refs(t));
    edit(p, &c0).unwrap();
    jj(t, &["edit", "main-"]);
    undo(p).unwrap();
    jj(t, &["undo"]);
    assert_eq!(refs(p), refs(t));
    assert_eq!(git(p, &["status", "--porcelain"]), git(t, &["status", "--porcelain"]));
    assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), std::fs::read_to_string(t.join("a.txt")).unwrap());
    // 삭제 후 op restore(삭제 전 시점)
    bookmark_set(p, "d", &c1, false).unwrap();
    jj(t, &["bookmark", "create", "d", "-r", "main"]);
    let before = op_log(p, None).unwrap()[0].id.clone();
    let tbefore = jj(t, &["op", "log", "--no-graph", "-n1", "-T", "id.short(12)"]);
    bookmark_delete(p, "d").unwrap();
    jj(t, &["bookmark", "delete", "d"]);
    assert_eq!(refs(p), refs(t));
    op_restore(p, &before).unwrap();
    jj(t, &["op", "restore", tbefore.trim()]);
    assert_eq!(refs(p), refs(t));
}

// ---- 30f 리뷰 반영 ----

fn has_jj() -> bool {
    Command::new("jj").arg("--version").output().map(|o| o.status.success()).unwrap_or(false)
}
fn jjc(dir: &Path, args: &[&str]) -> String {
    let o = Command::new("jj")
        .args(["--config", "user.name=t", "--config", "user.email=t@t", "--no-pager"])
        .args(args)
        .env("JJ_EDITOR", "true")
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(o.status.success(), "jj {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8(o.stdout).unwrap()
}
/// 브랜치·HEAD·HEAD 트리(앱과 CLI 결과 비교용)
fn refs_state(p: &Path) -> (String, String, String) {
    (
        git(p, &["for-each-ref", "--format=%(refname) %(tree) %(contents:subject)", "refs/heads"]),
        git(p, &["rev-parse", "--abbrev-ref", "HEAD"]),
        git(p, &["rev-parse", "HEAD^{tree}"]),
    )
}

#[test]
fn restore_refuses_root_and_add_workspace_by_position() {
    let d = repo();
    let p = d.path();
    let c0 = git(p, &["rev-parse", "main~1"]);
    bookmark_set(p, "x", &c0, false).unwrap();
    let ops = op_log(p, None).unwrap();
    let add_ws = ops.iter().find(|o| o.description.starts_with("add workspace")).unwrap().id.clone();
    let import = ops.iter().find(|o| o.description == "import git refs").unwrap().id.clone();
    let (refs, head, n) = (all_refs(p), git(p, &["rev-parse", "HEAD"]), ops.len());
    for id in [add_ws.as_str(), &"0".repeat(128), &add_ws[..16], "0000"] {
        let e = op_restore(p, id).unwrap_err();
        assert_eq!(code(e.clone()), "jj.cannotUndo", "{id}: {e:?}");
        assert_eq!((all_refs(p), git(p, &["rev-parse", "HEAD"]), op_log(p, None).unwrap().len()), (refs.clone(), head.clone(), n));
    }
    // jj를 켠 `import git refs` 시점으로는 돌아갈 수 있다
    op_restore(p, &import).unwrap();
    assert_eq!(branch(p, "x"), "");
    assert_eq!(git(p, &["rev-parse", "HEAD"]), parents(p, &wc(p))[0]);
    fsck(p);
}

#[test]
fn ambiguous_prefix_and_missing_prefix_have_own_codes() {
    let d = repo();
    let p = d.path();
    let c0 = git(p, &["rev-parse", "main~1"]);
    for i in 0..24 {
        bookmark_set(p, &format!("n{i}"), &c0, false).unwrap();
    }
    let ops = op_log(p, Some(1000)).unwrap();
    let n = ops.len();
    // 첫 글자가 같은 operation이 둘 이상인 접두(24개 넘게 있으면 비둘기집 원리로 있다)
    let pre = "0123456789abcdef".chars().map(String::from).find(|c| ops.iter().filter(|o| o.id.starts_with(c.as_str())).count() > 1).unwrap();
    assert_eq!(code(op_restore(p, &pre).unwrap_err()), "jj.ambiguousOpId");
    assert_eq!(op_log(p, Some(1000)).unwrap().len(), n);
    // 유일한 접두는 된다(1자 하한은 CLI와 같다), 없는 접두는 noOperation
    let mut len = 1;
    let target = &ops[3].id;
    while ops.iter().filter(|o| o.id.starts_with(&target[..len])).count() > 1 {
        len += 1;
    }
    op_restore(p, &target[..len]).unwrap();
    let no = "123456789abcdef".chars().map(|c| format!("{c}{c}{c}{c}{c}{c}")).find(|x| !ops.iter().any(|o| o.id.starts_with(x.as_str()))).unwrap();
    assert_eq!(code(op_restore(p, &no).unwrap_err()), "jj.noOperation");
}

#[test]
fn rejected_rewinds_do_not_touch_op_log_even_with_dirty_working_copy() {
    let d = repo();
    let p = d.path();
    let n = op_log(p, Some(1000)).unwrap().len();
    // 깨끗한 상태: jj를 켠 operation 앞으로는 undo 불가
    assert_eq!(code(undo(p).unwrap_err()), "jj.cannotUndo");
    assert_eq!(op_log(p, Some(1000)).unwrap().len(), n);
    // 더러운 작업 사본 + 거절될 요청: snapshot operation이 생기지 않고 파일은 그대로
    write(p, "dirty.txt", "d\n");
    for id in ["0".repeat(128), "zz".to_string(), "1".repeat(129)] {
        assert!(op_restore(p, &id).is_err());
        assert_eq!(op_log(p, Some(1000)).unwrap().len(), n, "{id}");
        assert_eq!(std::fs::read_to_string(p.join("dirty.txt")).unwrap(), "d\n");
    }
    let ops = op_log(p, Some(1000)).unwrap();
    let add_ws = ops.iter().find(|o| o.description.starts_with("add workspace")).unwrap().id.clone();
    assert_eq!(code(op_restore(p, &add_ws).unwrap_err()), "jj.cannotUndo");
    assert_eq!(op_log(p, Some(1000)).unwrap().len(), n);
    // 받아들여지는 요청이면 snapshot operation이 그 head의 자식으로 생기고 대상은 그 조상이다
    let import = ops.iter().find(|o| o.description == "import git refs").unwrap().id.clone();
    op_restore(p, &import).unwrap();
    let after = op_log(p, Some(1000)).unwrap();
    assert_eq!(after.len(), n + 2);
    assert!(after[0].description.starts_with("restore to operation "));
    assert_eq!(after[1].description, "snapshot working copy");
    assert_eq!(after[2].id, ops[0].id);
    fsck(p);
}

#[test]
fn bookmark_on_root_commit_is_refused_up_front() {
    let d = repo();
    let p = d.path();
    let n = op_log(p, None).unwrap().len();
    let e = bookmark_set(p, "r", &"0".repeat(40), true).unwrap_err();
    assert_eq!(code(e), "jj.rootCommit");
    assert_eq!(op_log(p, None).unwrap().len(), n);
    assert_eq!(code(bookmark_set(p, "r", &"1".repeat(40), true).unwrap_err()), "jj.noCommit");
}

#[test]
fn op_log_follows_merged_operation_branches_like_jj_cli() {
    if !has_jj() {
        return;
    }
    let d = repo();
    let p = d.path();
    let c0 = git(p, &["rev-parse", "main~1"]);
    bookmark_set(p, "a", &c0, false).unwrap();
    // 한 operation 앞(@-)에서 갈라진 operation을 만든 뒤 다음 작업이 둘을 병합한다
    let prev = jjc(p, &["op", "log", "--no-graph", "-n1", "-T", "id.short(16)", "--at-op=@-"]);
    jjc(p, &["--at-op", prev.trim(), "bookmark", "create", "side", "-r", "main"]);
    bookmark_set(p, "b", &c0, false).unwrap();
    let ours: Vec<String> = op_log(p, Some(1000)).unwrap().into_iter().map(|o| o.id).collect();
    let mut cli: Vec<String> = jjc(p, &["op", "log", "--no-graph", "-T", r#"id ++ "\n""#]).lines().map(String::from).collect();
    cli.retain(|l| !l.is_empty() && !l.bytes().all(|b| b == b'0'));
    assert_eq!(ours, cli);
    // 병합 operation이 있고 갈라진 쪽 operation도 나온다
    let descs: Vec<String> = op_log(p, Some(1000)).unwrap().into_iter().map(|o| o.description).collect();
    assert!(descs.iter().any(|d| d.contains("bookmark side")), "{descs:?}");
}

#[test]
fn undo_interleaved_with_jj_cli_both_orders() {
    if !has_jj() {
        return;
    }
    for app_first in [false, true] {
        let ours = repo();
        let theirs = tempfile::tempdir().unwrap();
        let (p, t) = (ours.path(), theirs.path());
        git(t, &["init", "-q", "-b", "main"]);
        for i in 0..2 {
            write(t, "a.txt", &format!("v{i}\n"));
            git(t, &["add", "."]);
            git(t, &["commit", "-q", "-m", &format!("c{i}")]);
        }
        jjc(t, &["git", "init", "--colocate"]);
        let c1 = git(p, &["rev-parse", "main"]);
        for n in ["a", "b", "c", "d"] {
            bookmark_set(p, n, &c1, false).unwrap();
            jjc(t, &["bookmark", "create", n, "-r", "main"]);
        }
        assert_eq!(refs_state(p), refs_state(t));
        // 서로 번갈아 undo: 어느 쪽이 먼저든 연속 undo를 서로 알아봐 한 단계씩 더 거슬러 간다
        for (i, cli_turn) in [app_first, !app_first, app_first, !app_first].iter().enumerate() {
            if *cli_turn {
                jjc(p, &["undo"]);
            } else {
                undo(p).unwrap();
            }
            jjc(t, &["undo"]);
            assert_eq!(refs_state(p), refs_state(t), "app_first={app_first} step {i}");
        }
        assert_eq!(branch(p, "a"), "");
        // 설명은 CLI와 같은 형식(전체 ID)이라 CLI로 이어서 op log를 읽어도 undo로 보인다
        let first = jjc(p, &["op", "log", "--no-graph", "-n1", "-T", "description"]);
        assert!(first.starts_with("undo: restore to operation ") && first.trim().len() == "undo: restore to operation ".len() + 128, "{first}");
        fsck(p);
    }
}

// ---- 30f 2차 리뷰 반영 ----

/// 커밋 2개가 있는 git 저장소를 jj CLI(`jj git init --colocate`)로 켠다(op 구성: add workspace → import git refs → import git head)
fn cli_repo() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    for i in 0..2 {
        write(p, "a.txt", &format!("v{i}\n"));
        git(p, &["add", "."]);
        git(p, &["commit", "-q", "-m", &format!("c{i}")]);
    }
    jjc(p, &["git", "init", "--colocate"]);
    d
}

#[test]
fn cli_initialized_repo_cannot_go_back_before_import() {
    if !has_jj() {
        return;
    }
    let d = cli_repo();
    let p = d.path();
    let c0 = git(p, &["rev-parse", "main~1"]);
    bookmark_set(p, "a", &c0, false).unwrap();
    let ops = op_log(p, None).unwrap();
    let add_ws = ops.iter().find(|o| o.description.starts_with("add workspace")).unwrap().id.clone();
    let state = |p: &Path| (all_refs(p), git(p, &["rev-parse", "HEAD"]), git(p, &["status", "--porcelain"]), std::fs::read_to_string(p.join("a.txt")).unwrap(), op_log(p, None).unwrap().len());
    let before = state(p);
    for id in [add_ws.as_str(), &add_ws[..16], &"0".repeat(128)] {
        assert_eq!(code(op_restore(p, id).unwrap_err()), "jj.cannotUndo");
        assert_eq!(state(p), before);
    }
    // 연속 undo는 `add workspace` 앞에서 멈춘다(그 앞 상태 = 가져오기 전)
    let mut n = 0;
    let e = loop {
        match undo(p) {
            Ok(_) => n += 1,
            Err(e) => break e,
        }
        assert!(n < 20);
    };
    assert_eq!(code(e), "jj.cannotUndo");
    assert_eq!(branch(p, "main"), git(p, &["rev-parse", "main"]));
}

/// `jj new 'root()'`는 jj CLI가 허용하는 정상 작업이다(HEAD가 `refs/jj/root`가 되고 `main`은 그대로): 그 operation 뒤의 undo·그 operation으로의 restore가 막히면 안 된다
#[test]
fn states_after_jj_new_root_are_restorable_like_jj_cli() {
    if !has_jj() {
        return;
    }
    let d = cli_repo();
    let p = d.path();
    jjc(p, &["new", "root()"]);
    let at_root = op_log(p, None).unwrap()[0].id.clone();
    let main = git(p, &["rev-parse", "main"]);
    undo(p).unwrap(); // `@`가 다시 main 위로
    assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "v1\n");
    op_restore(p, &at_root).unwrap(); // 다시 루트 위로
    assert_eq!(git(p, &["rev-parse", "main"]), main);
    undo(p).unwrap();
    assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "v1\n");
}

/// 고아 브랜치·detached HEAD·태그만 있는 저장소: git_refs나 git_head가 채워져 켜기 전만 막히고, 켠 뒤 상태는 허용된다
#[test]
fn orphan_detached_and_tag_only_repos() {
    if !has_jj() {
        return;
    }
    for kind in ["orphan", "detached", "tag-only"] {
        let d = tempfile::tempdir().unwrap();
        let p = d.path();
        git(p, &["init", "-q", "-b", "main"]);
        for i in 0..2 {
            write(p, "a.txt", &format!("v{i}\n"));
            git(p, &["add", "."]);
            git(p, &["commit", "-q", "-m", &format!("c{i}")]);
        }
        match kind {
            "orphan" => {
                git(p, &["checkout", "-q", "--orphan", "orph"]);
                git(p, &["commit", "-q", "--allow-empty", "-m", "o"]);
            }
            "detached" => {
                git(p, &["checkout", "-q", "--detach", "main~1"]);
            }
            _ => {
                git(p, &["tag", "v1"]);
                git(p, &["checkout", "-q", "--detach", "v1"]);
                git(p, &["branch", "-D", "main"]);
            }
        }
        jjc(p, &["git", "init", "--colocate"]);
        let c = git(p, &["rev-parse", "HEAD"]);
        bookmark_set(p, "x", &c, false).unwrap();
        let ops = op_log(p, None).unwrap();
        let add_ws = ops.iter().find(|o| o.description.starts_with("add workspace")).unwrap().id.clone();
        assert_eq!(code(op_restore(p, &add_ws).unwrap_err()), "jj.cannotUndo", "{kind}");
        // 켠 뒤(가져온 기록이 있는) 시점은 허용
        let import = ops.iter().find(|o| o.description == "import git refs").unwrap().id.clone();
        op_restore(p, &import).unwrap_or_else(|e| panic!("{kind}: {e:?}"));
        assert_eq!(branch(p, "x"), "", "{kind}");
    }
}

/// "커밋이 있는지"는 HEAD·브랜치만이 아니라 `refs/` 전체로: 태그만, `refs/jj/keep`만 남은 경우에도 켜기 전으로 못 간다
#[test]
fn pre_enable_is_refused_when_only_tags_or_keep_refs_hold_commits() {
    for kind in ["tag", "keep"] {
        let d = tempfile::tempdir().unwrap();
        let p = d.path();
        git(p, &["init", "-q", "-b", "main"]);
        for i in 0..2 {
            write(p, "a.txt", &format!("v{i}\n"));
            git(p, &["add", "."]);
            git(p, &["commit", "-q", "-m", &format!("c{i}")]);
        }
        enable(p).unwrap();
        let add_ws = op_log(p, None).unwrap().into_iter().find(|o| o.description.starts_with("add workspace")).unwrap().id;
        let c1 = git(p, &["rev-parse", "main"]);
        if kind == "tag" {
            git(p, &["tag", "only-tag"]);
        }
        // 브랜치·HEAD는 없앤다. 남는 것: 태그 또는 jj가 둔 keep ref
        git(p, &["update-ref", "--no-deref", "HEAD", &c1]);
        git(p, &["update-ref", "-d", "refs/heads/main"]);
        git(p, &["checkout", "-q", "--orphan", "unborn"]);
        git(p, &["rm", "-rfq", "--cached", "."]);
        assert_eq!(git(p, &["for-each-ref", "refs/heads"]), "");
        if kind == "keep" {
            
            assert!(!git(p, &["for-each-ref", "refs/jj/keep"]).is_empty());
            assert_eq!(git(p, &["for-each-ref", "refs/tags"]), "");
        } else {
            // 태그 외 keep ref도 지워 태그만 남긴다
            for r in git(p, &["for-each-ref", "--format=%(refname)", "refs/jj/keep"]).lines() {
                git(p, &["update-ref", "-d", r]);
            }
            assert!(!git(p, &["for-each-ref", "refs/tags"]).is_empty());
        }
        let e = op_restore(p, &add_ws).unwrap_err();
        assert_eq!(code(e.clone()), "jj.cannotUndo", "{kind}: {e:?}");
    }
}

#[test]
fn repo_without_commits_allows_restoring_to_its_initial_state() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    enable(p).unwrap();
    let w = wc(p);
    describe(p, &w, "first").unwrap();
    let w = wc(p);
    describe(p, &w, "second").unwrap();
    undo(p).unwrap();
    undo(p).unwrap();
    assert_eq!(msg(p, &wc(p)), "");
    fsck(p);
}

#[test]
fn undo_with_merge_operation_at_head_is_refused() {
    if !has_jj() {
        return;
    }
    let d = repo();
    let p = d.path();
    let c0 = git(p, &["rev-parse", "main~1"]);
    bookmark_set(p, "a", &c0, false).unwrap();
    let prev = jjc(p, &["op", "log", "--no-graph", "-n1", "-T", "id.short(16)", "--at-op=@-"]);
    jjc(p, &["--at-op", prev.trim(), "bookmark", "create", "side", "-r", "main"]);
    // 갈라진 operation 둘이 head: 다음 로드가 병합 operation을 만들고, 그것이 head라 undo는 거절된다
    let e = undo(p).unwrap_err();
    assert_eq!(code(e.clone()), "jj.cannotUndo", "{e:?}");
    assert!(op_log(p, None).unwrap()[0].description.contains("reconcile"), "{:?}", op_log(p, Some(2)));
}

fn cli_op_id(dir: &Path, needle: &str) -> String {
    jjc(dir, &["op", "log", "--no-graph", "-T", r#"id ++ " " ++ description.first_line() ++ "\n""#])
        .lines()
        .find(|l| l.contains(needle))
        .map(|l| l.split(' ').next().unwrap().to_string())
        .unwrap()
}

#[test]
fn cross_check_undo_sequences_with_jj_cli() {
    if !has_jj() {
        return;
    }
    for restore_first in [false, true] {
        let ours = repo();
        let theirs = tempfile::tempdir().unwrap();
        let (p, t) = (ours.path(), theirs.path());
        git(t, &["init", "-q", "-b", "main"]);
        for i in 0..2 {
            write(t, "a.txt", &format!("v{i}\n"));
            git(t, &["add", "."]);
            git(t, &["commit", "-q", "-m", &format!("c{i}")]);
        }
        jjc(t, &["git", "init", "--colocate"]);
        let c1 = git(p, &["rev-parse", "main"]);
        for n in ["a", "b", "c", "d"] {
            bookmark_set(p, n, &c1, false).unwrap();
            jjc(t, &["bookmark", "create", n, "-r", "main"]);
        }
        let same = |step: &str| assert_eq!(refs_state(p), refs_state(t), "restore_first={restore_first} {step}");
        if restore_first {
            // op restore → undo → undo
            let mine = op_log(p, None).unwrap().into_iter().find(|o| o.description.starts_with("create bookmark b")).unwrap().id;
            op_restore(p, &mine).unwrap();
            jjc(t, &["op", "restore", &cli_op_id(t, "create bookmark b")]);
            same("restore");
            undo(p).unwrap();
            jjc(t, &["undo"]);
            same("undo 1");
            undo(p).unwrap();
            jjc(t, &["undo"]);
            same("undo 2");
        } else {
            // undo → 다른 작업 → undo → undo
            undo(p).unwrap();
            jjc(t, &["undo"]);
            same("undo");
            bookmark_set(p, "e", &c1, false).unwrap();
            jjc(t, &["bookmark", "create", "e", "-r", "main"]);
            same("other op");
            undo(p).unwrap();
            jjc(t, &["undo"]);
            same("undo 1");
            undo(p).unwrap();
            jjc(t, &["undo"]);
            same("undo 2");
        }
        fsck(p);
    }
}

// ---- 30f 4차 리뷰: 사용자 커밋 판정 ----

fn first_op_id(p: &Path, prefix: &str) -> String {
    op_log(p, None).unwrap().into_iter().find(|o| o.description.starts_with(prefix)).unwrap().id
}

#[test]
fn empty_user_commits_count_as_commits() {
    // 빈 최초 커밋 + 브랜치
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    git(p, &["commit", "-q", "--allow-empty", "-m", "init"]);
    enable(p).unwrap();
    let w = wc(p);
    describe(p, &w, "work").unwrap();
    let add_ws = first_op_id(p, "add workspace");
    let main = git(p, &["rev-parse", "main"]);
    let e = op_restore(p, &add_ws).unwrap_err();
    assert_eq!(code(e), "jj.cannotUndo");
    assert_eq!(git(p, &["rev-parse", "main"]), main);
    // 빈 루트 커밋을 annotated tag만 가리키고 브랜치·HEAD는 없다
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    git(p, &["commit", "-q", "--allow-empty", "-m", "init"]);
    git(p, &["tag", "-a", "-m", "release", "v1"]);
    enable(p).unwrap();
    let add_ws = first_op_id(p, "add workspace");
    git(p, &["checkout", "-q", "--orphan", "unborn"]);
    git(p, &["update-ref", "-d", "refs/heads/main"]);
    assert_eq!(git(p, &["for-each-ref", "--format=%(objecttype)", "refs/tags"]), "tag");
    assert_eq!(git(p, &["for-each-ref", "refs/heads"]), "");
    let e = op_restore(p, &add_ws).unwrap_err();
    assert_eq!(code(e), "jj.cannotUndo");
}

#[test]
fn repo_without_user_commits_still_allows_going_back_even_with_jj_commits() {
    // 커밋 없는 저장소에서 jj로 커밋을 몇 개 만들어도(change-id가 있는 jj 커밋) 켜기 직후 상태로 돌아갈 수 있다
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    enable(p).unwrap();
    let w = wc(p);
    describe(p, &w, "a").unwrap();
    new_commit(p, &[wc(p)]).unwrap();
    write(p, "f.txt", "x\n");
    describe(p, &wc(p), "b").unwrap();
    assert!(!git(p, &["for-each-ref", "refs/jj/keep"]).is_empty());
    let import = first_op_id(p, "import git refs");
    op_restore(p, &import).unwrap();
}

// ---- disable ----

use gc_jj::{disable, disable_check};

/// 확인(check) 직후 그 op로 진행하는 것(UI가 하는 순서)
fn disable_now(p: &Path) -> Result<Vec<gc_i18n::Coded>, gc_i18n::Coded> {
    let c = disable_check(p)?;
    disable(p, &c.op_id)
}

/// jj가 아닌 ref 전체와 그것이 가리키는 커밋 집합, 작업 폴더 파일·내용, status, 인덱스
fn git_snapshot(p: &Path) -> (String, String, Vec<(String, String)>, String, String) {
    let refs = git(p, &["for-each-ref", "--format=%(refname) %(objectname)"])
        .lines()
        .filter(|l| !l.starts_with("refs/jj/") && !l.starts_with("refs/git403/"))
        .collect::<Vec<_>>()
        .join("\n");
    let commits = git(p, &["rev-list", "--branches", "--tags", "--remotes"]);
    let mut files = Vec::new();
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, String)>) {
        for e in std::fs::read_dir(dir).unwrap() {
            let e = e.unwrap();
            let name = e.file_name().to_string_lossy().into_owned();
            if name == ".git" || name == ".jj" {
                continue;
            }
            if e.path().is_dir() {
                walk(base, &e.path(), out);
            } else {
                out.push((e.path().strip_prefix(base).unwrap().to_string_lossy().into_owned(), std::fs::read_to_string(e.path()).unwrap_or_default()));
            }
        }
    }
    walk(p, p, &mut files);
    files.sort();
    (refs, commits, files, git(p, &["status", "--porcelain"]), git(p, &["ls-files", "-s"]))
}

fn codes(w: &[gc_i18n::Coded]) -> Vec<String> {
    w.iter().map(|c| c.code.to_string()).collect()
}

fn head_ref(p: &Path) -> String {
    let o = Command::new("git").args(["symbolic-ref", "-q", "HEAD"]).current_dir(p).output().unwrap();
    String::from_utf8(o.stdout).unwrap().trim().to_string()
}

/// main 위에서 jj 작업을 하고(HEAD는 detached) 미저장 변경이 있는 저장소
fn busy_repo() -> tempfile::TempDir {
    let d = repo();
    let p = d.path();
    git(p, &["tag", "v1", "main~1"]);
    git(p, &["update-ref", "refs/remotes/origin/dev", "main~1"]);
    // main~1 위에서 작업(HEAD는 detached, 그 커밋을 가리키는 브랜치는 `side` 하나)
    git(p, &["branch", "side", "main~1"]);
    let c0 = git(p, &["rev-parse", "main~1"]);
    new_commit(p, std::slice::from_ref(&c0)).unwrap();
    write(p, "u.txt", "unsaved\n");
    describe(p, &wc(p), "wip").unwrap();
    write(p, "u2.txt", "more unsaved\n"); // snapshot되지 않은 변경
    d
}

#[test]
fn disable_detaches_jj_and_keeps_everything_else() {
    let d = busy_repo();
    let p = d.path();
    assert_eq!(head_ref(p), "", "detached");
    let before = git_snapshot(p);
    assert!(git(p, &["for-each-ref", "refs/jj"]).contains("refs/jj/keep"));
    let w = disable_now(p).unwrap();
    // 설명이 있는 `@`(wip)는 어느 브랜치·태그에서도 안 닿으므로 보존 ref로 남는다
    assert_eq!(codes(&w), vec!["jj.disableKept"], "{w:?}");
    let kept = git(p, &["for-each-ref", "--format=%(objectname)", "refs/git403/jj-orphans"]);
    assert_eq!(kept.lines().count(), 1);
    assert_eq!(git(p, &["log", "-1", "--format=%s", kept.trim()]), "wip");
    assert_eq!(head_ref(p), "refs/heads/side");
    assert_eq!(git(p, &["for-each-ref", "refs/jj"]), "");
    assert!(!p.join(".jj").exists());
    assert_eq!(git_snapshot(p), before);
    assert_eq!(std::fs::read_to_string(p.join("u2.txt")).unwrap(), "more unsaved\n");
    assert!(git(p, &["status", "--porcelain"]).contains("u2.txt"));
    fsck(p);
    git(p, &["rev-parse", "--verify", "v1"]);
    // 다시 켤 수 있다
    enable(p).unwrap();
    assert!(status(p).unwrap().working_copy.is_some());
    new_commit(p, &[git(p, &["rev-parse", "main"])]).unwrap();
    fsck(p);
    // 켜져 있지 않으면 거절
    let d2 = tempfile::tempdir().unwrap();
    git(d2.path(), &["init", "-q"]);
    assert_eq!(code(disable_now(d2.path()).unwrap_err()), "jj.notEnabled");
}

#[test]
fn disable_matches_rm_rf_dot_jj_of_jj_cli_apart_from_head_and_jj_refs() {
    if !has_jj() {
        return;
    }
    let d = cli_repo();
    let p = d.path();
    git(p, &["tag", "v1", "main~1"]);
    git(p, &["branch", "side", "main~1"]);
    jjc(p, &["new", "main-"]);
    write(p, "u.txt", "unsaved\n");
    jjc(p, &["describe", "-m", "wip"]);
    write(p, "u2.txt", "more\n");
    // 같은 상태의 복사본: 하나는 `rm -rf .jj`, 하나는 disable
    let copy = tempfile::tempdir().unwrap();
    let q = copy.path();
    assert!(Command::new("cp").args(["-R", &format!("{}/.", p.display()), &q.display().to_string()]).status().unwrap().success());
    std::fs::remove_dir_all(q.join(".jj")).unwrap();
    let w = disable_now(p).unwrap();
    assert_eq!(codes(&w), vec!["jj.disableKept"], "{w:?}");
    assert_eq!(git_snapshot(p), git_snapshot(q));
    // 차이: ours는 HEAD가 브랜치로 돌아오고 refs/jj가 없다
    assert_eq!(head_ref(p), "refs/heads/side");
    assert_eq!(head_ref(q), "");
    assert_eq!(git(p, &["for-each-ref", "refs/jj"]), "");
    assert!(!git(q, &["for-each-ref", "refs/jj"]).is_empty());
    fsck(p);
}

#[test]
fn disable_warns_when_head_cannot_be_attached() {
    // 같은 커밋을 가리키는 브랜치가 둘
    let d = repo();
    let p = d.path();
    git(p, &["branch", "other", "main~1"]);
    git(p, &["branch", "another", "main~1"]);
    new_commit(p, &[git(p, &["rev-parse", "main~1"])]).unwrap();
    let w = disable_now(p).unwrap();
    assert_eq!(w.iter().map(|c| c.code.to_string()).collect::<Vec<_>>(), vec!["jj.disableDetached"]);
    assert_eq!(head_ref(p), "");
    assert_eq!(git(p, &["for-each-ref", "refs/jj"]), "");
    fsck(p);
    // 브랜치가 없다
    let d = repo();
    let p = d.path();
    let c0 = git(p, &["rev-parse", "main~1"]);
    new_commit(p, std::slice::from_ref(&c0)).unwrap();
    git(p, &["tag", "keep-it", &c0]);
    let w = disable_now(p).unwrap();
    assert_eq!(w.iter().map(|c| c.code.to_string()).collect::<Vec<_>>(), vec!["jj.disableDetached"]);
    assert_eq!(head_ref(p), "");
    assert_eq!(git(p, &["rev-parse", "HEAD"]), c0);
    fsck(p);
}

#[test]
fn disable_unborn_head_uses_a_free_default_branch_name_or_refuses() {
    // 루트 위 `@`: HEAD가 refs/jj/root를 향한다. `main`이 이미 있어도 거절하지 않고 빈 이름(`main-2`, 그것도 있으면 `main-3`…)을 골라 경고한다
    let d = repo();
    let p = d.path();
    git(p, &["branch", "main-2", "main"]);
    new_commit(p, &["0".repeat(40)]).unwrap();
    let w = disable_now(p).unwrap();
    assert_eq!(codes(&w), vec!["jj.disableUnbornBranch"], "{w:?}");
    assert_eq!(w[0].vars.iter().find(|(k, _)| *k == "name").map(|(_, v)| v.as_str()), Some("main-3"));
    assert_eq!(head_ref(p), "refs/heads/main-3");
    assert_eq!(git(p, &["for-each-ref", "refs/heads/main-3"]), "");
    fsck(p);
    // `main`이 없으면(이름을 바꿔 둠) 빈 기본 브랜치로 둔다(이미 있는 브랜치에 붙이지 않는다)
    let d = repo();
    let p = d.path();
    git(p, &["branch", "-m", "main", "other"]);
    new_commit(p, &["0".repeat(40)]).unwrap();
    let w = disable_now(p).unwrap();
    assert!(w.is_empty(), "{w:?}");
    let h = head_ref(p);
    assert!(h.starts_with("refs/heads/") && h != "refs/heads/other", "{h}");
    assert_eq!(git(p, &["for-each-ref", &h]), "", "새 브랜치는 아직 없다(커밋 없는 상태)");
    fsck(p);
}

#[test]
fn disable_check_changes_nothing_and_reports_what_would_be_kept() {
    let d = busy_repo();
    let p = d.path();
    let all = |p: &Path| (git(p, &["for-each-ref"]), op_log(p, None).unwrap().len(), git_snapshot(p), git(p, &["status", "--porcelain", "--ignored"]));
    let before = all(p);
    let c = disable_check(p).unwrap();
    assert_eq!(all(p), before);
    assert!(c.working_copy_described && !c.working_copy_merge && c.other_workspaces == 0);
    assert_eq!(c.orphans.len(), 1);
    assert_eq!(c.orphans[0].sha, wc(p));
    assert_eq!(c.orphans[0].description.trim(), "wip");
    assert_eq!(c.orphans[0].change_id.len(), 32);
    // 켜져 있지 않으면 jj.notEnabled
    let d2 = tempfile::tempdir().unwrap();
    git(d2.path(), &["init", "-q"]);
    assert_eq!(code(disable_check(d2.path()).unwrap_err()), "jj.notEnabled");
}

#[test]
fn kept_refs_keep_every_orphan_alive_through_gc_and_can_be_recovered() {
    let d = repo();
    let p = d.path();
    let c1 = git(p, &["rev-parse", "main"]);
    // 내용 있는 jj 커밋 둘(하나는 `@` 아래, 하나는 설명만 있고 비어 있음)과 설명 있는 `@`, 모두 브랜치·태그에 안 닿는다
    new_commit(p, std::slice::from_ref(&c1)).unwrap();
    write(p, "w.txt", "work\n");
    describe(p, &wc(p), "work one").unwrap();
    new_commit(p, std::slice::from_ref(&c1)).unwrap(); // `@`를 c1의 다른 자식으로: 위 커밋은 이름 없는 head로 남는다
    describe(p, &wc(p), "described empty").unwrap();
    let check = disable_check(p).unwrap();
    let shas: Vec<String> = check.orphans.iter().map(|o| o.sha.clone()).collect();
    assert_eq!(shas.len(), 2, "{check:?}");
    assert!(check.working_copy_described);
    let w = disable_now(p).unwrap();
    assert_eq!(codes(&w), vec!["jj.disableKept"], "{w:?}");
    assert!(w[0].message.contains("refs/git403/jj-orphans"));
    git(p, &["gc", "-q", "--prune=now"]);
    git(p, &["reflog", "expire", "--expire=now", "--all"]);
    git(p, &["gc", "-q", "--prune=now"]);
    for sha in &shas {
        git(p, &["cat-file", "-e", &format!("{sha}^{{commit}}")]);
    }
    let log = git(p, &["log", "--format=%s", "--glob=refs/git403/jj-orphans/*"]);
    assert!(log.contains("work one") && log.contains("described empty"), "{log}");
    fsck(p);
    // 복구: 브랜치로 만들고 다시 켜면 jj가 가져온다(`refs/git403/*` 자체는 jj가 가져오지 않는다)
    enable(p).unwrap();
    assert!(shas.iter().all(|s| !status(p).unwrap().change_ids.contains_key(s)), "refs/git403 is not imported by jj");
    for (i, sha) in shas.iter().enumerate() {
        git(p, &["branch", &format!("recovered{i}"), sha]);
    }
    describe(p, &wc(p), "after recover").unwrap(); // 아무 jj 작업이든 밖에서 바뀐 ref를 가져온다
    let ids = status(p).unwrap().change_ids;
    assert!(shas.iter().all(|s| ids.contains_key(s)), "branches made from the kept refs make the commits visible again");
}

#[test]
fn merge_working_copy_is_kept_with_both_parents() {
    let d = repo();
    let p = d.path();
    let (c0, c1) = (git(p, &["rev-parse", "main~1"]), git(p, &["rev-parse", "main"]));
    new_commit(p, &[c0.clone(), c1.clone()]).unwrap();
    let c = disable_check(p).unwrap();
    assert!(c.working_copy_merge && !c.working_copy_described);
    assert_eq!(c.orphans.len(), 1);
    let merge = c.orphans[0].sha.clone();
    let w = disable_now(p).unwrap();
    assert_eq!(codes(&w), vec!["jj.disableKept", "jj.disableDetached"], "{w:?}"); // HEAD(=첫 부모 c0)를 가리키는 브랜치가 없다
    assert_eq!(git(p, &["rev-parse", &format!("{merge}^@")]).lines().collect::<Vec<_>>(), vec![c0.as_str(), c1.as_str()]);
    // git HEAD에는 첫 부모만 남는다
    assert_eq!(git(p, &["rev-parse", "HEAD"]), c0);
    git(p, &["gc", "-q", "--prune=now"]);
    git(p, &["cat-file", "-e", &format!("{merge}^{{commit}}")]);
}

#[test]
fn hand_written_change_id_commits_are_kept_like_any_other() {
    let d = repo();
    let p = d.path();
    let tree = git(p, &["rev-parse", "main^{tree}"]);
    let c0 = git(p, &["rev-parse", "main~1"]);
    let obj = format!("tree {tree}\nparent {c0}\nauthor t <t@t> 1700000000 +0000\ncommitter t <t@t> 1700000000 +0000\nchange-id zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz\n\nhand made\n");
    let o = Command::new("git").args(["hash-object", "-t", "commit", "-w", "--stdin"]).current_dir(p).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().unwrap();
    use std::io::Write;
    o.stdin.as_ref().unwrap();
    let mut o = o;
    o.stdin.take().unwrap().write_all(obj.as_bytes()).unwrap();
    let sha = String::from_utf8(o.wait_with_output().unwrap().stdout).unwrap().trim().to_string();
    git(p, &["branch", "hand", &sha]);
    new_commit(p, std::slice::from_ref(&c0)).unwrap(); // 가져오기: hand가 보이는 커밋이 된다
    git(p, &["branch", "-D", "hand"]); // 이제 브랜치에서 안 닿는다(jj는 아직 보이는 커밋으로 알고 있다)
    let c = disable_check(p).unwrap();
    assert!(c.orphans.iter().any(|o| o.sha == sha && o.description.trim() == "hand made"), "{c:?}");
    disable_now(p).unwrap();
    assert_eq!(git(p, &["log", "--format=%s", "--glob=refs/git403/jj-orphans/*"]).lines().filter(|l| *l == "hand made").count(), 1);
}

#[test]
fn disable_refuses_when_other_workspaces_share_the_repo() {
    if !has_jj() {
        return;
    }
    let d = cli_repo();
    let p = d.path();
    let other = tempfile::tempdir().unwrap();
    jjc(p, &["workspace", "add", &other.path().join("ws2").to_string_lossy()]);
    let c = disable_check(p).unwrap();
    assert_eq!(c.other_workspaces, 1);
    let (refs, n) = (git(p, &["for-each-ref"]), op_log(p, None).unwrap().len());
    let e = disable_now(p).unwrap_err();
    assert_eq!(code(e), "jj.otherWorkspaces");
    assert!(p.join(".jj").exists());
    assert_eq!((git(p, &["for-each-ref"]), op_log(p, None).unwrap().len()), (refs, n));
}

#[test]
fn disable_refuses_when_it_cannot_tell_what_would_be_lost() {
    let d = busy_repo();
    let p = d.path();
    // jj 저장소를 읽을 수 없으면(백엔드 종류 파일이 사라짐) 판정 불가 → 아무것도 바꾸지 않고 거절
    std::fs::remove_file(p.join(".jj/repo/store/type")).unwrap();
    let before = (git(p, &["for-each-ref"]), head_ref(p));
    let e = disable_now(p).unwrap_err();
    assert_eq!(code(e.clone()), "jj.disableUnknown", "{e:?}");
    assert!(p.join(".jj").exists());
    assert_eq!((git(p, &["for-each-ref"]), head_ref(p)), before);
    assert_eq!(code(disable_check(p).unwrap_err()), "jj.disableUnknown");
}

#[test]
fn rerun_after_partial_failure_finishes_without_duplicating_kept_refs() {
    let d = busy_repo();
    let p = d.path();
    // 3단계(refs/jj 삭제)가 실패하도록 keep ref 하나에 잠금 파일을 둔다
    let keep = git(p, &["for-each-ref", "--format=%(refname)", "refs/jj/keep"]);
    let first = keep.lines().next().unwrap();
    let lock = p.join(".git").join(format!("{first}.lock"));
    std::fs::write(&lock, "").unwrap();
    let e = disable_now(p).unwrap_err();
    assert_eq!(code(e.clone()), "jj.disablePartial", "{e:?}");
    // 1·2단계는 끝나 있다: 보존 ref가 있고 HEAD는 브랜치, `.jj`는 아직 있다
    let kept1 = git(p, &["for-each-ref", "refs/git403/jj-orphans"]);
    assert_eq!(kept1.lines().count(), 1);
    assert_eq!(head_ref(p), "refs/heads/side");
    assert!(p.join(".jj").exists());
    std::fs::remove_file(&lock).unwrap();
    fsck(p);
    // 다시 실행하면 이어서 끝낸다(보존 ref는 그대로 하나)
    let w = disable_now(p).unwrap();
    assert_eq!(codes(&w), vec!["jj.disableKept"], "{w:?}");
    assert_eq!(git(p, &["for-each-ref", "refs/git403/jj-orphans"]), kept1);
    assert_eq!(git(p, &["for-each-ref", "refs/jj"]), "");
    assert!(!p.join(".jj").exists());
    fsck(p);
}

#[cfg(unix)]
#[test]
fn leftover_trash_lives_in_dot_git_and_does_not_break_disable() {
    use std::os::unix::fs::PermissionsExt;
    let d = repo();
    let p = d.path();
    let store = p.join(".jj/repo/store");
    std::fs::set_permissions(&store, std::fs::Permissions::from_mode(0o555)).unwrap();
    let w = disable_now(p).unwrap();
    let trash: Vec<_> = std::fs::read_dir(p.join(".git")).unwrap().map(|e| e.unwrap().path()).filter(|q| q.file_name().unwrap().to_string_lossy().starts_with("jj-removing-")).collect();
    // 루트로 돌 때는 권한이 안 막아 깨끗이 지워질 수 있다
    if trash.is_empty() {
        assert!(w.is_empty());
    } else {
        assert_eq!(codes(&w), vec!["jj.disableLeftover"]);
        assert!(!p.join(".jj").exists());
        assert_eq!(git(p, &["status", "--porcelain"]), "", "남은 폴더는 .git 안이라 git status에 안 보인다");
        std::fs::set_permissions(trash[0].join("repo/store"), std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::remove_dir_all(&trash[0]).unwrap();
    }
    enable(p).unwrap();
}
#[cfg(unix)]
#[test]
fn disable_never_follows_symlinks() {
    use std::os::unix::fs::symlink;
    let outside = tempfile::tempdir().unwrap();
    std::fs::create_dir(outside.path().join("dir")).unwrap();
    std::fs::write(outside.path().join("dir/keep.txt"), "keep").unwrap();
    std::fs::write(outside.path().join("file.txt"), "keep").unwrap();
    // `.jj` 자체가 밖을 가리키는 링크: 거절하고 아무것도 안 지운다
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    symlink(outside.path().join("dir"), p.join(".jj")).unwrap();
    assert_eq!(code(disable_now(p).unwrap_err()), "jj.partial");
    assert!(outside.path().join("dir/keep.txt").exists());
    // `.jj/repo`가 파일(다른 저장소 공유)이면 거절
    let d = repo();
    let p = d.path();
    std::fs::remove_dir_all(p.join(".jj/repo")).unwrap();
    std::fs::write(p.join(".jj/repo"), "../elsewhere").unwrap();
    assert_eq!(code(disable_now(p).unwrap_err()), "jj.partial");
    assert!(p.join(".jj").exists());
    // `.jj` 안의 링크(디렉터리·파일)는 링크만 지워지고 밖은 그대로
    let d = repo();
    let p = d.path();
    symlink(outside.path().join("dir"), p.join(".jj/evil_dir")).unwrap();
    symlink(outside.path().join("file.txt"), p.join(".jj/evil_file")).unwrap();
    symlink(outside.path().join("dir"), p.join(".jj/repo/evil_nested")).unwrap();
    disable_now(p).unwrap();
    assert!(!p.join(".jj").exists());
    assert_eq!(std::fs::read_to_string(outside.path().join("dir/keep.txt")).unwrap(), "keep");
    assert_eq!(std::fs::read_to_string(outside.path().join("file.txt")).unwrap(), "keep");
    fsck(p);
    // 저장소 루트 자체가 링크인 경로로 불러도 `.jj`는 canonical 루트 아래에서만 지운다
    let d = repo();
    let link = tempfile::tempdir().unwrap();
    let via = link.path().join("via");
    symlink(d.path(), &via).unwrap();
    disable_now(&via).unwrap();
    assert!(!d.path().join(".jj").exists());
}

// ---- 6차 리뷰 ----

/// `git fast-import`로 main에 커밋 `n`개를 빠르게 만든다
fn fast_import(p: &Path, n: usize) {
    use std::io::Write;
    let mut s2 = String::new();
    for i in 1..=n {
        let (msg, body) = (format!("c{i}\n"), format!("v{i}\n"));
        s2.push_str(&format!("commit refs/heads/main\ncommitter t <t@t> {} +0000\ndata {}\n{msg}M 100644 inline a.txt\ndata {}\n{body}\n", 1_700_000_000 + i, msg.len(), body.len()));
    }
    let mut c = Command::new("git").args(["fast-import", "--quiet"]).current_dir(p).stdin(std::process::Stdio::piped()).spawn().unwrap();
    c.stdin.take().unwrap().write_all(s2.as_bytes()).unwrap();
    assert!(c.wait().unwrap().success());
    git(p, &["reset", "-q", "--hard", "main"]);
}

#[test]
fn big_history_is_not_a_problem_only_unreachable_commits_count() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    git(p, &["init", "-q", "-b", "main"]);
    fast_import(p, 5000);
    enable(p).unwrap();
    assert!(status(p).unwrap().truncated, "status는 2000에서 잘린다(이 시험의 전제)");
    let main = git(p, &["rev-parse", "main"]);
    new_commit(p, std::slice::from_ref(&main)).unwrap();
    write(p, "w.txt", "w\n");
    describe(p, &wc(p), "described at 5000").unwrap();
    let c = disable_check(p).unwrap();
    assert_eq!(c.orphans.len(), 1, "{c:?}");
    assert_eq!(c.orphans[0].description.trim(), "described at 5000");
    let w = disable(p, &c.op_id).unwrap();
    assert_eq!(codes(&w), vec!["jj.disableKept"], "{w:?}");
    assert!(!p.join(".jj").exists());
    assert_eq!(git(p, &["rev-list", "--count", "main"]), "5000");
}

#[test]
fn visible_orphans_without_change_id_header_are_kept_too() {
    let d = repo();
    let p = d.path();
    let c1 = git(p, &["rev-parse", "main"]);
    // git으로 만든 커밋(change-id 헤더 없음)을 jj가 가져온 뒤 브랜치를 지운다
    git(p, &["checkout", "-q", "-b", "hold"]);
    write(p, "h.txt", "held\n");
    git(p, &["add", "."]);
    git(p, &["commit", "-q", "-m", "git made"]);
    let held = git(p, &["rev-parse", "HEAD"]);
    git(p, &["checkout", "-q", "main"]);
    new_commit(p, std::slice::from_ref(&c1)).unwrap(); // 가져오기
    git(p, &["branch", "-D", "hold"]);
    let c = disable_check(p).unwrap();
    let o = c.orphans.iter().find(|o| o.sha == held).unwrap_or_else(|| panic!("{c:?}"));
    assert_eq!(o.description.trim(), "git made");
    assert_eq!(o.change_id.len(), 32);
    disable_now(p).unwrap();
    git(p, &["gc", "-q", "--prune=now"]);
    git(p, &["cat-file", "-e", &format!("{held}^{{commit}}")]);
}

#[test]
fn disable_expect_op_refuses_when_jj_changed_in_between() {
    if !has_jj() {
        return;
    }
    let d = busy_repo();
    let p = d.path();
    let c = disable_check(p).unwrap();
    // 확인 뒤 외부 jj CLI가 커밋을 만든다
    jjc(p, &["new", "-m", "made by the CLI after the confirmation"]);
    let before = (git(p, &["for-each-ref"]), head_ref(p), op_log(p, None).unwrap().len());
    let e = disable(p, &c.op_id).unwrap_err();
    assert_eq!(code(e), "jj.disableChanged");
    assert!(p.join(".jj").exists());
    assert_eq!((git(p, &["for-each-ref"]), head_ref(p), op_log(p, None).unwrap().len()), before);
    // 다시 확인한 op로는 진행되고, 새 커밋(설명 있는 `@`)도 보존된다
    let c2 = disable_check(p).unwrap();
    assert_ne!(c2.op_id, c.op_id);
    assert!(c2.orphans.iter().any(|o| o.description.contains("made by the CLI")));
    let w = disable(p, &c2.op_id).unwrap();
    assert!(codes(&w).contains(&"jj.disableKept".to_string()), "{w:?}");
    assert!(git(p, &["log", "--format=%s", "--glob=refs/git403/jj-orphans/*"]).contains("made by the CLI"));
}

/// jj 0.47.1 CLI로 만든 저장소: 익명 브랜치·abandon·충돌·rebase로 생긴 predecessor·gc
#[test]
fn disable_on_a_real_jj_cli_repo_keeps_exactly_the_visible_orphans() {
    if !has_jj() {
        return;
    }
    let d = cli_repo();
    let p = d.path();
    let rev = |desc: &str| format!("description(exact:\"{desc}\\n\")");
    // 익명 브랜치 둘(main 아래 c0에서 갈라짐)
    jjc(p, &["new", "main-", "-m", "anon1"]);
    write(p, "anon1.txt", "1\n");
    jjc(p, &["new", "main-", "-m", "anon2"]);
    write(p, "anon2.txt", "2\n");
    // abandon: 버려진 커밋은 보이지 않으니 보존 대상이 아니다
    jjc(p, &["new", "main", "-m", "gone"]);
    write(p, "gone.txt", "g\n");
    jjc(p, &["abandon", &rev("gone")]);
    // rebase: anon1을 main 위로 옮기면 옛 버전(predecessor)은 숨겨진다
    jjc(p, &["rebase", "-r", &rev("anon1"), "-d", "main"]);
    // 충돌: 같은 파일을 다르게 고친 두 커밋과 그 머지(`@`)
    jjc(p, &["new", "main-", "-m", "X"]);
    write(p, "a.txt", "X\n");
    jjc(p, &["new", "main-", "-m", "Y"]);
    write(p, "a.txt", "Y\n");
    jjc(p, &["new", &rev("X"), &rev("Y"), "-m", "merge"]);
    let c = disable_check(p).unwrap();
    let mut descs: Vec<String> = c.orphans.iter().map(|o| o.description.trim().to_string()).collect();
    descs.sort();
    // X는 머지(`@`)의 첫 부모라 git HEAD가 가리키므로(detached) 사용자 ref에서 닿는다 → 보존 대상이 아니다
    assert_eq!(descs, vec!["Y", "anon1", "anon2", "merge"], "{c:?}");
    assert!(c.working_copy_described && c.working_copy_merge);
    let before_heads = git(p, &["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags"]);
    let w = disable(p, &c.op_id).unwrap();
    assert!(codes(&w).contains(&"jj.disableKept".to_string()), "{w:?}");
    let kept: Vec<String> = git(p, &["for-each-ref", "--format=%(objectname)", "refs/git403/jj-orphans"]).lines().map(String::from).collect();
    assert_eq!(kept.len(), 4);
    // 충돌 커밋은 보존 ref에서 `.jjconflict-*` 트리로 보인다
    let merge = kept.iter().find(|k| git(p, &["log", "-1", "--format=%s", k.as_str()]) == "merge").unwrap();
    assert!(git(p, &["ls-tree", "-r", "--name-only", merge]).contains(".jjconflict-"), "{}", git(p, &["ls-tree", "-r", "--name-only", merge]));
    git(p, &["gc", "-q", "--prune=now"]);
    for k in &kept {
        git(p, &["cat-file", "-e", &format!("{k}^{{commit}}")]);
    }
    // 사용자 브랜치·태그는 그대로, 옛 버전·abandon된 커밋은 보존되지 않았다
    assert_eq!(git(p, &["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags"]), before_heads);
    let subjects = git(p, &["log", "--format=%s", "--glob=refs/git403/jj-orphans/*"]);
    assert_eq!(subjects.lines().filter(|l| *l == "anon1").count(), 1);
    assert!(!subjects.lines().any(|l| l == "gone"));
    assert!(!p.join(".jj").exists());
    fsck(p);
}

// ---- 7차 리뷰: jj가 모르는 ref tip ----

/// jj 작업 뒤 git에서 만든 커밋(jj가 모른다)을 main에 얹는다
fn git_commit_on(p: &Path, parent: &str, msg: &str) -> String {
    let tree = git(p, &["rev-parse", &format!("{parent}^{{tree}}")]);
    git(p, &["commit-tree", &tree, "-p", parent, "-m", msg])
}

#[test]
fn tips_unknown_to_jj_do_not_turn_history_into_orphans() {
    if !has_jj() {
        return;
    }
    // (1) jj 작업 뒤 git commit(브랜치 main이 jj가 모르는 커밋으로 앞섬)
    let d = cli_repo();
    let p = d.path();
    jjc(p, &["bookmark", "create", "marker", "-r", "main"]);
    write(p, "g.txt", "git side\n");
    git(p, &["add", "g.txt"]);
    git(p, &["commit", "-q", "-m", "after jj"]);
    let c = disable_check(p).unwrap();
    assert!(c.orphans.is_empty(), "{c:?}");
    // (2) fetch로 원격 ref만 앞선 경우
    let d = cli_repo();
    let p = d.path();
    jjc(p, &["bookmark", "create", "marker", "-r", "main"]);
    let main = git(p, &["rev-parse", "main"]);
    let ahead = git_commit_on(p, &main, "fetched");
    git(p, &["update-ref", "refs/remotes/origin/main", &ahead]);
    let c = disable_check(p).unwrap();
    assert!(c.orphans.is_empty(), "{c:?}");
    // (3) 진짜 익명 브랜치는 그대로 잡힌다(모르는 tip이 있어도)
    let d = cli_repo();
    let p = d.path();
    jjc(p, &["new", "main-", "-m", "anon"]);
    write(p, "anon.txt", "a\n");
    jjc(p, &["new", "main", "-m", "tip"]); // 이름 없는 head 둘, main 위의 `@`는 설명 있음
    let main = git(p, &["rev-parse", "main"]);
    let ahead = git_commit_on(p, &main, "git after jj");
    git(p, &["update-ref", "refs/heads/main", &ahead]);
    let c = disable_check(p).unwrap();
    let mut descs: Vec<String> = c.orphans.iter().map(|o| o.description.trim().to_string()).collect();
    descs.sort();
    assert_eq!(descs, vec!["anon", "tip"], "{c:?}");
    let w = disable(p, &c.op_id).unwrap();
    assert!(codes(&w).contains(&"jj.disableKept".to_string()), "{w:?}");
    assert_eq!(git(p, &["for-each-ref", "--format=%(objectname)", "refs/git403/jj-orphans"]).lines().count(), 2);
    assert_eq!(git(p, &["rev-parse", "main"]), ahead);
}
