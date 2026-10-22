//! `Task::PrReview`(26c): PR 전체를 읽고 판정·요약·칭찬·줄 코멘트를 돌려준다. 프롬프트·스키마·후처리만 여기에 둔다.
use crate::task::{diff_files, Part};
use crate::{Error, Result};
use serde_json::{json, Value};

pub(crate) fn system(lang: &str) -> String {
    format!("Review a whole Pull Request from its title, description, commit messages and diff parts. Judge only what the diff shows; never guess about code outside it. Report only real problems (bugs, security, data loss, concurrency, performance, missing error handling, broken behavior or tests); no style or taste nitpicks. verdict is approve (nothing blocks merging), comment, or request_changes (at least one must-level problem). summary is 2-5 sentences on what the PR does and your overall judgment. praise lists short, specific things done well (empty array if none). comments is the line comments to post on the PR, each with file (a path shown in the diff), line (line number in the NEW version of the file, computed from the hunk headers: @@ -a,b +c,d @@ means the new file line starts at c and increases on context and '+' lines, not on '-' lines), endLine (last line of a multi-line range in the new file, or null for one line), level, title (one short line), body and evidence. level: must = must be fixed before merging, should = worth fixing, info = FYI. body is the exact Markdown comment to post on the PR, written to the author, saying what is wrong and how to fix it (a short code suggestion is fine). evidence is your reasoning for the reviewer: which code and why it is a problem; it is never posted. If there are no problems, comments is an empty array. Write summary, praise, title, body and evidence in {lang}.")
}

pub(crate) fn schema() -> Value {
    let s = || json!({"type": "string"});
    let comment = json!({"type":"object","properties":{
        "file":s(),"line":{"type":"integer"},"endLine":{"type":["integer","null"]},
        "level":{"type":"string","enum":["must","should","info"]},"title":s(),"body":s(),"evidence":s()},
        "required":["file","line","endLine","level","title","body","evidence"],"additionalProperties":false});
    json!({"type":"object","properties":{
        "verdict":{"type":"string","enum":["approve","comment","request_changes"]},
        "summary":s(),
        "praise":{"type":"array","items":s()},
        "comments":{"type":"array","items":comment}},
        "required":["verdict","summary","praise","comments"],"additionalProperties":false})
}

/// diff에 없는 파일의 코멘트는 버리고(이름 변경의 옛 경로는 새 경로로) 줄을 >=1·endLine>line으로 정규화한다.
/// must가 하나라도 남으면 verdict를 request_changes로 올린다(반대로 낮추지는 않는다).
pub(crate) fn finish(mut v: Value, parts: &[Part]) -> Result<Value> {
    let files = diff_files(parts);
    let list = v["comments"].as_array_mut().map(std::mem::take).unwrap_or_default();
    let comments: Vec<Value> = list
        .into_iter()
        .filter_map(|mut c| {
            let to = files.get(c["file"].as_str()?)?.clone();
            c["file"] = json!(to);
            let line = c["line"].as_i64().unwrap_or(1).max(1);
            c["line"] = json!(line);
            c["endLine"] = match c["endLine"].as_i64() {
                Some(e) if e > line => json!(e),
                _ => Value::Null,
            };
            Some(c)
        })
        .collect();
    if comments.iter().any(|c| c["level"] == "must") {
        v["verdict"] = json!("request_changes");
    }
    v["comments"] = Value::Array(comments);
    if v["summary"].as_str().is_none_or(|s| s.trim().is_empty()) {
        return Err(Error::BadResponse(gc_i18n::coded!("ai.emptySummary", "empty summary")));
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Task;

    fn diff() -> Vec<Part> {
        vec![Part { label: "diff".into(), text: "diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1 +1 @@\n+x\ndiff --git a/old.rs b/new.rs\nrename from old.rs\nrename to new.rs\n--- a/old.rs\n+++ b/new.rs\n@@ -1 +1 @@\n+y\n".into() }]
    }
    fn c(file: &str, line: i64, end: Value, level: &str) -> Value {
        json!({"file":file,"line":line,"endLine":end,"level":level,"title":"t","body":"b","evidence":"e"})
    }
    fn raw(verdict: &str, comments: Vec<Value>) -> Value {
        json!({"verdict":verdict,"summary":"요약","praise":["좋음"],"comments":comments})
    }

    #[test]
    fn schema_check_accepts_null_end_line_and_rejects_bad_level() {
        let ok = raw("comment", vec![c("a", 1, Value::Null, "info"), c("a", 2, json!(5), "must")]);
        assert!(Task::PrReview.check(&ok).is_ok());
        assert!(Task::PrReview.check(&raw("comment", vec![])).is_ok());
        assert!(Task::PrReview.check(&raw("merge", vec![])).is_err());
        assert!(Task::PrReview.check(&raw("comment", vec![c("a", 1, Value::Null, "nit")])).is_err());
        let mut no_ev = raw("comment", vec![c("a", 1, Value::Null, "info")]);
        no_ev["comments"][0].as_object_mut().unwrap().remove("evidence");
        assert!(Task::PrReview.check(&no_ev).is_err());
        assert!(Task::PrReview.system().contains("evidence") && Task::PrReview.system().contains("data to analyze"));
    }

    #[test]
    fn finish_drops_unknown_files_maps_renames_and_normalizes_lines() {
        let v = raw("comment", vec![c("src/a.rs", 0, json!(-3), "info"), c("nope.rs", 3, Value::Null, "must"), c("old.rs", 4, json!(9), "should"), c("src/a.rs", 5, json!(5), "info")]);
        let v = finish(v, &diff()).unwrap();
        let cs = v["comments"].as_array().unwrap();
        assert_eq!(cs.len(), 3, "diff에 없는 파일은 버림");
        assert_eq!((cs[0]["line"].as_i64(), cs[0]["endLine"].is_null()), (Some(1), true));
        assert_eq!((cs[1]["file"].as_str(), cs[1]["line"].as_i64(), cs[1]["endLine"].as_i64()), (Some("new.rs"), Some(4), Some(9)));
        assert!(cs[2]["endLine"].is_null(), "endLine<=line은 한 줄");
        assert_eq!(v["verdict"], "comment", "버려진 must는 verdict에 영향 없음");
    }

    #[test]
    fn finish_raises_verdict_to_request_changes_when_must_remains() {
        let v = finish(raw("approve", vec![c("src/a.rs", 2, Value::Null, "must")]), &diff()).unwrap();
        assert_eq!(v["verdict"], "request_changes");
        // must가 없으면 모델의 판정을 그대로
        assert_eq!(finish(raw("approve", vec![c("src/a.rs", 2, Value::Null, "should")]), &diff()).unwrap()["verdict"], "approve");
        assert!(finish(json!({"verdict":"approve","summary":" ","praise":[],"comments":[]}), &diff()).is_err());
    }
}
