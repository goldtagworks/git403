import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { COMPACT, DETAIL, hideWindow, listen, onOpenRepo, onSelect, openCommit, reportSelected } from "../shared/api/bridge";
import { api } from "../shared/api/api";
import { locale, onLocale, t, useLocale } from "../shared/i18n/i18n";
import { ChangesView } from "../widgets/changes/ChangesView";
import { CommitGraph } from "../widgets/commit-graph/CommitGraph";
import { Details } from "../widgets/details/Details";
import { DomMenuHost } from "../shared/ui/menu";
import { ctx, jobNote, ops, prBus, store, stored, touch, type JobTrack } from "../shared/model/ops";
import { prompt, PromptHost } from "../shared/ui/prompt";
import { AiHost } from "../features/ai/AiSheets";
import { HostingHost } from "../features/hosting/HostingSheets";
import { PrReviewHost } from "../features/hosting/PrReview";
import { InspectorHost } from "../features/inspect/Inspector";
import type { IssueRule } from "../shared/lib/issues";
import { QuickLaunch } from "../features/quick-launch/QuickLaunch";
import { RebaseHost } from "../features/rebase/RebaseSheet";
import { RewordHost } from "../features/rebase/Reword";
import { AutoFetch, SettingsHost } from "../widgets/settings/SettingsSheet";
import { GRAPH_PAGE, graphLimit, pref } from "../shared/lib/settings";
import { Sidebar } from "../widgets/sidebar/Sidebar";
import { markSelected } from "../shared/model/selection";
import { useRatioSplit, useSplit } from "../shared/ui/Splitter";
import { Notices } from "../shared/ui/Notices";
import { gh, suggestOtherAccount } from "../shared/model/gh";
import { StatusBar } from "../widgets/status-bar/StatusBar";
import { toast, toastError } from "../shared/lib/toast";
import { Toasts } from "../shared/ui/Toasts";
import { Tabs } from "../widgets/tabs/Tabs";
import { Toolbar } from "../widgets/toolbar/Toolbar";
import { WORKTREE, type GraphView, type Ref, type RepoChange, type Status, type Submodule, type Worktree } from "../shared/api/types";
import { useTheme } from "../shared/lib/theme";
import { hideSplash } from "../shared/lib/splash";
import { guide } from "../shared/model/guide";
import { bigView } from "../shared/model/bigview";
import { dismissTop } from "../shared/lib/dismiss";
import { appMenu } from "../shared/model/appMenu";
import "./style.css";

/** 새로 받은 값이 이전과 내용이 같으면 이전 참조를 돌려준다 (memo된 화면을 다시 그리지 않게) */
function same<T>(prev: T, next: T): T {
  return prev === next || JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}

if (import.meta.env.VITE_MOCK) await import("../shared/api/mock");

// Rust가 만드는 문구의 언어: 시작 시와 언어가 바뀔 때 알린다 (실패해도 앱은 계속)
api.setLocale(locale()).catch(() => {});
onLocale(() => api.setLocale(locale()).catch(() => {}));

/** fetch 오류가 "태그 덮어쓰기 거부"뿐이면 그 태그 이름들(쉼표로), 아니면 null.
 *  --all이면 거부된 원격마다 "error: could not fetch <원격>"이 붙는다. 다른 error·fatal·거부가 있으면 진짜 실패다 */
function clobberedTags(err: string): string | null {
  const tags = new Set<string>();
  for (const l of err.replace(/^git exited with code [^:]*: /, "").split("\n").map((l) => l.trim())) {
    const m = l.match(/^! \[rejected\]\s+(\S+)\s+->\s+\S+\s+\(would clobber existing tag\)$/);
    if (m) tags.add(m[1]);
    else if (/^(fatal|error):/.test(l) ? !/^error: could not fetch \S+$/.test(l) : l.startsWith("! ")) return null;
  }
  return tags.size ? [...tags].join(", ") : null;
}
/** 이미 안내한 저장소·태그 (자동 Fetch마다 반복하지 않게) */
const keptTags = new Set<string>();

