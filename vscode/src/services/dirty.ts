// 저장 전 편집 추적의 vscode 연결: 문서 변경 이벤트를 라인 트래커(tracker.ts)에 먹이고, 편집기·히스토리가 같이 쓴다.
import * as vscode from "vscode";
import { Trackers, type LineTracker } from "./tracker.ts";

const key = (d: vscode.TextDocument) => d.uri.toString();
const textLines = (d: vscode.TextDocument) => d.getText().split(/\r\n|\r|\n/);
const tracked = (d: vscode.TextDocument) => d.uri.scheme === "file";

export class Dirty implements vscode.Disposable {
  private trackers = new Trackers();
  private subs: vscode.Disposable[];

  constructor() {
    const ws = vscode.workspace;
    for (const d of ws.textDocuments) this.open(d);
    this.subs = [
      ws.onDidOpenTextDocument((d) => this.open(d)),
      // 변경이 있으면 따라가고(이 이벤트의 isDirty는 아직 갱신 전일 수 있다), 변경 없이 깨끗해졌다는 알림(저장·되돌리기·모두 undo)이면 처음 상태로
      ws.onDidChangeTextDocument((e) => tracked(e.document) && this.trackers.change(key(e.document), e.document.lineCount, e.document.isDirty, e.contentChanges, e.reason === vscode.TextDocumentChangeReason.Undo ? "undo" : e.reason === vscode.TextDocumentChangeReason.Redo ? "redo" : undefined, () => textLines(e.document))),
      ws.onDidSaveTextDocument((d) => tracked(d) && this.trackers.reset(key(d), d.lineCount, textLines(d))),
      ws.onDidCloseTextDocument((d) => this.trackers.delete(key(d))),
    ];
  }

  private open(d: vscode.TextDocument) {
    if (tracked(d)) this.trackers.get(key(d), d.lineCount, d.isDirty ? undefined : () => textLines(d)); // 이미 고친 문서는 디스크 텍스트를 모른다
  }

  tracker(d: vscode.TextDocument): LineTracker {
    return this.trackers.sync(key(d), d.lineCount);
  }

  /** blame·렌즈 계산에 넘기는 문서 모양 */
  view(d: vscode.TextDocument) {
    const t = d.isDirty ? this.tracker(d) : null;
    return { lineCount: d.lineCount, dirty: d.isDirty, textAt: (n: number) => d.lineAt(n).text, diskLine: t ? (n: number) => t.diskLine(n) : undefined };
  }

  dispose() {
    for (const s of this.subs) s.dispose();
  }
}
