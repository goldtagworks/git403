// 다중 저장소 스모크 (test/run.mjs가 멀티루트 폴더 a-app·b-lib·c-tool로 띄운다. a-app 안에는 pkg/inner 저장소가 하나 더 있다).
// 저장소 찾기, 저장소 노드(뷰 최상위), 저장소별 감시(watch_add/remove)와 repo-changed의 repo로 해당 저장소만 갱신, 활성 파일의 저장소 기준 히스토리·그래프.
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

type DebugState = { server: boolean; initialRepo: string | null; responses: Record<string, { ok: boolean; commits?: number }>; eventRepos: Record<string, number>; repos: string[]; watched: string[]; refLoads: Record<string, number>; panel: boolean; selected: string | null; graphRepo: string | null; openRepos: number };
type DNode = { label: string; description?: string; context: string; icon: string; children?: DNode[]; command?: { command: string; arguments?: unknown[] } };
const state = async () => (await vscode.commands.executeCommand<DebugState>("git403.debugState"))!;
const tree = async (id: string) => (await vscode.commands.executeCommand<DNode[]>("git403.debugTree", id))!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const labels = (n: DNode[] | undefined) => (n ?? []).map((x) => x.label);
const git = (repo: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo }).toString().trim();

async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  let v = await get();
  while (!ok(v) && Date.now() < end) (await sleep(400), (v = await get()));
  assert.ok(ok(v), `${what}: ${JSON.stringify(v)}`);
  return v;
}

const open = (file: string) => vscode.workspace.openTextDocument(vscode.Uri.file(file)).then((d) => vscode.window.showTextDocument(d));
const localOf = (n: DNode) => labels(n.children?.find((c) => c.label === "Local")?.children);

