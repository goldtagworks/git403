//! 설정 내보내기·가져오기: UI 설정·AI 설정·계정 목록·전역 git 설정을 버전 있는 JSON 한 파일로 주고받는다.
//!
//! 절대 담지 않는 것: 키체인 값(API 키·토큰), AI 동의 기록, gh 토큰. 계정은 provider·host·username만 옮기고
//! 가져온 PC에서 토큰을 다시 연결해야 한다. 가져올 때는 크기·형식·허용 키·토큰 모양을 검사한다.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use gc_hosting::Account;
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::util::{err, off, Res};
use crate::Backend;

const FORMAT: &str = "git403-settings";
const VERSION: u64 = 1;
/// 입력 크기 상한 (바이트)
const MAX_BYTES: usize = 1_000_000;
/// 섹션 id (내보내기 순서)
const SECTIONS: [&str; 5] = ["ui", "ai", "accounts", "gitGlobal", "tools"];
const AI_PROVIDERS: [&str; 4] = ["anthropic", "openai", "google", "xai"];
/// 토큰으로 보이는 접두사와, 접두사 뒤에 이어져야 하는 최소 글자 수
const TOKEN_PREFIXES: [(&str, usize); 11] = [
    ("ghp_", 16),
    ("gho_", 16),
    ("ghu_", 16),
    ("ghs_", 16),
    ("ghr_", 16),
    ("github_pat_", 16),
    ("glpat-", 16),
    ("sk-", 16),
    ("xai-", 16),
    ("AIza", 20),
    ("xox", 16),
];

#[derive(Serialize)]
pub(crate) struct Change {
    key: String,
    from: Option<String>,
    to: String,
}

#[derive(Serialize)]
pub(crate) struct SectionPreview {
    id: &'static str,
    changes: Vec<Change>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Preview {
    version: u64,
    sections: Vec<SectionPreview>,
    skipped: Vec<String>,
    /// 코드 있는 경고: `{code, vars, message}` (UI가 `code`로 번역)
    warnings: Vec<Value>,
}

/// 읽어서 검사를 마친 파일
struct Doc {
    version: u64,
    sections: Map<String, Value>,
    skipped: Vec<String>,
    warnings: Vec<Value>,
}

// ---- 검사 ----

/// 토큰처럼 보이는 단어(접두사 + 충분히 긴 영숫자)가 값·키 어디에든 있는가
fn has_secret(v: &Value) -> bool {
    let word = |s: &str| s.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-')).any(|w| TOKEN_PREFIXES.iter().any(|(p, n)| w.starts_with(p) && w.len() >= p.len() + n));
    match v {
        Value::String(s) => word(s),
        Value::Array(a) => a.iter().any(has_secret),
        Value::Object(m) => m.iter().any(|(k, v)| word(k) || has_secret(v)),
        _ => false,
    }
}

fn secret_error() -> String {
    gc_i18n::coded!("settings.io.secret", "The file contains something that looks like an API key or token. Import was refused; remove it and export again").json()
}

fn parse(text: &str) -> Res<Doc> {
    if text.len() > MAX_BYTES {
        return Err(gc_i18n::coded!("settings.io.tooLarge", "The settings file is too large (limit 1MB)").json());
    }
    let bad = || -> String { gc_i18n::coded!("settings.io.notSettings", "Not a git403 settings file").json() };
    let v: Value = serde_json::from_str(text).map_err(|_| bad())?;
    if v.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return Err(bad());
    }
    let version = v.get("version").and_then(Value::as_u64).filter(|n| *n >= 1).ok_or_else(bad)?;
    if has_secret(&v) {
        return Err(secret_error());
    }
    let Some(Value::Object(all)) = v.get("sections").cloned() else { return Err(bad()) };
    let (mut sections, mut skipped, mut warnings) = (Map::new(), vec![], vec![]);
    for (k, val) in all {
        if SECTIONS.contains(&k.as_str()) {
            sections.insert(k, val);
        } else {
            skipped.push(format!("section:{k}"));
        }
    }
    if version > VERSION {
        warnings.push(gc_i18n::coded!("settings.io.newerVersion", "This file is from a newer version of git403 (format {version}); only known items are read", version = version).value());
    }
    Ok(Doc { version, sections, skipped, warnings })
}

