// 저장 전 편집 추적 (vscode 비의존: 단위 테스트 가능). GitLens식 라인 트래커.
// 디스크 기준 blame 결과를 문서 변경 이벤트(contentChanges)로 줄 번호 이동시킨다.
// 현재 줄 → 디스크 줄(없으면 null = 커밋 안 됨). 삽입된 줄은 null, 삭제된 줄은 사라지고 나머지는 원래 줄을 유지한다.
// undo/redo: 편집마다 변경 전 대응(불변 배열 참조)을 undo 스택에 쌓고, undo/redo 이벤트(reason)가 오면 스택에서 되돌려 삭제했던 줄의 원래 대응을 복원한다.
// 복원한 대응의 줄 내용이 디스크와 같은지는 읽는 쪽(blame.ts lineInfo)이 줄 텍스트로 비교해 거른다(어긋나면 "커밋 안 됨"). 줄 수가 안 맞는 스택은 버리고 변경만 따라간다.
// 재입력 매핑: 디스크 줄 텍스트(disk)와 현재 줄 텍스트(cur, 변경 이벤트로 따라감)를 들고 있으면, 편집으로 생긴 "새 줄" 묶음(null 연속 구간)을
// 이웃 대응 사이의 비어 있는 디스크 줄(삭제됐거나 대응이 없는 줄)과 내용으로 비교(LCS)해 같은 줄이면 원래 디스크 줄로 되돌린다(잘라내기→같은 자리 붙여넣기·재입력).
// 정책: 순서를 해치지 않는 이웃 범위 안에서만 — 다른 위치로 옮긴 줄은 새 줄이다. 빈 줄·공백만 있는 줄은 LCS에서 빼고, 이웃 사이 구간이 길이·내용까지 정확히 같을 때만 매핑한다.
// 한 줄 안의 글자 편집은 줄 대응을 바꾸지 않는다 — 내용이 달라진 줄은 호출 측이 디스크 줄 텍스트와 비교해 거른다(되돌리면 자연히 복귀).

export interface Pos {
  line: number;
  character: number;
}
/** vscode `TextDocumentContentChangeEvent`의 필요한 부분 */
export interface Change {
  range: { start: Pos; end: Pos };
  text: string;
}

/** 문서 변경 이유: VS Code `TextDocumentChangeReason.Undo/Redo`를 옮긴 것(없으면 일반 편집) */
export type Reason = "undo" | "redo";
const MAX_HISTORY = 500;
const sameMap = (a: (number | null)[], b: (number | null)[]) => a.length === b.length && a.every((v, i) => v === b[i]);

const MATCH_CELLS = 1_000_000; // 한 구간의 LCS 표 크기 상한(넘으면 앞뒤 일치분만)
const splitLines = (s: string) => s.split(/\r\n|\r|\n/);
const blank = (s: string) => s.trim() === "";

/**
 * 새 줄 구간 cur[a..b)를 디스크 줄 구간 disk[g0..g1)에 내용으로 맞춘다. [현재 줄 인덱스(구간 안), 디스크 줄] 쌍을 순서대로 돌려준다.
 * 앞뒤의 같은 줄을 먼저 떼고 가운데만 LCS(빈 줄은 일치로 치지 않음). 마지막에 앵커 사이 구간이 모두 빈 줄이고 길이·내용이 같으면 짝지운다.
 */
