// ⌘W(Ctrl+W)·창 닫기 요청을 팝업 닫기로 돌린다: 열린 시트·메뉴·팝오버·PR 리뷰·크게 보기가 있으면 맨 위 하나에 Esc를 보낸다.
// 각 화면의 기존 Esc 처리(시트 onKeyDown·capture 리스너)를 그대로 쓰므로 닫는 규칙은 Esc와 같다.

const LAYER = '.sheet-backdrop, .dom-menu-backdrop, [role="dialog"], [role="menu"]';

/** 닫을 팝업이 있으면 Esc를 보내고 true, 없으면 false (호출 쪽이 창을 닫는다) */
export function dismissTop(): boolean {
  const layers = document.querySelectorAll<HTMLElement>(LAYER);
  const top = layers[layers.length - 1];
  if (!top && !document.querySelector(".prr") && !document.documentElement.hasAttribute("data-big")) return false;
  let el = document.activeElement as HTMLElement | null;
  if (top) el = el && top.contains(el) ? el : top;
  else if (el?.closest("input, textarea, select, [contenteditable]")) (el.blur(), (el = null)); // 입력창 Esc는 포커스만 풀므로 본문에서 보낸다
  (el ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  return true;
}
