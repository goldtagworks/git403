// 줄 끝 blame·호버·작업 정리 단위 테스트 (vscode 불필요): `pnpm test:unit`
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { BlameCache, currentLines, findRepo, PromiseLru, fenced, hoverMarkdown, inlineText, lineInfo, parseCommit, pickHunk, relativeTime, type BlameLine } from "../src/services/blame.ts";
import { PanelWork } from "../src/shared/jobs.ts";

const L = (sha: string, text: string, author = "ann", time = 1000, summary = "subj"): BlameLine => ({ sha, author, time, summary, text });
const doc = (texts: string[], dirty = false) => ({ lineCount: texts.length, dirty, textAt: (n: number) => texts[n] });
const A = "a".repeat(40), Z = "0".repeat(40);

test("blame → 줄 매핑: 커밋 줄·커밋 안 된 줄·범위 밖", () => {
  const lines = [L(A, "x"), L(Z, "y", "Not Committed Yet")];
  const d = doc(["x", "y"]);
  assert.equal(lineInfo(lines, 0, d), lines[0]);
  assert.equal(lineInfo(lines, 1, d), "uncommitted");
  assert.equal(lineInfo(lines, 5, d), null);
  assert.equal(lineInfo(null, 0, d), null);
});

test("저장 안 된 편집(트래커 없음): 같은 줄 번호의 내용이 같으면 blame을 믿고, 어긋나면 커밋 안 됨", () => {
  const lines = [L(A, "x"), L(A, "y")];
  assert.equal(lineInfo(lines, 1, doc(["x", "y"], true)), lines[1]);
  assert.equal(lineInfo(lines, 1, doc(["x", "y2"], true)), "uncommitted");
  assert.equal(lineInfo(lines, 1, doc(["new", "x", "y"], true)), "uncommitted");
  assert.equal(lineInfo(lines, 2, doc(["x", "y", "added"], true)), "uncommitted"); // 새로 추가한 줄
  assert.equal(lineInfo(lines, 0, doc(["x\r", "y"], true)), lines[0]); // CRLF 무시
});

test("저장 안 된 편집(트래커): 줄이 밀려도 원래 blame, 삽입 줄·고친 줄은 커밋 안 됨", () => {
  const lines = [L(A, "a", "ann"), L(A, "b", "bob"), L(A, "c", "cat")];
  // a, NEW, b, c — b·c가 한 줄씩 밀렸다
  const texts = ["a", "NEW", "b", "c"];
  const map = [0, null, 1, 2];
  const d = { dirty: true, textAt: (n: number) => texts[n], diskLine: (n: number) => map[n] ?? null };
  assert.equal(lineInfo(lines, 0, d), lines[0]);
  assert.equal(lineInfo(lines, 1, d), "uncommitted");
  assert.equal(lineInfo(lines, 2, d), lines[1]);
  assert.equal(lineInfo(lines, 3, d), lines[2]);
  // 밀린 줄의 내용을 고치면 커밋 안 됨, 되돌리면(내용이 같아지면) 복귀
  texts[2] = "b!";
  assert.equal(lineInfo(lines, 2, d), "uncommitted");
  texts[2] = "b";
  assert.equal(lineInfo(lines, 2, d), lines[1]);
  // 깨끗한 문서는 트래커를 쓰지 않는다
  assert.equal(lineInfo(lines, 1, { dirty: false, textAt: () => "", diskLine: () => null }), lines[1]);
});

test("현재 줄별 blame(CodeLens 집계용): 삭제된 줄은 빠지고 새 줄은 null", () => {
  const lines = [L(A, "a"), L(A, "b"), L(A, "c"), L(Z, "d")];
  const texts = ["a", "c", "new", "d"]; // b 삭제, 새 줄 삽입
  const map = [0, 2, null, 3];
  const cur = currentLines(lines, { lineCount: 4, dirty: true, textAt: (n) => texts[n], diskLine: (n) => map[n] });
  assert.deepEqual(cur, [lines[0], lines[2], null, null]); // 마지막 d는 커밋 안 된 줄
});

