import { Fragment, memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { t, useLocale } from "../../shared/i18n/i18n";
import { ops, store, stored } from "../../shared/model/ops";
import { IS_VSCODE } from "../../shared/api/bridge";
import { isMobile } from "../../shared/lib/platform";
import { onPrefs, pref, setPref } from "../../shared/lib/settings";
import { bigView } from "../../shared/model/bigview";
import { BigButton, type BigCtl } from "../../shared/ui/BigButton";
import { Icon } from "../../shared/ui/Icon";
import { showMenu } from "../../shared/ui/menu";
import { countRender } from "../../shared/lib/profile";
import { langOf } from "../../shared/lib/hlLangs";
import type { Tok } from "../../shared/lib/hl";
import { ImageDiff, type ImageSrc } from "./ImageDiff";
import { isImagePath, isSvg } from "./imagePixels";
import { IbDiff, IbToggle, useIbMode } from "./IbDiff";
import { isIbPath } from "./ibParse";
import { STEP, decodeLines, gapsOf, parseHeader, shownOf, visWs, type Exp, type Span } from "./diffExpand";
import { api } from "../../shared/api/api";

export interface HunkAction {
  label: string;
  /** lines: hunk 본문 기준 줄 번호(0부터). null이면 hunk 전체. */
  run: (hunk: number, lines: number[] | null) => void;
  danger?: boolean;
}

/** 줄에 붙이는 주석(AI 읽는 흐름 등). line은 새 파일 기준, file이 있으면 그 파일의 diff에만 보인다 */
export interface DiffNote {
  file?: string;
  line: number;
  endLine?: number;
  /** 단계 번호(kind "step") */
  n?: number;
  title?: string;
  text: string;
  /** "thread" = PR 리뷰 스레드(26b): 거터는 점, 카드는 `node`(마크다운 등)를 그대로 그린다 */
  kind: "step" | "focus" | "thread";
  node?: ReactNode;
}
/** diff를 이 파일의 새 줄 번호로 스크롤하라는 요청 (seq가 바뀔 때마다 한 번) */
export interface DiffReveal { file: string; line: number; seq: number }
/** 한 줄에 걸린 주석: 거터 표시(badge)·범위에 든 단계 번호(ns)·이 줄 아래에 그릴 카드 */
interface LineNote { badge?: DiffNote; ns: number[]; cards: DiffNote[] }

interface Line {
  t: " " | "+" | "-" | "\\";
  text: string;
  /** 옛·새 줄 번호 (삭제는 o, 추가는 n만) */
  o?: number;
  n?: number;
}
type Range = [number, number];
interface Hunk {
  header: string;
  /** 헤더의 줄 번호 범위 (문맥 펼치기용) */
  span: Span | null;
  lines: Line[];
  /** 짝지은 삭제·추가 줄에서 실제로 바뀐 글자 범위 (줄 번호 → 범위) */
  wd: Map<number, Range>;
}
interface FileInfo {
  path: string;
  oldPath?: string;
  state?: "diff.stateNew" | "diff.stateDeleted" | "diff.stateRenamed" | "diff.stateCopied";
  mode?: string;
}

const unquote = (p: string) => p.replace(/\t.*$/, "").replace(/^"(.*)"$/, "$1");
const strip = (p: string) => (p === "/dev/null" ? null : unquote(p).replace(/^[ab]\//, ""));

function parseHead(head: string[]): FileInfo | null {
  let minus: string | null | undefined, plus: string | null | undefined, git = "";
  const f: Partial<FileInfo> = {};
  let oldMode = "", newMode = "";
  for (const l of head) {
    if (l.startsWith("--- ")) minus = strip(l.slice(4));
    else if (l.startsWith("+++ ")) plus = strip(l.slice(4));
    else if (l.startsWith("diff --git ")) git = l.slice(11);
    else if (l.startsWith("new file mode")) f.state = "diff.stateNew";
    else if (l.startsWith("deleted file mode")) f.state = "diff.stateDeleted";
    else if (l.startsWith("rename from ")) (f.state = "diff.stateRenamed", (f.oldPath = unquote(l.slice(12))));
    else if (l.startsWith("copy from ")) (f.state = "diff.stateCopied", (f.oldPath = unquote(l.slice(10))));
    else if (l.startsWith("old mode ")) oldMode = l.slice(-3);
    else if (l.startsWith("new mode ")) newMode = l.slice(-3);
  }
  if (oldMode && newMode) f.mode = `${oldMode} → ${newMode}`;
  const path = plus ?? minus ?? (git.includes(" b/") ? unquote(git.slice(git.lastIndexOf(" b/") + 3)) : "");
  return path ? { ...f, path } : null;
}

/** 삭제 줄과 바로 이어지는 추가 줄을 순서대로 짝지어, 공통 접두·접미를 뺀 가운데만 강조 범위로 */
function wordDiff(lines: Line[]) {
  const wd = new Map<number, Range>();
  for (let i = 0; i < lines.length; ) {
    if (lines[i].t !== "-") { i++; continue; }
    const d: number[] = [], a: number[] = [];
    while (lines[i]?.t === "-") d.push(i++);
    while (lines[i]?.t === "+") a.push(i++);
    for (let k = 0; k < Math.min(d.length, a.length); k++) {
      const x = lines[d[k]].text, y = lines[a[k]].text, m = Math.min(x.length, y.length);
      if (x.length > 2000 || y.length > 2000) continue;
      let p = 0;
      while (p < m && x[p] === y[p]) p++;
      let s = 0;
      while (s < m - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
      if ((p + s) * 4 < Math.max(x.length, y.length)) continue; // 거의 다른 줄이면 줄 전체가 바뀐 것
      if (x.length - s > p) wd.set(d[k], [p, x.length - s]);
      if (y.length - s > p) wd.set(a[k], [p, y.length - s]);
    }
  }
  return wd;
}

function parse(diff: string) {
  const head: string[] = [];
  const hunks: Hunk[] = [];
  let o = 0, n = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      o = m ? +m[1] : 0;
      n = m ? +m[2] : 0;
      hunks.push({ header: line, span: parseHeader(line), lines: [], wd: new Map() });
    } else if (hunks.length) {
      const t = line[0] === "+" || line[0] === "-" || line[0] === "\\" ? line[0] : " ";
      hunks[hunks.length - 1].lines.push(
        t === "\\" ? { t, text: line } : { t, text: line.slice(1), o: t !== "+" ? o++ : undefined, n: t !== "-" ? n++ : undefined },
      );
    } else if (line) head.push(line);
  }
  // 마지막 빈 줄 제거
  const last = hunks[hunks.length - 1];
  if (last && last.lines[last.lines.length - 1]?.text === "" && last.lines[last.lines.length - 1].t === " ") last.lines.pop();
  for (const h of hunks) h.wd = wordDiff(h.lines);
  return { file: parseHead(head), hunks };
}

interface SplitRow { l: number; r: number; m?: boolean }
/** 나란히 보기: 문맥은 양쪽, 삭제·추가는 같은 순서끼리 한 줄에 */
function pairRows(lines: Line[]) {
  const rows: SplitRow[] = [];
  for (let i = 0; i < lines.length; ) {
    const t = lines[i].t;
    if (t === " " || t === "\\") rows.push({ l: i, r: i, m: t === "\\" }), i++;
    else {
      const d: number[] = [], a: number[] = [];
      while (lines[i]?.t === "-") d.push(i++);
      while (lines[i]?.t === "+") a.push(i++);
      for (let k = 0; k < Math.max(d.length, a.length); k++) rows.push({ l: d[k] ?? -1, r: a[k] ?? -1 });
    }
  }
  return rows;
}

// 보기 방식(한 줄/나란히)은 저장하고, 쓰는 DiffView들이 같이 따른다.
type Mode = "unified" | "split";
let mode: Mode = isMobile ? "unified" : stored<Mode>("diffMode", "unified"); // 모바일은 한 줄 모드 고정(보기 전환 없음)
const subs = new Set<() => void>();
const setMode = (m: Mode) => {
  mode = m;
  store("diffMode", m);
  subs.forEach((f) => f());
};
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));

