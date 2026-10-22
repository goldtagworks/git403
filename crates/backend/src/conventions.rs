//! AI 커밋 메시지·PR 설명에 붙일 저장소 규칙 수집(읽기 전용). CLAUDE.md·AGENTS.md·스킬·템플릿·최근 커밋 제목을 모아
//! `<repo-conventions>` 절 하나로 만든다(절을 입력·시스템 프롬프트에 붙이는 건 gc-ai `build_prompt_for`).
//! 파일은 저장소 안에서만 읽는다(저장소 밖을 가리키는 심볼릭 링크 거부). 파일당 16KB·합계 40KB, 넘으면 우선순위
//! (커밋/PR 스킬 > AGENTS·CLAUDE > 템플릿·이력 > 나머지)로 자르고 `truncated`로 표시한다.

use std::io::Read;
use std::path::{Path, PathBuf};

use gc_core::GitRunner;
use serde::Serialize;
use serde_json::Value;

const FILE_MAX: usize = 16 * 1024;
const TOTAL_MAX: usize = 40 * 1024;
/// 저장소 스킬이 없을 때 쓰는 플러그인 스킬 수 상한
const PLUGIN_SKILLS_MAX: usize = 3;
/// 지정 스킬을 찾으려 훑는 규칙 문서 크기 상한(프롬프트에 넣는 양과 별개)
const DOC_SCAN_MAX: usize = 256 * 1024;
/// 문서가 지정한 스킬 중 읽는 수 상한
const REFERENCED_MAX: usize = 5;
const COMMIT_SUBJECTS: &str = "20";

/// 사용한 출처 하나. `kind`: skill·plugin·agents·claude·gemini·contributing·copilot·template·commitlint·history·branch
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Source {
    pub kind: &'static str,
    pub path: String,
    pub truncated: bool,
    /// 스킬만: `referenced`(규칙 문서가 지정) | `matched`(지정이 없어 이름·설명으로 고름)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via: Option<&'static str>,
    /// 지정한 문서 위치 (`CLAUDE.md:168`)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// 문서가 지정했지만 찾지 못함 (`path`는 지정된 이름)
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub missing: bool,
    /// 읽지 않고 건너뜀: 템플릿이 홈·저장소 밖(심볼릭 링크는 실제 경로 기준)
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub skipped: bool,
}

pub(crate) struct Collected {
    pub text: String,
    pub sources: Vec<Source>,
}

#[derive(Default)]
struct Item {
    prio: u8,
    kind: &'static str,
    path: String,
    text: String,
    truncated: bool,
    via: Option<&'static str>,
    from: Option<String>,
    missing: bool,
    skipped: bool,
}

/// 저장소 규칙을 모은다. 저장소에서 껐거나(`git config git403.aiConventions false`) 모은 게 없으면 None.
pub(crate) async fn collect(git: &GitRunner, repo: &Path, task: gc_ai::Task, home: Option<PathBuf>) -> Option<Collected> {
    if !matches!(task, gc_ai::Task::Commit | gc_ai::Task::Pr) {
        return None;
    }
    let cfg = |args: &'static [&'static str]| async move { git.query(repo, args).await.ok().map(|o| String::from_utf8_lossy(&o).trim().to_string()).filter(|s| !s.is_empty()) };
    if cfg(&["config", "--local", "--get", "git403.aiConventions"]).await.is_some_and(|v| matches!(v.to_lowercase().as_str(), "false" | "0" | "no" | "off")) {
        return None;
    }
    let commit = task == gc_ai::Task::Commit;
    let template = if commit { cfg(&["config", "--type=path", "--get", "commit.template"]).await } else { None };
    let branch = cfg(&["symbolic-ref", "--short", "-q", "HEAD"]).await;
    let history = cfg(&["log", "-n", COMMIT_SUBJECTS, "--no-merges", "--format=%s"]).await;

    let root = repo.to_path_buf();
    let mut items = tokio::task::spawn_blocking(move || files(&root, commit, template.as_deref(), home.as_deref())).await.ok()?;
    // 규칙 파일이 하나도 없으면 최근 제목·브랜치만으로는 붙이지 않는다(UI가 이미 최근 커밋 제목을 보낸다)
    if items.is_empty() {
        return None;
    }
    let mut text_item = |kind, path: &str, text: String| items.push(Item { prio: 2, kind, path: path.into(), text, truncated: false, ..Default::default() });
    if let Some(h) = history {
        text_item("history", "git log -n 20", h);
    }
    if let Some(b) = branch {
        text_item("branch", "HEAD", format!("current branch: {b}"));
    }
    items.sort_by_key(|i| i.prio); // 안정 정렬: 같은 우선순위는 찾은 순서
    Some(assemble(items))
}

/// 우선순위 순으로 합계 상한에 맞춰 이어 붙인다. 못 넣은 것도 출처에는 `truncated`로 남긴다.
fn assemble(items: Vec<Item>) -> Collected {
    let (mut text, mut sources, mut left) = (String::new(), Vec::new(), TOTAL_MAX);
    for mut i in items {
        let src = |i: Item, truncated| Source { kind: i.kind, path: i.path, truncated, via: i.via, from: i.from, missing: i.missing, skipped: i.skipped };
        if i.missing || i.skipped {
            sources.push(src(i, false));
            continue;
        }
        // 머리글·잘림 표시까지 합쳐 합계 상한에 맞춘다
        let (head, tail) = (format!("## {} ({})\n", i.path, i.kind), "\n[... truncated]");
        let avail = left.saturating_sub(head.len() + tail.len() + 2);
        if i.text.len() > avail {
            i.text.truncate(floor(&i.text, avail));
            i.truncated = true;
        }
        if i.text.trim().is_empty() {
            sources.push(src(i, true));
            continue;
        }
        let section = format!("{head}{}{}\n\n", i.text.trim_end(), if i.truncated { tail } else { "" });
        left = left.saturating_sub(section.len());
        text.push_str(&section);
        let t = i.truncated;
        sources.push(src(i, t));
    }
    Collected { text, sources }
}

/// `s`의 `max`바이트 이하에서 가장 가까운 글자 경계
fn floor(s: &str, max: usize) -> usize {
    (0..=max.min(s.len())).rev().find(|&i| s.is_char_boundary(i)).unwrap_or(0)
}

