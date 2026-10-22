import { useSyncExternalStore } from "react";
import type { AiCall } from "./ops";
import { commitsAfter } from "./prreview";
import type { AiEffort, AiPrComment, AiPrReview } from "../api/types";

// PR AI 리뷰(26c)의 세션 캐시와 편집·체크·게시 상태. PR(저장소+번호)별로 보관하고 구독도 PR별이라, 타이핑·체크가
// 그 PR의 AI 패널·탭 보조 글·목록 배지만 깨우고 PR 화면 나머지·그래프·사이드바·툴바는 다시 그리지 않는다.
// 탭·PR을 오가거나 화면을 닫았다 열어도 결과와 편집 내용이 남는다(앱을 끄면 사라지는 세션 캐시). 호출은 ops.aiReviewPr, 화면은 features/hosting/PrAi.tsx.

export const LEVELS = ["must", "should", "info"] as const;
/** 카드 하나의 상태. c는 AI 원본, text는 편집한 게시 문구 */
export interface CardUi {
  /** 카드 생성 때 붙는 고정 번호(React key): 병합으로 위치가 바뀌어도 편집 중인 입력·코드 조각 상태가 같은 카드에 남는다 */
  id: number;
  c: AiPrComment; on: boolean; text: string; edit: boolean; ev: boolean; posted: boolean; bad: string | null;
  /** 새 커밋만 리뷰(26d) 뒤 "이전 리뷰" 묶음의 카드 */
  old?: boolean;
  /** 이전 리뷰 이후 이 줄이 바뀌었다("변경됨 — 다시 확인"). 한 번 켜지면 유지 */
  changed?: boolean;
  /** 새 head의 변경 diff에 이 줄이 없다(게시하면 GitHub 422 위험). 처음 걸릴 때 체크를 해제한다 */
  risk?: boolean;
  /** 줄이 밀려 옮겨졌으면 처음 AI가 말한 줄 */
  from?: number;
  /** 이전 리뷰 이후 파일 이름이 바뀌었으면 옛 경로(`c.file`은 새 경로로 바꿔 둔다) */
  renamed?: string;
  /** 새 커밋에 맞추지 못함(분석 실패·이름 변경을 매핑하지 못함): 이전 줄 그대로는 게시하면 안 되므로 risk와 함께 켠다 */
  lost?: boolean;
}
/** 결과 화면 상태: 요약·잘된 점 체크와 문구, 카드(must → should → info 순), 게시 진행·결과 */
export interface ReviewUi {
  summary: { on: boolean; text: string };
  praise: { on: boolean; text: string } | null;
  cards: CardUi[];
  posting: boolean;
  error: string | null;
  posted: { url: string; n: number } | null;
  /** 새 커밋만 리뷰 결과면: 리뷰한 새 커밋 수(모르면 null), 이전 묶음 펼침, 이전 라운드의 요약(최근 것부터, 읽기 전용) */
  inc?: { n: number | null; open: boolean; prevs: { sha: string; summary: string; praise: string; posted: boolean }[] } | null;
}
export type Run =
  | { status: "loading"; startedAt: number; cancel: () => void }
  | { status: "done"; result: AiPrReview; at: number; ui: ReviewUi }
  | { status: "error"; error: string };
/** 한 PR의 기록. sha = 리뷰한 head(지금 head와 다르면 "오래된 결과") */
export interface Rec {
  /** 시작할 때마다 새로 붙는 번호: 늦게 온 게시 응답이 새 결과에 섞이지 않게 patch가 비교한다 */
  rid: number; sha: string; opts: { model?: string; effort: AiEffort }; run: Run;
  /** 새 커밋만 리뷰가 진행 중(결과는 그대로 보이고 편집도 된다). 취소·실패하면 지우기만 하면 이전 상태 */
  inc?: { startedAt: number; cancel: () => void };
  /** 새 커밋만 리뷰가 실패한 이유(이전 결과는 그대로, 닫을 때까지 보인다) */
  note?: string;
}
/** 새 커밋만 리뷰의 이전 카드 분석: 카드별(요청한 순서) 옮겨진 줄·바뀜·위험. 분석을 못 한 카드는 null */
export interface IncInfo { n: number | null; cards: ({ file: string; renamed?: string; line: number; endLine: number | null; changed: boolean; risk: boolean } | null)[] }

const recs = new Map<string, Rec>();
let ridSeq = 0, cardSeq = 0;
const posting = new Set<string>(); // 게시 확인창이 뜨기 전부터 동기로 거는 잠금(연타로 확인창·게시가 겹치지 않게)
const subs = new Map<string, Set<() => void>>();
export const aiKey = (repo: string, number: number) => `${repo}\0${number}`;
const emit = (key: string) => subs.get(key)?.forEach((f) => f());
const put = (key: string, rec: Rec) => (recs.set(key, rec), emit(key));

