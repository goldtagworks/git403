import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { countRender } from "../../shared/lib/profile";
import { Sheet, SheetBody, SheetActions, SheetHead } from "../../shared/ui/Sheet";
import { dateFmt, intlTag, t, useLocale } from "../../shared/i18n/i18n";
import { store, stored } from "../../shared/model/ops";
import { prPopup, usePrPopup, type PopItem } from "../../shared/model/prpopup";
import { relTime } from "../../shared/model/prreview";
import { useShaCard } from "../../shared/model/prsha";
import { BigButton, type BigCtl } from "../../shared/ui/BigButton";
import { Icon } from "../../shared/ui/Icon";
import { Markdown } from "../../shared/ui/Markdown";

// PR 본문·리뷰·코멘트 팝업(26): 목록·타임라인에는 미리보기만 두고, 클릭하면 이 팝업(기존 시트 틀)으로 크게 읽는다.
// 열림 상태는 prpopup.ts 외부 스토어, 크기·글자 크기는 이 컴포넌트 안(저장)이라 PR 화면·그래프·사이드바·툴바는 다시 그려지지 않는다.

const FS = [12, 13, 14, 16, 18, 20, 22]; // 글자 크기 단계(px). 기본 14
const fmtDate = (iso: string) => dateFmt({ dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

export function Who({ name, src }: { name: string; src?: string }) {
  const [bad, setBad] = useState(false);
  return src && !bad ? <img className="prr-av" src={src} alt="" onError={() => setBad(true)} /> : <span className="prr-av" aria-hidden>{name.slice(0, 2).toUpperCase()}</span>;
}

/** `PrReviewScreen`이 한 번 둔다. 화면이 사라지면 팝업도 닫힌다 */
export function PrPopupHost() {
  countRender("PrPopupHost");
  const p = usePrPopup();
  useEffect(() => () => prPopup.close(false), []);
  return (
    <>
      {p ? <Popup items={p.items} i={p.i} scroll={p.scroll} /> : null}
      <ShaCard />
    </>
  );
}

/** 커밋 sha 링크 호버 카드: 제목·작성자·상대 시각·파일 수(diff 없음). 팝업이 아니라 가리키는 동안만 뜨는 작은 카드(포인터를 받지 않는다) */
function ShaCard() {
  const c = useShaCard();
  useLocale();
  if (!c) return null;
  const W = 280;
  const left = Math.max(8, Math.min(c.left, window.innerWidth - W - 8));
  const below = c.bottom + 150 < window.innerHeight; // 아래가 모자라면 위에
  return (
    <div className="sha-card" role="tooltip" style={{ left, width: W, ...(below ? { top: c.bottom + 6 } : { bottom: window.innerHeight - c.top + 6 }) }}>
      <strong className="sha-title">{c.info.title}</strong>
      <span className="hint">
        {c.info.author}{c.info.at && ` · ${relTime(c.info.at, intlTag())}`}{c.info.files !== null && ` · ${t("prr.sha.files", { n: c.info.files })}`}
      </span>
      <code className="hint">{c.sha.slice(0, 7)}</code>
    </div>
  );
}

function Popup({ items, i, scroll }: { items: PopItem[]; i: number; scroll?: number }) {
  countRender("Popup");
  useLocale();
  const it = items[i];
  const n = items.length;
  const [big, setBigState] = useState(() => stored("prrPopBig", false));
  const setBig = useCallback((v: boolean) => (setBigState(v), store("prrPopBig", v)), []);
  const ctl = useMemo<BigCtl>(() => ({ big, plain: true, restore: true, toggle: () => setBig(!big) }), [big, setBig]);
  const [fs, setFsState] = useState(() => {
    const v = stored("prrPopFs", 14);
    return FS.includes(v) ? v : 14;
  });
  const setFs = (d: number) => {
    const v = FS[Math.max(0, Math.min(FS.length - 1, FS.indexOf(fs) + d))];
    setFsState(v);
    store("prrPopFs", v);
  };
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => void (body.current && (body.current.scrollTop = scroll ?? 0)), [i, scroll]); // 다른 항목으로 넘기면 맨 위부터(sha 링크에서 돌아오면 있던 자리)
  const onKey = (e: React.KeyboardEvent) => {
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || n < 2) return;
    if (e.key === "ArrowLeft") (e.preventDefault(), prPopup.go(i - 1));
    else if (e.key === "ArrowRight") (e.preventDefault(), prPopup.go(i + 1));
  };
  const label = `${it.author} · ${it.kind}`;
  return (
    <Sheet label={label} size="reader" className="prr-pop" big={big} closeOnBackdrop onClose={() => prPopup.close()} onKeyDown={onKey}>
      <SheetHead
        onClose={() => prPopup.close()}
        tools={
          <>
            {n > 1 && (
              <span className="prr-step">
                <button className="prr-icon" disabled={i <= 0} title={`${t("prr.pop.prev")} (←)`} aria-label={t("prr.pop.prev")} onClick={() => prPopup.go(i - 1)}><Icon name="chevronLeft" size={14} /></button>
                <span className="hint" aria-live="polite">{i + 1}/{n}</span>
                <button className="prr-icon" disabled={i >= n - 1} title={`${t("prr.pop.next")} (→)`} aria-label={t("prr.pop.next")} onClick={() => prPopup.go(i + 1)}><Icon name="chevronRight" size={14} /></button>
              </span>
            )}
            <span className="prr-fs">
              <button className="tool-txt" disabled={fs <= FS[0]} title={t("prr.pop.smaller")} aria-label={t("prr.pop.smaller")} onClick={() => setFs(-1)}>A−</button>
              <button className="tool-txt" disabled={fs >= FS[FS.length - 1]} title={t("prr.pop.larger")} aria-label={t("prr.pop.larger")} onClick={() => setFs(1)}>A+</button>
            </span>
            <BigButton ctl={ctl} />
          </>
        }
      >
        <Who name={it.author} src={it.avatar} />
        <strong>{it.author}</strong>
        <span className={`prr-badge ${it.cls ?? ""}`}>{it.kind}</span>
        <time className="muted" dateTime={it.at}>{fmtDate(it.at)}</time>
        {it.where && <code className="prr-where" title={it.where}>{it.where}</code>}
      </SheetHead>
      <SheetBody flush>
        <div className="prr-pop-body" ref={body} style={{ fontSize: fs }}>
          <Markdown text={it.body} />
        </div>
      </SheetBody>
      <SheetActions cancel={t("common.close")} />
    </Sheet>
  );
}

/** 미리보기 카드·항목을 팝업 트리거로 만드는 props. 링크 클릭·글자 선택 드래그는 팝업을 열지 않는다 */
export const peek = (open: () => void, ref?: string) => ({
  role: "button" as const,
  tabIndex: 0,
  "aria-haspopup": "dialog" as const,
  "data-pop": ref,
  onClick: (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("a") || window.getSelection()?.toString()) return;
    open();
  },
  onKeyDown: (e: React.KeyboardEvent) => {
    if ((e.key !== "Enter" && e.key !== " ") || e.target !== e.currentTarget) return; // 안의 링크에서 누른 Enter는 링크가 처리
    e.preventDefault();
    open();
  },
});
