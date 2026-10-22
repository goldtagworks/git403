// 줄 끝 blame·호버의 순수 로직 (vscode 비의존: 단위 테스트 가능).
// 데이터는 서버의 기존 명령(`blame`, `file_diff`, `git show`)에서 온다 — docs/reuse.md "서버 프로토콜".
import * as path from "node:path";
import { repoKey } from "./repos.ts";

export type BlameLine = { sha: string; author: string; time: number; summary: string; text: string };
export type Commit = { sha: string; author: string; email: string; time: number; message: string };
/** 한 줄의 blame 결과: 커밋이 있으면 그 줄, 커밋 안 된 줄이면 "uncommitted" */
export type LineInfo = BlameLine | "uncommitted" | null;

const isZero = (sha: string) => /^0+$/.test(sha);
const eol = (s: string) => s.replace(/\r$/, "");

/**
 * `lineNo`(0부터) 줄의 blame. blame은 디스크의 파일 기준이라, 저장 안 된 편집(`dirty`)은 트래커(`diskLine`: 현재 줄 → 디스크 줄,
 * tracker.ts)로 줄 번호를 옮겨 찾고, 옮긴 줄의 내용이 디스크와 다르면(그 줄을 고친 경우) "커밋 안 됨"으로 본다.
 * `diskLine`이 없으면 줄 번호 그대로(항등).
 */
export function lineInfo(lines: BlameLine[] | null, lineNo: number, doc: { dirty: boolean; textAt: (n: number) => string; diskLine?: (n: number) => number | null }): LineInfo {
  const d = doc.dirty && doc.diskLine ? doc.diskLine(lineNo) : lineNo;
  if (d === null) return lines ? "uncommitted" : null;
  const l = lines?.[d];
  if (!lines || !l) return doc.dirty && lines ? "uncommitted" : null;
  if (doc.dirty && eol(doc.textAt(lineNo)) !== eol(l.text)) return "uncommitted";
  return isZero(l.sha) ? "uncommitted" : l;
}

/** 문서의 현재 줄마다 blame(커밋 안 된 줄·없는 줄은 null). CodeLens 집계용 */
export function currentLines(lines: BlameLine[] | null, doc: { lineCount: number; dirty: boolean; textAt: (n: number) => string; diskLine?: (n: number) => number | null }): (BlameLine | null)[] {
  const out: (BlameLine | null)[] = [];
  for (let i = 0; i < doc.lineCount; i++) {
    const info = lineInfo(lines, i, doc);
    out.push(info && info !== "uncommitted" ? info : null);
  }
  return out;
}

/** "5 minutes ago" 같은 상대 시간 (로케일은 Intl) */
export function relativeTime(nowSec: number, ts: number, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const d = ts - nowSec; // 음수 = 과거
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [unit, sec] of steps) if (Math.abs(d) >= sec) return rtf.format(Math.trunc(d / sec), unit);
  return rtf.format(Math.trunc(d), "second");
}

export const inlineText = (l: BlameLine, nowSec: number, locale: string) => `${l.author}, ${relativeTime(nowSec, l.time, locale)} • ${l.summary}`;

/** 파일이 속한 저장소 루트: 파일에서 위로 올라가며 작업 영역 폴더 안에서 `.git`을 찾는다 */
export function findRepo(file: string, roots: string[], exists: (p: string) => boolean): { repo: string; rel: string } | null {
  const root = roots.filter((r) => file === r || file.startsWith(r + path.sep)).sort((a, b) => b.length - a.length)[0];
  if (!root) return null;
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (exists(path.join(dir, ".git"))) return { repo: dir, rel: path.relative(dir, file).split(path.sep).join("/") };
    if (dir === root || dir === path.dirname(dir)) return null;
  }
}

