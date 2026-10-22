// package.json contributes 점검: when 절 우선순위·명령 메타·nls 키 일관성
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const read = (f: string) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"));
const pkg = read("package.json");
const c = pkg.contributes;

test("view/item/context의 || 는 괄호 안에만 있다 (다른 뷰로 새지 않게)", () => {
  for (const m of c.menus["view/item/context"]) {
    assert.match(m.when, /^view =~ /, `${m.command}: 뷰 조건으로 시작`);
    if (m.when.includes("||")) assert.match(m.when, /&& \(.*\|\|.*\)$/, `${m.command}: || 는 괄호로 묶는다 — ${m.when}`);
  }
});

test("모든 명령에 카테고리(git403), 제목은 접두어 없이 nls", () => {
  const nls = read("package.nls.json");
  for (const x of c.commands) {
    assert.equal(x.category, "git403", x.command);
    assert.match(x.title, /^%.+%$/);
    assert.ok(!/^git403:/.test(nls[x.title.slice(1, -1)]), `${x.command}: 제목에 "git403:" 접두어를 중복하지 않는다`);
  }
});

test("메뉴·welcome이 가리키는 명령은 선언돼 있다", () => {
  const ids = new Set(c.commands.map((x: { command: string }) => x.command));
  for (const list of Object.values(c.menus) as { command: string }[][]) for (const m of list) assert.ok(ids.has(m.command), m.command);
});

test("inline 버튼은 아이콘이 있는 명령만", () => {
  const icon = new Map(c.commands.map((x: { command: string; icon?: string }) => [x.command, x.icon]));
  for (const m of [...c.menus["view/title"], ...c.menus["view/item/context"]]) if (/^(navigation|inline)/.test(m.group)) assert.ok(icon.get(m.command), `${m.command} 아이콘`);
});

test("nls: 모든 언어 파일이 같은 키를 갖고, package.json의 %키%가 모두 있다", () => {
  const base = Object.keys(read("package.nls.json")).sort();
  for (const f of readdirSync(new URL("..", import.meta.url)).filter((x) => /^package\.nls\..+\.json$/.test(x))) assert.deepEqual(Object.keys(read(f)).sort(), base, f);
  const used = [...JSON.stringify(pkg).matchAll(/%([\w.-]+)%/g)].map((m) => m[1]);
  for (const k of used) assert.ok(base.includes(k), `nls 키 없음: ${k}`);
});
