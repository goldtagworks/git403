// 다중 저장소 단위 테스트 (vscode 불필요): `pnpm test:unit`
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { EventDedupe, RepoWatch, discoverRepos, gitInDepth, parentRepo, repoKey, sameRepo } from "../src/services/repos.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "git403-repos-"));
const mk = (root: string, ...dirs: string[]) => dirs.forEach((d) => fs.mkdirSync(path.join(root, d), { recursive: true }));

test("저장소 찾기: 폴더 자체·하위 폴더·.git 파일(worktree), 멀티루트", async () => {
  const a = tmp(), b = tmp();
  mk(a, ".git", "pkg/one/.git", "pkg/two", "deep/x/y/z/.git", "node_modules/m/.git", ".hidden/h/.git", "inside/.git/sub/.git");
  fs.writeFileSync(path.join(a, "pkg/two/.git"), "gitdir: ../x"); // worktree 식 .git 파일
  mk(b, "app/.git");
  // a 자체도 저장소이고 하위 저장소도 같이 찾는다
  assert.deepEqual(await discoverRepos([a]), [a, path.join(a, "inside"), path.join(a, "pkg/one"), path.join(a, "pkg/two")], "깊이 4 이상·node_modules·점 폴더 제외");
  fs.rmSync(path.join(a, ".git"), { recursive: true });
  assert.deepEqual(await discoverRepos([a]), [path.join(a, "inside"), path.join(a, "pkg/one"), path.join(a, "pkg/two")]);
  assert.deepEqual(await discoverRepos([a, b]), [path.join(a, "inside"), path.join(a, "pkg/one"), path.join(a, "pkg/two"), path.join(b, "app")].sort());
  assert.deepEqual(await discoverRepos([a], { maxDepth: 1 }), [path.join(a, "inside")]);
  assert.equal((await discoverRepos([a], { maxRepos: 1 })).length, 1);
  assert.deepEqual(await discoverRepos([path.join(a, "없는폴더")]), []);
});

test("저장소별 감시: 새 저장소 watch_add, 빠진 저장소 watch_remove, 중복 없음, 실패는 재시도", async () => {
  const calls: string[] = [];
  let failNext = false;
  const w = new RepoWatch(async (cmd, args) => {
    calls.push(`${cmd} ${(args as { repo: string }).repo}`);
    if (failNext) throw new Error("x");
    return null;
  });
  await w.sync(["/a", "/b"]);
  await w.sync(["/a", "/b"]);
  assert.deepEqual(calls.sort(), ["watch_add /a", "watch_add /b"]);
  calls.length = 0;
  await w.sync(["/b", "/c"]); // a 제거, c 추가
  assert.deepEqual(calls.sort(), ["watch_add /c", "watch_remove /a"]);
  assert.deepEqual(w.repos, ["/b", "/c"]);
  calls.length = 0;
  failNext = true;
  await w.sync(["/b", "/c", "/d"]);
  assert.deepEqual(w.repos, ["/b", "/c"], "실패한 d는 감시 목록에 없다");
  failNext = false;
  calls.length = 0;
  await w.sync(["/b", "/c", "/d"]);
  assert.deepEqual(calls, ["watch_add /d"]);
  w.forget();
  calls.length = 0;
  await w.sync(["/b"]);
  assert.deepEqual(calls, ["watch_add /b"], "서버 재시작 뒤에는 다시 추가");
});

test("저장소별 감시: 겹친 sync는 직렬로 돌고 최종 목록 기준(빠른 add/remove/add)", async () => {
  const log: string[] = [];
  const server = new Set<string>();
  let running = 0, maxRunning = 0;
  const w = new RepoWatch(async (cmd, args) => {
    const r = (args as { repo: string }).repo;
    running++, (maxRunning = Math.max(maxRunning, running));
    await new Promise((x) => setTimeout(x, cmd === "watch_add" ? 20 : 1)); // add가 느려 remove가 앞지르려 한다
    cmd === "watch_add" ? server.add(r) : server.delete(r);
    log.push(`${cmd} ${r}`);
    running--;
    return null;
  });
  const ps = [w.sync(["/a"]), w.sync([]), w.sync(["/a"])];
  await Promise.all(ps);
  assert.equal(maxRunning, 1, "요청이 겹치지 않는다");
  assert.deepEqual([...server], ["/a"], "서버 상태 = 마지막 목록");
  assert.deepEqual(w.repos, ["/a"]);
  const qs = [w.sync(["/a", "/b"]), w.sync(["/b"])];
  await Promise.all(qs);
  assert.deepEqual([...server].sort(), ["/b"]);
  assert.deepEqual(w.repos, ["/b"]);
});

