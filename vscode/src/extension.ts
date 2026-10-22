import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { webviewHtml } from "./shared/html.ts";
import { serverPath, uiDir } from "./shared/paths.ts";
import { Dirty } from "./services/dirty.ts";
import { EditorBlame, blameState } from "./features/editor/editor.ts";
import { EventDedupe, sameRepo } from "./services/repos.ts";
import { Workspace } from "./services/workspace.ts";
import { Views } from "./features/views/views.ts";
import { openFileDiff, registerContent } from "./features/views/diff.ts";
import { safeRel } from "./features/views/tree.ts";
import { PanelWork } from "./shared/jobs.ts";
import { Relay } from "./services/relay.ts";

type FromWebview =
  | { type: "invoke"; id: number; cmd: string; args?: Record<string, unknown> }
  | { type: "dialog"; id: number; kind: "open" | "save" | "ask"; message?: string; options?: any }
  | { type: "openUrl"; id: number; url: string }
  // 답이 없는 알림
  | { type: "ready"; id?: undefined }
  | { type: "selected"; id?: undefined; sha: string }
  | { type: "openFile"; id?: undefined; repo: string; path: string; sha?: string; line?: number }
  // compact 뷰: 커밋 클릭(편집기 영역의 커밋 상세 탭, sha가 WORKTREE면 소스 제어 뷰), 전체 화면(편집기 탭에 전체 앱)
  | { type: "commitClick"; id?: undefined; repo: string; sha: string }
  | { type: "openFull"; id?: undefined; sha?: string }
  // 테스트 훅 `git403.debugSimulate`의 답
  | { type: "simulated"; id?: undefined; found: boolean };

/** 테스트 훅(`git403.debugState`): 서버가 마지막으로 돌려준 응답 요약 */
const state: { initialRepo: string | null; responses: Record<string, { ok: boolean; commits?: number; err?: string }>; events: Record<string, number>; eventRepos: Record<string, number>; server?: boolean; selected: string | null; graphRepo: string | null; openRepos: number } = { initialRepo: null, responses: {}, events: {}, eventRepos: {}, selected: null, graphRepo: null, openRepos: 0 };

let relay: Relay | null = null;
/**
 * 그래프를 띄운 곳: 활동 바 뷰(sidebar)·아래 패널 뷰(panel)는 좁은 커밋 목록(compact), 편집기 탭(editor)은 전체 앱,
 * detail은 compact에서 커밋을 클릭하면 편집기 영역에 열리는 "커밋 상세" 탭(상세 + diff만, 하나를 재사용).
 * 종류마다 하나씩, 동시에 여럿 있을 수 있다(compact에서 "전체 화면으로 열기"를 누르면 편집기 탭이 더해진다).
 * 준비(ready) 전에 요청된 선택(`git403.openGraph(sha)`)·저장소 전환은 웹뷰별로 쌓았다가 ready 때 보낸다.
 */
type Kind = "sidebar" | "panel" | "editor" | "detail";
interface Graph { kind: Kind; webview: vscode.Webview; reveal(): void; title?(s: string): void; visible(): boolean; ready: boolean; select: string | null; repo: string | null }
const graphs = new Set<Graph>();
/** 선택·저장소 요청이 처음 만들어질 웹뷰에 전달되도록 잠시 두는 값 */
let wantSelect: string | null = null;
const primary = () => [...graphs].find((g) => g.kind === "editor") ?? [...graphs].find((g) => g.kind !== "detail") ?? [...graphs][0];
/** 선택·저장소 전환을 따라가는 그래프들(상세 탭은 commitClick만 따른다) */
const followers = () => [...graphs].filter((g) => g.kind !== "detail");
let content: vscode.Disposable | null = null;
let log: vscode.OutputChannel;
let editor: EditorBlame | null = null;
let views: Views | null = null;
let ws: Workspace | null = null;
let dirty: Dirty | null = null;
/** 열린 패널이 시작한 저장소, 다음에 열 패널이 시작할 저장소(그래프에서 보기 요청) */
let panelRepo: string | null = null;
let wantRepo: string | null = null;
/** 서버가 죽었다 다시 뜬 뒤 감시를 다시 걸어야 한다 */
let relaunched = false;
const dedupe = new EventDedupe();
let simulating: ((found: boolean) => void) | null = null;
const work = new PanelWork();

const workspaceRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;

/** 서버 요청(편집기·뷰·패널 공용). 서버가 죽었다 다시 뜨면 저장소 감시를 다시 건다 */
function request(ctx: vscode.ExtensionContext, cmd: string, args?: Record<string, unknown>) {
  const p = ensureRelay(ctx).request(cmd, args);
  if (relaunched && ws) (relaunched = false), void ws.resync();
  return p;
}

const isDev = (ctx: vscode.ExtensionContext) => ctx.extensionMode !== vscode.ExtensionMode.Production;

function ensureRelay(ctx: vscode.ExtensionContext): Relay {
  if (relay) return relay;
  // 사용자(전역) 설정만 읽는다: 작업 영역의 settings.json이 실행 파일을 지정하지 못하게
  const configured = vscode.workspace.getConfiguration("git403").inspect<string>("serverPath")?.globalValue ?? "";
  const bin = serverPath(ctx.extensionPath, configured, isDev(ctx));
  if (!bin) throw new Error(vscode.l10n.t("git403: Could not find git403-server. Set the git403.serverPath user setting or reinstall the extension."));
  log.appendLine(`server: ${bin}`);
  relay = new Relay({
    command: bin,
    cwd: workspaceRoot() ?? os.homedir(),
    onLog: (l) => log.appendLine(l),
    onExit: () => (relaunched = true),
    onEvent: ({ event, payload }) => {
      state.events[event] = (state.events[event] ?? 0) + 1;
      work.event(event, payload, graphs.size > 0);
      // repo-changed {worktree, refs, repo}: 같은 변경을 두 감시(웹뷰의 watch_repo·확장의 watch_add)가 알리면 하나로 합쳐 해당 저장소만 갱신한다
      const rc = event === "repo-changed" ? (payload as { worktree?: boolean; refs?: boolean; repo?: string } | null) : null;
      if (rc?.repo) state.eventRepos[rc.repo] = (state.eventRepos[rc.repo] ?? 0) + 1;
      const fresh = !rc || !rc.repo || dedupe.fresh(rc.repo, !!rc.worktree, !!rc.refs);
      if (fresh) {
        editor?.onServerEvent(event, payload);
        views?.onServerEvent(event, payload);
      }
      // 보이는 웹뷰가 있으면 그쪽이 askpass를 받고(중복 repo-changed는 웹뷰마다 한 번만), 없으면 입력 상자로 대신 받는다
      if (event === "askpass") {
        const g = [...graphs].find((x) => x.visible());
        if (g) void g.webview.postMessage({ type: "event", event, payload });
        else void askpass(payload as { id: number; prompt: string });
      } else if (fresh) for (const g of graphs) void g.webview.postMessage({ type: "event", event, payload });
    },
  });
  return relay;
}

async function askpass(p: { id: number; prompt: string }) {
  const answer = await vscode.window.showInputBox({ prompt: p.prompt, password: true, ignoreFocusOut: true });
  await relay?.request("askpass_reply", { id: p.id, answer: answer ?? null }).catch(() => {});
}

/** 서버는 확장 수명이다(편집기 기능이 패널 없이도 쓴다). 비활성화 때만 stdin을 닫아 진행 중인 git 작업·감시를 끝낸다(안 끝나면 kill) */
async function stopServer() {
  const r = relay;
  relay = null;
  state.responses = {};
  await r?.dispose();
}

