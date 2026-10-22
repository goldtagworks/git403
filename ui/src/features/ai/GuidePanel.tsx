import { memo, useEffect, useMemo, useRef, useState } from "react";
import { t, useLocale } from "../../shared/i18n/i18n";
import { ops, useAiOn } from "../../shared/model/ops";
import { guide, useGuideOpen, useGuideRec, useGuidePending } from "../../shared/model/guide";
import { countRender } from "../../shared/lib/profile";
import { Icon } from "../../shared/ui/Icon";
import type { AiGuide } from "../../shared/api/types";
import type { DiffNote } from "../../entities/diff/DiffView";

// AI 읽는 흐름 가이드(25d) 화면: 오른쪽 패널의 "파일 / 읽는 흐름" 세그먼트(GuideTabs), 가이드 패널(GuidePanel), diff 주석으로 바꾸는 훅(useGuideView).
// 상태·캐시는 shared/model/guide.ts, 호출은 ops.aiGuide*. 커밋 상세(Details)와 변경 화면(ChangesView)이 같이 쓴다.

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = MAC ? "⌘" : "Ctrl+";
const inField = (e: KeyboardEvent) => !!(e.target as HTMLElement | null)?.closest?.('input:not([type="checkbox"]), textarea, select, [contenteditable]');
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const range = (a: number, b: number) => `L${a}${b > a ? `–${b}` : ""}`;

/** 가이드를 diff 주석으로: 단계(번호 배지·범위·카드)와 집중해서 볼 곳(점) */
const guideNotes = (g: AiGuide): DiffNote[] => [
  ...g.steps.map((s, i): DiffNote => ({ file: s.file, line: s.startLine, endLine: s.endLine, n: i + 1, title: s.title, text: s.detail, kind: "step" })),
  ...g.focus.map((f): DiffNote => ({ file: f.file, line: f.line, title: t("guide.focusTitle"), text: f.note, kind: "focus" })),
];

/** 가이드 패널이 열려 있는지 (AI를 쓸 수 없으면 항상 닫힘) */
export function useGuidePanelOpen() {
  const on = useAiOn();
  const open = useGuideOpen();
  return open && on;
}

/** 이 대상의 가이드를 diff에 보일 정보. 패널이 닫혀 있거나 가이드가 아직 없으면 notes가 없다 */
export function useGuideView(key: string | null) {
  const lang = useLocale();
  const open = useGuidePanelOpen();
  const rec = useGuideRec(open ? key : null);
  const g = rec?.entry?.status === "done" ? rec.entry.guide : null;
  const notes = useMemo(() => (g ? guideNotes(g) : undefined), [g, lang]);
  return { open, notes, current: g ? rec!.n : undefined, reveal: rec?.reveal };
}

/** 변경 화면의 가이드 대상 키: 스테이지된 파일 목록+index 해시 지문(`diff --cached --raw`, 쓰기 없는 조회·diff 본문은 읽지 않는다). 패널이 열려 있고 스테이지된 파일이 있을 때만 읽는다. 읽기 전엔 undefined, 스테이지된 게 없으면 null */
export function useStagedGuide(repo: string, touched: number, enabled: boolean, hasStaged: boolean) {
  const [key, setKey] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    if (!hasStaged) return setKey(null);
    setKey((k) => (k === null ? undefined : k));
    let live = true;
    ops.guideStagedKey(repo).then((k) => live && setKey(k), () => live && setKey(null));
    return () => void (live = false);
  }, [repo, touched, enabled, hasStaged]); // status 객체가 아니라 파일 감시 알림(touched)으로만 다시 읽는다
  return enabled ? key : undefined;
}

/** "파일 / 읽는 흐름" 세그먼트. AI를 쓸 수 없으면 숨는다. ⌥⌘I(Alt+Ctrl+I) 열기·닫기는 main.tsx 전역 단축키 */
export function GuideTabs() {
  useLocale();
  const on = useAiOn();
  const open = useGuideOpen();
  if (!on) return null;
  return (
    <div className="guide-tabs">
      <div className="segmented" role="radiogroup" aria-label={t("guide.tabsLabel")} title={`${MAC ? "⌥⌘I" : "Alt+Ctrl+I"}`}>
        {[false, true].map((v) => (
          <button key={String(v)} role="radio" aria-checked={open === v} onClick={() => guide.setOpen(v)}>{v ? t("guide.tabFlow") : t("guide.tabFiles")}</button>
        ))}
      </div>
    </div>
  );
}