/** 주석을 diff 줄에 붙인다 (키 "hunk:line"). 범위의 줄은 모두 표시, 첫 줄에 배지, 마지막 줄 아래에 카드. 범위에 든 줄이 없으면(삭제만 있는 곳) 가장 가까운 새 줄에 붙인다 */
function annotate(hunks: Hunk[], notes: DiffNote[]) {
  const out = new Map<string, LineNote>();
  const flat: { k: string; n: number }[] = [];
  hunks.forEach((h, hi) => h.lines.forEach((l, i) => l.n !== undefined && l.t !== "\\" && flat.push({ k: `${hi}:${i}`, n: l.n })));
  if (!flat.length) return out;
  const at = (k: string) => out.get(k) ?? (out.set(k, { ns: [], cards: [] }), out.get(k)!);
  for (const note of notes) {
    const end = Math.max(note.endLine ?? note.line, note.line);
    let hit = flat.filter((f) => f.n >= note.line && f.n <= end);
    if (!hit.length) hit = [flat.find((f) => f.n >= note.line) ?? flat[flat.length - 1]];
    hit.forEach((f, j) => {
      const e = at(f.k);
      if (note.n !== undefined) e.ns.push(note.n);
      if (j === 0 && (!e.badge || (e.badge.kind === "focus" && note.kind === "step"))) e.badge = note;
    });
    at(hit[hit.length - 1].k).cards.push(note);
  }
  return out;
}

const IB_TOGGLE = <IbToggle />; // 모듈 상수: IbDiff에 넘기는 참조가 늘 같다
const NO_EXP: Record<number, Exp> = {}; // 모듈 상수: 펼친 게 없을 때 참조가 늘 같다
const BASE = 2000; // 처음 그리는 줄 수. 끝에 닿으면 더 그린다 (수만 줄 diff가 DOM을 한꺼번에 만들지 않게)
const HL_CHUNK = 400; // 펼친 줄 구문 강조를 한 번에 돌리는 줄 수
const HL_MAX = 6000; // 이 줄 수를 넘는 diff는 구문 강조를 하지 않는다

/** hunk의 옛쪽·새쪽을 각각 한 덩어리로 강조해 줄별 토큰으로 (hunk 안의 여러 줄 주석·문자열이 이어진다) */
function hunkTokens(h: Hunk, lang: string, hl: (lang: string, code: string) => Tok[][]) {
  const side = (keep: string) => hl(lang, h.lines.filter((l) => keep.includes(l.t)).map((l) => l.text).join("\n"));
  const old = side(" -"), nu = side(" +");
  let oi = 0, ni = 0;
  return h.lines.map((l) => (l.t === "\\" ? undefined : l.t === "-" ? old[oi++] : l.t === "+" ? nu[ni++] : (oi++, nu[ni++])));
}

