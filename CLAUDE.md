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
- 한 번에 로드맵 한 단계. 완료 기준 통과 + 사용자 확인 후 커밋.

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
