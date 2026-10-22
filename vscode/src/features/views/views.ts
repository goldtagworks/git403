// 사이드바 TreeView(22단계): Branches · Tags · Stashes · Remotes · File History · Line History.
// 새 서버 명령 없이 `load_refs`·`file_log`·`changed_files`·`git`·`repo-changed`만 재사용한다(감시는 Workspace). 순수 로직은 tree.ts.
// 저장소가 둘 이상이면(멀티루트·하위 .git) 참조 뷰 최상위에 저장소 노드를 두고, 하나면 평평하게 보인다.
import * as path from "node:path";
import * as vscode from "vscode";
import { relativeTime } from "../../services/blame.ts";
import type { Dirty } from "../../services/dirty.ts";
import { openFileDiff } from "./diff.ts";
import { sameRepo } from "../../services/repos.ts";
import { checkoutArgs, branchesTree, commitNode, lineLogArgs, lineRange, parseLineLog, parseRemotes, remotesTree, repoNode, stashArgs, stashesTree, tagsTree, type LogCommit, type Node, type Ref } from "./tree.ts";
import type { Workspace } from "../../services/workspace.ts";

type Request = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
const t = vscode.l10n.t;

const VIEWS = ["branches", "tags", "stashes", "remotes", "fileHistory", "lineHistory"] as const;
type ViewId = (typeof VIEWS)[number];

/** 평문 툴팁(첫 줄=제목, 나머지=내용)을 마크다운으로: 제목은 굵게, 줄바꿈 유지. 내용은 이스케이프된다 */
function tip(text: string): vscode.MarkdownString {
  const [head, ...rest] = text.split("\n");
  const md = new vscode.MarkdownString().appendMarkdown("**").appendText(head).appendMarkdown("**");
  for (const l of rest) md.appendMarkdown("  \n").appendText(l);
  return md;
}

/** 노드 목록을 loader로 만드는 TreeDataProvider. 자식은 노드에 들어 있다 */
class NodeProvider implements vscode.TreeDataProvider<Node> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  view!: vscode.TreeView<Node>;
  private load: () => Promise<Node[]>;
  /** 항목이 하나도 없을 때 뷰 위에 보일 안내(히스토리 뷰는 스스로 메시지를 정하므로 없다) */
  private empty?: () => string | undefined;
  constructor(load: () => Promise<Node[]>, empty?: () => string | undefined) {
    this.load = load;
    this.empty = empty;
  }
  refresh() {
    this.emitter.fire();
  }
  async getChildren(n?: Node): Promise<Node[]> {
    if (n) return n.children ?? [];
    try {
      const nodes = await this.load();
      if (this.view && this.empty) this.view.message = nodes.length ? undefined : this.empty();
      else if (this.view && !this.empty) this.view.message = undefined;
      return nodes;
    } catch (e) {
      if (this.view) this.view.message = e instanceof Error ? e.message : String(e);
      return [];
    }
  }
  getTreeItem(n: Node): vscode.TreeItem {
    const it = new vscode.TreeItem(n.label, n.open === "none" ? vscode.TreeItemCollapsibleState.None : n.open === "expanded" ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    it.id = n.id;
    it.description = n.description;
    it.tooltip = n.tooltip ? tip(n.tooltip) : undefined;
    it.iconPath = new vscode.ThemeIcon(n.icon, n.color ? new vscode.ThemeColor(n.color) : undefined);
    it.contextValue = n.context;
    // 브랜치를 누르면 그래프에서 그 브랜치 끝 커밋을 고른다
    if ((n.kind === "branch" || n.kind === "remoteBranch") && n.sha) it.command = { command: "git403.openGraph", title: t("Open in graph"), arguments: [{ sha: n.sha, repo: n.repo }] };
    if (n.kind === "commit") it.command = { command: "git403.openCommitDiff", title: t("Compare with Previous Version"), arguments: [n] };
    return it;
  }
}

/** 테스트 훅 `git403.debugTree`가 돌려주는 모양 */
export type DebugNode = { label: string; description?: string; path?: string; context: string; icon: string; children?: DebugNode[]; command?: vscode.Command };

interface Target {
  repo: string;
  rel: string;
  /** 디스크 기준 줄 범위(1부터). 저장 안 된 편집은 트래커로 옮긴 값 */
  range?: { start: number; end: number };
  /** 선택한 줄이 전부 아직 커밋 안 된(새로 쓴) 줄 */
  uncommitted?: boolean;
}