function Code({ text, toks, wd, ws }: { text: string; toks?: Tok[]; wd?: Range; ws?: boolean }) {
  if (toks && toks.map((t) => t[1]).join("") !== text) toks = undefined;
  if (!toks && !wd) return <>{ws ? visWs(text) : text}</>;
  const out: (string | JSX.Element)[] = [];
  let pos = 0;
  const push = (cls: string, s: string, hi: boolean) => {
    if (!s) return;
    const c = ws ? visWs(s) : s;
    out.push(cls || hi ? <span key={out.length} className={(cls ? "hl-" + cls : "") + (hi ? " wd" : "")}>{c}</span> : ws ? <Fragment key={out.length}>{c}</Fragment> : s);
  };
  for (const [cls, t] of toks ?? [["", text] as Tok]) {
    const end = pos + t.length;
    const a = wd ? Math.min(Math.max(wd[0], pos), end) : pos;
    const b = wd ? Math.min(Math.max(wd[1], pos), end) : pos;
    push(cls, t.slice(0, a - pos), false);
    push(cls, t.slice(a - pos, b - pos), true);
    push(cls, t.slice(b - pos), false);
    pos = end;
  }
  return <>{out}</>;
}

const cls = (t: Line["t"]) => (t === "+" ? "add" : t === "-" ? "del" : t === "\\" ? "meta" : "");
interface CellP { line: Line; toks?: Tok[]; wd?: Range; picked: boolean; h: number; i: number; nt?: LineNote; cur?: boolean; ws?: boolean }

/** 거터 배지: 단계는 번호 원, 집중해서 볼 곳은 점 */
const Badge = ({ nt }: { nt: LineNote }) =>
  !nt.badge ? null : nt.badge.kind === "step" ? <span className="nb" title={nt.badge.title}>{nt.badge.n}</span> : <span className="nb dot" title={nt.badge.text} />;
const noted = (nt?: LineNote, cur?: boolean) => (nt ? " nr" + (cur ? " cur" : "") : "");

const URow = memo(function URow({ line, toks, wd, picked, h, i, nt, cur, ws }: CellP) {
  return (
    <div className={"dl " + cls(line.t) + (picked ? " picked" : "") + noted(nt, cur)} data-h={h} data-i={i}>
      {nt && <Badge nt={nt} />}
      <span className="ln">{line.o}</span>
      <span className="ln">{line.n}</span>
      {line.t === "\\" ? <span className="code">{line.text}</span> : (
        <>
          <span className="sg">{line.t === " " ? "" : line.t}</span>
          <span className="code"><Code text={line.text} toks={toks} wd={wd} ws={ws} /></span>
        </>
      )}
    </div>
  );
});

const SCell = memo(function SCell({ line, toks, wd, picked, h, i, side, nt, cur, ws }: CellP & { side: "o" | "n" }) {
  if (side === "o") nt = undefined; // 주석은 새 쪽에만
  return (
    <div className={"sc " + cls(line.t) + (picked ? " picked" : "") + noted(nt, cur)} data-h={h} data-i={i}>
      {nt && <Badge nt={nt} />}
      <span className="ln">{line[side]}</span>
      <span className="code"><Code text={line.text} toks={toks} wd={wd} ws={ws} /></span>
    </div>
  );
});

/** 펼친 줄(hunk 밖 문맥): 줄 번호만 있고 고르기·주석·스테이지 대상이 아니다 (data-i가 없어 클릭 위임에 안 걸린다) */
interface XP { text: string; n: number; d: number; toks?: Tok[]; ws?: boolean }
const XRow = memo(function XRow({ text, n, d, toks, ws }: XP) {
  return (
    <div className="dl xl" data-xn={n}>
      <span className="ln">{n - d}</span>
      <span className="ln">{n}</span>
      <span className="sg"></span>
      <span className="code"><Code text={text} toks={toks} ws={ws} /></span>
    </div>
  );
});
const XCell = memo(function XCell({ text, n, d, toks, ws, side }: XP & { side: "o" | "n" }) {
  return (
    <div className="sc xl" data-xn={n}>
      <span className="ln">{side === "o" ? n - d : n}</span>
      <span className="code"><Code text={text} toks={toks} ws={ws} /></span>
    </div>
  );
});

/** 숨은 줄 자리의 "↕ N줄 펼치기" 행. 위/아래 버튼은 그쪽에 이웃한 hunk가 있을 때만 */
const ExpandRow = memo(function ExpandRow({ gi, hidden, up, down, onExpand }: { gi: number; hidden: number; up: boolean; down: boolean; onExpand: (gi: number, dir: "up" | "down" | "all") => void }) {
  useLocale();
  return (
    <div className="xrow" role="group">
      <span className="xlabel">{t("diff.expandHidden", { n: hidden })}</span>
      {up && <button className="tool-txt" onClick={() => onExpand(gi, "up")}>{t("diff.expandUp", { n: Math.min(STEP, hidden) })}</button>}
      {down && <button className="tool-txt" onClick={() => onExpand(gi, "down")}>{t("diff.expandDown", { n: Math.min(STEP, hidden) })}</button>}
      <button className="tool-txt" onClick={() => onExpand(gi, "all")}>{t("diff.expandAll")}</button>
    </div>
  );
});