/** 파일별 blame 캐시. 같은 파일의 동시 요청은 하나로 합치고, 실패는 null로 두었다가 무효화되면 다시 시도한다 */
export class BlameCache {
  private map = new Map<string, Promise<BlameLine[] | null>>();
  private fetch: (repo: string, rel: string) => Promise<BlameLine[]>;
  constructor(fetch: (repo: string, rel: string) => Promise<BlameLine[]>) {
    this.fetch = fetch;
  }
  get(repo: string, rel: string): Promise<BlameLine[] | null> {
    const k = `${repo}\0${rel}`;
    let p = this.map.get(k);
    if (!p) this.map.set(k, (p = this.fetch(repo, rel).catch(() => null)));
    return p;
  }
  /** rel 없으면 그 저장소 전체 */
  invalidate(repo: string, rel?: string) {
    for (const k of [...this.map.keys()]) if (rel === undefined ? k.startsWith(repo + "\0") : k === `${repo}\0${rel}`) this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
  get size() {
    return this.map.size;
  }
}

/**
 * 저장소별 Promise 캐시(호버의 커밋·diff): 키에 저장소를 포함(정규화), 크기 상한(LRU), 실패한 Promise는 바로 버려 다음에 다시 시도,
 * `invalidate(repo)`로 그 저장소 항목만 삭제(`repo` 없으면 전부)
 */
export class PromiseLru<V> {
  private map = new Map<string, { repo: string; p: Promise<V> }>();
  private max: number;
  constructor(max = 200) {
    this.max = max;
  }
  get(repo: string, key: string, make: () => Promise<V>): Promise<V> {
    const r = repoKey(repo), k = `${r}\0${key}`;
    const hit = this.map.get(k);
    if (hit) return (this.map.delete(k), this.map.set(k, hit), hit.p); // 최근 사용으로 이동
    const p = make();
    const e = { repo: r, p };
    this.map.set(k, e);
    p.catch(() => this.map.get(k) === e && this.map.delete(k));
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
    return p;
  }
  invalidate(repo?: string) {
    if (repo === undefined) return this.map.clear();
    const r = repoKey(repo);
    for (const [k, e] of [...this.map]) if (e.repo === r) this.map.delete(k);
  }
  get size() {
    return this.map.size;
  }
}

/** `git show -s --format=%H%x1f%an%x1f%ae%x1f%at%x1f%B` 출력 → Commit */
export function parseCommit(out: string): Commit {
  const [sha, author, email, at, ...msg] = out.split("\x1f");
  return { sha, author, email, time: Number(at) || 0, message: msg.join("\x1f").trim() };
}
export const COMMIT_FORMAT = "%H%x1f%an%x1f%ae%x1f%at%x1f%B";

/** diff에서 줄 내용(`text`)을 추가한 hunk(없으면 첫 hunk). 길면 자른다 */
export function pickHunk(diff: string, text: string, maxLines = 24): string | null {
  const hunks: string[][] = [];
  for (const l of diff.split("\n")) {
    if (l.startsWith("@@")) hunks.push([l]);
    else if (hunks.length) hunks[hunks.length - 1].push(l);
  }
  if (!hunks.length) return null;
  const want = eol(text).trimEnd();
  const h = hunks.find((x) => x.some((l) => /^\++/.test(l) && !l.startsWith("+++") && l.replace(/^\++/, "").trimEnd() === want)) ?? hunks[0];
  while (h.length && h[h.length - 1] === "") h.pop();
  return (h.length > maxLines ? [...h.slice(0, maxLines), "…"] : h).join("\n");
}

const esc = (s: string) => s.replace(/[\\`*_{}[\]()#+\-!|<>~&]/g, "\\$&");

/** 코드 펜스: 내용 안의 가장 긴 백틱·물결표 열보다 길게(최소 3) 해 내용이 펜스를 닫지 못하게 한다 */
export function fenced(body: string, lang = ""): string {
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${body}\n${fence}`;
}

export interface HoverData {
  commit: Commit;
  date: string;
  rel: string;
  hunk: string | null;
  links: { graph: string; copy: string };
  labels: { graph: string; copy: string };
}

/** 호버 마크다운: 짧은 SHA · 작성자·이메일·날짜 · 전체 메시지 · hunk(코드블록 diff) · 명령 링크 */
export function hoverMarkdown(d: HoverData): string {
  const c = d.commit;
  const parts = [
    `**\`${c.sha.slice(0, 8)}\`** ${esc(c.author)} &lt;${esc(c.email)}&gt;, ${esc(d.date)} (${esc(d.rel)})`,
    esc(c.message).replace(/\n/g, "  \n"),
  ];
  if (d.hunk) parts.push(fenced(d.hunk, "diff"));
  parts.push(`[${d.labels.graph}](${d.links.graph}) | [${d.labels.copy}](${d.links.copy})`);
  return parts.join("\n\n---\n\n");
}

export const commandUri = (cmd: string, ...args: unknown[]) => `command:${cmd}?${encodeURIComponent(JSON.stringify(args))}`;
