//! 폴더 아래 git 저장소 찾기 (저장소 관리 화면의 "폴더 스캔").

use std::path::{Path, PathBuf};

/// `root` 아래에서 `.git`(디렉터리 또는 파일)이 있는 폴더를 찾는다.
/// root 자체가 저장소면 그것만 돌려준다. 저장소 안으로는 더 내려가지 않는다.
/// 숨김 폴더·node_modules·target은 건너뛴다. 결과는 정렬돼 있다.
pub fn find_repos(root: &Path, max_depth: usize) -> Vec<PathBuf> {
    let mut found = Vec::new();
    walk(root, max_depth, &mut found);
    found.sort();
    found
}

fn walk(dir: &Path, depth: usize, found: &mut Vec<PathBuf>) {
    if dir.join(".git").exists() {
        found.push(dir.to_path_buf());
        return;
    }
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }
        // 심볼릭 링크는 따라가지 않는다 (순환 방지).
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            walk(&entry.path(), depth - 1, found);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gc-scan-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn finds_repos_and_skips() {
        let r = tmp("find");
        fs::create_dir_all(r.join("a/.git")).unwrap();
        fs::create_dir_all(r.join("a/inner/.git")).unwrap(); // 저장소 안 → 무시
        fs::create_dir_all(r.join("x/b")).unwrap();
        fs::write(r.join("x/b/.git"), "gitdir: ../elsewhere").unwrap(); // worktree·submodule 형태
        fs::create_dir_all(r.join(".hidden/c/.git")).unwrap();
        fs::create_dir_all(r.join("node_modules/d/.git")).unwrap();
        fs::create_dir_all(r.join("target/e/.git")).unwrap();
        fs::create_dir_all(r.join("1/2/3/deep/.git")).unwrap();

        assert_eq!(find_repos(&r, 4), vec![r.join("1/2/3/deep"), r.join("a"), r.join("x/b")]);
        assert_eq!(find_repos(&r, 2), vec![r.join("a"), r.join("x/b")]);
        fs::remove_dir_all(&r).unwrap();
    }

    #[test]
    fn root_is_repo() {
        let r = tmp("root");
        fs::create_dir_all(r.join(".git")).unwrap();
        fs::create_dir_all(r.join("sub/.git")).unwrap();
        assert_eq!(find_repos(&r, 4), vec![r.clone()]);
        fs::remove_dir_all(&r).unwrap();
    }
}
