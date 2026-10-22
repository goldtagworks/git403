// @vscode/test-electron: 진짜 VS Code를 내려받아 임시 git 저장소를 워크스페이스로 열고 스위트를 돌린다.
//  - single: 저장소 하나(`out/test.js` ← test/suite.ts): 편집기 통합·뷰·그래프·웹뷰 상호작용·스태시
//  - multi : 멀티루트 폴더 3개 + 하위 저장소 1개(`out/test-multi.js` ← test/multi.ts): 다중 저장소
// 환경변수 GIT403_SUITE=single|multi로 하나만 돌릴 수 있다. GIT403_SUITE=shots(macOS)는 테마별 화면을 test/results/screens에 찍는다(기본 실행엔 안 들어감). 사전: node scripts/build.mjs, cargo build -p gc-backend --bin git403-server
// 서버·UI는 개발·테스트 모드라 항상 ../target·../ui/dist를 쓴다(확장 폴더의 낡은 bin·ui가 아니라). 여기서는 그 산출물이 있는지·낡았는지만 확인한다.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const top = path.join(root, "..");

// ---- 산출물 확인 ----
const exe = process.platform === "win32" ? "git403-server.exe" : "git403-server";
const server = ["debug", "release"].map((p) => path.join(top, "target", p, exe)).filter(existsSync);
if (!server.length || !existsSync(path.join(top, "ui", "dist", "index.html"))) {
  console.error("서버(target/{debug,release}/git403-server)와 UI(ui/dist)를 먼저 빌드하라: cargo build -p gc-backend --bin git403-server && pnpm --dir ui build");
  process.exit(1);
}
const newest = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((m, e) => Math.max(m, e.isDirectory() ? newest(path.join(dir, e.name)) : statSync(path.join(dir, e.name)).mtimeMs), 0);
if (newest(path.join(top, "ui", "src")) > statSync(path.join(top, "ui", "dist", "index.html")).mtimeMs) console.warn("주의: ui/src가 ui/dist보다 새롭다. pnpm --dir ui build 후 다시 돌려라(낡은 UI로 테스트될 수 있다)");

// ---- 임시 저장소 ----
const git = (repo, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
const lines = (n, change) => Array.from({ length: n }, (_, i) => (i + 1 === change ? `line ${i + 1} changed` : `line ${i + 1}`)).join("\n") + "\n";

/** single 스위트용: 두 커밋 + 브랜치·태그·원격·스태시 + 커밋 안 된 줄 */
function singleRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "git403-ws-"));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "a.txt"), "a\n");
  writeFileSync(path.join(repo, "b.txt"), "one\ntwo\n");
  writeFileSync(path.join(repo, "c.txt"), lines(60)); // 심볼 렌즈·diff 줄 이동용(60줄)
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "first");
  writeFileSync(path.join(repo, "a.txt"), "b\n");
  writeFileSync(path.join(repo, "b.txt"), "one\ntwo!\n");
  writeFileSync(path.join(repo, "c.txt"), lines(60, 50)); // 50번 줄만 바뀜
  git(repo, "commit", "-qam", "second");
  // 사이드바 뷰용: 브랜치·태그·원격 추적 브랜치·스태시(a.txt만 담아 아래 커밋 안 된 줄을 남긴다)
  git(repo, "branch", "feature");
  git(repo, "tag", "v1");
  const bare = mkdtempSync(path.join(tmpdir(), "git403-origin-"));
  execFileSync("git", ["init", "-q", "--bare", bare]);
  git(repo, "remote", "add", "origin", bare);
  git(repo, "push", "-q", "origin", "main");
  writeFileSync(path.join(repo, "a.txt"), "stashed\n");
  git(repo, "stash", "push", "-q", "-m", "wip stuff", "--", "a.txt");
  writeFileSync(path.join(repo, "b.txt"), "one\ntwo!\nthree\n"); // 커밋 안 된 줄
  return repo;
}

/** multi 스위트용: 멀티루트 폴더 a-app(하위 저장소 pkg/inner 포함·원격 있음)·b-lib·c-tool */
function multiRepos() {
  const base = mkdtempSync(path.join(tmpdir(), "git403-multi-"));
  const mk = (rel, file, text, extra = () => {}) => {
    const repo = path.join(base, rel);
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(path.join(repo, file), text);
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", `init ${path.basename(rel)}`);
    extra(repo);
    return repo;
  };
  const a = mk("a-app", "a.txt", "a\n", (r) => {
    git(r, "branch", "a-feature");
    const bare = mkdtempSync(path.join(tmpdir(), "git403-origin-"));
    execFileSync("git", ["init", "-q", "--bare", bare]);
    git(r, "remote", "add", "origin", bare);
    git(r, "push", "-q", "origin", "main");
  });
  mk("a-app/pkg/inner", "i.txt", "i\n");
  const b = mk("b-lib", "b.txt", "b\n", (r) => git(r, "branch", "b-feature"));
  const c = mk("c-tool", "c.txt", "c\n");
  return [a, b, c];
}

// 새 VS Code(1.14x)는 macOS 실행 파일 이름이 Electron이 아니라 Code라, test-electron 기본 경로가 안 맞는다
let vscodeExecutablePath = await downloadAndUnzipVSCode(process.env.VSCODE_VERSION ?? "stable");
if (!existsSync(vscodeExecutablePath) && process.platform === "darwin") vscodeExecutablePath = path.join(path.dirname(vscodeExecutablePath), "Code");

// VS Code 터미널 등에서 상속되면 Electron이 Node로만 뜬다
delete process.env.ELECTRON_RUN_AS_NODE;
for (const k of Object.keys(process.env)) if (k.startsWith("VSCODE_")) delete process.env[k];

const dir = (p) => mkdtempSync(path.join(tmpdir(), p));
const suites = { single: { folders: () => [singleRepo()], tests: "test.js" }, multi: { folders: multiRepos, tests: "test-multi.js" }, shots: { folders: () => [singleRepo()], tests: "test-shots.js" } };
const which = process.env.GIT403_SUITE ? [process.env.GIT403_SUITE] : ["single", "multi"];
let current = "";
try {
  for (const name of which) {
    current = name;
    const s = suites[name];
    if (!s) throw new Error(`알 수 없는 스위트: ${name}`);
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(root, "out", s.tests),
      launchArgs: [...s.folders(), "--disable-extensions", "--disable-workspace-trust", "--user-data-dir", dir("git403-ud-"), "--extensions-dir", dir("git403-ex-")],
      extensionTestsEnv: { GIT403_CONFIG_DIR: dir("git403-cfg-"), GIT403_SHOTS_DIR: path.join(root, "test", "results", "screens") },
    });
    console.log(`extension smoke (${name}): ok`);
  }
  console.log("extension smoke: ok");
} catch (e) {
  console.error(`extension smoke (${current || "setup"}): FAILED`, e);
  process.exit(1);
}