/** 줄 아래 인라인 설명 카드. 현재 단계는 강조 */
const NoteCards = memo(function NoteCards({ list, cur }: { list: DiffNote[]; cur?: number }) {
  return (
    <div className="note-wrap">
      {list.map((n, k) => (
        <div key={k} className={"note-card " + n.kind + (n.n !== undefined && n.n === cur ? " cur" : "")} role="note" data-n={n.n}>
          {n.title && <div className="note-title">{n.n !== undefined ? t("diff.noteStep", { n: n.n, title: n.title }) : n.title}</div>}
          {n.node ?? <div className="note-text">{n.text}</div>}
        </div>
      ))}
    </div>
  );
});

/**
 * diff 표시: 파일 머리줄, 줄 번호 두 칸, 단어 단위 강조, 구문 강조, 한 줄/나란히 보기.
 * VS Code 모드에서 `rev`가 있으면(커밋 id, 작업 디렉터리는 null) 줄을 더블클릭해 편집기의 그 줄로 연다.
 * `actions`가 있으면 hunk마다 버튼을 달고, 바뀐 줄을 눌러 골라서 고른 줄만 처리할 수 있다 (Shift: 범위 선택).
 * `image`가 있고 파일이 이미지 확장자면 이미지 비교(ImageDiff)로 바꾼다 (svg는 이미지/텍스트 전환).
 * `image`가 있고 .xib/.storyboard면 시각 diff(IbDiff)가 기본이고 "Raw"로 이 텍스트 diff를 본다.
 * `notes`가 있으면 해당 줄에 거터 배지·범위 강조·아래 설명 카드를 단다(이 파일 것만, 이미지·xib 뷰어에서는 생략). `current`는 강조할 단계 번호,
 * `reveal`은 새 줄 번호로 스크롤(seq가 바뀔 때 한 번). features를 알지 못하므로 부모가 prop으로만 준다.
 * 머리줄 도구줄(25e): Blame·히스토리(`onInspect`, 없으면 숨김)·공백 무시·줄바꿈(저장되는 설정)·이전/다음 변경 hunk(⌥↑/⌥↓, 입력창 무시)·한 줄/나란히·크게 보기.
 * 좁으면(컨테이너 폭) Blame·히스토리·공백 무시·줄바꿈이 ⋯ 메뉴로 들어간다.
 */
