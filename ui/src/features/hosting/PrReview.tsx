import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../shared/api/api";
import { errCode } from "../../shared/api/bridge";
import { Icon } from "../../shared/ui/Icon";
import { contextMenu } from "../../shared/ui/menu";
import { ctx, ops, prBus } from "../../shared/model/ops";
import { bigView } from "../../shared/model/bigview";
import { firstCommitAfterMyReview, prReview, relTime, reviewProgress, usePrReview } from "../../shared/model/prreview";
import { dateFmt, intlTag, t, useLocale } from "../../shared/i18n/i18n";
import { countRender } from "../../shared/lib/profile";
import { Markdown, MdPreview } from "../../shared/ui/Markdown";
import { prPopup, type PopItem } from "../../shared/model/prpopup";
import { prSha } from "../../shared/model/prsha";
import { PrPopupHost, Who, peek } from "./PrPopup";
import { useSplit } from "../../shared/ui/Splitter";
import { isMac } from "../../shared/lib/platform";
import { PrFiles, type Range } from "./PrFiles";
import { AiMark, AiNewHint, AiTabButton, PrAi } from "./PrAi";
import { aiKey } from "../../shared/model/prai";
import type { DiffReveal } from "../../entities/diff/DiffView";
import type { InboxPr, PrDetail, PrTimelineItem, RemoteInfo } from "../../shared/api/types";

// PR 리뷰 화면(26a): 그래프·사이드바 자리를 덮는 목록 | 상세(개요·대화). 열림·선택은 prreview.ts 외부 스토어,
// 목록·상세·검색·탭 상태는 모두 이 파일 컴포넌트 안에 있다 (App·그래프·사이드바·툴바는 다시 그려지지 않는다).

const COLLAPSE_KEY = "prr.listCollapsed";
const MINE_KEY = "prr.mineFold"; // "내가 올린 PR" 묶음 접힘
type Tab = "review" | "mine" | "all";
const TAB_KEY = { review: "prr.tab.review", mine: "prr.tab.mine", all: "prr.tab.all" } as const;
type Target = Pick<RemoteInfo, "remote" | "repo" | "account">;
/** 토큰이 없거나 거부된 오류(Rust 오류 코드) — 계정 연결을 안내한다 */
const isTokenErr = (e: unknown) => {
  const c = errCode(e);
  return c ? ["hosting.noToken", "hosting.noSavedToken", "hosting.unauthorized", "hosting.store"].includes(c) : /token|토큰/i.test(String(e)); // 코드 없는 오류(gh stderr 인증 실패 등)는 문구로 폴백
};
type Load<T> = { key: string; data: T | null; error: string | null; token?: boolean };

/** `App`이 `.workspace` 안에 한 번 둔다. 저장소가 바뀌면 닫는다 */
/** 커밋 우클릭 "그래프에서 보기" → PR 화면을 닫고 그래프에서 그 커밋을 고른다(main.tsx `reveal`: 더 읽어 찾고, 없으면 경고) */
let revealCommit: (sha: string) => void = () => {};

export const PrReviewHost = memo(function PrReviewHost({ repo, onSelectCommit }: { repo: string; onSelectCommit: (sha: string) => void }) {
  revealCommit = onSelectCommit;
  const { open } = usePrReview();
  useEffect(() => prReview.close(), [repo]);
  useEffect(() => void (open && bigView.exit()), [open]);
  return open ? <PrReviewScreen repo={repo} /> : null;
});

const inboxCache = new Map<string, InboxPr[]>(); // `${repo}:${state}` → 마지막으로 받은 목록 (세션 메모리)
const inTab = (p: InboxPr, tab: Tab) => (tab === "review" ? p.reviewRequested || p.reRequested : tab === "mine" ? p.isMine : true);
const matches = (p: InboxPr, q: string) => !q || `#${p.number} ${p.number} ${p.title} ${p.author} ${p.head} ${p.base}`.toLowerCase().includes(q);

function status(p: InboxPr): { cls: string; label: string } {
  if (p.state === "MERGED") return { cls: "info", label: t("prr.st.merged") };
  if (p.state === "CLOSED") return { cls: "", label: t("prr.st.closed") };
  if (p.reRequested) return { cls: "rereq", label: t("prr.st.rereq") };
  if (p.myReview === "approved") return { cls: "ok", label: t("prr.st.approved") };
  if (p.myReview === "changes_requested") return { cls: "warn", label: t("prr.st.changes") };
  if (p.myReview === "commented") return { cls: "info", label: t("prr.st.commented") };
  if (p.draft) return { cls: "", label: t("prr.st.draft") };
  return { cls: "", label: t("prr.st.none") };
}

