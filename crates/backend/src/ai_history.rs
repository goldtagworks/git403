//! AI 채팅 이력 저장소: `<config_dir>/ai-chat/<저장소 경로 해시>/<대화id>.jsonl`, 한 줄 = 한 차례(입력·답)의 `Entry`.
//! 저장 전에 자격 증명을 가린다(`settings_io::redact`). 파일 입출력만 한다(동기) — 호출 측이 블로킹 스레드에서 부른다.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use gc_core::ai_backup::Backup;
use serde::{Deserialize, Serialize};

use crate::settings_io::redact;
use crate::util::Res;

/// 한 차례의 대화 기록
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// 끝난 시각(Unix ms)
    pub time: u64,
    pub repo: String,
    pub input: String,
    pub answer: String,
    /// 실행한 도구 요약 (`Bash: git status`)
    pub commands: Vec<String>,
    pub backup: Option<Backup>,
    pub session_id: Option<String>,
    /// `done` | `error` | `cancelled`
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub conversation: String,
    /// 첫 입력의 첫 줄(80자까지)
    pub title: String,
    /// 마지막 차례의 시각
    pub time: u64,
    pub turns: usize,
}

/// 저장 전 자격 증명 가림
fn scrub(mut e: Entry) -> Entry {
    e.input = redact(&e.input);
    e.answer = redact(&e.answer);
    e.commands = e.commands.iter().map(|c| redact(c)).collect();
    e
}

/// 대화 id는 파일 이름이 된다: 영숫자·`-`·`_`만, 64자까지
pub fn check_id(id: &str) -> Res<()> {
    let ok = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    ok.then_some(()).ok_or_else(|| gc_i18n::coded!("aiChat.badId", "invalid conversation id").json())
}

/// FNV-1a 64비트(Rust 버전에 따라 바뀌지 않는 해시)
fn repo_dir(root: &Path, repo: &Path) -> PathBuf {
    let h = repo.to_string_lossy().trim_end_matches(['/', '\\']).bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3));
    root.join(format!("{h:016x}"))
}

fn io(e: std::io::Error) -> String {
    e.to_string()
}

fn lines(path: &Path) -> Vec<Entry> {
    std::fs::read_to_string(path).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

pub fn append(root: &Path, repo: &Path, conversation: &str, entry: Entry) -> Res<()> {
    use std::io::Write;
    check_id(conversation)?;
    let dir = repo_dir(root, repo);
    std::fs::create_dir_all(&dir).map_err(io)?;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(dir.join(format!("{conversation}.jsonl"))).map_err(io)?;
    let line = serde_json::to_string(&scrub(entry)).map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(io)
}

/// 대화 목록, 최신순
pub fn list(root: &Path, repo: &Path) -> Vec<Summary> {
    let Ok(rd) = std::fs::read_dir(repo_dir(root, repo)) else { return vec![] };
    let mut out: Vec<Summary> = rd
        .flatten()
        .filter_map(|f| {
            let name = f.file_name().to_string_lossy().into_owned();
            let conversation = name.strip_suffix(".jsonl")?.to_owned();
            let e = lines(&f.path());
            let first = e.first()?;
            let title: String = first.input.lines().next().unwrap_or_default().chars().take(80).collect();
            Some(Summary { conversation, title, time: e.last()?.time, turns: e.len() })
        })
        .collect();
    out.sort_by(|a, b| b.time.cmp(&a.time).then_with(|| a.conversation.cmp(&b.conversation)));
    out
}

pub fn read(root: &Path, repo: &Path, conversation: &str) -> Res<Vec<Entry>> {
    check_id(conversation)?;
    Ok(lines(&repo_dir(root, repo).join(format!("{conversation}.jsonl"))))
}

/// 저장소 이력을 모두 지운다. 지운 항목의 백업을 돌려준다(ref 정리용).
pub fn clear(root: &Path, repo: &Path) -> Res<Vec<(String, Backup)>> {
    let dir = repo_dir(root, repo);
    let backups = backups_in(&dir);
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(backups),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(io(e)),
    }
}

/// 마지막 수정이 `days`일보다 오래된 대화를 지운다. 지운 항목의 (저장소, 백업)을 돌려준다.
pub fn prune(root: &Path, days: u32) -> Res<Vec<(String, Backup)>> {
    let limit = SystemTime::now().checked_sub(Duration::from_secs(u64::from(days) * 86_400)).unwrap_or(SystemTime::UNIX_EPOCH);
    let mut removed = Vec::new();
    for dir in std::fs::read_dir(root).into_iter().flatten().flatten().map(|d| d.path()).filter(|p| p.is_dir()) {
        for f in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let old = f.metadata().and_then(|m| m.modified()).is_ok_and(|t| t < limit);
            if old && f.path().extension().is_some_and(|x| x == "jsonl") {
                removed.extend(lines(&f.path()).into_iter().filter_map(|e| Some((e.repo, e.backup?))));
                std::fs::remove_file(f.path()).map_err(io)?;
            }
        }
        let _ = std::fs::remove_dir(&dir); // 비었을 때만 지워진다
    }
    Ok(removed)
}

