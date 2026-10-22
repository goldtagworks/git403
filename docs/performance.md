# 성능 지침

이 앱의 존재 이유는 **가볍고 빠르고 멈추지 않는 것**이다. UI 코드를 쓰거나 리뷰할 때 이 문서를 따른다.
여기 규칙을 어기는 변경은 기능이 맞아도 되돌린다.

## 1. 무거운 작업은 Rust에서

- git 실행, 로그 파싱, 그래프 레이아웃, diff 계산은 전부 Rust(`crates/*`)에서 한다. JS에서 반복문으로 커밋을 가공하지 않는다.
- Tauri 명령은 `async`로 만들어 UI 스레드를 막지 않는다. 오래 걸리는 작업은 `start_job` + 이벤트로 한다 (docs/reuse.md).

## 2. React 리렌더링 규칙

| 규칙 | 이유 / 예 |
|---|---|
| 큰 컴포넌트(`CommitGraph`, `Sidebar`, `Details`, `StatusBar`)는 `memo`로 감싼다 | 부모 상태가 바뀌어도 props가 같으면 건너뛴다 |
| 이런 컴포넌트에 넘기는 props는 **참조가 안정적**이어야 한다 | 콜백은 `setState` 그대로 넘기거나 `useCallback`. 렌더 중에 `{}`·`[]`·화살표 함수를 새로 만들어 넘기지 않는다 |
| **자주 오는 이벤트는 그걸 보여주는 컴포넌트만 구독한다** | 진행률(`job` 이벤트)은 `StatusBar`만 듣는다. App이 들으면 진행률마다 화면 전체가 다시 그려진다 |
| 드래그·스크롤처럼 프레임마다 바뀌는 값은 React 상태에 넣지 않는다 | 스플리터는 드래그 중 DOM style만 고치고, 놓을 때 한 번 `setState` (`Splitter.tsx`) |
| 같은 값으로 `setState`를 부르지 않는다 | 같은 값이어도 한 번 더 렌더링될 수 있다. `ResizeObserver`는 높이가 실제로 바뀔 때만 반영 (`CommitGraph.tsx`) |
| 파생 데이터는 `useMemo` | 트리 만들기(`buildTree`, `toTree`), 커밋별 ref 맵 등. 렌더마다 다시 계산하지 않는다 |
| 긴 목록은 보이는 행만 그린다 | 커밋 목록은 가상 스크롤 + Canvas. 수만 행을 DOM으로 만들지 않는다 |
| Context는 자주 바뀌는 값에 쓰지 않는다 | Context 값이 바뀌면 구독하는 모든 컴포넌트가 다시 그려진다 |

## 3. 측정과 회귀 방지