function PrReviewScreen({ repo }: { repo: string }) {
  countRender("PrReview");
  useLocale();
  const { selected } = usePrReview();
  const [target, setTarget] = useState<Target | null | undefined>(undefined); // undefined = 확인 중, null = GitHub 원격 없음
  const [inbox, setInbox] = useState<Load<InboxPr[]> | null>(null);
  const [tab, setTab] = useState<Tab>("review");
  const [query, setQuery] = useState("");
  const [state, setState] = useState<"open" | "closed">("open"); // 닫힘 = 닫힘·머지됨 최근 50개
  const seq = useRef(0);
  // 목록 접기(레일)·폭: 저장. 바뀔 때만 이 화면이 다시 그려진다 (드래그 중에는 Splitter가 DOM style만 고친다)
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [listW, listSplit] = useSplit("prlist", 380, 300, 640, "x");
  const toggleList = useCallback(() => setCollapsed((c) => !c), []);
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {}
  }, [collapsed]);
  // ⌘\ (Ctrl+\): 목록 접기·펼치기 (다른 곳에서 안 쓰는 키)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.code !== "Backslash") return;
      e.preventDefault();
      toggleList();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [toggleList]);
  const listKey = `${isMac ? "⌘" : "Ctrl+"}\\`;
  const [mineFold, setMineFold] = useState(() => {
    try {
      return localStorage.getItem(MINE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleMine = useCallback(() => setMineFold((c) => !c), []);
  useEffect(() => {
    try {
      localStorage.setItem(MINE_KEY, mineFold ? "1" : "0");
    } catch {}
  }, [mineFold]);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    // 원격 정보를 못 읽으면 "GitHub 원격 없음"이 아니라 오류 + 다시 시도
    let infos: RemoteInfo[];
    try {
      infos = await api.remoteInfo(repo);
    } catch (e) {
      if (mine === seq.current) (setTarget(undefined), setInbox({ key: `${repo}:${state}`, data: null, error: String(e) }));
      return;
    }
    if (mine !== seq.current) return;
    const gh = infos.find((i) => i.provider === "github") ?? null;
    setTarget(gh);
    if (!gh) return;
    const key = `${repo}:${state}`;
    // 받아 둔 목록이 있으면 먼저 보이고 뒤에서 새로 받는다 (GitHub 응답이 수 초 걸린다)
    setInbox((p) => (p && p.key === key ? { ...p, error: null } : inboxCache.has(key) ? { key, data: inboxCache.get(key)!, error: null } : null));
    api.prInbox(gh.account, gh.repo, gh.account?.username ?? null, state, false, ctx.repo || undefined).then(
      (data) => mine === seq.current && (inboxCache.set(key, data), setInbox({ key, data, error: null })),
      (e) => mine === seq.current && setInbox((p) => ({ key, data: p?.key === key ? p.data : null, error: String(e), token: isTokenErr(e) })),
    );
  }, [repo, state]);
  useEffect(() => {
    load();
    const off = prBus.on(load);
    return () => {
      seq.current++;
      off();
    };
  }, [load]);

  // Esc: 닫기 (시트·메뉴가 열려 있으면 그쪽만, 입력창은 포커스만 푼다). 크게 보기와 같이 capture 단계
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector('.sheet-backdrop, .dom-menu-backdrop, [role="dialog"], [role="menu"]')) return; // defaultPrevented: App의 크게 보기 Esc가 이미 처리
      const el = e.target as HTMLElement | null;
      if (el?.closest?.("input, textarea, select, [contenteditable]")) return void el.blur?.();
      e.preventDefault();
      e.stopImmediatePropagation(); // 맨 위 화면이 이 Esc를 가져간다 (다른 capture Esc 핸들러가 같이 반응하지 않게)
      if (bigView.open) bigView.exit(); // diff 크게 보기가 열려 있으면 그것부터 닫는다
      else prReview.close();
    };
    window.addEventListener("keydown", onEsc, true);
    return () => window.removeEventListener("keydown", onEsc, true);
  }, []);

  const items = inbox?.data ?? null;
  const q = query.trim().toLowerCase().replace(/^#/, "");
  // 내가 올린 PR은 "내 PR" 탭이 아니면 맨 위 묶음으로 고정(탭·검색과 무관)하고 아래 목록에서는 뺀다 (같은 PR이 두 번 보이지 않게)
  const pinned = useMemo(() => (tab === "mine" ? [] : (items ?? []).filter((p) => p.isMine)), [items, tab]);
  const shown = useMemo(() => (items ?? []).filter((p) => inTab(p, tab) && matches(p, q) && !(tab !== "mine" && p.isMine)), [items, tab, q]);
  const order = useMemo(() => (mineFold ? shown : [...pinned, ...shown]), [mineFold, pinned, shown]); // ↑↓ 이동 순서 = 화면 순서
  // 고른 PR이 현재 탭에 없으면 "전체"로(내 PR은 묶음에 보이니 그대로), 아무것도 안 골랐으면 목록 첫 항목(없으면 묶음 첫 항목)
  useEffect(() => {
    if (!items) return;
    const cur = selected != null ? items.find((p) => p.number === selected) : null;
    if (cur && !inTab(cur, tab) && !(cur.isMine && tab !== "mine")) setTab("all");
  }, [items, selected]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const first = shown[0] ?? pinned[0];
    if (items && selected == null && first) prReview.select(first.number);
  }, [items, selected, shown, pinned]);

  const counts = useMemo(() => ({ review: (items ?? []).filter((p) => inTab(p, "review")).length, mine: (items ?? []).filter((p) => p.isMine).length, all: items?.length ?? 0 }), [items]);
  const current = items?.find((p) => p.number === selected) ?? null;
  // 나: 연결 계정 이름, 없으면(gh 로그인) 내가 올린 PR의 작성자
  const me = target?.account?.username ?? items?.find((p) => p.isMine)?.author ?? null;

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if ((e.target as HTMLElement).closest("input")) return;
    e.preventDefault();
    const i = order.findIndex((p) => p.number === selected);
    const n = order[Math.max(0, Math.min(order.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (n) prReview.select(n.number);
  };

  const tokenErr = inbox?.error && inbox.token;
  return (
    <div className="prr" role="region" aria-label={t("prr.title")}>
      {collapsed ? (
        <aside className="prr-list rail" aria-label={t("prr.title")}>
          <button className="prr-icon" title={t("prr.list.expand", { key: listKey })} aria-label={t("prr.list.expand", { key: listKey })} onClick={toggleList}><Icon name="chevronRight" size={14} /></button>
          <button className="prr-icon" title={t("prr.close")} aria-label={t("prr.close")} onClick={() => prReview.close()}><Icon name="dismiss" size={14} /></button>
        </aside>
      ) : (
      <>
      <aside className="prr-list" style={{ width: listW }}>
        <div className="prr-list-head">
          <div className="prr-tabs" role="tablist" aria-label={t("prr.title")}>
            {(["review", "mine", "all"] as Tab[]).map((k) => (
              <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
                {t(TAB_KEY[k])}
                {items && <span className="count">{counts[k]}</span>}
              </button>
            ))}
          </div>
          <button className="prr-icon" title={t("pr.refresh")} aria-label={t("pr.refresh")} onClick={() => load()}><Icon name="fetch" size={14} /></button>
          <button className="prr-icon" title={t("prr.list.collapse", { key: listKey })} aria-label={t("prr.list.collapse", { key: listKey })} onClick={toggleList}><Icon name="chevronLeft" size={14} /></button>
          <button className="prr-close" title={t("prr.close")} aria-label={t("prr.close")} onClick={() => prReview.close()}><Icon name="dismiss" size={13} /><span>{t("prr.closeLabel")}</span><kbd className="big-kbd">Esc</kbd></button>
        </div>
        <label className="prr-search">
          <Icon name="search" size={13} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("prr.search")} aria-label={t("prr.search")} spellCheck={false} />
          <select value={state} onChange={(e) => (setState(e.target.value as "open" | "closed"), prReview.select(null))} aria-label={t("prr.state")} title={t("prr.state")}>
            <option value="open">{t("prr.state.open")}</option>
            <option value="closed">{t("prr.state.closed")}</option>
          </select>
        </label>
        <div className="prr-items" role="listbox" aria-label={t("prr.title")} onKeyDown={onListKey}>
          {target === null && <p className="prr-note">{t("prr.noGithub")}</p>}
          {target && !inbox && <p className="prr-note">{t("common.loading")}</p>}
          {inbox?.error && (
            <div className="prr-note" role="alert">
              <p>{inbox.error}</p>
              {tokenErr ? <button onClick={ops.manageAccounts}>{t("prr.connect")}</button> : <button onClick={() => load()}>{t("prr.retry")}</button>}
            </div>
          )}
          {pinned.length > 0 && (
            <section className="prr-mine" aria-label={t("prr.mine.title", { n: pinned.length })}>
              <button className="prr-mine-head" aria-expanded={!mineFold} onClick={toggleMine}>
                <Icon name={mineFold ? "chevronRight" : "chevronDown"} size={12} />
                <strong>{t("prr.mine.title", { n: pinned.length })}</strong>
                <span className="hint">{t("prr.mine.scope")}</span>
              </button>
              {!mineFold && pinned.map((p) => <MineRow key={p.number} p={p} on={p.number === selected} remote={target?.remote ?? ""} />)}
            </section>
          )}
          {items && !shown.length && !pinned.length && <p className="prr-note">{items.length ? (q ? t("prr.noMatch") : t("prr.emptyTab")) : t("prr.emptyAll")}</p>}
          {shown.map((p) => (
            <Item key={p.number} p={p} on={p.number === selected} remote={target?.remote ?? ""} repo={repo} />
          ))}
        </div>
      </aside>
      {listSplit}
      </>
      )}
      <section className="prr-detail">
        {current ? <Detail key={current.number} pr={current} target={target ?? null} repo={repo} me={me} /> : <div className="prr-empty">{items ? t("prr.pick") : ""}</div>}
      </section>
      <PrPopupHost />
    </div>
  );
}