export function matchRun(cur: string[], a: number, b: number, disk: string[], g0: number, g1: number): [number, number][] {
  const pairs: [number, number][] = [];
  let i0 = a, j0 = g0, i1 = b, j1 = g1;
  while (i0 < i1 && j0 < j1 && cur[i0] === disk[j0] && !blank(cur[i0])) pairs.push([i0++, j0++]);
  const tail: [number, number][] = [];
  while (i0 < i1 && j0 < j1 && cur[i1 - 1] === disk[j1 - 1] && !blank(cur[i1 - 1])) tail.push([--i1, --j1]);
  const r = i1 - i0, c = j1 - j0;
  if (r > 0 && c > 0 && r * c <= MATCH_CELLS) {
    const w = c + 1;
    const dp = new Uint32Array((r + 1) * w); // dp[i][j] = cur[i0+i..], disk[j0+j..]의 LCS 길이
    for (let i = r - 1; i >= 0; i--)
      for (let j = c - 1; j >= 0; j--) {
        const x = cur[i0 + i];
        dp[i * w + j] = x === disk[j0 + j] && !blank(x) ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    for (let i = 0, j = 0; i < r && j < c; ) {
      const x = cur[i0 + i];
      if (x === disk[j0 + j] && !blank(x)) pairs.push([i0 + i++, j0 + j++]);
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
      else j++;
    }
  }
  for (let k = tail.length - 1; k >= 0; k--) pairs.push(tail[k]);
  // 빈 줄: 앵커(구간 경계 포함) 사이가 전부 빈 줄이고 길이·내용이 같을 때만
  const out: [number, number][] = [];
  let pi = a, pj = g0;
  const fill = (ni: number, nj: number) => {
    if (ni - pi === nj - pj && ni > pi) {
      let ok = true;
      for (let k = 0; k < ni - pi && ok; k++) ok = blank(cur[pi + k]) && cur[pi + k] === disk[pj + k];
      if (ok) for (let k = 0; k < ni - pi; k++) out.push([pi + k, pj + k]);
    }
  };
  for (const [i, j] of pairs) {
    fill(i, j);
    out.push([i, j]);
    pi = i + 1;
    pj = j + 1;
  }
  fill(b, g1);
  return out;
}

const lineBreaks = (s: string) => s.split(/\r\n|\r|\n/).length - 1;

export class LineTracker {
  /** 현재 줄 번호 → 디스크 줄 번호 (배열은 불변으로 다룬다: 스택이 참조를 공유) */
  private map: (number | null)[];
  /** 편집이 하나도 적용되지 않은(항등) 상태 */
  private identity = true;
  private undoStack: (number | null)[][] = [];
  private redoStack: (number | null)[][] = [];
  /** 디스크 줄 텍스트(없으면 재입력 매핑을 하지 않는다) */
  private disk: string[] | null;
  /** 현재 줄 텍스트: 변경 이벤트로 따라간다(디스크 텍스트가 있을 때만) */
  private cur: string[] | null;

  /** `lines`: 문서가 디스크와 같을 때의 줄 텍스트(재입력 매핑용, 생략 가능) */
  constructor(lineCount: number, lines?: string[]) {
    this.map = Array.from({ length: Math.max(lineCount, 0) }, (_, i) => i);
    this.disk = lines && lines.length === lineCount ? lines : null;
    this.cur = this.disk;
  }

  /** 문서가 디스크와 같아졌을 때(저장·되돌리기) 처음 상태로. 이미 항등이면 아무것도 하지 않는다 */
  reset(lineCount: number, lines?: string[]) {
    this.undoStack = [];
    this.redoStack = [];
    this.disk = lines && lines.length === lineCount ? lines : null;
    this.cur = this.disk;
    if (this.identity && this.map.length === lineCount) return;
    this.map = Array.from({ length: Math.max(lineCount, 0) }, (_, i) => i);
    this.identity = true;
  }

  get lineCount() {
    return this.map.length;
  }

  /** 편집이 적용된 상태 */
  get dirty() {
    return !this.identity;
  }

  /**
   * 한 이벤트의 변경들을 적용한다. 범위는 모두 변경 전 문서 기준이므로 뒤쪽(위치가 큰 것)부터 적용한다
   * (이벤트 안의 순서와 무관). `reason`이 undo/redo면 스택에 쌓아 둔 이전 대응을 복원한다(줄 수가 맞을 때).
   */
  apply(changes: readonly Change[], reason?: Reason) {
    if (!changes.length) return;
    this.identity = false;
    const before = this.map;
    this.map = before.slice();
    const sorted = [...changes].sort((a, b) => b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character);
    const touched: [number, number][] = []; // 최종 좌표의 건드린 줄 범위
    for (const c of sorted) {
      const grow = lineBreaks(c.text) - (Math.max(c.range.end.line, c.range.start.line) - c.range.start.line);
      for (const t of touched) (t[0] += grow), (t[1] += grow); // 뒤쪽 변경이 먼저 적용되므로 이미 적은 범위는 아래 줄 수 변화만큼 밀린다
      touched.push([c.range.start.line, c.range.start.line + lineBreaks(c.text)]);
      this.one(c);
      this.text(c);
    }
    if (!reason) this.rematch(touched);
    if (sameMap(before, this.map)) this.map = before; // 글자 편집: 참조 유지
    const [from, to] = reason === "redo" ? [this.redoStack, this.undoStack] : [this.undoStack, this.redoStack];
    if (!reason) {
      this.push(this.undoStack, before);
      this.redoStack = [];
      return;
    }
    const cand = from.pop();
    this.push(to, before);
    if (cand && cand.length === this.map.length) this.map = cand;
    else (this.undoStack = []), (this.redoStack = []), this.rematch(touched); // 어긋난 스택은 믿지 않는다
  }

  /** 현재 줄 텍스트 따라가기. 길이가 맞지 않게 되면(이벤트를 놓침) 재입력 매핑을 끈다 */
  private text({ range: { start, end }, text }: Change) {
    const cur = this.cur;
    if (!cur) return;
    const sl = start.line, el = Math.max(end.line, start.line);
    if (sl >= cur.length || el >= cur.length) return void (this.cur = null);
    const mid = splitLines(cur[sl].slice(0, start.character) + text + (end.line >= start.line ? cur[el].slice(end.character) : ""));
    this.cur = cur.slice(0, sl).concat(mid, cur.slice(el + 1)); // 불변(`replaceAll` 등이 참조를 공유)
  }

  /**
   * 건드린 줄이 속한 새 줄(null) 구간을 이웃 대응 사이의 비어 있는 디스크 줄과 내용으로 맞춘다.
   * 구간은 편집당 한 번씩만, 비용은 구간 길이 × 이웃 사이 디스크 줄 수(상한 `MATCH_CELLS`).
   */
  private rematch(touched: [number, number][]) {
    const { map, cur, disk } = this;
    if (!cur || !disk || cur.length !== map.length) return;
    const done = new Set<number>();
    for (const [t0, t1] of touched) {
      for (let i = Math.max(t0 - 1, 0); i <= Math.min(t1 + 1, map.length - 1); i++) {
        if (map[i] !== null || done.has(i)) continue;
        let a = i, b = i + 1;
        while (a > 0 && map[a - 1] === null) a--;
        while (b < map.length && map[b] === null) b++;
        for (let k = a; k < b; k++) done.add(k);
        i = b - 1;
        const p = a > 0 ? (map[a - 1] as number) : -1, n = b < map.length ? (map[b] as number) : disk.length;
        if (n - p <= 1) continue;
        for (const [ci, dj] of matchRun(cur, a, b, disk, p + 1, n)) map[ci] = dj;
      }
    }
  }

  /** 문서 전체를 바꾸는 편집(전체 붙여넣기·다시 읽기): 대응을 새로 시작하되 undo로 되돌릴 수 있게 이전 대응은 스택에 둔다 */
  replaceAll(lineCount: number, lines?: string[]) {
    this.cur = this.disk && lines && lines.length === lineCount ? lines : null;
    this.push(this.undoStack, this.map);
    this.redoStack = [];
    this.map = Array.from({ length: Math.max(lineCount, 0) }, (_, i) => i); // 내용 비교가 어긋난 줄을 거른다
    this.identity = true;
  }

  private push(stack: (number | null)[][], m: (number | null)[]) {
    stack.push(m);
    if (stack.length > MAX_HISTORY) stack.shift();
  }

  private one({ range: { start, end }, text }: Change) {
    const sl = start.line, el = Math.max(end.line, start.line);
    const m = lineBreaks(text);
    const at = (i: number) => this.map[i] ?? null;
    let next: (number | null)[];
    if (m === 0) {
      // 줄 안 편집, 또는 여러 줄을 한 줄로 합침: 앞쪽 글자가 남으면 첫 줄, 아니면 남은 뒷부분이 있는 마지막 줄의 것
      next = [start.character > 0 ? at(sl) : at(el)];
    } else {
      // 줄 나눔: 앞쪽 글자가 남으면 첫 줄이 이어받고, 줄 시작에서 나눴다면 뒷부분(마지막 줄)이 이어받는다
      next = [start.character > 0 ? at(sl) : null, ...Array(m - 1).fill(null), start.character === 0 ? at(el) : null];
    }
    // 줄이 모자란 문서 끝에 쓰는 경우를 위해 빈 칸을 채운다
    while (this.map.length < sl) this.map.push(null);
    this.map.splice(sl, el - sl + 1, ...next);
  }

  /** 현재 줄 → 디스크 줄(0부터). 새로 생긴 줄·범위 밖이면 null */
  diskLine(line: number): number | null {
    return this.map[line] ?? null;
  }

  /** 현재 줄 범위(양끝 포함) → 디스크 줄 범위. 디스크에 있던 줄이 하나도 없으면 null */
  diskRange(start: number, end: number): { start: number; end: number } | null {
    let a: number | null = null, b: number | null = null;
    for (let i = start; i <= end; i++) {
      const d = this.diskLine(i);
      if (d === null) continue;
      a = a === null ? d : Math.min(a, d);
      b = b === null ? d : Math.max(b, d);
    }
    return a === null || b === null ? null : { start: a, end: b };
  }
}

/** 문서별 트래커 모음. 키는 문서 주소 */
export class Trackers {
  private map = new Map<string, LineTracker>();

  /** 없으면 만든다(문서가 디스크와 같다고 가정: 열 때 상태). 줄 수가 어긋나 있으면(이벤트를 놓친 경우) 새로 시작한다 */
  get(key: string, lineCount: number, lines?: () => string[]): LineTracker {
    let t = this.map.get(key);
    if (!t) this.map.set(key, (t = new LineTracker(lineCount, lines?.())));
    else if (t.lineCount !== lineCount && !t.dirty) t.reset(lineCount, lines?.());
    return t;
  }

  /**
   * 변경 이벤트. 변경이 있으면 따라간다(같은 이벤트의 `dirty`는 아직 갱신 전일 수 있어 믿지 않는다).
   * 변경 없이 깨끗해졌다는 알림(저장·되돌리기·모두 undo 뒤 상태 알림)이면 처음 상태로 돌린다.
   * `lines`: 현재 문서의 줄 텍스트(지연 계산) — 디스크와 같아질 때·전체 교체 때만 읽는다(재입력 매핑용, 생략 가능).
   */
  change(key: string, lineCount: number, dirty: boolean, changes: readonly Change[], reason?: Reason, lines?: () => string[]) {
    if (!changes.length) return void (dirty ? undefined : this.reset(key, lineCount, lines?.()));
    const t = this.get(key, lineCount - changes.reduce((n, c) => n + lineBreaks(c.text) - (c.range.end.line - c.range.start.line), 0));
    // 문서 전체를 바꾸는 변경(다시 읽기·전체 선택 붙여넣기)은 대응을 새로 시작한다(내용 비교가 줄을 거른다)
    const whole = changes.some((c) => c.range.start.line === 0 && c.range.start.character === 0 && c.range.end.line >= 1 && c.range.end.line >= t.lineCount - 1);
    // (전체 교체의 undo/redo는 스택으로 복원하므로 reason이 있으면 apply)
    if (whole && !reason) t.replaceAll(lineCount, lines?.());
    else t.apply(changes, reason);
  }

  /** 읽기용: 줄 수가 문서와 어긋난 트래커(이벤트를 놓침)는 항등으로 새로 시작한다 */
  sync(key: string, lineCount: number): LineTracker {
    const t = this.get(key, lineCount);
    if (t.lineCount !== lineCount) t.reset(lineCount);
    return t;
  }

  reset(key: string, lineCount: number, lines?: string[]) {
    this.map.get(key)?.reset(lineCount, lines);
  }

  delete(key: string) {
    this.map.delete(key);
  }

  get size() {
    return this.map.size;
  }
}
