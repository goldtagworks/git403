# 릴리스 절차

패키징·배포·자동 업데이트의 단일 문서. 빌드·배포는 로컬에서 한다. CI(`.github/workflows/ci.yml`·`vscode.yml`)는 수동 실행만. 지금 배포 방법은 아래 "개인 배포". 코드 서명·공증은 쓰지 않는다(아래 해당 절은 나중을 위한 참고). 앱 안 업데이트는 업데이터 키로 서명한다.

릴리스 노트는 루트 `CHANGELOG.md`의 `## <버전>` 절을 쓴다(`scripts/release-notes.mjs`가 뽑아 배포 스크립트의 `gh release create --notes`로 넘김). 배포 전에 그 절을 먼저 적는다. 확장은 `vscode/CHANGELOG.md`(마켓플레이스 Changelog 탭).

## 개인 배포 (macOS Homebrew·Windows 설치 파일, 서명 없음)

공개 저장소 [`goldtagworks/git403`](https://github.com/goldtagworks/git403) 하나에 소스·릴리스·캐스크(`main`의 `Casks/git403.rb`)를 둔다. 릴리스 노트도 공개되므로 `CHANGELOG.md`에는 사용자에게 보여도 되는 내용만 적는다.

1. `src-tauri/tauri.conf.json`의 `version`을 올린다.
2. Mac에서 `scripts/release-mac.sh`: Apple Silicon(`aarch64`)·Intel(`x64`) dmg를 따로 빌드(유니버설 아님, `rustup target`은 스크립트가 추가) → 릴리스 `v<version>`(없으면 생성)에 업로드 → `Casks/git403.rb`(`on_arm`·`on_intel`별 url·sha256) 갱신·push. 활성 gh 계정과 상관없이 goldtagworks 토큰(`gh auth token -u goldtagworks`)을 쓴다.
   - Windows PC에서 `powershell -ExecutionPolicy Bypass -File scripts\windows\release.ps1`: `build.ps1` 빌드 → 같은 릴리스에 `git403_<version>_x64-setup.exe` 업로드. 그 PC의 gh에도 goldtagworks 계정이 로그인돼 있어야 한다. 순서는 상관없다(먼저 도는 쪽이 릴리스를 만든다).
3. Windows 설치: 릴리스의 `-setup.exe`를 받아 실행(SmartScreen → 추가 정보 → 실행). macOS 설치: `brew tap goldtagworks/git403 https://github.com/goldtagworks/git403 && brew install --cask git403`. 업데이트: `brew update && brew upgrade --cask git403`. 캐스크 `postflight`가 격리 속성을 지워 Gatekeeper 경고 없이 열린다.

- 앱 안 자동 업데이트도 같은 저장소 릴리스에서 받는다: Mac은 `git403_<version>_aarch64.app.tar.gz`·`_x64.app.tar.gz`(`darwin-aarch64`·`darwin-x86_64`), Windows는 `-setup.exe`와 각 `.sig`, 그리고 `latest.json`. 캐스크는 `auto_updates true`라 앱이 스스로 업데이트해도 brew와 충돌하지 않는다. 서명 키 `~/.tauri/git403.key`(2026-10-21 새로 만듦, 암호 없음)를 Windows PC의 `%USERPROFILE%\.tauri\`에도 복사해 둔다.
- 스크린샷(`images/`)은 mock UI를 Playwright로 찍는다(1440×900, 라이트·다크): 그래프·커밋 diff, 나란히 diff·변경사항, 저장소 통계, 설정. mock 기본 diff에는 다른 프로젝트 식별자가 섞여 있으니 `window.__fileDiff`로 중립 diff를 넣어 찍고, 올리기 전에 이미지를 눈으로 확인한다. 화면이 바뀌면 다시 찍어 이 저장소의 `images/`를 교체한다.

## VS Code 확장 (Marketplace)

확장 ID `goldtagworks.git403-vscode`(publisher `goldtagworks`, `name`은 `git403-vscode`). `goldtagworks.git403`과 표시 이름 `git403`은 한 번 올렸다 지워서 마켓이 영구 예약해 다시 쓸 수 없다(표시 이름은 `git403 for VS Code`). 잘못 올렸으면 지우지 말고 Update로 덮어쓴다. 서버 바이너리가 플랫폼마다 달라 각 OS에서 그 OS용 VSIX를 만들어 올린다. 상세 페이지는 `vscode/README.md`(이미지는 이 저장소 `docs/images`의 raw 절대 URL).

- PAT(`vsce publish`)는 쓰지 않는다: 새 Azure DevOps 조직은 Azure 구독(카드 등록)이 필요하다. 대신 웹 업로드.
- 배포: `vscode/package.json`의 `version`을 올리고 각 OS에서 `pnpm --dir vscode package` → marketplace.visualstudio.com/manage/publishers/goldtagworks 에서 처음엔 New extension → Visual Studio Code, 이후엔 확장 `…` → Update로 VSIX 업로드. 플랫폼별 VSIX를 각각 올린다.
- Cursor 등은 Open VSX: 같은 VSIX를 `npx ovsx publish <vsix> -p <토큰>`.

## macOS 코드사인 (참고만, 아직 적용 안 함)

Developer ID 인증서 + hardened runtime + App Store Connect API 키 공증. Tauri에서는 이렇게 한다.

- 인증서: 키체인의 `Developer ID Application: 이름 (TEAMID)`. 확인: `security find-identity -v -p codesigning`.
  - 개인 Apple Developer 계정(연 $99)의 인증서를 쓴다. 다른 조직의 인증서로 서명하지 않는다.
- 서명: `tauri.conf.json` → `bundle.macOS.signingIdentity`(또는 환경 변수 `APPLE_SIGNING_IDENTITY`). Tauri는 hardened runtime을 기본으로 켠다. 권한이 더 필요하면 `bundle.macOS.entitlements`에 plist를 지정한다.
- 공증: App Store Connect API 키를 쓴다. 환경 변수 `APPLE_API_KEY`(키 ID), `APPLE_API_ISSUER`, `APPLE_API_KEY_PATH`(`AuthKey_XXXX.p8` 경로)를 주면 `tauri build`가 공증·staple까지 한다. electron-builder는 `APPLE_API_KEY`가 .p8 경로라서 이름이 다르니 주의. 앱 암호 방식은 위 표의 `APPLE_ID`·`APPLE_PASSWORD`·`APPLE_TEAM_ID`.
- 내 Mac에서만 쓸 때: `signingIdentity: "-"`(ad-hoc)면 인증서·공증 없이 직접 빌드한 앱이 실행된다. 다른 Mac에 옮기면 처음 한 번 "열기"를 허용해야 한다.
- 확인: `codesign -dv --verbose=4 git403.app`, `spctl -a -vv git403.app`(공증됐으면 `source=Notarized Developer ID`).

## 업데이터 서명 키

- 비공개키: `~/.tauri/git403.key` (저장소 밖. `.gitignore`가 `*.key`도 막는다). 공개키: `~/.tauri/git403.key.pub`, 같은 값이 `tauri.conf.json`의 `plugins.updater.pubkey`에 들어 있다.
- **비공개키를 잃으면 기존 설치본은 더 이상 업데이트를 받지 못한다**(공개키가 앱에 박혀 있음). 비밀번호 관리자 등 저장소 밖 두 곳 이상에 백업한다. 유출되면 새 키를 만들고 공개키를 바꾼 버전을 수동 설치로 배포해야 한다.
- 새로 만들기: `pnpm tauri signer generate -w ~/.tauri/git403.key` (암호를 주려면 `-p`).
- 서명 키 환경 변수 없이 `tauri build`를 하면 `createUpdaterArtifacts`가 켜져 있어 서명 단계에서 실패한다. 로컬에서 서명 없이 번들만 보려면 `pnpm build --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'`.

## 로컬 빌드

```
TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/git403.key" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" pnpm build --bundles app
```

결과: `target/release/bundle/macos/git403.app`, `.app.tar.gz`와 `.sig`(업데이터 아티팩트). `--bundles`를 빼면 dmg 등 전부 만든다(`hdiutil`이 느릴 수 있음).

## 자동 업데이트 동작

- endpoint: `https://github.com/goldtagworks/git403/releases/latest/download/latest.json`. `latest.json`은 배포 스크립트가 `scripts/latest-json.mjs`로 플랫폼별(darwin-aarch64·darwin-x86_64·windows-x86_64)로 합쳐 올린다.
- 앱은 시작 5초 뒤와 이후 매시간 "마지막 성공 확인이 하루 넘었는가"를 보고 확인한다(설정 > 일반 > 업데이트 자동 확인으로 끔). 실패는 조용히 넘어가고, 설정의 "지금 확인"만 결과를 보여 준다.
- 새 버전이 있으면 상단 배너 → "업데이트하고 재시작" → 다운로드 진행률 → 설치 → 재시작(Windows는 설치 프로그램이 앱을 종료).
- git은 번들하지 않는다. 시작 시 `git --version`이 실패하면 설치 안내 배너를 띄운다. deb/rpm은 `git`에 의존한다.

## 플랫폼 검증 현황

- `cargo check --target x86_64-pc-windows-msvc`는 mac에서 gc-core·gc-graph만 가능하다(reqwest의 aws-lc-sys가 `windows.h`를 요구). hosting·ai·src-tauri의 Windows 컴파일, Linux의 keyring(libdbus)·webkit 빌드는 CI 매트릭스가 확인한다.
