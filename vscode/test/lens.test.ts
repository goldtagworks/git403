// CodeLens 집계·경로 검증 단위 테스트 (vscode 불필요): `pnpm test:unit`
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BlameLine } from "../src/services/blame.ts";
import { lensParts, lensScopes, summarize, symbolScopes, type SymbolLike } from "../src/features/editor/lens.ts";
import { safeRel } from "../src/features/views/tree.ts";

const L = (author: string, time: number, sha = "a".repeat(40)): BlameLine => ({ sha, author, time, summary: "s", text: "x" });

test("작성자 수와 최근 수정자: 커밋 안 된 줄은 제외", () => {
  const s = summarize([L("ann", 100), L("bob", 300), L("ann", 200), L("Not Committed Yet", 999, "0".repeat(40))]);
  assert.deepEqual(s, { authors: 2, last: { author: "bob", time: 300 } });
});

test("빈 파일·실패·전부 커밋 안 됨은 렌즈 없음", () => {
  assert.equal(summarize(null), null);
  assert.equal(summarize([]), null);
  assert.equal(summarize([L("x", 1, "0".repeat(40))]), null);
});

test("렌즈 문구 조각: 상대 시간", () => {
  const p = lensParts({ authors: 3, last: { author: "bob", time: 1000 - 7200 } }, 1000, "en");
  assert.deepEqual(p, { n: 3, author: "bob", rel: "2 hours ago" });
  assert.equal(lensParts({ authors: 1, last: { author: "bob", time: 0 } }, 300, "ko").rel, "5분 전");
});

test("웹뷰가 보낸 경로: 저장소 안 상대 경로만", () => {
  assert.equal(safeRel("src/a.ts"), "src/a.ts");
  assert.equal(safeRel("src\\a.ts"), "src/a.ts");
  for (const bad of ["../x", "a/../../x", "/etc/passwd", "C:\\x", "", "a\0b", 3, null]) assert.equal(safeRel(bad), null, String(bad));
});

test("집계는 null(없는 줄·새 줄)을 건너뛴다", () => {
  assert.deepEqual(summarize([L("ann", 100), null, null, L("bob", 50)]), { authors: 2, last: { author: "ann", time: 100 } });
  assert.equal(summarize([null, null]), null);
});

test("심볼 렌즈 범위: 함수·클래스·메서드만, 중첩 포함, 문서 순서", () => {
  const S = (name: string, kind: number, start: number, end: number, children?: SymbolLike[]): SymbolLike => ({ name, kind, start, end, children });
  const syms = [
    S("util", 11, 30, 40),
    S("Foo", 4, 0, 20, [S("ctor", 8, 1, 3), S("bar", 5, 5, 9), S("field", 7, 10, 10), S("Inner", 4, 12, 19, [S("deep", 5, 13, 15)])]),
    S("VERSION", 13, 22, 22),
    S("Shape", 10, 24, 28),
  ];
  assert.deepEqual(symbolScopes(syms).map((s) => [s.name, s.start, s.end]), [["Foo", 0, 20], ["ctor", 1, 3], ["bar", 5, 9], ["Inner", 12, 19], ["deep", 13, 15], ["Shape", 24, 28], ["util", 30, 40]]);
  assert.equal(symbolScopes(syms, 2).length, 2, "상한");
  assert.deepEqual(symbolScopes([]), []);
  assert.deepEqual(symbolScopes([S("bad", 11, 5, 3)]), [], "끝이 시작보다 앞이면 버린다");
});

test("설정 scopes: 기본은 둘 다, 빈 배열은 끔, 모르는 값은 무시", () => {
  assert.deepEqual(lensScopes(undefined), { file: true, symbols: true });
  assert.deepEqual(lensScopes(["file"]), { file: true, symbols: false });
  assert.deepEqual(lensScopes(["symbols", "x"]), { file: false, symbols: true });
  assert.deepEqual(lensScopes([]), { file: false, symbols: false });
  assert.deepEqual(lensScopes("file"), { file: true, symbols: true });
});
