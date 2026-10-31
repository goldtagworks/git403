use crate::{api, Account, Error, Provider, Result};
use std::path::PathBuf;

/// 토큰 저장소. 운영은 OS 키체인(`Keychain`), 테스트는 메모리 구현.
pub trait SecretStore: Send + Sync {
    fn set(&self, key: &str, secret: &str) -> Result<()>;
    fn get(&self, key: &str) -> Result<Option<String>>;
    fn delete(&self, key: &str) -> Result<()>;
}

/// 서비스 "git403", 사용자 `<provider>:<host>:<username>`. Android에는 keyring 백엔드가 없어(메모리 mock) 앱 전용 폴더의 `FileSecrets`를 쓴다.
pub struct Keychain;

#[cfg(not(target_os = "android"))]
impl Keychain {
    fn entry(key: &str) -> Result<keyring::Entry> {
        keyring::Entry::new("git403", key).map_err(|e| Error::Store(e.to_string()))
    }
}

#[cfg(not(target_os = "android"))]
impl SecretStore for Keychain {
    fn set(&self, key: &str, secret: &str) -> Result<()> {
        Self::entry(key)?.set_password(secret).map_err(|e| Error::Store(e.to_string()))
    }
    fn get(&self, key: &str) -> Result<Option<String>> {
        match Self::entry(key)?.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(Error::Store(e.to_string())),
        }
    }
    fn delete(&self, key: &str) -> Result<()> {
        match Self::entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(Error::Store(e.to_string())),
        }
    }
}

/// 파일 저장소를 감싸는 암호화(Android Keystore 등). `seal`한 바이트만 디스크에 쓴다.
pub trait SecretCipher: Send + Sync {
    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>>;
    fn open(&self, sealed: &[u8]) -> Result<Vec<u8>>;
}

/// Android: `init_secret_dir`로 정한 앱 전용 폴더 + `set_secret_cipher`로 등록한 Keystore 암호화. 암호화가 없으면 평문으로 쓰지 않고 오류를 낸다.
#[cfg(target_os = "android")]
static SECRET_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
#[cfg(target_os = "android")]
static SECRET_CIPHER: std::sync::OnceLock<std::sync::Arc<dyn SecretCipher>> = std::sync::OnceLock::new();

/// 앱 시작 때 한 번(앱 전용 내부 저장소 폴더). Android 전용.
#[cfg(target_os = "android")]
pub fn init_secret_dir(dir: &std::path::Path) {
    let _ = SECRET_DIR.set(dir.to_path_buf());
}

/// Keystore 암호화를 등록한다(앱 시작 때 한 번). Android 전용.
#[cfg(target_os = "android")]
pub fn set_secret_cipher(cipher: std::sync::Arc<dyn SecretCipher>) {
    let _ = SECRET_CIPHER.set(cipher);
}

#[cfg(target_os = "android")]
impl Keychain {
    fn file() -> Result<FileSecrets> {
        let dir = SECRET_DIR.get().ok_or_else(|| Error::Store("secret store is not initialized".into()))?;
        let cipher = SECRET_CIPHER.get().ok_or_else(|| Error::Store("secure storage (Keystore) is not initialized".into()))?;
        Ok(FileSecrets { path: dir.join("secrets.json"), cipher: Some(cipher.clone()) })
    }
}

#[cfg(target_os = "android")]
impl SecretStore for Keychain {
    fn set(&self, key: &str, secret: &str) -> Result<()> {
        Self::file()?.set(key, secret)
    }
    fn get(&self, key: &str) -> Result<Option<String>> {
        Self::file()?.get(key)
    }
    fn delete(&self, key: &str) -> Result<()> {
        Self::file()?.delete(key)
    }
}

