// 실제 앱 E2E (OS 연동): 네이티브 우클릭 메뉴·대화상자, askpass 인증 Pull/Push, 키체인, 외부 diff/merge 도구,
// 로그인 셸 PATH, 자동 업데이트(확인·다운로드·서명 검증). macOS 전용 — 메뉴·대화상자는 System Events로 키를 보낸다
// (실행하는 터미널·에디터에 손쉬운 사용 권한 필요). 키보드 포커스·클립보드를 잠깐 쓰므로 실행 중에는 손대지 않는다.
// 실행: pnpm --dir ui e2e:native  (디버그 빌드 후 실행)
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { App, Steps, eq, gitIn, sleep, temp, until } from "./lib.mjs";

if (process.platform !== "darwin") {
  console.log("native E2E는 macOS 전용입니다 (System Events)");
  process.exit(0);
}

const ROOT = resolve(import.meta.dirname, "../../..");
const work = temp("native");
const home = join(work, "home");
const repo = join(work, "repo");
const served = join(work, "served"); // http-backend가 내보내는 bare 저장소들
const out = join(work, "out"); // 외부 도구·훅이 남기는 기록
for (const d of [home, repo, served, out]) mkdirSync(d, { recursive: true });
const git = (...a) => gitIn(repo)("-c", "core.hooksPath=/dev/null", ...a); // 테스트 쪽 커밋은 훅을 건너뛴다
const bare = gitIn(join(served, "remote.git"));
const USER = "e2e", PASS = "s3cret", TOKEN = "e2e-token-" + Date.now();

// ---- 테스트 서버: 인증 git(http-backend) · Gitea API 흉내 · 업데이트 매니페스트 ----
const seen = { gitAuthFails: 0, update: 0, apiToken: null, prToken: null };
let update = null; // { manifest, body }
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/v1/user") {
    seen.apiToken = req.headers.authorization ?? null;
    if (req.headers.authorization !== `token ${TOKEN}`) return res.writeHead(401).end();
    return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ login: "e2e-user", username: "e2e-user" }));
  }
  if (url.pathname.startsWith("/api/v1/repos/")) return (seen.prToken = req.headers.authorization ?? null, res.writeHead(200, { "Content-Type": "application/json" }).end("[]"));
  if (url.pathname === "/latest.json") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(update.manifest));
  if (url.pathname === "/update.tar.gz") return (seen.update++, res.writeHead(200, { "Content-Length": update.body.length }).end(update.body));
  if (req.headers.authorization !== "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64")) {
    if (req.headers.authorization) seen.gitAuthFails++;
    return res.writeHead(401, { "WWW-Authenticate": 'Basic realm="e2e"' }).end();
  }
  const cgi = spawn("git", ["http-backend"], {
    env: {
      ...process.env, GIT_PROJECT_ROOT: served, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers["content-type"] ?? "", HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
      REMOTE_USER: USER, REMOTE_ADDR: "127.0.0.1",
    },
  });
  req.pipe(cgi.stdin);
  let buf = Buffer.alloc(0), head = false;
  cgi.stdout.on("data", (d) => {
    if (head) return res.write(d);
    buf = Buffer.concat([buf, d]);
    const i = buf.indexOf("\r\n\r\n");
    if (i < 0) return;
    head = true;
    const headers = {};
    let status = 200;
    for (const l of buf.subarray(0, i).toString().split("\r\n")) {
      const [k, ...v] = l.split(":");
      if (k.toLowerCase() === "status") status = parseInt(v.join(":"));
      else headers[k] = v.join(":").trim();
    }
    res.writeHead(status, headers);
    res.write(buf.subarray(i + 4));
  });
  cgi.on("close", () => res.end());
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const HTTP = `http://127.0.0.1:${server.address().port}`;