test("상대 시간", () => {
  const now = 1_000_000_000;
  assert.equal(relativeTime(now, now, "en"), "now");
  assert.equal(relativeTime(now, now - 300, "en"), "5 minutes ago");
  assert.equal(relativeTime(now, now - 7200, "en"), "2 hours ago");
  assert.equal(relativeTime(now, now - 86400, "en"), "yesterday");
  assert.equal(relativeTime(now, now - 86400 * 400, "en"), "last year");
  assert.equal(relativeTime(now, now - 300, "ko"), "5분 전");
  assert.equal(inlineText(L(A, "x", "ann", now - 3600, "fix bug"), now, "en"), "ann, 1 hour ago • fix bug");
});

test("저장소 찾기: 작업 영역 안에서 위로 .git", () => {
  const root = path.resolve("/w/proj");
  const has = new Set([path.join(root, ".git"), path.join(root, "sub", ".git")]);
  const ex = (p: string) => has.has(p);
  assert.deepEqual(findRepo(path.join(root, "src", "a.ts"), [root], ex), { repo: root, rel: "src/a.ts" });
  assert.deepEqual(findRepo(path.join(root, "sub", "b.ts"), [root], ex), { repo: path.join(root, "sub"), rel: "b.ts" });
  assert.equal(findRepo(path.resolve("/other/c.ts"), [root], ex), null);
  assert.equal(findRepo(path.join(root, "a.ts"), [root], () => false), null);
});

test("blame 캐시: 파일별 캐시·동시 요청 합치기·무효화·실패는 null", async () => {
  let n = 0, fail = false;
  const c = new BlameCache(async () => {
    n++;
    if (fail) throw new Error("x");
    return [L(A, String(n))];
  });
  const [a, b] = await Promise.all([c.get("/r", "f"), c.get("/r", "f")]);
  assert.equal(n, 1);
  assert.equal(a, b);
  await c.get("/r", "g");
  assert.equal(n, 2);
  c.invalidate("/r", "f");
  assert.equal((await c.get("/r", "f"))![0].text, "3");
  await c.get("/r", "g");
  assert.equal(n, 3, "g는 그대로");
  c.invalidate("/r");
  assert.equal(c.size, 0);
  fail = true;
  assert.equal(await c.get("/r", "f"), null);
  fail = false;
  assert.equal(await c.get("/r", "f"), null, "무효화 전에는 실패도 캐시");
  c.invalidate("/r", "f");
  assert.ok(await c.get("/r", "f"));
  c.clear();
  assert.equal(c.size, 0);
});

const DIFF = `diff --git a/f b/f
index 1..2 100644
--- a/f
+++ b/f
@@ -1,2 +1,2 @@
 one
-two
+two!
@@ -40,1 +40,2 @@
 keep
+other
`;

test("hunk 고르기: 줄 내용을 추가한 hunk, 없으면 첫 hunk, 길면 자름", () => {
  assert.match(pickHunk(DIFF, "other")!, /^@@ -40,1 \+40,2 @@\n keep\n\+other$/);
  assert.match(pickHunk(DIFF, "two!")!, /^@@ -1,2 \+1,2 @@/);
  assert.match(pickHunk(DIFF, "nope")!, /^@@ -1,2/);
  assert.equal(pickHunk("", "x"), null);
  const big = "@@ -1 +1,100 @@\n" + Array.from({ length: 100 }, (_, i) => `+l${i}`).join("\n");
  assert.equal(pickHunk(big, "zz", 5)!.split("\n").length, 6); // 5줄 + 자름 표시
});

test("호버 마크다운: 짧은 SHA·작성자·이메일·날짜·전체 메시지·diff·링크, 마크다운 이스케이프", () => {
  const commit = parseCommit(`${A}\x1fAnn *B*\x1fann@x.io\x1f1000\x1fsubject line\n\nbody <b> line\n`);
  assert.deepEqual(commit, { sha: A, author: "Ann *B*", email: "ann@x.io", time: 1000, message: "subject line\n\nbody <b> line" });
  const md = hoverMarkdown({ commit, date: "D", rel: "R", hunk: "@@ -1 +1 @@\n+x", links: { graph: "command:g", copy: "command:c" }, labels: { graph: "Open in graph", copy: "Copy SHA" } });
  assert.match(md, /`aaaaaaaa`/);
  assert.ok(!md.includes("a".repeat(9)));
  assert.match(md, /Ann \\\*B\\\* &lt;ann@x\.io&gt;, D \(R\)/);
  assert.match(md, /subject line {2}\n {2}\nbody \\<b\\> line/);
  assert.match(md, /```diff\n@@ -1 \+1 @@\n\+x\n```/);
  assert.match(md, /\[Open in graph\]\(command:g\) \| \[Copy SHA\]\(command:c\)$/);
  assert.ok(!hoverMarkdown({ commit, date: "D", rel: "R", hunk: null, links: { graph: "g", copy: "c" }, labels: { graph: "G", copy: "C" } }).includes("diff"));
});

