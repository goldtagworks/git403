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
| **외부 스토어 스냅숏은 저장된 참조나 원시값만 돌려준다** | `useSyncExternalStore(sub, getSnapshot)`은 참조가 바뀌면 "변경"으로 보고, 매번 새 참조면 무한 리렌더(크래시). `getSnapshot` 안에서 `?? []`·`?? {}`·`.filter`·`.map`·`{ ...x }` 금지 — 폴백은 밖에서 모듈 상수(`const NONE = []`), 변환은 `useMemo`. 계산이 필요하면 원시값(문자열·boolean·숫자)으로 돌려준다 (`useVisibleCount`·`aiSummary`가 문자열인 이유) |
| **구독 함수도 참조가 안정적이어야 한다** | `useSyncExternalStore(on(key), …)`처럼 렌더마다 새 함수를 넘기면 React가 렌더마다 구독을 풀고 다시 건다. 모듈 상수로 두거나 키별로 한 번만 만들어 캐시한다 (`prAi.on`·아바타 `onEmail`·`aichat`의 `onChats`) |
| **목록 항목은 자기 값만 구독한다** | 행마다 `useXxx(key)`로 그 행의 boolean만 구독하면 바뀐 행만 다시 그려진다 (`useRefPicked`·`useHiddenRef`·`useActive`). 목록 전체를 구독해 행에 props로 나눠 주지 않는다. 선택은 `Set`으로 O(1) 판단 |

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
  - AI 채팅 열(열기·닫기·스트림 이벤트·입력·끝난 뒤 새로고침)은 `CommitGraph`/`Sidebar`/`Details`/`Toolbar`/`StatusBar`를 다시 그리지 않는다(상태는 `aichat.ts` 외부 스토어, 입력 글자는 `ChatInput` 안, 상태바는 `useChatHidden` 불리언만 구독 — 열이 닫힌 채 진행 중일 때만 `AiChatStatusItem`이 다시 그려진다).
  - jj 보기(30d): 켜기·끄기·jj 상태 반영은 `CommitGraph`/`Sidebar`/`Details`/`Toolbar`를 다시 그리지 않고 표시가 있는 행만 다시 그린다(`jjview.ts` 외부 스토어, 행이 자기 커밋의 문자열 하나만 구독, 같은 상태는 구독자를 깨우지 않음).
  - jj 쓰기 작업(30e): 같은 행 우클릭 메뉴 열기·닫기와 설명 편집 시트 입력은 `CommitGraph`/`Sidebar`/`Toolbar`/`CommitRow`를 다시 그리지 않고(행의 `getMulti`는 안정적 ref 콜백), 변경 화면의 파일 체크는 `CommitGraph`/`Sidebar`/`Details`/`Toolbar`/`StatusBar`를 다시 그리지 않는다(체크 상태는 `ChangesView` 안).
  - jj 30f: 작업 기록·북마크·jj 끄기 시트(열기·더 보기·phase 전환·닫기)와 버려진 늦은 응답은 `CommitGraph`/`Sidebar`/`Details`/`Toolbar`/`StatusBar`를 다시 그리지 않고(시트 상태는 `JjHost` 안, 요청 번호로 늦은 응답 폐기), 같은 내용의 작업 기록 재조회는 `OpRow`(memo, 같은 id·내용은 이전 객체 재사용)를 다시 그리지 않는다. `JjUndo` 툴바 버튼은 `useJjOn`(boolean)만 구독해 jj 보기 토글로 나타나도 `Toolbar`는 그대로(30d 테스트가 함께 확인). undo·복원 진행은 ops 모듈 플래그(React state 아님).
  - 목록 행 memo(`FolderRow`·`ChangeItem`·`FileItem`): 사이드바 폴더 접기·펼치기는 그 폴더 행 하나만, 변경 화면·커밋 상세에서 파일을 바꿔 고르면 선택이 바뀐 두 행만 다시 그린다(안정 콜백 + `nodeKey`·`active`·`checked` 불리언 props). 그래프 `Row`는 refs를 우클릭 때 ref로 읽고 내용이 같은 ref 칩은 이전 객체를 재사용해, refs가 새 배열로 와도 바뀐 행만 다시 그린다.
- 리뷰할 때 확인할 것: 새 `useState`가 App 같은 상위 컴포넌트에 생기는지, 그 값이 얼마나 자주 바뀌는지.