/// 파일 기반 출처(스킬·문서·템플릿·플러그인 스킬). 블로킹이라 `spawn_blocking`에서 부른다.
fn files(repo: &Path, commit: bool, template: Option<&str>, home: Option<&Path>) -> Vec<Item> {
    let Ok(root) = std::fs::canonicalize(repo) else { return Vec::new() };
    let mut out = Vec::new();
    // 1순위: 규칙 문서가 커밋(PR) 문맥에서 지정한 스킬
    let docs = rule_docs(&root, home);
    let mut skills = referenced_skills(&root, home, &docs, commit);
    // 지정이 없을 때만 이름·설명으로 고른다
    if skills.is_empty() {
        skills = matched_skills(&root, home, commit);
    }
    out.extend(skills);

    first(&mut out, &root, 1, "claude", "", &["CLAUDE.md"]);
    first(&mut out, &root, 1, "agents", "", &["AGENTS.md"]);
    first(&mut out, &root, 3, "gemini", "", &["GEMINI.md"]);
    // CONTRIBUTING은 루트에 있으면 그것, 없으면 .github
    first(&mut out, &root, 3, "contributing", "", &["CONTRIBUTING.md"]);
    if find_ci(&root, "", "CONTRIBUTING.md").is_none() {
        first(&mut out, &root, 3, "contributing", ".github", &["CONTRIBUTING.md"]);
    }
    first(&mut out, &root, 3, "copilot", ".github", &["copilot-instructions.md"]);

    if commit {
        if let Some(t) = template {
            // 템플릿은 저장소 안이나 홈 아래(~/.gitmessage)만 읽는다. 심볼릭 링크는 실제 경로로 해석해 같은 제한을 건다.
            // 설정 값은 저장소가 정할 수 있어(.git/config) 임의 파일(예: ~/.ssh)을 프롬프트로 보내지 못하게 하는 장치.
            let p = PathBuf::from(t);
            let p = if p.is_absolute() { p } else { root.join(p) };
            if let Ok(real) = std::fs::canonicalize(&p) {
                let path = format!("commit.template ({t})");
                let home_real = home.and_then(|h| std::fs::canonicalize(h).ok());
                if !(real.starts_with(&root) || home_real.is_some_and(|h| real.starts_with(h))) {
                    out.push(Item { prio: 2, kind: "template", path, skipped: true, ..Default::default() });
                } else if let Some((text, truncated)) = read_file(None, &real) {
                    out.push(Item { prio: 2, kind: "template", path, text, truncated, ..Default::default() });
                }
            }
        }
        let rc = ["", "", ".json", ".yaml", ".yml", ".js", ".cjs", ".mjs", ".ts", ".cts", ".mts"].map(|e| format!(".commitlintrc{e}"));
        let cfg = ["js", "cjs", "mjs", "ts", "cts", "mts"].map(|e| format!("commitlint.config.{e}"));
        let names: Vec<&str> = rc.iter().chain(cfg.iter()).map(String::as_str).collect();
        for n in names {
            if let Some((text, truncated)) = find_ci(&root, "", n).and_then(|p| read_file(Some(&root), &p)) {
                out.push(Item { prio: 2, kind: "commitlint", path: n.into(), text, truncated, ..Default::default() });
                break;
            }
        }
    } else {
        for dir in [".github", "docs", ""] {
            let name = "pull_request_template.md";
            if let Some(p) = find_ci(&root, dir, name) {
                if let Some((text, truncated)) = read_file(Some(&root), &p) {
                    let rel = if dir.is_empty() { name.to_string() } else { format!("{dir}/{name}") };
                    out.push(Item { prio: 2, kind: "template", path: rel, text, truncated, ..Default::default() });
                    break;
                }
            }
        }
        // 여러 템플릿 폴더: .github/PULL_REQUEST_TEMPLATE/*.md
        if let Some(dir) = find_ci(&root, ".github", "PULL_REQUEST_TEMPLATE") {
            for f in sorted_files(&dir).into_iter().filter(|f| f.extension().is_some_and(|e| e.eq_ignore_ascii_case("md"))).take(5) {
                if let Some((text, truncated)) = read_file(Some(&root), &f) {
                    let rel = format!(".github/PULL_REQUEST_TEMPLATE/{}", f.file_name().unwrap_or_default().to_string_lossy());
                    out.push(Item { prio: 2, kind: "template", path: rel, text, truncated, ..Default::default() });
                }
            }
        }
    }
    out
}

/// root 안 `dir`에서 `names` 중 처음 있는(대소문자 무시) 파일 하나를 읽어 넣는다.
fn first(out: &mut Vec<Item>, root: &Path, prio: u8, kind: &'static str, dir: &str, names: &[&str]) {
    for n in names {
        if let Some(p) = find_ci(root, dir, n) {
            if let Some((text, truncated)) = read_file(Some(root), &p) {
                out.push(Item { prio, kind, path: if dir.is_empty() { n.to_string() } else { format!("{dir}/{n}") }, text, truncated, ..Default::default() });
            }
            return;
        }
    }
}

/// `dir`(root 기준 상대, 빈 문자열 = root) 안에서 이름이 대소문자 무시로 같은 항목의 경로. 없으면 None.
fn find_ci(root: &Path, dir: &str, name: &str) -> Option<PathBuf> {
    let d = if dir.is_empty() { root.to_path_buf() } else { find_dir_ci(root, dir)? };
    std::fs::read_dir(d).ok()?.flatten().find(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(name)).map(|e| e.path())
}

fn find_dir_ci(root: &Path, dir: &str) -> Option<PathBuf> {
    dir.split('/').try_fold(root.to_path_buf(), |p, seg| std::fs::read_dir(&p).ok()?.flatten().find(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(seg)).map(|e| e.path()))
}

fn sorted_dirs(p: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(p).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    v.sort();
    v
}

fn sorted_files(p: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(p).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_file()).collect();
    v.sort();
    v
}

/// 텍스트 파일 하나. `root`가 있으면 심볼릭 링크를 풀어 root 밖이면 거부. 일반 파일이 아니거나 NUL이 있거나 UTF-8이 아니면 None.
/// 16KB를 넘으면 글자 경계에서 잘라 `(text, true)`.
fn read_file(root: Option<&Path>, path: &Path) -> Option<(String, bool)> {
    read_file_cap(root, path, FILE_MAX)
}

fn read_file_cap(root: Option<&Path>, path: &Path, cap: usize) -> Option<(String, bool)> {
    let real = std::fs::canonicalize(path).ok()?;
    if root.is_some_and(|r| !real.starts_with(r)) || !real.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&real).ok()?.take(cap as u64 + 1).read_to_end(&mut bytes).ok()?;
    let truncated = bytes.len() > cap;
    bytes.truncate(cap);
    let text = match String::from_utf8(bytes) {
        Ok(s) => s,
        // 자른 자리에서 글자가 반쯤 끊긴 것만 허용
        Err(e) if truncated && e.utf8_error().error_len().is_none() => {
            let n = e.utf8_error().valid_up_to();
            String::from_utf8(e.into_bytes()[..n].to_vec()).ok()?
        }
        Err(_) => return None,
    };
    (!text.contains('\0')).then_some((text, truncated))
}

