# 로드맵

## 이어서 하기 (다음 세션용)

- 작업 브랜치: `main`(브랜치 만들지 않는다). 0~25단계 완료(25는 diff 업그레이드 a~d, 25b~d는 사용자 확인 대기), UI FSD 구조 정리 완료. 20~24는 VS Code 확장 트랙(GitLens식: 그래프 웹뷰·줄 끝 blame·호버·상태 바·사이드바 TreeView·CodeLens·다중 저장소·저장 전 편집 추적). **진행 중: 27단계(코어 백엔드 레이어화, Android 대비)** — 27a·27b 완료, 27c 완료, cli 분리(27c-2) 완료, 다음은 27d.
- 구조: 명령 본문은 `crates/backend`(`dispatch.rs` 진입점 + 담당 모듈). Tauri 앱(`src-tauri`)과 stdio 서버 `git403-server`가 같이 쓴다. 새 IPC는 `dispatch`에 arm 하나. UI는 `ui/src/shared/api/bridge.ts`로 Tauri/VS Code를 가른다. UI 코드는 FSD 레이어(`app`·`widgets`·`features`·`entities`·`shared`, 규칙은 `docs/reuse.md` ui 절)로 나뉘어 있다. 확장은 `vscode/`(`extension.ts` → `features`·`services`·`shared` 계층).
- 먼저 읽을 문서: 이 파일 → `docs/reuse.md`(모듈·IPC·서버 프로토콜·VS Code 확장 절) → `docs/performance.md` → `docs/design.md`.
- 확인 명령: `cargo test --workspace --no-fail-fast` · `pnpm --dir ui build` · `pnpm --dir ui e2e`(mock, headless) · `pnpm --dir ui e2e:app`(실제 앱, 창 뜸) · `pnpm --dir ui e2e:native`(macOS OS 연동, 창 뜸·키보드 사용) · `pnpm --dir vscode test:unit` · `pnpm --dir vscode test`(진짜 VS Code 스모크 single+multi, 창 뜸) · `pnpm --dir vscode package`(현재 OS VSIX).
- CI: `.github/workflows/ci.yml`(Rust·mock E2E, macOS·ubuntu·windows), `vscode.yml`(VSIX 4종 + Linux xvfb 스모크). 푸시는 gh 계정 goldtagworks로.
- 사용자가 이 Mac에서 작업 중일 때는 창 뜨는 테스트(e2e:app, VS Code 스모크)를 묻고 돌린다.

다음 후보
- VS Code 마켓플레이스 배포 준비: publisher `git403` 등록·PAT, `vsce publish` CI 잡, CHANGELOG, 아이콘·README 스크린샷.
- 실제 앱 OS 연동 중 아직 확인 안 한 것 (`e2e:native`에 단계로 추가하는 방식):
  - opener: 기본 앱·브라우저 열기(`open_in`·`openUrl`). 테스트용 URL 스킴·확장자 처리기를 등록해 호출을 받아 확인하는 방법을 검토.
  - AI: 키체인의 AI 키(`ai:anthropic`, 임시 키체인으로), 실제 API·Claude Code CLI 호출(키·비용이 들어 수동 확인 또는 가짜 서버).
  - 업데이트 실제 설치·재시작: 서명이 맞는 패키지로 `.app` 번들을 임시 위치에 두고 설치·재실행까지 (지금은 서명 검증 실패까지만).
  - SSH askpass: 암호 있는 키 + 로컬 sshd(또는 `GIT_SSH_COMMAND` 흉내)로 passphrase 질문.
  - Windows·Linux: 네이티브 메뉴·키체인(Credential Manager·Secret Service)·askpass. `e2e:native`는 macOS(System Events)만 지원.
- 확인한 것: 네이티브 메뉴·확인창, http askpass Pull/Push(틀린 비밀번호 포함), 계정 토큰 키체인, 외부 diff/merge, 로그인 셸 PATH, 업데이트 확인·다운로드·서명 검증 → `pnpm --dir ui e2e:native`.
- AI 인증 B(OAuth 프로필), AI 리뷰 결과의 파일·줄 이동 (`docs/ai-auth.md`).
- 릴리스 전 GitHub secrets 등록과 서명 키 백업 (`docs/release.md`).
- RTL 언어(아랍어·히브리어·페르시아어): 번역만으론 안 됨 — 레이아웃 좌우 반전, Canvas 그래프 방향, 코드·경로(LTR) 혼재, RTL 스크린샷 E2E가 필요해 별도 단계로. 28단계에선 제외.

