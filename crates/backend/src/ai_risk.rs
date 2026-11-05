//! AI 채팅 시작 전 확인이 필요한 저장소인가 (docs/security.md "AI 채팅"). 판정 불가는 위험으로 본다.
//!
//! 규칙: 원격이 없거나 전부 같은 컴퓨터의 경로(`/x`·`../x`·`file://`)면 `none`(로컬 전용). GitHub 원격은 `GET /repos/{o}/{r}`의 `private`로 공개(`public`)를 가리고,
//! private이면 `GET /user`(본인) + `GET /repos/{o}/{r}/collaborators`에서 본인을 뺀 수가 1명 이상이면 `shared`, 0명이면 `none`.
//! 그 밖의 서비스·계정/토큰 없음·조회 실패·협업자 조회 권한 없음·해석 못 하는 원격은 `unknown`. 원격이 여럿이면 가장 위험한 쪽
//! (public > shared > unknown > none).

use std::path::Path;

use gc_hosting::{Account, Exposure, Provider};
use serde::Serialize;

use crate::util::{err, Res};
use crate::Backend;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    None,
    Public,
    Shared,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Risk {
    pub level: Level,
    /// `shared`일 때: 본인 외 협업자 수
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collaborators: Option<usize>,
    /// 판정에 쓴 원격 URL(가져오기·보내기, `insteadOf` 적용 후)의 지문. 확인 키에 넣어 원격이 바뀌면 다시 묻는다. UI로는 보내지 않는다
    #[serde(skip)]
    pub fingerprint: String,
    /// 저장소 로컬 설정(include 포함)에 있는, git이 프로그램을 실행하게 만드는 키 이름들(textconv·filter·sshCommand·credential.helper·driver 등, 값은 안 담음).
    /// 비어 있지 않으면 레벨과 무관하게 확인이 필요하다(훅·ext-diff·textconv는 앱이 끄지만 filter·driver·sshCommand 등은 끌 수 없다)
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub exec: Vec<String>,
}

const fn risk(level: Level, collaborators: Option<usize>) -> Risk {
    Risk { level, collaborators, fingerprint: String::new(), exec: Vec::new() }
}

/// 조회 결과 → 위험. 오류(접근 불가·한도·네트워크·GitHub 아님)는 전부 `unknown`.
pub fn classify(r: Result<Exposure, gc_hosting::Error>) -> Risk {
    match r {
        Ok(Exposure { private: false, .. }) => risk(Level::Public, None),
        Ok(Exposure { collaborators: Some(0), .. }) => risk(Level::None, None),
        Ok(Exposure { collaborators: Some(n), .. }) => risk(Level::Shared, Some(n)),
        Ok(_) | Err(_) => risk(Level::Unknown, None),
    }
}

/// 여러 원격 중 가장 위험한 것 (공개 > 다수 > 불명 > 없음). 비면 `none`.
pub fn combine(rs: impl IntoIterator<Item = Risk>) -> Risk {
    let rank = |r: &Risk| match r.level {
        Level::Public => 3,
        Level::Shared => 2,
        Level::Unknown => 1,
        Level::None => 0,
    };
    rs.into_iter().max_by_key(|r| (rank(r), r.collaborators)).unwrap_or(risk(Level::None, None))
}

/// 같은 컴퓨터의 경로를 가리키는 원격 URL인가 (절대·상대 경로, `~`, `file://`, Windows 드라이브)
fn is_local_url(u: &str) -> bool {
    let b = u.as_bytes();
    u.starts_with(['/', '.', '~', '\\']) || u.starts_with("file://") || (b.len() > 2 && b[1] == b':' && b[0].is_ascii_alphabetic() && (b[2] == b'\\' || b[2] == b'/'))
}