const itemMenu = (p: InboxPr, remote: string) =>
  contextMenu(() => [
    { label: t("prr.github"), action: () => ops.openUrl(p.url) },
    { label: t("pr.checkout", { head: p.head }), action: () => ops.checkoutPr(remote, p.head) },
    { separator: true },
    { label: t("pr.copyUrl"), action: () => ops.copy(p.url) },
  ]);

/** 내가 올린 PR 한 줄: #번호 제목 · 리뷰어 진행도(승인/요청 리뷰어) · 상대 시각 */
const MineRow = memo(function MineRow({ p, on, remote }: { p: InboxPr; on: boolean; remote: string }) {
  const g = reviewProgress(p);
  return (
    <div
      role="option"
      aria-selected={on}
      tabIndex={0}
      className={`prr-item prr-mine-row${on ? " on" : ""}`}
      onClick={() => prReview.select(p.number)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), prReview.select(p.number))}
      onContextMenu={itemMenu(p, remote)}
    >
      <span className="prr-num">#{p.number}</span>{" "}
      <span className="prr-item-title">{p.title}</span>{" "}
      {p.draft ? <span className="prr-badge">{t("prr.st.draft")}</span> : g.total ? <span className="prr-prog" title={t("prr.mine.progress", { a: g.done, p: g.pending })}>{g.done}/{g.total}</span> : <span className="prr-prog none">{t("prr.mine.noReviewers")}</span>}{" "}
      <time className="prr-time" dateTime={p.updatedAt}>{relTime(p.updatedAt, intlTag())}</time>
    </div>
  );
});

