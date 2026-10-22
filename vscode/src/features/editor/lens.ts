// CodeLens 요약의 순수 로직 (vscode 비의존: 단위 테스트 가능). 데이터는 blame 캐시(`blame` 명령)에서 온다.
import { relativeTime, type BlameLine } from "../../services/blame.ts";

export interface FileSummary {
  /** 커밋된 줄을 쓴 서로 다른 작성자 수 */
  authors: number;
  /** 가장 최근에 바꾼 커밋의 작성자·시각(초) */
  last: { author: string; time: number };
}

/** 파일 blame → 작성자 수와 최근 수정자. 커밋 안 된 줄(0 SHA)은 빼고, 커밋된 줄이 하나도 없으면 null */
export function summarize(lines: readonly (BlameLine | null)[] | null): FileSummary | null {
  const authors = new Set<string>();
  let last: FileSummary["last"] | null = null;
  for (const l of lines ?? []) {
    if (!l || /^0+$/.test(l.sha)) continue;
    authors.add(l.author);
    if (!last || l.time > last.time) last = { author: l.author, time: l.time };
  }
  return last ? { authors: authors.size, last } : null;
}

/** 렌즈 문구 조각: 번역은 호출 측(`l10n.t`)이 고르고, 상대 시간만 여기서 만든다 */
export const lensParts = (s: FileSummary, nowSec: number, locale: string) => ({ n: s.authors, author: s.last.author, rel: relativeTime(nowSec, s.last.time, locale) });

/** DocumentSymbol/SymbolInformation을 줄 범위로 줄인 모양(vscode 비의존). line은 0부터, 양끝 포함 */
export interface SymbolLike {
  name: string;
  kind: number;
  start: number;
  end: number;
  children?: SymbolLike[];
}

/** vscode.SymbolKind 번호: 렌즈를 다는 종류(클래스·메서드·생성자·열거형·인터페이스·함수·구조체) */
export const LENS_KINDS = new Set([4, 5, 8, 9, 10, 11, 22]);
export const MAX_SYMBOL_LENSES = 200;

/** 심볼 트리 → 렌즈를 달 범위(문서 순서, 중첩 포함). 개수 상한이 있다 */
export function symbolScopes(symbols: readonly SymbolLike[], max = MAX_SYMBOL_LENSES): { name: string; start: number; end: number }[] {
  const out: { name: string; start: number; end: number }[] = [];
  const walk = (list: readonly SymbolLike[]) => {
    for (const s of list) {
      if (LENS_KINDS.has(s.kind) && s.end >= s.start) out.push({ name: s.name, start: s.start, end: s.end });
      if (s.children?.length) walk(s.children);
    }
  };
  walk(symbols);
  return out.sort((a, b) => a.start - b.start || b.end - a.end).slice(0, max);
}

/** 설정 `git403.codeLens.scopes`: 알 수 없는 값은 버린다. 배열이 아니면 기본(둘 다) */
export function lensScopes(v: unknown): { file: boolean; symbols: boolean } {
  const a = Array.isArray(v) ? v : ["file", "symbols"];
  return { file: a.includes("file"), symbols: a.includes("symbols") };
}