impl Backend {
    /// 저장소의 위험 판정. 원격이 없으면 네트워크를 쓰지 않는다. 원격 URL은 `git remote get-url --all`(가져오기)과 `--push --all`(`pushurl` 포함)이
    /// 돌려주는 값 — git이 `url.<base>.insteadOf`를 적용한 뒤의 실제 주소다.
    pub(crate) async fn ai_chat_risk(&self, repo: &Path) -> Res<Risk> {
        let names = self.backend.run(repo, &["remote"], &[]).await.map_err(err)?;
        let names: Vec<String> = String::from_utf8_lossy(&names).lines().map(|l| l.trim().to_owned()).filter(|l| !l.is_empty()).collect();
        let mut urls = Vec::new();
        for n in &names {
            for push in [false, true] {
                let mut a = vec!["remote", "get-url", "--all"];
                if push {
                    a.push("--push");
                }
                a.push(n.as_str());
                // 실패(원격 설정 이상)는 해석 못 하는 원격으로 취급한다
                match self.backend.run(repo, &a, &[]).await {
                    Ok(o) => urls.extend(String::from_utf8_lossy(&o).lines().map(|l| (n.clone(), l.trim().to_owned())).filter(|(_, u)| !u.is_empty())),
                    Err(_) => urls.push((n.clone(), String::new())),
                }
            }
        }
        let fp = gc_core::ai_tool::remotes_fingerprint(&mut urls);
        // 같은 컴퓨터의 경로(`/x`, `../x`, `file://`)는 호스팅 서비스가 아니므로 로컬 전용으로 본다
        let hosted: Vec<&(String, String)> = urls.iter().filter(|(_, u)| u.is_empty() || !is_local_url(u)).collect();
        let mut all = Vec::new();
        if !hosted.is_empty() {
            let accts = self.hosting.accounts();
            let accounts = crate::util::off(move || accts.list().map_err(|e| e.ipc())).await.unwrap_or_default();
            for (name, url) in hosted {
                // 해석할 수 없는 원격(알 수 없는 URL 형식·빈 값)은 불명
                let Some(parsed) = gc_hosting::parse_remote(url) else {
                    all.push(risk(Level::Unknown, None));
                    continue;
                };
                let info = crate::hosting::info_for(&accounts, name.clone(), url.clone(), parsed);
                if info.provider != Some(Provider::GitHub) {
                    all.push(risk(Level::Unknown, None));
                    continue;
                }
                // 토큰: 저장소에 연결한 gh 계정 → 앱 계정 → `gh auth token`. 없으면 토큰 없이(공개 저장소만 읽힌다)
                let bound = self.gh_read_token(repo, &info.repo).await;
                let (account, token) = match self.hosting.pr_auth(info.account.clone(), &info.repo, self.path_env(), bound).await {
                    Ok((a, t)) => (a, Some(t)),
                    Err(_) => (Account { provider: Provider::GitHub, host: info.repo.host.clone(), username: String::new() }, None),
                };
                all.push(classify(gc_hosting::repo_exposure(&account, token.as_deref(), &info.repo).await));
            }
        }
        // 저장소 로컬 설정의 실행형 키(키 이름에 URL이 있으면 자격 증명을 가려 보낸다)
        let cfg = self.backend.run(repo, &["config", "--list", "--includes", "--show-scope", "-z"], &[1]).await.unwrap_or_default();
        let exec = gc_core::ai_tool::exec_config_keys(&String::from_utf8_lossy(&cfg)).iter().map(|k| crate::settings_io::redact(k)).collect();
        Ok(Risk { fingerprint: fp, exec, ..combine(all) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_maps_exposure_and_errors_to_levels() {
        let ex = |private, collaborators| Ok(Exposure { private, collaborators });
        assert_eq!(classify(ex(false, None)), risk(Level::Public, None));
        assert_eq!(classify(ex(true, Some(0))), risk(Level::None, None));
        assert_eq!(classify(ex(true, Some(3))), risk(Level::Shared, Some(3)));
        assert_eq!(classify(ex(true, None)), risk(Level::Unknown, None), "협업자 수를 모르면 불명");
        for e in [gc_hosting::Error::NotFound, gc_hosting::Error::Forbidden, gc_hosting::Error::Unauthorized, gc_hosting::Error::Timeout, gc_hosting::Error::Unsupported] {
            assert_eq!(classify(Err(e)), risk(Level::Unknown, None));
        }
    }

    #[test]
    fn local_paths_are_not_hosted_remotes() {
        for u in ["/srv/git/x.git", "../x", "./x", "~/x", "file:///x.git", "C:\\repos\\x", "D:/x"] {
            assert!(is_local_url(u), "{u}");
        }
        for u in ["https://github.com/o/r.git", "git@github.com:o/r.git", "ssh://git@host/x", "host:path"] {
            assert!(!is_local_url(u), "{u}");
        }
    }

    #[test]
    fn combine_takes_the_riskiest_and_serializes() {
        let r = |l, c| risk(l, c);
        assert_eq!(combine([]).level, Level::None);
        assert_eq!(combine([r(Level::None, None), r(Level::Unknown, None)]).level, Level::Unknown);
        assert_eq!(combine([r(Level::Unknown, None), r(Level::Shared, Some(2)), r(Level::Shared, Some(5))]), r(Level::Shared, Some(5)));
        assert_eq!(combine([r(Level::Shared, Some(2)), r(Level::Public, None), r(Level::None, None)]).level, Level::Public);
        assert_eq!(serde_json::to_value(r(Level::Shared, Some(2))).unwrap(), serde_json::json!({"level": "shared", "collaborators": 2}));
        assert_eq!(serde_json::to_value(r(Level::None, None)).unwrap(), serde_json::json!({"level": "none"}));
    }
}