알려진 한계
- VS Code 저장 전 편집 추적: 다른 위치로 옮긴 줄·빈 줄 위주의 모호한 재입력·이미 고친 채 열린 문서(디스크 텍스트 모름)·아주 큰 구간(LCS 표 상한)은 새 줄(커밋 안 됨)로 보인다. 한 줄 안의 수정은 줄 단위로만 판단.
- VS Code 다중 저장소 탐색은 작업 영역 폴더 아래 깊이 3·2000폴더까지. 심볼 렌즈는 언어 서버가 심볼을 줘야 보인다. 작업 영역 밖 저장소 탭에서는 "편집기에서 열기"를 무시한다.
- interactive rebase 시트는 Rust 통합 테스트로만 검증(E2E는 머지 커밋 차단만).
- `e2e:native`는 CI에서 돌리지 않는다(macOS 손쉬운 사용 권한·키보드 포커스 필요). OS 연동을 바꿨을 때 로컬에서 돌린다.

한 번에 한 단계씩 진행한다. 각 단계는 **완료 기준을 모두 통과**하고 사용자 확인을 받은 뒤 커밋하고 다음 단계로 넘어간다.
공통 완료 기준(모든 단계): Rust 테스트 · E2E · 리렌더링 테스트 통과, `docs/reuse.md` 갱신, 라이트/다크 스크린샷 확인.

| 단계 | 내용 | 상태 |
|---|---|---|
| 0 | 지금까지 작업 정리·커밋 | 완료 |
| 1 | 작업 디렉터리 변경 보기, 파일 감시 자동 새로고침 | 완료 |
| 2 | 스테이지·언스테이지(파일·hunk·줄), 변경 되돌리기 | 완료 |
| 3 | 커밋, amend, 커밋 메시지 수정(reword) | 완료 (reword는 7단계 interactive rebase와 함께) |
| 4 | 브랜치 체크아웃·생성·삭제·이름 변경·추적, 원격 브랜치 삭제, 태그 생성·삭제·push | 완료 |
| 5 | 툴바 재설계, 우클릭 메뉴, 단축키, 빠른 실행(명령 팔레트) | 완료 |
| 6 | Pull/Push/Fetch 옵션 대화상자, 원격 추가·편집·삭제, 인증(askpass), ahead/behind | 완료 |
| 7 | merge, rebase, interactive rebase, cherry-pick, revert, reset, 충돌 해결 화면 | 완료 |
| 8 | 스태시: 만들기(부분 포함)·적용·pop·삭제·이름 변경 | 완료 |
| 9 | 검색(메시지·작성자·SHA·내용), 파일 히스토리, blame, 커밋 시점 파일 보기, .gitignore 추가 | 완료 |
| 10 | 저장소 관리: clone, init, 저장소 목록·탭, 작업공간 | 완료 |
| 11 | 서브모듈, worktree, Git LFS | 완료 |
| 12 | git-flow (feature·release·hotfix) | 완료 |
| 13 | 패치 저장·적용, 스냅샷 | 완료 |
| 14 | 사용자 정의 명령, 외부 diff/merge 도구, 터미널·파일 탐색기 열기 | 완료 |
| 15 | 계정 연동(GitHub·GitLab·Bitbucket·Gitea), PR 만들기, 이슈 트래커 링크 | 완료 |
| 16 | 저장소 통계·개요 | 완료 |
| 17 | 설정: git 사용자·gitignore·SSH 키·외관 | 완료 |
| 18 | git 작업용 AI: 커밋 메시지·코드 리뷰·충돌 도우미·PR 설명 (사용자 API 키, 없으면 숨김). 범용 에디터·에이전트는 넣지 않는다 | 완료 |
| 19 | Windows·Linux 빌드 확인, 패키징, 자동 업데이트 | 완료 |
| 20 | VS Code 확장 기반: `crates/backend`(명령 본문 공유) + `git403-server`(stdio) + `ui/src/shared/api/bridge.ts` + 웹뷰 그래프 패널 | 완료 |
| 21 | VS Code 편집기 통합: 줄 끝 blame, 호버(커밋 정보·diff), 상태 바 | 완료 |
| 22 | VS Code 사이드바 TreeView: 브랜치·태그·스태시·원격, 파일·줄 히스토리 | 완료 |
| 23 | VS Code CodeLens, 그래프↔편집기 연동(커밋 클릭 → 파일 diff 열기) | 완료 |
| 24 | VS Code 확장 미구현분: 저장 전 편집 추적, 다중 저장소, 심볼 CodeLens, diff 줄 이동, 브랜치 클릭, 스태시 검증, 크로스플랫폼 VSIX CI | 완료 |
| 25 | diff 업그레이드: 파일 이전/다음(25a), 이미지 diff(25b), xib/storyboard 시각 diff(25c), AI 읽는 흐름 리뷰(25d) | 진행 중 |
| 26 | PR 리뷰(PRView 참고): 목록·개요·대화(26a), 변경 파일(26b), AI 리뷰 초안·게시(26c), 새 커밋만 다시 리뷰(26d), 목록 보강·닫힌 PR(26e) | 진행 중 |
| 27 | 다국어 준비 정리: Rust 사용자 문구를 오류 코드(`coded!`)로 바꾸고 UI 사전 `err.*`로 번역, UI 하드코딩 문구 키화 | 완료 |
| 28 | 다국어 23개: 기존 14(en ko zh-CN zh-TW vi ja tl km uz lo ru th mn ne) + 유럽 9(de fr es pt-BR it pl tr uk nl), 언어마다 `locales/xx.ts` 전량 번역 | 완료 |