export class Views implements vscode.Disposable {
  private subs: vscode.Disposable[] = [];
  private providers = {} as Record<ViewId, NodeProvider>;
  private refsP = new Map<string, Promise<Ref[]>>();
  private urlsP = new Map<string, Promise<Map<string, string>>>();
  private file: Target | null = null;
  private line: Target | null = null;
  private logs = new Map<string, Promise<LogCommit[]>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private req: Request;
  private ws: Workspace;
  private dirty: Dirty;
  /** 테스트 훅: 저장소별 `load_refs` 호출 수 */
  readonly loads: Record<string, number> = {};
  /** 테스트 모드에서만 넣는 확인 대체(스태시 확인 모달을 건너뛴다). null이면 모달 */
  testConfirm: boolean | null = null;

  constructor(req: Request, ws: Workspace, dirty: Dirty) {
    this.req = req;
    this.ws = ws;
    this.dirty = dirty;
    const refsView = (build: (r: Ref[], urls: Map<string, string>) => Node[], empty: string, urls = false) => new NodeProvider(() => this.refsNodes(build, urls), () => (this.ws.repos.length ? empty : undefined)); // 저장소가 없으면 viewsWelcome이 안내한다
    this.providers.branches = refsView((r) => branchesTree(r, { local: t("Local"), current: t("current") }), t("No branches."));
    this.providers.tags = refsView(tagsTree, t("No tags."));
    this.providers.stashes = refsView(stashesTree, t("No stashes."));
    this.providers.remotes = refsView(remotesTree, t("No remotes."), true);
    this.providers.fileHistory = new NodeProvider(() => this.history(this.file, "f"));
    this.providers.lineHistory = new NodeProvider(() => this.history(this.line, "l"));
    const w = vscode.window;
    for (const id of VIEWS) {
      const p = this.providers[id];
      p.view = w.createTreeView(`git403.${id}`, { treeDataProvider: p, showCollapseAll: id === "branches" || id === "remotes" });
      this.subs.push(p.view);
    }
    this.providers.fileHistory.view.message = t("Open a file to see its history.");
    this.providers.lineHistory.view.message = t("Select lines to see their history.");
    const cmd = vscode.commands.registerCommand;
    this.subs.push(
      w.onDidChangeActiveTextEditor(() => this.schedule()),
      w.onDidChangeTextEditorSelection((e) => e.textEditor === w.activeTextEditor && this.schedule()),
      // 저장 안 된 편집으로 줄이 밀리면 Line History의 대상 범위도 다시 계산한다
      vscode.workspace.onDidChangeTextDocument((e) => e.document === w.activeTextEditor?.document && e.document.isDirty && this.schedule()),
      ws.onDidChange(() => this.refreshAll()),
      cmd("git403.refreshViews", () => this.ws.refresh().then(() => this.refreshAll())),
      cmd("git403.checkout", (n: Node) => this.checkout(n)),
      cmd("git403.copyRefName", (n: Node) => this.copy(n.name)),
      cmd("git403.copyRefSha", (n: Node) => this.copy(n.sha)),
      cmd("git403.stashApply", (n: Node) => this.stash("apply", n)),
      cmd("git403.stashPop", (n: Node) => this.stash("pop", n)),
      cmd("git403.stashDrop", (n: Node) => this.stash("drop", n)),
      cmd("git403.openCommitDiff", (n: Node) => this.openDiff(n)),
    );
    this.schedule(0);
  }

  private withRepo(nodes: Node[], repo: string | null): Node[] {
    const set = (n: Node): Node => ({ ...n, repo: repo ?? undefined, children: n.children?.map(set) });
    return nodes.map(set);
  }

  private refs(repo: string): Promise<Ref[]> {
    let p = this.refsP.get(repo);
    if (!p) {
      this.loads[repo] = (this.loads[repo] ?? 0) + 1;
      this.refsP.set(repo, (p = this.req("load_refs", { repo }).then((r) => r as Ref[])));
      p.catch(() => this.refsP.delete(repo));
    }
    return p;
  }

  /** 원격 이름 → URL (`git remote -v`). 실패해도 뷰는 URL 없이 보인다 */
  private urls(repo: string): Promise<Map<string, string>> {
    let p = this.urlsP.get(repo);
    if (!p) this.urlsP.set(repo, (p = this.req("git", { repo, args: ["remote", "-v"] }).then((o) => parseRemotes(String(o)), () => new Map<string, string>())));
    return p;
  }