export async function run() {
  // 패널 열고 닫기를 보는 테스트라 편집기 탭 그래프로 연다(아래 패널 그래프는 suite.ts graphViewTests)
  await vscode.workspace.getConfiguration("git403").update("graph.location", "editor", vscode.ConfigurationTarget.Global);
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  assert.equal(folders.length, 3, "멀티루트 폴더 3개");
  const [A, B, C] = folders;
  const inner = path.join(A, "pkg", "inner");
  const sorted = [A, inner, B, C];

  // ---- 저장소 찾기·감시: 폴더 3개 + 하위 .git 하나를 모두 저장소로 보고 저장소별로 감시한다 ----
  let s = await until(state, (x) => x.repos.length === 4 && x.watched.length === 4, "저장소 4개를 찾고 감시한다");
  assert.deepEqual(s.repos, sorted);
  assert.deepEqual(s.watched, sorted, "저장소마다 watch_add");

  // ---- 뷰: 저장소가 둘 이상이면 최상위가 저장소 노드 ----
  let b = await until(() => tree("branches"), (n) => n?.length === 4 && n.every((x) => x.children?.length), "Branches 저장소 노드");
  assert.deepEqual(labels(b), ["a-app", "inner", "b-lib", "c-tool"]);
  assert.ok(b.every((x) => x.context === "git403.repo" && x.icon === "repo"));
  assert.deepEqual(localOf(b[0]), ["main", "a-feature"]);
  assert.deepEqual(localOf(b[2]), ["main", "b-feature"]);
  assert.deepEqual(labels(b[0].children), ["Local", "origin"], "a-app에는 원격이 있다");
  // 원격 뷰: URL이 설명
  const rm = await until(() => tree("remotes"), (n) => n?.length === 4, "Remotes 저장소 노드");
  assert.equal(rm[0].children![0].label, "origin");
  assert.equal(rm[0].children![0].description, git(A, "remote", "get-url", "origin"), "원격 노드 설명 = URL");
  const tags = await tree("tags");
  assert.deepEqual(labels(tags), ["a-app", "inner", "b-lib", "c-tool"]);

  // ---- 저장소별 갱신: B의 브랜치가 바뀌면 B만 다시 읽는다 ----
  // 시작 직후에는 플랫폼마다 늦게 오는 감시 이벤트(Linux inotify 등)가 있을 수 있어, 로드·이벤트 수가 1.5초간 변하지 않을 때까지 기다린 뒤 그 기준에서 변화량만 본다
  let prev = "";
  for (let i = 0; i < 40; i++) {
    const cur = JSON.stringify((await state()).refLoads) + JSON.stringify((await state()).eventRepos);
    if (cur === prev) break;
    prev = cur;
    await sleep(1500);
  }
  s = await state();
  const loadsBefore = { ...s.refLoads };
  assert.ok(Object.values(loadsBefore).every((n) => n >= 1), `저장소마다 한 번 이상 읽었다: ${JSON.stringify(loadsBefore)}`);
  git(B, "branch", "b-new");
  b = await until(() => tree("branches"), (n) => localOf(n[2]).includes("b-new"), "B의 새 브랜치가 보인다");
  s = await state();
  assert.ok(s.eventRepos[B] >= 1, "repo-changed가 B로 왔다");
  assert.ok(s.refLoads[B] > loadsBefore[B], "B는 다시 읽었다");
  for (const r of [A, inner, C]) assert.equal(s.refLoads[r], loadsBefore[r], `${path.basename(r)}는 다시 읽지 않았다 (loads ${JSON.stringify(s.refLoads)}, events ${JSON.stringify(s.eventRepos)})`);
  assert.deepEqual(localOf(b[0]), ["main", "a-feature"], "다른 저장소 뷰는 그대로");

  // ---- 활성 편집기 파일의 저장소 기준 히스토리 ----
  await open(path.join(B, "b.txt"));
  await until(() => tree("fileHistory"), (n) => labels(n).join() === "init b-lib", "B 파일의 File History");
  await open(path.join(A, "a.txt"));
  await until(() => tree("fileHistory"), (n) => labels(n).join() === "init a-app", "A 파일의 File History");
  await open(path.join(inner, "i.txt"));
  await until(() => tree("fileHistory"), (n) => labels(n).join() === "init inner", "하위 저장소 파일은 그 저장소의 히스토리");
  // blame도 그 저장소로
  const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", vscode.Uri.file(path.join(B, "b.txt")));
  assert.ok(lenses.some((l) => l.command?.command === "git403.showFileHistory"), "B 파일의 CodeLens");

  // ---- 그래프 패널은 활성 파일의 저장소로 열린다 ----
  await open(path.join(B, "b.txt"));
  await vscode.commands.executeCommand("git403.openGraph");
  s = await until(state, (x) => x.panel && !!x.initialRepo && !!x.responses.load_graph, "패널이 열린다");
  assert.equal(s.initialRepo, B, "initial_repo = 활성 파일의 저장소");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  await until(state, (x) => !x.panel, "패널 닫힘");
  await open(path.join(inner, "i.txt"));
  await vscode.commands.executeCommand("git403.openGraph");
  s = await until(state, (x) => x.panel && x.initialRepo === inner && !!x.responses.load_graph, "하위 저장소 파일이면 그 저장소");

  // 브랜치 클릭 = 그 브랜치 끝 커밋을 그래프에서 선택. 열린 패널이 다른 저장소를 보고 있으면 패널을 다시 열지 않고
  // 웹뷰에 저장소 전환(openRepo)을 보내 UI의 기존 저장소 열기(탭) 경로로 바꾼다
  const feature = (await tree("branches"))[0].children![0].children!.find((x) => x.label === "a-feature")!;
  assert.equal(feature.command?.command, "git403.openGraph");
  assert.equal((feature.command!.arguments![0] as { repo: string }).repo, A);
  s = await until(state, (x) => x.graphRepo === inner, "패널은 inner를 보고 있다");
  const opens = s.openRepos;
  await vscode.commands.executeCommand(feature.command!.command, ...feature.command!.arguments!);
  const tip = git(A, "rev-parse", "a-feature");
  s = await until(state, (x) => x.graphRepo === A && x.selected === tip, "A의 브랜치 클릭 → 같은 패널이 A로 전환되어 선택");
  assert.equal(s.openRepos, opens + 1, "openRepo 메시지로 전환했다");
  assert.equal(s.initialRepo, inner, "패널을 다시 열지 않았다(initial_repo는 처음 한 번)");
  assert.ok(s.panel);
  assert.equal(s.responses.load_graph.ok, true);

  // ---- 열린 뒤 새로 생긴 하위 저장소: .git 생성·삭제를 감시해 목록·감시·뷰를 맞춘다 ----
  const late = path.join(A, "pkg", "late");
  fs.mkdirSync(late, { recursive: true });
  git(late, "init", "-q", "-b", "main");
  git(late, "commit", "-q", "--allow-empty", "-m", "late init");
  s = await until(state, (x) => x.repos.includes(late) && x.watched.includes(late), "새 하위 저장소를 찾고 watch_add");
  await until(() => tree("branches"), (n) => n.some((x) => x.label === "late"), "뷰에 새 저장소 노드");
  fs.rmSync(path.join(late, ".git"), { recursive: true, force: true });
  s = await until(state, (x) => !x.repos.includes(late) && !x.watched.includes(late), ".git이 사라지면 목록·감시에서 빠진다");
  await until(() => tree("branches"), (n) => !n.some((x) => x.label === "late"), "뷰에서 사라진다");

  // ---- 폴더 제거: C를 빼면 C의 감시가 끝나고 뷰에서도 사라진다 ----
  git(C, "branch", "c-before");
  await until(state, (x) => (x.eventRepos[C] ?? 0) >= 1, "C 감시가 동작한다");
  const cBefore = (await state()).eventRepos[C];
  assert.ok(vscode.workspace.updateWorkspaceFolders(2, 1), "폴더 제거 요청");
  s = await until(state, (x) => x.repos.length === 3 && x.watched.length === 3, "C가 저장소·감시에서 빠진다");
  assert.deepEqual(s.watched, [A, inner, B]);
  b = await until(() => tree("branches"), (n) => labels(n).join() === "a-app,inner,b-lib", "뷰에서 C가 사라진다");
  git(C, "branch", "c-after");
  await sleep(1500);
  assert.equal((await state()).eventRepos[C], cBefore, "빠진 폴더의 변경은 이벤트가 오지 않는다(watch_remove)");
  // 다른 저장소는 계속 감시된다
  git(B, "branch", "b-newer");
  await until(() => tree("branches"), (n) => localOf(n[2]).includes("b-newer"), "남은 저장소는 계속 갱신된다");

  // ---- 작업 영역 폴더가 저장소의 하위 폴더: 상위 저장소를 찾고 파일 경로는 그 저장소 기준 ----
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git403-parent-")));
  fs.mkdirSync(path.join(parent, "sub"));
  fs.writeFileSync(path.join(parent, "sub", "x.txt"), "x\n");
  git(parent, "init", "-q", "-b", "main");
  git(parent, "add", "-A");
  git(parent, "commit", "-q", "-m", "init parent");
  const n = vscode.workspace.workspaceFolders!.length;
  assert.ok(vscode.workspace.updateWorkspaceFolders(n, 0, { uri: vscode.Uri.file(path.join(parent, "sub")) }), "하위 폴더 추가 요청");
  s = await until(state, (x) => x.repos.includes(parent) && x.watched.includes(parent), "상위 저장소를 찾고 감시한다");
  await open(path.join(parent, "sub", "x.txt"));
  await until(() => tree("fileHistory"), (nd) => labels(nd).join() === "init parent", "저장소 기준 상대 경로(sub/x.txt)로 File History");
  assert.ok(vscode.workspace.updateWorkspaceFolders(n, 1), "폴더 제거 요청");
  await until(state, (x) => !x.repos.includes(parent) && !x.watched.includes(parent), "폴더를 빼면 상위 저장소도 빠진다");
  fs.rmSync(parent, { recursive: true, force: true });
}