export const DiffView = memo(function DiffView({ diff, actions, rev, image, notes, current, reveal, onInspect, bigCtl }: { diff: string; actions?: HunkAction[]; rev?: string | null; image?: ImageSrc; notes?: DiffNote[]; current?: number; reveal?: DiffReveal; onInspect?: (kind: "blame" | "history", path: string) => void; /** 앱 크게 보기 대신 다른 제어를 쓰거나(BigCtl), null이면 머리줄에 크게 보기 버튼을 두지 않는다(시트 안 diff) */ bigCtl?: BigCtl | null }) {
  countRender("DiffView");
  const loc = useLocale();
  const { file, hunks } = useMemo(() => parse(diff), [diff]);
  const view = useSyncExternalStore(subscribe, () => mode);
  const ignoreWs = useSyncExternalStore(onPrefs, () => pref("ignoreWs"));
  const wrap = useSyncExternalStore(onPrefs, () => pref("diffWrap"));
  const ibMode = useIbMode();
  const showWs = useSyncExternalStore(onPrefs, () => pref("diffWs"));
  const full = useSyncExternalStore(onPrefs, () => pref("diffFull"));
  const rows = useMemo(() => (view === "split" ? hunks.map((h) => pairRows(h.lines)) : null), [hunks, view]);
  const path = file?.path ?? "";
  const pre = useRef<HTMLPreElement>(null);
  const [svgText, setSvgText] = useState<string | null>(null); // 텍스트 diff로 보기로 한 svg 경로
  const lineNotes = useMemo(() => {
    const mine = notes?.filter((n) => n.file === undefined || n.file === path);
    return mine?.length ? annotate(hunks, mine) : null;
  }, [hunks, notes, path]);
  // 고른 줄: "hunk:line"
  const [picked, setPicked] = useState<{ hunk: number; lines: Set<number>; anchor: number } | null>(null);
  // 더 그릴 줄 수 (diff가 바뀌면 처음부터)
  const [more, setMore] = useState({ diff, n: BASE });
  const budget = more.diff === diff ? more.n : BASE;
  const [hl, setHl] = useState<{ diff: string; toks: (Tok[] | undefined)[][] } | null>(null);

  // ---- 문맥 펼치기·파일 전체 (25f): 펼친 상태는 이 컴포넌트 안에만 둔다. 새 쪽 파일은 처음 필요할 때 한 번 읽고(버전 v가 바뀌면 다시), 줄 계산은 useMemo ----
  // 새·삭제 파일은 숨은 줄이 없고, 이미지(뷰어)·xib 뷰어는 텍스트 diff가 아니다. image가 없으면 파일을 읽을 방법이 없다
  const expOk0 = !!image && !!file && hunks.length > 0 && hunks.every((h) => h.span) && file.state !== "diff.stateNew" && file.state !== "diff.stateDeleted"
    && (!isImagePath(file.path) || (isSvg(file.path) && svgText === file.path)) && !(isIbPath(file.path) && ibMode === "viewer");
  const [exp, setExp] = useState<{ diff: string; g: Record<number, Exp> }>({ diff, g: {} });
  const gx = exp.diff === diff ? exp.g : NO_EXP;
  const touched = Object.keys(gx).length > 0;
  const use = expOk0 && (full || touched);
  const fkey = image && file ? `${image.repo}|${image.after}|${file.path}` : "";
  const [ft, setFt] = useState<{ key: string; v: unknown; lines: string[] | null } | null>(null);
  const cur = ft && ft.key === fkey && ft.v === image?.v ? ft : null;
  // diff를 그린 뒤 한가할 때 파일을 미리 한 번 읽어 줄 수를 안다 (맨 끝 숨은 줄 행은 줄 수를 알아야 보인다)
  const idleKey = `${diff.length}|${fkey}`;
  const [idle, setIdle] = useState<string | null>(null);
  const loaded = !!cur;
  useEffect(() => {
    if (!expOk0 || loaded) return;
    const w = window as { requestIdleCallback?: (f: () => void) => number; cancelIdleCallback?: (h: number) => void };
    const go = () => setIdle(idleKey);
    const h = w.requestIdleCallback ? w.requestIdleCallback(go) : window.setTimeout(go, 200);
    return () => (w.requestIdleCallback ? w.cancelIdleCallback?.(h) : window.clearTimeout(h));
  }, [expOk0, loaded, idleKey]);
  const want = use || (expOk0 && idle === idleKey);
  useEffect(() => {
    if (!want || cur || !image) return;
    let live = true;
    const done = (lines: string[] | null) => live && setFt({ key: fkey, v: image.v, lines });
    api.fileBlob(image.repo, image.after, path).then((b) => done(decodeLines(b)), () => done(null));
    return () => void (live = false);
  }, [want, cur, fkey, image, path]);
  const lines = cur?.lines ?? null;
  const unreadable = expOk0 && !!cur && !cur.lines; // 바이너리·20MB 초과·없음: 펼치기 행 대신 첫 자리에 안내 한 줄
  const expOk = expOk0 && !unreadable;
  const gaps = useMemo(() => (expOk0 ? gapsOf(hunks.map((h) => h.span!), lines ? lines.length : null) : null), [expOk0, hunks, lines]);
  const all = full && !!lines;
  const shown = useMemo(() => gaps?.map((g, gi) => (g.size === null ? null : shownOf(g.size, gx[gi], all))) ?? null, [gaps, gx, all]);
  const extraLines = lines && use ? lines : null;
  // 펼친 줄의 구문 강조: 실제로 펼친 구간만, 400줄 단위로 쪼개 돌린다 (큰 파일도 펼친 곳엔 색이 들어가고 메인 스레드를 오래 막지 않는다). 줄 번호별 캐시
  const hlc = useRef<{ lines: string[] | null; m: Map<number, Tok[]> }>({ lines: null, m: new Map() });
  if (hlc.current.lines !== lines) hlc.current = { lines, m: new Map() };
  const [, setHlTick] = useState(0);
  useEffect(() => {
    const lang = langOf(path);
    if (!lines || !lang || !shown || !gaps) return;
    const cache = hlc.current.m;
    const todo: number[] = [];
    shown.forEach((sh, gi) => {
      const g = gaps[gi];
      if (!sh || !g || g.size === null) return;
      const spans = [[g.n, g.n + sh.top - 1], [g.n + g.size - sh.bot, g.n + g.size - 1]];
      for (const [a, b] of spans) for (let n = a; n <= Math.min(b, lines.length); n++) if (!cache.has(n)) todo.push(n);
    });
    if (!todo.length) return;
    let dead = false;
    import("../../shared/lib/hl").then(async ({ highlightLines }) => {
      for (let k = 0; k < todo.length && !dead; ) {
        let e = k + 1;
        while (e < todo.length && e - k < HL_CHUNK && todo[e] === todo[e - 1] + 1) e++;
        const toks = highlightLines(lang, todo.slice(k, e).map((n) => lines[n - 1]).join("\n"));
        todo.slice(k, e).forEach((n, i) => cache.set(n, toks[i]));
        k = e;
        if (!dead) setHlTick((t) => t + 1);
        await new Promise((r) => setTimeout(r));
      }
    });
    return () => void (dead = true);
  }, [lines, shown, gaps, path]);
  // 나란히 + 줄바꿈 끔: 두 쪽 열 폭을 가장 긴 줄에 맞춰(--cw) 한 덩어리로 가로 스크롤한다
  const cw = useMemo(() => {
    const m = hunks.reduce((m, h) => h.lines.reduce((n, l) => Math.max(n, l.text.length), m), 0);
    return (extraLines ? extraLines.reduce((n, l) => Math.max(n, l.length), m) : m) + 9;
  }, [hunks, extraLines]);
  // 방향은 화면 기준: "up" = 숨은 구간의 아래쪽(다음 hunk에 이웃한 줄)을 위로 펼침 = [1] 증가, "down" = 위쪽(앞 hunk에 이웃한 줄)을 아래로 펼침 = [0] 증가
  const onExpand = useCallback((gi: number, dir: "up" | "down" | "all") => {
    setExp((p) => {
      const g = { ...(p.diff === diff ? p.g : {}) };
      const e = g[gi] ?? [0, 0];
      g[gi] = dir === "all" ? [Infinity, 0] : dir === "down" ? [e[0] + STEP, e[1]] : [e[0], e[1] + STEP];
      return { diff, g };
    });
  }, [diff]);

  // 요청받은 줄로 스크롤 (diff가 아직 이전 파일이면 새 파일 diff가 올 때까지 기다린다). 한 요청은 한 번만.
  // 그 줄이 아직 안 그린(접힌) 구간이면 거기까지 펼친 뒤 스크롤한다
  const revealed = useRef(0);
  useEffect(() => {
    const el = pre.current;
    if (!reveal || reveal.seq === revealed.current || reveal.file !== path || !el) return;
    let best: [number, number] | null = null, near = Infinity, last: [number, number] | null = null;
    hunks.forEach((h, hi) => h.lines.forEach((l, i) => {
      if (l.n === undefined) return;
      last = [hi, i];
      const d = l.n >= reveal.line ? l.n - reveal.line : Infinity;
      if (d < near) (near = d), (best = [hi, i]);
    }));
    const at = best ?? last;
    if (!at) return void (revealed.current = reveal.seq);
    const xs = shown ? shown.slice(0, at[0] + 1).reduce((n, g) => n + (g ? g.top + g.bot : 0), 0) : 0; // 앞쪽에 펼친 줄
    const need = hunks.slice(0, at[0]).reduce((n, h) => n + h.lines.length, 0) + at[1] + 1 + xs; // 줄 수는 나란히의 행 수 이상
    if (need > budget) return setMore({ diff, n: need + 40 }); // 다음 렌더에서 다시 시도
    revealed.current = reveal.seq;
    const row = el.querySelector<HTMLElement>(`[data-h="${at[0]}"][data-i="${at[1]}"]`);
    if (row) el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientHeight / 3;
  }, [reveal, path, hunks, budget, shown]);

  // 구문 강조는 줄이 많지 않을 때만, 강조 모듈을 늦게 불러와 hunk 단위로 쪼개 돌린다 (메인 스레드를 오래 막지 않게)
  useEffect(() => {
    const lang = langOf(path);
    const total = hunks.reduce((s, h) => s + h.lines.length, 0);
    if (!lang || !total || total > HL_MAX) return;
    let dead = false;
    import("../../shared/lib/hl").then(async ({ highlightLines }) => {
      const toks: (Tok[] | undefined)[][] = [];
      for (const h of hunks) {
        if (dead) return;
        toks.push(hunkTokens(h, lang, highlightLines));
        await new Promise((r) => setTimeout(r));
      }
      if (!dead) setHl({ diff, toks });
    });
    return () => void (dead = true);
  }, [diff, hunks, path]);

  // 이전/다음 변경 hunk: 머리줄 바로 아래로 hunk 머리를 올린다 (현재 위치는 스크롤 위치에서 읽는다). 아직 안 그린 hunk면 더 그린 뒤 이어서 간다
  const wantNav = useRef<1 | -1 | 0>(0);
  const stepHunk = (dir: 1 | -1) => {
    const el = pre.current;
    if (!el) return;
    const top = el.getBoundingClientRect().top + (el.querySelector<HTMLElement>(".diff-file")?.offsetHeight ?? 0);
    const offs = [...el.querySelectorAll<HTMLElement>(".hunk")].map((h) => h.getBoundingClientRect().top - top);
    const to = dir > 0 ? offs.find((o) => o > 2) : offs.filter((o) => o < -2).pop();
    if (to !== undefined) el.scrollTop += to;
    else if (dir > 0 && offs.length < hunks.length) (wantNav.current = 1, setMore({ diff, n: budget + BASE }));
  };
  const stepRef = useRef(stepHunk);
  stepRef.current = stepHunk;
  useEffect(() => {
    if (wantNav.current) stepRef.current(wantNav.current), (wantNav.current = 0);
  }, [budget]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]") || !pre.current) return;
      // 맨 위 화면(시트 > PR 리뷰 화면) 안의 diff만 반응하고, 숨긴 패널(visibility:hidden)의 diff는 반응하지 않는다
      const top = document.querySelector(".sheet-backdrop") ?? document.querySelector(".prr");
      if ((top && !top.contains(pre.current)) || getComputedStyle(pre.current).visibility === "hidden") return;
      e.preventDefault();
      stepRef.current(e.key === "ArrowDown" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 끝에 닿으면 더 그린다
  const seen = useRef<IntersectionObserver>();
  const sentinel = (el: HTMLElement | null) => {
    seen.current?.disconnect();
    if (!el) return;
    seen.current = new IntersectionObserver((e) => e[0].isIntersecting && setMore({ diff, n: budget + BASE }), { rootMargin: "800px" });
    seen.current.observe(el);
  };

  const slash = file ? file.path.lastIndexOf("/") + 1 : 0;
  // ImageDiff·IbDiff(memo)에 넘기는 머리·추가 요소는 파일·언어가 바뀔 때만 새로 만든다 (참조가 안정적이어야 memo가 먹는다)
  const head = useMemo(
    () =>
      file && (
        <>
          <span className="diff-path" title={file.path} onDoubleClick={bigCtl === null ? undefined : bigCtl ? bigCtl.toggle : bigView.toggle}>
            <span className="dir">{file.path.slice(0, slash)}</span>
            <b>{file.path.slice(slash)}</b>
          </span>
          {file.state && <span className="diff-tag">{t(file.state)}{file.oldPath ? ` · ${file.oldPath}` : ""}</span>}
          {file.mode && <span className="diff-tag">{t("diff.mode", { mode: file.mode })}</span>}
        </>
      ),
    [file, slash, loc, bigCtl],
  );
  const svg = !!image && !!file && isSvg(file.path);
  const asText = svg && svgText === file!.path;
  const toggleWs = () => setPref("ignoreWs", !ignoreWs);
  const toggleWrap = () => setPref("diffWrap", !wrap);
  const toggleShowWs = () => setPref("diffWs", !showWs);
  const moreMenu = () =>
    showMenu([
      ...(onInspect && file ? [{ label: t("diff.blame"), action: () => onInspect("blame", file.path) }, { label: t("diff.history"), action: () => onInspect("history", file.path) }, { separator: true as const }] : []),
      { label: t("diff.ignoreWs"), checked: ignoreWs, action: toggleWs },
      { label: t("diff.wrap"), checked: wrap, action: toggleWrap },
      { label: t("diff.showWs"), checked: showWs, action: toggleShowWs },
    ]);
  const svgToggle = useMemo(
    () =>
      svg && (
        <div className="segmented" role="radiogroup" aria-label={t("diff.svgView")}>
          {[false, true].map((x) => (
            <button key={String(x)} role="radio" aria-checked={asText === x} onClick={() => setSvgText(x ? file!.path : null)}>{x ? t("diff.asText") : t("diff.asImage")}</button>
          ))}
        </div>
      ),
    [svg, asText, file?.path, loc],
  );
  if (image && file && isImagePath(file.path) && !asText) return <ImageDiff image={image} path={file.path} oldPath={file.oldPath} head={head} extra={svgToggle} />;
  const ib = !!image && !!file && isIbPath(file.path); // xib/storyboard: 뷰어(기본) / Raw(아래 텍스트 diff)
  if (ib && ibMode === "viewer") return <IbDiff image={image!} path={file!.path} oldPath={file!.oldPath} head={head} extra={IB_TOGGLE} />;

  if (!diff) return <pre className="diff" />;
  if (!hunks.length && /^(Binary files|GIT binary patch)/m.test(diff)) return <pre className="diff"><div className="meta bin">{t("diff.binary")}</div></pre>;

  const pick = (h: number, i: number, shift: boolean) => {
    if (!actions || !"+-".includes(hunks[h].lines[i]?.t ?? "")) return;
    setPicked((p) => {
      const lines = new Set(p?.hunk === h ? p.lines : []);
      if (shift && p?.hunk === h) {
        const [a, b] = [Math.min(p.anchor, i), Math.max(p.anchor, i)];
        for (let k = a; k <= b; k++) if ("+-".includes(hunks[h].lines[k].t)) lines.add(k);
      } else lines.has(i) ? lines.delete(i) : lines.add(i);
      return lines.size ? { hunk: h, lines, anchor: i } : null;
    });
  };
  const onDown = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
    if (el) pick(+el.dataset.h!, +el.dataset.i!, e.shiftKey);
  };

  // 더블클릭한 줄의 새 파일 기준 줄 번호(삭제 줄은 이어지는 새 줄, 없으면 앞쪽 마지막 새 줄)
  const onOpen = (e: React.MouseEvent) => {
    const x = (e.target as HTMLElement).closest<HTMLElement>("[data-xn]"); // 펼친 줄: 새 줄 번호 그대로
    if (x && file) return void ops.openInEditor(file.path, rev ?? null, +x.dataset.xn!);
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
    if (!el || !file) return;
    const ls = hunks[+el.dataset.h!]?.lines;
    const i = +el.dataset.i!;
    const line = ls?.[i]?.n ?? ls?.slice(i).find((l) => l.n)?.n ?? ls?.slice(0, i).reverse().find((l) => l.n)?.n;
    ops.openInEditor(file.path, rev ?? null, line);
  };

  let left = budget, truncated = false;
  // 숨은 구간 gi(0 = 첫 hunk 앞, hunks.length = 마지막 뒤)의 펼친 줄 + "↕ N줄 펼치기" 행. 펼친 줄도 그리는 줄 수 예산(left)을 쓴다
  const xline = (n: number, d: number) => {
    if (left <= 0) return void (truncated = true);
    left--;
    const text = lines![n - 1], toks = hlc.current.m.get(n);
    return rows ? (
      <div key={n} className="sr">
        <XCell text={text} n={n} d={d} toks={toks} ws={showWs} side="o" />
        <XCell text={text} n={n} d={d} toks={toks} ws={showWs} side="n" />
      </div>
    ) : <XRow key={n} text={text} n={n} d={d} toks={toks} ws={showWs} />;
  };
  const firstGi = unreadable && gaps ? gaps.findIndex((g) => g.size !== 0) : -1;
  const gapNodes = (gi: number) => {
    if (unreadable) return gi === firstGi ? <div key="xnote" className="xrow xnote">{t("diff.expandFail")}</div> : null;
    const g = gaps?.[gi];
    if (!g || !g.size) return null; // 0 = 숨은 줄 없음, null = 줄 수를 아직 모름(맨 끝)
    const sh = shown?.[gi];
    const top: (JSX.Element | void)[] = [], bot: (JSX.Element | void)[] = [];
    if (sh && lines) {
      for (let k = 0; k < sh.top; k++) top.push(xline(g.n + k, g.d));
      for (let k = sh.bot; k > 0; k--) bot.push(xline(g.n + g.size! - k, g.d));
    }
    const hidden = sh ? sh.hidden : 0;
    return (
      <>
        {top}
        {hidden > 0 && <ExpandRow gi={gi} hidden={hidden} up={gi < hunks.length} down={gi > 0} onExpand={onExpand} />}
        {bot}
      </>
    );
  };
  return (
    <pre ref={pre} className={"diff selectable " + view + (lineNotes ? " noted" : "") + (wrap ? " wrap" : "") + (showWs ? " showws" : "")} style={view === "split" && !wrap ? ({ "--cw": `${cw}ch` } as React.CSSProperties) : undefined} onMouseDown={onDown} onDoubleClick={IS_VSCODE && rev !== undefined ? onOpen : undefined}>
      <div className="diff-file">
        {head}
        {svgToggle}
        {ib && <IbToggle />}
        <div className="diff-tools" role="toolbar" aria-label={t("diff.tools")}>
          <span className="tools-wide">
            {onInspect && file && (
              <>
                <button className="tool-txt" onClick={() => onInspect("blame", file.path)}>{t("diff.blame")}</button>
                <button className="tool-txt" onClick={() => onInspect("history", file.path)}>{t("diff.history")}</button>
              </>
            )}
            <button className="tool-txt" aria-pressed={ignoreWs} onClick={toggleWs}>{t("diff.ignoreWs")}</button>
            <button className="tool-txt" aria-pressed={wrap} onClick={toggleWrap}>{t("diff.wrap")}</button>
            <button className="tool-txt" aria-pressed={showWs} onClick={toggleShowWs}>{t("diff.showWs")}</button>
          </span>
          <button className="tool-ico tools-more" title={t("diff.tools")} aria-label={t("diff.tools")} onClick={moreMenu}><Icon name="more" size={14} /></button>
          {hunks.length > 0 && (
            <span className="tool-pair">
              <button className="tool-ico" title={t("diff.prevHunk")} aria-label={t("diff.prevHunk")} onClick={() => stepHunk(-1)}><Icon name="arrowUp" size={14} /></button>
              <button className="tool-ico" title={t("diff.nextHunk")} aria-label={t("diff.nextHunk")} onClick={() => stepHunk(1)}><Icon name="arrowDown" size={14} /></button>
            </span>
          )}
          {expOk && (
            <div className="segmented" role="radiogroup" aria-label={t("diff.scope")}>
              {[false, true].map((f) => (
                <button key={String(f)} role="radio" aria-checked={full === f} onClick={() => setPref("diffFull", f)}>{f ? t("diff.scopeFull") : t("diff.scopeDiff")}</button>
              ))}
            </div>
          )}
          <div className="segmented" role="radiogroup" aria-label={t("diff.view")}>
            {(["unified", "split"] as const).map((m) => (
              <button key={m} role="radio" aria-checked={view === m} onClick={() => setMode(m)}>
                {m === "unified" ? t("diff.unified") : t("diff.split")}
              </button>
            ))}
          </div>
          {bigCtl !== null && <BigButton ctl={bigCtl} />}
        </div>
      </div>
      {hunks.map((h, hi) => {
        const sel = picked?.hunk === hi ? picked.lines : null;
        const toks = hl?.diff === diff ? hl.toks[hi] : undefined;
        const before = gapNodes(hi);
        const items = rows ? rows[hi] : h.lines;
        const take = Math.min(items.length, left);
        left -= take;
        if (take < items.length) truncated = true;
        const cell = (i: number) => {
          const nt = lineNotes?.get(`${hi}:${i}`);
          return { line: h.lines[i], toks: toks?.[i], wd: h.wd.get(i), picked: !!sel?.has(i), ws: showWs, h: hi, i, nt, cur: nt && current !== undefined ? nt.ns.includes(current) : undefined };
        };
        const cards = (i: number) => {
          const c = lineNotes?.get(`${hi}:${i}`)?.cards;
          return c && <NoteCards list={c} cur={current} />;
        };
        return (
          <div key={hi} className="hunk-block">
            {before}
            <div className="hunk">
              <span className="hunk-title">{h.header}</span>
              {actions?.map((a) => (
                <button
                  key={a.label}
                  className={"hunk-btn" + (a.danger ? " hunk-danger" : "")}
                  onClick={() => {
                    a.run(hi, sel ? [...sel].sort((x, y) => x - y) : null);
                    setPicked(null);
                  }}
                >
                  {sel ? t("diff.selLines", { label: a.label }) : t("diff.hunk", { label: a.label })}
                </button>
              ))}
            </div>
            {rows
              ? rows[hi].slice(0, take).map((r, k) =>
                  r.m ? (
                    <div key={k} className="sm meta">{h.lines[r.l].text}</div>
                  ) : (
                    <Fragment key={k}>
                      <div className="sr">
                        {r.l < 0 ? <div className="sc empty" /> : <SCell key="l" {...cell(r.l)} side="o" />}
                        {r.r < 0 ? <div className="sc empty" /> : <SCell key="r" {...cell(r.r)} side="n" />}
                      </div>
                      {r.r >= 0 && cards(r.r)}
                    </Fragment>
                  ),
                )
              : h.lines.slice(0, take).map((_, i) => (
                  <Fragment key={i}>
                    <URow {...cell(i)} />
                    {cards(i)}
                  </Fragment>
                ))}
            {hi === hunks.length - 1 && gapNodes(hunks.length)}
          </div>
        );
      })}
      {truncated && <div ref={sentinel} className="diff-more meta">{t("diff.loadingMore")}</div>}
    </pre>
  );
});