/// git 키 정규화: 섹션·변수 이름은 소문자(git이 그렇게 돌려준다), 가운데 서브섹션은 그대로
fn norm_key(k: &str) -> String {
    let parts: Vec<&str> = k.split('.').collect();
    match parts.len() {
        0 | 1 => k.to_lowercase(),
        n => parts.iter().enumerate().map(|(i, p)| if i == 0 || i == n - 1 { p.to_lowercase() } else { p.to_string() }).collect::<Vec<_>>().join("."),
    }
}

fn plain(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// 허용 git 키: 섹션 `gitGlobal`은 `git403.*`(저장소별 연결 `ghAccount`·디버그 키 제외), `tools`는 `diff.tool`·`merge.tool`뿐
fn key_allowed(section: &str, key: &str) -> bool {
    let k = norm_key(key);
    if section == "tools" {
        return k == "diff.tool" || k == "merge.tool";
    }
    let Some(rest) = k.strip_prefix("git403.") else { return false };
    plain(rest, 100) && !rest.contains("..") && !rest.starts_with('.') && !rest.ends_with('.') && !["ghaccount", "debugsimulate"].contains(&rest)
}

fn value_ok(section: &str, v: &str) -> bool {
    if section == "tools" { plain(v, 50) } else { v.len() <= 1024 && !v.chars().any(char::is_control) }
}

fn host_ok(h: &str) -> bool {
    !h.is_empty() && h.len() <= 253 && h.chars().all(|c| c.is_ascii_alphanumeric() || ".-:/_".contains(c))
}

/// 섹션 하나를 검사해 내부 표준 형태로 만든다. 못 쓰는 항목은 `skipped`에 `섹션:항목`으로 쌓는다.
fn clean(id: &str, v: &Value, skipped: &mut Vec<String>) -> Res<Value> {
    let shape = || -> String { gc_i18n::coded!("settings.io.badShape", "Section `{id}` has the wrong shape", id = id).json() };
    Ok(match id {
        "ui" => {
            if !v.is_object() {
                return Err(shape());
            }
            v.clone()
        }
        "ai" => {
            let o = v.as_object().ok_or_else(shape)?;
            let mut out = Map::new();
            for (k, val) in o {
                match (k.as_str(), val) {
                    ("provider", Value::String(p)) if AI_PROVIDERS.contains(&p.as_str()) => drop(out.insert(k.clone(), val.clone())),
                    ("conventions", Value::Bool(_)) => drop(out.insert(k.clone(), val.clone())),
                    ("providers", Value::Object(ps)) => {
                        let mut pm = Map::new();
                        for (name, s) in ps {
                            let mut one = Map::new();
                            if AI_PROVIDERS.contains(&name.as_str()) {
                                for (f, fv) in s.as_object().into_iter().flatten() {
                                    match (f.as_str(), fv.as_str()) {
                                        ("model", Some(m)) if m.len() <= 100 && !m.chars().any(|c| c.is_whitespace() || c.is_control()) => drop(one.insert(f.clone(), fv.clone())),
                                        ("method", Some("auto" | "cli" | "key")) => drop(one.insert(f.clone(), fv.clone())),
                                        _ => skipped.push(format!("ai:{name}.{f}")),
                                    }
                                }
                                pm.insert(name.clone(), Value::Object(one));
                            } else {
                                skipped.push(format!("ai:{name}"));
                            }
                        }
                        out.insert(k.clone(), Value::Object(pm));
                    }
                    _ => skipped.push(format!("ai:{k}")),
                }
            }
            Value::Object(out)
        }
        "accounts" => {
            let mut out = vec![];
            for (i, a) in v.as_array().ok_or_else(shape)?.iter().enumerate() {
                match serde_json::from_value::<Account>(a.clone()) {
                    Ok(a) if host_ok(&a.host) && a.username.len() <= 100 && !a.username.chars().any(char::is_control) => out.push(json!({"provider": a.provider, "host": a.host.to_lowercase(), "username": a.username})),
                    _ => skipped.push(format!("accounts:{i}")),
                }
            }
            Value::Array(out)
        }
        _ => {
            let o = v.as_object().ok_or_else(shape)?;
            let mut out = Map::new();
            for (k, val) in o {
                match val.as_str() {
                    Some(s) if key_allowed(id, k) && value_ok(id, s) => drop(out.insert(norm_key(k), val.clone())),
                    _ => skipped.push(format!("{id}:{k}")),
                }
            }
            Value::Object(out)
        }
    })
}

// ---- 현재 값 ----

/// 비교용 평면 맵: 키 → 보여줄 값
fn flatten(id: &str, v: &Value) -> BTreeMap<String, String> {
    let mut m = BTreeMap::new();
    let s = |v: &Value| v.as_str().map(String::from).unwrap_or_else(|| v.to_string());
    match id {
        "ai" => {
            for (k, val) in v.as_object().into_iter().flatten() {
                if k == "providers" {
                    for (p, one) in val.as_object().into_iter().flatten() {
                        for (f, fv) in one.as_object().into_iter().flatten() {
                            m.insert(format!("{p}.{f}"), s(fv));
                        }
                    }
                } else {
                    m.insert(k.clone(), s(val));
                }
            }
        }
        "accounts" => {
            for a in v.as_array().into_iter().flatten() {
                m.insert(format!("{}:{}", s(&a["provider"]), s(&a["host"])), s(&a["username"]));
            }
        }
        _ => {
            for (k, val) in v.as_object().into_iter().flatten() {
                let t = s(val);
                m.insert(k.clone(), if t.chars().count() > 200 { t.chars().take(200).collect::<String>() + "…" } else { t });
            }
        }
    }
    m
}

impl Backend {
    fn ai_path(&self) -> PathBuf {
        self.config_dir.join("ai.json")
    }

    /// 전역 git 설정에서 허용 키만 읽는다 (`gitGlobal`, `tools` 섹션 값)
    async fn git_globals(&self) -> Res<(Map<String, Value>, Map<String, Value>)> {
        let out = self.backend.run(&std::env::temp_dir(), &["config", "--global", "--null", "--get-regexp", r"^(git403\..*|(diff|merge)\.tool)$"], &[1]).await.map_err(err)?;
        let (mut g, mut t) = (Map::new(), Map::new());
        for entry in String::from_utf8_lossy(&out).split('\0').filter(|e| !e.is_empty()) {
            let (k, v) = entry.split_once('\n').unwrap_or((entry, ""));
            for (id, m) in [("gitGlobal", &mut g), ("tools", &mut t)] {
                if key_allowed(id, k) && value_ok(id, v) {
                    m.insert(norm_key(k), json!(v));
                }
            }
        }
        Ok((g, t))
    }

    /// 지금 설정을 섹션별로 모은다. `ui`는 UI(localStorage)가 넘겨준 값
    async fn current(&self, ui: Option<Value>) -> Res<Map<String, Value>> {
        let (ai_path, accts) = (self.ai_path(), self.hosting.accounts());
        let (s, list) = off(move || Ok((gc_ai::Settings::load(&ai_path).map_err(|e| e.ipc())?, accts.list().map_err(|e| e.ipc())?))).await?;
        let mut providers = Map::new();
        for name in AI_PROVIDERS {
            let p: gc_ai::Provider = serde_json::from_value(json!(name)).map_err(|e| e.to_string())?;
            let o = s.of(p);
            providers.insert(name.into(), json!({"model": o.model, "method": o.method}));
        }
        let (g, t) = self.git_globals().await?;
        let mut m = Map::new();
        if let Some(ui) = ui.filter(Value::is_object) {
            m.insert("ui".into(), ui);
        }
        m.insert("ai".into(), json!({"provider": s.provider, "conventions": s.conventions, "providers": providers}));
        m.insert("accounts".into(), Value::Array(list.iter().map(|a| json!({"provider": a.provider, "host": a.host, "username": a.username})).collect()));
        m.insert("gitGlobal".into(), Value::Object(g));
        m.insert("tools".into(), Value::Object(t));
        Ok(m)
    }

    async fn export_doc(&self, ui: Option<Value>) -> Res<String> {
        let sections = self.current(ui).await?;
        let (iso, _) = utc_now();
        let doc = json!({"format": FORMAT, "version": VERSION, "app": env!("CARGO_PKG_VERSION"), "exportedAt": iso, "sections": sections});
        if has_secret(&doc) {
            return Err(secret_error());
        }
        serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())
    }

    /// 내보내기. 키체인·동의·토큰은 읽지도 않는다.
    pub(crate) async fn settings_export(&self, ui: Value) -> Res<Value> {
        if !ui.is_object() {
            return Err(gc_i18n::coded!("settings.io.uiNotObject", "`ui` must be an object").json());
        }
        Ok(json!({"json": self.export_doc(Some(ui)).await?}))
    }

    /// 내보내기를 `path`에 쓴다 (UI가 저장 대화상자로 고른 경로)
    pub(crate) async fn settings_export_file(&self, ui: Value, path: PathBuf) -> Res<Value> {
        let text = self.settings_export(ui).await?["json"].as_str().unwrap_or_default().to_string();
        off(move || std::fs::write(&path, text).map_err(|e| e.to_string())).await?;
        Ok(Value::Null)
    }

    /// 가져올 파일 읽기 (크기 상한 검사). 내용 검사는 preview가 한다.
    pub(crate) async fn settings_read_file(&self, path: PathBuf) -> Res<Value> {
        off(move || {
            let len = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
            if len as usize > MAX_BYTES {
                return Err(gc_i18n::coded!("settings.io.tooLarge", "The settings file is too large (limit 1MB)").json());
            }
            Ok(json!({"json": std::fs::read_to_string(&path).map_err(|e| e.to_string())?}))
        })
        .await
    }

    pub(crate) async fn settings_import_preview(&self, text: String, ui: Option<Value>) -> Res<Preview> {
        let mut doc = parse(&text)?;
        let cur = self.current(ui).await?;
        let mut sections = vec![];
        for id in SECTIONS {
            let Some(v) = doc.sections.get(id) else { continue };
            let incoming = flatten(id, &clean(id, v, &mut doc.skipped)?);
            let have = cur.get(id).map(|c| flatten(id, c)).unwrap_or_default();
            let changes: Vec<Change> = incoming.into_iter().filter(|(k, to)| have.get(k) != Some(to) && !(id == "accounts" && have.contains_key(k))).map(|(key, to)| Change { from: have.get(&key).cloned(), key, to }).collect();
            if !changes.is_empty() {
                sections.push(SectionPreview { id, changes });
            }
        }
        if doc.skipped.iter().any(|s| s.starts_with("gitGlobal:") || s.starts_with("tools:")) {
            doc.warnings.push(gc_i18n::coded!("settings.io.gitKeysRefused", "Git config keys outside the allowed list were found; applying those sections will be refused").value());
        }
        Ok(Preview { version: doc.version, sections, skipped: doc.skipped, warnings: doc.warnings })
    }

    /// 고른 섹션만 적용한다. 적용 전 현재 설정을 `backups/settings-<시각>.json`에 저장한다.
    /// AI 동의(consent)는 건드리지 않는다. 계정은 토큰 없이 항목만 더하고 `reconnect`로 알린다. `ui`는 그대로 돌려준다.
    pub(crate) async fn settings_import_apply(&self, text: String, ids: Vec<String>, current_ui: Option<Value>) -> Res<Value> {
        let mut doc = parse(&text)?;
        let mut picked = vec![];
        for id in SECTIONS.into_iter().filter(|s| ids.iter().any(|i| i == s)) {
            let v = doc.sections.get(id).ok_or_else(|| gc_i18n::coded!("settings.io.noSection", "The file has no `{id}` section", id = id).json())?;
            let before = doc.skipped.len();
            let c = clean(id, v, &mut doc.skipped)?;
            if matches!(id, "gitGlobal" | "tools") && doc.skipped.len() > before {
                return Err(gc_i18n::coded!("settings.io.gitKeyRefused", "Refused: not an allowed git config key ({keys})", keys = doc.skipped[before..].join(", ")).json());
            }
            picked.push((id, c));
        }
        if let Some(bad) = ids.iter().find(|i| !SECTIONS.contains(&i.as_str())) {
            return Err(format!("unknown section `{bad}`"));
        }
        let backup = self.backup(current_ui).await?;
        let (mut applied, mut reconnect, mut ui_out) = (vec![], vec![], None);
        for (id, c) in picked {
            match id {
                "ui" => ui_out = Some(c),
                "ai" => {
                    let path = self.ai_path();
                    off(move || apply_ai(&path, &c)).await?;
                }
                "accounts" => {
                    let accts = self.hosting.accounts();
                    reconnect = off(move || apply_accounts(&accts, &c)).await?;
                }
                _ => {
                    for (k, v) in c.as_object().into_iter().flatten() {
                        self.backend.run(&std::env::temp_dir(), &["config", "--global", k, v.as_str().unwrap_or_default()], &[]).await.map_err(err)?;
                    }
                }
            }
            applied.push(id);
        }
        Ok(json!({"applied": applied, "backup": backup, "ui": ui_out, "reconnect": reconnect, "skipped": doc.skipped}))
    }

    async fn backup(&self, ui: Option<Value>) -> Res<String> {
        let text = self.export_doc(ui).await?;
        let dir = self.config_dir.join("backups");
        off(move || {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let (_, stamp) = utc_now();
            for n in 0..100 {
                let path = dir.join(if n == 0 { format!("settings-{stamp}.json") } else { format!("settings-{stamp}-{n}.json") });
                match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                    Ok(mut f) => {
                        std::io::Write::write_all(&mut f, text.as_bytes()).map_err(|e| e.to_string())?;
                        return Ok(path.to_string_lossy().into_owned());
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(e) => return Err(e.to_string()),
                }
            }
            Err("backup name collision".into())
        })
        .await
    }
}