test("이벤트 중복 합치기: 같은 저장소·같은 내용만, 시간 창 안에서", () => {
  const d = new EventDedupe(100);
  assert.equal(d.fresh("/a", true, false, 1000), true);
  assert.equal(d.fresh("/a", true, false, 1050), false, "중복");
  assert.equal(d.fresh("/a", true, true, 1060), true, "내용이 다르면 새 이벤트");
  assert.equal(d.fresh("/b", true, false, 1060), true, "저장소가 다르면 새 이벤트");
  assert.equal(d.fresh("/a", true, false, 1400), true, "시간이 지나면 새 이벤트");
});

test("저장소 키 정규화: 끝 구분자·심볼릭 링크·대소문자(Windows·macOS)", () => {
  assert.equal(repoKey("/a/b/", "linux", (p) => p), repoKey("/a/b", "linux", (p) => p));
  assert.notEqual(repoKey("/a/B", "linux", (p) => p), repoKey("/a/b", "linux", (p) => p));
  assert.equal(repoKey("/a/B", "darwin", (p) => p), repoKey("/a/b", "darwin", (p) => p));
  const link = path.resolve("/link"), target = path.resolve("/real/repo"); // Windows에선 드라이브 문자가 붙는다
  assert.equal(repoKey("/link", "linux", (p) => (p === link ? target : p)), target);
  const root = tmp(), real = path.join(root, "real");
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(root, "ln"));
  assert.equal(repoKey(path.join(root, "ln") + path.sep), repoKey(real));
  const d = new EventDedupe(100);
  assert.equal(d.fresh(real, true, false, 1000), true);
  assert.equal(d.fresh(path.join(root, "ln"), true, false, 1010), false, "같은 저장소의 다른 표기는 중복");
});

test("저장소 경로 비교", () => {
  assert.ok(sameRepo("/a/b", "/a/b/"));
  assert.ok(!sameRepo("/a/b", "/a/c"));
  assert.ok(!sameRepo(undefined, "/a"));
});

test("상위 저장소: 작업 영역 폴더가 저장소의 하위 폴더이면 그 저장소를 찾는다(.git 폴더·파일), 폴더 자체가 저장소면 해당 없음", async () => {
  const a = tmp();
  mk(a, ".git", "sub/deep", "other/.git", "wt");
  fs.writeFileSync(path.join(a, "wt/.git"), "gitdir: ../x");
  mk(a, "wt/inner");
  assert.equal(await parentRepo(path.join(a, "sub/deep")), a);
  assert.equal(await parentRepo(path.join(a, "wt/inner")), path.join(a, "wt"), "가장 가까운 상위");
  assert.equal(await parentRepo(a), null, "폴더 자체가 저장소");
  assert.equal(await parentRepo(path.join(a, "other")), null);
  // 작업 영역 폴더가 하위 폴더: 상위 저장소와 그 폴더 아래 저장소를 같이 찾는다
  mk(a, "sub/deep/child/.git");
  assert.deepEqual(await discoverRepos([path.join(a, "sub/deep")]), [a, path.join(a, "sub/deep/child")].sort());
  const none = tmp();
  mk(none, "x");
  const up = await parentRepo(path.join(none, "x"));
  assert.ok(up === null || !up.startsWith(none), "임시 폴더 안에는 없다");
});

test("`.git` 생성·삭제 알림의 깊이 제한: 탐색 깊이 3과 일관, 점·제외 폴더 안은 무시", () => {
  const r = path.join(path.sep, "w");
  const g = (...p: string[]) => path.join(r, ...p, ".git");
  assert.ok(gitInDepth(r, g()));
  assert.ok(gitInDepth(r, g("a", "b", "c")), "저장소 깊이 3");
  assert.ok(!gitInDepth(r, g("a", "b", "c", "d")), "깊이 4");
  assert.ok(!gitInDepth(r, g("node_modules", "m")));
  assert.ok(!gitInDepth(r, g(".hidden")));
  assert.ok(!gitInDepth(r, path.join(r, "a", "x.git")));
  assert.ok(!gitInDepth(r, path.join(path.sep, "elsewhere", ".git")));
});