기능 목록 출처: rea로 확인한 참고 앱의 화면·대화상자·명령 목록. 같은 기능을 우리 방식으로 새로 구현한다.

별도 트랙(단계 사이에 끼워 넣음)
- 참고 앱 분석 결과 정리 후 분석 산출물 삭제 (단계 1 전)
- 하네스(에이전트·스킬) 재구성 (단계 3 완료 후, 기본 작업 흐름이 생긴 시점)

---

## 0. 정리·커밋
- 미커밋 변경(UI 레이아웃, 테마, 스플리터, 상태바, E2E, 문서)을 커밋하고 push.
- 완료 기준: `git status` 깨끗함, 원격 반영.

## 1. 작업 디렉터리 변경 보기
- core: `status`(`git status --porcelain=v2 -z`) 파싱 → 스테이지된 파일 / 안 된 파일 / 추적 안 하는 파일 / 충돌.
- core: 작업 디렉터리 diff(`git diff`, `git diff --cached`).
- UI: 커밋 목록 맨 위에 "로컬 변경사항" 행. 누르면 하단이 변경 화면(스테이지 안 됨 / 스테이지됨 두 목록 + diff)으로 바뀐다.
- 파일이 바뀌면 자동 새로고침: Rust에서 파일 감시(`notify`), 짧은 시간 몰아서 한 번만 이벤트.
- 완료 기준: 실제 git 저장소로 수정·추가·삭제·이름 변경·충돌 상태 파싱 테스트, 파일 저장 후 1초 안에 화면 반영(E2E), 감시 이벤트가 그래프를 다시 그리지 않음(리렌더링 테스트).

## 2. 스테이지 · 언스테이지 · 되돌리기
- 파일 단위: stage / unstage / discard (discard는 OS 확인 대화상자).
- hunk 단위, 줄 단위: diff에서 선택 → `git apply --cached` 패치.
- 완료 기준: 파일·hunk·줄 단위 각각 실제 저장소 테스트, 새 파일·삭제 파일·바이너리 예외 처리.

## 3. 커밋 · amend
- 커밋 메시지(제목/본문), 커밋, amend(직전 메시지 불러오기), 빈 메시지·스테이지 없음 막기.
- 완료 기준: 커밋 후 그래프·상태 갱신, amend 테스트, 훅 실패 시 오류 메시지 표시.

## 4. 브랜치
- 체크아웃(더블클릭), 생성(현재/선택 커밋에서), 삭제, 이름 변경, 원격 브랜치에서 추적 브랜치 만들기.
- 로컬 변경이 있으면 선택지(스태시 후 재적용 / 그대로 / 취소).

## 5. 우클릭 메뉴 · 키보드
- 커밋·브랜치·파일 우클릭 메뉴(OS 네이티브 메뉴), 단축키(⌘/Ctrl 관례), 목록 키보드 이동.

