//! 내구성: gix는 ref·reflog·인덱스·pack·loose 객체를 쓰고 rename만 하고 fsync를 하지 않는다. 앱이 강제 종료되거나 기기가 꺼지면(특히 모바일) 페이지 캐시가
//! 디스크에 안 내려가 `refs/heads/x`가 0바이트가 되는 사고가 난다. 그래서 gix_backend의 쓰기 경로는 아래 규칙으로 직접 fsync한다.
//!
//! - **우리가 잠금 파일을 쓰는 경로**(인덱스·설정·`logs/HEAD`·옮긴 reflog): rename **전에** 잠금 파일을 `sync_all`(`lock_file`)하고 rename 뒤 폴더를 fsync한다(git과 같은 순서).
//! - **gix가 쓰는 경로**(ref 트랜잭션·fetch가 갱신한 ref·pack·clone): gix 안에 훅이 없어 끝난 직후 바뀐 파일을 fsync한다(`refs`·`pack_files`·`tree`). rename과 fsync 사이의
//!   아주 짧은 창은 남지만(예전에는 OS가 내릴 때까지 수십 초) 종료 직후 빈 ref가 남는 문제는 없어진다.
//! - **loose 객체**: 새 ref·인덱스가 가리키는 객체가 빠지면 안 되므로 ref/인덱스 전에 fsync한다(`object`·`objects`). git 기본값(loose 객체는 안 함)보다 강하다.
//! - `core.fsync`를 존중한다: 설정돼 있으면 `reference`·`index`·`pack`·`loose-object` 성분이 켜졌을 때만 한다(`none`·`-reference` 등). **설정이 없으면 전부 켠다** —
//!   git의 기본값(`committed,-loose-object`가 아니라 실제로는 pack·derived-metadata만)보다 강한데, 모바일에서 ref가 비는 사고가 났기 때문이다. `core.fsyncMethod`는 무시하고 항상 `fsync`(macOS는 F_FULLFSYNC).
//! 오류는 파일 fsync만 전달하고 폴더 fsync 실패는 무시한다(지원 안 하는 파일 시스템이 있다).

use std::path::Path;

use gix::refs::transaction::RefEdit;

use super::common::fail;
use crate::Result;

#[derive(Clone, Copy)]
pub(super) enum Part {
    Reference,
    Index,
    Pack,
    Loose,
}

const LOOSE: u32 = 1;
const PACK: u32 = 2;
const INDEX: u32 = 16;
const REFERENCE: u32 = 32;

/// `core.fsync` 값(쉼표 목록)을 git처럼 해석한다. 처음은 비어 있고 `-이름`은 빼고 `default`는 git 기본값을 더한다.
fn parse(value: &str) -> u32 {
    let objects = LOOSE | PACK;
    let derived = 4 | 8; // pack-metadata, commit-graph
    let committed = objects | REFERENCE;
    let mut bits = 0u32;
    for tok in value.split(',').map(|t| t.trim().to_ascii_lowercase()).filter(|t| !t.is_empty()) {
        let (neg, name) = tok.strip_prefix('-').map_or((false, tok.as_str()), |n| (true, n));
        let m = match name {
            "none" => 0,
            "loose-object" => LOOSE,
            "pack" => PACK,
            "pack-metadata" => 4,
            "commit-graph" => 8,
            "index" => INDEX,
            "reference" => REFERENCE,
            "objects" => objects,
            "derived-metadata" => derived,
            "committed" => committed,
            "added" => committed | INDEX,
            "all" => committed | INDEX | derived,
            "default" => (objects | derived) & !LOOSE,
            _ => 0,
        };
        if neg { bits &= !m } else if name == "none" { bits = 0 } else { bits |= m }
    }
    bits
}

pub(super) fn enabled(r: &gix::Repository, part: Part) -> bool {
    let bit = match part {
        Part::Reference => REFERENCE,
        Part::Index => INDEX,
        Part::Pack => PACK,
        Part::Loose => LOOSE,
    };
    match r.config_snapshot().string("core.fsync") {
        Some(v) => parse(&v.to_string()) & bit != 0,
        None => true,
    }
}

/// 파일을 fsync한다(없으면 무시).
pub(super) fn file(path: &Path) -> Result<()> {
    match std::fs::File::open(path) {
        Ok(f) => f.sync_all().map_err(fail),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(fail(e)),
    }
}