/// SKILL.md 앞머리의 name·description (`key: value`, 따옴표·`|`·`>` 블록 허용). 없으면 빈 문자열.
fn frontmatter(text: &str) -> (String, String) {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Default::default();
    }
    let head: Vec<&str> = lines.take_while(|l| l.trim() != "---").collect();
    let value = |key: &str| {
        let i = head.iter().position(|l| l.strip_prefix(key).is_some_and(|r| r.starts_with(':')))?;
        let v = head[i][key.len() + 1..].trim();
        let v = if matches!(v, "" | "|" | ">" | "|-" | ">-") {
            head[i + 1..].iter().take_while(|l| l.starts_with(' ') || l.starts_with('\t')).map(|l| l.trim()).collect::<Vec<_>>().join(" ")
        } else {
            v.trim_matches(|c| c == '"' || c == '\'').to_string()
        };
        Some(v)
    };
    (value("name").unwrap_or_default(), value("description").unwrap_or_default())
}

/// 커밋(또는 PR) 메시지 규칙 스킬인가. 이름 토큰, 없으면 설명 앞부분의 키워드로 본다
/// (설명 뒷부분이나 "…·커밋 요청에 트리거"처럼 곁다리로 나온 "커밋"은 무시 — 메시지 규칙 문구가 있어야 한다).
fn skill_matches(name: &str, desc: &str, commit: bool) -> bool {
    let name = name.to_lowercase();
    let tokens: Vec<&str> = name.split(|c: char| !c.is_alphanumeric()).collect();
    let head: String = desc.chars().take(160).collect::<String>().to_lowercase();
    if commit {
        tokens.iter().any(|t| matches!(*t, "commit" | "commits")) || name.contains("커밋") || ["commit message", "conventional commit", "커밋 메시지", "커밋메시지", "커밋 규칙", "커밋 컨벤션"].iter().any(|k| head.contains(k))
    } else {
        let by_name = tokens.iter().any(|t| matches!(*t, "pr" | "pull")) && !tokens.iter().any(|t| matches!(*t, "approve" | "review" | "merge" | "check"));
        by_name || ["pr 제목", "pr 본문", "pr 설명", "pr 메시지", "pr message", "pr description", "pull request"].iter().any(|k| head.contains(k))
    }
}

/// `~/.claude/plugins/installed_plugins.json`(version 2: `plugins{키: [{scope, installPath, projectPath?}]}`)에서
/// 켜져 있는(`~/.claude/settings.json`의 `enabledPlugins`가 false가 아닌) 플러그인의 (키, 설치 경로).
/// 설치 경로는 파일이 가리키는 버전 폴더 하나뿐이다(cache의 다른 버전은 보지 않는다).
fn active_plugins(repo_root: &Path, home: &Path) -> Vec<(String, PathBuf)> {
    let rd = |p: PathBuf| std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
    let Some(installed) = rd(home.join(".claude/plugins/installed_plugins.json")) else { return Vec::new() };
    let enabled = rd(home.join(".claude/settings.json")).map(|s| s["enabledPlugins"].clone()).unwrap_or(Value::Null);
    let mut out = Vec::new();
    let Some(plugins) = installed["plugins"].as_object() else { return out };
    let mut keys: Vec<&String> = plugins.keys().collect();
    keys.sort();
    for key in keys {
        if enabled[key.as_str()] == Value::Bool(false) {
            continue;
        }
        for e in plugins[key].as_array().into_iter().flatten() {
            // project·local 범위 설치는 그 프로젝트에서만
            let scope = e["scope"].as_str().unwrap_or("user");
            if matches!(scope, "project" | "local") && e["projectPath"].as_str().and_then(|p| std::fs::canonicalize(p).ok()).as_deref() != Some(repo_root) {
                continue;
            }
            if let Some(install) = e["installPath"].as_str().and_then(|p| std::fs::canonicalize(p).ok()) {
                out.push((key.clone(), install));
            }
        }
    }
    out
}

fn tilde(home: &Path, p: &Path) -> String {
    let h = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    p.display().to_string().replace(&h.display().to_string(), "~")
}

/// 지정이 없을 때의 대체: 저장소 `.claude|.agents/skills`의 커밋/PR 스킬(같은 이름은 앞의 것 하나),
/// 그것도 없으면 설치된 플러그인 스킬(최대 3개).
fn matched_skills(root: &Path, home: Option<&Path>, commit: bool) -> Vec<Item> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for base in [".claude/skills", ".agents/skills"] {
        for dir in sorted_dirs(&root.join(base)) {
            if let Some((text, truncated)) = read_file(Some(root), &dir.join("SKILL.md")) {
                let (name, desc) = frontmatter(&text);
                let dname = dir.file_name().unwrap_or_default().to_string_lossy().into_owned();
                let name = if name.is_empty() { dname.clone() } else { name };
                if skill_matches(&name, &desc, commit) && seen.insert(name) {
                    out.push(Item { prio: 0, kind: "skill", path: format!("{base}/{dname}/SKILL.md"), text, truncated, via: Some("matched"), ..Default::default() });
                }
            }
        }
    }
    if out.is_empty() {
        for (_, install) in home.map(|h| active_plugins(root, h)).unwrap_or_default() {
            for dir in sorted_dirs(&install.join("skills")) {
                if out.len() >= PLUGIN_SKILLS_MAX {
                    return out;
                }
                let Some((text, truncated)) = read_file(Some(&install), &dir.join("SKILL.md")) else { continue };
                let (name, desc) = frontmatter(&text);
                let name = if name.is_empty() { dir.file_name().unwrap_or_default().to_string_lossy().into_owned() } else { name };
                if skill_matches(&name, &desc, commit) {
                    let path = tilde(home.unwrap_or(&install), &dir.join("SKILL.md"));
                    out.push(Item { prio: 0, kind: "plugin", path, text, truncated, via: Some("matched"), ..Default::default() });
                }
            }
        }
    }
    out
}

// ---- 규칙 문서가 지정한 스킬 ----

struct Doc {
    label: String,
    text: String,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Loc {
    User,
    Claude,
    Agents,
}

#[derive(Clone, PartialEq, Debug)]
enum Form {
    /// 이름만(`commit-message`, `/commit-message`)
    Plain,
    /// `plugin:skill`
    Plugin(String),
    /// 경로(`.claude/skills/x`, `~/.claude/skills/x`)
    At(Loc),
}

#[derive(Debug)]
struct Ref {
    name: String,
    form: Form,
    /// 못 찾으면 "지정됐는데 없음"으로 알릴 만큼 분명한 지정인가 (슬래시·plugin:skill·경로, 또는 문장에 "스킬"이 있음)
    explicit: bool,
    from: String,
}

/// 저장소 CLAUDE.md·AGENTS.md·GEMINI.md·.github/copilot-instructions.md와 사용자 전역
/// ~/.claude/CLAUDE.md·~/.codex/AGENTS.md·~/.gemini/GEMINI.md. 전역 문서는 지정을 찾는 데만 쓴다(프롬프트엔 안 넣음).
fn rule_docs(root: &Path, home: Option<&Path>) -> Vec<Doc> {
    let mut docs = Vec::new();
    for (dir, name) in [("", "CLAUDE.md"), ("", "AGENTS.md"), ("", "GEMINI.md"), (".github", "copilot-instructions.md")] {
        if let Some((text, _)) = find_ci(root, dir, name).and_then(|p| read_file_cap(Some(root), &p, DOC_SCAN_MAX)) {
            docs.push(Doc { label: if dir.is_empty() { name.into() } else { format!("{dir}/{name}") }, text });
        }
    }
    for rel in home.map(|_| [".claude/CLAUDE.md", ".codex/AGENTS.md", ".gemini/GEMINI.md"]).into_iter().flatten() {
        if let Some((text, _)) = read_file_cap(None, &home.unwrap().join(rel), DOC_SCAN_MAX) {
            docs.push(Doc { label: format!("~/{rel}"), text });
        }
    }
    docs
}

fn valid_name(n: &str) -> bool {
    n.len() <= 64 && n.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit()) && n.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_'))
}

