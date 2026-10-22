//! `~/.ssh` 공개키 목록(`ssh-keygen -lf`)과 새 ed25519 키 생성(순수 Rust `ssh-key`: 암호가 명령줄·환경에 노출되지 않는다).
//! 기존 비공개키 내용은 읽지 않는다.

use std::path::Path;

use serde::Serialize;
use ssh_key::{rand_core::OsRng, Algorithm, HashAlg, LineEnding, PrivateKey};
use tokio::process::Command;

use crate::{Error, Result};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKey {
    /// 공개키 파일 이름 (`id_ed25519.pub`)
    pub name: String,
    /// `ED25519`, `RSA` …
    pub kind: String,
    pub bits: u32,
    /// `SHA256:…`
    pub fingerprint: String,
    pub comment: String,
    /// 공개키 한 줄 (복사용)
    pub public: String,
    /// 같은 이름의 비공개키 파일이 있는지 (존재 여부만)
    pub has_private: bool,
}

/// `ssh-keygen -lf` 한 줄 `256 SHA256:abc user@host (ED25519)` → (bits, 지문, 코멘트, 유형)
pub fn parse_fingerprint(line: &str) -> Option<(u32, String, String, String)> {
    let line = line.trim();
    let (rest, kind) = line.rsplit_once(" (")?;
    let kind = kind.strip_suffix(')')?;
    let mut it = rest.splitn(3, ' ');
    let bits = it.next()?.parse().ok()?;
    let fp = it.next()?;
    if !fp.contains(':') {
        return None;
    }
    Some((bits, fp.to_string(), it.next().unwrap_or("").to_string(), kind.to_string()))
}

/// 새 키 파일 이름 검사: 영숫자·`.`·`_`·`-`, 맨 앞은 `-`·`.` 금지, 경로 구분자 금지
pub fn valid_key_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with(['-', '.'])
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && !name.ends_with(".pub")
}

async fn keygen(args: &[String]) -> Result<String> {
    let out = Command::new("ssh-keygen").args(args).stdin(std::process::Stdio::null()).output().await?;
    if !out.status.success() {
        return Err(Error::Exit { code: out.status.code(), stderr: String::from_utf8_lossy(&out.stderr).trim().to_string() });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

async fn describe(dir: &Path, pub_name: &str) -> Result<SshKey> {
    let file = dir.join(pub_name);
    let public = std::fs::read_to_string(&file)?.lines().next().unwrap_or("").trim().to_string();
    let (bits, fingerprint, comment, kind) = parse_fingerprint(&keygen(&["-lf".into(), file.to_string_lossy().into_owned()]).await?)
        .ok_or_else(|| Error::from(gc_i18n::coded!("ssh.pubKeyUnreadable", "cannot read public key: {name}", name = pub_name)))?;
    let has_private = dir.join(pub_name.trim_end_matches(".pub")).exists();
    Ok(SshKey { name: pub_name.to_string(), kind, bits, fingerprint, comment, public, has_private })
}

/// `dir`의 `*.pub` 목록 (이름순). 폴더가 없으면 빈 목록, 읽을 수 없는 파일은 건너뛴다.
pub async fn list_keys(dir: &Path) -> Result<Vec<SshKey>> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Ok(vec![]) };
    let mut names = vec![];
    for e in rd.flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if n.ends_with(".pub") && e.file_type().map(|t| t.is_file()).unwrap_or(false) {
            names.push(n);
        }
    }
    names.sort();
    let mut keys = vec![];
    for n in names {
        if let Ok(k) = describe(dir, &n).await {
            keys.push(k);
        }
    }
    Ok(keys)
}

fn create_new(path: &Path, text: &str, _mode: u32) -> Result<()> {
    use std::io::Write;
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, _mode);
    let mut f = o.open(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => Error::from(gc_i18n::coded!("ssh.exists", "{path} already exists. Use a different name.", path = path.display())),
        _ => e.into(),
    })?;
    Ok(f.write_all(text.as_bytes())?)
}

fn ssh_err(e: ssh_key::Error) -> Error {
    gc_i18n::coded!("ssh.keygenFailed", "key generation failed: {error}", error = e).into()
}