## 6. 원격 인증 · ahead/behind
- askpass로 사용자명·토큰·SSH 암호 입력 창, OS 키체인 연동.
- 사이드바·상태바에 ahead/behind 표시.

## 7~11
- 앞 단계가 끝날 때 다시 구체화한다.

## 27. 코어 백엔드 레이어화 (진행 중, Android 대비)

목표: Android에서 git 실행 파일 없이 순수 Rust(gitoxide) 백엔드를 쓸 수 있게, git 실행 경로를 trait 뒤로 숨긴다. 데스크탑은 지금과 같은 `CliBackend`.
- 27a `GitBackend` trait + `CliBackend` (완료; 동작·IPC·UI 변화 없음): `crates/core/src/backend.rs`. `gc-core` feature `cli`(기본)·`gix`(예약). `crates/backend`는 조회·쓰기·긴 작업·짧은 argv 실행·설정 읽기를 `Inner.backend: Arc<dyn GitBackend>`로 부른다. `GitRunner`를 직접 쓰는 곳(PATH 보정·`spawn_shell`·askpass 환경·conventions·ai)은 docs/reuse.md 참고. 완료 기준: `cargo test --workspace`(CliBackend = 기존 함수 같은 결과 테스트), `cargo check -p gc-core --no-default-features`(워크스페이스 전체는 `gc-backend`가 `CliBackend`를 쓰므로 해당 없음), `e2e`·`e2e:app` 통과.
- 27b capabilities IPC (완료): IPC `capabilities` → `{all, ops}`, UI는 시작 때 한 번 받아 `ui/src/shared/lib/caps.ts`의 `supports`/`visible`로 미지원 작업을 우클릭·드롭다운·툴바 버튼·빠른 실행·메뉴 막대에서 숨긴다(`op` 태그 규칙은 docs/reuse.md). `git.unsupported`는 UI 사전에 추가됨. 테스트 `ui/e2e/caps.spec.ts`. 한계: 단축키 직접 실행·사이드바 섹션 인라인 버튼은 숨기지 않고 실행 시 unsupported 토스트, PR/hosting 항목은 `op` 태그가 없어 항상 보인다.
- 27c `GixBackend` (완료): `crates/core/src/gix_backend/`(feature `gix`, 기본 빌드엔 안 들어감). 조회 `read_log head_commit read_refs read_status changed_files file_diff worktree_diff file_blob commit_message committer`, 쓰기 `stage unstage commit`, `run`(`config --get`·`symbolic-ref`·`rev-parse`)·`spawn_job`(`fetch [<remote>]`)은 argv 허용 목록. `capabilities`는 구현한 op만(`all:false`). 교차 테스트 `tests/gix_cross.rs`가 CliBackend와 **정규화 없이** 비교(무작위 diff 포함). 완료 기준: `cargo test --workspace`, `cargo test -p gc-core --features gix`, `cargo check -p gc-core --no-default-features --features gix`. 쓰기(stage·unstage·commit)는 gix 위에 직접 구현한 범위라(인덱스 갱신·트리/커밋 객체·ref 갱신) 원칙을 "git과 같게 못 하면 거절"로 두고 훅·서명·sparse index·보존 못 하는 인덱스 확장·skip-worktree·비기본 `commit.cleanup`/`i18n.commitEncoding`을 `Unsupported`로 막았다. 한계(자세한 목록은 docs/reuse.md): 훅 미실행(있으면 거절), fetch는 `FETCH_HEAD`를 안 쓰고 prune 설정이면 거절, diff 드라이버 미지원, `fetch --all --prune --tags --progress`(UI의 Fetch argv)·push·pull·blame·file_log·discard·restore_file·apply_partial·rebase 미구현, Android 타깃 컴파일은 타깃 미설치로 미확인(android 타깃 의존성 트리에 `rustls-platform-verifier-android`·`jni`가 들어오는 것은 `cargo tree --target aarch64-linux-android`로 확인했으므로 27d에서 JNI 초기화가 필요하다. `trash` 크레이트의 android 컴파일은 미확인). 남은 과제였던 `cli` 분리는 아래 27c-2로 했다.
- 27c-2 cli 분리 (완료): `gc-core`에서 feature `cli`를 끄면 git 프로세스 실행 코드가 컴파일에서 빠진다(`runner`·`shellenv`·`ssh`·`version`·`restore`·`commit_graph` 모듈, `job.rs`의 프로세스 부분, `&GitRunner`를 받는 조회·쓰기 함수와 전용 파서; 타입·`JobEvent`/`JobHandle`·`Error`·`reject_option`·`patch` 등 공용은 유지). `gc-backend`는 feature `cli`(기본)/`gix`를 전달하고, `gix`에선 `GixBackend`로 조립 — `Inner.git: GitRunner`는 `cli` 전용, 호출 측은 `Inner::path_env()`·`GitBackend::run`만 쓴다. `gix` 빌드에서 `start_shell`·`ssh_keys`·`ssh_generate`는 `git.unsupported`, askpass·로그인 셸 PATH 보정 없음. 데스크탑 기본 빌드·IPC·UI 불변. 완료 기준: `cargo test --workspace`, `cargo test -p gc-core --features gix`, `cargo check -p gc-core|gc-backend --no-default-features --features gix`(경고 0), `pnpm --dir ui build`. 한계: gix 빌드의 gc-backend 단위 테스트는 `cli` 전용(컴파일 안 됨), gh·AI CLI·`open_in`은 gc-backend/gc-ai에서 외부 프로세스를 그대로 띄운다(Android 대응은 27d).
- 27d Tauri Android 빌드: `src-tauri`에서 android 타깃은 `gix` feature, updater·window-state·네이티브 메뉴·askpass·`spawn_shell`(사용자 셸 명령, trait 밖) 등을 cfg로 분리.
- 27e 태블릿 레이아웃: React 유지, 좁은 화면·터치.

