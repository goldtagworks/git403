use crate::{api, Account, Error, Provider, Result};
use std::path::PathBuf;

/// 토큰 저장소. 운영은 OS 키체인(`Keychain`), 테스트는 메모리 구현.
pub trait SecretStore: Send + Sync {
    fn set(&self, key: &str, secret: &str) -> Result<()>;
    fn get(&self, key: &str) -> Result<Option<String>>;
    fn delete(&self, key: &str) -> Result<()>;
}

/// 서비스 "git403", 사용자 `<provider>:<host>:<username>`
pub struct Keychain;

impl Keychain {
    fn entry(key: &str) -> Result<keyring::Entry> {
        keyring::Entry::new("git403", key).map_err(|e| Error::Store(e.to_string()))
    }
}

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