function filters(list?: { name: string; extensions: string[] }[]) {
  const out: Record<string, string[]> = {};
  for (const f of list ?? []) if (!f.extensions.includes("*")) out[f.name] = f.extensions;
  return Object.keys(out).length ? out : undefined;
}

async function handle(ctx: vscode.ExtensionContext, m: Exclude<FromWebview, { type: "ready" | "selected" | "openFile" }>): Promise<unknown> {
  switch (m.type) {
    case "invoke": {
      // 시작 저장소(서버는 항상 null): 그래프에서 보기로 요청된 저장소 → 활성 편집기 파일의 저장소 → 마지막/첫 저장소 → 첫 폴더
      if (m.cmd === "initial_repo") {
        panelRepo = state.initialRepo = wantRepo ?? ws?.activeRepo() ?? workspaceRoot();
        wantRepo = null;
        return panelRepo;
      }
      const r = await request(ctx, m.cmd, m.args);
      work.track(m.cmd, m.args, r);
      const rec = (state.responses[m.cmd] = { ok: true } as { ok: boolean; commits?: number; err?: string });
      if (m.cmd === "load_graph") {
        rec.commits = (r as { commits?: unknown[] }).commits?.length ?? 0;
        state.graphRepo = typeof m.args?.repo === "string" ? m.args.repo : null;
        if (state.graphRepo) panelRepo = state.graphRepo; // 사용자가 UI 탭을 바꿔도 지금 보는 저장소를 안다
      }
      return r;
    }
    case "dialog": {
      const o = m.options ?? {};
      if (m.kind === "open") {
        const r = await vscode.window.showOpenDialog({ canSelectFolders: !!o.directory, canSelectFiles: !o.directory, canSelectMany: false, title: o.title, filters: filters(o.filters) });
        return r?.[0]?.fsPath ?? null;
      }
      if (m.kind === "save") {
        const r = await vscode.window.showSaveDialog({ title: o.title, defaultUri: o.defaultPath ? vscode.Uri.file(o.defaultPath) : undefined, filters: filters(o.filters) });
        return r?.fsPath ?? null;
      }
      const ok = o.okLabel ?? vscode.l10n.t("OK");
      const fn = o.kind === "info" ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
      const r = await fn(o.title ?? String(m.message), { modal: true, detail: o.title ? m.message : undefined }, ok);
      return r === ok;
    }
    case "openUrl": {
      const u = vscode.Uri.parse(m.url, true);
      if (!/^(https?|mailto)$/.test(u.scheme)) throw new Error(vscode.l10n.t("Blocked URL scheme: {0}", u.scheme));
      await vscode.env.openExternal(u);
      return null;
    }
  }
}

/** 그래프에서 커밋을 고르게 한다. 웹뷰가 준비되기 전이면 준비 때(ready) 보낸다 */
function selectInGraph(sha: string | undefined) {
  if (!sha) return;
  for (const g of followers()) g.ready ? void g.webview.postMessage({ type: "select", sha }) : (g.select = sha);
}

/** 열린 패널의 저장소를 바꾼다: 패널을 다시 만들지 않고 웹뷰의 저장소 열기(탭) 경로로 전환(`openRepo`). 준비 전이면 ready 때 보낸다 */
function openRepoInPanel(repo: string) {
  panelRepo = repo;
  state.openRepos++;
  for (const g of followers()) g.ready ? void g.webview.postMessage({ type: "openRepo", repo }) : (g.repo = repo);
}

/** `git403.openGraph`의 인자: SHA 문자열, 또는 `sha`·`repo` 필드가 있는 객체(트리 노드·호버·브랜치 클릭), 팔레트는 없음 */
const shaArg = (a: unknown) => (typeof a === "string" ? a : typeof (a as { sha?: unknown } | undefined)?.sha === "string" ? (a as { sha: string }).sha : undefined);
const repoArg = (a: unknown) => (typeof (a as { repo?: unknown } | undefined)?.repo === "string" ? (a as { repo: string }).repo : undefined);

