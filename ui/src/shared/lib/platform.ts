import { useSyncExternalStore } from "react";

export const isWin = /Windows/i.test(navigator.userAgent), isMac = /Mac/i.test(navigator.userAgent);

// ---- 모바일(Android 폰·태블릿) ----
// 판정은 여기 한 곳: WebView의 User-Agent에 Android가 있으면 모바일. 동기 값이라 첫 렌더부터 쓰고(IPC 응답을 기다리지 않는다),
// 데스크탑·VS Code 웹뷰는 항상 false라서 아래 코드는 아무것도 구독·설치하지 않는다. 목업 E2E는 Playwright `userAgent`로 켠다.
export const isMobile = /Android/i.test(navigator.userAgent);
/** 이 폭(px) 이상이면 태블릿(두 칸), 아래면 폰(한 화면에 한 가지) — widgets/mobile/MobileShell.tsx */
export const TABLET = 600;

const wideQuery = isMobile ? matchMedia(`(min-width: ${TABLET}px)`) : null;
const onWide = (f: () => void) => (wideQuery?.addEventListener("change", f), () => wideQuery?.removeEventListener("change", f));
/** 모바일의 태블릿 폭 여부. 폭이 경계를 넘을 때만 바뀐다 (데스크탑은 항상 false, 구독 없음) */
export const useTablet = () => useSyncExternalStore(onWide, () => !!wideQuery?.matches);

/** 모바일 시작 때 한 번: `<html data-mobile>`(CSS 범위), 길게 누르기 → 우클릭 메뉴 */
export function initMobile() {
  if (!isMobile) return;
  const html = document.documentElement;
  html.setAttribute("data-mobile", "");
  const HOLD = 500, SLOP = 10;
  let timer = 0, x = 0, y = 0, touching = false, fired = false;
  const stop = () => (clearTimeout(timer), (touching = false));
  // 입력란·선택 가능한 글자는 OS의 선택 메뉴에 맡긴다
  const native = (e: Event) => !!(e.target as Element | null)?.closest?.("input, textarea, select, .selectable");
  addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch" || !e.isPrimary) return;
    touching = true;
    fired = false;
    x = e.clientX;
    y = e.clientY;
    if (native(e)) return;
    const target = e.target as Element;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      fired = true;
      target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }));
    }, HOLD);
  }, true);
  addEventListener("pointermove", (e) => Math.hypot(e.clientX - x, e.clientY - y) > SLOP && clearTimeout(timer), true);
  for (const ev of ["pointerup", "pointercancel"]) addEventListener(ev, stop, true);
  // WebView가 길게 누르기에 자체로 내는 contextmenu(isTrusted)는 막는다 — 위에서 만든 한 번만 메뉴를 연다
  addEventListener("contextmenu", (e) => { if (e.isTrusted && touching && !native(e)) (e.preventDefault(), e.stopImmediatePropagation()); }, true);
  // 길게 누른 뒤 손을 뗄 때의 클릭은 삼킨다
  addEventListener("click", (e) => { if (fired) (fired = false, e.preventDefault(), e.stopPropagation()); }, true);
}