function App() {
  useLocale(); // 언어가 바뀔 때만 App 아래 non-memo 화면이 다시 그려진다
  const theme = useTheme();
  const [repo, setRepo] = useState("");
  const [recent, setRecent] = useState<string[]>(() => stored("recent", []));
  // 폴더 스캔으로 찾은 저장소. 최근 목록(10개)과 따로 두고 목록에서는 최근 다음에 보인다.
  const [known, setKnown] = useState<string[]>(() => stored("known", []));
  const repos = useMemo(() => [...new Set([...recent, ...known])], [recent, known]);
  // 저장소 목록(최근·폴더 스캔)에서 지운다. path가 없으면 전부. 저장소 자체는 건드리지 않는다.
  const forget = useCallback((path?: string) => {
    const keep = (list: string[]) => (path ? list.filter((x) => x !== path) : []);
    setRecent((l) => (store("recent", keep(l)), keep(l)));
    setKnown((l) => (store("known", keep(l)), keep(l)));
  }, []);
  const [tabs, setTabs] = useState<string[]>(() => (ctx.tabs = pref("restoreTabs") ? stored("tabs", []) : []));
  const [view, setView] = useState<GraphView | null>(null);
  const [refs, setRefs] = useState<Ref[]>([]);
  const [submodules, setSubmodules] = useState<Submodule[]>([]);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [issueRules, setIssueRules] = useState<IssueRule[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [wide, setWide] = useState(true); // 로컬 변경사항을 그래프 자리까지 넓게 (고를 때마다 다시 켠다)
  const pick = useCallback((id: string | null) => (id === WORKTREE && setWide(true), setSelected(id)), []); // 이미 골라 둔 상태에서 다시 눌러도 넓게
  const [job, setJob] = useState<{ id: number; name: string; quiet?: boolean } | null>(null);
  const [message, setMessage] = useState("");
  const [palette, setPalette] = useState(false);
  const [sideW, sideSplit] = useSplit("sidebar", 240, 160, 480, "x");
  const [listH, listSplit] = useRatioSplit("commits-ratio", 0.55, 120, 140, "y"); // 창 크기가 바뀌면 그래프·상세가 같은 비율로
  const repoRef = useRef("");
  const loadSeq = useRef(0);
  // 그래프를 읽은 커밋 수(저장소별). full = 상한까지 다 읽었는지가 아니라 "읽은 개수만큼 꽉 찼는지"(더 있을 수 있음)
  const graphRead = useRef({ repo: "", n: 0, full: false });
  const moreBusy = useRef(false);
  const [pending, setPending] = useState<string | null>(null); // 여는 중인 저장소 (탭 표시용)
  const pendingRef = useRef<string | null>(null);
  // 작업 번호 → 정보. job-done이 start_job 응답보다 먼저 오면 결과를 early에 두었다가 등록 때 처리한다.
  const jobs = useRef(new Map<number, { name: string; repo: string; onDone?: () => void; remote?: boolean; quiet?: boolean; note?: ReturnType<typeof jobNote>; args?: string[]; shell?: string }>());
  const ignored = useRef(new Set<number>()); // 사용자 작업에 밀려 취소한 자동 작업 (완료 이벤트 무시)
  const quietFailed = useRef(false); // 자동 작업이 연속 실패 중인지 (안내는 한 번만)
  const early = useRef(new Map<number, string | null>());

  const loadStatus = useCallback(async (path = repoRef.current) => {
    if (!path) return;
    const s = await api.loadStatus(path).catch((e) => (console.warn("load_status", e), undefined));
    if (path !== repoRef.current) return; // 그사이 다른 탭으로 바뀜
    if (s === undefined) return; // 일시적 실패(락 등): 지난 상태를 그대로 둔다 — null로 지우면 변경 화면·ahead/behind가 사라진다
    setStatus((prev) => (ctx.status = same(prev, s)));
  }, []);

  /** 탭 목록 변경. ctx.tabs를 바로 맞춰서 같은 틱의 다음 호출도 최신 값을 본다. */
  const changeTabs = useCallback((fn: (t: string[]) => string[]) => {
    ctx.tabs = fn(ctx.tabs);
    setTabs(ctx.tabs);
  }, []);

  const clear = useCallback(() => {
    repoRef.current = ctx.repo = "";
    store("activeTab", "");
    ctx.refs = ctx.commits = [];
    ctx.status = null;
    ctx.flow = null;
    setRepo("");
    setView(null);
    setRefs([]);
    setSubmodules([]);
    setWorktrees([]);
    setIssueRules([]);
    setStatus(null);
    setSelected(null);
  }, []);

  /** path 없이 부르면 현재 저장소 새로고침. 다른 탭으로 전환 중이면 건너뛴다(전환이 끝나면 새로 읽음). */
  const loadAll = useCallback(async (target?: string) => {
    if (!target && pendingRef.current) return;
    const path = target ?? repoRef.current;
    if (!path) return;
    const seq = ++loadSeq.current;
    pendingRef.current = path === repoRef.current ? null : path;
    setPending(pendingRef.current);
    try {
      const want = graphLimit(graphRead.current.repo === path ? Math.max(graphRead.current.n, GRAPH_PAGE) : undefined); // 스크롤로 늘린 개수 유지 (상한이 작아서 줄었던 값은 한 페이지로)
      // 상태도 같이 받는다 (그래프 뒤에 순서대로 기다리지 않게)
      const [v, r, st] = await Promise.all([api.loadGraph(path, want), api.loadRefs(path), api.loadStatus(path).catch(() => null)]);
      if (seq !== loadSeq.current) return; // 탭을 빨리 바꾸면 늦게 온 이전 결과는 버린다
      graphRead.current = { repo: path, n: want, full: v.commits.length >= want };
      pendingRef.current = null;
      setPending(null);
      const opened = path !== repoRef.current;
      repoRef.current = ctx.repo = path;
      setRepo(path);
      // 내용이 같으면 이전 참조를 그대로 둬서 그래프·사이드바·상세를 다시 그리지 않는다
      setView((prev) => (opened ? v : same(prev, v)));
      setRefs((prev) => same(prev, r)); // 숨김 토글 등
      ctx.refs = r;
      ctx.commits = v.commits;
      // 서브모듈·worktree는 느릴 수 있어 그래프를 막지 않고 따로 받는다. 다른 저장소로 바뀌면 이전 목록은 비운다.
      if (opened) {
        setSubmodules((s) => (s.length ? [] : s));
        setWorktrees((w) => (w.length ? [] : w));
      }
      ops.flowLoad(path);
      if (opened) {
        ops.aiLoad(path);
        gh.refresh(path);
        api.ensureCommitGraph(path).catch(() => {}); // 백그라운드. 없거나 오래됐을 때만 만든다
      }
      // 이슈 링크 규칙은 저장소를 열 때만 읽는다 (규칙 편집은 setIssues로 직접 갱신). 이전 저장소 규칙은 바로 비운다.
      if (opened) {
        setIssueRules((r) => (r.length ? [] : r));
        ops.issueLoad(path).then((r) => seq === loadSeq.current && setIssueRules(r));
      }
      Promise.all([api.loadSubmodules(path).catch(() => []), api.loadWorktrees(path).catch(() => [])]).then(([sm, wt]) => {
        if (seq !== loadSeq.current) return;
        setSubmodules((p) => same(p, sm));
        setWorktrees((p) => same(p, wt));
      });
      setStatus((prev) => (ctx.status = same(prev, st)));
      if (opened) {
        setSelected(null);
        api.watchRepo(path).catch(() => {});
        changeTabs((t) => (t.includes(path) ? t : [...t, path]));
        setRecent((list) => {
          const next = [path, ...list.filter((x) => x !== path)].slice(0, 10);
          store("recent", next);
          return next;
        });
      }
      setSelected((s) => (s && (s === WORKTREE || v.commits.some((c) => c.id === s)) ? s : DETAIL ? null : r.find((x) => x.head)?.target ?? v.commits[0]?.id ?? null)); // 커밋 상세 탭은 확장이 보낸 select만 보인다
    } catch (e) {
      if (seq !== loadSeq.current) return;
      pendingRef.current = null;
      setPending(null);
      // 닫힌 저장소 화면이 남지 않게 (활성 탭을 닫은 뒤·작업공간 전환 실패)
      if (!ctx.tabs.includes(repoRef.current)) clear();
      toastError(t("app.openFail"), t("app.openFailHint", { error: String(e) }));
    }
  }, [loadStatus, changeTabs, clear]);

  /** 그래프 맨 아래 근처로 스크롤하면 읽는 개수를 두 배로(상한까지) 늘려 다시 읽는다. 선택·스크롤 위치는 그대로 */
  const loadMore = useCallback(async () => {
    const path = repoRef.current;
    const g = graphRead.current;
    if (!path || g.repo !== path || !g.full || moreBusy.current || pendingRef.current) return;
    const want = graphLimit(g.n * 2);
    if (want <= g.n) return;
    moreBusy.current = true;
    try {
      const v = await api.loadGraph(path, want);
      if (repoRef.current !== path || graphRead.current !== g) return; // 그사이 다른 저장소·새로고침이 있었으면 버린다
      graphRead.current = { repo: path, n: want, full: v.commits.length >= want };
      ctx.commits = v.commits;
      setView(v);
    } catch (e) {
      toastError(t("app.moreFail"), String(e));
    } finally {
      moreBusy.current = false;
    }
  }, []);

  // 확장(VS Code)이 요청한 커밋 선택. 그래프가 아직 없으면 기억했다가 읽은 뒤, 읽은 범위에 없으면 limit을 늘려 가며 찾는다.
  const wantSel = useRef<string | null>(null);
  const reveal = useCallback(async (sha: string) => {
    if (!repoRef.current || pendingRef.current) return void (wantSel.current = sha);
    wantSel.current = null;
    const path = repoRef.current;
    const find = () => ctx.commits.find((c) => c.id === sha || (sha.length >= 7 && c.id.startsWith(sha)));
    let c = find();
    for (let g = graphRead.current; !c && g.full; g = graphRead.current) {
      await loadMore();
      if (repoRef.current !== path || graphRead.current === g) break; // 상한이거나 저장소가 바뀜
      c = find();
    }
    if (repoRef.current !== path) return;
    if (!c) return toast(t("app.selectMissing", { sha: sha.slice(0, 8) }), { kind: "warning" });
    setSelected(c.id);
    reportSelected(c.id);
  }, [loadMore]);
  useEffect(() => onSelect(reveal), [reveal]);
  useEffect(() => onOpenRepo((p) => void loadAll(p)), [loadAll]);
  useEffect(() => void (view && wantSel.current && reveal(wantSel.current)), [view, reveal]);

  const open = useCallback(async (path?: string) => {
    const p = path ?? (await api.pickRepo());
    if (p) loadAll(p);
  }, [loadAll]);

  const showPalette = useCallback(() => setPalette(true), []);

  // 탭 목록·활성 탭 저장 (재시작 시 복원)
  useEffect(() => store("tabs", tabs), [tabs]);
  useEffect(() => markSelected(selected), [selected]);
  // 크게 보기는 저장소를 바꾸거나 선택이 없어지면 닫는다 (시트에서 다른 커밋을 골라도 유지)
  useEffect(() => bigView.exit(), [repo]);
  useEffect(() => void (selected || bigView.exit()), [selected]);
  useEffect(() => void (repo && store("activeTab", repo)), [repo]);
  ctx.activeTab = pending ?? repo;

  const moveTab = useCallback(
    (path: string, i: number) => changeTabs((t) => {
      if (t[i] === path) return t;
      const n = t.filter((p) => p !== path);
      n.splice(i, 0, path);
      return n;
    }),
    [changeTabs],
  );

  const closeTab = useCallback((path: string) => {
    const i = ctx.tabs.indexOf(path);
    changeTabs((t) => t.filter((x) => x !== path));
    if (path !== repoRef.current) return;
    const next = ctx.tabs[Math.min(i, ctx.tabs.length - 1)];
    if (next) loadAll(next);
    else clear();
  }, [loadAll, changeTabs, clear]);

  /** 메뉴·⌘W 닫기: 팝업 → 저장소 탭 → 창 숨기기 순으로 하나만 닫는다. 숨겨진 창에서는 아무것도 닫지 않는다 */
  const closeKey = useCallback(() => {
    if (document.visibilityState === "hidden") return;
    if (!dismissTop()) ctx.activeTab ? closeTab(ctx.activeTab) : hideWindow();
  }, [closeTab]);

  /** 작업 완료. 다른 탭의 작업이면 다시 읽지 않고 문구에 저장소 이름을 붙인다. */
  const finish = useCallback((id: number, err: string | null) => {
    if (ignored.current.delete(id)) return;
    const j = jobs.current.get(id);
    if (!j) return void early.current.set(id, err);
    jobs.current.delete(id);
    setJob(null);
    setMessage("");
    // fetch --tags: 원격에서 옮겨진 태그만 거부(would clobber)되고 나머지는 받았다 → 실패가 아니라 안내. 로컬 태그는 덮어쓰지 않는다
    const kept = err && j.args?.[0] === "fetch" ? clobberedTags(err) : null;
    if (kept) {
      err = null;
      const key = j.repo + "\0" + kept;
      if (!keptTags.has(key)) keptTags.add(key), toast(t("app.tagKept", { tags: kept }), { kind: "info" });
    }
    if (j.quiet) {
      // 자동 작업: 재조회 없음. 갱신은 파일 감시(repo-changed refs)가 한다. 실패는 연속 실패 중 한 번만 경고 토스트
      if (!err) quietFailed.current = false;
      else if (!quietFailed.current) {
        quietFailed.current = true;
        toast(t("app.jobFailed", { name: j.name }), { kind: "warning", detail: err.trim().split("\n").pop() });
      }
      return;
    }
    const here = j.repo === repoRef.current;
    const prefix = here || j.onDone ? "" : `${j.repo.split(/[\\/]/).pop()}: `;
    if (err) {
      toastError(prefix + t("app.jobFailed", { name: j.name }), err.trim());
      // 다른 gh 계정이면 접근되는지 확인하고 연결·재시도를 제안한다
      if (/repository not found/i.test(err)) suggestOtherAccount(j.repo, () => ctx.job(j.name, j.args ?? [], { repo: j.repo, shell: j.shell, remote: j.remote, onDone: j.onDone }));
    }
    else j.note ? j.note(prefix) : toast(prefix + t("app.jobDone", { name: j.name }), { kind: "success" });
    if (j.remote && here) gh.refresh(j.repo); // 원격 작업 뒤 gh 계정 표시를 다시 읽는다 (작업 중 임시 전환·복원)
    if (!err && here && j.remote && !j.onDone) prBus.emit(); // 원격 ref가 바뀐 작업 뒤 PR 목록을 한 번 다시 읽는다 (onDone이 있으면 그쪽이 책임)
    if (j.onDone) {
      if (!err) j.onDone(); // 복제 등: 성공 시 그 동작만, 실패해도 현재 탭은 다시 읽지 않음
    } else if (here) loadAll();
  }, [loadAll]);

  // ops가 쓰는 공용 동작
  useEffect(() => {
    ctx.busy = () => jobs.current.size > 0;
    ctx.loading = () => !!pendingRef.current;
    ctx.job = async (name, args, opts) => {
      // 사용자 작업이 오면 돌고 있는 자동 작업은 취소하고 이어서 실행한다 (동시에 둘이 돌지 않게)
      if (!opts?.quiet) {
        for (const [id, j] of jobs.current) {
          if (!j.quiet) continue;
          jobs.current.delete(id);
          ignored.current.add(id);
          api.cancelJob(id).catch(() => {});
          setJob(null);
        }
      }
      if (!opts?.quiet) setMessage(t("app.jobRunning", { name }));
      try {
        const repo = opts?.repo ?? repoRef.current;
        const id = opts?.shell ? await api.startShell(repo, opts.shell) : await api.startJob(repo, args, opts?.quiet, opts?.ghUser);
        jobs.current.set(id, { name, repo, onDone: opts?.onDone, remote: opts?.remote, quiet: opts?.quiet, args, shell: opts?.shell, note: opts?.track ? jobNote(name, repo, opts.track) : undefined });
        if (early.current.has(id)) {
          const err = early.current.get(id)!;
          early.current.delete(id);
          finish(id, err);
        } else setJob({ id, name, quiet: opts?.quiet });
      } catch (e) {
        toastError(String(e));
      }
    };
    ctx.open = (p) => loadAll(p);
    ctx.reload = () => loadAll();
    ctx.setIssues = setIssueRules;
    ctx.setTabs = (paths) => {
      changeTabs(() => paths);
      loadAll(paths[0]);
    };
    ctx.addRepos = (paths) =>
      setKnown((k) => {
        const next = [...new Set([...k, ...paths])];
        store("known", next);
        return next;
      });
  }, [loadAll, finish, changeTabs]);

  // 시작: 실행 인자 → 마지막 활성 탭 → 최근 저장소 (설정에서 복원을 끄면 실행 인자만)
  useEffect(() => {
    api.initialRepo().then((p) => loadAll(p ?? (pref("restoreTabs") ? stored<string | null>("activeTab", null) ?? stored<string[]>("recent", [])[0] : undefined))).finally(hideSplash);
  }, [loadAll]);

  // 파일 감시·작업 완료 이벤트. 필요한 것만 다시 읽는다.
  useEffect(() => {
    const un = [
      // git·ssh 인증 입력 요청 (src-tauri/src/askpass.rs)
      listen<{ id: number; prompt: string }>("askpass", async ({ payload: { id, prompt: q } }) => {
        const secret = /password|passphrase|token|암호/i.test(q);
        const r = await prompt({
          title: t("app.authTitle"),
          message: q,
          fields: [{ kind: secret ? "password" : "text", name: "answer", label: secret ? t("app.authSecret") : t("app.authInput") }],
          submit: t("common.ok"),
        });
        api.askpassReply(id, r ? String(r.answer) : null);
      }),
      listen<RepoChange>("repo-changed", ({ payload }) => (touch(), payload.refs ? loadAll() : loadStatus())),
      listen<[number, string | null]>("job-done", ({ payload: [id, err] }) => finish(id, err)),
      // macOS 메뉴 "닫기"(⌘W, src-tauri lib.rs — 메뉴 막대가 만들어지기 전의 기본 메뉴): 같은 처리
      listen("close-key", closeKey),
    ];
    return () => un.forEach((p) => p.then((f) => f()));
  }, [loadAll, loadStatus, finish, closeKey]);

  // 앱 메뉴 막대(shared/model/appMenu.ts): 메뉴가 부를 동작을 넘기고, 저장소 유무·탭 수가 바뀔 때만 다시 만든다 (렌더링과 무관)
  useEffect(() => appMenu.start({ open, palette: showPalette, refresh: loadAll, close: closeKey }), [open, showPalette, loadAll, closeKey]);
  useEffect(() => appMenu.set({ repo: !!repo, tabs: tabs.length }), [repo, tabs.length]);

  // 단축키 (macOS ⌘, 그 외 Ctrl)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      // ⌥⌘I(Alt+Ctrl+I): AI 읽는 흐름 가이드 패널 열기·닫기 (입력창 포커스 중엔 무시)
      if (e.altKey && !e.shiftKey && e.code === "KeyI") {
        if (repoRef.current && ops.aiOn() && !(e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]")) {
          e.preventDefault();
          guide.toggle();
        }
        return;
      }
      // ⌘⇧↩(Ctrl+Shift+Enter): diff 크게 보기 열기·닫기 (입력창 포커스 중엔 무시)
      if (e.shiftKey && !e.altKey && e.key === "Enter") {
        // 시트(파일 히스토리·Blame)가 열려 있으면 시트가 자기 크게 보기로 받는다
        if (repoRef.current && !document.querySelector(".sheet-backdrop") && !(e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]")) {
          e.preventDefault();
          bigView.toggle();
        }
        return;
      }
      // ⌘⌥←/→(Ctrl+Alt+←/→): 이전·다음 탭 (입력창 포커스 중엔 무시, 양끝에서 멈춤)
      if (e.altKey && !e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        if (!(e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]")) {
          e.preventDefault();
          ops.tabStep(e.key === "ArrowLeft" ? -1 : 1);
        }
        return;
      }
      const k = e.key.toLowerCase();
      // Ctrl+W(macOS는 메뉴가 먼저 받아 close-key로 같은 처리): 팝업이 있으면 팝업, 없으면 저장소 탭을 닫는다
      if (k === "w" && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        if (!dismissTop() && ctx.activeTab) closeTab(ctx.activeTab);
        return;
      }
      const map: Record<string, () => void> = e.shiftKey
        ? { f: ops.fetch, l: ops.pullQuick, p: ops.pushQuick, s: ops.stash, b: () => ops.createBranch() }
        : { o: () => open(), p: () => setPalette(true), r: () => loadAll(), ",": () => ops.openSettings() };
      if (map[k] && (repoRef.current || k === "o" || k === "p" || k === ",")) {
        e.preventDefault();
        map[k]();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, loadAll, closeTab]);

  // Esc: 크게 보기 닫기. 시트·메뉴가 열려 있으면 그쪽만 닫는다 (React가 시트를 닫기 전에 보려고 capture 단계에서 듣는다)
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !bigView.open || document.querySelector('.sheet-backdrop, .dom-menu-backdrop, [role="dialog"], [role="menu"]')) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest?.("input, textarea, select, [contenteditable]")) return void (el as HTMLElement).blur?.(); // 입력창의 Esc는 포커스만 푼다
      e.preventDefault();
      bigView.exit();
    };
    window.addEventListener("keydown", onEsc, true);
    return () => window.removeEventListener("keydown", onEsc, true);
  }, []);

  // compact: 행 클릭 → 확장이 변경 파일 quick pick(WORKTREE면 소스 제어 뷰)을 연다
  const openInExt = useCallback((id: string) => openCommit(repoRef.current, id), []);
  const commit = useMemo(() => view?.commits.find((c) => c.id === selected) ?? null, [view, selected]);
  const localCount = status?.files.length ?? 0;

  return (
    <div className={COMPACT ? "app compact" : DETAIL ? "app detail-mode" : "app"}>
      {!COMPACT && !DETAIL && <Toolbar
        repo={repo}
        refs={refs}
        status={status}
        busy={!!job && !job.quiet}
        recent={repos}
        theme={theme.mode}
        onTheme={theme.setMode}
        onOpen={open}
        onForget={forget}
        onQuickLaunch={showPalette}
      />}
      {!COMPACT && !DETAIL && tabs.length > 0 && <Tabs tabs={tabs} active={pending ?? repo} onOpen={loadAll} onClose={closeTab} onAdd={open} onMove={moveTab} />}
      <Notices />
      {status?.operation && (
        <div className="banner op">
          <span>{t("app.opBanner", { op: status.operation })}</span>
          <button onClick={() => ops.continueOp(status.operation!)}>{t("app.continue")}</button>
          {status.operation !== "merge" && <button onClick={() => ops.skipOp(status.operation!)}>{t("app.skip")}</button>}
          <button onClick={() => ops.abortOp(status.operation!)}>{t("app.abort")}</button>
        </div>
      )}
      {view ? (
        <div className="workspace">
          {!COMPACT && !DETAIL && (
            <div className="pane side" style={{ width: sideW }}>
              <Sidebar repo={repo} refs={refs} submodules={submodules} worktrees={worktrees} onSelect={setSelected} />
            </div>
          )}
          {!COMPACT && !DETAIL && sideSplit}
          <main className="main" data-wide={(!COMPACT && !DETAIL && selected === WORKTREE && status && wide) || undefined}>
            {!DETAIL && <div className="pane graph" style={{ height: COMPACT ? "100%" : `${listH * 100}%` }}>
              <CommitGraph
                view={view}
                refs={refs}
                theme={theme.resolved}
                selected={selected}
                onSelect={pick}
                onMore={loadMore}
                localCount={localCount}
                onOpen={COMPACT ? openInExt : undefined}
              />
            </div>}
            {!COMPACT && !DETAIL && listSplit}
            {!COMPACT && !DETAIL && selected === WORKTREE && status && wide && (
              <div className="wide-bar">
                <button onClick={() => setWide(false)}>← {t("app.backToGraph")}</button>
                <span>{t("graph.localChanges")}</span>
              </div>
            )}
            {COMPACT ? null : !DETAIL && selected === WORKTREE && status ? (
              <ChangesView repo={repo} status={status} onError={toastError} />
            ) : (
              <Details repo={repo} commit={commit} rules={issueRules} />
            )}
          </main>
          <PrReviewHost repo={repo} onSelectCommit={reveal} />
        </div>
      ) : (
        (
          <div className="empty">
            <p>{t("app.emptyTitle")}</p>
            <div className="empty-actions">
              <button className="primary" onClick={() => open()}>{t("app.openRepo")}</button>
              <button onClick={ops.clone}>{t("app.clone")}</button>
              <button onClick={ops.init}>{t("app.init")}</button>
              <button onClick={ops.scan}>{t("app.scan")}</button>
            </div>
            {repos.length > 0 && (
              <ul className="empty-repos" aria-label={t("app.repoList")}>
                {repos.map((r) => (
                  <li key={r}>
                    <button onClick={() => loadAll(r)} title={r}>
                      <span>{r.split(/[\\/]/).pop()}</span>
                      <span className="hint">{r}</span>
                    </button>
                    <button className="forget" aria-label={t("app.forgetOne", { path: r })} title={t("app.forgetTip")} onClick={() => forget(r)}>×</button>
                  </li>
                ))}
              </ul>
            )}
            {repos.length > 0 && <button className="link" onClick={() => forget()}>{t("app.forgetAll")}</button>}
          </div>
        )
      )}
      {!COMPACT && !DETAIL && (view || job) && <StatusBar status={status} message={message} job={job} />}
      {palette && <QuickLaunch recent={repos} onOpen={open} onClose={() => setPalette(false)} />}
      <SettingsHost theme={theme.mode} onTheme={theme.setMode} />
      <PromptHost />
      <Toasts />
      <RebaseHost />
      <RewordHost />
      <HostingHost />
      <AiHost />
      <AutoFetch repo={repo} />
      <InspectorHost onSelectCommit={setSelected} />
      <DomMenuHost />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