interface GuideCall { result: Promise<AiGuide | null>; cancel: () => void }

/**
 * 가이드 패널. gkey는 대상 키(없으면 만들 수 없음 — hint가 이유), start는 그 대상의 호출을 만든다, go는 파일 선택.
 * 단계 이동(클릭·⌘]/⌘[)은 파일 선택(go) + diff 스크롤 요청(store)만 하므로 그래프·사이드바·툴바는 다시 그려지지 않는다.
 */
export const GuidePanel = memo(function GuidePanel({ gkey, start, go, hint }: { gkey: string | null; start: (() => GuideCall) | null; go: (file: string) => void; hint?: string }) {
  countRender("GuidePanel");
  useLocale();
  const rec = useGuideRec(gkey);
  const entry = rec?.entry;
  const pending = useGuidePending();
  const st = useRef(start);
  st.current = start;
  const begin = () => gkey && st.current && guide.start(gkey, st.current());
  // 빠른 실행으로 연 경우: 대상이 정해지면(또는 만들 수 없다고 안내가 나오면) 그 한 번만 받아 만든다. 이미 있으면 보이기만
  useEffect(() => {
    if (!pending || !(gkey && st.current) && !hint) return;
    guide.take();
    if (gkey && !guide.has(gkey)) begin();
  }, [gkey, pending, !!start, hint]);

  if (entry?.status === "loading")
    return (
      <div className="guide" role="region" aria-label={t("guide.panelLabel")}>
        <p className="guide-busy" role="status"><span className="guide-spin" aria-hidden />{t("guide.making")}</p>
        <button type="button" onClick={() => gkey && guide.cancel(gkey)}>{t("common.cancel")}</button>
      </div>
    );
  if (entry?.status === "done" && gkey) return <GuideDone key={gkey} gkey={gkey} g={entry.guide} n={rec!.n} go={go} remake={begin} />;
  return (
    <div className="guide" role="region" aria-label={t("guide.panelLabel")}>
      <p className="help">{t("guide.intro")}</p>
      {entry?.status === "error" && <p className="warn selectable" role="alert">{entry.error}</p>}
      {hint && <p className="help" role="status">{hint}</p>}
      <button type="button" className="primary" disabled={!gkey || !start} onClick={begin}>{entry?.status === "error" ? t("guide.retry") : t("guide.make")}</button>
    </div>
  );
});

function Sect({ id, title, open, onToggle, children }: { id: string; title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <section className="guide-sect">
      <button type="button" className="guide-sect-head" aria-expanded={open} aria-controls={id} onClick={onToggle}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
        {title}
      </button>
      {open && <div id={id} className="guide-sect-body">{children}</div>}
    </section>
  );
}

