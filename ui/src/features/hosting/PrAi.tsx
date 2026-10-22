import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ask } from "../../shared/api/bridge";
import { api } from "../../shared/api/api";
import { Icon } from "../../shared/ui/Icon";
import { Markdown } from "../../shared/ui/Markdown";
import { showMenu } from "../../shared/ui/menu";
import { ctx, ops, stored, store, useAiOn } from "../../shared/model/ops";
import { aiKey, mustCount, prAi, useAiSummary, usePrAi, type CardUi, type IncInfo, type Rec, type ReviewUi, type Run } from "../../shared/model/prai";
import { commitsAfter, relTime } from "../../shared/model/prreview";
import { shiftLines, sliceDiff, type SliceRow } from "../../shared/lib/diffSlice";
import { toast } from "../../shared/lib/toast";
import { intlTag, t, useLocale, type Key } from "../../shared/i18n/i18n";
import { countRender } from "../../shared/lib/profile";
import { ensurePrepared, prFileDiff } from "./PrFiles";
import type { AiEffort, AiPrReview, InboxPr, PrDetail, PrTimelineItem, RemoteInfo } from "../../shared/api/types";

// PR AI 리뷰 탭(26c). 결과·체크·편집은 모두 shared/model/prai.ts 외부 스토어(PR별)라 탭·PR을 오가도 남고,
// 타이핑·체크는 이 패널과 탭 보조 글·목록 배지만 다시 그린다 (PR 화면의 다른 부분·그래프·사이드바·툴바는 그대로).

