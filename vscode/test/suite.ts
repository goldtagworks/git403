// VS Code 안에서 도는 스모크 테스트 (test/run.mjs가 @vscode/test-electron로 띄운다).
// 편집기 기능(줄 끝 blame·상태 바·호버)은 패널 없이, 그래프 패널은 `git403.openGraph`로 — 확장을 실제로 활성화하고 `git403.openGraph`를 실행해, 웹뷰의 UI가 서버에 load_graph를 요청해 응답을 받는지 본다.
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as vscode from "vscode";

type DebugState = { server: boolean; initialRepo: string | null; responses: Record<string, { ok: boolean; commits?: number; err?: string }>; events: Record<string, number>; eventRepos: Record<string, number>; repos: string[]; watched: string[]; refLoads: Record<string, number>; panel: boolean; graphKinds: string[]; graphVisible: string[]; selected: string | null; blame: { line: number | null; decoration: string | null; statusBar: string | null; inline: boolean } };
const state = () => vscode.commands.executeCommand<DebugState>("git403.debugState");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(done: (s: DebugState) => Promise<boolean>) {
  const deadline = Date.now() + 90_000;
  let s = await state();
  while (!(await done(s)) && Date.now() < deadline) {
    await sleep(500);
    s = await state();
  }
  return s;
}