const Item = memo(function Item({ p, on, remote, repo }: { p: InboxPr; on: boolean; remote: string; repo: string }) {
  const st = status(p);
  return (
    <div
      role="option"
      aria-selected={on}
      tabIndex={0}
      className={`prr-item${on ? " on" : ""}${p.reRequested ? " rereq" : ""}`}
      onClick={() => prReview.select(p.number)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), prReview.select(p.number))}
      onContextMenu={itemMenu(p, remote)}
    >
      <Who name={p.author} src={p.authorAvatar} />
      <div className="prr-item-main">
        <div className="prr-item-top">
          <span className={`prr-badge ${st.cls}`}>{st.label}</span>
          <AiMark k={aiKey(repo, p.number)} sha={p.headSha} />
          <span className="prr-num">#{p.number}</span>
          <time className="prr-time" dateTime={p.updatedAt}>{relTime(p.updatedAt, intlTag())}</time>
        </div>
        <div className="prr-item-title">{p.title}</div>
        <div className="prr-item-meta">
          <span>{p.author}</span>
          <span className="prr-add">+{p.additions}</span>
          <span className="prr-del">−{p.deletions}</span>
          <span title={t("prr.card.approve")}>✓ {p.approvals}</span>
          {p.labels.map((l) => <span key={l} className="prr-label">{l}</span>)}
        </div>
      </div>
    </div>
  );
});

