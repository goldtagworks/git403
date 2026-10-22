import { useEffect, useRef } from "react";
import { t, useLocale } from "../i18n/i18n";
import { Icon } from "./Icon";

/** 파일 경로 목록에서 현재 파일의 이전/다음 (목록에 없거나 이동할 곳이 없으면 undefined) */
export function neighbors(paths: string[], cur: string | null) {
  const i = cur === null ? -1 : paths.indexOf(cur);
  return i < 0 ? {} : { prev: paths[i - 1], next: paths[i + 1] };
}

/** diff 영역 좌우 가장자리의 원형 이전/다음 파일 버튼 + ⌥←/⌥→ (입력창 포커스 중엔 무시). 부모는 position: relative(.diff-wrap·.diff-pane). */
export function FileNav({ prev, next, go }: { prev?: string; next?: string; go: (path: string) => void }) {
  useLocale();
  const ref = useRef({ prev, next, go });
  ref.current = { prev, next, go };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]")) return;
      const { prev, next, go } = ref.current;
      const to = e.key === "ArrowLeft" ? prev : next;
      if (to === undefined) return;
      e.preventDefault();
      go(to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <>
      {prev !== undefined && (
        <button className="file-nav prev" title={t("diff.prevFile")} aria-label={t("diff.prevFile")} onClick={() => go(prev)}>
          <Icon name="chevronLeft" size={14} />
        </button>
      )}
      {next !== undefined && (
        <button className="file-nav next" title={t("diff.nextFile")} aria-label={t("diff.nextFile")} onClick={() => go(next)}>
          <Icon name="chevronRight" size={14} />
        </button>
      )}
    </>
  );
}

/** 선택 항목(aria-selected)이 목록 스크롤 밖이면 보이게 */
export const revealSelected = (root: HTMLElement | null) => void root?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
