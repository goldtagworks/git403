use std::path::Path;

use crate::{GitRunner, Result};

/// 파일을 `rev` 커밋 시점 내용으로 작업 트리와 인덱스에 되돌린다(`git restore --source`).
/// 그 커밋에 없는 경로가 하나라도 있으면 `restore.notInRev`로 거부하고 아무것도 바꾸지 않는다.
pub async fn restore_file(git: &GitRunner, repo: &Path, rev: &str, paths: &[String]) -> Result<()> {
    if rev.is_empty() || rev.starts_with('-') {
        return Err(gc_i18n::coded!("restore.badRev", "invalid revision: {rev}", rev = rev).into());
    }
    for p in paths {
        if git.query(repo, &["cat-file", "-e", &format!("{rev}:{p}")]).await.is_err() {
            return Err(gc_i18n::coded!("restore.notInRev", "{path} does not exist in {rev}", path = p, rev = rev).into());
        }
    }
    let mut a = vec!["restore".to_owned(), format!("--source={rev}"), "--staged".into(), "--worktree".into(), "--".into()];
    a.extend(paths.iter().cloned());
    let a: Vec<&str> = a.iter().map(String::as_str).collect();
    git.output(repo, &a).await.map(drop)
}