/** 결과 → 화면 상태. must·should는 기본 체크, info·잘된 점은 해제. 카드는 레벨 순(같은 레벨은 파일·줄 순) */
function toUi(r: AiPrReview): ReviewUi {
  const order = (c: AiPrComment) => LEVELS.indexOf(c.level);
  const cards = [...r.comments].sort((a, b) => order(a) - order(b) || a.file.localeCompare(b.file) || a.line - b.line).map((c) => ({ id: ++cardSeq, c, on: c.level !== "info", text: c.body, edit: false, ev: false, posted: false, bad: null }));
  return { summary: { on: !!r.summary.trim(), text: r.summary }, praise: r.praise.length ? { on: false, text: r.praise.map((p) => `- ${p}`).join("\n") } : null, cards, posting: false, error: null, posted: null };
}

/** 새 결과(`fresh`)를 위에 두고 이전 카드는 "이전 리뷰"로 합친다. 이전 카드의 게시·편집·체크는 그대로, 밀린 줄은 새 줄로, 위험한 카드는 처음 걸릴 때만 체크를 해제 */
function mergeInc(prev: Extract<Run, { status: "done" }>, prevSha: string, fresh: ReviewUi, info: IncInfo): ReviewUi {
  const old = prev.ui.cards.map((c, i): CardUi => {
    const f = info.cards[i];
    // 분석하지 못한 카드(개별·전체 실패)는 이전 줄 그대로 새 head에 게시되면 안 되므로 위험 + 체크 해제(게시한 카드는 그대로)
    if (!f) return c.posted ? { ...c, old: true } : { ...c, old: true, lost: true, risk: true, on: c.risk ? c.on : false };
    const move = !c.posted && (f.file !== c.c.file || f.line !== c.c.line || f.endLine !== c.c.endLine);
    return {
      ...c,
      old: true,
      changed: c.changed || f.changed,
      ...(move ? { c: { ...c.c, file: f.file, line: f.line, endLine: f.endLine }, from: c.from ?? (f.line !== c.c.line ? c.c.line : undefined) } : {}),
      ...(f.renamed && !c.posted ? { renamed: c.renamed ?? f.renamed } : {}),
      ...(c.posted ? {} : { lost: false, risk: f.risk, on: f.risk && !c.risk ? false : c.on }),
    };
  });
  const p = prev.ui;
  const earlier = (p.inc?.prevs ?? []);
  return { ...fresh, cards: [...fresh.cards, ...old], inc: { n: info.n, open: true, prevs: [{ sha: prevSha, summary: p.summary.text, praise: p.praise?.text ?? "", posted: !!p.posted }, ...earlier] } };
}

