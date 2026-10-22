// diff 문맥 펼치기(25f)의 순수 로직 (DOM·React 비의존): hunk 헤더로 숨은 구간(gap)을 계산하고, 파일 텍스트를 줄로 나눈다.
import { Fragment, createElement, type ReactNode } from "react";

/** hunk 헤더 `@@ -o,oc +n,nc @@`의 숫자 (생략된 개수는 1) */
export interface Span { o: number; oc: number; n: number; nc: number }
export function parseHeader(header: string): Span | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  return m ? { o: +m[1], oc: m[2] === undefined ? 1 : +m[2], n: +m[3], nc: m[4] === undefined ? 1 : +m[4] } : null;
}

/** 두 hunk 사이(또는 앞·뒤)의 숨은 줄: 새 파일 기준 첫 줄 `n`부터 `size`줄. 옛 줄 번호는 새 번호 - `d`. size null = 파일 길이를 아직 모름(맨 끝) */
export interface Gap { n: number; d: number; size: number | null }
export const STEP = 20;

/** 개수 0인 쪽의 시작 번호는 "그 줄 다음"이라 한 칸 민다 */
const first = (s: number, c: number) => (c === 0 ? s + 1 : s);
const last = (s: number, c: number) => (c === 0 ? s : s + c - 1);

/** hunk마다 앞 gap 하나 + 마지막 hunk 뒤 gap 하나 (길이 spans+1). total은 새 파일의 줄 수(모르면 null) */
export function gapsOf(spans: Span[], total: number | null): Gap[] {
  const out: Gap[] = [];
  spans.forEach((s, i) => {
    const start = i ? last(spans[i - 1].n, spans[i - 1].nc) + 1 : 1;
    const end = first(s.n, s.nc) - 1;
    out.push({ n: start, d: first(s.n, s.nc) - first(s.o, s.oc), size: Math.max(0, end - start + 1) });
  });
  const l = spans[spans.length - 1];
  if (l) {
    const start = last(l.n, l.nc) + 1;
    out.push({ n: start, d: last(l.n, l.nc) - last(l.o, l.oc), size: total === null ? null : Math.max(0, total - start + 1) });
  }
  return out;
}

/** 파일 텍스트 → 줄 (끝의 개행 하나는 줄이 아님, CR 제거). 바이너리(NUL 포함)는 null */
export function splitText(text: string): string[] | null {
  if (text.includes("\0")) return null;
  const ls = text.split("\n");
  if (ls[ls.length - 1] === "") ls.pop();
  return ls.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** 이 이상이면 읽지 않는다 (base64 글자 수 기준 20MB) */
export const MAX_B64 = Math.ceil((20 * 1024 * 1024 * 4) / 3);

/** base64 → UTF-8 텍스트 → 줄. 너무 크거나 바이너리면 null (20MB 상한: 그 이상은 메모리·분할 비용이 커서 펼치지 않는다) */
export function decodeLines(b64: string | null): string[] | null {
  if (b64 == null || b64.length > MAX_B64) return null;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return splitText(new TextDecoder().decode(bytes));
}

/** 펼침 상태: [위쪽(앞 hunk 쪽)에서 편 줄, 아래쪽(다음 hunk 쪽)에서 편 줄] */
export type Exp = [number, number];
/** gap의 화면 구성: 위에서 top줄, 아래에서 bot줄을 보이고 나머지(hidden)는 접힌 행 하나. all이면 전부 */
export function shownOf(size: number, e: Exp | undefined, all: boolean) {
  const top = all ? size : Math.min(e?.[0] ?? 0, size);
  const bot = all ? 0 : Math.min(e?.[1] ?? 0, size - top);
  return { top, bot, hidden: size - top - bot };
}

/** 공백 표시: 같은 종류의 연속 공백·탭은 span 하나로 묶는다(공백→·, 탭→→). 글자는 그대로 두고 CSS ::before로 덧그려 복사해도 원문 */
export function visWs(s: string): ReactNode {
  if (!/[ \t]/.test(s)) return s;
  const out: ReactNode[] = [];
  let k = 0;
  for (const part of s.split(/( +|\t+)/)) {
    if (!part) continue;
    out.push(part[0] === " " ? createElement("span", { key: k++, className: "ws-c", "data-c": "·".repeat(part.length) }, part)
      : part[0] === "\t" ? createElement("span", { key: k++, className: "ws-c", "data-c": Array(part.length).fill("→").join("\t") }, part) : part);
  }
  return createElement(Fragment, null, ...out);
}
