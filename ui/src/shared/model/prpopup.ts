import { useSyncExternalStore } from "react";

// PR 본문·리뷰·코멘트 팝업(26)의 열림 상태. prreview.ts처럼 외부 스토어라 열기·이동·닫기는 `PrPopupHost`만 다시 그린다
// (PR 화면·그래프·사이드바·툴바는 그대로). 화면이 닫히면 Host가 사라지며 같이 닫힌다.

export interface PopItem {
  author: string;
  avatar?: string;
  /** 종류 글자: 본문 · 리뷰 상태 · 코멘트 */
  kind: string;
  /** 배지 색(`prr-badge` 변형: ok·warn·info·"") */
  cls?: string;
  at: string;
  body: string;
  /** 스레드 코멘트면 `경로:줄` */
  where?: string;
  /** 닫을 때 포커스를 돌려줄 항목의 `data-pop` 값(없으면 연 요소) */
  ref?: string;
}
type S = { items: PopItem[]; i: number; /** 다시 열 때 본문 스크롤 위치 */ scroll?: number } | null;
let s: S = null;
let trigger: HTMLElement | null = null;
const subs = new Set<() => void>();
const set = (n: S) => ((s = n), subs.forEach((f) => f()));

export const prPopup = {
  /** 연 요소를 기억해 두었다가 닫을 때 포커스를 돌려준다 */
  open: (items: PopItem[], i = 0, scroll?: number) => {
    if (!items.length) return;
    if (!s) trigger = document.activeElement as HTMLElement | null;
    set({ items, i: Math.max(0, Math.min(items.length - 1, i)), scroll });
  },
  go: (i: number) => s && i >= 0 && i < s.items.length && i !== s.i && set({ items: s.items, i }),
  /** restore=false: 화면이 사라지는 중이라 포커스를 옮기지 않는다 */
  close: (restore = true) => {
    if (!s) return;
    const ref = s.items[s.i].ref;
    set(null);
    if (!restore) return;
    const el = (ref && document.querySelector<HTMLElement>(`[data-pop="${ref}"]`)) || trigger;
    trigger = null;
    if (el?.isConnected) el.focus();
  },
  on: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
  get: () => s,
};

export const usePrPopup = () => useSyncExternalStore(prPopup.on, prPopup.get);