async function blameTests(folder: string) {
  const uri = vscode.Uri.file(`${folder}/b.txt`);
  const doc = await vscode.workspace.openTextDocument(uri);
  const ed = await vscode.window.showTextDocument(doc);
  const at = async (line: number, re: RegExp) => {
    ed.selection = new vscode.Selection(line, 0, line, 0);
    const s = await waitFor(async (x) => x.blame.line === line && re.test(x.blame.decoration ?? ""));
    assert.match(s.blame.decoration ?? "", re, `${line}번 줄 decoration`);
    return s;
  };
  // 패널 없이 서버가 떠 있다 (서버 수명 = 확장 수명)
  let s = await at(0, /^t, .+ • first$/);
  assert.ok(!s.panel && s.server, "패널 없이도 서버가 산다");
  assert.match(s.blame.statusBar ?? "", /^\$\(git-commit\) t, /, "상태 바");
  await at(1, /^t, .+ • second$/);
  s = await at(2, /^Not committed yet$/); // 커밋 안 된 줄
  assert.equal(s.blame.statusBar, "$(git-commit) Not committed yet");

  // 호버: 줄 끝 위치. SHA·작성자·메시지·그 줄 근처 hunk·명령 링크
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", uri, new vscode.Position(1, 4));
  const md = hovers.flatMap((h) => h.contents).map((c) => (typeof c === "string" ? c : c.value)).join("\n");
  assert.match(md, /`[0-9a-f]{8}`/, "짧은 SHA");
  assert.match(md, /t &lt;t@t&gt;/, "작성자·이메일");
  assert.match(md, /second/, "메시지");
  assert.match(md, /```diff\n@@[^\n]*\n one\n-two\n\+two!/, "hunk");
  assert.match(md, /command:git403\.openGraph\?/, "그래프 링크");
  assert.match(md, /command:git403\.copySha\?/, "SHA 복사 링크");
  const none = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", uri, new vscode.Position(2, 5));
  assert.equal(none.length, 0, "커밋 안 된 줄은 호버 없음");

  // 설정 토글: 줄 끝만 꺼지고 상태 바는 남는다
  await at(1, /second$/);
  await vscode.commands.executeCommand("git403.toggleInlineBlame");
  s = await waitFor(async (x) => !x.blame.inline);
  assert.equal(s.blame.decoration, null, "줄 끝 blame 꺼짐");
  assert.match(s.blame.statusBar ?? "", /^\$\(git-commit\) t, /, "상태 바는 유지");
  await vscode.commands.executeCommand("git403.toggleInlineBlame");
  await waitFor(async (x) => x.blame.inline && !!x.blame.decoration);

  // 저장 안 된 편집: 어긋난 줄은 커밋 안 됨으로 단순 처리, 되돌리면 복귀
  await ed.edit((b) => b.insert(new vscode.Position(0, 0), "x"));
  ed.selection = new vscode.Selection(0, 0, 0, 0);
  await waitFor(async (x) => x.blame.line === 0 && x.blame.decoration === "Not committed yet");
  assert.equal((await state()).blame.decoration, "Not committed yet", "편집한 줄은 커밋 안 됨");
  await vscode.commands.executeCommand("workbench.action.files.revert");
  await waitFor(async () => !doc.isDirty);
  ed.selection = new vscode.Selection(0, 0, 0, 0);
  s = await waitFor(async (x) => x.blame.line === 0 && /• first$/.test(x.blame.decoration ?? ""));
  assert.match(s.blame.decoration ?? "", /^t, .+ • first$/, `되돌리면 blame 복귀 ${JSON.stringify(s.blame)} dirty=${doc.isDirty} text=${doc.lineAt(0).text}`);
}

async function lensTests(folder: string) {
  const uri = vscode.Uri.file(`${folder}/b.txt`);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  const lenses = async (u = uri, cmd = "git403.showFileHistory") => (await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", u)).filter((l) => l.command?.command === cmd);
  let l = await lenses();
  const deadline = Date.now() + 30_000;
  while (!l.length && Date.now() < deadline) (await sleep(300), (l = await lenses()));
  assert.equal(l.length, 1, "파일 맨 위 렌즈 하나");
  assert.deepEqual([l[0].range.start.line, l[0].range.start.character], [0, 0]);
  assert.match(l[0].command!.title, /^1 author • t, /, "작성자 1명(t)·최근 수정자");
  // 클릭 = File History 뷰 포커스 (실패해도 던지지 않는다)
  await vscode.commands.executeCommand(l[0].command!.command);

  // 심볼 단위 렌즈: 테스트용 심볼 프로바이더(함수 alpha, 클래스 Beta 안의 메서드 gamma, 변수 VERSION은 렌즈 대상 아님)
  const S = vscode.SymbolKind;
  const sym = (n: string, k: vscode.SymbolKind, a: number, b: number, kids: vscode.DocumentSymbol[] = []) => {
    const s = new vscode.DocumentSymbol(n, "", k, new vscode.Range(a, 0, b, 1), new vscode.Range(a, 0, a, 1));
    s.children = kids;
    return s;
  };
  const provider = vscode.languages.registerDocumentSymbolProvider({ pattern: "**/c.txt" }, { provideDocumentSymbols: () => [sym("alpha", S.Function, 10, 20), sym("Beta", S.Class, 30, 59, [sym("gamma", S.Method, 45, 55), sym("field", S.Field, 40, 40)]), sym("VERSION", S.Constant, 25, 25)] });
  try {
    const c = vscode.Uri.file(`${folder}/c.txt`);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(c));
    const all = async (ok: (x: vscode.CodeLens[]) => boolean) => {
      const end = Date.now() + 30_000;
      let x = (await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", c)).filter((y) => y.command?.command.startsWith("git403."));
      while (!ok(x) && Date.now() < end) (await sleep(300), (x = (await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", c)).filter((y) => y.command?.command.startsWith("git403."))));
      return x;
    };
    const both = await all((x) => x.length === 4);
    assert.deepEqual(both.map((x) => [x.command!.command, x.range.start.line]), [["git403.showFileHistory", 0], ["git403.showLineHistory", 10], ["git403.showLineHistory", 30], ["git403.showLineHistory", 45]], "파일 렌즈 + 함수·클래스·메서드 렌즈(변수·필드 제외)");
    for (const x of both) assert.match(x.command!.title, /^1 author • t, /);
    assert.deepEqual(both[3].command!.arguments!.slice(1), [45, 55], "메서드 범위");

    // 렌즈 클릭: 그 범위의 Line History (gamma 45~55줄은 50번 줄이 바뀐 second 포함, alpha 10~20줄은 first만)
    await vscode.commands.executeCommand(both[3].command!.command, ...both[3].command!.arguments!);
    await treeUntil("lineHistory", (n) => labels(n).join() === "second,first", "메서드 렌즈 → Line History");
    await vscode.commands.executeCommand(both[1].command!.command, ...both[1].command!.arguments!);
    await treeUntil("lineHistory", (n) => labels(n).join() === "first", "함수 렌즈 → Line History");

    // 설정 git403.codeLens.scopes
    const cfg = vscode.workspace.getConfiguration("git403");
    await cfg.update("codeLens.scopes", ["symbols"], vscode.ConfigurationTarget.Global);
    assert.deepEqual((await all((x) => x.length === 3)).map((x) => x.command!.command), ["git403.showLineHistory", "git403.showLineHistory", "git403.showLineHistory"], "symbols만");
    await cfg.update("codeLens.scopes", ["file"], vscode.ConfigurationTarget.Global);
    assert.deepEqual((await all((x) => x.length === 1)).map((x) => x.command!.command), ["git403.showFileHistory"], "file만");
    await cfg.update("codeLens.scopes", [], vscode.ConfigurationTarget.Global);
    assert.equal((await all((x) => x.length === 0)).length, 0, "빈 목록이면 렌즈 없음");
    await cfg.update("codeLens.scopes", undefined, vscode.ConfigurationTarget.Global);
    assert.equal((await all((x) => x.length === 4)).length, 4, "기본값은 둘 다");
  } finally {
    provider.dispose();
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri)); // 뒤 테스트는 b.txt가 활성이라고 가정한다
  }
}

/** 저장 전 편집 추적: 줄을 삽입하면 아래 줄의 blame·Line History가 밀린 줄을 따라가고, 새 줄은 커밋 안 됨 */
async function dirtyTests(folder: string) {
  const uri = vscode.Uri.file(`${folder}/b.txt`);
  const doc = await vscode.workspace.openTextDocument(uri);
  const ed = await vscode.window.showTextDocument(doc);
  const at = async (line: number, re: RegExp) => {
    ed.selection = new vscode.Selection(line, 0, line, 0);
    const s = await waitFor(async (x) => x.blame.line === line && re.test(x.blame.decoration ?? ""));
    assert.match(s.blame.decoration ?? "", re, `${line}번 줄 decoration ${JSON.stringify(s.blame)} ${JSON.stringify(doc.getText())}`);
  };
  await ed.edit((b) => b.insert(new vscode.Position(0, 0), "new line\n")); // new line / one / two! / three
  assert.ok(doc.isDirty);
  await at(0, /^Not committed yet$/);
  await at(1, /^t, .+ • first$/); // "one"은 한 줄 밀렸지만 first의 blame
  await at(2, /^t, .+ • second$/);
  await at(3, /^Not committed yet$/); // 원래 커밋 안 된 줄
  // Line History도 디스크 기준 줄로 옮겨 찾는다
  ed.selection = new vscode.Selection(1, 0, 1, 0);
  await treeUntil("lineHistory", (n) => labels(n).join() === "first", "밀린 줄의 Line History");
  ed.selection = new vscode.Selection(2, 0, 2, 0);
  await treeUntil("lineHistory", (n) => labels(n).join() === "second,first", "밀린 줄의 Line History(2)");
  ed.selection = new vscode.Selection(0, 0, 0, 0); // 새로 쓴 줄만 선택: 안내(비어 있음)
  await treeUntil("lineHistory", (n) => n.length === 0, "새 줄만 선택하면 Line History 비어 있음");
  // 삭제: 맨 위 새 줄과 "one"을 지우면 "two!"가 0번 줄
  await ed.edit((b) => b.delete(new vscode.Range(0, 0, 2, 0)));
  await at(0, /^t, .+ • second$/);
  // 되돌리기: undo 두 번 대신 revert로 디스크 상태 복귀
  await vscode.commands.executeCommand("workbench.action.files.revert");
  await waitFor(async () => !doc.isDirty);
  await at(0, /^t, .+ • first$/);
  // 재입력: 첫 줄을 지웠다가 같은 내용을 다시 붙여넣으면(undo가 아니라) 원래 blame
  await ed.edit((b) => b.delete(new vscode.Range(0, 0, 1, 0)));
  await at(0, /^t, .+ • second$/);
  await ed.edit((b) => b.insert(new vscode.Position(0, 0), "one\n"));
  await at(0, /^t, .+ • first$/);
  await at(1, /^t, .+ • second$/);
  await ed.edit((b) => b.insert(new vscode.Position(0, 0), "one\n")); // 같은 줄이 하나 더: 이번엔 새 줄
  await at(0, /^Not committed yet$/);
  await vscode.commands.executeCommand("workbench.action.files.revert");
  await waitFor(async () => !doc.isDirty);
}

/** 그래프 → 편집기: `git403.openFile`(웹뷰의 openFile 메시지와 같은 경로)이 diff 에디터를 연다 */
async function openFileTests(folder: string) {
  const activeDiff = async (ok: (i: vscode.TabInputTextDiff) => boolean) => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const i = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      if (i instanceof vscode.TabInputTextDiff && ok(i)) return i;
      assert.ok(Date.now() < deadline, "diff 에디터가 열린다");
      await sleep(300);
    }
  };
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: folder }).toString().trim();
  await vscode.commands.executeCommand("git403.openFile", { repo: folder, path: "b.txt", sha: head });
  const d = await activeDiff((i) => i.modified.scheme === "git403");
  assert.equal((await vscode.workspace.openTextDocument(d.original)).getText(), "one\ntwo\n", "sha^ 내용");
  assert.equal((await vscode.workspace.openTextDocument(d.modified)).getText(), "one\ntwo!\n", "sha 내용");
  // sha 없으면 작업 파일과 HEAD의 비교
  await vscode.commands.executeCommand("git403.openFile", { repo: folder, path: "b.txt" });
  const w = await activeDiff((i) => i.modified.scheme === "file");
  assert.equal(w.original.scheme, "git403");
  assert.equal(w.modified.fsPath, `${folder}/b.txt`);
  assert.equal((await vscode.workspace.openTextDocument(w.original)).getText(), "one\ntwo!\n", "HEAD 내용");
  // 잘못된 경로는 무시된다(탭이 늘지 않는다)
  const before = vscode.window.tabGroups.all.flatMap((g) => g.tabs).length;
  await vscode.commands.executeCommand("git403.openFile", { repo: folder, path: "../etc/passwd" });
  await sleep(500);
  assert.equal(vscode.window.tabGroups.all.flatMap((g) => g.tabs).length, before, "`..` 경로 거부");
}

type DNode = { label: string; description?: string; path?: string; context: string; icon: string; children?: DNode[]; command?: { command: string; arguments?: unknown[] } };
const tree = (id: string) => vscode.commands.executeCommand<DNode[]>("git403.debugTree", id);
async function treeUntil(id: string, ok: (n: DNode[]) => boolean, what: string) {
  const deadline = Date.now() + 60_000;
  let n = await tree(id);
  while (!ok(n) && Date.now() < deadline) {
    await sleep(400);
    n = await tree(id);
  }
  assert.ok(ok(n), `${what}: ${JSON.stringify(n)}`);
  return n;
}
const labels = (n: DNode[] | undefined) => (n ?? []).map((x) => x.label);

async function treeTests(folder: string) {
  // 참조 뷰: 임시 저장소의 브랜치·태그·스태시·원격
  let b = await treeUntil("branches", (n) => n.length > 0, "Branches");
  assert.deepEqual(b.map((x) => x.label), ["Local", "origin"]);
  assert.deepEqual(labels(b[0].children), ["main", "feature"], "현재 브랜치가 먼저");
  assert.deepEqual([b[0].children![0].icon, b[0].children![0].context], ["check", "git403.branch.current"], "현재 브랜치 표시");
  assert.deepEqual(labels(b[1].children), ["main"], "원격 그룹");
  assert.deepEqual(labels(await tree("tags")), ["v1"]);
  const st = await tree("stashes");
  assert.deepEqual(st.map((x) => [x.label, x.description]), [["wip stuff", "stash@{0} · main"]]);
  const rm = await tree("remotes");
  assert.deepEqual(rm.map((x) => [x.label, labels(x.children)]), [["origin", ["main"]]]);
  assert.equal(rm[0].description, execFileSync("git", ["remote", "get-url", "origin"], { cwd: folder }).toString().trim(), "원격 노드 설명 = URL");

  // File History: 활성 편집기(b.txt)의 커밋 → 항목 명령이 diff 에디터를 연다
  const uri = vscode.Uri.file(`${folder}/b.txt`);
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  const fh = await treeUntil("fileHistory", (n) => n.length === 2 && n[0].path === "b.txt", "File History");
  assert.deepEqual(labels(fh), ["second", "first"]);
  const cmd = fh[0].command;
  assert.equal(cmd?.command, "git403.openCommitDiff", "항목 클릭 명령");
  await vscode.commands.executeCommand(cmd!.command, ...(cmd!.arguments ?? []));
  const deadline = Date.now() + 30_000;
  let input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  while (!(input instanceof vscode.TabInputTextDiff) && Date.now() < deadline) {
    await sleep(300);
    input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  }
  assert.ok(input instanceof vscode.TabInputTextDiff, "diff 에디터가 열린다");
  assert.deepEqual([input.original.scheme, input.modified.scheme], ["git403", "git403"]);
  assert.equal((await vscode.workspace.openTextDocument(input.original)).getText(), "one\ntwo\n", "커밋 전 내용");
  assert.equal((await vscode.workspace.openTextDocument(input.modified)).getText(), "one\ntwo!\n", "커밋 후 내용");

  // Line History: 선택한 줄 범위의 커밋만 (0번 줄 "one"은 first에서만, 1번 줄 "two!"는 first·second)
  const ed = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
  ed.selection = new vscode.Selection(0, 0, 0, 0);
  await treeUntil("lineHistory", (n) => labels(n).join() === "first", "Line History 0번 줄");
  ed.selection = new vscode.Selection(1, 0, 1, 0);
  await treeUntil("lineHistory", (n) => labels(n).join() === "second,first", "Line History 1번 줄");
  assert.equal(((await tree("lineHistory"))[0].command ?? {}).command, "git403.openCommitDiff");

  // 체크아웃 후 Branches 갱신
  assert.equal(b[0].children![1].context, "git403.branch");
  await vscode.commands.executeCommand("git403.checkout", await branchNode("feature"));
  b = await treeUntil("branches", (n) => n[0]?.children?.find((x) => x.label === "feature")?.icon === "check", "체크아웃 뒤 Branches");
  assert.equal(b[0].children!.find((x) => x.label === "main")?.icon, "git-branch");
  await vscode.commands.executeCommand("git403.checkout", await branchNode("main"));
  await treeUntil("branches", (n) => n[0]?.children?.find((x) => x.label === "main")?.icon === "check", "main 복귀");
}

/** 메뉴 명령은 실제 Node(저장소·이름 포함)를 받는다 */
const branchNode = (label: string) => vscode.commands.executeCommand<unknown>("git403.debugNode", "branches", label);

export async function run() {
  const ext = vscode.extensions.getExtension("goldtagworks.git403-vscode");
  assert.ok(ext, "확장이 설치돼 있다");
  const folder0 = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(folder0, "워크스페이스가 열려 있다");
  await blameTests(folder0);
  await lensTests(folder0);
  await treeTests(folder0);
  await dirtyTests(folder0);
  await openFileTests(folder0);
  // 아래 테스트는 편집기 탭 그래프(열고 닫기)를 본다. 아래 패널 그래프는 마지막 graphViewTests
  const graphConf = vscode.workspace.getConfiguration("git403");
  await graphConf.update("graph.location", "editor", vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand("git403.openGraph");
  assert.ok(ext.isActive, "명령으로 활성화된다");
  const cmds = await vscode.commands.getCommands(true);
  assert.ok(cmds.includes("git403.openGraph"));

  const folder = folder0;

  // UI → 확장 → 서버 왕복: initial_repo는 확장이, load_graph는 서버가 답한다
  const deadline = Date.now() + 90_000;
  let s = await state();
  while (!s.responses.load_graph && Date.now() < deadline) {
    await sleep(500);
    s = await state();
  }
  assert.ok(s.panel, "웹뷰 패널이 열려 있다");
  assert.equal(s.initialRepo, folder, "initial_repo = 워크스페이스 첫 폴더");
  assert.deepEqual({ ok: s.responses.load_graph?.ok, err: s.responses.load_graph?.err }, { ok: true, err: undefined }, "load_graph 응답");
  assert.equal(s.responses.load_graph.commits, 4, "임시 저장소의 커밋 2개 + 스태시 커밋 2개(작업 트리·index)");
  assert.ok(s.responses.load_refs?.ok, "load_refs도 응답");
  assert.ok(s.server, "서버가 산다");

  // 패널을 닫아도 서버는 확장 수명이라 산다(편집기 기능이 쓴다). 다시 열면 같은 서버가 load_graph에 응답한다
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  s = await waitFor(async (x) => !x.panel);
  assert.deepEqual({ panel: s.panel, server: s.server }, { panel: false, server: true }, "닫아도 서버는 산다");
  await vscode.commands.executeCommand("git403.openGraph");
  s = await waitFor(async (x) => !!x.responses.load_graph);
  assert.ok(s.panel && s.server && s.responses.load_graph.ok, "다시 열면 같은 서버로 응답한다");

  // 확장 → 그래프 선택: 열린 패널에서, 그리고 패널이 없을 때(새로 열며 준비 후 전달)
  const sha = (rev: string) => execFileSync("git", ["rev-parse", rev], { cwd: folder }).toString().trim();
  const first = sha("HEAD~1");
  await vscode.commands.executeCommand("git403.openGraph", first);
  s = await waitFor(async (x) => x.selected === first);
  assert.equal(s.selected, first, "열린 패널: 웹뷰가 요청한 커밋을 선택했다");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  s = await waitFor(async (x) => !x.panel);
  assert.equal(s.selected, null);
  const head = sha("HEAD");
  await vscode.commands.executeCommand("git403.openGraph", head);
  s = await waitFor(async (x) => x.selected === head);
  assert.equal(s.selected, head, "새 패널: 준비 뒤 선택이 전달된다");

  await branchClickTests(folder);
  await webviewTests(folder);
  await stashTests(folder);
  await graphViewTests(folder);
  await graphConf.update("graph.location", undefined, vscode.ConfigurationTarget.Global);
}

/** 웹뷰(종류 지정)에 실제 DOM 이벤트를 일으킨다. 요소가 아직 없으면(읽는 중) 기다린다 */
async function simulateOn(target: string, selector: string, text: string, events: string[], after?: string) {
  const end = Date.now() + 45_000;
  while (Date.now() < end) {
    if (await vscode.commands.executeCommand<boolean>("git403.debugSimulate", { selector, text, events, after, target })) return;
    await sleep(500);
  }
  assert.fail(`${target} 웹뷰에서 ${selector} "${text}"를 찾지 못했다`);
}

/**
 * 설정 graph.location = sidebar | panel: 활동 바 맨 위 / 아래 패널 뷰에 compact 그래프가 뜬다(다른 항목이 열려 있어도 `git403.openGraph`가 뷰를 보이게 한다).
 * compact 행 클릭 → 편집기 영역의 "커밋 상세" 탭(상세 + diff, 하나를 재사용), 파일 선택 → 같은 탭에 diff.
 * "전체 화면으로 열기" → 편집기 탭에 전체 앱이 더해진다(선택 유지).
 */
async function graphViewTests(folder: string) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: folder }).toString().trim();
  const first = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: folder }).toString().trim();
  const conf = vscode.workspace.getConfiguration("git403");
  const detailTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith("git403.detail"));
  for (const kind of ["sidebar", "panel"] as const) {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    let s = await waitFor(async (x) => !x.panel && !x.graphKinds.includes("detail"));
    assert.equal(s.panel, false, "편집기 탭 그래프를 닫았다");
    await conf.update("graph.location", kind, vscode.ConfigurationTarget.Global);
    // 다른 활동 바 항목(탐색기)이 열려 있거나 아래 패널이 닫혀 있어도 명령이 그래프 뷰를 보이게 한다 — 처음(뷰 미해결)과 이미 열린 뒤 둘 다
    for (const round of ["처음", "다시"]) {
      await vscode.commands.executeCommand(kind === "sidebar" ? "workbench.view.explorer" : "workbench.action.closePanel");
      if (round === "다시") await waitFor(async (x) => !x.graphVisible.includes(kind));
      await vscode.commands.executeCommand("git403.openGraph", head);
      s = await waitFor(async (x) => x.graphVisible.includes(kind) && x.selected === head && !!x.responses.load_graph?.ok);
      assert.ok(s.graphVisible.includes(kind), `${kind}(${round}): 명령 실행 뒤 그래프 뷰가 보인다`);
    }
    assert.equal(s.panel, false, `${kind}: 편집기 탭은 열리지 않는다`);
    // compact 행 클릭 → 커밋 상세 탭 하나
    await simulateOn(kind, ".commits .row:not(.local-row)", "first", ["mousedown", "click"]);
    s = await waitFor(async (x) => x.graphKinds.includes("detail") && x.selected === first);
    assert.equal(s.selected, first, `${kind}: 상세 탭이 그 커밋을 보인다`);
    assert.equal(detailTabs().length, 1, `${kind}: 커밋 상세 탭은 하나`);
    // 파일 선택 → 같은 탭 안에 diff
    await simulateOn("detail", ".files li[role=option]", "", ["mousedown"], ".diff .dl");
    // 다른 행 클릭 → 탭을 늘리지 않고 내용만 바뀐다
    await simulateOn(kind, ".commits .row:not(.local-row)", "second", ["mousedown", "click"]);
    s = await waitFor(async (x) => !!x.selected && x.selected !== first);
    assert.equal(detailTabs().length, 1, `${kind}: 다른 커밋을 눌러도 탭은 하나`);
    await simulateOn("detail", ".files li[role=option]", "", []); // 새 커밋의 파일 목록
    assert.ok(!s.graphKinds.includes("editor"), "전체 앱 탭은 열리지 않았다");
  }
  // 전체 화면: 마지막(panel) compact에서 클릭한 커밋을 선택한 채 편집기 탭에 전체 앱
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await waitFor(async (x) => !x.graphKinds.includes("detail"));
  await simulateOn("panel", ".commits .row:not(.local-row)", "first", ["mousedown"]);
  await simulateOn("panel", ".search-bar .icon-btn[title]", "", ["click"]);
  const s = await waitFor(async (x) => x.panel && x.selected === first);
  assert.ok(s.panel && s.graphKinds.includes("editor"), "전체 화면: 편집기 탭에 전체 앱이 열린다");
  assert.equal(s.selected, first, "전체 화면: 선택한 커밋이 유지된다");
  await simulateOn("editor", ".toolbar", "", []); // 전체 앱에는 툴바가 있다
}

const gitIn = (folder: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: folder }).toString();

/** 브랜치 항목 클릭 = 그래프에서 그 브랜치 끝 커밋 선택 */
async function branchClickTests(folder: string) {
  gitIn(folder, "branch", "old", "HEAD~1");
  const old = gitIn(folder, "rev-parse", "old").trim();
  const b = await treeUntil("branches", (n) => !!n[0]?.children?.find((x) => x.label === "old"), "새 브랜치가 Branches에 보인다");
  const cmd = b[0].children!.find((x) => x.label === "old")!.command!;
  assert.equal(cmd.command, "git403.openGraph", "브랜치 클릭 명령");
  assert.equal((cmd.arguments![0] as { sha: string }).sha, old);
  await vscode.commands.executeCommand(cmd.command, ...cmd.arguments!);
  const s = await waitFor(async (x) => x.selected === old);
  assert.equal(s.selected, old, "브랜치 끝 커밋이 그래프에서 선택된다");
  // 원격 브랜치도 같다
  const remote = (await treeUntil("branches", (n) => !!n[1]?.children?.length, "원격 그룹"))[1].children![0].command!;
  assert.equal(remote.command, "git403.openGraph");
}

/**
 * 웹뷰 안 상호작용: 테스트 훅 `git403.debugSimulate`가 웹뷰에 실제 DOM 이벤트를 일으키게 하면 UI가 평소 경로로 확장에 openFile을 보내고,
 * 확장은 diff 에디터를 열어 줄로 이동한다(커밋 상세의 파일 더블클릭 → diff 줄 더블클릭).
 */
async function webviewTests(folder: string) {
  const simulate = async (selector: string, text: string, events: string[], after?: string) => {
    const end = Date.now() + 45_000;
    while (Date.now() < end) {
      if (await vscode.commands.executeCommand<boolean>("git403.debugSimulate", { selector, text, events, after })) return;
      await sleep(500); // 요소가 아직 없다(커밋 상세·diff를 읽는 중)
    }
    assert.fail(`웹뷰에서 ${selector} "${text}"를 찾지 못했다`);
  };
  await vscode.commands.executeCommand("git403.openGraph"); // 패널 보이기
  // 메뉴·팝업: 툴바 설정 버튼 → DOM 메뉴가 뜨고, "설정…"을 누르면 설정 창, 브랜치 피커는 목록이 뜬다(웹뷰에서 메뉴 호스트가 빠졌던 회귀)
  const click = ["mousedown", "click"];
  await simulate('.tool-btn[aria-label="Settings"], .tool-btn[aria-label="설정"]', "", click, ".dom-menu");
  await simulate(".dom-menu button", "", click, ".sheet-backdrop");
  await simulate(".branch-pop-wrap .picker", "", click, ".branch-pop li[data-i]");
  await simulate(".branch-pop-backdrop", "", ["mousedown"]);
  // "second"는 스태시 커밋 제목에도 들어 있어 첫 커밋을 고른다(c.txt가 전부 추가 줄)
  await simulate(".commits .row", "first", ["mousedown"]);
  await simulate(".files li[role=option]", "c.txt", ["mousedown", "dblclick"]);
  // 활성 diff 탭의 오른쪽(modified) 에디터
  const modified = () => {
    const i = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return i instanceof vscode.TabInputTextDiff && i.modified.path.endsWith("/c.txt") ? vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === i.modified.toString()) : undefined;
  };
  const end = Date.now() + 30_000;
  while (!modified() && Date.now() < end) await sleep(300);
  assert.ok(modified(), "파일 더블클릭 → diff 에디터");
  // diff 줄 더블클릭 → 새 파일 기준 50번 줄(0부터 49)로 이동
  await simulate(".diff .dl.add", "line 50", ["dblclick"]);
  const until = Date.now() + 30_000;
  while (modified()?.selection.active.line !== 49 && Date.now() < until) await sleep(300);
  const ed = modified()!;
  assert.equal(ed.selection.active.line, 49, "diff 에디터가 더블클릭한 줄로 이동");
  assert.ok(ed.visibleRanges.some((r) => r.start.line <= 49 && r.end.line >= 49), "그 줄이 화면에 보인다");
}

/** 스태시 apply/pop/drop을 실제로 실행: 확인 모달은 테스트 훅으로 대체하고 스태시 목록과 작업 파일 내용을 확인한다 */
async function stashTests(folder: string) {
  const list = () => gitIn(folder, "stash", "list").trim().split("\n").filter(Boolean);
  const read = (f: string) => fs.readFileSync(`${folder}/${f}`, "utf8");
  const node = async (label: string) => {
    const n = await treeUntil("stashes", (x) => x.some((y) => y.label === label), `스태시 "${label}"`);
    return vscode.commands.executeCommand<unknown>("git403.debugNode", "stashes", n.find((y) => y.label === label)!.label);
  };
  assert.deepEqual([list().length, read("a.txt")], [1, "b\n"]);
  try {
    // 취소하면 아무 일도 없다
    await vscode.commands.executeCommand("git403.debugConfirm", false);
    await vscode.commands.executeCommand("git403.stashApply", await node("wip stuff"));
    await sleep(800);
    assert.deepEqual([list().length, read("a.txt")], [1, "b\n"], "확인 취소: 변화 없음");

    // apply: 작업 파일에 적용되고 스태시는 남는다
    await vscode.commands.executeCommand("git403.debugConfirm", true);
    await vscode.commands.executeCommand("git403.stashApply", await node("wip stuff"));
    await waitUntil(() => read("a.txt") === "stashed\n", "apply가 작업 파일을 바꾼다");
    assert.equal(list().length, 1, "apply는 스태시를 남긴다");
    await treeUntil("stashes", (x) => x.length === 1, "apply 뒤 스태시 뷰");

    // pop: 적용하고 목록에서 뺀다
    gitIn(folder, "checkout", "--", "a.txt");
    assert.equal(read("a.txt"), "b\n");
    await vscode.commands.executeCommand("git403.stashPop", await node("wip stuff"));
    await waitUntil(() => read("a.txt") === "stashed\n" && list().length === 0, "pop: 적용 + 목록에서 제거");
    await treeUntil("stashes", (x) => x.length === 0, "pop 뒤 스태시 뷰가 빈다");

    // drop: 새 스태시(저장소 감시 이벤트로 뷰에 나타남)를 버린다. 작업 파일은 그대로
    gitIn(folder, "stash", "push", "-q", "-m", "two", "--", "a.txt");
    assert.equal(read("a.txt"), "b\n");
    const two = await node("two");
    await vscode.commands.executeCommand("git403.stashDrop", two);
    await waitUntil(() => list().length === 0, "drop: 목록에서 제거");
    assert.equal(read("a.txt"), "b\n", "drop은 작업 파일을 건드리지 않는다");
    await treeUntil("stashes", (x) => x.length === 0, "drop 뒤 스태시 뷰가 빈다");
  } finally {
    await vscode.commands.executeCommand("git403.debugConfirm", null);
  }
}

async function waitUntil(ok: () => boolean, what: string) {
  const end = Date.now() + 30_000;
  while (!ok() && Date.now() < end) await sleep(300);
  assert.ok(ok(), what);
}