/// 토큰을 파일 하나(`{키: 토큰}` JSON)에 저장한다. 파일 권한 0600(소유자만), 쓸 때 임시 파일 → fsync → rename → 폴더 fsync.
/// `cipher`가 있으면 `path`의 확장자를 `enc`로 바꾼 파일에 **봉인한 바이트만** 쓴다. 이때 평문 `path`(옛 형식)가 있으면 읽어 봉인해 옮기고 지운다(이동 도중 어느 시점에 꺼져도 평문이나 봉인본이 남는다).
/// `cipher`가 없으면 평문(OS 키체인이 없고 암호화도 못 쓰는 곳·시험용). 한 프로세스 안에서는 잠금으로 직렬화한다.
pub struct FileSecrets {
    pub path: PathBuf,
    pub cipher: Option<std::sync::Arc<dyn SecretCipher>>,
}

static FILE_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

impl FileSecrets {
    fn enc_path(&self) -> PathBuf {
        self.path.with_extension("enc")
    }

    fn load(&self) -> Result<std::collections::BTreeMap<String, String>> {
        let read = |p: &std::path::Path| match std::fs::read(p) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(Error::Store(e.to_string())),
        };
        let parse = |b: &[u8]| serde_json::from_slice(b).map_err(|e| Error::Store(e.to_string()));
        match &self.cipher {
            None => Ok(read(&self.path)?.map(|b| parse(&b)).transpose()?.unwrap_or_default()),
            Some(c) => {
                if let Some(sealed) = read(&self.enc_path())? {
                    return parse(&c.open(&sealed)?);
                }
                // 옛 평문 파일: 봉인해서 옮기고 지운다
                match read(&self.path)? {
                    Some(plain) => {
                        let map = parse(&plain)?;
                        self.store(&map)?;
                        Ok(map)
                    }
                    None => Ok(Default::default()),
                }
            }
        }
    }

    fn write_file(&self, target: &std::path::Path, bytes: &[u8]) -> Result<()> {
        use std::io::Write;
        let io = |e: std::io::Error| Error::Store(e.to_string());
        let dir = target.parent().ok_or_else(|| Error::Store("no parent directory".into()))?;
        std::fs::create_dir_all(dir).map_err(io)?;
        let tmp = target.with_extension("tmp");
        let _ = std::fs::remove_file(&tmp);
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
        let mut f = opts.open(&tmp).map_err(io)?;
        f.write_all(bytes).and_then(|()| f.sync_all()).map_err(io)?;
        std::fs::rename(&tmp, target).map_err(io)?;
        #[cfg(unix)]
        if let Ok(d) = std::fs::File::open(dir) {
            let _ = d.sync_all();
        }
        Ok(())
    }

    fn store(&self, map: &std::collections::BTreeMap<String, String>) -> Result<()> {
        let json = serde_json::to_vec(map).map_err(|e| Error::Store(e.to_string()))?;
        match &self.cipher {
            None => self.write_file(&self.path, &json),
            Some(c) => {
                self.write_file(&self.enc_path(), &c.seal(&json)?)?;
                // 봉인본이 디스크에 내려간 뒤에만 평문을 지운다
                match std::fs::remove_file(&self.path) {
                    Ok(()) => {
                        #[cfg(unix)]
                        if let Some(Ok(d)) = self.path.parent().map(std::fs::File::open) {
                            let _ = d.sync_all();
                        }
                        Ok(())
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                    Err(e) => Err(Error::Store(e.to_string())),
                }
            }
        }
    }
}

impl SecretStore for FileSecrets {
    fn set(&self, key: &str, secret: &str) -> Result<()> {
        let _g = FILE_LOCK.lock();
        let mut m = self.load()?;
        m.insert(key.to_owned(), secret.to_owned());
        self.store(&m)
    }
    fn get(&self, key: &str) -> Result<Option<String>> {
        let _g = FILE_LOCK.lock();
        Ok(self.load()?.get(key).cloned())
    }
    fn delete(&self, key: &str) -> Result<()> {
        let _g = FILE_LOCK.lock();
        let mut m = self.load()?;
        if m.remove(key).is_some() {
            self.store(&m)?;
        }
        Ok(())
    }
}

/// 계정 목록(JSON 파일, 비밀 아님) + 토큰 저장소
pub struct Accounts<S: SecretStore> {
    pub path: PathBuf,
    pub store: S,
}