fn apply_ai(path: &Path, c: &Value) -> Res<()> {
    let mut s = gc_ai::Settings::load(path).map_err(|e| e.ipc())?;
    let parse = |v: &Value| -> Res<gc_ai::Provider> { serde_json::from_value(v.clone()).map_err(|e| e.to_string()) };
    if let Some(p) = c.get("provider") {
        s.provider = parse(p)?;
    }
    if let Some(b) = c.get("conventions").and_then(Value::as_bool) {
        s.conventions = b;
    }
    for (name, one) in c.get("providers").and_then(Value::as_object).into_iter().flatten() {
        let cur = s.of_mut(parse(&json!(name))?);
        if let Some(m) = one.get("model").and_then(Value::as_str) {
            cur.model = m.into();
        }
        if let Some(m) = one.get("method") {
            cur.method = serde_json::from_value(m.clone()).map_err(|e| e.to_string())?;
        }
    }
    s.save(path).map_err(|e| e.ipc())
}

/// 없는 계정만 목록 파일 끝에 더한다 (토큰 없음). 새로 더한 계정 = 다시 연결해야 할 계정
fn apply_accounts(accts: &gc_hosting::Accounts<gc_hosting::Keychain>, c: &Value) -> Res<Vec<Account>> {
    let mut list = accts.list().map_err(|e| e.ipc())?;
    let mut added = vec![];
    for a in c.as_array().into_iter().flatten() {
        let a: Account = serde_json::from_value(a.clone()).map_err(|e| e.to_string())?;
        if !list.iter().any(|x| x.provider == a.provider && x.host == a.host) {
            list.push(a.clone());
            added.push(a);
        }
    }
    if !added.is_empty() {
        if let Some(dir) = accts.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&accts.path, serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    }
    Ok(added)
}

