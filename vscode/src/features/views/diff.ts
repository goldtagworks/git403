// git403: 스킴 내용 제공자와 diff 에디터 열기 (사이드바 히스토리 항목·그래프의 "파일 열기"가 같이 쓴다). 새 서버 명령 없이 `git`·`changed_files`만.
import * as path from "node:path";
import * as vscode from "vscode";
import { CONTENT_SCHEME, beforePath, contentUriParts, parseContentUri, showArgs } from "./tree.ts";

type Request = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
const t = vscode.l10n.t;

const uri = (repo: string, ref: string, rel: string) => vscode.Uri.from(contentUriParts({ repo, ref }, rel));

/** `git show <ref>:<path>` 내용을 보여 주는 문서 제공자. 그 커밋에 없던 파일(추가·삭제)은 빈 문서 */
export function registerContent(req: Request): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(CONTENT_SCHEME, {
    async provideTextDocumentContent(u) {
      const c = parseContentUri(u);
      const args = c && showArgs(c.ref, c.rel);
      if (!c || !args) return "";
      try {
        return String(await req("git", { repo: c.repo, args }));
      } catch {
        return "";
      }
    },
  });
}

/**
 * diff의 오른쪽 에디터를 그 줄(1부터)로 옮긴다. 이미 열려 있던 diff는 `vscode.diff`의 옵션이 적용되지 않아 직접 옮긴다
 * (에디터가 보일 때까지 잠깐 기다린다).
 */
let revealToken = 0;
async function reveal(right: vscode.Uri, line?: number) {
  const my = ++revealToken; // 새 reveal이 시작되면 이전 폴링은 멈춘다
  if (!line || !Number.isSafeInteger(line) || line < 1) return;
  for (let i = 0; i < 20 && my === revealToken; i++) {
    const ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === right.toString());
    if (ed) {
      const l = Math.min(line, ed.document.lineCount) - 1;
      const p = new vscode.Position(l, 0);
      ed.selection = new vscode.Selection(p, p);
      ed.revealRange(new vscode.Range(p, p), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

/**
 * sha가 있으면 그 커밋의 변경(`<sha>^` ↔ `<sha>`, 이름 변경은 옛 경로), 없으면 작업 파일과 HEAD의 비교.
 * 파일이 작업 트리에 없으면(삭제) 오른쪽은 빈 문서. `line`(1부터, 새 파일 기준)이 있으면 diff 에디터의 오른쪽을 그 줄로 이동한다.
 */
export async function openFileDiff(req: Request, repo: string, rel: string, sha?: string, line?: number) {
  try {
    const options = line && Number.isSafeInteger(line) && line > 0 ? { selection: new vscode.Range(line - 1, 0, line - 1, 0) } : undefined;
    const name = path.basename(rel);
    if (sha) {
      const files = (await req("changed_files", { repo, commit: sha })) as { status: string; path: string; oldPath?: string | null }[];
      const before = beforePath(files, rel);
      const s = sha.slice(0, 8);
      const right = uri(repo, sha, rel);
      await vscode.commands.executeCommand("vscode.diff", uri(repo, before.added ? "" : `${sha}^`, before.rel), right, `${name} (${s}^ ↔ ${s})`, options);
      await reveal(right, line);
    } else {
      const file = vscode.Uri.file(path.join(repo, rel));
      await vscode.commands.executeCommand("vscode.diff", uri(repo, "HEAD", rel), file, `${name} (HEAD ↔ ${t("Working Tree")})`, options);
      await reveal(file, line);
    }
  } catch (e) {
    void vscode.window.showErrorMessage(t("git403: {0}", e instanceof Error ? e.message : String(e)));
  }
}
