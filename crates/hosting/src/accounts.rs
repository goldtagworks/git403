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

/// Android: `init_secret_dir`로 정한 앱 전용 폴더의 `FileSecrets`.
#[cfg(target_os = "android")]
static SECRET_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// 앱 시작 때 한 번(앱 전용 내부 저장소 폴더). Android 전용.
#[cfg(target_os = "android")]
pub fn init_secret_dir(dir: &std::path::Path) {
    let _ = SECRET_DIR.set(dir.to_path_buf());
}

#[cfg(target_os = "android")]
impl Keychain {
    fn file() -> Result<FileSecrets> {
        SECRET_DIR.get().map(|d| FileSecrets { path: d.join("secrets.json") }).ok_or_else(|| Error::Store("secret store is not initialized".into()))
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

/// 토큰을 JSON 파일 하나(`{키: 토큰}`)에 저장한다. 파일 권한 0600(소유자만), 쓸 때 임시 파일 → fsync → rename → 폴더 fsync.
/// OS 키체인이 없는 곳(Android: 앱 전용 내부 저장소라 다른 앱이 못 읽는다)용이며 한 프로세스 안에서는 잠금으로 직렬화한다.
pub struct FileSecrets {
    pub path: PathBuf,
}

static FILE_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

impl FileSecrets {
    fn load(&self) -> Result<std::collections::BTreeMap<String, String>> {
        match std::fs::read_to_string(&self.path) {
            Ok(t) => serde_json::from_str(&t).map_err(|e| Error::Store(e.to_string())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Default::default()),
            Err(e) => Err(Error::Store(e.to_string())),
        }
    }

    fn store(&self, map: &std::collections::BTreeMap<String, String>) -> Result<()> {
        use std::io::Write;
        let io = |e: std::io::Error| Error::Store(e.to_string());
        let dir = self.path.parent().ok_or_else(|| Error::Store("no parent directory".into()))?;
        std::fs::create_dir_all(dir).map_err(io)?;
        let tmp = self.path.with_extension("json.tmp");
        let _ = std::fs::remove_file(&tmp);
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
        let mut f = opts.open(&tmp).map_err(io)?;
        f.write_all(serde_json::to_string(map).map_err(|e| Error::Store(e.to_string()))?.as_bytes()).and_then(|()| f.sync_all()).map_err(io)?;
        std::fs::rename(&tmp, &self.path).map_err(io)?;
        #[cfg(unix)]
        if let Ok(d) = std::fs::File::open(dir) {
            let _ = d.sync_all();
        }
        Ok(())
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
        let fs = FileSecrets { path: dir.join("secrets.json") };
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
        assert!(!dir.join("secrets.json.tmp").exists());
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
