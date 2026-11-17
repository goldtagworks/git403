import { memo } from "react";
import { t, useLocale } from "../../shared/i18n/i18n";
import { Icon } from "../../shared/ui/Icon";
import { ops } from "../../shared/model/ops";
import { useJjOn } from "../../shared/lib/jjview";
import { isMac } from "../../shared/lib/platform";

/** jj 보기일 때만 보이는 "되돌리기" 툴바 버튼. jj 보기 여부(boolean)만 구독해 Toolbar를 다시 그리지 않는다. 중복 실행 방지는 `ops.jjUndo`의 플래그 */
export const JjUndo = memo(function JjUndo({ repo }: { repo: string }) {
  useLocale();
  if (!useJjOn(repo)) return null;
  const tip = `${t("toolbar.jjUndo")} (${isMac ? "⌘⌥Z" : "Ctrl+Alt+Z"})`;
  return (
    <div className="tool jj-undo">
      <button className="tool-btn" aria-label={t("toolbar.jjUndo")} title={tip} onClick={() => void ops.jjUndo()}>
        <span className="tool-icon"><Icon name="undo" size={20} /></span>
        <span className="tool-label">{t("toolbar.jjUndo")}</span>
      </button>
    </div>
  );
});