/** 웹뷰의 알림 메시지(답 없음). 처리했으면 true */
function notification(ctx: vscode.ExtensionContext, m: FromWebview, g: Graph): boolean {
  if (m.type === "ready") {
    g.ready = true;
    const [repo, sha] = [g.repo, g.select];
    g.repo = g.select = null;
    if (repo) void g.webview.postMessage({ type: "openRepo", repo });
    if (sha) void g.webview.postMessage({ type: "select", sha });
  } else if (m.type === "commitClick") commitClick(ctx, m);
  else if (m.type === "openFull") openGraph(ctx, undefined, { kind: "editor", sha: typeof m.sha === "string" ? m.sha : undefined, repo: panelRepo ?? undefined });
  else if (m.type === "selected") state.selected = String(m.sha);
  else if (m.type === "openFile") void openFile(ctx, m);
  else if (m.type === "simulated") simulating?.(m.found);
  else return false;
  return true;
}

/** 작업 영역 저장소 목록(`ws.repos`)에 있는 저장소인가 (경로 정규화 비교). 웹뷰·명령 인자로 받은 임의 경로를 거른다 */
const knownRepo = (repo: unknown): repo is string => typeof repo === "string" && !!ws?.repos.some((r) => sameRepo(r, repo));

async function openFile(ctx: vscode.ExtensionContext, a: { repo?: unknown; path?: unknown; sha?: unknown; line?: unknown }) {
  const rel = safeRel(a.path);
  if (!vscode.workspace.isTrusted || !knownRepo(a.repo) || !rel || (a.sha !== undefined && (typeof a.sha !== "string" || !/^[0-9a-fA-F]{4,64}$/.test(a.sha)))) return;
  await openFileDiff((cmd, args) => request(ctx, cmd, args), a.repo, rel, a.sha as string | undefined, typeof a.line === "number" ? a.line : undefined);
}

/** 커밋 상세 탭이 보고 있는 저장소 */
let detailRepo: string | null = null;
/** compact 뷰 커밋 클릭: 편집기 영역의 "커밋 상세" 탭에 그 커밋을 보인다(탭은 하나, 열려 있으면 내용만 바꾸고 포커스는 뺏지 않는다). 로컬 변경사항은 소스 제어 뷰 */
function commitClick(ctx: vscode.ExtensionContext, a: { repo?: unknown; sha?: unknown }) {
  if (!vscode.workspace.isTrusted) return;
  if (a.sha === "WORKTREE") return void vscode.commands.executeCommand("workbench.view.scm");
  if (!knownRepo(a.repo) || typeof a.sha !== "string" || !/^[0-9a-fA-F]{4,64}$/.test(a.sha)) return;
  const { repo, sha } = { repo: a.repo, sha: a.sha };
  const open = [...graphs].find((g) => g.kind === "detail");
  if (open) {
    open.reveal();
    open.title?.(sha.slice(0, 7));
    // 저장소가 바뀌면 UI의 저장소 열기 경로로 전환한 뒤 select (준비 전이면 ready 때 같은 순서로)
    if (repo !== detailRepo) {
      detailRepo = repo;
      open.ready ? void open.webview.postMessage({ type: "openRepo", repo }) : (open.repo = repo);
    }
    open.ready ? void open.webview.postMessage({ type: "select", sha }) : (open.select = sha);
    return;
  }
  const dir = uiDir(ctx.extensionPath, isDev(ctx));
  if (!dir) return void vscode.window.showErrorMessage(vscode.l10n.t("git403: Could not find the UI build (ui/dist)."));
  detailRepo = repo;
  wantRepo = repo;
  wantSelect = sha;
  const p = vscode.window.createWebviewPanel("git403.detail", sha.slice(0, 7), { viewColumn: vscode.ViewColumn.Active }, { retainContextWhenHidden: true });
  p.iconPath = vscode.Uri.file(path.join(ctx.extensionPath, "media", "icon.png"));
  const g = attachGraph(ctx, p.webview, dir, "detail", () => p.reveal(undefined, true), () => p.visible);
  g.title = (s) => void (p.title = s);
  p.onDidDispose(() => (detachGraph(g), (detailRepo = null)));
}