/// 영문 단어 경계(양옆이 ASCII 영숫자가 아님)에서 `w`가 나오는가. 한글 조사(`PR을`)는 경계로 본다.
fn ascii_word(s: &str, w: &str) -> bool {
    s.match_indices(w).any(|(i, _)| !s[..i].chars().next_back().is_some_and(|c| c.is_ascii_alphanumeric()) && !s[i + w.len()..].chars().next().is_some_and(|c| c.is_ascii_alphanumeric()))
}

/// 이름 토큰이 작업을 가리키는가 (`commit-message`·`ke-commit` / `pr-message`)
fn name_is_task(name: &str, commit: bool) -> bool {
    name.split(|c: char| !c.is_ascii_alphanumeric()).any(|t| if commit { matches!(t, "commit" | "commits") } else { matches!(t, "pr" | "pull") })
}

/// 조각이 커밋(PR) 이야기인가. 이름이 작업에 맞는 스킬(`commit-message`·`pr-message`)이면 그걸로 충분하고,
/// 일반 이름(`release-notes`)은 조각에 "메시지·작성·제목…" 같은 말이 함께 있어야 한다.
/// 리뷰·승인·머지·점검 이야기(`커밋 전 보안 점검`, `PR 리뷰`)는 제외.
fn in_context(seg: &str, name: &str, commit: bool) -> bool {
    let l = seg.to_lowercase();
    let topic = if commit { l.contains("commit") || l.contains("커밋") } else { l.contains("pull request") || ascii_word(&l, "pr") };
    let has = |ks: &[&str]| ks.iter().any(|k| l.contains(k));
    if !topic || has(&["리뷰", "review", "승인", "approve", "머지", "merge", "점검", "검증", "보안", "security"]) {
        return false;
    }
    name_is_task(name, commit) || has(&["메시지", "message", "작성", "생성", "제목", "본문", "title", "body", "규칙", "컨벤션", "형식", "format", "write"])
}

/// 이름이 반대 작업용(커밋 작업에 PR 스킬, PR 작업에 커밋·승인·리뷰·머지 스킬)이면 제외
fn wrong_task(name: &str, commit: bool) -> bool {
    let t: Vec<&str> = name.split(|c: char| !c.is_ascii_alphanumeric()).collect();
    let has = |ks: &[&str]| t.iter().any(|x| ks.contains(x));
    if commit { has(&["pr", "pull"]) } else { has(&["commit", "commits", "approve", "review", "merge", "check"]) }
}

/// 한 줄을 문장·항목 단위(`. `·`·`·`|`·`;`)로 나눈 조각
/// 표 행(`|`로 시작)은 한 조각이다.
fn segments(line: &str) -> Vec<&str> {
    let seps: &[char] = if line.trim_start().starts_with('|') { &['·', ';', '。'] } else { &['·', '|', ';', '。'] };
    line.split(seps).flat_map(|p| p.split(". ")).collect()
}

/// 조각 안의 (단어, 백틱 안인가). 단어 = `[A-Za-z0-9_\-:/.~]` 연속, 끝의 `.`·`:`는 뗀다.
fn words(seg: &str) -> Vec<(String, bool)> {
    let (mut out, mut cur, mut bt, mut cur_bt) = (Vec::new(), String::new(), false, false);
    let mut flush = |cur: &mut String, bt: bool| {
        let w = cur.trim_end_matches(['.', ':']).to_string();
        if !w.is_empty() {
            out.push((w, bt));
        }
        cur.clear();
    };
    for ch in seg.chars() {
        if ch == '`' {
            flush(&mut cur, cur_bt);
            bt = !bt;
        } else if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | ':' | '/' | '.' | '~') {
            if cur.is_empty() {
                cur_bt = bt;
            }
            cur.push(ch);
        } else {
            flush(&mut cur, cur_bt);
        }
    }
    flush(&mut cur, cur_bt);
    out
}

/// 문서에서 커밋(PR) 문맥 조각에 나온 스킬 참조 (문서 순서, 같은 참조는 처음 것만).
fn find_refs(docs: &[Doc], commit: bool) -> Vec<Ref> {
    let mut out: Vec<Ref> = Vec::new();
    for d in docs {
        let mut fence = false;
        for (n, line) in d.text.lines().enumerate() {
            if line.trim_start().starts_with("```") {
                fence = !fence;
                continue;
            }
            if fence {
                continue;
            }
            for seg in segments(line) {
                let skillish = { let l = seg.to_lowercase(); l.contains("스킬") || l.contains("skill") };
                for (w, bt) in words(seg) {
                    let from = format!("{}:{}", d.label, n + 1);
                    let r = if let Some(i) = w.find("skills/") {
                        let (prefix, name) = (&w[..i + 6], w[i + 7..].split('/').next().unwrap_or(""));
                        let loc = match prefix {
                            "~/.claude/skills" => Some(Loc::User),
                            p if p == ".claude/skills" || p.ends_with("/.claude/skills") => Some(Loc::Claude),
                            p if p == ".agents/skills" || p.ends_with("/.agents/skills") => Some(Loc::Agents),
                            _ => None,
                        };
                        loc.filter(|_| valid_name(name)).map(|l| Ref { name: name.into(), form: Form::At(l), explicit: true, from })
                    } else if let Some(r) = w.strip_prefix('/') {
                        match r.split_once(':') {
                            Some((p, s)) if valid_name(p) && valid_name(s) => Some(Ref { name: s.into(), form: Form::Plugin(p.into()), explicit: true, from }),
                            None if valid_name(r) => Some(Ref { name: r.into(), form: Form::Plain, explicit: true, from }),
                            _ => None,
                        }
                    } else if !bt {
                        None
                    } else if let Some((p, s)) = w.split_once(':') {
                        (valid_name(p) && valid_name(s)).then(|| Ref { name: s.into(), form: Form::Plugin(p.into()), explicit: true, from })
                    } else {
                        valid_name(&w).then(|| Ref { explicit: skillish || (w.contains('-') && name_is_task(&w, commit)), name: w, form: Form::Plain, from })
                    };
                    if let Some(r) = r.filter(|r| !wrong_task(&r.name, commit) && in_context(seg, &r.name, commit)) {
                        if !out.iter().any(|o| o.name == r.name && o.form == r.form) {
                            out.push(r);
                        }
                    }
                }
            }
        }
    }
    out
}

