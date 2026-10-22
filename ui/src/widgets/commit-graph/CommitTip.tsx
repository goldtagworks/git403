import { memo } from "react";
import { dateFmt, t, useLocale } from "../../shared/i18n/i18n";
import { useTip } from "../../shared/model/tip";
import { countRender } from "../../shared/lib/profile";

const FULL: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };
const W = 300;

/** compact 커밋 목록의 호버 카드. 스토어(`tip.ts`)만 구독한다 */
export const CommitTip = memo(function CommitTip() {
  useLocale();
  countRender("CommitTip");
  const tp = useTip();
  if (!tp) return null;
  const { c, info } = tp;
  const w = Math.min(W, innerWidth - 16);
  const left = Math.max(8, Math.min(tp.left + 8, innerWidth - w - 8));
  const below = tp.bottom + 200 < innerHeight || tp.top < 200; // 아래 공간이 모자라면 위로
  const style = below ? { left, width: w, top: tp.bottom + 4 } : { left, width: w, bottom: innerHeight - tp.top + 4 };
  return (
    <div className="ctip" role="tooltip" style={style}>
      <div className="ctip-who">{c.author} · {dateFmt(FULL).format(c.time * 1000)}</div>
      {info.files !== null && (
        <div className="ctip-stat">
          {t("details.changedFiles", { n: info.files })} · <span className="add">+{info.add}</span> <span className="del">−{info.del}</span>
        </div>
      )}
      <div className="ctip-msg selectable">{info.message || c.subject}</div>
    </div>
  );
});
