---
name: add-git-op
description: git403에 새 git 작업(브랜치·태그·스태시·원격 조작 등) 또는 새 조회를 하나 추가할 때 사용. "X 기능 추가", "git X 명령 붙여줘", "우클릭 메뉴에 X", "툴바에 X 버튼" 요청에 트리거.
---

# git 작업 하나 추가

먼저 `docs/reuse.md`에서 이미 있는 core 함수·IPC·ops 항목으로 되는지 확인한다. 되면 연결만 한다.

## 조회 (데이터를 읽어 화면에 보여줌)
1. `crates/core/src/{명령}.rs` — `GitRunner::output` + 파서 + 파서 단위 테스트
2. `src-tauri/src/lib.rs` — `async` Tauri 명령으로 노출
3. `ui/src/shared/api/api.ts` + `ui/src/shared/api/mock.ts` — 호출 함수와 mock 데이터
4. `docs/reuse.md` 갱신

## 작업 (저장소를 바꿈)
1. 짧은 명령은 `GitRunner::output`, 원격·긴 작업은 기존 `start_job`(진행률 이벤트) 경로를 쓴다.
2. `ui/src/shared/model/ops.ts`에 작업 하나 등록 → 툴바·우클릭 메뉴·빠른 실행이 같이 쓴다. 입력이 필요하면 기존 `ui/src/shared/ui/prompt.tsx` 시트를 쓴다.
3. mock에 동작을 추가하고 `ui/e2e/app.spec.ts`에 테스트 하나.
4. `docs/reuse.md` 갱신

## 확인
`cargo test --workspace` · `pnpm --dir ui build` · `pnpm --dir ui e2e`. 성공은 한 줄로, 실패만 자세히 보고.
