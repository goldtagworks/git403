// 화면 확인용 스위트(GIT403_SUITE=shots, macOS 전용): 테마 3종(다크·라이트·고대비)마다 사이드바 뷰 + 편집기 + 그래프 탭을 열고
// 이 VS Code 창만 `screencapture -l<창 id>`로 찍는다. 키보드·마우스 입력은 보내지 않는다(다른 앱에 입력이 새지 않게).
// 창 id는 CGWindowList(JXA)에서 VS Code 메인 프로세스(= 확장 호스트의 부모) 소유 창 중 가장 큰 것.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const out = process.env.GIT403_SHOTS_DIR!;

const JXA = `ObjC.import('CoreGraphics');
function run(argv) {
  const pid = Number(argv[0]);
  const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0)));
  const mine = list.filter((w) => w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === 0);
  mine.sort((a, b) => b.kCGWindowBounds.Width * b.kCGWindowBounds.Height - a.kCGWindowBounds.Width * a.kCGWindowBounds.Height);
  return mine.length ? String(mine[0].kCGWindowNumber) : "";
}`;

function shot(name: string) {
  const id = execFileSync("osascript", ["-l", "JavaScript", "-e", JXA, String(process.ppid)], { encoding: "utf8" }).trim();
  if (!id) throw new Error("VS Code 창을 찾지 못했다");
  execFileSync("screencapture", ["-x", "-o", `-l${id}`, path.join(out, `${name}.png`)]);
}

async function graphLoaded() {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    const s = await vscode.commands.executeCommand<{ responses: Record<string, { ok: boolean }> }>("git403.debugState");
    if (Object.entries(s.responses).some(([k, v]) => k.startsWith("load_graph") && v.ok)) return;
    await sleep(300);
  }
}

export async function run() {
  fs.mkdirSync(out, { recursive: true });
  const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const cfg = vscode.workspace.getConfiguration();
  for (const [name, theme] of [["dark", "Default Dark Modern"], ["light", "Default Light Modern"], ["hc", "Default High Contrast"]]) {
    await cfg.update("workbench.colorTheme", theme, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("workbench.view.extension.git403");
    const ed = await vscode.window.showTextDocument(vscode.Uri.file(`${folder}/b.txt`));
    ed.selection = new vscode.Selection(1, 0, 1, 0);
    await sleep(2500);
    shot(`vscode-views-${name}`);
    await vscode.commands.executeCommand("git403.openGraph");
    await graphLoaded();
    await sleep(2500);
    shot(`vscode-graph-${name}`);
  }
}
