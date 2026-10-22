import { useEffect, useState } from "react";
import { t, useLocale } from "../i18n/i18n";
import { bigView, useBigView } from "../model/bigview";
import { isMac } from "../lib/platform";
import { Icon } from "./Icon";

const SEEN = "bigHint";
const seen = () => {
  try {
    return localStorage.getItem(SEEN) === "1";
  } catch {
    return false;
  }
};
const markSeen = () => {
  try {
    localStorage.setItem(SEEN, "1");
  } catch {}
};
// 한 번이라도 크게 보기를 쓰면(어떤 경로든) 안내는 다시 뜨지 않는다
bigView.on(() => bigView.open && markSeen());

/** 앱 전체 크게 보기 대신 다른 곳(예: 파일 히스토리 시트)이 자기 상태로 쓰는 제어 */
export interface BigCtl { big: boolean; toggle: () => void; /** 열린 상태의 글자·툴팁·아이콘(기본: 크게 보기 닫기) */ restore?: boolean; /** 팝업 등 diff가 아닌 곳: "크게 보기"/"원래 크기" 글자만(Esc 표시·첫 사용 안내·단축키 안내 없음) */ plain?: boolean }

export const BIG_KEYS = isMac ? "⌘⇧↩" : "Ctrl+Shift+Enter";

/**
 * diff 머리줄의 크게 보기 진입(아이콘+"크게 보기")·종료("닫기 Esc") 버튼. 일반 diff·이미지·xib 머리줄이 모두 넣고, 머리줄이 좁으면 글자는 숨는다.
 * 처음 diff를 열었을 때 한 번만 버튼 아래에 작은 안내 말풍선을 보인다(닫거나 한 번 쓰면 다시 안 뜸, localStorage).
 */
export function BigButton({ ctl }: { ctl?: BigCtl }) {
  useLocale();
  const global = useBigView();
  const big = ctl ? ctl.big : global;
  const toggle = ctl ? ctl.toggle : bigView.toggle;
  const [hint, setHint] = useState(() => !seen());
  useEffect(() => void (big && setHint(false)), [big]);
  const restore = !!ctl?.restore; // 시트: "닫기"가 시트 닫기와 헷갈리지 않게 "원래 크기"
  const plain = !!ctl?.plain;
  const tip = plain ? t(big ? "diff.bigRestore" : "diff.big") : big ? t(restore ? "diff.bigRestoreTip" : "diff.bigClose") : t("diff.bigTip", { key: BIG_KEYS });
  return (
    <span className="big-wrap">
      <button className="tool-txt big-btn" title={tip} aria-label={plain ? tip : big ? t(restore ? "diff.bigRestoreTip" : "diff.bigClose") : t("diff.big")} onClick={() => (markSeen(), toggle())}>
        <Icon name={big ? (restore ? "shrink" : "dismiss") : "expand"} size={14} />
        <span className="big-label">{big ? t(restore ? "diff.bigRestore" : "diff.bigCloseLabel") : t("diff.big")}</span>
        {big && !plain && <kbd className="big-kbd">Esc</kbd>}
      </button>
      {hint && !big && !plain && (
        <span className="big-hint" role="note">
          {t("diff.bigHint")}
          <button className="tool-ico" aria-label={t("diff.bigHintClose")} onClick={() => (markSeen(), setHint(false))}><Icon name="dismiss" size={12} /></button>
        </span>
      )}
    </span>
  );
}