const graphLocation = (): Kind => {
  const v = vscode.workspace.getConfiguration("git403").get<string>("graph.location");
  return v === "panel" || v === "editor" ? v : "sidebar";
};
const FOCUS: Record<"sidebar" | "panel", string> = { sidebar: "git403.graphSidebar.focus", panel: "git403.graphView.focus" };

/** 인자: `kind`(없으면 설정 위치), `sha`·`repo`(인자 객체보다 우선, 작업 영역 저장소 검사 없음 — 확장 안 호출용) */
function openGraph(ctx: vscode.ExtensionContext, arg?: unknown, opts?: { kind?: Kind; sha?: string; repo?: string }) {
  // 신뢰하지 않는 작업 영역에서는 서버(실행 파일)를 띄우지 않고, 선택·저장소 요청도 쌓아 두지 않는다
  if (!vscode.workspace.isTrusted) return void vscode.window.showWarningMessage(vscode.l10n.t("git403 does not run in untrusted workspaces. Trust this workspace to open the commit graph."));
  const sha = opts?.sha ?? shaArg(arg), repo = opts?.repo ?? repoArg(arg);
  if (!opts?.repo && repo !== undefined && !knownRepo(repo)) return; // 작업 영역 저장소가 아니면 거부
  const kind = opts?.kind ?? graphLocation();
  const open = [...graphs].find((g) => g.kind === kind);
  // 열린 그래프가 다른 저장소를 보고 있으면 그래프는 그대로 두고 그 저장소로 전환시킨다(UI 상태 유지)
  if (graphs.size && repo && panelRepo && !sameRepo(repo, panelRepo)) openRepoInPanel(repo);
  // 이미 열려 있어도 sidebar·panel은 focus 명령으로 컨테이너를 확실히 연다(다른 활동 바 항목·닫힌 사이드바에서도 보이게)
  if (open) return (selectInGraph(sha), kind === "editor" ? open.reveal() : void vscode.commands.executeCommand(FOCUS[kind as "sidebar" | "panel"]));
  const dir = uiDir(ctx.extensionPath, isDev(ctx));
  if (!dir) return void vscode.window.showErrorMessage(vscode.l10n.t("git403: Could not find the UI build (ui/dist)."));
  wantSelect = sha ?? null;
  // 그래프가 열리면 활성 편집기가 웹뷰로 바뀌므로, 지금(명령 시점) 활성 파일의 저장소를 잡아 둔다
  wantRepo = repo ?? ws?.activeRepo() ?? null;
  // 활동 바·아래 패널 뷰는 보이면 resolveGraphView가 붙인다
  if (kind !== "editor") return void vscode.commands.executeCommand(FOCUS[kind as "sidebar" | "panel"]);
  const p = vscode.window.createWebviewPanel("git403.graph", "git403", vscode.ViewColumn.Active, { retainContextWhenHidden: true });
  p.iconPath = vscode.Uri.file(path.join(ctx.extensionPath, "media", "icon.png"));
  const g = attachGraph(ctx, p.webview, dir, "editor", () => p.reveal(), () => p.visible);
  p.onDidDispose(() => detachGraph(g));
}

/** 활동 바·아래 패널 뷰가 처음 보일 때(사용자가 열었거나 openGraph가 focus했을 때) compact 그래프를 붙인다 */
function resolveGraphView(ctx: vscode.ExtensionContext, view: vscode.WebviewView, kind: "sidebar" | "panel") {
  const dir = uiDir(ctx.extensionPath, isDev(ctx));
  if (!vscode.workspace.isTrusted || !dir) {
    view.webview.html = `<p style="padding:8px">${vscode.l10n.t("git403 does not run in untrusted workspaces. Trust this workspace to open the commit graph.")}</p>`;
    return;
  }
  wantRepo ??= ws?.activeRepo() ?? null;
  const g = attachGraph(ctx, view.webview, dir, kind, () => view.show(true), () => view.visible);
  view.onDidDispose(() => detachGraph(g));
}