function GuideDone({ gkey, g, n, go, remake }: { gkey: string; g: AiGuide; n: number; go: (file: string) => void; remake: () => void }) {
  const [ov, setOv] = useState(true);
  const [dec, setDec] = useState(false);
  const total = g.steps.length;
  const pick = (i: number) => {
    const s = g.steps[i];
    guide.step(gkey, i + 1, s.file, s.startLine);
    go(s.file);
  };
  const to = (file: string, line: number) => {
    guide.reveal(gkey, file, line);
    go(file);
  };
  // ⌘] / ⌘[ (Ctrl): 다음·이전 단계. 끝에서는 아무 일도 하지 않는다. 최신 값은 ref로 읽어 리스너는 한 번만 등록
  const cur = useRef({ n, total, pick });
  cur.current = { n, total, pick };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || inField(e)) return;
      const d = e.key === "]" || e.code === "BracketRight" ? 1 : e.key === "[" || e.code === "BracketLeft" ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const { n, total, pick } = cur.current;
      if (n + d >= 1 && n + d <= total) pick(n + d - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="guide selectable" role="region" aria-label={t("guide.panelLabel")}>
      <Sect id="guide-ov" title={t("guide.overview")} open={ov} onToggle={() => setOv(!ov)}>
        <p>{g.overview}</p>
      </Sect>
      {g.decision && (
        <Sect id="guide-dec" title={t("guide.decision")} open={dec} onToggle={() => setDec(!dec)}>
          <p className="guide-dec-title">{g.decision.title}</p>
          <p><span className="muted">{t("guide.why")}</span> {g.decision.why}</p>
          {g.decision.alternatives.length > 0 && (
            <>
              <p className="muted">{t("guide.alts")}</p>
              <ul>{g.decision.alternatives.map((a, i) => <li key={i}>{a}</li>)}</ul>
            </>
          )}
        </Sect>
      )}
      <section className="guide-sect">
        <div className="guide-flow-head">
          <h3>{t("guide.flow")}</h3>
          <span className="guide-count" aria-live="polite">{n} / {total}</span>
          <button type="button" className="guide-step-btn" aria-label={t("guide.prev", { keys: `${MOD}[` })} title={t("guide.prev", { keys: `${MOD}[` })} disabled={n <= 1} onClick={() => pick(n - 2)}><Icon name="chevronLeft" size={14} /></button>
          <button type="button" className="guide-step-btn" aria-label={t("guide.next", { keys: `${MOD}]` })} title={t("guide.next", { keys: `${MOD}]` })} disabled={n >= total} onClick={() => pick(n)}><Icon name="chevronRight" size={14} /></button>
        </div>
        <ol className="guide-steps" aria-label={t("guide.stepsLabel")}>
          {g.steps.map((s, i) => (
            <li key={i}>
              <button type="button" className={"guide-step" + (n === i + 1 ? " cur" : "")} aria-current={n === i + 1 ? "step" : undefined} onClick={() => pick(i)}>
                <span className="gs-n">{i + 1}</span>
                <span className="gs-title">{s.title}</span>
                <span className="gs-loc mono" title={s.file}>{base(s.file)} {range(s.startLine, s.endLine)}</span>
                <span className="gs-detail">{s.detail}</span>
              </button>
            </li>
          ))}
        </ol>
      </section>
      {g.focus.length > 0 && (
        <section className="guide-sect">
          <h3>{t("guide.focus")}</h3>
          <ul className="guide-focus">
            {g.focus.map((f, i) => (
              <li key={i}>
                <button type="button" onClick={() => to(f.file, f.line)} title={`${f.file}:${f.line}`}>
                  <span className="chip mono">L{f.line}</span>
                  <span>{f.note}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {g.apis.length > 0 && (
        <section className="guide-sect">
          <h3>{t("guide.apis")}</h3>
          <ul className="guide-apis">
            {g.apis.map((a, i) => (
              <li key={i} className="guide-api">
                <span className="mono guide-api-name">{a.name}</span>
                <span>{a.summary}</span>
                {a.file && (
                  <button type="button" className="link" onClick={() => to(a.file!, a.line ?? 1)}>
                    {t("guide.openDef", { loc: a.line ? `${a.file}:${a.line}` : a.file })}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {g.checks.length > 0 && (
        <section className="guide-sect">
          <h3>{t("guide.checks")}</h3>
          <Checks list={g.checks} />
        </section>
      )}
      <p className="help">{t("ai.mayBeWrong")}</p>
      <button type="button" className="secondary" onClick={remake}>{t("guide.remake")}</button>
    </div>
  );
}

/** 확인할 점 체크리스트: 체크 상태는 이 컴포넌트 안에만 둔다 */
function Checks({ list }: { list: string[] }) {
  const [done, setDone] = useState<Set<number>>(() => new Set());
  const flip = (i: number) => setDone((d) => { const n = new Set(d); n.delete(i) || n.add(i); return n; });
  return (
    <ul className="guide-checks">
      {list.map((c, i) => (
        <li key={i}>
          <label className={done.has(i) ? "done" : ""}>
            <input type="checkbox" checked={done.has(i)} onChange={() => flip(i)} />
            <span>{c}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}
