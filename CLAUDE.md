# git403

기능을 두루 갖춘 가볍고 빠른 크로스플랫폼 git 클라이언트.
스택: Tauri 2 + Rust(`crates/core`, `crates/graph`) + React/Canvas(`ui`). 답변·문서·커밋 메시지는 한국어.

## 먼저 읽을 문서 (규칙의 원본 — 여기엔 복제하지 않는다)

1. `docs/roadmap.md` — 현재 단계, 다음 할 일, 단계 완료 기준
2. `docs/reuse.md` — 재사용 모듈·IPC 목록. 새 코드 쓰기 전에 확인, 바꾸면 갱신
3. `docs/performance.md` — React 리렌더링 규칙
4. `docs/design.md` — 디자인 규칙 (라이트/다크 필수, native-feel)

## 지켜야 할 것

- 코드는 최소로. 기존 모듈로 되면 새로 쓰지 않는다.
- 기능이 갖춰지기 전에 앱을 띄워 데모하지 않는다. 검증은 테스트로.
- 한 번에 로드맵 한 단계. 테스트를 통과한 단위마다 중간 커밋·푸시한다(에이전트가 고치는 중인 파일은 빼고).
- 잔여 이슈를 남기지 않는다. 확인 중 찾은 문제는 사소해도 그 단계 안에서 고친다("한계" 목록으로 미루지 않음).
- 로드맵에 이미 정해진 설계는 다시 묻지 않는다. 예: Android git은 순수 gix(push 포함) — libgit2·git 번들 같은 대안 제안 금지.
- 커밋·푸시 계정은 goldtagworks(`gh auth switch -u goldtagworks`로 푸시 후 원래 계정으로 되돌림).
- Android 확인은 에뮬레이터(폰·태블릿 AVD, 없으면 `avdmanager`로 생성)와 디버그 APK로. 빌드 명령은 `docs/reuse.md` Android 절.

## 확인 명령

- `cargo test --workspace`
- `pnpm --dir ui build` (타입 검사)
- `pnpm --dir ui e2e` (mock E2E·리렌더링·라이트/다크 스크린샷)
- `pnpm --dir ui e2e:app` (**실제 앱** E2E: 디버그 빌드를 임시 저장소로 띄워 진짜 IPC·git으로 검증. 완료 보고 전 필수)
- `pnpm --dir ui e2e:native` (macOS: 네이티브 메뉴·askpass·키체인·외부 도구·로그인 PATH·업데이트. OS 연동을 건드렸을 때)

## 하네스

- 로드맵 단계 진행·여러 모듈에 걸친 기능 → `roadmap-step` 스킬 (core-dev / ui-dev / reviewer 에이전트)
- 새 git 작업·조회 하나 추가 → `add-git-op` 스킬
- 문구·스타일 한 줄 같은 단일 파일 수정은 스킬 없이 직접 고친다.

변경 이력
- 2026-10-19: 하네스 최초 구성 (에이전트 3, 스킬 2)
- 2026-10-31: 작업 원칙 추가(중간 커밋·잔여 이슈 금지·정해진 설계 재질문 금지·커밋 계정·Android 확인)