## 26. PR 리뷰 (진행 중)

GitHub PR을 앱 안에서 리뷰한다. PRView(terry-yes/PRView, 소스 없음·README 스크린샷만)의 화면을 참고했다. GitHub만 지원하고, 토큰은 연결 계정 → 없으면 `gh auth token`(저장 안 함).
- 26a 목록·개요·대화 (완료): Rust `gc_hosting::graphql`(`pr_inbox`·`pr_detail`, GraphQL 한 번, 부분 오류·null 노드 처리). PR 화면 `features/hosting/PrReview.tsx`는 `.workspace`를 덮는다: 목록(리뷰 대기·내 PR·전체, 검색, 재요청은 배지+왼쪽 막대, 접기 ⌘\·폭 조절) | 상세(카드 줄·본문·타임라인). 본문·리뷰·코멘트는 평문 미리보기 → 클릭하면 팝업(`PrPopup`, 마크다운 `shared/ui/Markdown.tsx`(markdown-it, html:false), 크게/보통·글자 크기 저장, 이전/다음). 사이드바 PR 섹션은 계정이 없어도 gh 로그인으로 조회되면 보인다. 닫기는 글자 버튼 "닫기 Esc".
- 26b 변경 파일 (완료): `PrFiles.tsx` — 범위 [전체 변경 | 커밋별 ▾ ‹ ›], 기존 DiffFrame·DiffView·FileNav·크게 보기 재사용, 리뷰 스레드는 줄 아래 인라인 카드(`DiffNote kind:"thread"`). 로컬에 없으면 `git fetch --no-tags --progress -- <원격> refs/pull/<N>/head`(로컬 ref 안 만듦). 타임라인 커밋 클릭 = 변경 파일 탭 + 그 커밋, "← 대화로 돌아가기"(⌘[)로 그 항목에 복귀. 탭 패널은 언마운트하지 않아 스크롤·선택 유지. 우클릭: 그래프에서 보기·GitHub에서 보기.
- 함께 고친 것: macOS ⌘W·창 닫기는 앱 종료 대신 창 숨김, Dock 아이콘으로 다시 보임(`e2e:native` 단계 추가).
- 26a 후속 (완료): 개요 안내줄(내 리뷰 상태·다음 할 일, [새 커밋 보기])·내가 올린 PR 묶음(접기 저장, 리뷰어 진행도)·탭 보조 글.
- 26c AI 리뷰 (Rust·UI 완료, 사용자 확인 대기): `Task::PrReview`(Rust, ca2ed5a) + AI 리뷰 탭 `PrAi.tsx` — 실행 전(설명·보내는 내용·모델·노력 저장)·진행(경과·취소·탭을 떠나도 계속)·결과(must 유무 배너, 메타 줄, 리뷰 본문 요약·잘된 점 체크+편집, must→should→info 코멘트 카드: 코드 조각 ±3줄·편집·근거 보기·코드에서 보기→"← AI 리뷰로 돌아가기")·게시(split 버튼, 기본 = 필수 있으면 변경 요청, OS 확인창, 승인 경고, 체크한 것만, 게시됨 표시, 실패·422 표시)·다시 리뷰(전체; "새 커밋만"은 26d 준비 중 항목). 결과·편집·체크는 PR별 세션 캐시(`prai.ts`), 오래된 결과(head 바뀜) 안내. 탭 보조 글·목록 배지 연동. 한계: 422가 어느 줄인지 GitHub가 알려 주지 않으면 diff에서 못 찾은 줄만 표시, 결과는 앱을 끄면 사라짐(저장 안 함), 입력 200KB 초과는 Rust 오류 그대로, 코드 조각은 구문 강조 없음, 실제 AI 호출·게시는 e2e(mock)로만 검증.
- 26d 새 커밋만 다시 리뷰 (UI 완료, 사용자 확인 대기; Rust 변경 없음): "다시 리뷰 ▾"·오래된 결과 배너의 [새 커밋만 리뷰](기본)/[전체 다시 리뷰]. 입력 = PR 제목·본문 + 새 커밋 메시지 + `리뷰한 head..head` diff + "이전 리뷰" part(이미 지적한 것은 반복하지 말고 고쳐졌는지 판단하게 하는 지시는 part 라벨로). 결과는 "이번 커밋" 묶음 위·이전 카드는 "이전 리뷰" 묶음(접기)에 게시·편집·체크 유지, 줄이 바뀐 이전 카드는 "변경됨 — 다시 확인", 밀린 줄은 새 번호로, 새 head 변경 diff 밖이면 "게시 거부 위험"(체크 해제), 필수 수는 이번 + 미게시 이전 필수를 구분해 표시, 게시 commitId는 새 head. 진행 중엔 이전 결과가 그대로 보이고 취소·실패하면 그대로 복귀. 리뷰한 커밋이 로컬에 없거나(강제 푸시) 조상이 아니면 이유를 보이고 전체만. 탭 보조 글 "새 커밋 n"·개요 안내줄. 한계: 이전 라운드 요약은 읽기 전용으로만 남고 다시 게시할 수 없다, 밀린 줄 계산은 hunk 안에서 근사, 타임라인 100개를 넘으면 새 커밋 수를 못 센다(수 없이 표시), 실제 AI·게시는 e2e(mock)로만 검증.
- 26e 진행: 닫힌·머지된 PR 보기(검색창 옆 상태 선택)·목록 캐시(다시 열면 즉시)·목록 조회에서 타임라인 생략(`activity:false`, 사이드바 포함) 완료.
- 남은 것(순서대로): 26e 목록 보강(최근 활동 표시 — 켤 때 `activity:true`, 필터·숨김 안내, 새로고침 상태·자동 새로고침). 흡수하지 않음: `claude --resume` 이어가기(18단계 원칙), 여러 저장소 통합 목록.
- 한계: 목록 열린 PR 100개·타임라인 100·스레드 100(다음 페이지 안 따라감). fetch로 받은 PR 객체는 FETCH_HEAD로만 참조돼 gc prune 뒤 사라질 수 있다. outdated 스레드(line null)는 배지 개수에만. 실제 GitHub는 `gh api graphql`로 같은 쿼리를 확인(e2e는 mock).

## 25. diff 업그레이드 (완료)
- 25a 파일 이전/다음 (UI만): 커밋 상세·변경 화면 diff 영역 좌우 가장자리에 원형 ←/→ 버튼(툴팁 "이전 파일"/"다음 파일"), 단축키 ⌥←/⌥→(입력창 포커스 중 무시). 첫/마지막 파일이면 해당 버튼 숨김, 파일 1개면 둘 다 숨김. 이동하면 파일 목록 선택·스크롤도 같이 바뀐다. 변경 화면은 보고 있는 목록(스테이지 안 됨/됨) 안에서만 이동. 공통 컴포넌트 `shared/ui/FileNav.tsx`. 완료 기준: E2E(버튼·단축키·끝 경계·선택 동기화·입력창 무시), 리렌더링 테스트(그래프·사이드바·툴바 불변), 라이트/다크 스크린샷에 버튼 포함.
- 25b 이미지 diff (core `file_blob` + UI `ImageDiff` 구현 완료, 사용자 확인 대기): png/jpg/jpeg/gif/webp/bmp/ico/svg의 이전/이후를 나란히·슬라이더·겹쳐 보기·차이 4방식으로 비교. 머리줄에 W×H·용량·바뀐 픽셀 %·변경 영역, 변경 영역 점선 박스, 투명 체커보드, 확대는 pixelated. 한쪽만 있는 파일은 "없음". 완료 기준: E2E(`imagediff.spec.ts`: 4모드·% · 박스·새/삭제 파일·모드 저장·변경 화면·오류·svg), 리렌더링 테스트, 라이트/다크 스크린샷, 실제 앱 E2E(이미지 커밋→상세에서 비교).
- 25c xib/storyboard 시각 diff (UI 구현 완료, 사용자 확인 대기): `.xib`/`.storyboard`를 id 기준으로 비교해 뷰 추가·삭제·수정·이동과 제약 추가·삭제·수정·기준 변경을 이전/이후 캔버스(저장된 frame)와 변경 목록으로 보인다. 머리줄 "뷰어 / Raw"(저장)로 기존 텍스트 diff 전환, storyboard는 변경 있는 scene 선택, 목록 호버·클릭으로 뷰·제약 강조. 한계: 오토레이아웃 계산 없음(저장된 frame만), frame 없는 뷰는 목록에만, 커스텀 렌더 없음. Rust 변경 없음(25b `file_blob` 재사용). 완료 기준: E2E(`ibdiff.spec.ts`: 요약·범례·분류·세부 문구·강조·Raw 저장·scene 선택·오류), 리렌더링 테스트(목록 호버), 라이트/다크 스크린샷(`xib-*.png`), 실제 앱 E2E(xib 커밋→상세 뷰어·Raw).
- 25d AI 읽는 흐름 리뷰 (UI 구현 완료, 사용자 확인 대기): 변경을 읽는 순서로 묶어 단계별로 설명한다. 기존 AI 경로(`aiStart` → `gc_ai`)에 작업 `guide`만 추가(`AiGuide{overview, decision, steps, focus, apis, checks}`, 줄은 새 파일 기준, Rust가 diff에 없는 파일의 항목을 거른다). 오른쪽 패널(커밋 상세의 파일 목록 자리·변경 화면 목록 자리)에 "파일 / 읽는 흐름" 세그먼트(AI 꺼짐이면 숨김) → "가이드 만들기"(생성 중 스피너·취소, diff는 그대로) → 변경 개요·핵심 기술 결정(접힘)·읽는 흐름 "1 / N" 단계 카드·집중해서 볼 곳·API 설명 카드("정의 열기")·확인할 점 체크리스트. 단계 클릭·⌘]/⌘[(Ctrl)는 해당 파일 선택 + diff를 그 줄로 스크롤, ⌥⌘I(Alt+Ctrl+I)는 패널 열기·닫기(25a ⌥←/⌥→와 겹치지 않음). `DiffView`는 `notes`·`current`·`reveal` prop으로 거터 배지·범위 강조·인라인 설명 카드를 그린다(한 줄·나란히, 이미지·xib 뷰어 제외). 가이드는 대상(커밋 sha / 변경 화면 스테이지 diff 지문)별 세션 메모리 캐시. 진입점: 커밋 우클릭 "읽는 흐름 가이드"·빠른 실행. 한계: 브랜치 범위 대상은 보여 줄 diff 화면이 없어 미지원(키·캐시 구조는 대응 가능), 패널이 열려 있는 동안 커밋 상세는 제목·짧은 sha·작성자 한 줄만 남기고 파일 목록 자리에 패널을 보인다(파일 이동은 단계·FileNav), `e2e:app`은 실제 AI 호출(키·비용)을 하지 않아 가이드 생성은 mock E2E로만 검증. 완료 기준: E2E(`guide.spec.ts`: 섹션·단계 클릭·스크롤·⌘]/⌘[·⌥⌘I·API 정의 열기·AI 꺼짐·취소·오류·대상 변경·변경 화면·나란히), 리렌더링 테스트(단계 이동에서 그래프·사이드바·툴바 불변), 라이트/다크 스크린샷(`guide-*.png`).
- 25e diff 크게 보기·UI 다듬기 (완료; Rust는 `ignore_ws` 인자 하나): diff가 그래프(커밋 목록) 영역 전체를 덮고 사이드바는 접히고 오른쪽 상세 열(커밋 정보·파일/읽는 흐름 탭·파일 목록 / 변경 화면이면 두 목록+커밋 상자)은 세로 전체로 남는다 — 목록에서 파일을 바꾸면 덮은 diff가 바뀐다. 진입: diff 머리줄 확대 버튼("크게 보기")·커밋 상세 파일 더블클릭(VS Code 모드는 편집기 열기 유지, 변경 화면 더블클릭은 스테이지 유지라 버튼·단축키만)·⌘⇧↩(Ctrl+Shift+Enter, 입력창 무시; 커밋 상자 ⌘↩는 Shift가 있으면 커밋하지 않도록 조정). 종료: Esc(시트·메뉴가 열려 있으면 그쪽만)·X·⌘⇧↩, 저장소·선택 커밋이 바뀌면 자동. 그래프·사이드바는 언마운트하지 않고 숨겨 스크롤·선택을 유지하고(숨김 중 그리기 중단) 재조회·리렌더 없음. 공용 틀 `shared/model/bigview.ts`·`shared/ui/BigButton.tsx`·`shared/ui/DiffFrame.tsx`(PR 리뷰 화면이 같은 틀을 쓴다, docs/reuse.md). 도구줄(일반·크게 보기 공통, 좁으면 ⋯ 메뉴): Blame·히스토리(기존 inspect)·공백 무시(`-w`, 새 pref `ignoreWs`, 켜면 hunk 스테이지 끔)·줄바꿈(pref `diffWrap`)·이전/다음 변경 hunk(⌥↑/⌥↓)·한 줄/나란히. 이미지 diff·xib 뷰어는 넓어진 공간을 쓰고(xib 캔버스는 좁으면 이전/이후를 위아래로, 칩 겹침 없음 확인), 25d 가이드 패널·인라인 카드·FileNav·⌘]/⌘[는 그대로 동작. 한계: 크게 보기에서 상세 열 폭 조절 분할선은 숨김(저장된 폭 사용), 변경 화면 파일 더블클릭 진입 없음. 완료 기준: E2E(`bigview.spec.ts`: 진입 3종·종료·레이아웃·사이드바/그래프 복원·파일 교체·hunk 이동·공백 무시/줄바꿈 저장·⋯ 메뉴·가이드·이미지·xib), 리렌더링 테스트(`render.spec.ts`), 라이트/다크 스크린샷(`big-*.png`), 실제 앱 E2E(크게 보기 진입·종료), `cargo test`(`ignore_ws_hides_whitespace_only_changes`).
  - 25e 추가: 버튼은 아이콘+"크게 보기"(열림 중 "닫기 Esc", 좁으면 글자 숨김, 툴팁에 단축키), 머리줄 경로·파일 더블클릭·파일 우클릭 "크게 보기"·빠른 실행 "diff 크게 보기", 첫 사용 안내 말풍선 1회(localStorage `bigHint`). 나란히+줄바꿈 끔은 두 쪽이 같은 폭으로 가로 스크롤(`--cw`), 줄바꿈 켬은 칸 안 줄바꿈. 파일 히스토리·Blame·파일 보기 시트는 제목줄 크게 보기 버튼으로 시트 자체를 창 거의 전체로(저장 `inspectBig`, Esc는 먼저 축소, `DiffView bigCtl={null}`로 시트 안 diff엔 앱 크게 보기 버튼 없음), 히스토리 커밋 목록은 2줄(제목 / sha·작성자·날짜)+폭 스플리터(`split:history`). 25d 리렌더링 정리: 가이드 대상 키는 `diff --cached --raw` 지문(write-tree 제거), ImageDiff·IbDiff 머리·추가 요소 props 안정화, `guide.ts` 구독을 열림·대기·대상 키별로 분리.
- 후속: 커밋 목록 열 폭 조절·숨김 — 열 구성 브랜치/태그 | 그래프 | 설명 | 작성자 | 날짜 | 커밋, 경계 스플리터로 폭 조절·저장(더블클릭 = 기본/자동 폭), 그래프 열이 좁으면 레인 간격·노드 축소 후 오른쪽 페이드, 머리글 우클릭으로 열 숨김·"열 폭 초기화", 브랜치/태그 숨김 시 배지는 설명 앞 인라인 칩 (`e2e/columns.spec.ts`, `render.spec.ts`).