test("호버: 백틱·HTML·command: 링크가 든 hunk는 펜스를 못 벗어나고, 메시지·작성자는 이스케이프된다", () => {
  const hunk = "@@ -1 +1 @@\n+````\n+<img src=x onerror=1>\n+[x](command:git403.evil)\n+```\n+text";
  const commit = { sha: A, author: "[a](command:x)", email: "<i>@x", time: 1, message: "- [p](command:y)\n<script>`x`" };
  const md = hoverMarkdown({ commit, date: "D", rel: "R", hunk, links: { graph: "command:g", copy: "command:c" }, labels: { graph: "G", copy: "C" } });
  assert.ok(md.includes("`````diff\n" + hunk + "\n`````")); // 최장 열 4 + 1
  const outside = md.replace(/(`{5,})diff\n[\s\S]*?\n\1/, "");
  assert.ok(!/(?<!\\)\[[^\]]*\]\(command:(x|y|git403\.evil)/.test(outside), outside);
  assert.ok(!outside.includes("<script>") && !outside.includes("<i>"));
  assert.match(outside, /\\\[a\\\]\\\(command:x\\\)/);
  assert.equal(fenced("a"), "```\na\n```");
  assert.equal(fenced("a ``` b", "diff"), "````diff\na ``` b\n````");
});

test("PromiseLru: 저장소별 키·실패 삭제·LRU 상한·저장소별 무효화", async () => {
  const c = new PromiseLru<string>(2);
  let n = 0;
  const mk = (v: string) => () => (n++, Promise.resolve(v));
  assert.equal(await c.get("/a", "s1", mk("a1")), "a1");
  assert.equal(await c.get("/b", "s1", mk("b1")), "b1", "같은 sha라도 저장소가 다르면 다른 항목");
  assert.equal(await c.get("/a/", "s1", mk("x")), "a1", "경로 표기가 달라도 같은 저장소");
  await c.get("/c", "s1", mk("c1")); // 상한 2: 가장 오래 안 쓴 /b가 밀려난다
  assert.equal(c.size, 2);
  assert.equal(await c.get("/b", "s1", mk("b2")), "b2");
  c.invalidate("/c");
  assert.equal(await c.get("/c", "s1", mk("c2")), "c2");
  const bad = new PromiseLru<string>();
  await assert.rejects(bad.get("/a", "k", () => Promise.reject(new Error("x"))));
  await new Promise((r) => setTimeout(r));
  assert.equal(bad.size, 0, "실패는 캐시에 남지 않는다");
  assert.equal(await bad.get("/a", "k", mk("ok")), "ok");
  bad.invalidate();
  assert.equal(bad.size, 0);
});

test("패널 작업 정리: 남은 작업만 취소하고 인증 대기는 취소로 답한다", async () => {
  const w = new PanelWork();
  w.track("start_job", {}, 7);
  w.track("start_shell", {}, 8);
  w.track("run_detached", { token: "t1" }, null);
  w.track("run_detached", { token: "t2" }, null);
  w.track("load_graph", {}, { commits: [] }); // 무관
  w.event("job-done", [7, null], true);
  w.track("cancel_detached", { token: "t2" }, null);
  w.event("askpass", { id: 3, prompt: "Password:" }, true);
  w.event("askpass", { id: 4, prompt: "x" }, false); // 웹뷰로 안 보낸 것은 세지 않는다
  assert.equal(w.pending, 3);
  const calls: [string, unknown][] = [];
  await w.cleanup(async (cmd, args) => void calls.push([cmd, args]));
  assert.deepEqual(calls, [["cancel_job", { job: 8 }], ["cancel_detached", { token: "t1" }], ["askpass_reply", { id: 3, answer: null }]]);
  assert.equal(w.pending, 0);
  await w.cleanup(async () => assert.fail("두 번 취소하지 않는다"));
});
