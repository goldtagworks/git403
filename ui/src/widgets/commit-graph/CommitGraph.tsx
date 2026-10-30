import { t, dateFmt, useLocale } from "../../shared/i18n/i18n";
import { isMobile } from "../../shared/lib/platform";
import { Sha } from "../../shared/ui/Sha";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { contextMenu, type MenuEntry } from "../../shared/ui/menu";
import { api } from "../../shared/api/api";
import { COMPACT, openFull } from "../../shared/api/bridge";
import { tip } from "../../shared/model/tip";
import { relTime } from "../../shared/lib/reltime";
import { CommitTip } from "./CommitTip";
import { isHiddenRef, useHiddenSet } from "../../shared/lib/hidden";
import { ctx, ops } from "../../shared/model/ops";
import { resetMenu, stashMenu } from "../../shared/model/menus";
import { startInteractiveRebase } from "../../features/rebase/RebaseSheet";
import { startReword } from "../../features/rebase/Reword";
import { WORKTREE, type Commit, type GraphView, type Ref } from "../../shared/api/types";
import { countRender } from "../../shared/lib/profile";
import { bigView } from "../../shared/model/bigview";
import { token } from "../../shared/lib/theme";
import { Icon } from "../../shared/ui/Icon";
import { useSplit } from "../../shared/ui/Splitter";
import { pick, useFocusRef } from "../../shared/model/selection";
import { Avatar, avatarImage, avatarUrl, onAvatarChange, requestAvatars } from "../../shared/ui/avatar";

const ROW_H = COMPACT ? 44 : isMobile ? 40 : 28; // compact(VS Code 사이드바·패널): 두 줄 행, 모바일: 터치 타깃
const COMPACT_GRAPH_MAX = 72; // compact 그래프 열 상한 (넘는 레인은 페이드로 잘린다)
const LANE_W = 22;
const AUTO_MAX = 120; // 자동 폭 상한 (더 넓게는 사용자가 끌어서)
const FIT_ROWS = 300; // 자동 폭·레인 간격은 최근 이만큼의 행에 쓰인 레인 수로 정한다 (오래된 역사의 넓은 레인에 끌려가지 않게, 넘치는 레인은 페이드로 잘린다)
const LANE_MIN = 8; // 그래프 열이 좁으면 레인 간격을 여기까지 줄인다 (그래도 넘치면 오른쪽을 잘라 페이드)
const FADE_W = 18;
const MERGE_R = 4; // 머지 커밋: 작은 채운 점
const AVATAR_R = 11; // 일반 커밋: 사진(없으면 이니셜) 원형 노드
const PAD = 12;
const PALETTE_N = 8; // style.css --graph 색 개수. 행 틴트용 --g0..--g7로 내보낸다
const LINE_W = 2.5;
const BUCKET = 10; // 스크롤은 이 행 수 단위로만 React 상태에 반영한다 (위아래 오버스캔도 같은 값)
const DIM = 0.28; // 검색에서 일치하지 않는 행의 투명도

/** 커밋 하나의 ref 라벨 칩: 첫 ref + "+N". 로컬과 같은 이름의 원격은 칩 안에 아이콘으로 합친다.
 *  원격 칩은 원격 이름(`origin/`)을 떼고, 위치는 이름 뒤 아이콘(노트북 = 로컬, 구름 = 원격)으로 보인다. */
interface Chip { name: string; label: string; kind: Ref["kind"]; head: boolean; paired: boolean; extra: number; title: string }
const chipOf = (rs: Ref[]): Chip => {
  const locals = rs.filter((r) => r.kind === "local").sort((a, b) => +b.head - +a.head);
  const remotes = rs.filter((r) => r.kind === "remote");
  const pairedOf = (l: Ref) => remotes.some((r) => r.name.endsWith("/" + l.name));
  const lonely = remotes.filter((r) => !locals.some((l) => r.name.endsWith("/" + l.name)));
  const entries = [...locals.map((r) => ({ r, paired: pairedOf(r) })), ...lonely.map((r) => ({ r, paired: false })), ...rs.filter((r) => r.kind === "tag").map((r) => ({ r, paired: false }))];
  const f = entries[0];
  const label = f.r.kind === "remote" ? f.r.name.slice(f.r.name.indexOf("/") + 1) : f.r.name;
  return { name: f.r.name, label, kind: f.r.kind, head: f.r.head, paired: f.paired, extra: entries.length - 1, title: rs.map((r) => r.name).join("\n") };
};

