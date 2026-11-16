import { t } from "../i18n/i18n";
import { supports } from "../lib/caps";
import type { Commit } from "../api/types";
import { ctx, ops } from "./ops";

// 커밋 행 드래그 → 현재 브랜치에 cherry-pick. 포인터 이벤트로 직접 구현한다(HTML5 DnD는 WebView·터치에서 불안정, 탭 이동과 같은 방식).
// 드롭 대상은 `data-drop="head"`(현재 브랜치 사이드바 항목·그래프의 HEAD 행) 또는 `data-drop="no"`(그 밖의 브랜치·행 → 불가 표시).
// 드래그 중 바뀌는 건 전부 DOM(유령 요소·클래스·`<html data-dnd>`)이라 React 렌더링이 없다.
const THRESHOLD = 5;
let busy = false;

export const dnd = {
  /** 커밋 행의 pointerdown에서 부른다. `commits`는 최신순(그래프 순서). 5px 안 움직이고 놓으면 `onClick`(다중 선택 행의 클릭 처리)을 부른다 */
  begin(e: PointerEvent, commits: Commit[], onClick?: () => void) {
    if (busy || e.button !== 0 || !commits.length || !supports("cherry-pick")) return;
    busy = true;
    const root = document.documentElement;
    const [x0, y0] = [e.clientX, e.clientY];
    let ghost: HTMLElement | null = null;
    let over: HTMLElement | null = null;
    const mark = (el: HTMLElement | null) => {
      over?.classList.remove("drop-ok", "drop-no");
      over = el;
      const ok = el?.dataset.drop === "head";
      el?.classList.add(ok ? "drop-ok" : "drop-no");
      root.dataset.dnd = !el ? "drag" : ok ? "ok" : "no";
      ghost?.classList.toggle("no", !!el && !ok);
    };
    const move = (m: PointerEvent) => {
      if (!ghost) {
        if (Math.hypot(m.clientX - x0, m.clientY - y0) < THRESHOLD) return;
        ghost = document.createElement("div");
        ghost.className = "dnd-ghost";
        ghost.textContent = commits.length === 1 ? commits[0].subject : t("dnd.commits", { n: commits.length });
        document.body.appendChild(ghost);
        root.dataset.dnd = "drag";
        getSelection()?.removeAllRanges();
      }
      ghost.style.transform = `translate(${m.clientX + 14}px, ${m.clientY + 14}px)`;
      const el = document.elementFromPoint(m.clientX, m.clientY)?.closest<HTMLElement>("[data-drop]") ?? null;
      if (el !== over) mark(el);
    };
    const finish = (drop: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key, true);
      const target = over?.dataset.drop;
      over?.classList.remove("drop-ok", "drop-no");
      ghost?.remove();
      delete root.dataset.dnd;
      busy = false;
      if (!drop) return;
      if (!ghost) return onClick?.();
      if (target === "head") void ops.cherryPickMany(commits);
      else if (target === "no") ctx.notify(t("dnd.onlyHead", { branch: ops.head() ?? "HEAD" }), { kind: "info" });
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const key = (k: KeyboardEvent) => k.key === "Escape" && (k.preventDefault(), k.stopPropagation(), finish(false));
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
  },
};