fn backups_in(dir: &Path) -> Vec<(String, Backup)> {
    std::fs::read_dir(dir).into_iter().flatten().flatten().flat_map(|f| lines(&f.path())).filter_map(|e| Some((e.repo, e.backup?))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(input: &str, time: u64) -> Entry {
        Entry { time, repo: "/r".into(), input: input.into(), answer: "답".into(), commands: vec!["Bash: git status".into()], backup: None, session_id: Some("s".into()), status: "done".into() }
    }

    #[test]
    fn append_list_read_newest_first_with_title_and_turns() {
        let d = tempfile::tempdir().unwrap();
        let repo = Path::new("/work/a");
        append(d.path(), repo, "c1", entry("첫 질문\n둘째 줄", 100)).unwrap();
        append(d.path(), repo, "c1", entry("후속", 200)).unwrap();
        append(d.path(), repo, "c2", entry("다른 대화", 300)).unwrap();
        append(d.path(), Path::new("/work/b"), "c3", entry("다른 저장소", 400)).unwrap();
        let l = list(d.path(), repo);
        assert_eq!(l.iter().map(|s| (s.conversation.as_str(), s.title.as_str(), s.time, s.turns)).collect::<Vec<_>>(), [("c2", "다른 대화", 300, 1), ("c1", "첫 질문", 200, 2)]);
        let e = read(d.path(), repo, "c1").unwrap();
        assert_eq!((e.len(), e[1].input.as_str(), e[0].session_id.as_deref()), (2, "후속", Some("s")));
        assert!(read(d.path(), repo, "nope").unwrap().is_empty());
        for bad in ["../x", "a/b", "", "a.b"] {
            assert!(append(d.path(), repo, bad, entry("x", 1)).is_err() && read(d.path(), repo, bad).is_err(), "{bad}");
        }
        // 한 줄 = 한 항목
        let raw = std::fs::read_dir(repo_dir(d.path(), repo)).unwrap().flatten().find(|f| f.file_name() == "c1.jsonl").unwrap();
        assert_eq!(std::fs::read_to_string(raw.path()).unwrap().lines().count(), 2);
    }

    #[test]
    fn credentials_are_redacted_before_saving() {
        let d = tempfile::tempdir().unwrap();
        let mut e = entry("push https://u:p4ss@github.com/o/r 해줘 ghp_abcdefghijklmnopqrstuvwxyz0123", 1);
        e.answer = "토큰 sk-ant-abcdefghijklmnopqrstuvwxyz".into();
        e.commands = vec!["Bash: git remote add o https://bob:secret@host/x.git".into()];
        append(d.path(), Path::new("/r"), "c", e).unwrap();
        let dir = repo_dir(d.path(), Path::new("/r"));
        let raw = std::fs::read_to_string(dir.join("c.jsonl")).unwrap();
        for leak in ["p4ss", "ghp_", "sk-ant", "secret", "bob"] {
            assert!(!raw.contains(leak), "{leak}: {raw}");
        }
        assert!(raw.contains("https://***@github.com/o/r"));
    }

    #[test]
    fn clear_and_prune_remove_files_and_report_backups() {
        let d = tempfile::tempdir().unwrap();
        let repo = Path::new("/work/a");
        let bk = |id: &str| Some(Backup { id: id.into(), ref_name: format!("refs/git403/ai-backup/{id}"), sha: "0".repeat(40), branch: None });
        let mut old = entry("옛날", 1);
        old.backup = bk("b1");
        append(d.path(), repo, "old", old).unwrap();
        let mut fresh = entry("최근", 2);
        fresh.backup = bk("b2");
        append(d.path(), repo, "fresh", fresh).unwrap();
        let f = std::fs::File::options().write(true).open(repo_dir(d.path(), repo).join("old.jsonl")).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(91 * 86_400)).unwrap();
        let removed = prune(d.path(), 90).unwrap();
        assert_eq!(removed.iter().map(|(r, b)| (r.as_str(), b.id.as_str())).collect::<Vec<_>>(), [("/r", "b1")]);
        assert_eq!(list(d.path(), repo).iter().map(|s| s.conversation.as_str()).collect::<Vec<_>>(), ["fresh"]);
        let cleared = clear(d.path(), repo).unwrap();
        assert_eq!(cleared.iter().map(|(_, b)| b.id.as_str()).collect::<Vec<_>>(), ["b2"]);
        assert!(list(d.path(), repo).is_empty());
        assert!(clear(d.path(), repo).unwrap().is_empty(), "없어도 오류 아님");
        assert!(prune(&d.path().join("none"), 90).unwrap().is_empty());
    }
}