/** 그래프 열 폭에 맞춘 레인 간격 (넉넉하면 LANE_W, 좁으면 LANE_MIN까지) */
const laneStep = (gw: number, lanes: number) => Math.min(LANE_W, Math.max(LANE_MIN, (gw - PAD * 2) / lanes));
/** 노드 x(그래프 열 안의 CSS): 레인 간격은 `--lstep`이라 드래그 중 행을 다시 그리지 않아도 따라온다 */
const PAD_LEFT = "calc(var(--ref-w) + var(--graph-w))"; // 설명 열 시작 (행 paddingLeft)
/** 잘린 레인·숨긴 그래프의 노드 x는 그래프 열 오른쪽 끝(=설명 시작)을 넘지 않는다 (틴트가 글자 위로 안 오게) */
const cssX = (lane: number) => `min(calc(var(--ref-w) + ${PAD}px + ${lane + 0.5} * var(--lstep)), ${PAD_LEFT})`;
const setVar = (v: string, w: number) => document.querySelector<HTMLElement>(".commits")?.style.setProperty(v, w + "px");
const onAuthorMove = (w: number) => setVar("--author-w", w);
const onDateMove = (w: number) => setVar("--date-w", w);
const onShaMove = (w: number) => setVar("--sha-w", w);

/** 숨길 수 있는 열 (설명은 항상 보인다). 저장: localStorage cols:hidden */
type Col = "refs" | "graph" | "author" | "date" | "sha";
const COLS: [Col, "graph.colRefs" | "graph.colGraph" | "graph.colAuthor" | "graph.colDate" | "graph.colSha"][] = [
  ["refs", "graph.colRefs"], ["graph", "graph.colGraph"], ["author", "graph.colAuthor"], ["date", "graph.colDate"], ["sha", "graph.colSha"],
];
const readHidden = (): Set<Col> => {
  try {
    const v = JSON.parse(localStorage.getItem("cols:hidden") ?? "[]");
    return new Set((Array.isArray(v) ? v : []).filter((c) => COLS.some(([k]) => k === c)));
  } catch {
    return new Set();
  }
};

const DATE_OPTS: Intl.DateTimeFormatOptions = { year: "2-digit", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false };

interface Props {
  view: GraphView;
  refs: Ref[];
  theme: string;
  selected: string | null;
  onSelect: (id: string) => void;
  /** 맨 아래 근처까지 스크롤하면 부른다 (더 읽을 게 있는지는 부르는 쪽이 판단). 참조가 안정적이어야 한다 */
  onMore: () => void;
  /** 작업 디렉터리 변경 파일 수. 0보다 크면 목록 맨 위에 "로컬 변경사항" 행을 둔다. */
  localCount: number;
  /** compact 전용: 행 클릭(커밋 id 또는 WORKTREE). 참조가 안정적이어야 한다 */
  onOpen?: (id: string) => void;
}

/** 커밋 우클릭 메뉴 (ops 재사용). 그룹 순서: 체크아웃 → 이 커밋 기준 작업 → AI → 복사·패치·웹 → 태그 */
const commitMenu = (c: Commit, refs: Ref[]): MenuEntry[] => {
  const branches = refs.filter((r) => r.kind === "local" && !r.head);
  const tip = refs.find((r) => r.head)?.target;
  const stash = refs.find((r) => r.kind === "stash" && r.target === c.id);
  return [
    ...(stash ? [...stashMenu(stash), { separator: true } as MenuEntry] : []),
    ...branches.map((r) => ({ label: t("graph.checkoutName", { name: r.name }), op: "switch", action: () => ops.checkout(r.name) })),
    { label: t("graph.checkoutCommit"), op: "switch", action: () => ops.checkoutCommit(c.id) },
    { separator: true },
    { label: t("graph.newBranch"), op: "branch", action: () => ops.createBranch(c.id) },
    { label: "cherry-pick", op: "cherry-pick", action: () => ops.cherryPick(c.id) },
    { label: t("graph.merge"), op: "merge", action: () => ops.merge(c.id) },
    { label: t("graph.rebase"), op: "rebase", action: () => ops.rebase(c.id) },
    { label: t("graph.irebase"), op: "rebase_interactive", action: () => startInteractiveRebase(c.id) },
    { label: t("reword.menu"), op: "rebase_interactive", action: () => void startReword(c.id) },
    resetMenu(c.id),
    { label: t("graph.revert"), op: "revert", action: () => ops.revert(c.id) },
    ...(ops.aiOn() ? [{ separator: true } as MenuEntry, { label: t("graph.aiReview"), action: () => ops.aiReviewCommit(c.id, c.subject) }, { label: t("graph.aiGuide"), action: () => ops.guideCommit(c.id) }] : []),
    { separator: true },
    { label: t("graph.copySha"), action: () => ops.copy(c.id) },
    { label: t("graph.copySubject"), action: () => ops.copy(c.subject) },
    { label: t("graph.viewWeb"), action: () => ops.openCommitWeb(c.id) },
    { label: t("graph.savePatch"), op: "format-patch", action: () => ops.savePatchCommits(c.id) },
    ...(tip && tip !== c.id ? [{ label: t("graph.savePatchToTip"), op: "format-patch", action: () => ops.savePatchCommits(c.id, true) }] : []),
    { separator: true },
    { label: t("graph.tag"), op: "tag", action: () => ops.createTag(c.id) },
    ...ops.customMenu("commit", { sha: c.id }),
  ];
};