/** 웹뷰(편집기 탭·뷰 공용)에 UI를 싣고 메시지를 연결한다. editor가 아니면 compact 모드 */
function attachGraph(ctx: vscode.ExtensionContext, w: vscode.Webview, dir: string, kind: Kind, reveal: () => void, visible: () => boolean): Graph {
  const g: Graph = { kind, webview: w, reveal, visible, ready: false, select: wantSelect, repo: null };
  wantSelect = null;
  graphs.add(g);
  w.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(dir)] };
  w.html = webviewHtml(fs.readFileSync(path.join(dir, "index.html"), "utf8"), {
    toUri: (rel) => w.asWebviewUri(vscode.Uri.file(path.join(dir, rel))).toString(),
    cspSource: w.cspSource,
    nonce: randomBytes(16).toString("base64"),
    compact: kind === "sidebar" || kind === "panel",
    detail: kind === "detail",
    lang: vscode.env.language,
    version: ctx.extension.packageJSON.version,
  });
  w.onDidReceiveMessage(async (m: FromWebview) => {
    if (notification(ctx, m, g)) return;
    try {
      const ok = await handle(ctx, m as Parameters<typeof handle>[1]);
      void w.postMessage({ type: "result", id: m.id, ok: ok ?? null });
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      if (m.type === "invoke") state.responses[m.cmd] = { ok: false, err };
      void w.postMessage({ type: "result", id: m.id, err });
    }
  });
  return g;
}

function detachGraph(g: Graph) {
  graphs.delete(g);
  state.selected = null;
  if (graphs.size) return; // 다른 그래프가 남아 있으면 공용 상태·작업은 그대로
  panelRepo = null;
  wantSelect = null;
  state.graphRepo = null;
  state.responses = {};
  // 서버는 계속 살지만 그래프가 시작한 작업은 정리한다
  if (relay) void work.cleanup((cmd, args) => relay!.request(cmd, args));
}

/**
 * 편집기 기능(줄 끝 blame·호버·상태 바·CodeLens)과 사이드바 뷰: 신뢰된 작업 영역에서만.
 * 저장소는 작업 영역의 모든 폴더(멀티루트·하위 `.git`)에서 찾아 저장소별로 감시한다. 뷰는 저장소가 하나라도 있을 때만(컨텍스트 키 `git403.active`가 when 절로 켠다).
 */
async function start(ctx: vscode.ExtensionContext) {
  const setActive = (on: boolean) => void vscode.commands.executeCommand("setContext", "git403.active", on);
  if (!vscode.workspace.isTrusted || !workspaceRoot()) return setActive(false);
  const req = (cmd: string, args?: Record<string, unknown>) => request(ctx, cmd, args);
  if (!ws) {
    ws = new Workspace(req);
    dirty = new Dirty();
    // 저장소가 처음 생기면(열린 뒤 만든 하위 저장소 등) 뷰를 만든다
    ws.onDidChange(() => (setActive(ws!.repos.length > 0), !views && ws!.repos.length > 0 && (views = new Views(req, ws!, dirty!))));
  }
  if (!editor) {
    content = registerContent(req);
    editor = new EditorBlame(req, ws, dirty!);
  }
  await ws.refresh().catch((e) => log.appendLine(`repos: ${e}`));
  setActive(ws.repos.length > 0);
  if (!views && ws.repos.length > 0) views = new Views(req, ws, dirty!);
}