- 무거운 컴포넌트 첫 줄에 `countRender("이름")`(`ui/src/shared/lib/profile.ts`)을 둔다. 데모·E2E(`VITE_MOCK`)에서만 횟수를 세고, 실제 빌드에서는 아무것도 하지 않는다.
- `ui/e2e/render.spec.ts`가 다음을 검증한다. 새 기능이 자주 바뀌는 상태를 만들면 여기에 테스트를 추가한다.
  - 작업 진행률 이벤트 동안 `CommitGraph`/`Sidebar`/`Details` 렌더 횟수가 늘지 않는다.
  - 스플리터 드래그 중에는 렌더 횟수가 늘지 않는다.
  - 설정 창 열기·탭 이동·입력은 `CommitGraph`/`Sidebar`/`Details`/`Toolbar`를 다시 그리지 않는다(입력 상태는 각 탭 안에만 둔다).
  - AI(리뷰 시트 열기·대기·결과, 설정 AI 탭 입력)는 `CommitGraph`/`Sidebar`/`Details`/`Toolbar`를 다시 그리지 않는다(`AiHost`·`AiPanel`·커밋 상자 자체 상태, 사용 가능 여부는 `useAiOn`만 구독).
  - 상태바 AI 항목(공급자 전환·설정에서 방식 변경·저장소별 끄기)은 그 항목만 다시 그리고 `CommitGraph`/`Sidebar`/`Details`/`Toolbar`/`StatusBar`는 건드리지 않는다(`useAiSig` 지문 구독, 바뀔 때만 `aiBus.emit`).
  - 토스트(뜨기·합치기·자세히·닫기·자동 사라짐)는 `CommitGraph`/`Sidebar`/`Details`/`Toolbar`를 다시 그리지 않는다(`toast.ts` 외부 스토어를 `Toasts`만 구독, 타이머는 카드 안).
  - 커밋 목록 열 폭 드래그(그래프·작성자·날짜)는 `CommitGraph`·`CommitRow`를 다시 그리지 않고(CSS 변수·Canvas만), 열 숨김 토글은 `Sidebar`/`Details`/`Toolbar`를 다시 그리지 않는다.
  - 그래프 검색 입력은 `CommitGraph`만, 사이드바 필터 입력은 `Sidebar`만, 브랜치 팝오버(열기·입력·닫기)는 아무것도 다시 그리지 않는다(상태는 각 컴포넌트 안).
  - 그래프 스크롤은 같은 10행 구간 안에서 `CommitGraph` 렌더 0(scrollTop은 DOM에서 읽고 Canvas는 rAF로 직접 그림), 브랜치/태그 열 스플리터 드래그도 렌더 0(`useSplit` `onMove` → CSS 변수 `--ref-w` + Canvas rAF).
  - 크게 보기(25e): 진입·종료·hunk 이동·줄바꿈 토글은 `CommitGraph`/`Sidebar`/`Details`/`Toolbar`/`StatusBar`를 다시 그리지 않고 `load_graph`도 다시 부르지 않는다(상태는 `bigview.ts` 외부 스토어 + `<html data-big>` CSS, 그래프·사이드바는 언마운트하지 않고 숨기며 숨김 중 Canvas는 그리지 않는다).
  - 상태바 항목(`GhStatusItem`·`AiStatusItem`은 memo): 진행률 이벤트 동안 둘 다 렌더 0. gh 재조회(창 포커스·원격 작업 완료)는 값이 같으면 렌더 0, 바뀌어도 `GhStatusItem`만 그리고 작업 자체의 렌더 증가분과 같다. gh 전환·연결은 낙관적 갱신(`gh.switchTo`·`bindTo`)이라 응답을 기다리지 않는다.
  - AI 공급자 전환(상태바 메뉴·설정)은 사용 가능 여부(`useAiOn` 값)가 그대로면 `CommitGraph`/`Sidebar`/`Details`/`Toolbar`/`StatusBar`/`ChangesView`를 다시 그리지 않는다(`useSyncExternalStore` 값이 같으면 건너뜀).
  - 설정 가져오기에서 언어가 같은 파일은 렌더 횟수를 늘리지 않는다(`onPrefs`가 언어 불변이면 구독자를 깨우지 않음).
  - PR sha 호버 카드: 카드가 뜨는 순간과 같은 sha 위 재호버는 `PrReview`·`PrPopupHost`·`Popup`(팝업 본체)·그래프·사이드바·상세·툴바·상태바를 다시 그리지 않는다(`ShaCard`만 구독, 같은 sha 카드가 떠 있으면 `prSha.hover`가 무시).
  - 로컬 변경사항 넓게 보기를 끄면(← 그래프로) `CommitGraph`/`Sidebar`를 다시 그리지 않는다.
- 리뷰할 때 확인할 것: 새 `useState`가 App 같은 상위 컴포넌트에 생기는지, 그 값이 얼마나 자주 바뀌는지.

## 4. 번들과 의존성

- 의존성을 추가하기 전에 크기를 확인한다. 아이콘은 필요한 것만 뽑아 쓴다(`pnpm icons`, 전체 세트 번들 금지).
- 상태 관리 라이브러리, UI 컴포넌트 키트는 들이지 않는다. 필요해지면 이 문서에 이유를 적고 추가한다.
- `highlight.js`(diff 구문 강조): 직접 토크나이저를 짜는 것보다 언어별 정확도가 높고, 코어 + 14개 언어만 등록해(`ui/src/shared/lib/hl.ts`) **동적 import 청크 하나(81 kB, gzip 26 kB)** 로 분리했다. 첫 로드 번들(`index`)은 +6 kB(gzip +2 kB, DiffView 본체)뿐이고 강조 청크는 diff에서 강조 가능한 확장자를 처음 볼 때만 받는다. 언어를 더하면 이 크기를 다시 적는다.
- 큰 diff: 구문 강조는 6000줄 이하에서만, hunk 단위로 쪼개 돌린다. 줄은 처음 2000줄만 그리고 끝에 닿으면(IntersectionObserver) 더 그린다. 줄 행은 `memo`, 클릭은 이벤트 위임이라 줄 고르기가 해당 줄만 다시 그린다.