/**
 * 커밋 목록 + 그래프. 보이는 행만 Canvas에 그리는 가상 스크롤.
 * 레인 간 이동은 베지어 곡선으로 그린다.
 */
export const CommitGraph = memo(function CommitGraph({ view, refs, theme, selected, onSelect, onMore, localCount, onOpen }: Props) {
  useLocale();
  countRender("CommitGraph");
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [bucket, setBucket] = useState(0); // 스크롤 위치 / (ROW_H*BUCKET). 프레임마다 바뀌는 scrollTop은 state가 아니라 DOM에서 읽는다
  // 높이는 창 리사이즈 중 매 프레임 바뀌므로 ref에 두고, React 상태는 보이는 행 수가 바뀔 때만 갱신한다
  const heightRef = useRef(600);
  const [rowsVisible, setRowsVisible] = useState(Math.ceil(600 / ROW_H));
  const rootRef = useRef<HTMLDivElement>(null);
  const drawRef = useRef<() => void>(() => {});
  const raf = useRef(0);
  /** 다음 프레임에 Canvas만 다시 그린다 (React 렌더링 없이) */
  const requestDraw = useCallback(() => {
    if (!raf.current) raf.current = requestAnimationFrame(() => ((raf.current = 0), drawRef.current()));
  }, []);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  // 브랜치/태그 열 폭: 드래그 중에는 CSS 변수(--ref-w)와 Canvas만 따라온다
  const refWRef = useRef(150);
  const onRefMove = useCallback((w: number) => {
    refWRef.current = w;
    rootRef.current?.style.setProperty("--ref-w", w + "px");
    requestDraw();
  }, [requestDraw]);
  const [refW, refSplit, refReset] = useSplit("graph-refs", 150, 80, 400, "x", onRefMove); // 브랜치/태그 열
  // 그래프 열: 저장값이 없으면(0) 레인 수에 맞춘 자동 폭. 드래그 중에는 --graph-w·--lstep과 Canvas만 따라온다
  const graphWRef = useRef(0);
  const lanesRef = useRef(1);
  const onGraphMove = useCallback((w: number) => {
    graphWRef.current = w;
    rootRef.current?.style.setProperty("--graph-w", w + "px");
    rootRef.current?.style.setProperty("--lstep", laneStep(w, lanesRef.current) + "px");
    requestDraw();
  }, [requestDraw]);
  const [graphSize, graphSplit, graphReset] = useSplit("graph-w", 0, 40, 800, "x", onGraphMove);
  // 오른쪽 열: 왼쪽 경계를 끌어 조절한다 (설명이 남은 폭을 가진다). 행은 CSS 변수만 따라온다
  const [authorW, authorSplit, authorReset] = useSplit("graph-author", 110, 60, 400, "x", onAuthorMove, true);
  const [dateW, dateSplit, dateReset] = useSplit("graph-date", 150, 80, 400, "x", onDateMove, true);
  const [shaW, shaSplit, shaReset] = useSplit("graph-sha", 60, 48, 200, "x", onShaMove, true);
  const [hide, setHide] = useState<Set<Col>>(() => (COMPACT ? new Set<Col>(["refs"]) : readHidden())); // compact: 배지는 행 안(1줄)에
  const toggleCol = (c: Col) =>
    setHide((h) => {
      const n = new Set(h);
      n.has(c) ? n.delete(c) : n.add(c);
      try {
        localStorage.setItem("cols:hidden", JSON.stringify([...n]));
      } catch {}
      return n;
    });
  const headMenu = (): MenuEntry[] => [
    ...COLS.map(([c, key]) => ({ label: t(key), checked: !hide.has(c), action: () => toggleCol(c) })),
    { separator: true },
    {
      label: t("graph.colReset"),
      action: () => {
        setHide(new Set());
        try {
          localStorage.removeItem("cols:hidden");
        } catch {}
        [refReset, graphReset, authorReset, dateReset, shaReset].forEach((f) => f());
      },
    },
  ];

  const { commits, layout } = view;

  // 검색 (⌘/Ctrl+F): 메시지·작성자·SHA는 바로, 내용은 Enter로 git log -S
  const [search, setSearch] = useState<{ q: string; content: boolean; hits: Set<string> | null } | null>(COMPACT ? { q: "", content: false, hits: null } : null); // compact: 검색칸은 항상 보인다
  const searchRef = useRef<HTMLInputElement>(null);
  const [listOn, setListOn] = useState(false); // 일치한 커밋만 목록으로 모아 보기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearch((s) => s ?? { q: "", content: false, hits: null });
        setTimeout(() => searchRef.current?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const matches = useMemo(() => {
    if (!search?.q.trim()) return [];
    if (search.content) return search.hits ? commits.filter((c) => search.hits!.has(c.id)).map((c) => c.id) : [];
    const q = search.q.toLowerCase();
    return commits.filter((c) => c.subject.toLowerCase().includes(q) || c.body.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) || c.id.startsWith(q)).map((c) => c.id);
  }, [search, commits]);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  // 검색 중이면 일치하지 않는 행(과 노드·선)을 흐리게 한다. 내용 검색은 Enter로 결과가 오기 전엔 흐리지 않는다.
  const dimming = !!search?.q.trim() && (!search.content || !!search.hits);
  // 그래프에서 브랜치 배지를 누르면 그 계보(불러온 커밋 안에서 닿는 조상)만 진하게. 검색 흐림이 우선이다.
  const focus = useFocusRef();
  const lit = useMemo(() => {
    if (!focus || dimming) return null;
    const byId = new Map(commits.map((c) => [c.id, c]));
    const set = new Set<string>();
    const stack = [focus];
    while (stack.length) {
      const id = stack.pop()!;
      const c = byId.get(id);
      if (!c || set.has(id)) continue;
      set.add(id);
      stack.push(...c.parents);
    }
    // 선은 레인을 따라 위에서 아래로: 계보 노드에서 나가는 선, 그 선이 이어지는 레인만 진하게
    let on = new Set<number>();
    const edges = layout.rows.map((r, i) => {
      const flags = r.edges.map((e) => (e.from === r.lane ? set.has(commits[i].id) : on.has(e.from)));
      on = new Set(r.edges.filter((_, k) => flags[k]).map((e) => e.to));
      return flags;
    });
    return { set, edges };
  }, [focus, dimming, commits, layout]);
  const cur = matches.indexOf(selected ?? "") + 1;
  const jump = (dir: 1 | -1) => {
    if (!matches.length) return;
    const i = matches.indexOf(selected ?? "");
    onSelect(matches[(i + dir + matches.length) % matches.length]);
  };
  const lanes = useMemo(() => {
    let n = 1;
    for (const r of layout.rows.slice(0, FIT_ROWS)) {
      n = Math.max(n, r.lane + 1);
      for (const e of r.edges) n = Math.max(n, e.from + 1, e.to + 1);
    }
    return n;
  }, [layout]);
  const maxLanesRef = useRef(1);
  maxLanesRef.current = Math.max(lanes, layout.max_lanes);
  const graphW = hide.has("graph") ? 0 : COMPACT ? Math.min(COMPACT_GRAPH_MAX, PAD * 2 + lanes * LANE_W) : graphSize > 0 ? graphSize : Math.min(AUTO_MAX, PAD * 2 + lanes * LANE_W); // 자동 = 레인이 다 들어가는 폭(상한 AUTO_MAX)
  const effRefW = hide.has("refs") ? 0 : refW;
  refWRef.current = effRefW;
  graphWRef.current = graphW;
  lanesRef.current = lanes;
  const leftW = effRefW + graphW;

  const hiddenSet = useHiddenSet(ctx.repo);
  const chips = useMemo(() => {
    const m = new Map<string, Ref[]>();
    for (const r of refs) if (r.kind !== "stash" && !isHiddenRef(ctx.repo, r)) m.set(r.target, [...(m.get(r.target) ?? []), r]);
    const out = new Map<string, Chip>();
    for (const [id, rs] of m) out.set(id, chipOf(rs));
    return out;
  }, [refs, view, hiddenSet]);

  // 현재 HEAD 커밋 행: "로컬 변경사항" 점선이 닿는 곳
  const headIdx = useMemo(() => {
    const t = refs.find((r) => r.head)?.target;
    return t ? commits.findIndex((c) => c.id === t) : -1;
  }, [refs, commits]);
  const headRow = headIdx >= 0 ? layout.rows[headIdx] : null;

  useEffect(() => {
    const el = scrollRef.current!;
    // 높이가 바뀌면 Canvas만 바로 다시 그린다. 행 수가 같으면 setState도 부르지 않는다(같은 값이어도 한 번 리렌더링될 수 있다).
    let last = -1;
    const ro = new ResizeObserver(() => {
      if (el.clientHeight === heightRef.current) return;
      heightRef.current = el.clientHeight;
      const n = Math.ceil(el.clientHeight / ROW_H);
      if (n !== last) setRowsVisible((last = n));
      drawRef.current();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 사이드바에서 브랜치를 고르면 그 커밋이 보이도록 스크롤한다. 선택이 그대로면 목록이 늘어나도 스크롤하지 않는다.
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    const i = commits.findIndex((c) => c.id === selected);
    const el = scrollRef.current;
    if (i < 0 || !el) return void (revealed.current = null);
    if (revealed.current === selected) return;
    revealed.current = selected;
    const top = i * ROW_H;
    if (top < el.scrollTop || top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top - el.clientHeight / 3;
  }, [selected, commits]);

  const first = Math.max(0, (bucket - 1) * BUCKET);
  const last = Math.min(commits.length, (bucket + 1) * BUCKET + rowsVisible + BUCKET);

  // 보이는 커밋의 작성자 사진을 한 번에 요청한다 (이미 아는 이메일은 건너뜀)
  useEffect(() => requestAvatars(ctx.repo, commits.slice(first, last)), [commits, first, last]);

  // 사진이 도착해도 React 상태는 건드리지 않는다. Canvas만 다시 그린다.
  useEffect(() => onAvatarChange(() => drawRef.current()), []);
  // 크게 보기를 닫으면 그동안 못 그린 변경(데이터·테마)을 한 번 반영한다 (React 렌더링 없이)
  useEffect(() => bigView.on(() => bigView.open || requestDraw()), [requestDraw]);

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas || bigView.open) return; // 크게 보기 중엔 숨겨져 있으므로 그리지 않는다 (닫을 때 한 번 다시 그린다)
    const dpr = window.devicePixelRatio || 1;
    const scrollTop = scrollRef.current?.scrollTop ?? 0;
    const gw = graphWRef.current;
    if (!gw) return; // 그래프 열을 숨겼으면 그리지 않는다
    const leftW = refWRef.current + gw;
    const height = heightRef.current;
    const lanes = lanesRef.current;
    const step = laneStep(gw, lanes);
    const x = (lane: number) => refWRef.current + PAD + (lane + 0.5) * step; // 캔버스는 브랜치/태그 열부터 시작한다
    const R = Math.max(3, Math.min(AVATAR_R, step / 2)); // 노드 지름도 레인 간격에 비례해 줄인다
    const mergeR = Math.max(2, Math.min(MERGE_R, step / 2 - 1));
    // 크기는 바뀔 때만 대입한다 (대입하면 캔버스 버퍼를 다시 잡으므로 스크롤 프레임마다 하면 비싸다)
    if (canvas.width !== Math.round(leftW * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.style.width = leftW + "px";
      canvas.style.height = height + "px";
      canvas.width = Math.round(leftW * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext("2d")!;
    // 색은 CSS 토큰에서 읽는다 (docs/design.md). 스타일 계산을 피하려고 theme이 바뀔 때만 읽어 둔다.
    if (!colorsRef.current.palette.length) readColors();
    const { palette, surface } = colorsRef.current;
    const color = (c: number) => palette[c % palette.length];
    ctx.setTransform(dpr, 0, 0, dpr, 0, -scrollTop * dpr);
    ctx.clearRect(0, scrollTop, leftW, height);
    ctx.lineWidth = LINE_W;
    ctx.lineCap = "round";

    // "로컬 변경사항" → HEAD 커밋 점선. HEAD는 레이아웃에서 맨 왼쪽(0번) 레인이라 곧게 내려간다.
    // HEAD가 화면 아래(아직 그리지 않은 구간)에 있어도 선은 잇는다.
    if (localCount > 0 && headRow) {
      ctx.setLineDash([2, 5]);
      ctx.strokeStyle = color(headRow.color);
      ctx.beginPath();
      const headY = headIdx * ROW_H + ROW_H / 2;
      ctx.moveTo(x(headRow.lane), 0);
      ctx.lineTo(x(headRow.lane), headY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for (let i = first; i < last; i++) {
      const y0 = i * ROW_H + ROW_H / 2;
      const y1 = y0 + ROW_H;
      ctx.globalAlpha = dimming && !matchSet.has(commits[i].id) && !(i + 1 < commits.length && matchSet.has(commits[i + 1].id)) ? DIM : 1;
      for (const [k, e] of layout.rows[i].edges.entries()) {
        if (lit) ctx.globalAlpha = lit.edges[i][k] ? 1 : DIM;
        ctx.strokeStyle = color(e.color);
        ctx.beginPath();
        ctx.moveTo(x(e.from), y0);
        if (e.from === e.to) ctx.lineTo(x(e.to), y1);
        else {
          const mid = (y0 + y1) / 2;
          ctx.bezierCurveTo(x(e.from), mid, x(e.to), mid, x(e.to), y1);
        }
        ctx.stroke();
      }
    }
    for (let i = first; i < last; i++) {
      const r = layout.rows[i];
      const cy = i * ROW_H + ROW_H / 2;
      const nx = x(r.lane);
      const c = commits[i];
      const merge = c.parents.length > 1;
      const col = color(r.color);
      ctx.globalAlpha = (dimming && !matchSet.has(c.id)) || (lit && !lit.set.has(c.id)) ? DIM : 1;
      if (chips.has(c.id) && refWRef.current > 0) {
        // 브랜치/태그 칩에서 노드까지 레인 색 가는 선
        ctx.strokeStyle = col;
        ctx.beginPath();
        ctx.moveTo(refWRef.current, cy);
        ctx.lineTo(nx, cy);
        ctx.stroke();
      }
      if (merge) {
        ctx.beginPath();
        ctx.arc(nx, cy, mergeR, 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.fill();
        continue;
      }
      // 작성자 사진 원형 + 레인 색 링. 사진이 없으면 이니셜
      ctx.beginPath();
      ctx.arc(nx, cy, R, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
      if (R < 6) continue; // 너무 작으면 사진·이니셜 없이 색 점만
      const url = avatarUrl(c.email);
      const img = url ? avatarImage(url, () => drawRef.current()) : null;
      ctx.save();
      ctx.beginPath();
      ctx.arc(nx, cy, R - 2, 0, Math.PI * 2);
      ctx.clip();
      if (img) ctx.drawImage(img, nx - R + 2, cy - R + 2, (R - 2) * 2, (R - 2) * 2);
      else {
        ctx.fillStyle = surface;
        ctx.fillRect(nx - R, cy - R, R * 2, R * 2);
        ctx.fillStyle = col;
        ctx.font = "600 10px -apple-system, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        if (R >= 8) ctx.fillText((c.author.trim()[0] ?? "?").toUpperCase(), nx, cy + 0.5);
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    // 레인이 열보다 넓어 잘리면 오른쪽 경계를 페이드로 지운다
    if (PAD * 2 + maxLanesRef.current * step > gw + 0.5) {
      const g = ctx.createLinearGradient(leftW - FADE_W, 0, leftW, 0);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, "rgba(0,0,0,1)");
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = g;
      ctx.fillRect(leftW - FADE_W, scrollTop, FADE_W, height);
      ctx.globalCompositeOperation = "source-over";
    }
  };
  drawRef.current = draw;
  useEffect(draw, [view, first, last, leftW, theme, localCount, headIdx, dimming, matchSet, lit]);

  // 행 틴트가 쓰는 레인 색(--g0..)을 토큰에서 내보낸다. 마지막으로 내보낸 값과 같으면 아무것도 안 한다.
  const palRef = useRef("");
  const colorsRef = useRef({ palette: [] as string[], surface: "" });
  function readColors() {
    const raw = token("--graph");
    if (raw !== palRef.current) {
      palRef.current = raw;
      raw.split(/\s+/).forEach((c, i) => rootRef.current?.style.setProperty(`--g${i}`, c));
    }
    colorsRef.current = { palette: raw.split(/\s+/), surface: token("--surface") };
  }
  useLayoutEffect(() => {
    readColors();
    // data-theme은 부모 effect에서 바뀌므로 한 프레임 뒤에 한 번 더 읽는다
    const id = requestAnimationFrame(() => (readColors(), drawRef.current()));
    return () => cancelAnimationFrame(id);
  }, [theme]);
  const laneStyle = (lane: number, color: number): CSSProperties =>
    ({ "--lane": `var(--g${color % PALETTE_N})`, "--nx": cssX(lane) }) as CSSProperties;

  return (
    <div
      className={"commits" + COLS.map(([c]) => (hide.has(c) ? " hide-" + c : "")).join("")}
      ref={rootRef}
      style={{ "--ref-w": effRefW + "px", "--graph-w": graphW + "px", "--lstep": laneStep(graphW, lanes) + "px", "--author-w": authorW + "px", "--date-w": dateW + "px", "--sha-w": shaW + "px" } as CSSProperties}
    >
      {search && (
        <div className="search-bar" role="search">
          <Icon name="search" size={14} />
          <input
            ref={searchRef}
            value={search.q}
            placeholder={search.content ? t("graph.searchChanged") : t("graph.searchPlaceholder")}
            aria-label={t("graph.searchLabel")}
            onChange={(e) => setSearch({ ...search, q: e.target.value, hits: null })}
            onKeyDown={(e) => {
              if (e.key === "Escape") setSearch(COMPACT ? { q: "", content: false, hits: null } : null);
              else if (e.key === "Enter" && search.content && !search.hits)
                api.searchContent(ctx.repo, search.q).then((ids) => setSearch((s) => s && { ...s, hits: new Set(ids) }), (er) => ctx.error(String(er)));
              else if (e.key === "Enter") jump(e.shiftKey ? -1 : 1);
            }}
          />
          <label>
            <input type="checkbox" checked={search.content} onChange={(e) => setSearch({ ...search, content: e.target.checked, hits: null })} /> {t("graph.searchContent")}
          </label>
          <button className={"search-list-btn" + (listOn ? " on" : "")} aria-pressed={listOn} onClick={() => setListOn(!listOn)}>{t("graph.searchList")}</button>
          <span className="search-count">{search.q.trim() ? `${cur || "-"} / ${matches.length}` : ""}</span>
          <button className="icon-btn" onClick={() => jump(-1)} disabled={!matches.length} aria-label={t("graph.prevResult")}><Icon name="arrowUp" size={14} /></button>
          <button className="icon-btn" onClick={() => jump(1)} disabled={!matches.length} aria-label={t("graph.nextResult")}><Icon name="arrowDown" size={14} /></button>
          {COMPACT ? (
            <button className="icon-btn" onClick={() => openFull(selected && selected !== WORKTREE ? selected : undefined)} title={t("graph.openFull")} aria-label={t("graph.openFull")}><Icon name="openOut" size={14} /></button>
          ) : (
            <button className="icon-btn" onClick={() => setSearch(null)} aria-label={t("graph.closeSearch")}><Icon name="dismiss" size={14} /></button>
          )}
          {listOn && matches.length > 0 && (
            <ul className="search-list" role="listbox" aria-label={t("graph.searchList")}>
              {matches.slice(0, 500).map((id) => {
                const c = commits.find((x) => x.id === id)!;
                return (
                  <li key={id} role="option" aria-selected={id === selected} className={id === selected ? "selected" : ""} onMouseDown={() => onSelect(id)} onDoubleClick={onOpen && (() => onOpen(id))}>
                    <span className="subject">{c.subject}</span>
                    <span className="meta">{c.author} · {relTime(c.time)} · {id.slice(0, 7)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      <div className="commits-head" onContextMenu={contextMenu(headMenu)}>
        <div className="head-left">
          {!hide.has("refs") && <span className="refs-head" style={{ width: refW }}>{t("graph.colRefs")}</span>}
          {!hide.has("refs") && refSplit}
          {!hide.has("graph") && <span className="graph-head" style={{ width: graphW }}>{t("graph.colGraph")}</span>}
          {!hide.has("graph") && graphSplit}
        </div>
        <span className="subject">{t("graph.colSubject")}</span>
        {!hide.has("author") && authorSplit}
        {!hide.has("author") && <span className="author" style={{ width: authorW }}>{t("graph.colAuthor")}</span>}
        {!hide.has("date") && dateSplit}
        {!hide.has("date") && <span className="date" style={{ width: dateW }}>{t("graph.colDate")}</span>}
        {!hide.has("sha") && shaSplit}
        {!hide.has("sha") && <span className="sha" style={{ width: shaW }}>{t("graph.colSha")}</span>}
      </div>
      {localCount > 0 && (
        <div
          className={"row local-row" + (selected === WORKTREE ? " selected" : "")}
          style={{ paddingLeft: PAD_LEFT, height: ROW_H, ...laneStyle(headRow?.lane ?? 0, headRow?.color ?? 0), "--mx": PAD_LEFT } as CSSProperties}
          onMouseDown={() => onSelect(WORKTREE)}
          onClick={onOpen && (() => onOpen(WORKTREE))}
        >
          <span className="wip-node" style={{ left: cssX(headRow?.lane ?? 0) }} />
          <span className="subject">{t("graph.localChanges")} <span className="count-pill">{localCount}</span></span>
        </div>
      )}
      <div ref={scrollRef} className="graph-scroll" onScroll={(e) => {
          const el = e.currentTarget;
          const b = Math.floor(el.scrollTop / (ROW_H * BUCKET));
          setBucket((p) => (p === b ? p : b)); // 같은 구간 안의 스크롤은 렌더링하지 않는다
          requestDraw();
          if (COMPACT) tip.scrolled();
          if (el.scrollTop + el.clientHeight > el.scrollHeight - 30 * ROW_H) onMore();
        }}>
        <div style={{ height: commits.length * ROW_H, position: "relative" }}>
          <canvas ref={canvasRef} className="graph-canvas" />
          {commits.slice(first, last).map((c, k) => {
            const row = layout.rows[first + k];
            return (
              <Row
                key={c.id}
                c={c}
                top={(first + k) * ROW_H}
                lane={row.lane}
                color={row.color}
                chip={chips.get(c.id)}
                selected={c.id === selected}
                match={matchSet.has(c.id)}
                dim={(dimming && !matchSet.has(c.id)) || (!!lit && !lit.set.has(c.id))}
                refs={refs}
                onSelect={onSelect}
                onOpen={onOpen}
              />
            );
          })}
        </div>
      </div>
      {COMPACT && <CommitTip />}
    </div>
  );
});

/** 커밋 한 행. 원시값 props만 받아 memo로 감싸, 선택이 바뀌면 바뀐 두 행만 다시 그린다. */
const Row = memo(function Row({ c, top, lane, color, chip, selected, match, dim, refs, onSelect, onOpen }: {
  c: Commit; top: number; lane: number; color: number; chip: Chip | undefined;
  selected: boolean; match: boolean; dim: boolean; refs: Ref[]; onSelect: (id: string) => void; onOpen?: (id: string) => void;
}) {
  useLocale(); // 날짜 형식이 언어를 따른다
  countRender("CommitRow");
  const badgeEl = chip && (
  <span
    className={`badge ${chip.kind}${chip.head ? " head" : ""}`}
    title={chip.title}
    onClick={(e) => (COMPACT && e.stopPropagation(), pick(`graph:${chip.kind}:${chip.name}`, c.id, true))}
    onDoubleClick={() => (chip.kind === "local" ? ops.checkout(chip.name) : chip.kind === "remote" ? ops.checkoutRemote(chip.name) : null)}
  >
    {chip.head ? <Icon name="current" size={12} /> : chip.kind === "tag" ? <Icon name="tag" size={12} /> : null}
    <span className="badge-name">{chip.label}</span>
    {chip.kind === "local" && <Icon name="local" size={12} />}
    {(chip.paired || chip.kind === "remote") && <Icon name="remote" size={12} />}
    {chip.extra > 0 && <span className="badge-more">+{chip.extra}</span>}
  </span>
  );
  return (
    <div
      className={"row" + (selected ? " selected" : "") + (match ? " match" : "") + (dim ? " dim" : "")}
      style={{ top, height: ROW_H, left: 0, paddingLeft: PAD_LEFT, "--lane": `var(--g${color % PALETTE_N})`, "--nx": cssX(lane), "--mx": PAD_LEFT } as CSSProperties}
      onMouseDown={() => (COMPACT && tip.leave(), onSelect(c.id))}
      onClick={onOpen && (() => onOpen(c.id))}
      onMouseEnter={COMPACT ? (e) => tip.hover(ctx.repo, c, e.currentTarget) : undefined}
      onMouseLeave={COMPACT ? tip.leave : undefined}
      onContextMenu={contextMenu(() => commitMenu(c, refs))}
    >
      {COMPACT ? (
        <span className="c-main">
          <span className="c-l1">
            {chip && <span className="row-refs">{badgeEl}</span>}
            <span className="subject">{c.subject}</span>
          </span>
          <span className="c-l2">{c.id.slice(0, 7)} · {relTime(c.time)} · {c.author}</span>
        </span>
      ) : null}
      {!COMPACT && chip && (
        <span className="row-refs" style={{ width: "var(--ref-w)" }}>
          {badgeEl}
          <span className="ref-line" />
        </span>
      )}
      {!COMPACT && (
        <>
          <span className="subject">{c.subject}{c.body && <span className="body"> {c.body}</span>}</span>
          <span className="author"><Avatar name={c.author} email={c.email} /><span>{c.author}</span></span>
          <span className="date">{dateFmt(DATE_OPTS).format(c.time * 1000)}</span>
          <Sha id={c.id} />
        </>
      )}
    </div>
  );
});