impl<S: SecretStore> Accounts<S> {
    pub fn list(&self) -> Result<Vec<Account>> {
        match std::fs::read_to_string(&self.path) {
            Ok(t) => serde_json::from_str(&t).map_err(|e| Error::File(e.to_string())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
            Err(e) => Err(Error::File(e.to_string())),
        }
    }

    fn save(&self, list: &[Account]) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| Error::File(e.to_string()))?;
        }
        let text = serde_json::to_string_pretty(list).map_err(|e| Error::File(e.to_string()))?;
        std::fs::write(&self.path, text).map_err(|e| Error::File(e.to_string()))
    }

    /// 토큰을 확인(verify)한 뒤 저장. `host`가 비면 provider 기본 호스트. 같은 계정은 토큰만 갱신.
    pub async fn add(&self, provider: Provider, host: &str, token: &str) -> Result<Account> {
        let host = host.trim();
        let host = if host.is_empty() { provider.default_host().unwrap_or_default() } else { host };
        let mut acct = Account { provider, host: host.trim_end_matches('/').to_lowercase(), username: String::new() };
        acct.username = api::verify(&acct, token).await?;
        self.store.set(&acct.key(), token)?;
        // 같은 서비스·호스트의 기존 항목은 교체한다(다른 사용자명이면 이전 키체인 토큰도 삭제)
        let mut list = self.list()?;
        for old in list.iter().filter(|a| a.provider == acct.provider && a.host == acct.host && **a != acct) {
            self.store.delete(&old.key())?;
        }
        list.retain(|a| !(a.provider == acct.provider && a.host == acct.host));
        list.push(acct.clone());
        self.save(&list)?;
        Ok(acct)
    }

    pub fn remove(&self, acct: &Account) -> Result<()> {
        self.store.delete(&acct.key())?;
        let mut list = self.list()?;
        list.retain(|a| a != acct);
        self.save(&list)
    }

    pub fn token(&self, acct: &Account) -> Result<Option<String>> {
        self.store.get(&acct.key())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::tests::mock;
    use std::collections::HashMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Mem(Mutex<HashMap<String, String>>);
    impl SecretStore for Mem {
        fn set(&self, k: &str, s: &str) -> Result<()> {
            self.0.lock().unwrap().insert(k.into(), s.into());
            Ok(())
        }
        fn get(&self, k: &str) -> Result<Option<String>> {
            Ok(self.0.lock().unwrap().get(k).cloned())
        }
        fn delete(&self, k: &str) -> Result<()> {
            self.0.lock().unwrap().remove(k);
            Ok(())
        }
    }

    #[test]
    fn file_secrets는_0600으로_저장하고_지운다() {
        let dir = std::env::temp_dir().join(format!("gc-hosting-fs-{}", std::process::id()));
        let fs = FileSecrets { path: dir.join("secrets.json"), cipher: None };
        assert_eq!(fs.get("a").unwrap(), None);
        fs.set("a", "t1").unwrap();
        fs.set("b", "t2").unwrap();
        fs.set("a", "t3").unwrap();
        assert_eq!(fs.get("a").unwrap().as_deref(), Some("t3"));
        #[cfg(unix)]
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&fs.path).unwrap().permissions()) & 0o777, 0o600);
        fs.delete("a").unwrap();
        fs.delete("nope").unwrap();
        assert_eq!(fs.get("a").unwrap(), None);
        assert_eq!(fs.get("b").unwrap().as_deref(), Some("t2"));
        assert!(!dir.join("secrets.tmp").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// 시험용 암호화: 바이트를 뒤집고 앞에 표식을 붙인다(평문이 그대로 보이지 않음을 확인할 정도).
    struct Toy;
    impl SecretCipher for Toy {
        fn seal(&self, p: &[u8]) -> Result<Vec<u8>> {
            Ok(b"SEAL".iter().copied().chain(p.iter().rev().copied()).collect())
        }
        fn open(&self, s: &[u8]) -> Result<Vec<u8>> {
            s.strip_prefix(b"SEAL").map(|r| r.iter().rev().copied().collect()).ok_or_else(|| Error::Store("bad seal".into()))
        }
    }

    #[test]
    fn 암호화가_있으면_평문을_쓰지_않고_옛_평문_파일을_옮기고_지운다() {
        let dir = std::env::temp_dir().join(format!("gc-hosting-enc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 옛 평문 파일
        std::fs::write(dir.join("secrets.json"), r#"{"old":"plain-token"}"#).unwrap();
        let fs = FileSecrets { path: dir.join("secrets.json"), cipher: Some(std::sync::Arc::new(Toy)) };
        assert_eq!(fs.get("old").unwrap().as_deref(), Some("plain-token"), "옛 평문을 읽는다");
        assert!(!dir.join("secrets.json").exists(), "읽으면서 평문이 지워진다");
        fs.set("new", "tok2").unwrap();
        let sealed = std::fs::read(dir.join("secrets.enc")).unwrap();
        assert!(sealed.starts_with(b"SEAL"));
        assert!(!String::from_utf8_lossy(&sealed).contains("plain-token") && !String::from_utf8_lossy(&sealed).contains("tok2"));
        #[cfg(unix)]
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(dir.join("secrets.enc")).unwrap().permissions()) & 0o777, 0o600);
        assert_eq!(fs.get("old").unwrap().as_deref(), Some("plain-token"));
        assert_eq!(fs.get("new").unwrap().as_deref(), Some("tok2"));
        fs.delete("old").unwrap();
        assert_eq!(fs.get("old").unwrap(), None);
        // 깨진 봉인본은 오류(평문으로 되돌아가지 않음)
        std::fs::write(dir.join("secrets.enc"), b"garbage").unwrap();
        assert!(fs.get("new").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn add_verifies_stores_token_apart_and_removes() {
        let dir = std::env::temp_dir().join(format!("gc-hosting-{}", std::process::id()));
        let accts = Accounts { path: dir.join("accounts.json"), store: Mem::default() };
        assert!(accts.list().unwrap().is_empty());

        let (host, _h) = mock(200, r#"{"username":"kim"}"#).await;
        let a = accts.add(Provider::Gitea, &host, "secret-token").await.unwrap();
        assert_eq!(a.username, "kim");
        assert_eq!(accts.token(&a).unwrap().as_deref(), Some("secret-token"));
        let file = std::fs::read_to_string(&accts.path).unwrap();
        assert!(!file.contains("secret-token"), "토큰이 파일에 남음");
        assert_eq!(accts.list().unwrap(), vec![a.clone()]);

        accts.remove(&a).unwrap();
        assert!(accts.list().unwrap().is_empty());
        assert_eq!(accts.token(&a).unwrap(), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn same_host_replaces_previous_account_and_token() {
        let dir = std::env::temp_dir().join(format!("gc-hosting-rep-{}", std::process::id()));
        let accts = Accounts { path: dir.join("accounts.json"), store: Mem::default() };
        // 같은 주소에서 두 번 응답하는 서버 (첫 응답 kim, 둘째 lee)
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = format!("http://{}", l.local_addr().unwrap());
        tokio::spawn(async move {
            for name in ["kim", "lee"] {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let (mut s, _) = l.accept().await.unwrap();
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf).await;
                let body = format!(r#"{{"username":"{name}"}}"#);
                let res = format!("HTTP/1.1 200 X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                s.write_all(res.as_bytes()).await.unwrap();
            }
        });
        let a = accts.add(Provider::Gitea, &host, "t1").await.unwrap();
        let b = accts.add(Provider::Gitea, &host, "t2").await.unwrap();
        assert_eq!(a.host, b.host);
        assert_eq!(accts.list().unwrap(), vec![b.clone()]);
        assert_eq!(accts.token(&a).unwrap(), None, "이전 토큰이 키체인에 남음");
        assert_eq!(accts.token(&b).unwrap().as_deref(), Some("t2"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn bad_token_is_not_saved() {
        let dir = std::env::temp_dir().join(format!("gc-hosting-bad-{}", std::process::id()));
        let accts = Accounts { path: dir.join("accounts.json"), store: Mem::default() };
        let (host, _h) = mock(401, "{}").await;
        assert!(matches!(accts.add(Provider::Gitea, &host, "x").await, Err(Error::Unauthorized)));
        assert!(accts.list().unwrap().is_empty());
    }
}
