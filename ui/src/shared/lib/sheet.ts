/** 시트(dialog)의 ref. 열릴 때 시트 안에 포커스가 없으면 시트 자체에 준다 (Escape가 시트 안 어디서든 backdrop의 onKeyDown에 닿게). tabIndex={-1}과 함께 쓴다.
 *  포커스된 버튼이 눌린 뒤 disabled가 되면 포커스가 body로 빠져 Escape가 시트에 닿지 않으므로, 그때도 시트로 되돌린다. */
const kept = new WeakSet<HTMLElement>();
export const focusSheet = (el: HTMLElement | null) => {
  if (!el) return;
  if (!el.contains(document.activeElement)) el.focus();
  if (kept.has(el)) return;
  kept.add(el);
  el.addEventListener("focusout", (e) => {
    if (e.relatedTarget) return; // 다른 요소로 옮긴 포커스는 그대로
    queueMicrotask(() => {
      if (el.isConnected && (document.activeElement === document.body || !document.activeElement)) el.focus();
    });
  });
};