/// 폴더를 fsync한다(rename·생성·삭제를 내구화). 실패는 무시.
pub(super) fn dir(path: &Path) {
    #[cfg(unix)]
    if let Ok(d) = std::fs::File::open(path) {
        let _ = d.sync_all();
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// rename 전에 잠금 파일의 내용을 디스크에 내린다.
pub(super) fn lock_file(lock: &mut gix::lock::File) -> Result<()> {
    lock.with_mut(|f| f.sync_all()).map_err(fail)
}

/// ref 편집이 끝난 직후: 바뀐 loose ref·reflog 파일과 폴더, `packed-refs`를 fsync한다.
pub(super) fn refs(r: &gix::Repository, edits: &[RefEdit]) -> Result<()> {
    if !enabled(r, Part::Reference) {
        return Ok(());
    }
    for e in edits {
        let name = e.name.as_bstr().to_string();
        let base = if name == "HEAD" || name.starts_with("refs/bisect/") || name.starts_with("refs/worktree/") { r.git_dir() } else { r.common_dir() };
        for p in [base.join(&name), base.join("logs").join(&name)] {
            file(&p)?;
            if let Some(parent) = p.parent() {
                dir(parent);
            }
        }
    }
    file(&r.common_dir().join("packed-refs"))?;
    dir(r.common_dir());
    Ok(())
}

/// loose 객체 파일(있으면)을 fsync한다. pack에 있거나 이미 있던 객체는 파일이 없어 건너뛴다.
pub(super) fn objects(r: &gix::Repository, ids: &[gix::ObjectId]) -> Result<()> {
    if !enabled(r, Part::Loose) {
        return Ok(());
    }
    let root = r.objects.store_ref().path().to_owned();
    for id in ids {
        let hex = id.to_string();
        let fan = root.join(&hex[..2]);
        file(&fan.join(&hex[2..]))?;
        dir(&fan);
    }
    dir(&root);
    Ok(())
}

pub(super) fn object(r: &gix::Repository, id: gix::ObjectId) -> Result<()> {
    objects(r, &[id])
}

/// fetch가 쓴 pack(데이터·인덱스)과 폴더.
pub(super) fn pack_files(r: &gix::Repository, paths: &[&Path]) -> Result<()> {
    if !enabled(r, Part::Pack) {
        return Ok(());
    }
    for p in paths {
        file(p)?;
    }
    dir(&r.objects.store_ref().path().join("pack"));
    Ok(())
}

/// 폴더 아래 모든 파일과 폴더를 fsync한다(clone이 `.git` 전체를 쓴 직후).
pub(super) fn tree(root: &Path) -> Result<()> {
    fn walk(p: &Path) -> Result<()> {
        for e in std::fs::read_dir(p).map_err(fail)?.flatten() {
            let path = e.path();
            if e.file_type().is_ok_and(|t| t.is_dir()) {
                walk(&path)?;
            } else if e.file_type().is_ok_and(|t| t.is_file()) {
                file(&path)?;
            }
        }
        dir(p);
        Ok(())
    }
    walk(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_fsync를_git처럼_해석한다() {
        assert_eq!(parse("none"), 0);
        assert_ne!(parse("reference") & REFERENCE, 0);
        assert_eq!(parse("committed,-loose-object") & (LOOSE | PACK | REFERENCE), PACK | REFERENCE);
        assert_eq!(parse("added") & INDEX, INDEX);
        assert_eq!(parse("all,-index") & INDEX, 0);
        assert_eq!(parse("default") & (REFERENCE | INDEX), 0);
        assert_eq!(parse("objects,-pack"), LOOSE);
    }

    #[test]
    fn 설정에_따라_켜고_끈다_없는_파일은_무시한다() {
        let d = tempfile::tempdir().unwrap();
        let mut r = gix::init(d.path()).unwrap();
        assert!(enabled(&r, Part::Reference) && enabled(&r, Part::Index) && enabled(&r, Part::Pack) && enabled(&r, Part::Loose), "설정이 없으면 전부 켠다");
        {
            let mut c = r.config_snapshot_mut();
            c.set_raw_value(&"core.fsync", "committed,-loose-object").unwrap();
        }
        assert!(enabled(&r, Part::Reference) && enabled(&r, Part::Pack) && !enabled(&r, Part::Loose) && !enabled(&r, Part::Index));
        {
            let mut c = r.config_snapshot_mut();
            c.set_raw_value(&"core.fsync", "none").unwrap();
        }
        assert!(!enabled(&r, Part::Reference));
        assert!(file(&d.path().join("nope")).is_ok());
        // 있는 파일·폴더는 fsync가 성공한다
        std::fs::write(d.path().join("f"), b"x").unwrap();
        assert!(file(&d.path().join("f")).is_ok());
        dir(d.path());
        assert!(tree(d.path()).is_ok());
    }
}
