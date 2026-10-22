// 작업 영역의 저장소 목록(멀티루트·하위 .git)과 저장소별 감시. 편집기·사이드바가 같이 쓴다.
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { findRepo } from "./blame.ts";
import { RepoWatch, discoverRepos, gitInDepth } from "./repos.ts";

type Request = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export class Workspace implements vscode.Disposable {
  /** 찾은 저장소(정렬됨) */
  repos: string[] = [];
  private watch: RepoWatch;
  private emitter = new vscode.EventEmitter<void>();
  /** 저장소 목록이 바뀔 때 */
  readonly onDidChange = this.emitter.event;
  private seq = 0;
  private lastActive: string | null = null;

  private sub: vscode.Disposable[];
  private gitWatchers: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(req: Request) {
    this.watch = new RepoWatch(req);
    // 웹뷰·diff 등으로 활성 편집기가 파일이 아니게 돼도 마지막으로 본 파일의 저장소를 기억한다
    this.sub = [
      vscode.window.onDidChangeActiveTextEditor(() => void this.activeRepo()),
      // 폴더가 추가·제거되면 감시를 다시 걸고 저장소를 다시 찾는다
      vscode.workspace.onDidChangeWorkspaceFolders(() => (this.watchGit(), this.refreshSoon())),
    ];
    this.watchGit();
  }

  /** 열린 뒤 생기거나 사라진 하위 저장소(`.git` 생성·삭제)를 찾는다: 탐색 깊이 안의 것만 */
  private watchGit() {
    for (const w of this.gitWatchers) w.dispose();
    this.gitWatchers = (vscode.workspace.workspaceFolders ?? []).map((f) => {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(f, "**/.git"));
      const on = (u: vscode.Uri) => gitInDepth(f.uri.fsPath, u.fsPath) && this.refreshSoon();
      return vscode.Disposable.from(w, w.onDidCreate(on), w.onDidDelete(on));
    });
  }

  /** 디바운스한 refresh(`git clone`·`git init`·폴더 이동이 이벤트를 몰아서 낸다) */
  refreshSoon(ms = 600) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh().catch(() => {}), ms);
  }

  private roots = () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

  /** 다시 찾고 감시를 맞춘다(폴더가 빠지면 그 저장소는 `watch_remove`). 목록이 바뀌면 `onDidChange` */
  async refresh(): Promise<void> {
    const my = ++this.seq;
    const next = await discoverRepos(this.roots());
    if (my !== this.seq) return; // 더 최신 refresh가 있다
    const changed = next.join("\0") !== this.repos.join("\0");
    this.repos = next;
    await this.watch.sync(next);
    if (changed) this.emitter.fire();
  }

  /** 지금 감시 중인 저장소(테스트·진단용) */
  get watched() {
    return this.watch.repos;
  }

  /** 서버가 다시 떴을 때: 서버가 감시를 잃었으므로 다시 건다 */
  async resync() {
    this.watch.forget();
    await this.watch.sync(this.repos);
  }

  /** 파일이 속한 저장소: 찾은 저장소(작업 영역 폴더의 상위 저장소 포함) 중 가장 안쪽, 없으면 위로 `.git`을 찾는다. rel은 그 저장소 기준 */
  repoOf(uri: vscode.Uri): { repo: string; rel: string } | null {
    if (uri.scheme !== "file") return null;
    const f = uri.fsPath;
    const r = this.repos.filter((x) => f.startsWith(x + path.sep)).sort((a, b) => b.length - a.length)[0];
    return r ? { repo: r, rel: path.relative(r, f).split(path.sep).join("/") } : findRepo(f, this.roots(), fs.existsSync);
  }

  /** 지금 기준 저장소: 활성 편집기 파일의 저장소 → 마지막으로 본 저장소 → 첫 저장소 */
  activeRepo(): string | null {
    const ed = vscode.window.activeTextEditor;
    const r = ed && this.repoOf(ed.document.uri)?.repo;
    if (r) this.lastActive = r;
    return r ?? (this.lastActive && this.repos.includes(this.lastActive) ? this.lastActive : (this.repos[0] ?? null));
  }

  dispose() {
    this.seq++;
    clearTimeout(this.timer);
    for (const d of [...this.sub, ...this.gitWatchers]) d.dispose();
    this.emitter.dispose();
  }
}
