// 편집기 통합: 줄 끝 blame decoration · 호버 · 상태 바. 순수 로직은 blame.ts.
import * as vscode from "vscode";
import type { Dirty } from "../../services/dirty.ts";
import { lensParts, lensScopes, summarize, symbolScopes, type SymbolLike } from "./lens.ts";
import type { Workspace } from "../../services/workspace.ts";
import { BlameCache, COMMIT_FORMAT, PromiseLru, commandUri, currentLines, hoverMarkdown, inlineText, lineInfo, parseCommit, pickHunk, relativeTime, type BlameLine, type Commit, type LineInfo } from "../../services/blame.ts";

type Request = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** 테스트 훅(`git403.debugState`)에 노출되는 현재 표시 상태 */
export const blameState: { line: number | null; decoration: string | null; statusBar: string | null; inline: boolean } = { line: null, decoration: null, statusBar: null, inline: false };

const cfg = () => vscode.workspace.getConfiguration("git403");
const t = vscode.l10n.t;

export class EditorBlame implements vscode.Disposable {
  private subs: vscode.Disposable[] = [];
  private deco = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor("editorCodeLens.foreground"), margin: "0 0 0 3em", fontStyle: "italic" },
  });
  private bar = vscode.window.createStatusBarItem("git403.blame", vscode.StatusBarAlignment.Left, 0);
  private cache: BlameCache;
  private commits = new PromiseLru<Commit>();
  private diffs = new PromiseLru<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;
  private current: { commit: BlameLine } | null = null;

  private lensChanged = new vscode.EventEmitter<void>();
  private req: Request;
  private space: Workspace;
  private dirty: Dirty;

  constructor(req: Request, space: Workspace, dirty: Dirty) {
    this.req = req;
    this.space = space;
    this.dirty = dirty;
    this.bar.name = "git403 blame";
    this.bar.command = "git403.showBlameActions";
    // 저장소 감시는 Workspace(`watch_add`)가 한다
    this.cache = new BlameCache(async (repo, rel) => (await this.req("blame", { repo, path: rel })) as BlameLine[]);
    const w = vscode.window, ws = vscode.workspace;
    this.subs.push(
      this.deco,
      this.bar,
      w.onDidChangeTextEditorSelection((e) => e.textEditor === w.activeTextEditor && this.schedule()),
      w.onDidChangeActiveTextEditor(() => this.schedule(0)),
      ws.onDidChangeTextDocument((e) => e.document === w.activeTextEditor?.document && this.schedule()),
      ws.onDidSaveTextDocument((d) => {
        const r = this.repoOf(d.uri);
        if (r) this.cache.invalidate(r.repo, r.rel);
        this.schedule(0);
        this.lensChanged.fire();
      }),
      ws.onDidChangeConfiguration((e) => (e.affectsConfiguration("git403.blame") && this.schedule(0), e.affectsConfiguration("git403.codeLens") && this.lensChanged.fire())),
      this.lensChanged,
      vscode.languages.registerCodeLensProvider({ scheme: "file" }, { onDidChangeCodeLenses: this.lensChanged.event, provideCodeLenses: (d) => this.lenses(d) }),
      vscode.commands.registerCommand("git403.showLineHistory", (uri: vscode.Uri, start: number, end: number) => this.showLineHistory(uri, start, end)),
      vscode.commands.registerCommand("git403.showFileHistory", () => void Promise.resolve(vscode.commands.executeCommand("git403.fileHistory.focus")).then(undefined, () => {})),
      vscode.languages.registerHoverProvider({ scheme: "file" }, { provideHover: (d, p) => this.hover(d, p) }),
      vscode.commands.registerCommand("git403.toggleInlineBlame", () => cfg().update("blame.inline", !cfg().get("blame.inline", true), vscode.ConfigurationTarget.Global)),
      vscode.commands.registerCommand("git403.copySha", (sha: string) => vscode.env.clipboard.writeText(sha)),
      vscode.commands.registerCommand("git403.showBlameActions", () => this.actions()),
    );
    this.schedule(0);
  }

  /** 서버 이벤트: 저장소가 바뀌면 그 저장소의 blame·커밋·diff 캐시를 버린다(`repo`가 없으면 전부) */
  onServerEvent(event: string, payload?: unknown) {
    if (event !== "repo-changed") return;
    const repo = (payload as { repo?: unknown } | null)?.repo;
    if (typeof repo === "string") (this.cache.invalidate(repo), this.commits.invalidate(repo), this.diffs.invalidate(repo));
    else (this.cache.clear(), this.commits.invalidate(), this.diffs.invalidate());
    this.schedule();
    this.lensChanged.fire();
  }

  /**
   * CodeLens: 파일 맨 위 "N authors • 최근 수정자, 상대시간"(→ File History)와 함수·클래스·메서드마다 같은 요약(→ 그 범위의 Line History).
   * blame 캐시를 줄 끝 blame과 같이 쓰고, 저장 안 된 편집은 트래커로 옮긴 줄만 센다. 설정 `git403.codeLens.scopes`.
   */
  private async lenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const scopes = lensScopes(cfg().get("codeLens.scopes"));
    const repo = (scopes.file || scopes.symbols) && this.space.repoOf(doc.uri);
    if (!repo) return [];
    const lines = await this.cache.get(repo.repo, repo.rel);
    if (!lines) return [];
    const cur = currentLines(lines, this.dirty.view(doc));
    const title = (s: NonNullable<ReturnType<typeof summarize>>) => {
      const p = lensParts(s, Date.now() / 1000, vscode.env.language);
      return p.n === 1 ? t("1 author • {0}, {1}", p.author, p.rel) : t("{0} authors • {1}, {2}", p.n, p.author, p.rel);
    };
    const out: vscode.CodeLens[] = [];
    const top = scopes.file && summarize(cur);
    if (top) out.push(new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), { title: title(top), tooltip: t("Show File History"), command: "git403.showFileHistory" }));
    if (scopes.symbols)
      for (const sym of symbolScopes(await this.symbols(doc))) {
        const s = summarize(cur.slice(sym.start, sym.end + 1));
        if (s) out.push(new vscode.CodeLens(new vscode.Range(sym.start, 0, sym.start, 0), { title: title(s), tooltip: t("Show Line History of {0}", sym.name), command: "git403.showLineHistory", arguments: [doc.uri, sym.start, sym.end] }));
      }
    return out;
  }

  private async symbols(doc: vscode.TextDocument): Promise<SymbolLike[]> {
    const res = await Promise.resolve(vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>("vscode.executeDocumentSymbolProvider", doc.uri)).catch(() => undefined);
    const span = (r: vscode.Range) => ({ start: r.start.line, end: r.end.character === 0 && r.end.line > r.start.line ? r.end.line - 1 : r.end.line });
    const conv = (s: vscode.DocumentSymbol | vscode.SymbolInformation): SymbolLike =>
      "range" in s ? { name: s.name, kind: s.kind, ...span(s.range), children: s.children.map(conv) } : { name: s.name, kind: s.kind, ...span(s.location.range) };
    return (res ?? []).map(conv);
  }

  /** 렌즈 클릭: 그 범위를 선택해 Line History 뷰가 그 줄들의 히스토리를 보이게 한다 */
  private async showLineHistory(uri: vscode.Uri, start: number, end: number) {
    const doc = await vscode.workspace.openTextDocument(uri);
    const ed = await vscode.window.showTextDocument(doc, { preserveFocus: true });
    const last = Math.min(end, doc.lineCount - 1);
    ed.selection = new vscode.Selection(start, 0, last, doc.lineAt(last).range.end.character);
    await Promise.resolve(vscode.commands.executeCommand("git403.lineHistory.focus")).then(undefined, () => {});
  }

  private repoOf(uri: vscode.Uri) {
    return this.space.repoOf(uri);
  }

  private schedule(ms = 120) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.update(), ms);
  }

  private clear(editor?: vscode.TextEditor) {
    editor?.setDecorations(this.deco, []);
    this.bar.hide();
    this.current = null;
    Object.assign(blameState, { line: null, decoration: null, statusBar: null });
  }

  private async update() {
    const editor = vscode.window.activeTextEditor;
    const inline = cfg().get<boolean>("blame.inline", true), bar = cfg().get<boolean>("blame.statusBar", true);
    blameState.inline = inline;
    const my = ++this.seq;
    const repo = editor && (inline || bar) ? this.repoOf(editor.document.uri) : null;
    if (!editor || !repo) return this.clear(editor);
    const lineNo = editor.selection.active.line;
    const doc = editor.document;
    const lines = await this.cache.get(repo.repo, repo.rel);
    if (my !== this.seq) return; // 더 최신 요청이 있다
    const info: LineInfo = lineInfo(lines, lineNo, this.dirty.view(doc));
    if (!info) return this.clear(editor);
    const now = Date.now() / 1000, loc = vscode.env.language;
    const text = info === "uncommitted" ? t("Not committed yet") : inlineText(info, now, loc);
    const short = info === "uncommitted" ? t("Not committed yet") : `${info.author}, ${relativeTime(now, info.time, loc)}`;
    const end = doc.lineAt(lineNo).range.end;
    editor.setDecorations(this.deco, inline ? [{ range: new vscode.Range(end, end), renderOptions: { after: { contentText: text } } }] : []);
    if (bar) {
      this.bar.text = `$(git-commit) ${short}`;
      this.bar.tooltip = text;
      this.bar.show();
    } else this.bar.hide();
    this.current = info === "uncommitted" ? null : { commit: info };
    Object.assign(blameState, { line: lineNo, decoration: inline ? text : null, statusBar: bar ? this.bar.text : null });
  }

  private commit(repo: string, sha: string) {
    return this.commits.get(repo, sha, () => this.req("git", { repo, args: ["show", "-s", `--format=${COMMIT_FORMAT}`, sha] }).then((o) => parseCommit(String(o))));
  }

  private diff(repo: string, sha: string, rel: string) {
    return this.diffs.get(repo, `${sha}\0${rel}`, () => this.req("file_diff", { repo, commit: sha, path: rel, ignoreEol: false }).then(String));
  }

  /** 줄 끝(= decoration 위)에 올린 호버 */
  private async hover(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.Hover | null> {
    if (!cfg().get<boolean>("blame.inline", true) || pos.character < doc.lineAt(pos.line).text.length) return null;
    const repo = this.repoOf(doc.uri);
    if (!repo) return null;
    const info = lineInfo(await this.cache.get(repo.repo, repo.rel), pos.line, this.dirty.view(doc));
    if (!info || info === "uncommitted") return null;
    try {
      const [commit, diff] = await Promise.all([this.commit(repo.repo, info.sha), this.diff(repo.repo, info.sha, repo.rel).catch(() => "")]);
      const loc = vscode.env.language;
      const md = new vscode.MarkdownString(
        hoverMarkdown({
          commit,
          date: new Date(commit.time * 1000).toLocaleString(loc),
          rel: relativeTime(Date.now() / 1000, commit.time, loc),
          hunk: pickHunk(diff, info.text),
          links: { graph: commandUri("git403.openGraph", { sha: info.sha, repo: repo.repo }), copy: commandUri("git403.copySha", info.sha) },
          labels: { graph: t("Open in graph"), copy: t("Copy SHA") },
        }),
      );
      md.isTrusted = { enabledCommands: ["git403.openGraph", "git403.copySha"] };
      return new vscode.Hover(md);
    } catch {
      return null;
    }
  }

  /** 상태 바 클릭: 커밋 정보 quick pick */
  private async actions() {
    const editor = vscode.window.activeTextEditor;
    const repo = editor && this.repoOf(editor.document.uri);
    const cur = this.current?.commit;
    if (!repo || !cur) return;
    const c = await this.commit(repo.repo, cur.sha).catch(() => null);
    const pick = await vscode.window.showQuickPick(
      [
        { label: `$(git-commit) ${cur.sha.slice(0, 8)} ${cur.summary}`, detail: c ? `${c.author} <${c.email}>, ${new Date(c.time * 1000).toLocaleString(vscode.env.language)}` : cur.author, id: "info" },
        { label: `$(graph) ${t("Open in graph")}`, id: "graph" },
        { label: `$(copy) ${t("Copy SHA")}`, id: "copy" },
      ],
      { placeHolder: cur.summary },
    );
    if (pick?.id === "graph") await vscode.commands.executeCommand("git403.openGraph", { sha: cur.sha, repo: repo.repo });
    else if (pick?.id === "copy") await vscode.env.clipboard.writeText(cur.sha);
  }

  dispose() {
    clearTimeout(this.timer);
    this.seq++;
    for (const d of this.subs) d.dispose();
  }
}
