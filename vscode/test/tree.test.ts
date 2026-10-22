// 사이드바 TreeView 순수 로직 단위 테스트 (vscode 불필요): `pnpm test:unit`
import assert from "node:assert/strict";
import { test } from "node:test";
import { beforePath, branchesTree, checkoutArgs, commitNode, contentUriParts, groupBranches, lineLogArgs, lineRange, parseContentUri, parseLineLog, maskUrl, parseRemotes, parseStashMessage, remotesTree, repoNode, showArgs, stashArgs, stashesTree, tagsTree, trackText, type Ref } from "../src/features/views/tree.ts";

const R = (kind: Ref["kind"], name: string, extra: Partial<Ref> = {}): Ref => ({ kind, name, target: "a".repeat(40), head: false, ahead: 0, behind: 0, ...extra });
const refs: Ref[] = [
  R("local", "feature/x", { ahead: 2, behind: 1 }),
  R("local", "main", { head: true }),
  R("local", "dev"),
  R("remote", "origin/main"),
  R("remote", "upstream/main"),
  R("remote", "origin/feature/x"),
  R("tag", "v1.2"),
  R("tag", "v1.10"),
  R("stash", "stash@{0}", { message: "On main: wip login" }),
  R("stash", "stash@{1}", { message: "WIP on dev: abc1234 subject" }),
];
const L = { local: "Local", current: "current" };

test("ref 그룹핑: 현재 브랜치 먼저, 원격은 첫 슬래시로 나눠 이름순", () => {
  const g = groupBranches(refs);
  assert.deepEqual(g.local.map((r) => r.name), ["main", "dev", "feature/x"]);
  assert.deepEqual(g.remotes.map((r) => [r.remote, r.branches.map((b) => b.name)]), [["origin", ["origin/feature/x", "origin/main"]], ["upstream", ["upstream/main"]]]);
});

test("ahead/behind 설명", () => {
  assert.equal(trackText({ ahead: 2, behind: 1 }), "↑2 ↓1");
  assert.equal(trackText({ ahead: 0, behind: 3 }), "↓3");
  assert.equal(trackText({ ahead: 0, behind: 0 }), "");
});

test("Branches 트리: Local 그룹(펼침) + 원격 그룹(접힘), 현재 브랜치 표시", () => {
  const t = branchesTree(refs, L);
  assert.deepEqual(t.map((n) => [n.label, n.open]), [["Local", "expanded"], ["origin", "collapsed"], ["upstream", "collapsed"]]);
  const [main, dev, feat] = t[0].children!;
  assert.deepEqual([main.icon, main.context, dev.icon, dev.context], ["check", "git403.branch.current", "git-branch", "git403.branch"]);
  assert.equal(feat.description, "↑2 ↓1");
  assert.equal(dev.description, undefined);
  assert.deepEqual(t[1].children!.map((n) => [n.label, n.name, n.context]), [["feature/x", "origin/feature/x", "git403.remoteBranch"], ["main", "origin/main", "git403.remoteBranch"]]);
});

test("Remotes·Tags·Stashes 트리", () => {
  assert.deepEqual(remotesTree(refs).map((n) => [n.label, n.description, n.children!.length]), [["origin", "2", 2], ["upstream", "1", 1]]);
  assert.deepEqual(tagsTree(refs).map((n) => n.label), ["v1.10", "v1.2"]); // 버전 숫자순, 최신 먼저
  const s = stashesTree(refs);
  assert.deepEqual(s.map((n) => [n.label, n.description, n.name]), [["wip login", "stash@{0} · main", "stash@{0}"], ["abc1234 subject", "stash@{1} · dev", "stash@{1}"]]);
});

