//! gix 백엔드 공통 도우미: 저장소 열기, 오류 변환, 경로·시각 도우미.

use std::path::Path;

use crate::Error;

/// gix 오류를 git이 낸 오류처럼 보이게 한다 (`Exit` = 코드 없는 원문). UI 사전에 새 코드를 만들지 않는다.
pub(crate) fn fail(e: impl std::fmt::Display) -> Error {
    Error::Exit { code: Some(128), stderr: format!("fatal: {e}") }
}

/// `git -C <repo>`처럼 위쪽 디렉터리를 찾아 연다.
pub(crate) fn open(repo: &Path) -> crate::Result<gix::Repository> {
    gix::discover(repo).map_err(fail)
}

pub(crate) fn hex(id: impl AsRef<gix::oid>) -> String {
    id.as_ref().to_hex().to_string()
}

/// 커밋 메시지에서 git의 `%s`(제목)와 `%b`(본문). 제목은 첫 문단의 줄을 공백 하나로 잇고(줄 끝 공백 제거),
/// 본문은 그 뒤 빈 줄들을 건너뛴 나머지다.
pub(crate) fn subject_body(msg: &[u8]) -> (String, String) {
    let text = String::from_utf8_lossy(msg);
    let mut lines = text.split('\n').peekable();
    while lines.peek().is_some_and(|l| l.trim().is_empty()) {
        lines.next();
    }
    let mut subject = String::new();
    for l in lines.by_ref() {
        let l = l.trim_end();
        if l.is_empty() {
            break;
        }
        if !subject.is_empty() {
            subject.push(' ');
        }
        subject.push_str(l);
    }
    while lines.peek().is_some_and(|l| l.trim().is_empty()) {
        lines.next();
    }
    (subject, lines.collect::<Vec<_>>().join("\n"))
}

/// `core.quotepath=false` 기준의 git 경로 인용: `"`·`\`·제어 문자가 있을 때만 C 방식으로 감싼다.
pub(crate) fn quote_path(p: &[u8]) -> String {
    let plain = !p.iter().any(|&b| b < 0x20 || b == b'"' || b == b'\\' || b == 0x7f);
    if plain {
        return String::from_utf8_lossy(p).into_owned();
    }
    let mut out: Vec<u8> = vec![b'"'];
    for &b in p {
        match b {
            b'"' => out.extend(b"\\\""),
            b'\\' => out.extend(b"\\\\"),
            b'\x07' => out.extend(b"\\a"),
            b'\x08' => out.extend(b"\\b"),
            b'\t' => out.extend(b"\\t"),
            b'\n' => out.extend(b"\\n"),
            0x0b => out.extend(b"\\v"),
            0x0c => out.extend(b"\\f"),
            b'\r' => out.extend(b"\\r"),
            b if b < 0x20 || b == 0x7f => out.extend(format!("\\{b:03o}").bytes()),
            b => out.push(b),
        }
    }
    out.push(b'"');
    String::from_utf8_lossy(&out).into_owned()
}

/// git 경로 스펙(접두 디렉터리 포함) 비교: 같거나 `spec/` 아래.
pub(crate) fn under(path: &[u8], spec: &str) -> bool {
    let spec = spec.strip_prefix("./").unwrap_or(spec);
    let spec = if spec == "." { "" } else { spec.trim_end_matches('/') }.as_bytes();
    spec.is_empty() || path == spec || (path.starts_with(spec) && path.get(spec.len()) == Some(&b'/'))
}

/// 글롭 `*`(`/` 포함 전부)·`?`만 지원하는 wildmatch(플래그 0) 근사. git `--exclude`·`--glob`의 refs 이름 비교용.
pub(crate) fn glob(pat: &[u8], s: &[u8]) -> bool {
    match pat.split_first() {
        None => s.is_empty(),
        Some((b'*', rest)) => (0..=s.len()).any(|i| glob(rest, &s[i..])),
        Some((b'?', rest)) => !s.is_empty() && glob(rest, &s[1..]),
        Some((c, rest)) => s.first() == Some(c) && glob(rest, &s[1..]),
    }
}

/// 저장소 설정 파일(`config`)의 잠금. **잠금을 먼저 잡고** 읽는다(`config.lock`을 `create_new`로 만들며, 있으면 128 오류). 고친 내용은 `stage`로 잠금 파일에 미리 써 두고
/// (여기서 쓰기·sync가 실패하면 아무것도 안 바뀐 채 끝난다) ref를 바꾼 **뒤에** `commit`(rename)한다. 어떤 경로로든 `commit` 전에 버려지면 잠금 파일을 지운다.
pub(crate) struct ConfigLock {
    path: std::path::PathBuf,
    lock: std::path::PathBuf,
    cfg: gix::config::File,
    staged: bool,
    done: bool,
}

impl ConfigLock {
    pub(crate) fn acquire(repo: &gix::Repository) -> crate::Result<Self> {
        Self::acquire_path(repo.common_dir().join("config"), gix::config::Source::Local, false)
    }