/// 지정된 스킬을 찾는다. 이름만 쓰면 Claude Code와 같은 순서: 사용자 `~/.claude/skills` > 저장소 `.claude/skills` >
/// `.agents/skills` > 설치 플러그인. `plugin:skill`은 그 플러그인만, 경로는 그 자리만. 못 찾았고 분명한 지정이면 `missing` 항목.
fn referenced_skills(root: &Path, home: Option<&Path>, docs: &[Doc], commit: bool) -> Vec<Item> {
    let plugins = home.map(|h| active_plugins(root, h)).unwrap_or_default();
    let mut out: Vec<Item> = Vec::new();
    for r in find_refs(docs, commit) {
        if out.iter().filter(|i| !i.missing).count() >= REFERENCED_MAX {
            break;
        }
        let user = |n: &str| home.and_then(|h| read_file(None, &h.join(".claude/skills").join(n).join("SKILL.md")).map(|t| (format!("~/.claude/skills/{n}/SKILL.md"), t)));
        let repo = |base: &str, n: &str| read_file(Some(root), &root.join(base).join(n).join("SKILL.md")).map(|t| (format!("{base}/{n}/SKILL.md"), t));
        let plugin = |only: Option<&str>, n: &str| {
            plugins.iter().filter(|(k, _)| only.is_none_or(|o| k.split('@').next() == Some(o))).find_map(|(_, install)| {
                let f = install.join("skills").join(n).join("SKILL.md");
                read_file(Some(install), &f).map(|t| (tilde(home.unwrap_or(install), &f), t))
            })
        };
        let n = r.name.as_str();
        let found = match &r.form {
            Form::Plain => user(n).or_else(|| repo(".claude/skills", n)).or_else(|| repo(".agents/skills", n)).or_else(|| plugin(None, n)),
            Form::Plugin(p) => plugin(Some(p), n),
            Form::At(Loc::User) => user(n),
            Form::At(Loc::Claude) => repo(".claude/skills", n),
            Form::At(Loc::Agents) => repo(".agents/skills", n),
        };
        let item = match found {
            Some((path, (text, truncated))) => Item { prio: 0, kind: if matches!(r.form, Form::Plugin(_)) || path.contains("/plugins/") { "plugin" } else { "skill" }, path, text, truncated, via: Some("referenced"), from: Some(r.from), ..Default::default() },
            None if r.explicit => {
                let path = match &r.form {
                    Form::Plain => r.name.clone(),
                    Form::Plugin(p) => format!("{p}:{}", r.name),
                    Form::At(l) => format!("{}/{}", match l { Loc::User => "~/.claude/skills", Loc::Claude => ".claude/skills", Loc::Agents => ".agents/skills" }, r.name),
                };
                Item { prio: 0, kind: "skill", path, via: Some("referenced"), from: Some(r.from), missing: true, ..Default::default() }
            }
            None => continue,
        };
        if !out.iter().any(|o| o.path == item.path) {
            out.push(item);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn w(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    fn skill(root: &Path, base: &str, name: &str, desc: &str, body: &str) {
        w(root, &format!("{base}/{name}/SKILL.md"), &format!("---\nname: {name}\ndescription: \"{desc}\"\n---\n{body}"));
    }

    fn init(root: &Path) {
        for a in [&["init", "-q", "-b", "feat/ABC-12-x"][..], &["config", "user.email", "a@b.c"], &["config", "user.name", "n"], &["config", "commit.gpgsign", "false"]] {
            assert!(std::process::Command::new("git").args(a).current_dir(root).status().unwrap().success());
        }
    }

    fn commit(root: &Path, msg: &str) {
        assert!(std::process::Command::new("git").args(["commit", "-q", "--allow-empty", "-m", msg]).current_dir(root).status().unwrap().success());
    }

    fn kinds(c: &Collected) -> Vec<(&'static str, &str)> {
        c.sources.iter().map(|s| (s.kind, s.path.as_str())).collect()
    }

    async fn run(root: &Path, task: gc_ai::Task, home: Option<&Path>) -> Option<Collected> {
        collect(&GitRunner::new("git"), root, task, home.map(Path::to_path_buf)).await
    }

    #[test]
    fn skill_relevance_uses_name_and_description_head() {
        assert!(skill_matches("commit-message", "x", true) && skill_matches("ke-commit", "", true) && skill_matches("a", "변경을 분석해 커밋 메시지를", true));
        assert!(!skill_matches("roadmap-step", "로드맵 단계를 진행한다. 단계 완료 확인·커밋 요청에 트리거", true), "곁다리 커밋 언급");
        assert!(!skill_matches("ke-securityguard", &format!("{}커밋 직전 실행", "코드를 점검한다. ".repeat(20)), true), "설명 뒷부분의 곁다리 언급은 무시");
        assert!(skill_matches("pr-message", "x", false) && skill_matches("a", "브랜치를 분석해 PR 제목과 본문을 만든다", false));
        assert!(!skill_matches("pr-approve", "다른 사람이 올린 PR 을 검증", false) && !skill_matches("review-code", "PR 리뷰, 코드 리뷰", false));
        assert!(!skill_matches("pr-message", "PR 제목", true), "PR 스킬은 커밋에 안 쓴다");
        assert_eq!(frontmatter("---\nname: x\ndescription: |\n  첫째\n  둘째\n---\nbody"), ("x".into(), "첫째 둘째".into()));
    }

    #[tokio::test]
    async fn collects_repo_skills_docs_history_and_branch_by_task() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        init(r);
        commit(r, "feat: 첫 커밋");
        commit(r, "fix(ABC-12): 두 번째");
        skill(r, ".claude/skills", "commit-message", "커밋 메시지 작성", "한국어 Conventional Commits");
        skill(r, ".agents/skills", "commit-message", "커밋 메시지 작성", "중복(앞의 .claude만 쓴다)");
        skill(r, ".agents/skills", "pr-message", "PR 제목·본문 작성", "PR 규칙");
        skill(r, ".claude/skills", "review-code", "코드 리뷰", "무관");
        w(r, "AGENTS.md", "AI-Use footer 규칙");
        w(r, "CLAUDE.md", "클로드 규칙");
        w(r, ".github/CONTRIBUTING.md", "기여 가이드");
        w(r, ".github/copilot-instructions.md", "코파일럿");
        w(r, ".commitlintrc.json", "{\"extends\":[]}");
        w(r, ".github/pull_request_template.md", "## 요약");
        w(r, ".github/PULL_REQUEST_TEMPLATE/bug.md", "## 버그");

        let c = run(r, gc_ai::Task::Commit, None).await.unwrap();
        assert_eq!(
            kinds(&c),
            [("skill", ".claude/skills/commit-message/SKILL.md"), ("claude", "CLAUDE.md"), ("agents", "AGENTS.md"), ("commitlint", ".commitlintrc.json"), ("history", "git log -n 20"), ("branch", "HEAD"), ("contributing", ".github/CONTRIBUTING.md"), ("copilot", ".github/copilot-instructions.md")]
        );
        assert!(c.text.contains("한국어 Conventional Commits") && c.text.contains("fix(ABC-12): 두 번째") && c.text.contains("current branch: feat/ABC-12-x"));
        assert!(!c.text.contains("PR 규칙") && !c.text.contains("## 요약") && !c.text.contains("무관") && !c.text.contains("중복"));

        let p = run(r, gc_ai::Task::Pr, None).await.unwrap();
        assert_eq!(kinds(&p)[0], ("skill", ".agents/skills/pr-message/SKILL.md"));
        assert!(p.sources.iter().any(|s| s.path == ".github/pull_request_template.md") && p.sources.iter().any(|s| s.path == ".github/PULL_REQUEST_TEMPLATE/bug.md"));
        assert!(!p.text.contains("Conventional Commits") && !p.text.contains("commitlint"));

        // 다른 작업엔 없음
        assert!(run(r, gc_ai::Task::Review, None).await.is_none());
        // 저장소별 끄기
        for v in ["false", "off", "0"] {
            assert!(std::process::Command::new("git").args(["config", "git403.aiConventions", v]).current_dir(r).status().unwrap().success());
            assert!(run(r, gc_ai::Task::Commit, None).await.is_none(), "{v}");
        }
        assert!(std::process::Command::new("git").args(["config", "git403.aiConventions", "true"]).current_dir(r).status().unwrap().success());
        assert!(run(r, gc_ai::Task::Commit, None).await.is_some());
    }

    #[tokio::test]
    async fn nothing_found_is_none_and_commit_template_is_read() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        init(r);
        assert!(run(r, gc_ai::Task::Commit, None).await.is_none(), "커밋도 문서도 없으면 None");
        let tpl_dir = tempfile::tempdir().unwrap();
        let tpl = tpl_dir.path().join("gitmessage");
        fs::write(&tpl, "[TICKET] 제목\n\n# 본문").unwrap();
        let set = |v: &str| assert!(std::process::Command::new("git").args(["config", "commit.template", v]).current_dir(r).status().unwrap().success());
        set(&tpl.display().to_string());
        // 홈 아래면 읽는다
        let c = run(r, gc_ai::Task::Commit, Some(tpl_dir.path())).await.unwrap();
        assert!(c.sources.iter().any(|s| s.kind == "template" && s.path.starts_with("commit.template") && !s.skipped) && c.text.contains("[TICKET] 제목"));
        // 홈·저장소 밖이면 건너뛰고 출처에 skipped로 표시
        let c = run(r, gc_ai::Task::Commit, None).await.unwrap();
        assert!(c.sources.iter().any(|s| s.kind == "template" && s.skipped) && !c.text.contains("[TICKET]"), "{:?}", c.sources);
        // 저장소 안의 심볼릭 링크가 밖을 가리키면 실제 경로 기준으로 건너뜀
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&tpl, r.join("tpl-link")).unwrap();
            set("tpl-link");
            let c = run(r, gc_ai::Task::Commit, None).await.unwrap();
            assert!(c.sources.iter().any(|s| s.kind == "template" && s.skipped) && !c.text.contains("[TICKET]"));
        }
        // 저장소 안 일반 파일은 읽는다
        fs::write(r.join("msg.txt"), "[REPO] 제목").unwrap();
        set("msg.txt");
        let c = run(r, gc_ai::Task::Commit, None).await.unwrap();
        assert!(c.text.contains("[REPO] 제목"));
        set(&tpl.display().to_string());
        assert!(run(r, gc_ai::Task::Pr, None).await.is_none_or(|c| !c.text.contains("[TICKET]")), "PR엔 커밋 템플릿을 안 쓴다");
    }

    fn fake_home(home: &Path, plugins: &str, settings: &str) -> PathBuf {
        let v1 = home.join(".claude/plugins/cache/mk/acme/1.0.0");
        let v2 = home.join(".claude/plugins/cache/mk/acme/2.0.0");
        skill(&v1, "skills", "ke-commit", "커밋 메시지", "옛 버전");
        skill(&v2, "skills", "ke-commit", "(acme) 커밋 메시지", "새 버전 규칙");
        skill(&v2, "skills", "ke-other", "다른 일", "무관");
        w(home, ".claude/plugins/installed_plugins.json", &plugins.replace("HOME", &home.display().to_string()));
        w(home, ".claude/settings.json", settings);
        v2
    }

    const PLUGINS: &str = r#"{"version":2,"plugins":{"acme@mk":[{"scope":"managed","installPath":"HOME/.claude/plugins/cache/mk/acme/2.0.0"}],"x@mk":[{"scope":"project","projectPath":"/elsewhere","installPath":"HOME/.claude/plugins/cache/mk/acme/1.0.0"}]}}"#;

    #[tokio::test]
    async fn plugin_skills_only_without_repo_skills_and_only_pointed_version() {
        let (d, h) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        init(d.path());
        fake_home(h.path(), PLUGINS, "{}");
        let c = run(d.path(), gc_ai::Task::Commit, Some(h.path())).await.unwrap();
        let plugin: Vec<_> = c.sources.iter().filter(|s| s.kind == "plugin").collect();
        assert_eq!(plugin.len(), 1, "{:?}", c.sources);
        assert!(plugin[0].path.starts_with("~/.claude/plugins/cache/mk/acme/2.0.0/skills/ke-commit"), "{}", plugin[0].path);
        assert!(c.text.contains("새 버전 규칙") && !c.text.contains("옛 버전") && !c.text.contains("무관"));
        // PR 작업엔 커밋 스킬을 쓰지 않는다
        assert!(run(d.path(), gc_ai::Task::Pr, Some(h.path())).await.is_none_or(|c| !c.text.contains("새 버전")));
        // enabledPlugins false면 제외
        fake_home(h.path(), PLUGINS, r#"{"enabledPlugins":{"acme@mk":false}}"#);
        assert!(run(d.path(), gc_ai::Task::Commit, Some(h.path())).await.is_none_or(|c| c.sources.iter().all(|s| s.kind != "plugin")));
        // 저장소 스킬이 있으면 플러그인은 안 본다
        fake_home(h.path(), PLUGINS, "{}");
        skill(d.path(), ".claude/skills", "commit-message", "커밋", "저장소 규칙");
        let c = run(d.path(), gc_ai::Task::Commit, Some(h.path())).await.unwrap();
        assert!(c.sources.iter().all(|s| s.kind != "plugin") && c.text.contains("저장소 규칙") && !c.text.contains("새 버전"));
    }

    #[tokio::test]
    async fn caps_per_file_and_total_by_priority_and_marks_truncated() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        init(r);
        skill(r, ".claude/skills", "commit-message", "커밋", &"스".repeat(10_000)); // 30KB(3바이트 글자) → 16KB 컷
        w(r, "CLAUDE.md", &"c".repeat(20_000));
        w(r, "AGENTS.md", &"a".repeat(10_000));
        w(r, "GEMINI.md", &"g".repeat(10_000));
        w(r, "CONTRIBUTING.md", "마지막");
        let c = run(r, gc_ai::Task::Commit, None).await.unwrap();
        let get = |k: &str| c.sources.iter().find(|s| s.kind == k).unwrap().clone();
        // 16K(스킬) + 16K(CLAUDE) + 8K(AGENTS, 남은 만큼) = 40K 소진 → 뒤의 것은 못 넣고 잘림 표시만
        assert!(["skill", "claude", "agents", "gemini", "contributing"].iter().all(|k| get(k).truncated));
        assert!(c.text.len() <= TOTAL_MAX, "머리글 포함 합계 상한 이내: {}", c.text.len());
        assert!(!c.text.contains("마지막") && c.text.contains("[... truncated]"));
        // 글자 경계에서 자른다 (유효한 UTF-8)
        assert!(c.text.is_char_boundary(c.text.len()));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlink_outside_repo_is_rejected_inside_is_allowed() {
        let (d, out) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let r = d.path();
        init(r);
        fs::write(out.path().join("secret.md"), "비밀").unwrap();
        std::os::unix::fs::symlink(out.path().join("secret.md"), r.join("CLAUDE.md")).unwrap();
        w(r, "real/AGENTS.md", "안쪽 규칙");
        std::os::unix::fs::symlink(r.join("real/AGENTS.md"), r.join("AGENTS.md")).unwrap();
        // 스킬 폴더 통째로 밖을 가리키는 링크
        skill(out.path(), "s", "commit-message", "커밋", "밖의 스킬");
        fs::create_dir_all(r.join(".claude")).unwrap();
        std::os::unix::fs::symlink(out.path().join("s"), r.join(".claude/skills")).unwrap();
        let c = run(r, gc_ai::Task::Commit, None).await.unwrap();
        assert!(c.text.contains("안쪽 규칙") && !c.text.contains("비밀") && !c.text.contains("밖의 스킬"), "{}", c.text);
    }

    #[test]
    fn binary_and_non_utf8_are_skipped_and_cut_char_is_trimmed() {
        let d = tempfile::tempdir().unwrap();
        let r = std::fs::canonicalize(d.path()).unwrap();
        fs::write(r.join("nul.md"), b"abc\0def").unwrap();
        fs::write(r.join("latin.md"), [0xff, 0xfe, b'a']).unwrap();
        fs::write(r.join("dir.md"), "x").unwrap();
        fs::create_dir(r.join("d.md")).unwrap();
        assert!(read_file(Some(&r), &r.join("nul.md")).is_none() && read_file(Some(&r), &r.join("latin.md")).is_none() && read_file(Some(&r), &r.join("d.md")).is_none());
        assert_eq!(read_file(Some(&r), &r.join("dir.md")), Some(("x".into(), false)));
        // 상한 경계에 걸친 3바이트 글자는 버리고 잘림 표시
        fs::write(r.join("big.md"), "가".repeat(6_000)).unwrap();
        let (t, tr) = read_file(Some(&r), &r.join("big.md")).unwrap();
        assert!(tr && t.len() <= FILE_MAX && t.len() % 3 == 0 && t.chars().all(|c| c == '가'));
    }

    fn skill_src(c: &Collected) -> Vec<(&str, Option<&str>, Option<&str>, bool)> {
        c.sources.iter().filter(|s| s.kind == "skill" || s.kind == "plugin").map(|s| (s.path.as_str(), s.via, s.from.as_deref(), s.missing)).collect()
    }

    #[tokio::test]
    async fn referenced_skill_wins_even_with_generic_name_and_marks_from() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path();
        init(r);
        skill(r, ".claude/skills", "release-notes", "릴리즈 노트", "릴리즈 규칙 본문");
        skill(r, ".claude/skills", "commit-message", "커밋", "이름 매칭이었다면 이게 뽑혔을 것");
        w(r, "AGENTS.md", "# 규칙\n- 커밋 메시지는 `release-notes` 스킬로 작성한다.\n");
        let c = run(r, gc_ai::Task::Commit, None).await.unwrap();
        assert_eq!(skill_src(&c), [(".claude/skills/release-notes/SKILL.md", Some("referenced"), Some("AGENTS.md:2"), false)]);
        assert!(c.text.contains("릴리즈 규칙 본문") && !c.text.contains("이름 매칭"));
        // PR 작업에선 커밋 문맥 지정이므로 쓰지 않는다 → 대체 매칭(PR 스킬 없음)
        assert!(run(r, gc_ai::Task::Pr, None).await.is_none_or(|c| skill_src(&c).is_empty()));
    }

    #[tokio::test]
    async fn resolution_order_user_then_repo_claude_then_agents_then_plugin() {
        let (d, h) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let (r, hp) = (d.path(), h.path());
        init(r);
        fake_home(hp, PLUGINS, "{}");
        w(r, "CLAUDE.md", "- `commit-message`(커밋 — 필수 경유) · `pr-message`(PR 제목·본문 생성 — 필수 경유)\n");
        skill(r, ".agents/skills", "commit-message", "c", "agents 사본");
        let one = |c: &Collected| skill_src(c).iter().map(|s| s.0.to_string()).collect::<Vec<_>>();
        let c = run(r, gc_ai::Task::Commit, Some(hp)).await.unwrap();
        assert_eq!(one(&c), [".agents/skills/commit-message/SKILL.md"], "pr-message는 커밋에서 제외");
        skill(r, ".claude/skills", "commit-message", "c", "claude 사본");
        let c = run(r, gc_ai::Task::Commit, Some(hp)).await.unwrap();
        assert_eq!(one(&c), [".claude/skills/commit-message/SKILL.md"]);
        skill(hp, ".claude/skills", "commit-message", "c", "사용자 사본");
        let c = run(r, gc_ai::Task::Commit, Some(hp)).await.unwrap();
        assert_eq!(one(&c), ["~/.claude/skills/commit-message/SKILL.md"]);
        assert!(c.text.contains("사용자 사본") && !c.text.contains("claude 사본"));
        assert_eq!(c.sources[0].via, Some("referenced"));
        assert_eq!(c.sources[0].from.as_deref(), Some("CLAUDE.md:1"));
        // 같은 줄의 pr-message는 PR 작업에서 지정으로 잡히지만 없으면 알린다
        let p = run(r, gc_ai::Task::Pr, Some(hp)).await.unwrap();
        assert_eq!(skill_src(&p), [("pr-message", Some("referenced"), Some("CLAUDE.md:1"), true)]);
        // 저장소에 없으면 설치 플러그인에서
        w(r, "CLAUDE.md", "- 커밋 메시지는 `ke-commit` 스킬로\n");
        let c = run(r, gc_ai::Task::Commit, Some(hp)).await.unwrap();
        assert!(one(&c)[0].starts_with("~/.claude/plugins/cache/mk/acme/2.0.0/skills/ke-commit"), "{:?}", one(&c));
        assert_eq!(c.sources[0].kind, "plugin");
    }

    #[tokio::test]
    async fn plugin_skill_slash_and_path_forms() {
        let (d, h) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let (r, hp) = (d.path(), h.path());
        init(r);
        fake_home(hp, PLUGINS, "{}");
        skill(r, ".claude/skills", "commit-message", "c", "claude 사본");
        skill(r, ".agents/skills", "commit-message", "c", "agents 사본");
        // plugin:skill은 그 플러그인만(저장소·사용자의 같은 이름은 무시)
        w(r, "CLAUDE.md", "커밋은 `acme:ke-commit` 로 한다\n커밋은 `/other:ke-commit` 로\n");
        let c = run(r, gc_ai::Task::Commit, Some(hp)).await.unwrap();
        assert_eq!(skill_src(&c).len(), 2);
        assert!(skill_src(&c)[0].0.contains("acme/2.0.0/skills/ke-commit") && c.text.contains("새 버전 규칙"));
        assert_eq!(skill_src(&c)[1], ("other:ke-commit", Some("referenced"), Some("CLAUDE.md:2"), true), "없는 플러그인은 누락");
        // 슬래시 호출
        w(r, "CLAUDE.md", "커밋할 땐 /acme:ke-commit 을 호출\n");
        let c = run(r, gc_ai::Task::Commit, Some(hp)).await.unwrap();
        assert!(skill_src(&c)[0].0.contains("ke-commit") && skill_src(&c)[0].2 == Some("CLAUDE.md:1"));
        // 경로 참조는 그 자리만
        w(r, "CLAUDE.md", "커밋 규칙: .agents/skills/commit-message/SKILL.md 를 따른다\n");
        let c = run(r, gc_ai::Task::Commit, Some(hp)).await.unwrap();
        assert_eq!(skill_src(&c), [(".agents/skills/commit-message/SKILL.md", Some("referenced"), Some("CLAUDE.md:1"), false)]);
        assert!(c.text.contains("agents 사본") && !c.text.contains("claude 사본"));
        w(r, "CLAUDE.md", "커밋 규칙: `~/.claude/skills/commit-message` 를 따른다\n");
        let c = run(r, gc_ai::Task::Commit, Some(hp)).await.unwrap();
        assert_eq!(skill_src(&c), [("~/.claude/skills/commit-message", Some("referenced"), Some("CLAUDE.md:1"), true)], "경로가 가리키는 자리에 없으면 누락(다른 사본으로 대체 안 함)");
    }

    #[tokio::test]
    async fn missing_matched_fallback_and_out_of_context_mentions() {
        let (d, h) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let (r, hp) = (d.path(), h.path());
        init(r);
        skill(r, ".claude/skills", "review-code", "코드 리뷰", "리뷰 규칙");
        skill(r, ".claude/skills", "commit-message", "커밋", "이름으로 찾은 사본");
        // 지정 없음: 리뷰·점검·PR 리뷰 언급은 커밋 문맥 밖 → 이름·설명 매칭으로 대체
        w(r, "CLAUDE.md", "코드 리뷰는 `review-code` 로\n커밋 전 보안 점검은 `/ke-securityguard`\nPR 리뷰는 `pr-approve` 로\n커밋 메시지 형식은 `conventional` 을 따른다\n");
        let c = run(r, gc_ai::Task::Commit, Some(hp)).await.unwrap();
        assert_eq!(skill_src(&c), [(".claude/skills/commit-message/SKILL.md", Some("matched"), None, false)], "문서에 없는 일반 이름은 누락으로 안 알린다");
        assert!(c.sources.iter().filter(|s| s.kind == "skill").all(|s| !s.path.contains("review") && !s.path.contains("securityguard")));
        // 사용자 전역 문서의 분명한 지정("스킬")이 안 풀리면 누락으로 남고 대체 매칭은 하지 않는다
        w(hp, ".claude/CLAUDE.md", "- 전역: 커밋 메시지는 `global-commit` 스킬로\n");
        let c = run(r, gc_ai::Task::Commit, Some(hp)).await.unwrap();
        assert_eq!(skill_src(&c), [("global-commit", Some("referenced"), Some("~/.claude/CLAUDE.md:1"), true)]);
        // 전역 문서 내용 자체는 프롬프트에 넣지 않는다
        assert!(!c.text.contains("전역:"));
        // 누락만 있어도 다른 문서·이력이 있으면 결과는 있다
        assert!(c.sources.iter().any(|s| s.kind == "claude"));
    }

    #[test]
    fn find_refs_handles_table_rows_slash_and_skips_fences() {
        let doc = |t: &str| vec![Doc { label: "D.md".into(), text: t.into() }];
        let names = |t: &str, commit| find_refs(&doc(t), commit).into_iter().map(|r| (r.name, r.form, r.from)).collect::<Vec<_>>();
        let sample = "- **유틸**: `commit-message`(커밋 — 필수 경유) · `pr-message`(PR 제목·본문 생성 — 필수 경유) · `pr-approve`(PR 실측 검증 → 코멘트 → 승인 → 머지 — 필수 경유) · `jira-issue`(지라 이슈 등록)";
        assert_eq!(names(sample, true), [("commit-message".into(), Form::Plain, "D.md:1".into())]);
        assert_eq!(names(sample, false), [("pr-message".into(), Form::Plain, "D.md:1".into())]);
        // 표 행
        // 백틱 단어 `commit`·`pr` 자체는 스킬 지정이 아니다(찾지 못해도 누락으로 안 알림)
        let bare = find_refs(&doc("커밋은 `commit` 으로, PR 작성은 `pr` 로"), true);
        assert!(bare.iter().all(|r| !r.explicit), "{bare:?}");
        assert_eq!(names("| 커밋 | `/release-notes` | 메시지 작성 |", true).len(), 1);
        // 코드 블록 안은 무시, 커밋 말이 없는 줄도 무시
        assert!(names("```\n커밋은 `x-y` 로\n```\n`other-x` 는 다른 얘기", true).is_empty());
        // 파일 경로·URL·대문자 이름은 이름으로 안 본다
        assert!(names("커밋은 `/usr/bin/git`, `Resolves:`, https://x.y/z 로", true).is_empty());
    }
}