  /** 참조 뷰의 최상위 노드: 저장소 하나면 평평하게, 둘 이상이면 저장소 노드 아래에 */
  private async refsNodes(build: (r: Ref[], urls: Map<string, string>) => Node[], withUrls: boolean): Promise<Node[]> {
    const repos = this.ws.repos;
    const one = async (repo: string) => this.withRepo(build(await this.refs(repo), withUrls ? await this.urls(repo) : new Map()), repo);
    if (repos.length <= 1) return repos.length ? one(repos[0]) : [];
    return Promise.all(
      repos.map(async (repo) => {
        const parent = path.basename(path.dirname(repo));
        try {
          return repoNode(repo, path.basename(repo), await one(repo), parent);
        } catch (e) {
          return { ...repoNode(repo, path.basename(repo), [], parent), tooltip: e instanceof Error ? e.message : String(e), open: "none" as const };
        }
      }),
    );
  }

  /** 서버 이벤트: refs가 바뀌면 그 저장소의 참조 뷰(와 대상이 그 저장소인 히스토리 뷰)만 다시 읽는다. 작업 트리만 바뀐 경우는 해당 없음 */
  onServerEvent(event: string, payload: unknown) {
    const p = payload as { refs?: boolean; repo?: unknown } | null;
    if (event !== "repo-changed" || !p?.refs) return;
    if (typeof p.repo !== "string") return this.refreshAll();
    const repo = this.ws.repos.find((r) => sameRepo(r, p.repo as string));
    if (repo) this.refreshRepo(repo);
  }

  /** 한 저장소만: 그 저장소의 캐시를 버리고 뷰를 다시 그린다(다른 저장소는 캐시에서) */
  refreshRepo(repo: string) {
    this.refsP.delete(repo);
    this.urlsP.delete(repo);
    for (const k of [...this.logs.keys()]) if (k.split("\0")[1] === repo) this.logs.delete(k);
    for (const id of ["branches", "tags", "stashes", "remotes"] as const) this.providers[id].refresh();
    if (this.file?.repo === repo) this.providers.fileHistory.refresh();
    if (this.line?.repo === repo) this.providers.lineHistory.refresh();
  }

  refreshAll() {
    this.refsP.clear();
    this.urlsP.clear();
    this.logs.clear();
    for (const id of VIEWS) this.providers[id].refresh();
  }

  // ---- 히스토리 ----