/// 새 ed25519 키를 OpenSSH 형식으로 저장 (비공개 0600, 공개 0644). `create_new`라 이미 있는 파일은
/// 어느 쪽이든 덮어쓰지 않고 거부한다. 암호가 비어 있지 않으면 비공개키를 암호화한다.
pub async fn generate_key(dir: &Path, name: &str, passphrase: &str, comment: &str) -> Result<SshKey> {
    if !valid_key_name(name) {
        return Err(gc_i18n::coded!("ssh.badName", "File names may only contain letters, digits, . _ -").into());
    }
    let (dir, name, pass, comment) = (dir.to_owned(), name.to_owned(), passphrase.to_owned(), comment.to_owned());
    tokio::task::spawn_blocking(move || -> Result<SshKey> {
        std::fs::create_dir_all(&dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        }
        let mut key = PrivateKey::random(&mut OsRng, Algorithm::Ed25519).map_err(ssh_err)?;
        key.set_comment(&comment);
        let public = key.public_key().to_openssh().map_err(ssh_err)?;
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        let secret = if pass.is_empty() { key } else { key.encrypt(&mut OsRng, pass.as_bytes()).map_err(ssh_err)? };
        let secret = secret.to_openssh(LineEnding::LF).map_err(ssh_err)?;
        let (priv_path, pub_path) = (dir.join(&name), dir.join(format!("{name}.pub")));
        create_new(&priv_path, &secret, 0o600)?;
        if let Err(e) = create_new(&pub_path, &format!("{public}\n"), 0o644) {
            let _ = std::fs::remove_file(&priv_path); // 방금 만든 비공개키만 정리
            return Err(e);
        }
        Ok(SshKey { name: format!("{name}.pub"), kind: "ED25519".into(), bits: 256, fingerprint, comment, public, has_private: true })
    })
    .await
    .map_err(|e| Error::Parse(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn parses_fingerprint_line() {
        let (b, f, c, k) = parse_fingerprint("256 SHA256:AbC+/12= me@x.dev (ED25519)\n").unwrap();
        assert_eq!((b, f.as_str(), c.as_str(), k.as_str()), (256, "SHA256:AbC+/12=", "me@x.dev", "ED25519"));
        // 코멘트에 공백·괄호가 있어도, 코멘트가 없어도
        let (_, _, c, k) = parse_fingerprint("3072 SHA256:zz my laptop (work) (RSA)").unwrap();
        assert_eq!((c.as_str(), k.as_str()), ("my laptop (work)", "RSA"));
        let (_, _, c, _) = parse_fingerprint("256 SHA256:zz  (ED25519)").unwrap_or((0, String::new(), "?".into(), String::new()));
        assert!(c == "" || c == "?");
        assert!(parse_fingerprint("not a key").is_none());
        assert!(parse_fingerprint("abc SHA256:zz c (RSA)").is_none());
    }

    #[test]
    fn key_name_rules() {
        for ok in ["id_ed25519", "work-key", "a.b"] {
            assert!(valid_key_name(ok), "{ok}");
        }
        for bad in ["", "-x", ".x", "a/b", "a\\b", "..", "x.pub", "a b", "한글"] {
            assert!(!valid_key_name(bad), "{bad}");
        }
    }

    fn tmpdir(n: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gc-ssh-{n}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[tokio::test]
    async fn generate_list_and_refuse_overwrite() {
        let dir = tmpdir("a");
        let k = generate_key(&dir, "id_test", "", "me@x.dev").await.unwrap();
        assert_eq!((k.kind.as_str(), k.bits, k.comment.as_str(), k.has_private), ("ED25519", 256, "me@x.dev", true));
        assert!(k.fingerprint.starts_with("SHA256:") && k.public.starts_with("ssh-ed25519 ") && k.public.ends_with("me@x.dev"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |n: &str| std::fs::metadata(dir.join(n)).unwrap().permissions().mode() & 0o777;
            assert_eq!((mode("id_test"), mode("id_test.pub")), (0o600, 0o644));
        }
        let before = std::fs::read(dir.join("id_test")).unwrap();
        assert!(std::str::from_utf8(&before).unwrap().starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"));
        assert!(generate_key(&dir, "id_test", "", "x").await.is_err());
        assert_eq!(std::fs::read(dir.join("id_test")).unwrap(), before); // 그대로
        // 비공개키만 있어도 거부하고, 있던 비공개키는 지우지 않는다
        std::fs::remove_file(dir.join("id_test.pub")).unwrap();
        assert!(generate_key(&dir, "id_test", "", "x").await.is_err());
        assert_eq!(std::fs::read(dir.join("id_test")).unwrap(), before);
        assert!(!dir.join("id_test.pub").exists());
        // 목록: ssh-keygen이 있으면 지문이 생성 때와 같다
        if std::process::Command::new("ssh-keygen").arg("-h").output().is_ok() {
            let k2 = generate_key(&dir, "second", "", "c").await.unwrap();
            let l = list_keys(&dir).await.unwrap();
            assert_eq!(l.len(), 1);
            assert_eq!((l[0].fingerprint.as_str(), l[0].comment.as_str()), (k2.fingerprint.as_str(), "c"));
            std::fs::write(dir.join("junk.pub"), "garbage").unwrap();
            assert_eq!(list_keys(&dir).await.unwrap().len(), 1); // 읽을 수 없는 파일은 건너뜀
        }
        assert!(list_keys(&dir.join("none")).await.unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn passphrase_encrypts_private_key() {
        let dir = tmpdir("b");
        generate_key(&dir, "enc", "s3cret pass", "c").await.unwrap();
        let text = std::fs::read_to_string(dir.join("enc")).unwrap();
        let key = PrivateKey::from_openssh(&text).unwrap();
        assert!(key.is_encrypted());
        assert!(key.decrypt(b"wrong").is_err());
        assert!(key.decrypt(b"s3cret pass").is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