/// UTC 현재 시각: (`2026-10-21T01:02:03Z`, `20261021-010203`)
fn utc_now() -> (String, String) {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // 날짜 변환 (Howard Hinnant의 civil_from_days)
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    let (hh, mm, ss) = (rem / 3600, rem % 3600 / 60, rem % 60);
    (format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}Z"), format!("{y:04}{m:02}{d:02}-{hh:02}{mm:02}{ss:02}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NullEmit;
    use gc_core::GitRunner;
    use std::sync::Arc;

    /// 홈·전역 git 설정·설정 폴더를 모두 임시 폴더로 격리한 백엔드
    fn backend(d: &Path) -> Backend {
        let git = GitRunner::default().with_env("GIT_CONFIG_GLOBAL", d.join("gitconfig").to_string_lossy()).with_env("HOME", d.to_string_lossy()).with_env("GIT_CONFIG_NOSYSTEM", "1");
        Backend::with_parts(git, Default::default(), Arc::new(NullEmit), d.join("cfg"), None)
    }

    async fn git_set(b: &Backend, k: &str, v: &str) {
        b.git.output(&std::env::temp_dir(), &["config", "--global", k, v]).await.unwrap();
    }

    fn file(sections: Value) -> String {
        json!({"format": FORMAT, "version": 1, "sections": sections}).to_string()
    }

    #[tokio::test]
    async fn 왕복_내보내기_미리보기_적용() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let src = backend(a.path());
        src.ai.set_settings(Some(gc_ai::Provider::Google), Some("gemini-x".into()), Some(gc_ai::Method::Key), Some(true), true, Some(false)).await.unwrap();
        std::fs::write(a.path().join("cfg/accounts.json"), r#"[{"provider":"github","host":"github.com","username":"me"}]"#).unwrap();
        git_set(&src, "git403.jira.url", "https://j.example.com").await;
        git_set(&src, "git403.aiConventions", "false").await;
        git_set(&src, "git403.ghAccount", "me").await;
        git_set(&src, "core.sshCommand", "evil").await;
        git_set(&src, "diff.tool", "vscode").await;
        let out = src.settings_export(json!({"theme": "dark", "customCommands": "[]"})).await.unwrap();
        let text = out["json"].as_str().unwrap().to_string();
        // 비밀·동의·저장소별 키·허용 밖 키는 없다
        for no in ["consent", "ghAccount", "ghaccount", "sshCommand", "sshcommand", "token"] {
            assert!(!text.contains(no), "{no}");
        }
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!((v["format"].as_str(), v["version"].as_u64(), v["sections"]["gitGlobal"]["git403.jira.url"].as_str()), (Some(FORMAT), Some(1), Some("https://j.example.com")));

        let dst = backend(b.path());
        let p = dst.settings_import_preview(text.clone(), Some(json!({"theme": "light"}))).await.unwrap();
        let ids: Vec<_> = p.sections.iter().map(|s| s.id).collect();
        assert_eq!(ids, ["ui", "ai", "accounts", "gitGlobal", "tools"]);
        let theme = &p.sections[0].changes.iter().find(|c| c.key == "theme").unwrap();
        assert_eq!((theme.from.as_deref(), theme.to.as_str()), (Some("light"), "dark"));
        let r = dst.settings_import_apply(text.clone(), ids.iter().map(|s| s.to_string()).collect(), Some(json!({"theme": "light"}))).await.unwrap();
        assert_eq!(r["ui"]["theme"], "dark");
        assert_eq!(r["reconnect"][0]["username"], "me");
        let s = gc_ai::Settings::load(&b.path().join("cfg/ai.json")).unwrap();
        assert!(s.provider == gc_ai::Provider::Google && s.google.model == "gemini-x" && s.google.method == gc_ai::Method::Key && !s.conventions);
        assert!(!s.google.consent, "동의는 가져오지 않는다");
        assert!(std::fs::read_to_string(b.path().join("cfg/accounts.json")).unwrap().contains("\"me\""));
        let (g, t) = dst.git_globals().await.unwrap();
        assert_eq!((g["git403.jira.url"].as_str(), t["diff.tool"].as_str()), (Some("https://j.example.com"), Some("vscode")));
        // 적용 뒤 같은 파일의 미리보기는 변경 없음
        assert!(dst.settings_import_preview(text, Some(json!({"theme": "dark", "customCommands": "[]"}))).await.unwrap().sections.is_empty());
    }

    #[tokio::test]
    async fn 적용_전_백업이_만들어진다() {
        let d = tempfile::tempdir().unwrap();
        let b = backend(d.path());
        git_set(&b, "git403.jira.url", "https://old.example.com").await;
        let r = b.settings_import_apply(file(json!({"gitGlobal": {"git403.jira.url": "https://new.example.com"}})), vec!["gitGlobal".into()], Some(json!({"a": 1}))).await.unwrap();
        let saved = std::fs::read_to_string(r["backup"].as_str().unwrap()).unwrap();
        assert!(saved.contains("old.example.com") && saved.contains("\"a\": 1") && r["backup"].as_str().unwrap().contains("backups/settings-"));
        assert_eq!(b.git_globals().await.unwrap().0["git403.jira.url"], "https://new.example.com");
    }

    #[tokio::test]
    async fn 허용_목록_밖_git_키는_거부한다() {
        let d = tempfile::tempdir().unwrap();
        let b = backend(d.path());
        let f = file(json!({"gitGlobal": {"git403.jira.url": "https://j", "core.sshCommand": "evil", "git403.ghAccount": "x"}, "tools": {"diff.tool": "a b", "alias.x": "!rm"}}));
        let p = b.settings_import_preview(f.clone(), None).await.unwrap();
        assert!(["gitGlobal:core.sshCommand", "gitGlobal:git403.ghAccount", "tools:diff.tool", "tools:alias.x"].iter().all(|k| p.skipped.contains(&k.to_string())));
        assert!(!p.warnings.is_empty());
        assert!(b.settings_import_apply(f.clone(), vec!["gitGlobal".into()], None).await.is_err());
        assert!(b.settings_import_apply(f, vec!["tools".into()], None).await.is_err());
        assert!(b.git_globals().await.unwrap().0.is_empty(), "아무것도 쓰지 않았다");
    }

    #[tokio::test]
    async fn 새_버전_모르는_섹션_키는_건너뛰고_경고() {
        let d = tempfile::tempdir().unwrap();
        let b = backend(d.path());
        let f = json!({"format": FORMAT, "version": 9, "sections": {"future": {}, "ai": {"conventions": false, "newKey": 1, "providers": {"openai": {"model": "m", "color": "x"}, "foo": {}}}}}).to_string();
        let p = b.settings_import_preview(f, None).await.unwrap();
        assert_eq!(p.version, 9);
        assert!(p.warnings.len() == 1);
        for k in ["section:future", "ai:newKey", "ai:openai.color", "ai:foo"] {
            assert!(p.skipped.contains(&k.to_string()), "{k}");
        }
        assert_eq!(p.sections[0].changes.iter().map(|c| c.key.as_str()).collect::<Vec<_>>(), ["conventions", "openai.model"]);
    }

    #[tokio::test]
    async fn 손상_크기_형식_토큰은_거부한다() {
        let d = tempfile::tempdir().unwrap();
        let b = backend(d.path());
        for bad in ["{not json", "[]", r#"{"format":"other","version":1,"sections":{}}"#, r#"{"format":"git403-settings","sections":{}}"#, r#"{"format":"git403-settings","version":1}"#] {
            assert!(b.settings_import_preview(bad.into(), None).await.is_err(), "{bad}");
        }
        assert!(b.settings_import_preview(format!("{}{}", file(json!({})), " ".repeat(MAX_BYTES)), None).await.is_err());
        for tok in ["ghp_abcdefghijklmnopqrstuvwxyz0123", "sk-ant-abcdefghijklmnopqrstuvwxyz", "xai-abcdefghijklmnopqrstuvwxyz", "gho_abcdefghijklmnopqrstuvwxyz0123"] {
            let f = file(json!({"ui": {"memo": format!("my {tok} here")}}));
            assert!(b.settings_import_preview(f.clone(), None).await.is_err(), "{tok}");
            assert!(b.settings_import_apply(f, vec!["ui".into()], None).await.is_err());
        }
        assert!(b.settings_export(json!({"x": "ghp_abcdefghijklmnopqrstuvwxyz0123"})).await.is_err());
        // 비슷하지만 토큰이 아닌 값(task-list)은 통과
        assert!(b.settings_import_preview(file(json!({"ui": {"k": "task-list-item-with-long-name"}})), None).await.is_ok());
        assert!(!d.path().join("cfg/backups").exists(), "거부된 가져오기는 백업도 만들지 않는다");
    }

    #[tokio::test]
    async fn 이미_있는_계정은_그대로() {
        let d = tempfile::tempdir().unwrap();
        let b = backend(d.path());
        std::fs::create_dir_all(d.path().join("cfg")).unwrap();
        std::fs::write(d.path().join("cfg/accounts.json"), r#"[{"provider":"github","host":"github.com","username":"keep"}]"#).unwrap();
        let f = file(json!({"accounts": [{"provider":"github","host":"github.com","username":"other"}, {"provider":"gitlab","host":"gitlab.com","username":"g"}]}));
        let p = b.settings_import_preview(f.clone(), None).await.unwrap();
        assert_eq!(p.sections[0].changes.len(), 1);
        let r = b.settings_import_apply(f, vec!["accounts".into()], None).await.unwrap();
        assert_eq!(r["reconnect"].as_array().unwrap().len(), 1);
        let t = std::fs::read_to_string(d.path().join("cfg/accounts.json")).unwrap();
        assert!(t.contains("keep") && !t.contains("other") && t.contains("gitlab"));
    }
}