test("stash 메시지 파싱·git 인자", () => {
  assert.deepEqual(parseStashMessage("On feat/a: hello: world"), { branch: "feat/a", text: "hello: world" });
  assert.deepEqual(parseStashMessage("WIP on main: 1a2b3c4 msg"), { branch: "main", text: "1a2b3c4 msg" });
  assert.deepEqual(parseStashMessage("custom"), { branch: null, text: "custom" });
  assert.deepEqual(stashArgs("drop", "stash@{2}"), ["stash", "drop", "stash@{2}"]);
  assert.equal(stashArgs("pop", "--all"), null);
  assert.equal(stashArgs("apply", "stash@{x}"), null);
});

test("체크아웃 인자", () => {
  assert.deepEqual(checkoutArgs("branch", "dev"), ["switch", "dev"]);
  assert.deepEqual(checkoutArgs("remoteBranch", "origin/dev"), ["switch", "--track", "origin/dev"]);
});

test("git log -L 파싱: 머리만, 깨진 레코드 무시, 제목의 구분자 보존", () => {
  const A = "a".repeat(40), B = "b".repeat(40);
  const out = `\x1e${A}\x1f${B}\x1ft\x1ft@t\x1f1792538980\x1ftwo\n\x1e${B}\x1f\x1ft\x1ft@t\x1f1792538979\x1fone\n\x1ebroken\n`;
  assert.deepEqual(parseLineLog(out).map((c) => [c.id.slice(0, 1), c.author, c.time, c.subject]), [["a", "t", 1792538980, "two"], ["b", "t", 1792538979, "one"]]);
  assert.deepEqual(parseLineLog(""), []);
  assert.deepEqual(lineLogArgs("src/a.ts", 3, 5).slice(0, 2), ["log", "-L3,5:src/a.ts"]);
});

test("선택 → 줄 범위(1부터): 다음 줄 첫 칸에서 끝나면 그 줄 제외", () => {
  const p = (line: number, character: number) => ({ line, character });
  assert.deepEqual(lineRange({ start: p(0, 0), end: p(0, 0) }), { start: 1, end: 1 });
  assert.deepEqual(lineRange({ start: p(2, 1), end: p(4, 3) }), { start: 3, end: 5 });
  assert.deepEqual(lineRange({ start: p(2, 0), end: p(5, 0) }), { start: 3, end: 5 });
});

test("커밋 항목: 제목·짧은 SHA·작성자·상대 시간, 비교할 파일 경로", () => {
  const n = commitNode({ id: "c".repeat(40), author: "ann", time: 5, subject: "fix" }, "a/b.ts", () => "1 day ago", "f");
  assert.deepEqual([n.label, n.description, n.path, n.context, n.id], ["fix", "cccccccc · ann · 1 day ago", "a/b.ts", "git403.commit", `f:${"c".repeat(40)}`]);
});

test("git403: 컨텐츠 URI 인코딩 왕복 (한글·공백·특수문자 경로, 저장소 경로)", () => {
  for (const [repo, rel] of [["/tmp/repo", "a.txt"], ["C:\\Users\\a b\\저장소", "디렉터리/파일 #1 (a)?.ts"], ["/x", "weird&=%/q.md"]]) {
    const u = contentUriParts({ repo, ref: "abc^" }, rel);
    assert.equal(u.scheme, "git403");
    assert.match(u.query, /^[A-Za-z0-9_-]+$/, "query는 URL 안전 문자만");
    assert.deepEqual(parseContentUri(u), { repo, ref: "abc^", rel });
  }
  assert.equal(parseContentUri({ path: "/a", query: "!!!" }), null);
  assert.equal(parseContentUri({ path: "/a", query: Buffer.from('{"repo":1}').toString("base64url") }), null);
});

test("git show 인자: 빈 ref·옵션처럼 보이는 ref는 거부", () => {
  assert.deepEqual(showArgs("abc^", "a b.txt"), ["show", "abc^:a b.txt"]);
  assert.equal(showArgs("", "a"), null);
  assert.equal(showArgs("--output=x", "a"), null);
});