function Detail({ pr, target, repo, me }: { pr: InboxPr; target: Target | null; repo: string; me: string | null }) {
  const [tab, setTab] = useState<"overview" | "ai" | "files">("overview");
  const [range, setRange] = useState<Range>(null); // 변경 파일 탭의 범위: null = 전체 변경, sha = 커밋 하나 (이 PR 화면 안에서만 산다)
  // 타임라인 커밋 클릭: 그래프로 나가지 않고 변경 파일 탭에서 그 커밋 범위를 본다
  const [from, setFrom] = useState<string | null>(null); // 개요에서 넘어왔으면 그 sha, 안내줄에서 왔으면 "" (돌아가기 버튼·⌘[). null = 직접 들어옴
  const [menuReq, setMenuReq] = useState(0); // 커밋별 메뉴를 열어 달라는 요청 번호 (안내줄: 새 커밋 범위를 정확히 못 정할 때)
  const [back, setBack] = useState(0); // 돌아가기 요청 번호 (개요가 다시 보일 때 그 항목으로 스크롤·강조)
  const [backTo, setBackTo] = useState<"overview" | "ai" | "pop">("overview"); // 돌아갈 탭: 타임라인·안내줄에서 왔으면 개요, AI 코멘트 "코드에서 보기"면 AI 리뷰(그 카드)
  const [card, setCard] = useState(0); // AI 리뷰로 돌아갈 때 보여 줄 카드 번호
  const [reveal, setReveal] = useState<DiffReveal | undefined>(undefined); // 변경 파일 탭이 스크롤할 파일·줄
  const [seenAi, setSeenAi] = useState(false);
  const [seen, setSeen] = useState(false); // 변경 파일 탭을 한 번이라도 열었는지 (처음 열 때 준비·조회 시작, 그 뒤로는 언마운트 없이 숨김만)
  const panels = useRef<HTMLDivElement>(null);
  const popBack = useRef<{ tab: "overview" | "ai" | "files"; range: Range; pop: { items: PopItem[]; i: number; scroll?: number } | null } | null>(null);
  const [popTab, setPopTab] = useState<"overview" | "ai" | "files">("overview"); // sha 링크로 넘어온 곳 (돌아가기 글자)
  const openCommit = useCallback((sha: string) => (setRange(sha), setFrom(sha), setBackTo("overview"), setTab("files")), []);
  // AI 코멘트 "코드에서 보기": 전체 변경 범위의 그 파일·줄로 가고 "← AI 리뷰로 돌아가기"로 그 카드에 복귀
  const openCode = useCallback((file: string, line: number, i: number) => (setRange(null), setFrom(""), setBackTo("ai"), setCard(i), setReveal((r) => ({ file, line, seq: (r?.seq ?? 0) + 1 })), setTab("files")), []);
  const pickRange = useCallback((r: Range) => (setRange(r), setFrom((f) => (f === "" ? "" : null))), []); // 안내줄에서 왔으면 메뉴로 범위를 골라도 돌아가기 유지
  // 안내줄 "새 커밋 보기": 내 마지막 리뷰 이후 첫 커밋 범위로, 못 정하면 커밋별 메뉴를 연다
  const reviewNew = useCallback((sha: string | null) => (setFrom(""), setBackTo("overview"), sha ? setRange(sha) : setMenuReq((n) => n + 1), setTab("files")), []);
  const openAi = useCallback(() => setTab("ai"), []);
  // 본문·코멘트의 커밋 sha 링크(이 PR의 커밋): 변경 파일 탭 + 그 커밋 범위. 돌아가기는 링크가 있던 탭·항목(팝업이면 같은 항목을 다시 연다)으로
  const openSha = useCallback((sha: string) => {
    const c = cur.current;
    const p = prPopup.get();
    popBack.current = { tab: c.tab, range: c.range, pop: p ? { items: p.items, i: p.i, scroll: document.querySelector<HTMLElement>(".prr-pop-body")?.scrollTop } : null };
    setPopTab(c.tab);
    if (p) prPopup.close(false); // 팝업 위에 팝업을 만들지 않고, 닫고 이동한다
    setRange(sha);
    setFrom(sha);
    setBackTo("pop");
    setTab("files");
  }, []);
  const goBack = useCallback(() => {
    const c = cur.current;
    const pb = c.backTo === "pop" ? popBack.current : null;
    if (pb) (setTab(pb.tab), pb.tab === "files" && setRange(pb.range));
    else setTab(c.backTo === "pop" ? "overview" : c.backTo);
    setBack((n) => n + 1);
  }, []);
  useEffect(() => void (tab === "files" && setSeen(true)), [tab]);
  useEffect(() => void (tab === "ai" && setSeenAi(true)), [tab]);
  // ⌘[ (Ctrl+[): PR 화면이 열려 있는 동안은 이쪽이 가져간다 (25d 가이드의 이전 단계 단축키와 겹치므로 뒤에서 도는 가이드는 막는다)
  const cur = useRef({ tab, from, backTo, range });
  cur.current = { tab, from, backTo, range };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || !(e.key === "[" || e.code === "BracketLeft")) return;
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (cur.current.tab === "files" && cur.current.from !== null) goBack();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [goBack]);
  // 개요로 돌아오면 넘어갔던 커밋 항목을 보이게 하고 잠깐 강조 (스크롤은 즉시, smooth 금지)
  useEffect(() => {
    if (!back || tab !== "ai") return;
    const el = panels.current?.querySelector<HTMLElement>(`[data-card="${card}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.classList.add("flash");
    const id = setTimeout(() => el.classList.remove("flash"), 1600);
    return () => (clearTimeout(id), el.classList.remove("flash"));
  }, [back]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!back || tab !== "overview" || !from || backTo === "pop") return;
    const li = panels.current?.querySelector<HTMLElement>(`[data-sha="${from}"]`);
    if (!li) return;
    li.scrollIntoView({ block: "center" });
    li.classList.add("flash");
    const id = setTimeout(() => li.classList.remove("flash"), 1600);
    return () => (clearTimeout(id), li.classList.remove("flash"));
  }, [back]); // eslint-disable-line react-hooks/exhaustive-deps
  // 돌아오면 sha 링크가 있던 항목(본문 카드·코멘트·AI 카드)을 보이게 하고, 팝업에서 왔으면 같은 항목·스크롤 위치로 다시 연다
  useEffect(() => {
    const pb = popBack.current;
    if (!back || backTo !== "pop" || !pb || tab !== pb.tab) return;
    popBack.current = null;
    const ref = pb.pop?.items[pb.pop.i].ref;
    const el = ref ? panels.current?.querySelector<HTMLElement>(`[data-pop="${ref}"]`) : null;
    el?.scrollIntoView({ block: "center" });
    if (pb.pop) prPopup.open(pb.pop.items, pb.pop.i, pb.pop.scroll);
    if (!el) return;
    el.classList.add("flash");
    const id = setTimeout(() => el.classList.remove("flash"), 1600);
    return () => (clearTimeout(id), el.classList.remove("flash"));
  }, [back]); // eslint-disable-line react-hooks/exhaustive-deps
  const [d, setD] = useState<Load<PrDetail> | null>(null);
  // 커밋 sha 링크 클릭·호버 (Markdown이 prSha로 넘긴다): 이 PR의 커밋 → 변경 파일 탭, 아니면 로컬에 있으면 그래프에서 선택, 없으면 GitHub
  const timeline = d?.data?.timeline;
  useEffect(() => {
    const commit = (sha: string) => timeline?.find((it) => it.kind === "commit" && it.sha && (it.sha.startsWith(sha) || sha.startsWith(it.sha)));
    const web = pr.url.replace(/\/pull\/\d+.*$/, "");
    prSha.setHandler({
      repo,
      click: (sha, href) => {
        prSha.leave();
        const c = commit(sha);
        if (c?.sha) return openSha(c.sha);
        api.git(repo, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]).then(
          (out) => (prReview.close(), revealCommit(out.trim() || sha)),
          () => ops.openUrl(href ?? `${web}/commit/${sha}`),
        );
      },
      known: (sha) => {
        const c = commit(sha);
        return c ? { title: (c.body ?? "").split("\n")[0], author: c.author, at: c.at } : null;
      },
    });
    return () => (prSha.setHandler(null), prSha.leave());
  }, [repo, pr.url, timeline, openSha]);
  const seq = useRef(0);
  const run = useCallback(() => {
    if (!target) return;
    const mine = ++seq.current;
    setD((cur) => (cur?.data && cur.key === String(pr.number) ? cur : null)); // head만 바뀐 새로고침이면 기존 화면(탭·스크롤)을 유지한 채 조용히 다시 읽는다
    api.prDetail(target.account, target.repo, pr.number, ctx.repo || undefined).then(
      (data) => mine === seq.current && setD({ key: String(pr.number), data, error: null }),
      (e) => mine === seq.current && setD({ key: String(pr.number), data: null, error: String(e), token: isTokenErr(e) }),
    );
  }, [target, pr.number, pr.headSha]);
  useEffect(() => {
    run();
    return () => void seq.current++;
  }, [run]);
  const st = status(pr);
  // 탭 보조 글: 개요·대화 = 미해결 스레드가 있으면 그 수(warn), 아니면 대화 수 / 변경 파일 = PR 전체 규모 (조회 전에는 빈 줄로 높이만 유지)
  const dd = d?.data;
  const subOverview = dd ? (dd.unresolvedThreads ? t("prr.sub.unresolved", { n: dd.unresolvedThreads }) : t("prr.timeline", { n: dd.timeline.length })) : "";
  const subFiles = dd ? t("prr.files.sum", { n: dd.files, a: dd.additions, d: dd.deletions }) : "";
  return (
    <>
      <header className="prr-head">
        <div className="prr-head-row">
          <h2><span className="prr-num">#{pr.number}</span> {pr.title}</h2>
          <button onClick={() => ops.openUrl(pr.url)}>{t("prr.github")}</button>
        </div>
        <div className="prr-head-meta">
          <span className={`prr-badge ${st.cls}`}>{st.label}</span>
          <span className="prr-branch">{pr.head} → {pr.base}</span>
          <code className="prr-sha">{pr.headSha.slice(0, 7)}</code>
          {pr.labels.map((l) => <span key={l} className="prr-label">{l}</span>)}
        </div>
        <div className="prr-tabs sub" role="tablist">
          <button role="tab" aria-label={t("prr.tab.overview")} aria-description={subOverview} aria-selected={tab === "overview"} className={tab === "overview" ? "on" : ""} onClick={() => setTab("overview")}>
            {t("prr.tab.overview")}
            <small className={d?.data?.unresolvedThreads ? "is-warn" : ""}>{subOverview}</small>
          </button>
          <AiTabButton k={aiKey(repo, pr.number)} sha={pr.headSha} tl={dd?.timeline} on={tab === "ai"} onClick={() => setTab("ai")} />
          <button role="tab" aria-label={t("prr.tab.files")} aria-description={subFiles} aria-selected={tab === "files"} className={tab === "files" ? "on" : ""} onClick={() => setTab("files")}>
            {t("prr.tab.files")}
            <small>{subFiles}</small>
          </button>
        </div>
      </header>
      {/* 두 탭 패널은 언마운트하지 않고 겹쳐 두고 숨긴다(visibility): 스크롤·펼침·선택 파일·diff 스크롤이 탭을 오가도 그대로 */}
      <div className="prr-panels" ref={panels}>
      <div className={"prr-body" + (tab !== "overview" ? " off" : "")}>
        {!d && <p className="prr-note">{t("common.loading")}</p>}
        {d?.error && (
          <div className="prr-note" role="alert">
            <p>{d.error}</p>
            {d.token ? <button onClick={ops.manageAccounts}>{t("prr.connect")}</button> : <button onClick={run}>{t("prr.retry")}</button>}
          </div>
        )}
        {d?.data && <Overview pr={pr} d={d.data} me={me} k={aiKey(repo, pr.number)} onCommit={openCommit} onNew={reviewNew} onAi={openAi} />}
      </div>
      {d?.data && target && seenAi && (
        <div className={"prr-body ai" + (tab === "ai" ? "" : " off")}>
          <PrAi repo={repo} target={target} pr={pr} d={d.data} onCode={openCode} />
        </div>
      )}
      {d?.data && target && seen && (
        <div className={"prr-body files" + (tab === "files" ? "" : " off")}>
          <PrFiles repo={repo} remote={target.remote} pr={pr} d={d.data} range={range} setRange={pickRange} active={tab === "files"} onBack={from !== null ? goBack : undefined} backLabel={backTo === "ai" || (backTo === "pop" && popTab === "ai") ? t("prr.files.backAi") : backTo === "pop" && popTab === "files" ? t("prr.files.backRange") : undefined} menuReq={menuReq} reveal={reveal} />
        </div>
      )}
      </div>
    </>
  );
}

const fmtDate = (iso: string) => dateFmt({ dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
const MERGE = { MERGEABLE: "prr.merge.ok", CONFLICTING: "prr.merge.conflict", UNKNOWN: "prr.merge.unknown" } as const;
const CI = { SUCCESS: "prr.ci.success", FAILURE: "prr.ci.failure", PENDING: "prr.ci.pending" } as const;
const REVIEW = { APPROVED: "prr.st.approved", CHANGES_REQUESTED: "prr.st.changes", COMMENTED: "prr.st.commented" } as const;

const KIND_CLS = { APPROVED: "ok", CHANGES_REQUESTED: "warn", COMMENTED: "info" } as const;
const kindOf = (it: PrTimelineItem) => (it.kind === "review" ? (it.state && it.state in REVIEW ? t(REVIEW[it.state as keyof typeof REVIEW]) : t("prr.review")) : t("prr.comment"));

/** 개요 맨 위 안내줄: 내 리뷰 상태와 다음 할 일 한 문장. 해당 없으면 null */
function hintOf(pr: InboxPr, d: PrDetail): { tone: "info" | "warn"; text: string; go?: boolean } | null {
  if (pr.isMine) return { tone: "info", text: pr.draft ? t("prr.hint.mineDraft") : d.requiredApprovals != null ? t("prr.hint.mine", { n: d.approvals, m: d.requiredApprovals }) : t("prr.hint.mineNoReq", { n: d.approvals }) };
  if (pr.draft) return { tone: "info", text: t("prr.hint.draft") };
  if (pr.reRequested) return { tone: "warn", text: t("prr.hint.newCommits"), go: true };
  if (pr.myReview === "approved") return { tone: "info", text: t("prr.hint.approved") };
  if (pr.myReview === "changes_requested") return { tone: "info", text: t("prr.hint.changes") };
  if (pr.myReview === "commented") return { tone: "info", text: t("prr.hint.commented") };
  if (pr.reviewRequested) return { tone: "warn", text: t("prr.hint.req") };
  return null;
}

function Overview({ pr, d, me, k, onCommit, onNew, onAi }: { pr: InboxPr; d: PrDetail; me: string | null; k: string; onCommit: (sha: string) => void; onNew: (sha: string | null) => void; onAi: () => void }) {
  const hint = hintOf(pr, d);
  useLocale();
  const tl = useMemo(() => [...d.timeline].sort((a, b) => a.at.localeCompare(b.at)), [d.timeline]);
  // 팝업에서 이전/다음으로 넘길 항목: 본문이 있는 리뷰·코멘트만 (타임라인 순서). 언어가 바뀌면 종류 글자도 다시 만든다
  const pops = useMemo(() => {
    const list: PopItem[] = [];
    const at = new Map<number, number>();
    tl.forEach((it, i) => {
      if (it.kind === "commit" || !it.body) return;
      at.set(i, list.length);
      list.push({ author: it.author, avatar: it.avatar, kind: kindOf(it), cls: it.kind === "review" ? KIND_CLS[(it.state ?? "") as keyof typeof KIND_CLS] ?? "" : "", at: it.at, body: it.body, ref: `tl${i}` });
    });
    return { list, at };
  }, [tl, intlTag()]); // eslint-disable-line react-hooks/exhaustive-deps
  const openBody = useCallback(() => prPopup.open([{ author: pr.author, avatar: pr.authorAvatar, kind: t("prr.body"), at: pr.createdAt, body: d.body, ref: "body" }]), [pr, d.body]);
  return (
    <>
      {hint && (
        <div className={`prr-hint is-${hint.tone}`} role="status">
          <span>{hint.text}</span>
          {hint.go && <button onClick={() => onNew(firstCommitAfterMyReview(d.timeline, me))}>{t("prr.hint.newCommitsGo")}</button>}
        </div>
      )}
      <AiNewHint k={k} sha={pr.headSha} tl={d.timeline} onOpen={onAi} />
      <div className="prr-card">
        <div className="prr-by">
          <Who name={pr.author} src={pr.authorAvatar} />
          <div>
            <strong>{pr.author}</strong>
            <div className="hint">{t("prr.created", { at: fmtDate(pr.createdAt) })}</div>
          </div>
        </div>
        <div className="prr-stats">
          <Stat label={t("prr.card.approve")} v={d.requiredApprovals != null ? `${d.approvals}/${d.requiredApprovals}` : String(d.approvals)} />
          <Stat label="CI" v={d.ci ? t(CI[d.ci]) : t("prr.ci.none")} tone={d.ci === "SUCCESS" ? "ok" : d.ci === "FAILURE" ? "bad" : ""} />
          <Stat label={t("prr.card.merge")} v={t(MERGE[d.mergeable])} tone={d.mergeable === "CONFLICTING" ? "bad" : ""} />
          <Stat label={t("prr.card.threads")} v={String(d.unresolvedThreads)} tone={d.unresolvedThreads ? "warn" : ""} />
          <Stat label={t("prr.card.files", { n: d.files })} v={<><span className="prr-add">+{d.additions}</span> <span className="prr-del">−{d.deletions}</span></>} />
        </div>
      </div>
      {/* 본문: 미리보기 몇 줄만. 클릭·Enter로 팝업에서 크게/작게 읽는다 */}
      {d.body ? (
        <div className="prr-card prr-peek" {...peek(openBody, "body")}>
          <div className="prr-peek-head">
            <strong>{t("prr.body")}</strong>
            <span className="hint">{t("prr.chars", { n: d.body.length })}</span>
            <span className="prr-go" aria-hidden>{t("prr.pop.open")}</span>
          </div>
          <MdPreview text={d.body} lines={4} />
        </div>
      ) : (
        <div className="prr-card">
          <strong>{t("prr.body")}</strong>
          <p className="hint">{t("prr.bodyEmpty")}</p>
        </div>
      )}
      <h3 className="prr-h3">{t("prr.timeline", { n: tl.length })}</h3>
      <ol className="prr-timeline">
        {tl.map((it, i) => <Entry key={i} it={it} idx={i} pop={pops.at.get(i) ?? -1} list={pops.list} pr={pr} onCommit={onCommit} head={it.kind === "commit" && !!it.sha && it.sha === d.headSha} />)}
      </ol>
    </>
  );
}

function Stat({ label, v, tone = "" }: { label: string; v: React.ReactNode; tone?: string }) {
  return (
    <div className={`prr-stat ${tone}`}>
      <span className="hint">{label}</span>
      <strong>{v}</strong>
    </div>
  );
}

function Entry({ it, idx, pop, list, head, pr, onCommit }: { it: PrTimelineItem; idx: number; /** 팝업 목록에서의 위치(-1 = 본문 없음) */ pop: number; list: PopItem[]; head: boolean; pr: InboxPr; onCommit: (sha: string) => void }) {
  const when = <time className="hint" title={fmtDate(it.at)} dateTime={it.at}>{relTime(it.at, intlTag())}</time>;
  if (it.kind === "commit")
    return (
      <li className="prr-entry commit" data-sha={it.sha ?? undefined}>
        <span className="prr-dot" />
        <div
          className="prr-line prr-click"
          role="button"
          tabIndex={0}
          title={t("prr.openCommit")}
          onClick={() => it.sha && onCommit(it.sha)}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && it.sha && (e.preventDefault(), onCommit(it.sha))}
          onContextMenu={contextMenu(() => [
            { label: t("prr.commit.graph"), action: () => it.sha && (prReview.close(), revealCommit(it.sha)) },
            { label: t("prr.commit.github"), action: () => ops.openUrl(`${pr.url}/commits/${it.sha}`) },
          ])}
        >
          <strong>{it.author}</strong> <span className="hint">{t("prr.commit")}</span> {when} <span className="prr-msg">{it.body}</span>
          <span className="prr-line-end">
            {head && <span className="prr-badge info">head</span>}
            <span className="prr-go" aria-hidden>{t("prr.openCommit.go")}</span>
            <code className="prr-sha">{(it.sha ?? "").slice(0, 7)}</code>
          </span>
        </div>
      </li>
    );
  const kind = kindOf(it);
  const meta = <><strong>{it.author}</strong> <span className="hint">{kind}</span> {when}</>;
  return (
    <li className={`prr-entry ${it.kind}${pop >= 0 ? " prr-click prr-peek" : ""}`} {...(pop >= 0 ? peek(() => prPopup.open(list, pop), `tl${idx}`) : {})}>
      <span className="prr-dot" />
      <div className="prr-line">
        <div className="prr-peek-head">
          <span>{meta}</span>
          {pop >= 0 && <span className="prr-go" aria-hidden>{t("prr.pop.open")}</span>}
        </div>
        {pop >= 0 && <MdPreview text={it.body!} lines={2} />}
      </div>
    </li>
  );
}