  private target(): { file: Target | null; line: Target | null } | null {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== "file") return null;
    const r = this.ws.repoOf(ed.document.uri);
    if (!r) return null;
    const sel = lineRange(ed.selection);
    // 저장 안 된 편집: 선택한 줄을 트래커로 디스크 기준 줄로 옮긴다(새로 쓴 줄만이면 안내)
    if (!ed.document.isDirty) return { file: r, line: { ...r, range: sel } };
    const d = this.dirty.tracker(ed.document).diskRange(sel.start - 1, sel.end - 1);
    return { file: r, line: d ? { ...r, range: { start: d.start + 1, end: d.end + 1 } } : { ...r, uncommitted: true } };
  }

  /** 활성 편집기·선택 변경: 디바운스 후 대상이 바뀐 뷰만 다시 그린다 */
  private schedule(ms = 250) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const next = this.target();
      if (!next) return; // 파일이 아닌 편집기(diff 등)로 옮겨도 마지막 히스토리를 유지
      const key = (x: Target | null) => x && `${x.repo}\0${x.rel}\0${x.range?.start ?? ""}-${x.range?.end ?? ""}${x.uncommitted ? "u" : ""}`;
      if (key(next.file) !== key(this.file)) {
        this.file = next.file;
        this.providers.fileHistory.refresh();
      }
      if (key(next.line) !== key(this.line)) {
        this.line = next.line;
        this.providers.lineHistory.refresh();
      }
    }, ms);
  }

  private async history(tg: Target | null, prefix: "f" | "l"): Promise<Node[]> {
    if (!tg) return [];
    if (tg.uncommitted) {
      const v = this.providers.lineHistory.view;
      v.title = t("Line History");
      v.description = path.basename(tg.rel);
      v.message = t("The selected lines are not committed yet.");
      return [];
    }
    const k = `${prefix}\0${tg.repo}\0${tg.rel}\0${tg.range?.start}-${tg.range?.end}`;
    let p = this.logs.get(k);
    if (!p) {
      p = (prefix === "f"
        ? this.req("file_log", { repo: tg.repo, path: tg.rel })
        : this.req("git", { repo: tg.repo, args: lineLogArgs(tg.rel, tg.range!.start, tg.range!.end) }).then((o) => parseLineLog(String(o)))) as Promise<LogCommit[]>;
      this.logs.set(k, p);
      p.catch(() => this.logs.delete(k));
    }
    const commits = await p;
    const loc = vscode.env.language, now = Date.now() / 1000;
    const view = this.providers[prefix === "f" ? "fileHistory" : "lineHistory"].view;
    // 뷰 제목은 VS Code가 대문자로 바꿔 보이므로(파일명이 B.TXT가 된다) 파일명·범위는 description(원문 그대로)에 둔다
    view.title = prefix === "f" ? t("File History") : t("Line History");
    view.description = prefix === "f" ? path.basename(tg.rel) : `${path.basename(tg.rel)}:${tg.range!.start}-${tg.range!.end}`;
    view.message = commits.length ? undefined : t("No history.");
    return this.withRepo(commits.map((c) => commitNode(c, tg.rel, (ts) => relativeTime(now, ts, loc), prefix)), tg.repo);
  }

  // ---- 비교 ----

  private openDiff(n: Node) {
    if (n.repo && n.sha && n.path) return openFileDiff(this.req, n.repo, n.path, n.sha);
  }

  // ---- 쓰기 작업 ----

  /** 클립보드 복사 + 상태 바 피드백(내장 Git처럼 알림 팝업은 띄우지 않는다) */
  private async copy(text: string | undefined) {
    if (!text) return;
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage(t("Copied: {0}", text), 2500);
  }

  /** git 작업 하나: 진행은 상태 바(Window) 진행 표시, 실패는 오류 알림, 성공은 조용히(뷰가 바뀐다) */
  private async run(repo: string | undefined, args: string[] | null, title?: string) {
    if (!repo || !args) return;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: title ?? `git403: git ${args[0]}` }, () => this.req("git", { repo, args }));
    } catch (e) {
      void vscode.window.showErrorMessage(t("git403: git {0} failed: {1}", args[0], e instanceof Error ? e.message : String(e)));
    }
    this.refreshRepo(repo); // 파일 감시 이벤트보다 먼저 화면을 맞춘다
  }

  private checkout(n: Node) {
    if (n.kind === "branch" || n.kind === "remoteBranch") return this.run(n.repo, n.name ? checkoutArgs(n.kind, n.name) : null, t("git403: Checking out {0}…", n.name ?? ""));
  }

  private async stash(op: "apply" | "pop" | "drop", n: Node) {
    const args = n.name ? stashArgs(op, n.name) : null;
    if (!args) return;
    const ok = { apply: t("Apply"), pop: t("Pop"), drop: t("Drop") }[op];
    const msg = { apply: t("Apply {0}?", n.name!), pop: t("Pop {0}? It is removed from the stash list.", n.name!), drop: t("Drop {0}? This cannot be undone.", n.name!) }[op];
    const yes = this.testConfirm ?? (await vscode.window.showWarningMessage(msg, { modal: true, detail: n.label }, ok)) === ok;
    if (!yes) return;
    await this.run(n.repo, args, t("git403: Stash {0}…", op));
  }

  /** 테스트 훅 */
  async debugTree(id: ViewId): Promise<DebugNode[]> {
    const p = this.providers[id];
    const plain = (n: Node): DebugNode => ({ label: n.label, description: n.description, path: n.path, context: n.context, icon: n.icon, children: n.children?.map(plain), command: p.getTreeItem(n).command });
    return (await p.getChildren()).map(plain);
  }

  /** 테스트 훅: 라벨로 찾은 실제 Node */
  async debugNode(id: ViewId, label: string): Promise<Node | undefined> {
    const find = (ns: Node[]): Node | undefined => ns.flatMap((n) => [n, ...(n.children ? [find(n.children)] : [])]).find((n) => n?.label === label);
    return find(await this.providers[id].getChildren());
  }

  dispose() {
    clearTimeout(this.timer);
    for (const d of this.subs) d.dispose();
  }
}