export function activate(ctx: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel("git403");
  // 상태 바 버튼: 위치 설정과 상관없이 편집기 탭에 전체 git403을 연다(사이드바·패널은 활동 바·⌥⌘G로)
  const graphButton = vscode.window.createStatusBarItem("git403.openGraph", vscode.StatusBarAlignment.Left, 1);
  graphButton.text = "$(git-branch) git403";
  graphButton.tooltip = vscode.l10n.t("Open Commit Graph");
  graphButton.command = "git403.openGraphEditor";
  graphButton.show();
  ctx.subscriptions.push(
    log,
    graphButton,
    vscode.window.registerWebviewViewProvider("git403.graphSidebar", { resolveWebviewView: (v) => resolveGraphView(ctx, v, "sidebar") }, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider("git403.graphView", { resolveWebviewView: (v) => resolveGraphView(ctx, v, "panel") }, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("git403.openGraph", (arg?: unknown) => openGraph(ctx, arg)),
    vscode.commands.registerCommand("git403.openGraphEditor", () => openGraph(ctx, undefined, { kind: "editor" })),
    vscode.commands.registerCommand("git403.openFile", (a: { repo?: unknown; path?: unknown; sha?: unknown; line?: unknown }) => openFile(ctx, a ?? {})),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void start(ctx)),
    // 폴더가 추가·제거되면 저장소를 다시 찾는다(Workspace가 디바운스해 처리: 빠진 폴더의 저장소는 watch_remove). 아직 시작 전(폴더가 없던 경우)이면 시작
    vscode.workspace.onDidChangeWorkspaceFolders(() => void (ws ? undefined : start(ctx))),
    {
      dispose: () => {
        for (const d of [editor, content, views, ws, dirty]) d?.dispose();
        editor = content = views = ws = dirty = null;
      },
    },
  );
  void start(ctx);
  // 테스트 훅은 테스트 모드에서만 등록한다
  if (ctx.extensionMode === vscode.ExtensionMode.Test)
    ctx.subscriptions.push(
      vscode.commands.registerCommand("git403.debugTree", (id: Parameters<Views["debugTree"]>[0]) => views?.debugTree(id)),
      vscode.commands.registerCommand("git403.debugNode", (id: Parameters<Views["debugNode"]>[0], label: string) => views?.debugNode(id, label)),
      vscode.commands.registerCommand("git403.debugState", () => ({ ...state, panel: [...graphs].some((g) => g.kind === "editor"), /* 편집기 탭 그래프 */ graphKinds: [...graphs].map((g) => g.kind).sort(), graphVisible: [...graphs].filter((g) => g.visible()).map((g) => g.kind).sort(), server: !!relay?.running, blame: blameState, pendingWork: work.pending, repos: ws?.repos ?? [], watched: ws?.watched ?? [], refLoads: views?.loads ?? {} })),
      // 스태시 확인 모달 대체: true면 승인, false면 취소, null이면 원래대로 모달
      vscode.commands.registerCommand("git403.debugConfirm", (v: boolean | null) => void (views && (views.testConfirm = v))),
      // 웹뷰 안 상호작용 검증: 웹뷰가 실제 DOM 이벤트(selector에 맞는 요소, 선택적으로 텍스트 포함)를 일으키게 한다.
      // 그러면 UI가 실제 경로로 확장에 메시지(openFile 등)를 보낸다. 요소를 찾았는지 돌려준다
      vscode.commands.registerCommand("git403.debugSimulate", (a: { selector: string; text?: string; events: string[]; after?: string; target?: Kind }) => {
        const w = (a.target ? [...graphs].find((g) => g.kind === a.target) : primary())?.webview;
        if (!w) return false;
        return new Promise<boolean>((done) => {
          const t = setTimeout(() => ((simulating = null), done(false)), 10_000);
          simulating = (found) => (clearTimeout(t), (simulating = null), done(found));
          void w.postMessage({ type: "simulate", selector: a.selector, text: a.text, events: a.events, after: a.after });
        });
      }),
    );
}

export const deactivate = stopServer;