export const prAi = {
  get: (key: string) => recs.get(key),
  on: (key: string) => (f: () => void) => {
    const set = subs.get(key) ?? subs.set(key, new Set()).get(key)!;
    set.add(f);
    return () => void set.delete(f);
  },
  /** 시작(같은 PR의 이전 요청은 취소). 취소·동의 거절이면 처음 상태로, 오류는 오류로, 끝나면 결과로 */
  start(key: string, sha: string, call: AiCall<AiPrReview>, opts: Rec["opts"]) {
    const prev = recs.get(key)?.run;
    if (prev?.status === "loading") prev.cancel();
    recs.get(key)?.inc?.cancel();
    const run: Run = { status: "loading", startedAt: Date.now(), cancel: call.cancel };
    const rid = ++ridSeq;
    put(key, { rid, sha, opts, run });
    const cur = () => recs.get(key)?.run === run;
    call.result.then(
      (r) => cur() && (r ? put(key, { rid, sha, opts, run: { status: "done", result: r, at: Date.now(), ui: toUi(r) } }) : (recs.delete(key), emit(key))),
      (e) => cur() && put(key, { rid, sha, opts, run: { status: "error", error: String(e) } }),
    );
  },
  /** 새 커밋만 리뷰(26d): 지금 결과는 그대로 두고 백그라운드로 돌려, 끝나면 새 결과를 "이번 커밋"으로 위에 합친다(이전 카드는 "이전 리뷰"로 남고 게시·편집 유지).
   *  `analyze`는 결과가 오면 이전 카드를 새 head 기준으로 살핀다(밀린 줄·바뀜·게시 위험). 취소·실패하면 이전 결과 그대로(실패는 note로 알린다) */
  startInc(key: string, sha: string, call: AiCall<AiPrReview>, analyze: (r: AiPrReview, old: CardUi[]) => Promise<IncInfo>) {
    const rec = recs.get(key);
    if (rec?.run.status !== "done" || rec.inc) return;
    const inc = { startedAt: Date.now(), cancel: call.cancel };
    put(key, { ...rec, inc, note: undefined });
    const cur = () => recs.get(key)?.inc === inc;
    const end = (note?: string) => {
      const r = recs.get(key);
      if (r) put(key, { ...r, inc: undefined, note });
    };
    call.result.then(
      async (r) => {
        if (!cur()) return;
        if (!r) return end();
        const now = recs.get(key);
        if (now?.run.status !== "done") return end();
        const info = await analyze(r, now.run.ui.cards).catch((): IncInfo => ({ n: null, cards: [] }));
        const last = recs.get(key); // 분석하는 동안 바뀐 편집·체크도 반영한다
        if (!cur() || last?.run.status !== "done") return;
        put(key, { rid: ++ridSeq, sha, opts: last.opts, run: { status: "done", result: r, at: Date.now(), ui: mergeInc(last.run, last.sha, toUi(r), info) } });
      },
      (e) => cur() && end(String(e)),
    );
  },
  cancelInc(key: string) {
    const r = recs.get(key);
    if (!r?.inc) return;
    r.inc.cancel();
    put(key, { ...r, inc: undefined });
  },
  clearNote(key: string) {
    const r = recs.get(key);
    if (r?.note) put(key, { ...r, note: undefined });
  },
  cancel(key: string) {
    const r = recs.get(key)?.run;
    if (r?.status !== "loading") return;
    r.cancel();
    recs.delete(key);
    emit(key);
  },
  /** 결과 화면 상태를 고친다(결과가 있을 때만). 바뀌지 않은 카드는 같은 참조를 유지해 그 카드만 다시 그려진다 */
  patch(key: string, f: (ui: ReviewUi) => ReviewUi, rid?: number) {
    const rec = recs.get(key);
    if (rec?.run.status !== "done" || (rid !== undefined && rec.rid !== rid)) return;
    put(key, { ...rec, run: { ...rec.run, ui: f(rec.run.ui) } });
  },
  /** 게시 잠금: 이미 잠겨 있으면 false. 끝나면(취소·완료·실패 모두) unlock */
  lock: (key: string) => (posting.has(key) ? false : (posting.add(key), true)),
  unlock: (key: string) => void posting.delete(key),
  locked: (key: string) => posting.has(key),
  card(key: string, i: number, p: Partial<CardUi>) {
    prAi.patch(key, (ui) => ({ ...ui, cards: ui.cards.map((c, j) => (j === i ? { ...c, ...p } : c)) }));
  },
};

/** PR 하나의 기록 구독 (AI 패널) */
export const usePrAi = (key: string) => useSyncExternalStore(prAi.on(key), () => recs.get(key));

/** 탭 보조 글·목록 배지용 한 줄 요약: none | loading | error | done:<must 수>[:stale]. 문자열이라 값이 같으면 다시 그리지 않는다 */
/** 필수 수: 이번 결과의 필수 + (새 커밋만 리뷰 뒤) 아직 게시 안 한 이전 필수 */
export const mustCount = (ui: ReviewUi) => ui.cards.filter((c) => c.c.level === "must" && (!c.old || !c.posted)).length;
const afterMemo = new WeakMap<object, Map<string, number | null>>();
/** `commitsAfter`를 타임라인 배열·sha별로 한 번만 계산한다(구독 스냅샷이 이벤트마다 불리므로) */
function newCommits(tl: Parameters<typeof commitsAfter>[0], sha: string) {
  if (!tl) return null;
  const m = afterMemo.get(tl) ?? afterMemo.set(tl, new Map()).get(tl)!;
  if (!m.has(sha)) m.set(sha, commitsAfter(tl, sha));
  return m.get(sha)!;
}
export function aiSummary(key: string, headSha: string, tl?: Parameters<typeof commitsAfter>[0]): string {
  const r = recs.get(key);
  if (!r) return "none";
  if (r.run.status !== "done") return r.run.status;
  if (r.inc) return "loading";
  const stale = r.sha !== headSha;
  return `done:${mustCount(r.run.ui)}${stale ? `:stale:${newCommits(tl, r.sha) ?? ""}` : ""}`;
}
export const useAiSummary = (key: string, headSha: string, tl?: Parameters<typeof commitsAfter>[0]) => useSyncExternalStore(prAi.on(key), () => aiSummary(key, headSha, tl));
