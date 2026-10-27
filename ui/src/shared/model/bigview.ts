import { useSyncExternalStore } from "react";

// 크게 보기(25e): diff가 그래프 자리 전체를 덮고, 사이드바는 접히고, 오른쪽 상세 열은 그대로 남는다.
// 상태는 이 외부 스토어 하나이고 `<html data-big>`로 CSS가 레이아웃을 바꾼다(style.css "크게 보기").
// React 상태가 아니라서 진입·종료가 App·그래프·사이드바·툴바를 다시 그리지 않는다. 구독하는 건 버튼(`useBigView`)과 그래프(그리기 중단)뿐.
// 단축키(⌘⇧↩/Ctrl+Shift+Enter)·Esc는 app/main.tsx 전역 핸들러가 부른다. 같은 틀을 PR 리뷰 화면도 쓴다(docs/reuse.md).

let open = false;
let avail = false;
const subs = new Set<() => void>();
const set = (v: boolean) => {
  if (open === v) return;
  open = v;
  document.documentElement.toggleAttribute("data-big", v);
  subs.forEach((f) => f());
};
/** 변경 알림. 해제 함수를 돌려준다 */
const on = (f: () => void) => (subs.add(f), () => void subs.delete(f));

export const bigView = {
  get open() {
    return open;
  },
  /** 보여 줄 diff가 있을 때만 진입한다 (Details·ChangesView가 `setAvail`로 알림). force: 방금 그 파일을 골라 알림이 아직 안 왔을 때 */
  enter: (force?: boolean) => (force === true || avail) && set(true),
  exit: () => set(false),
  toggle: () => (open ? set(false) : bigView.enter()),
  /** 지금 화면에 크게 볼 diff(커밋 상세·변경 화면의 파일 diff)가 있는지 */
  get avail() {
    return avail;
  },
  setAvail: (v: boolean) => void (avail = v),
  /** 파일을 골랐을 때: 상세가 오른쪽 열(설정 detailLayout = right)이면 diff는 크게 보기로만 보이므로 연다 */
  picked: () => document.querySelector('.main[data-layout="right"]') && set(true),
  on,
};

export const useBigView = () => useSyncExternalStore(on, () => open);