## 4. 번들과 의존성

- 의존성을 추가하기 전에 크기를 확인한다. 아이콘은 필요한 것만 뽑아 쓴다(`pnpm icons`, 전체 세트 번들 금지).
- 상태 관리 라이브러리, UI 컴포넌트 키트는 들이지 않는다. 필요해지면 이 문서에 이유를 적고 추가한다.
- `highlight.js`(diff 구문 강조): 직접 토크나이저를 짜는 것보다 언어별 정확도가 높고, 코어 + 14개 언어만 등록해(`ui/src/shared/lib/hl.ts`) **동적 import 청크 하나(81 kB, gzip 26 kB)** 로 분리했다. 첫 로드 번들(`index`)은 +6 kB(gzip +2 kB, DiffView 본체)뿐이고 강조 청크는 diff에서 강조 가능한 확장자를 처음 볼 때만 받는다. 언어를 더하면 이 크기를 다시 적는다.
- 큰 diff: 구문 강조는 6000줄 이하에서만, hunk 단위로 쪼개 돌린다. 줄은 처음 2000줄만 그리고 끝에 닿으면(IntersectionObserver) 더 그린다. 줄 행은 `memo`, 클릭은 이벤트 위임이라 줄 고르기가 해당 줄만 다시 그린다.
- 언어 사전 지연 로드(i18n): `en`만 정적으로 번들하고 나머지 22개 언어는 `import.meta.glob`으로 언어별 청크(각 90~166 kB, gzip 30~36 kB)로 나눈다. 첫 번들(`index`)은 3,357 kB(gzip 967 kB) → 809 kB(gzip 269 kB). 시작할 때 현재 언어 청크 하나만 받고(top-level await로 첫 렌더 전에 완료 — 영어가 먼저 깜빡이지 않는다), 언어를 바꾸면 청크를 받은 뒤 한 번에 갈아끼우고 구독자를 깨운다. `t()`는 동기다.
- 코드 스플리팅(열 때만 쓰는 큰 화면): `main.tsx`가 `AiHost`·`AiChatHost`·`HostingHost`·`PrReviewHost`·`JjHost`·`SettingsHost`·`MobileShell`을 `React.lazy` + `Suspense fallback={null}`로 불러온다. 호스트는 항상 마운트돼 첫 렌더 직후 청크를 받으므로(열 때 기다리지 않고, 호스트는 닫혀 있을 때 아무것도 그리지 않아 깜빡임·애니메이션 변화 없음) 열 때는 이미 준비돼 있다. 데스크탑은 `MobileShell`을, 모바일·VS Code compact는 `JjHost`를 받지 않는다. 청크는 호스트 모듈만 단독 import하는 곳이 `main.tsx`뿐일 때 갈린다 — 그래서 `AutoFetch`는 `widgets/settings/AutoFetch.tsx`로 뺐고, `RebaseHost`·`RewordHost`·`InspectorHost`는 같은 모듈의 열기 함수를 `CommitGraph`·`Details` 등이 직접 import해 갈리지 않는다. `markdown-it`은 PR·AI 화면에서만 쓰는 `Markdown`과 함께 청크(`Markdown` 109.5 kB, gzip 48.7 kB)로 빠져, 그 화면을 불러올 때 같이 받는다(렌더는 동기라 깜빡임 없음). 청크 크기: `PrReview` 62.6 kB(gzip 19.8), `SettingsSheet` 29.8 kB(8.9), `MobileShell` 14.8 kB(4.5), `JjSheets` 10.7 kB(3.4), `HostingSheets` 10.1 kB(3.5), `AiSheets` 6.9 kB(2.5), `AiChat` 6.6 kB(2.6). 첫 로드 JS(index + modulepreload 합계)는 약 836 kB(gzip ≈ 280 kB) → 581.8 kB(gzip 191 kB). 새 큰 화면을 만들면 호스트를 lazy로 두고 이 크기를 다시 적는다.
- AI 채팅 스트리밍 글 조각은 상태는 바로 갱신하고 화면 갱신(마크다운 재파싱)만 프레임당 한 번으로 묶는다(`aichat.ts` `putText`). 그래프의 아바타 로드 재그리기도 `requestDraw`(rAF 합치기)를 쓴다.