type Event = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
const LV: Record<"must" | "should" | "info", Key> = { must: "prr.ai.lv.must", should: "prr.ai.lv.should", info: "prr.ai.lv.info" };
const EFFORTS: AiEffort[] = ["low", "medium", "high"];
const EFFORT_KEY: Record<AiEffort, Key> = { low: "prr.ai.effort.low", medium: "prr.ai.effort.medium", high: "prr.ai.effort.high" };
const EVENT_KEY: Record<Event, Key> = { COMMENT: "prr.ai.post.comment", APPROVE: "prr.ai.post.approve", REQUEST_CHANGES: "prr.ai.post.changes" };
const tok = (n: number | null) => (n == null ? "–" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const where = (c: { file: string; line: number; endLine: number | null }) => `${c.file}:${c.line}${c.endLine ? `-${c.endLine}` : ""}`;

/** 탭 버튼 한 개. 상태(리뷰 전·리뷰 중…·필수 n·리뷰 완료)는 이 컴포넌트만 구독한다 */
export function AiTabButton({ k, sha, tl, on, onClick }: { k: string; sha: string; tl?: PrTimelineItem[]; on: boolean; onClick: () => void }) {
  useLocale();
  const sum = useAiSummary(k, sha, tl);
  const aiOn = useAiOn();
  const [st, must, stale, n] = sum.split(":");
  const base = st === "loading" ? t("prr.ai.sub.loading") : st === "error" ? t("prr.ai.sub.err") : st === "done" ? (Number(must) ? t("prr.ai.sub.must", { n: must }) : t("prr.ai.sub.done")) : aiOn ? t("prr.ai.sub.none") : t("prr.ai.sub.off");
  const sub = stale ? (n ? t("prr.ai.sub.new", { x: base, n }) : t("prr.ai.sub.stale", { x: base })) : base;
  return (
    <button role="tab" aria-label={t("prr.tab.ai")} aria-description={sub} aria-selected={on} className={on ? "on" : ""} onClick={onClick}>
      {t("prr.tab.ai")}
      <small className={st === "done" && (Number(must) || stale) ? "is-warn" : ""}>{sub}</small>
    </button>
  );
}

/** 목록 항목의 작은 표시(세션 캐시 기준): AI 리뷰 중 / 필수 n / 완료 */
export const AiMark = memo(function AiMark({ k, sha }: { k: string; sha: string }) {
  useLocale();
  const [st, must] = useAiSummary(k, sha).split(":");
  if (st === "loading") return <span className="prr-badge info" title={t("prr.ai.running")}>{t("prr.ai.mark.loading")}</span>;
  if (st !== "done") return null;
  return Number(must) ? <span className="prr-badge warn">{t("prr.ai.mark.must", { n: must })}</span> : <span className="prr-badge ok">{t("prr.ai.mark.done")}</span>;
});

/** 개요 안내줄: AI 리뷰 이후 새 커밋이 생겼을 때만. AI 탭으로 보낼 뿐 직접 시작하지 않는다(비용·옵션은 그 탭에서) */
export function AiNewHint({ k, sha, tl, onOpen }: { k: string; sha: string; tl?: PrTimelineItem[]; onOpen: () => void }) {
  useLocale();
  const [st, , stale, n] = useAiSummary(k, sha, tl).split(":");
  if (st !== "done" || !stale) return null;
  return (
    <div className="prr-hint is-info" role="status">
      <span>{n ? t("prr.ai.hint.new", { n }) : t("prr.ai.hint.newNo")}</span>
      <button onClick={onOpen}>{t("prr.ai.hint.go")}</button>
    </div>
  );
}

export interface PrAiProps {
  repo: string;
  target: Pick<RemoteInfo, "remote" | "repo" | "account">;
  pr: InboxPr;
  d: PrDetail;
  /** "코드에서 보기": 변경 파일 탭에서 이 파일·줄로, 카드 번호는 돌아올 때 그 카드로 되돌리려고 */
  onCode: (file: string, line: number, card: number) => void;
}

export function PrAi({ repo, target, pr, d, onCode }: PrAiProps) {
  countRender("PrAi");
  useLocale();
  const k = aiKey(repo, pr.number);
  const rec = usePrAi(k);
  const aiOn = useAiOn();
  const [model, setModel] = useState(() => stored<string>("prr.ai.model", ""));
  const [effort, setEffort] = useState<AiEffort>(() => stored<AiEffort>("prr.ai.effort", "medium"));

  // 상세(d)는 새로고침 사이에 늦을 수 있어 head는 목록의 최신 값을 쓴다
  const head = pr.headSha;
  const dh = useMemo(() => ({ ...d, headSha: head }), [d, head]);
  const start = (opts?: { model?: string; effort: AiEffort }) => {
    const o = opts ?? { model: model.trim() || undefined, effort };
    if (!opts) (store("prr.ai.model", model.trim()), store("prr.ai.effort", effort));
    prAi.start(k, head, ops.aiReviewPr(repo, { title: pr.title, body: d.body, head }, () => ensurePrepared(repo, target.remote, pr, dh), o), o);
  };
  /** 새 커밋만 리뷰: 이전 리뷰한 head(rec.sha)..head의 diff·커밋 메시지 + 이전 리뷰 요약. 같은 모델·노력 */
  const startNew = () => {
    const r = prAi.get(k);
    if (r?.run.status !== "done" || r.inc || r.sha === head) return;
    const old = r.sha;
    const prev = prevReviewText(r.run.result, r.run.ui);
    const call = ops.aiReviewPrNew(repo, { title: pr.title, body: d.body, head }, { sha: old, prev }, async () => {
      const mb = await ensurePrepared(repo, target.remote, pr, dh);
      const bad = await checkInc(repo, old, head);
      if (bad) throw t(INC_WHY[bad], { sha: old.slice(0, 7) });
      return mb;
    }, r.opts);
    prAi.startInc(k, head, call, (res, cards) => analyze(repo, old, head, res, cards));
  };

  if (rec?.run.status === "loading") return <Running since={rec.run.startedAt} onCancel={() => prAi.cancel(k)} />;
  if (rec?.run.status === "done")
    return <Result k={k} rec={rec as Rec & { run: Extract<Run, { status: "done" }> }} repo={repo} target={target} pr={pr} tl={d.timeline} head={head} aiOn={aiOn} onCode={onCode} onAgain={() => start(rec.opts)} onNew={startNew} />;

  // 실행 전(또는 실패 뒤): AI를 쓸 수 없으면 이유를 보이고 설정으로 보낸다
  if (!aiOn)
    return (
      <div className="prai prai-intro">
        <h3>{t("prr.tab.ai")}</h3>
        <p role="status">{ctx.ai.repoOff ? t("prr.ai.off.repo") : t("prr.ai.off.none")}</p>
        <div><button onClick={() => ops.openSettings("ai")}>{t("prr.ai.off.go")}</button></div>
      </div>
    );
  return (
    <div className="prai prai-intro">
      <h3>{t("prr.tab.ai")}</h3>
      <p>{t("prr.ai.intro")}</p>
      <p className="hint">{t("prr.ai.sends")}</p>
      {rec?.run.status === "error" && (
        <div className="prai-err" role="alert">
          <strong>{t("prr.ai.fail")}</strong>
          <p className="selectable">{rec.run.error}</p>
        </div>
      )}
      <div className="prai-opts">
        <label className="field">
          <span>{t("prr.ai.model")}</span>
          <input value={model} spellCheck={false} autoComplete="off" placeholder={t("prr.ai.model.ph", { m: ctx.ai.status?.model ?? "" })} onChange={(e) => setModel(e.target.value)} />
        </label>
        <div className="field">
          <span>{t("prr.ai.effort")}</span>
          <div className="segmented" role="radiogroup" aria-label={t("prr.ai.effort")}>
            {EFFORTS.map((x) => (
              <button key={x} role="radio" aria-checked={effort === x} onClick={() => setEffort(x)}>{t(EFFORT_KEY[x])}</button>
            ))}
          </div>
        </div>
      </div>
      <div><button className="primary" onClick={() => start()}>{t("prr.ai.start")}</button></div>
    </div>
  );
}

const INC_WHY = { gone: "prr.ai.inc.gone", diverged: "prr.ai.inc.diverged" } as const;
const INC_WHY_SHORT = { gone: "prr.ai.re.new.gone", diverged: "prr.ai.re.new.diverged" } as const;
const has = (repo: string, sha: string) => api.git(repo, ["cat-file", "-e", `${sha}^{commit}`]).then(() => true, () => false);
/** 이전에 리뷰한 head(old)로 범위 diff를 만들 수 있는지: 로컬에 있고(강제 푸시로 사라지지 않음) 새 head의 조상일 때. head가 아직 로컬에 없으면 조상 여부는 모르므로 통과 */
async function checkInc(repo: string, old: string, head: string): Promise<"gone" | "diverged" | null> {
  if (!(await has(repo, old))) return "gone";
  if ((await has(repo, head)) && !(await api.git(repo, ["merge-base", "--is-ancestor", old, head]).then(() => true, () => false))) return "diverged";
  return null;
}
/** 이전 리뷰를 AI에 알리는 글: 요약(편집 전 AI 원문)과 코멘트 요약(file:line [level] title, 게시 여부). 각 줄을 들여써서 diff 헤더처럼 읽히지 않게 한다 */
function prevReviewText(r: AiPrReview, ui: ReviewUi) {
  const sums = [r.summary, ...(ui.inc?.prevs.map((p) => p.summary) ?? [])];
  const cs = ui.cards.map((c) => `${where(c.c)} [${c.c.level}] ${c.c.title}${c.posted ? " (posted)" : ""}`);
  return [`summary:\n${sums.join("\n\n")}`, `comments:\n${cs.length ? cs.join("\n") : "(none)"}`].join("\n\n").split("\n").map((l) => `  ${l}`).join("\n");
}
/** 이전 카드를 새 head 기준으로 살핀다: 이름 바뀐 파일은 새 경로로(`diff --name-status -M`), 줄 밀림·바뀜은 파일마다 한 번 읽은 이전 head→새 head `-U0 -M` diff로,
 *  새 head의 변경 diff(병합 기준..head)에 그 줄이 있는지로 게시 위험을 본다. 게시한 카드는 바뀜만. 못 살핀 카드는 null(mergeInc가 위험 처리) */
async function analyze(repo: string, old: string, head: string, _r: AiPrReview, cards: CardUi[]): Promise<IncInfo> {
  const n = Number((await api.git(repo, ["rev-list", "--count", `${old}..${head}`]).catch(() => "")).trim()) || null;
  const names = new Map<string, string>(); // 옛 경로 → 새 경로(이름 변경만)
  const ns = await api.git(repo, ["-c", "core.quotepath=false", "diff", "--name-status", "-M", old, head]).catch(() => null);
  if (ns === null) return { n, cards: [] };
  for (const l of ns.split("\n")) {
    const f = l.split("\t");
    if (f[0]?.[0] === "R" && f[1] && f[2]) names.set(f[1], f[2]);
  }
  const diffs = new Map<string, Promise<string>>(); // 파일(새 경로)별 -U0 diff는 한 번만
  const diff0 = (from: string, to: string) => {
    let p = diffs.get(to);
    if (!p) diffs.set(to, (p = api.git(repo, ["diff", "--no-ext-diff", "-U0", "-M", old, head, "--", ...(from === to ? [to] : [from, to])])));
    return p;
  };
  const out = await Promise.all(
    cards.map(async (c) => {
      try {
        const to = names.get(c.c.file) ?? c.c.file;
        const renamed = to !== c.c.file ? c.c.file : undefined;
        const sh = shiftLines(await diff0(c.c.file, to), c.c.line, c.c.endLine);
        if (c.posted) return { ...sh, file: c.c.file, line: c.c.line, endLine: c.c.endLine, risk: false };
        const risk = await prFileDiff(repo, head, to).then((x) => sliceDiff(x, sh.line, sh.endLine) === null, () => false);
        return { ...sh, file: to, renamed, risk };
      } catch {
        return null;
      }
    }),
  );
  return { n, cards: out };
}

function Running({ since, onCancel }: { since: number; onCancel: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="prai prai-intro" role="status">
      <div className="guide-busy"><span className="guide-spin" aria-hidden /><span>{t("prr.ai.running")}</span><span className="prai-sec">{t("prr.ai.sec", { n: Math.floor((Date.now() - since) / 1000) })}</span></div>
      <p className="hint">{t("prr.ai.bg")}</p>
      <div><button onClick={onCancel}>{t("common.cancel")}</button></div>
    </div>
  );
}

const bodyOf = (ui: ReviewUi) => {
  if (ui.posted) return ""; // 본문은 한 번만 게시한다 (남은 코멘트를 더 올릴 때 중복 방지)
  const parts = [ui.summary.on && ui.summary.text.trim(), ui.praise?.on && ui.praise.text.trim() && `### ${t("prr.ai.praiseHead")}\n${ui.praise.text.trim()}`].filter(Boolean) as string[];
  return parts.join("\n\n");
};

/** 한 묶음 머리의 개수: 필수 m · p/k 게시됨 */
const counts = (cards: CardUi[]) => t("prr.ai.counts", { m: cards.filter((c) => c.c.level === "must").length, p: cards.filter((c) => c.posted).length, k: cards.length });

function Result({ k, rec, repo, target, pr, tl, head, aiOn, onCode, onAgain, onNew }: { k: string; rec: Rec & { run: Extract<Run, { status: "done" }> }; repo: string; target: PrAiProps["target"]; pr: InboxPr; tl: PrTimelineItem[]; head: string; aiOn: boolean; onCode: PrAiProps["onCode"]; onAgain: () => void; onNew: () => void }) {
  useLocale();
  const { result, ui, at } = rec.run;
  const inc = ui.inc;
  const run = rec.inc; // 새 커밋만 리뷰 진행 중
  const fresh = ui.cards.filter((c) => !c.old);
  const olds = ui.cards.filter((c) => c.old);
  const mustNow = fresh.filter((c) => c.c.level === "must").length;
  const mustTotal = mustCount(ui);
  const mustLeft = ui.cards.filter((c) => c.c.level === "must" && !c.posted).length;
  const stale = rec.sha !== head;
  const newN = useMemo(() => commitsAfter(tl, rec.sha), [tl, rec.sha]);
  const picked = ui.cards.flatMap((c, i) => (c.on && !c.posted ? [i] : []));
  const pickedOld = picked.filter((i) => ui.cards[i].old).length;
  const body = bodyOf(ui);
  const defEvent: Event = mustLeft ? "REQUEST_CHANGES" : "COMMENT";
  const block = (ev: Event) => (run ? t("prr.ai.block.inc") : ev === "REQUEST_CHANGES" && !body ? t("prr.ai.block.changes") : ev === "COMMENT" && !body && !picked.length ? t("prr.ai.block.empty") : null);
  // 새 커밋만 리뷰를 할 수 있는지: 리뷰한 커밋이 로컬에 없거나(강제 푸시) 조상이 아니면 이유를 보이고 전체만 가능
  const [chk, setChk] = useState<"gone" | "diverged" | null>(null);
  useEffect(() => {
    if (!stale) return setChk(null);
    let live = true;
    checkInc(repo, rec.sha, head).then((x) => live && setChk(x));
    return () => void (live = false);
  }, [repo, rec.sha, head, stale, rec.note]);
  const praiseInit = result.praise.map((x) => `- ${x}`).join("\n");
  const dirty = ui.cards.some((c) => c.text !== c.c.body) || ui.summary.text !== result.summary || (!!ui.praise && ui.praise.text !== praiseInit);
  const rid = rec.rid;
  const busy = ui.posting || !!run;

  const submit = async (ev: Event) => {
    if (busy || block(ev) || !prAi.lock(k)) return; // 확인창이 뜨기 전부터 동기 잠금: 연타·버튼+메뉴 섞어 눌러도 한 번만
    try {
      const checkedMust = picked.filter((i) => ui.cards[i].c.level === "must").length;
      const risky = picked.filter((i) => ui.cards[i].risk).length;
      const num = pr.number;
      const what = body && picked.length ? t("prr.ai.confirm.both", { n: picked.length, num }) : picked.length ? t("prr.ai.confirm.comments", { n: picked.length, num }) : body ? t("prr.ai.confirm.body", { num }) : t("prr.ai.confirm.none", { num });
      const msg = [ev === "APPROVE" && checkedMust ? t("prr.ai.confirm.warnApprove", { n: checkedMust }) : "", risky ? t("prr.ai.confirm.risk", { n: risky }) : "", what, t("prr.ai.confirm.kind", { kind: t(EVENT_KEY[ev]) }), t("prr.ai.confirm.final")].filter(Boolean).join("\n\n");
      if (!(await ask(msg, { title: t("prr.ai.confirm.title"), kind: "warning" }))) return;
      // 확인 직후 최신 상태로 다시 만든다(확인창이 떠 있는 동안 바뀐 편집·체크 반영, 그사이 결과가 바뀌었으면 중단)
      const now = prAi.get(k);
      if (now?.run.status !== "done" || now.rid !== rid || now.inc) return;
      const nui = now.run.ui;
      const sel = nui.cards.flatMap((c, i) => (c.on && !c.posted ? [i] : []));
      const nbody = bodyOf(nui);
      if ((ev === "REQUEST_CHANGES" && !nbody) || (ev === "COMMENT" && !nbody && !sel.length)) return;
      prAi.patch(k, (u) => ({ ...u, posting: true, error: null, cards: u.cards.map((c) => (c.bad ? { ...c, bad: null } : c)) }), rid);
      const comments = sel.map((i) => {
        const c = nui.cards[i];
        return { path: c.c.file, line: c.c.endLine ?? c.c.line, ...(c.c.endLine ? { startLine: c.c.line } : {}), side: "RIGHT" as const, body: c.text };
      });
      try {
        const url = await api.prReviewSubmit(target.account, target.repo, num, rec.sha, ev, nbody, comments, ctx.repo || undefined);
        prAi.patch(k, (u) => ({ ...u, posting: false, posted: { url, n: (u.posted?.n ?? 0) + sel.length }, cards: u.cards.map((c, i) => (sel.includes(i) ? { ...c, posted: true, edit: false, bad: null } : c)) }), rid);
        toast(t("prr.ai.posted"), { kind: "success", detail: t("prr.ai.posted.detail", { num, n: sel.length }) });
      } catch (e) {
        const em = String(e);
        // 422(줄이 diff 밖): 메시지에 든 path:line, 그리고 변경 diff에서 찾을 수 없는 줄을 표시한다. diff를 못 읽으면 표시 없이 오류만. 체크·편집은 그대로
        const named = new Set([...em.matchAll(/([^\s(:]+):(\d+)/g)].map((m) => `${m[1]}:${m[2]}`));
        let outside: boolean[] | null = null;
        try {
          outside = await Promise.all(sel.map(async (i) => sliceDiff(await prFileDiff(repo, rec.sha, nui.cards[i].c.file), nui.cards[i].c.line, nui.cards[i].c.endLine) === null));
        } catch {}
        prAi.patch(k, (u) => ({ ...u, posting: false, error: em, cards: u.cards.map((c, i) => (sel.includes(i) && (named.has(`${c.c.file}:${c.c.line}`) || named.has(`${c.c.file}:${c.c.endLine ?? c.c.line}`) || outside?.[sel.indexOf(i)]) ? { ...c, bad: t("prr.ai.badLine") } : c)) }), rid);
      }
    } finally {
      prAi.unlock(k);
      prAi.patch(k, (u) => (u.posting ? { ...u, posting: false } : u), rid); // 어느 경로로 끝나도 버튼이 풀린다
    }
  };
  const menu = (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu((["COMMENT", "APPROVE", "REQUEST_CHANGES"] as Event[]).map((ev) => ({ label: t(EVENT_KEY[ev]), disabled: !!block(ev), action: () => void submit(ev) })), { x: r.left, y: r.bottom + 2 });
  };
  /** 다시 리뷰(전체): 편집·체크가 있거나 일부를 게시했으면 확인을 받는다. 게시 중에는 안 한다 */
  const again = async () => {
    if (busy || prAi.locked(k) || !aiOn) return;
    const anyPosted = !!ui.posted || ui.cards.some((c) => c.posted);
    if ((dirty || anyPosted) && !(await ask(t(anyPosted ? "prr.ai.re.confirmPosted" : "prr.ai.re.confirm"), { title: t("prr.ai.re"), kind: "warning" }))) return;
    if (prAi.locked(k) || prAi.get(k)?.inc || prAi.get(k)?.rid !== rid) return; // 확인창이 떠 있는 동안 게시·새 커밋 리뷰가 시작됐거나 결과가 바뀜
    onAgain();
  };
  const againOff = !aiOn ? t("prr.ai.re.off") : run ? t("prr.ai.re.running") : ui.posting ? t("prr.ai.re.posting") : undefined;
  /** 새 커밋만: 새 커밋이 있고 리뷰한 커밋이 로컬에 있을 때만. 안 되면 메뉴 글자에 이유가 붙는다 */
  const newOff = againOff ?? (!stale ? t("prr.ai.re.new.none") : chk ? t(INC_WHY_SHORT[chk]) : undefined);
  const newTip = !stale ? t("prr.ai.re.new.none") : chk ? t(INC_WHY[chk], { sha: rec.sha.slice(0, 7) }) : againOff;
  const againMenu = (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(
      [
        { label: newOff ? `${t("prr.ai.re.new")} (${newOff})` : t("prr.ai.re.new"), disabled: !!newOff, action: onNew },
        { label: t("prr.ai.re.all"), disabled: !!againOff, action: () => void again() },
      ],
      { x: r.left, y: r.bottom + 2 },
    );
  };
  const reason = block(defEvent);

  return (
    <div className="prai">
      {rec.note && (
        <div className="prai-err" role="alert">
          <strong>{t("prr.ai.inc.fail")}</strong>
          <p className="selectable">{rec.note}</p>
          <p className="hint">{t("prr.ai.inc.failKept")}</p>
          <button onClick={() => prAi.clearNote(k)}>{t("common.close")}</button>
        </div>
      )}
      {run && <IncRunning since={run.startedAt} onCancel={() => prAi.cancelInc(k)} />}
      {stale && !run && (
        <div className="prai-banner is-warn wrap" role="status">
          <span>{newN ? t("prr.ai.stale.n", { n: newN }) : t("prr.ai.stale")}</span>
          <button className="primary" disabled={!!newOff} title={newTip} onClick={onNew}>{t("prr.ai.re.newGo")}</button>
          <button disabled={!!againOff} title={againOff} onClick={() => void again()}>{t("prr.ai.re.all")}</button>
          {chk && <span className="hint prai-why">{t(INC_WHY[chk], { sha: rec.sha.slice(0, 7) })}</span>}
        </div>
      )}
      <div className={`prai-banner ${mustTotal ? "is-danger" : "is-ok"}`} role="status">
        <span>{mustTotal ? t("prr.ai.banner.must", { n: mustTotal }) : t("prr.ai.banner.ok")}</span>
        {inc && mustTotal > 0 && <span className="hint">{t("prr.ai.banner.split", { a: mustNow, b: mustTotal - mustNow })}</span>}
      </div>
      <div className="prai-meta hint">
        {inc && <strong>{inc.n ? t("prr.ai.meta.inc", { n: inc.n }) : t("prr.ai.meta.incNo")}</strong>}
        <span>{result.meta.model}</span>
        <span>{t("prr.ai.meta.tokens", { i: tok(result.meta.inputTokens), o: tok(result.meta.outputTokens) })}</span>
        <span>{t("prr.ai.sec", { n: Math.round(result.meta.elapsedMs / 1000) })}</span>
        <span>{relTime(new Date(at).toISOString(), intlTag())}</span>
        <span>{t(EFFORT_KEY[rec.opts.effort])}</span>
      </div>
      <div className="prai-cols">
        <BodyCard k={k} ui={ui} />
        <section className="prai-side" aria-label={t("prr.ai.commentsTitle", { n: ui.cards.length })}>
          {/* 한 부모 아래 key(카드 id) 있는 평평한 목록: 병합으로 카드가 이전 묶음으로 옮겨져도 DOM·편집 중인 입력이 그대로 남는다 */}
          <div key="h-new" className={`prai-side-head${inc ? " prai-group" : ""}`} data-group={inc ? "new" : undefined}>
            <strong>{inc ? t("prr.ai.group.now", { n: fresh.length }) : t("prr.ai.commentsTitle", { n: ui.cards.length })}</strong>
            <span className="hint prai-count">{counts(inc ? fresh : ui.cards)}</span>
          </div>
          {!fresh.length && <p key="none" className="prr-note">{t("prr.ai.noComments")}</p>}
          {ui.cards.map((c, i) => (c.old ? null : <Card key={c.id} k={k} i={i} c={c} repo={repo} sha={rec.sha} onCode={onCode} />))}
          {inc && <OldHead key="h-old" k={k} inc={inc} olds={olds} />}
          {inc?.open && inc.prevs.map((p, i) => (
            <div key={`prev${i}`} className="prai-prev selectable">
              <span className="hint">{t("prr.ai.prevSummary", { sha: p.sha.slice(0, 7) })}{p.posted ? ` ${t("prr.ai.postedTag")}` : ""}</span>
              <p>{p.summary}</p>
            </div>
          ))}
          {inc?.open && !olds.length && <p key="none-old" className="prr-note">{t("prr.ai.noComments")}</p>}
          {inc?.open && ui.cards.map((c, i) => (c.old ? <Card key={c.id} k={k} i={i} c={c} repo={repo} sha={rec.sha} onCode={onCode} /> : null))}
        </section>
      </div>
      <footer className="prai-foot">
        <div className="prai-split">
          <button className="primary" disabled={ui.posting || !!reason} title={reason ?? undefined} onClick={() => void submit(defEvent)}>{ui.posting ? t("prr.ai.posting") : t(EVENT_KEY[defEvent])}</button>
          <button className="primary" aria-haspopup="menu" aria-label={t("prr.ai.post.menu")} title={t("prr.ai.post.menu")} disabled={ui.posting} onClick={menu}><Icon name="dropdown" size={10} /></button>
        </div>
        <div className="prai-split">
          <button aria-haspopup="menu" title={againOff ?? t("prr.ai.re")} disabled={busy} onClick={againMenu}>{t("prr.ai.re")} <Icon name="dropdown" size={10} /></button>
        </div>
        <span className="hint prai-plan" role="status">{reason ?? (inc ? t("prr.ai.plan.inc", { b: body ? t("prr.ai.has") : t("prr.ai.no"), n: picked.length, a: picked.length - pickedOld, o: pickedOld }) : t("prr.ai.plan", { b: body ? t("prr.ai.has") : t("prr.ai.no"), n: picked.length }))}</span>
        {ui.posted && (
          <span className="prai-done">
            <span>{t("prr.ai.postedLine", { n: ui.posted.n })}</span>
            <button onClick={() => ops.openUrl(ui.posted!.url)}>{t("prr.github")}</button>
          </span>
        )}
        {ui.error && (
          <div className="prai-err" role="alert">
            <strong>{t("prr.ai.postFail")}</strong>
            <p className="selectable">{ui.error}</p>
            <p className="hint">{t("prr.ai.kept")}</p>
          </div>
        )}
      </footer>
    </div>
  );
}

/** 새 커밋만 리뷰 진행 줄: 결과는 그대로 아래에 보이고 편집·체크도 된다 */
function IncRunning({ since, onCancel }: { since: number; onCancel: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="prai-banner wrap" role="status">
      <span className="guide-spin" aria-hidden />
      <span>{t("prr.ai.inc.running")}</span>
      <span className="prai-sec">{t("prr.ai.sec", { n: Math.floor((Date.now() - since) / 1000) })}</span>
      <button onClick={onCancel}>{t("common.cancel")}</button>
      <span className="hint prai-why">{t("prr.ai.inc.runningHint")}</span>
    </div>
  );
}

/** "이전 리뷰" 묶음 머리(접기 가능). 접어도 개수·변경됨·게시 위험이 보인다 */
function OldHead({ k, inc, olds }: { k: string; inc: NonNullable<ReviewUi["inc"]>; olds: CardUi[] }) {
  const changed = olds.filter((c) => c.changed).length;
  const risk = olds.filter((c) => c.risk && !c.posted).length;
  const toggle = () => prAi.patch(k, (u) => ({ ...u, inc: { ...u.inc!, open: !u.inc!.open } }));
  return (
    <div className="prai-side-head prai-group prai-old" data-group="old">
      <button className="prai-fold" aria-expanded={inc.open} onClick={toggle}><Icon name={inc.open ? "chevronDown" : "chevronRight"} size={12} /> {t("prr.ai.group.old", { n: olds.length })}</button>
      <span className="hint prai-count">{[counts(olds), changed ? t("prr.ai.group.changed", { n: changed }) : "", risk ? t("prr.ai.group.risk", { n: risk }) : ""].filter(Boolean).join(" ")}</span>
    </div>
  );
}

/** 왼쪽 "리뷰 본문": 요약·잘된 점. 체크한 것만 게시 본문에 들어간다 */
function BodyCard({ k, ui }: { k: string; ui: ReviewUi }) {
  const set = (name: "summary" | "praise", p: { on?: boolean; text?: string }) => prAi.patch(k, (u) => ({ ...u, [name]: { ...u[name]!, ...p } }));
  const posted = !!ui.posted;
  const row = (name: "summary" | "praise", label: string, v: { on: boolean; text: string }) => (
    <div className={`prai-field${v.on ? "" : " off"}`}>
      <label className="prai-check">
        <input type="checkbox" checked={v.on} disabled={posted} onChange={(e) => set(name, { on: e.target.checked })} />
        <strong>{label}</strong>
        {posted && <span className="prai-tag">{t("prr.ai.postedTag")}</span>}
      </label>
      <textarea aria-label={label} value={v.text} rows={Math.min(14, Math.max(3, v.text.split("\n").length + 1))} disabled={posted} onChange={(e) => set(name, { text: e.target.value })} />
    </div>
  );
  return (
    <section className="prai-body" aria-label={t("prr.ai.bodyTitle")}>
      <div className="prai-side-head"><strong>{t(ui.inc ? "prr.ai.bodyTitle.inc" : "prr.ai.bodyTitle")}</strong><span className="hint">{t("prr.ai.bodyHint")}</span></div>
      {row("summary", t("prr.ai.summary"), ui.summary)}
      {ui.praise && row("praise", t("prr.ai.praise", { n: ui.praise.text.split("\n").length }), ui.praise)}
    </section>
  );
}

/** 코멘트 한 줄 둘레의 읽기 전용 작은 코드 블록 (26b가 이미 받아 둔 병합 기준..head diff에서 잘라 쓴다) */
const Snippet = memo(function Snippet({ repo, sha, file, line, endLine, quiet }: { repo: string; sha: string; file: string; line: number; endLine: number | null; /** 게시한 카드는 "diff에 없음" 경고를 숨긴다 */ quiet?: boolean }) {
  const [rows, setRows] = useState<SliceRow[] | null | false | undefined>(undefined);
  useEffect(() => {
    let live = true;
    prFileDiff(repo, sha, file).then((x) => live && setRows(sliceDiff(x, line, endLine)), () => live && setRows(false));
    return () => void (live = false);
  }, [repo, sha, file, line, endLine]);
  if (rows === undefined) return <p className="hint prai-snip-note">{t("prr.ai.snipLoad")}</p>;
  if (rows === false) return <p className="hint prai-snip-note">{t("prr.ai.snipFail")}</p>;
  if (rows === null) return quiet ? null : <p className="hint prai-snip-note">{t("prr.ai.noLine")}</p>;
  return (
    <div className="prai-code selectable" role="group" aria-label={where({ file, line, endLine })}>
      {rows.map((r, i) => (
        <div key={i} className={`prai-row${r.t === "+" ? " add" : r.t === "-" ? " del" : ""}${r.hit ? " hit" : ""}`}>
          <span className="n">{r.n ?? ""}</span>
          <span className="s">{r.t === " " ? "" : r.t}</span>
          <span className="x">{r.text}</span>
        </div>
      ))}
    </div>
  );
});

const Card = memo(function Card({ k, i, c, repo, sha, onCode }: { k: string; i: number; c: CardUi; repo: string; sha: string; onCode: PrAiProps["onCode"] }) {
  useLocale();
  const set = (p: Partial<CardUi>) => prAi.card(k, i, p);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => void (c.edit && ta.current?.focus()), [c.edit]);
  const cm = c.c;
  const loc = useMemo(() => where(cm), [cm]);
  return (
    <article className={`prai-card lv-${cm.level}${c.posted ? " posted" : ""}${c.bad ? " bad" : ""}${c.old ? " old" : ""}`} data-card={i}>
      <header>
        <input type="checkbox" aria-label={`${t("prr.ai.include")}: ${loc}`} checked={c.on} disabled={c.posted} onChange={(e) => set({ on: e.target.checked })} />
        <span className="prai-lv">{t(LV[cm.level])}</span>
        <span className="prai-title">{cm.title}</span>
        <code className="prai-loc" title={loc}>{loc}</code>
      </header>
      <Snippet repo={repo} sha={sha} file={cm.file} line={cm.line} endLine={cm.endLine} quiet={c.posted} />
      {c.edit ? <textarea ref={ta} aria-label={t("prr.ai.edit")} value={c.text} rows={Math.min(12, Math.max(3, c.text.split("\n").length + 1))} onChange={(e) => set({ text: e.target.value })} /> : <Markdown text={c.text} className="prai-md" />}
      {c.bad && <p className="prai-badmsg" role="alert">{c.bad}</p>}
      {c.old && (c.changed || (c.risk && !c.posted) || c.from || c.renamed) && (
        <p className="prai-flags">
          {c.changed && <span className="prai-tag warn" title={t("prr.ai.changed.tip")}>{t("prr.ai.changed")}</span>}
          {c.risk && !c.posted && <span className="prai-tag danger" title={t("prr.ai.risk.tip")}>{t("prr.ai.risk")}</span>}
          {c.lost && !c.posted && <span className="hint">{t("prr.ai.lost")}</span>}
          {c.renamed && <span className="hint">{t("prr.ai.renamed", { old: c.renamed })}</span>}
          {c.from && !c.posted && <span className="hint">{t("prr.ai.moved", { n: c.from })}</span>}
        </p>
      )}
      <div className="prai-actions">
        {c.posted ? <span className="prai-tag">{t("prr.ai.postedTag")}</span> : (
          <>
            <button onClick={() => set({ edit: !c.edit })}>{c.edit ? t("prr.ai.editDone") : t("prr.ai.edit")}</button>
            {c.text !== cm.body && <button onClick={() => set({ text: cm.body })}>{t("prr.ai.reset")}</button>}
          </>
        )}
        <button onClick={() => onCode(cm.file, cm.line, i)}>{t("prr.ai.code")}</button>
        {cm.evidence && <button aria-expanded={c.ev} onClick={() => set({ ev: !c.ev })}>{c.ev ? t("prr.ai.evidenceHide") : t("prr.ai.evidence")}</button>}
      </div>
      {c.ev && <div className="prai-evidence selectable"><span className="hint">{t("prr.ai.evidence")}</span><p>{cm.evidence}</p></div>}
    </article>
  );
});