// ---- 저장소: 인증이 필요한 http 원격(upstream 설정됨), 충돌용 브랜치 ----
git("init", "-q", "-b", "main");
git("config", "user.name", "E2E");
git("config", "user.email", "e2e@example.com");
git("config", "credential.helper", ""); // 시스템 osxkeychain 도우미를 끈다 → 매번 askpass로 묻는다
writeFileSync(join(repo, "a.txt"), "old\n");
writeFileSync(join(repo, "c.txt"), "base\n");
git("add", ".");
git("commit", "-qm", "첫 커밋");
writeFileSync(join(repo, "a.txt"), "new\n");
git("commit", "-qam", "a를 바꿈");
execFileSync("git", ["init", "-q", "--bare", "-b", "main", join(served, "remote.git")]);
git("push", "-q", join(served, "remote.git"), "main");
git("remote", "add", "origin", `${HTTP}/remote.git`);
git("update-ref", "refs/remotes/origin/main", "HEAD");
git("branch", "-q", "-u", "origin/main");
// 외부 도구: 받은 파일을 out에 기록 (diff), 충돌 파일을 해결 (merge)
git("config", "diff.tool", "e2e");
git("config", "difftool.e2e.cmd", `cat "$LOCAL" > '${out}/local'; cat "$REMOTE" > '${out}/remote'`);
git("config", "merge.tool", "e2e");
git("config", "mergetool.e2e.cmd", `cat "$BASE" > '${out}/base'; printf 'resolved\\n' > "$MERGED"`);
git("config", "mergetool.e2e.trustExitCode", "true");
git("config", "mergetool.keepBackup", "false");

// ---- 키체인: 임시 HOME에 login 키체인을 새로 만든다 → 앱의 기본 키체인이 되고 사용자 실제 키체인은 건드리지 않는다 ----
mkdirSync(join(home, "Library", "Keychains"), { recursive: true });
const sec = (...a) => execFileSync("security", a, { encoding: "utf8", env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "ignore"] }).trim();
const KEYCHAIN = join(home, "Library", "Keychains", "login.keychain-db");
sec("create-keychain", "-p", "e2e", KEYCHAIN); // 테스트 키체인 암호: e2e

