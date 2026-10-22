---
name: roadmap-step
description: git403 로드맵 단계를 진행하거나 여러 모듈(Rust core + Tauri + UI)에 걸친 기능을 구현할 때 사용. "다음 단계 진행", "N단계 하자", "로드맵 이어서", "clone/서브모듈/worktree 같은 기능 추가", 단계 완료 확인·커밋 요청에 트리거.
---

# 로드맵 단계 진행

## 0. 트리아지
- 단일 파일·문구·스타일 수정 → 이 스킬 쓰지 말고 직접 고친다.
- git 작업·조회 하나 추가 → `add-git-op` 스킬.
- 단계 전체·여러 모듈 → 아래 진행.

## 1. 계획
`docs/roadmap.md`에서 단계 내용과 "알려진 한계"를 읽고, `docs/reuse.md`로 재사용 가능한 것을 확인한다.
필요한 core 함수·IPC 명령·UI 변경 목록을 사용자에게 짧게 보여주고 확인받는다.

## 2. 구현
- Rust 쪽은 `core-dev`, UI 쪽은 `ui-dev` 에이전트에 맡긴다. UI가 새 IPC에 의존하면 core-dev 먼저 끝낸 뒤 그 시그니처를 ui-dev에 넘긴다.
- 위임은 단계당 각 1회를 기본으로, 실패 수정까지 최대 2회. 작은 수정은 직접 한다.

## 3. 완료 기준 (docs/roadmap.md 공통 기준)
- `cargo test --workspace`, `pnpm --dir ui build`, `pnpm --dir ui e2e` 통과
- `docs/reuse.md` 갱신, 라이트/다크 스크린샷 확인 (`ui/e2e/screenshot.spec.ts`)
- `reviewer` 에이전트로 한 번 점검, 지적 사항 반영

## 4. 마무리
`docs/roadmap.md`의 상태·"이어서 하기"를 갱신하고, 결과를 보고해 사용자 확인을 받은 뒤 현재 브랜치(`main`)에 커밋한다. 사용자가 지시하지 않은 브랜치를 만들거나 옮기지 않는다.
앱을 직접 띄워 보여주지 않는다 — 사용자가 요청할 때만.