test("커밋 전 경로: 이름 변경은 옛 경로, 추가는 빈 쪽", () => {
  const files = [{ status: "R", path: "new.txt", oldPath: "old.txt" }, { status: "A", path: "add.txt" }, { status: "M", path: "m.txt" }];
  assert.deepEqual(beforePath(files, "new.txt"), { rel: "old.txt", added: false });
  assert.deepEqual(beforePath(files, "add.txt"), { rel: "add.txt", added: true });
  assert.deepEqual(beforePath(files, "m.txt"), { rel: "m.txt", added: false });
  assert.deepEqual(beforePath(files, "none"), { rel: "none", added: false });
});

test("원격 URL: git remote -v 파싱(자격 증명 가림), Remotes 설명은 URL, 브랜치 없는 원격도 보인다", () => {
  const urls = parseRemotes("origin\thttps://user:tok@github.com/a/b.git (fetch)\norigin\thttps://user:tok@github.com/a/b.git (push)\nupstream\tgit@github.com:c/d.git (fetch)\nupstream\tgit@github.com:c/d.git (push)\nonlypush\tssh://h/x (push)\nempty\t/tmp/e (fetch)\n");
  assert.deepEqual([...urls], [["origin", "https://github.com/a/b.git"], ["upstream", "git@github.com:c/d.git"], ["onlypush", "ssh://h/x"], ["empty", "/tmp/e"]]);
  assert.equal(parseRemotes("").size, 0);
  const t = remotesTree(refs, urls);
  assert.deepEqual(t.map((n) => [n.label, n.description, n.open]), [["empty", "/tmp/e", "none"], ["onlypush", "ssh://h/x", "none"], ["origin", "https://github.com/a/b.git", "collapsed"], ["upstream", "git@github.com:c/d.git", "collapsed"]]);
  assert.match(t[2].tooltip!, /origin\nhttps:\/\/github.com\/a\/b.git/);
});

test("저장소 노드: 하위 id에 저장소 접두사, 저장소 필드", () => {
  const n = repoNode("/w/app", "app", branchesTree(refs, L), "w");
  assert.deepEqual([n.kind, n.label, n.description, n.repo, n.open, n.context], ["repo", "app", "w", "/w/app", "expanded", "git403.repo"]);
  assert.ok(n.children![0].id.startsWith("/w/app|"));
  assert.ok(n.children![0].children![0].id.startsWith("/w/app|b:"));
  const other = repoNode("/w/lib", "lib", branchesTree(refs, L));
  assert.notEqual(n.children![0].children![0].id, other.children![0].children![0].id, "저장소가 달라 id가 겹치지 않는다");
});

test("원격 URL 마스킹: userinfo·scp 토큰·쿼리 토큰", () => {
  assert.equal(maskUrl("https://user:tok@host/o/r.git"), "https://host/o/r.git");
  assert.equal(maskUrl("https://tok@host/o/r.git"), "https://host/o/r.git");
  assert.equal(maskUrl("https://user:to/k@en@host/o/r.git"), "https://host/o/r.git", "토큰에 / @가 있어도 마지막 @ 앞 전부");
  assert.equal(maskUrl("ssh://git@host:22/o/r.git"), "ssh://host:22/o/r.git");
  assert.equal(maskUrl("https://host/o/r.git"), "https://host/o/r.git");
  assert.equal(maskUrl("user:tok:en@host:o/r.git"), "user@host:o/r.git");
  assert.equal(maskUrl("git@github.com:o/r.git"), "git@github.com:o/r.git");
  assert.equal(maskUrl("https://host/o/r.git?private_token=abc&x=1"), "https://host/o/r.git?private_token=***&x=1");
  assert.equal(maskUrl("https://host/r?a=1&Access_Token=zz#frag"), "https://host/r?a=1&Access_Token=***#frag");
  assert.equal(maskUrl("https://u:p@host/r?token=t@x"), "https://host/r?token=***");
  assert.equal(parseRemotes("origin\thttps://u:secret@h/r.git (fetch)\norigin\thttps://u:secret@h/r.git (push)").get("origin"), "https://h/r.git");
  assert.equal(maskUrl("/local/path/repo"), "/local/path/repo");
});