// ---- 로그인 셸 PATH: ~/.zprofile에만 있는 도구를 pre-commit 훅이 부른다 ----
mkdirSync(join(home, "loginbin"));
writeFileSync(join(home, ".zprofile"), 'export PATH="$HOME/loginbin:$PATH"\n');
writeFileSync(join(home, "loginbin", "e2e-login-tool"), `#!/bin/sh\necho ok > '${out}/hook'\n`);
chmodSync(join(home, "loginbin", "e2e-login-tool"), 0o755);
// AI CLI도 ~/.zprofile PATH에만 있다 → 시작 직후 감지가 PATH 보정을 기다려야 찾는다
writeFileSync(join(home, "loginbin", "claude"), "#!/bin/sh\necho '9.9.9 (e2e)'\n");
chmodSync(join(home, "loginbin", "claude"), 0o755);
writeFileSync(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\ne2e-login-tool\n");
chmodSync(join(repo, ".git", "hooks", "pre-commit"), 0o755);

// ---- 업데이트: 테스트 키로 서명한 파일, 실제로는 바꾼 내용을 내려준다 → 서명 검증에서 거절되어야 한다 ----
const tauri = (...a) => execFileSync("pnpm", ["--silent", "tauri", "signer", ...a], { cwd: ROOT, encoding: "utf8", env: { ...process.env, CI: "true" } });
const keyFile = join(work, "update.key");
tauri("generate", "--ci", "-p", "", "-w", keyFile, "-f");
const pkg = join(work, "update.tar.gz");
writeFileSync(pkg, "진짜 업데이트 파일\n");
tauri("sign", "-f", keyFile, "-p", "", pkg);
const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
const platform = { url: `${HTTP}/update.tar.gz`, signature: readFileSync(pkg + ".sig", "utf8").trim() };
update = {
  manifest: { version: "99.0.0", notes: "e2e", pub_date: new Date().toISOString(), platforms: { [`darwin-${arch}`]: platform, [`darwin-${arch}-app`]: platform } },
  body: Buffer.from("바꿔치기한 업데이트 파일\n"),
};

// ---- System Events ----
const osa = (...lines) => execFileSync("osascript", lines.flatMap((l) => ["-e", l]), { encoding: "utf8" }).trim();
const front = () => osa('tell application "System Events" to set frontmost of process "git403" to true');
/** 열린 네이티브 메뉴에서 이름을 쳐서 고르고 Enter (NSMenu 타입 선택) */
const pickMenu = async (label) => {
  await sleep(1000);
  osa(`tell application "System Events" to keystroke "${label}"`, "delay 0.3", 'tell application "System Events" to key code 36');
};
const clipboard = (() => { try { return execFileSync("pbpaste", { encoding: "utf8" }); } catch { return ""; } })();

const PORT = 47404;
const app = App({
  port: PORT,
  home,
  env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", SHELL: "/bin/zsh", GIT403_E2E_UPDATER: `${HTTP}/latest.json ${readFileSync(keyFile + ".pub", "utf8").trim()}` },
});
const { js } = app;
const { step, finish } = Steps();
const acctKey = `gitea:${HTTP}:e2e-user`;
// 값(-w)을 읽으면 다른 앱이 만든 항목이라 OS가 허용 창을 띄운다 → 있는지만 본다. 값은 앱이 서버로 보내는 토큰으로 확인한다.
const inKeychain = () => { try { return sec("find-generic-password", "-s", "git403", "-a", acctKey, KEYCHAIN).includes(acctKey); } catch { return false; } };
/** 인증 시트에 답한다: 질문에 hint가 들어 있어야 한다 */
const answerAuth = (hint, value) => js(`
  const d = await waitFor(() => $$('[role=dialog]').find((d) => d.getAttribute("aria-label") === "Authentication required" && d.textContent.includes(${JSON.stringify(hint)})), "인증 시트: ${hint}");
  fill(d.querySelector("input"), ${JSON.stringify(value)});
  press([...d.querySelectorAll("button")].find((b) => b.textContent === "OK"));
`);
const toolbar = (name) => `press(await waitFor(() => $('.toolbar button[aria-label="${name}"]:not(:disabled)'), "툴바 ${name}"))`;

app.launch([repo]);
let saved = null;
try {
  // 메뉴 항목은 영어 이름으로 친다 (타입 선택은 한글 입력이 안 된다). 업데이트 자동 확인이 바로 돌게 마지막 확인 기록을 지운다.
  saved = await js(`const s = JSON.stringify({ ...localStorage }); localStorage.clear(); localStorage.setItem("language", '"en"'); localStorage.setItem("restoreTabs", "false"); setTimeout(() => location.reload(), 0); return s;`);
  await sleep(1000);
  await js(`await waitFor(() => byText(".commits .subject", "a를 바꿈"), "그래프");`);
  front();

  await step("로그인 셸 PATH: 시작 직후 AI 상태 조회도 ~/.zprofile의 claude CLI를 찾는다", async () => {
    const st = await js(`return await window.__TAURI_INTERNALS__.invoke("ai_status");`);
    const a = st.providers.find((p) => p.provider === "anthropic");
    if (!a.cli || a.cliVersion !== "9.9.9 (e2e)") throw new Error("claude CLI 감지 실패: " + JSON.stringify(a));
  });

  await step("로그인 셸 PATH: 최소 PATH로 띄워도 ~/.zprofile의 도구를 pre-commit 훅이 찾는다", async () => {
    writeFileSync(join(repo, "hooked.txt"), "x\n");
    await js(`
      press(await waitFor(() => byText(".commits .subject", "Local changes"), "Local changes 행"));
      const unstaged = await waitFor(() => $('[role=listbox][aria-label="Unstaged"]'), "Unstaged 목록");
      dbl(await waitFor(() => $$("[role=option]", unstaged).find((o) => o.textContent.includes("hooked.txt")), "hooked.txt"));
      await waitFor(() => $$('[role=listbox][aria-label="Staged"] [role=option]').some((o) => o.textContent.includes("hooked.txt")), "Staged에 hooked.txt");
      fill($('[aria-label="Commit subject"]'), "훅이 도는 커밋");
      press(await waitFor(() => $$("button").find((b) => b.textContent.trim() === "Commit" && !b.disabled), "Commit 버튼"));
      await waitFor(() => byText(".commits *", "훅이 도는 커밋"), "그래프에 새 커밋");
    `);
    eq(git("log", "-1", "--format=%s"), "훅이 도는 커밋", "HEAD 제목");
    eq(readFileSync(join(out, "hook"), "utf8"), "ok\n", "훅이 로그인 셸 PATH의 도구를 실행");
  });

  await step("네이티브 우클릭 메뉴: 커밋 → Copy SHA를 OS 메뉴에서 고르면 클립보드에 SHA", async () => {
    execFileSync("pbcopy", { input: "" });
    front();
    await js(`rightClick(byText(".commits .subject", "a를 바꿈"));`);
    await pickMenu("Copy SHA");
    await until(() => execFileSync("pbpaste", { encoding: "utf8" }) === git("rev-parse", "HEAD~1"), "클립보드 SHA");
  });

  await step("네이티브 메뉴 막대: UI가 만든 막대(App/File/Edit/Repository/View/Window/Help)로 바뀌고, 저장소 항목이 켜져 있고, Help > Quick launch가 팔레트를 연다", async () => {
    const bar = () => osa('tell application "System Events" to tell process "git403" to get name of every menu bar item of menu bar 1').trim().split(", ");
    const items = (m) => osa(`tell application "System Events" to tell process "git403" to get name of every menu item of menu 1 of menu bar item "${m}" of menu bar 1`).trim().split(", ").filter((x) => x !== "missing value");
    front();
    await until(() => bar().includes("Repository"), "메뉴 막대가 UI 메뉴로 교체", 15000); // 시작 직후엔 Rust 기본 메뉴
    eq(bar().slice(1), ["git403", "File", "Edit", "Repository", "View", "Window", "Help"], "최상위 메뉴 순서");
    eq(items("Repository"), [
      "Fetch", "Pull", "Pull with options…", "Push", "Push with options…", "New branch…", "Stash…", "Pop stash", "Save snapshot (keep changes)",
      "Create pull request…", "Add remote…", "Apply patch…", "Repository statistics…", "Add submodule…", "Add worktree…",
    ], "Repository 항목");
    eq(items("File").slice(0, 4), ["Open repository…", "Clone repository…", "New repository…", "Find repositories in folder…"], "File 앞부분");
    eq(osa('tell application "System Events" to tell process "git403" to get enabled of menu item "Fetch" of menu 1 of menu bar item "Repository" of menu bar 1'), "true", "저장소가 열려 있으면 Fetch 활성");
    osa('tell application "System Events" to tell process "git403" to click menu item "Quick launch" of menu 1 of menu bar item "Help" of menu bar 1');
    await js(`
      const d = await waitFor(() => $$('[role=dialog]').find((d) => d.getAttribute("aria-label") === "Quick launch"), "빠른 실행 팔레트");
      d.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await waitFor(() => !$$('[role=dialog]').some((x) => x.getAttribute("aria-label") === "Quick launch"), "팔레트 닫힘");
    `);
  });

  await step("창 닫기: 닫기 버튼은 앱을 끝내지 않고 창만 숨긴다(탭 유지), Dock 아이콘(reopen)으로 다시 보인다", async () => {
    const wins = () => Number(osa('tell application "System Events" to count windows of process "git403"'));
    front();
    await until(() => wins() === 1, "창 1개");
    // ⌘W는 저장소 탭부터 닫는다(main.tsx closeKey) → 창 숨기기는 빨간 닫기 버튼으로 본다
    osa('tell application "System Events" to tell process "git403" to click (first button of window 1 whose subrole is "AXCloseButton")');
    await until(() => wins() === 0, "닫기 버튼 뒤 창 숨김");
    eq(await js(`return 1 + 1;`), 2, "앱 프로세스는 살아 있어 응답한다");
    osa('tell application "System Events" to tell process "Dock" to click UI element "git403" of list 1'); // Dock 아이콘 클릭 = reopen
    await until(() => wins() === 1, "reopen 뒤 창 다시 보임");
    await js(`await waitFor(() => byText(".commits .subject", "a를 바꿈"), "창을 다시 띄워도 그래프 그대로");`);
    front();
  });

  await step("외부 diff 도구: 커밋 상세 파일 우클릭(네이티브 메뉴) → 커밋 전후 파일로 difftool 실행", async () => {
    await js(`
      press(byText(".commits .subject", "a를 바꿈"));
      rightClick(await waitFor(() => $$(".details [role=option]").find((o) => o.textContent.includes("a.txt")), "상세의 a.txt"));
    `);
    await pickMenu("Open in external diff tool");
    await until(() => existsSync(join(out, "remote")), "difftool 실행");
    eq(readFileSync(join(out, "local"), "utf8"), "old\n", "왼쪽 = 부모 커밋");
    eq(readFileSync(join(out, "remote"), "utf8"), "new\n", "오른쪽 = 커밋");
    await js(`await waitFor(() => byText(".toast *", "external diff tool finished"), "종료 알림");`);
  });

  await step("외부 merge 도구: 충돌 파일을 mergetool로 해결하면 해결됨으로 바뀐다", async () => {
    git("checkout", "-q", "-b", "other", "HEAD~2");
    writeFileSync(join(repo, "c.txt"), "theirs\n");
    git("commit", "-qam", "상대 쪽");
    git("checkout", "-q", "main");
    writeFileSync(join(repo, "c.txt"), "mine\n");
    git("commit", "-qam", "내 쪽");
    try { git("merge", "other"); } catch {} // 충돌로 실패한다
    await js(`
      press(await waitFor(() => byText(".commits .subject", "Local changes"), "Local changes 행"));
      press(await waitFor(() => $$("[role=option]").find((o) => o.textContent.includes("c.txt")), "충돌 파일 c.txt"));
      press(await waitFor(() => $$("button").find((b) => b.textContent === "External merge tool"), "External merge tool 버튼"));
      await waitFor(() => byText(".toast *", "external merge tool finished"), "종료 알림");
    `);
    eq(readFileSync(join(out, "base"), "utf8"), "base\n", "도구가 공통 조상을 받음");
    eq(readFileSync(join(repo, "c.txt"), "utf8"), "resolved\n", "해결된 내용");
    eq(git("diff", "--name-only", "--diff-filter=U"), "", "충돌 없음");
    git("commit", "-q", "--no-edit");
  });

  await step("askpass: Push가 사용자명·비밀번호를 물어 인증 http 원격에 올린다", async () => {
    await js(toolbar("Push"));
    await answerAuth("Username", USER);
    await answerAuth("Password", PASS);
    await until(() => bare("rev-parse", "main") === git("rev-parse", "HEAD"), "원격 main = HEAD", 20000);
  });

  await step("askpass: 틀린 비밀번호면 Push가 실패를 알리고 원격은 그대로", async () => {
    const before = bare("rev-parse", "main");
    git("commit", "-q", "--allow-empty", "-m", "올리지 못할 커밋");
    const fails = seen.gitAuthFails;
    await js(toolbar("Push"));
    await answerAuth("Username", USER);
    await answerAuth("Password", "wrong");
    await until(() => seen.gitAuthFails > fails, "서버가 틀린 인증을 받음");
    await js(`await waitFor(() => $$(".toast").some((t) => /Authentication failed|401/i.test(t.textContent)), "실패 알림", 20000);`);
    eq(bare("rev-parse", "main"), before, "원격 그대로");
  });

  await step("askpass: Pull이 인증을 물어 원격의 새 커밋을 받는다", async () => {
    const other = join(work, "other");
    execFileSync("git", ["clone", "-q", join(served, "remote.git"), other]);
    execFileSync("git", ["-C", other, "-c", "user.name=O", "-c", "user.email=o@x", "commit", "-q", "--allow-empty", "-m", "원격에서 온 커밋"]);
    execFileSync("git", ["-C", other, "push", "-q", "origin", "main"]);
    git("reset", "-q", "--hard", "origin/main"); // 올리지 못한 커밋은 버린다 (빨리 감기 Pull)
    await js(toolbar("Pull"));
    await answerAuth("Username", USER);
    await answerAuth("Password", PASS);
    await until(() => git("log", "-1", "--format=%s") === "원격에서 온 커밋", "Pull로 받음", 20000);
    await js(`await waitFor(() => byText(".commits .subject", "원격에서 온 커밋"), "그래프에 표시");`);
  });

  await step("키체인: 계정 연결은 토큰을 OS 키체인에만 저장하고, 다시 실행해도 남아 있고, 삭제(네이티브 확인)하면 지운다", async () => {
    await js(`
      document.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true }));
      press(await waitFor(() => $('[role=tab]#stab-accounts'), "Accounts 탭"));
      const form = await waitFor(() => $('form[aria-label="Accounts"]'), "계정 폼");
      fill(form.querySelector("select"), "5");
      fill(await waitFor(() => [...form.querySelectorAll(".sitem")].find((r) => r.querySelector(".sitem-name")?.textContent === "Host")?.querySelector("input"), "Host 칸"), ${JSON.stringify(HTTP)});
      fill(form.querySelector('input[type=password]'), ${JSON.stringify(TOKEN)});
      press(await waitFor(() => [...form.querySelectorAll("button[type=submit]")].find((b) => !b.disabled), "Connect"));
      await waitFor(() => byText('.accounts li', "e2e-user") || form.querySelector("[role=alert]"), "목록에 계정");
      if (form.querySelector("[role=alert]")) throw new Error(form.querySelector("[role=alert]").textContent);
    `);
    eq(seen.apiToken, `token ${TOKEN}`, "서버가 토큰을 받음");
    eq(inKeychain(), true, "키체인에 항목");
    const leaked = (dir) => readdirSync(dir).some((f) => { const p = join(dir, f); return f !== "Keychains" && (statSync(p).isDirectory() ? leaked(p) : readFileSync(p).includes(TOKEN)); });
    eq(leaked(home), false, "앱 설정 파일에 토큰이 없음");

    await app.quit();
    app.launch([repo]);
    await js(`await waitFor(() => $(".toolbar"), "툴바");`);
    front();
    eq(inKeychain(), true, "다시 실행 후에도 키체인에 항목");
    await js(`await window.__TAURI_INTERNALS__.invoke("pr_list", { account: { provider: "gitea", host: ${JSON.stringify(HTTP)}, username: "e2e-user" }, repo: { host: "127.0.0.1", owner: "o", name: "n" } });`);
    eq(seen.prToken, `token ${TOKEN}`, "다시 실행한 앱이 키체인에서 꺼낸 토큰");
    await js(`
      document.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true }));
      press(await waitFor(() => $('[role=tab]#stab-accounts'), "Accounts 탭"));
      const b = await waitFor(() => $$('.accounts li button').find((b) => b.getAttribute("aria-label")?.includes("e2e-user")), "삭제 버튼");
      setTimeout(() => press(b), 0);
    `);
    await sleep(1000);
    osa('tell application "System Events" to key code 36'); // 네이티브 확인 대화상자의 기본 버튼
    await until(() => !inKeychain(), "키체인에서 삭제");
    await js(`await waitFor(() => !byText('.accounts li', "e2e-user"), "목록에서 사라짐");`);
  });

  await step("자동 업데이트: 새 버전 알림 → 다운로드 → 서명이 안 맞는 파일은 설치하지 않고 실패를 알린다", async () => {
    await js(`localStorage.removeItem("updateCheckedAt"); setTimeout(() => location.reload(), 0);`); // 하루 한 번 기록을 지워 시작 직후 확인이 돌게
    await sleep(1000);
    await js(`
      await waitFor(() => byText(".banner", "Version 99.0.0 is available"), "업데이트 알림", 20000);
      press(byText(".banner button", "Update and restart"));
      await waitFor(() => byText(".banner", "Update failed"), "서명 검증 실패", 20000);
    `);
    eq(seen.update > 0, true, "업데이트 파일을 내려받음");
    eq(app.proc.exitCode, null, "앱은 그대로 실행 중");
  });
} finally {
  if (saved) await js(`localStorage.clear(); for (const [k, v] of Object.entries(${saved})) localStorage.setItem(k, v);`).catch(() => {});
  app.proc?.kill();
  execFileSync("pbcopy", { input: clipboard });
  server.close();
  rmSync(work, { recursive: true, force: true });
}
finish();