    /// 임의 설정 파일(전역 설정 등)의 잠금. 파일이 없으면 빈 설정으로 시작하고 `create_dirs`면 폴더를 만든다.
    pub(crate) fn acquire_path(path: std::path::PathBuf, source: gix::config::Source, create_dirs: bool) -> crate::Result<Self> {
        if let (true, Some(dir)) = (create_dirs, path.parent()) {
            std::fs::create_dir_all(dir).map_err(fail)?;
        }
        // 설정 파일이 심볼릭 링크면 git처럼 링크를 따라가 실제 파일에 잠금·rename한다(링크는 그대로)
        let path = if path.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()) { std::fs::canonicalize(&path).map_err(fail)? } else { path };
        let mut name = path.file_name().unwrap_or_default().to_os_string();
        name.push(".lock");
        let lock = path.with_file_name(name);
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock)
            .map_err(|e| crate::Error::Exit { code: Some(255), stderr: format!("error: could not lock config file {}: {e}", path.display()) })?;
        // 원래 파일의 권한(예: 0600)을 잠금 파일에 옮긴다(git과 같음)
        if let Ok(m) = std::fs::metadata(&path) {
            let _ = std::fs::set_permissions(&lock, m.permissions());
        }
        // 잠근 뒤 읽는다. 실패하면 Drop이 잠금을 지운다.
        let mut me = Self { path, lock, cfg: gix::config::File::default(), staged: false, done: false };
        me.cfg = if me.path.exists() { gix::config::File::from_path_no_includes(me.path.clone(), source).map_err(fail)? } else { gix::config::File::new(gix::config::file::Metadata::from(source)) };
        Ok(me)
    }

    /// 설정 내용을 텍스트로 바꿔 다시 읽는다(gix가 항목을 지우고 남기는 들여쓰기만 있는 줄을 치울 때).
    pub(crate) fn replace_text(&mut self, text: &[u8]) -> crate::Result<()> {
        let meta = self.cfg.meta().clone();
        self.cfg = gix::config::File::from_bytes_no_includes(text, meta, Default::default()).map_err(fail)?;
        self.staged = false;
        Ok(())
    }

    pub(crate) fn cfg(&mut self) -> &mut gix::config::File {
        self.staged = false;
        &mut self.cfg
    }

    /// 고친 내용을 잠금 파일에 쓰고 sync한다(아직 반영 안 됨).
    pub(crate) fn stage(&mut self) -> crate::Result<()> {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().write(true).truncate(true).open(&self.lock).map_err(fail)?;
        f.write_all(&self.cfg.to_bstring()).and_then(|()| f.sync_all()).map_err(fail)?;
        self.staged = true;
        Ok(())
    }

    /// 잠금 파일을 `config`로 rename한다(안 썼으면 먼저 쓴다).
    pub(crate) fn commit(mut self) -> crate::Result<()> {
        if !self.staged {
            self.stage()?;
        }
        std::fs::rename(&self.lock, &self.path).map_err(fail)?;
        if let Some(d) = self.path.parent() {
            super::durable::dir(d);
        }
        self.done = true;
        Ok(())
    }
}

impl Drop for ConfigLock {
    fn drop(&mut self) {
        if !self.done {
            let _ = std::fs::remove_file(&self.lock);
        }
    }
}

/// reflog에 쓸 committer. 없으면 git은 기본 신원으로 쓰지만 여기선 못 하므로 거절한다.
pub(crate) fn committer(r: &gix::Repository) -> crate::Result<gix::actor::Signature> {
    match r.committer() {
        Some(c) => c.map_err(fail)?.to_owned().map_err(fail),
        None => Err(crate::Error::Unsupported("reflog(no committer identity)".into())),
    }
}

/// git 경로(바이트) → 파일 시스템 경로.
pub(crate) fn fs_path(p: &gix::bstr::BStr) -> crate::Result<std::path::PathBuf> {
    gix::path::from_bstr(p).map(|c| c.into_owned()).map_err(fail)
}

/// HEAD의 reflog에 한 줄 붙인다. gix는 심볼릭 ref 변경의 reflog를 안 쓰는데 git은 쓰므로(`checkout: moving from a to b`, 앞뒤 id가 같아도) 직접 쓴다.
/// gix가 이미 쓴 변경(id가 있는 대상)에는 호출하지 않는다(중복 방지는 호출자 몫). `logs/HEAD.lock`을 잡고 기존 내용 + 한 줄을 rename으로 바꿔 놓는다.
/// `core.logAllRefUpdates`가 `false`류면 이미 있는 로그에만 붙이고, 그 밖(기본 true·always)이면 만든다. 비-베어 저장소 전용.
pub(crate) fn append_head_log(r: &gix::Repository, old: gix::ObjectId, new: gix::ObjectId, who: &gix::actor::Signature, msg: &str) -> crate::Result<()> {
    use std::io::Write;
    let path = r.common_dir().join("logs").join("HEAD");
    let mode = r.config_snapshot().string("core.logAllRefUpdates").map(|v| v.to_string().to_ascii_lowercase());
    if matches!(mode.as_deref(), Some("false" | "no" | "off" | "0" | "never")) && !path.is_file() {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(fail)?;
    }
    let mut line = format!("{old} {new} ").into_bytes();
    who.write_to(&mut line).map_err(fail)?;
    line.extend_from_slice(format!("\t{msg}\n").as_bytes());
    let mut lock = gix::lock::File::acquire_to_update_resource(&path, gix::lock::acquire::Fail::Immediately, None, 0).map_err(fail)?;
    let mut all = std::fs::read(&path).unwrap_or_default();
    all.extend_from_slice(&line);
    lock.write_all(&all).map_err(fail)?;
    super::durable::lock_file(&mut lock)?;
    lock.commit().map_err(|e| fail(e.error))?;
    super::durable::dir(path.parent().unwrap_or(&path));
    Ok(())
}
