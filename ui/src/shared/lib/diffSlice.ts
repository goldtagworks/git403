// 통합 diff 한 파일에서 "새 파일의 이 줄 둘레"만 잘라 낸다 (AI 리뷰 코멘트 카드의 작은 코드 조각용, 읽기 전용).
export interface SliceRow { t: " " | "+" | "-"; n: number | null; text: string; hit: boolean }

/** line..endLine(새 파일 기준) 둘레 ±ctx행. 삭제 줄은 번호 없이 끼어 들어간다. 그 줄이 diff에 없으면 null.
 *  둘레는 같은 hunk 안에서만 잡는다(hunk를 넘으면 줄 번호가 건너뛰어 붙은 코드처럼 보인다) */
export function sliceDiff(diff: string, line: number, endLine: number | null, ctx = 3): SliceRow[] | null {
  const rows: SliceRow[] = [];
  const hunk: number[] = []; // rows[i]가 속한 hunk 번호
  let n = 0;
  let h = -1;
  let inHunk = false;
  for (const l of diff.split("\n")) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (m) {
      n = Number(m[1]);
      inHunk = true;
      h++;
      continue;
    }
    if (!inHunk || l.startsWith("\\")) continue;
    const c = l[0];
    if (c === " " || c === "+" || c === "-") hunk[rows.length] = h;
    if (c === " ") rows.push({ t: " ", n: n++, text: l.slice(1), hit: false });
    else if (c === "+") rows.push({ t: "+", n: n++, text: l.slice(1), hit: false });
    else if (c === "-") rows.push({ t: "-", n: null, text: l.slice(1), hit: false });
  }
  const last = endLine ?? line;
  const a = rows.findIndex((r) => r.n === line);
  if (a < 0) return null;
  const b = rows.findIndex((r) => r.n === last);
  const e = b < 0 ? a : b;
  let from = Math.max(0, a - ctx);
  let to = Math.min(rows.length - 1, e + ctx);
  while (hunk[from] !== hunk[a]) from++;
  while (hunk[to] !== hunk[e]) to--;
  return rows.slice(from, to + 1).map((r) => ({ ...r, hit: r.n !== null && r.n >= line && r.n <= last }));
}

/** 이전 head의 코멘트 줄이 새 head에서 어디로 갔고(밀림) 그 줄이 바뀌었는지. `git diff -U0 <이전 head> <새 head> -- <파일>` 출력을 읽는다
 *  (새 커밋만 다시 리뷰). 파일이 안 바뀌었으면(빈 출력) 그대로. 바뀐 hunk 안의 줄은 그 hunk 새 쪽 같은 위치로 옮기고,
 *  순수 삭제 hunk 안의 줄은 새 파일의 직전 줄로 근사한다(`+c,0`의 c). 끝줄이 시작줄 이하로 접히면(삭제·축소) 한 줄(endLine = null)로 둔다 */
export function shiftLines(diff0: string, line: number, endLine: number | null): { line: number; endLine: number | null; changed: boolean } {
  const hs = [...diff0.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => ({ a: +m[1], b: m[2] === undefined ? 1 : +m[2], c: +m[3], d: m[4] === undefined ? 1 : +m[4] }));
  const last = endLine ?? line;
  const map = (x: number) => {
    let delta = 0;
    for (const h of hs) {
      if (h.b === 0 ? h.a < x : h.a + h.b - 1 < x) delta += h.d - h.b; // 이 줄 앞의 hunk: 줄 수만큼 밀림
      else if (h.b > 0 && h.a <= x) return h.c + Math.min(x - h.a, Math.max(h.d - 1, 0)); // 바뀐 hunk 안
      else break;
    }
    return x + delta;
  };
  const changed = hs.some((h) => (h.b > 0 ? h.a <= last && h.a + h.b - 1 >= line : h.a >= line && h.a < last));
  const to = Math.max(map(line), 1);
  const end = endLine === null ? null : map(endLine);
  return { line: to, endLine: end !== null && end > to ? end : null, changed };
}
