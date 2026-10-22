import { expect, test, type Page } from "@playwright/test";
import { cleanJiraKeys, cleanJiraUrl, jiraRule, jiraSuggest } from "../src/shared/lib/issues";
import { addTemplate, clampLimit, GIT_SETTINGS_RE, IGNORE_TEMPLATES, parseConfig, pullConfig, pullMode, validEmail } from "../src/shared/lib/settings";

// 로드맵 17단계: 설정 창 (일반·Git·계정·도구·gitignore·SSH 키·이슈 링크)
const calls = (page: Page) => page.evaluate(() => (window as any).__git as string[][]);
const callsOf = async (page: Page, name: string) => (await calls(page)).filter((c) => c[0] === name);
const configCalls = async (page: Page) => (await calls(page)).filter((c) => c[0] === "config");
const dlg = (page: Page) => page.getByRole("dialog", { name: "설정" });
const tab = (page: Page, name: string) => dlg(page).getByRole("tab", { name, exact: true });
const open = async (page: Page, name?: string, flags: Record<string, unknown> = {}) => {
  await page.addInitScript((f) => Object.assign(window, f), flags);
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
  if (name) {
    await page.keyboard.press("ControlOrMeta+,");
    await tab(page, name).click();
  }
};

// ---- 순수 로직 ----
test("이메일 형식 검증", () => {
  for (const ok of ["a@b.co", "first.last+tag@sub.example.com"]) expect(validEmail(ok), ok).toBe(true);
  for (const bad of ["", "a", "a@b", "a@b.", "@b.co", "a b@c.co", "a@@b.co", "a@b..co"]) expect(validEmail(bad), bad).toBe(false);
});

test("pull 모드 ↔ pull.rebase·pull.ff 변환", () => {
  expect(pullConfig("merge")).toEqual(["false", null]);
  expect(pullConfig("rebase")).toEqual(["true", null]);
  expect(pullConfig("ff-only")).toEqual(["false", "only"]);
  expect(pullConfig("default")).toEqual([null, null]);
  expect(pullMode(undefined, undefined)).toBe("default");
  expect(pullMode("false", undefined)).toBe("merge");
  expect(pullMode("true", undefined)).toBe("rebase");
  expect(pullMode("false", "only")).toBe("ff-only");
  for (const m of ["default", "merge", "rebase", "ff-only"] as const) {
    const [r, f] = pullConfig(m);
    expect(pullMode(r ?? undefined, f ?? undefined)).toBe(m);
  }
});

test("설정값 파싱·그래프 상한 보정·gitignore 템플릿", () => {
  expect(parseConfig("user.name 홍 길동\nuser.email a@b.co\nuser.name 나중 값\n")).toEqual({ "user.name": "나중 값", "user.email": "a@b.co" });
  expect(clampLimit("abc")).toBe(20000);
  expect(clampLimit(5)).toBe(100);
  expect(clampLimit(9e9)).toBe(200000);
  expect(clampLimit("1500.4")).toBe(1500);
  expect(new RegExp(GIT_SETTINGS_RE).test("init.defaultbranch")).toBe(true);
  expect(Object.keys(IGNORE_TEMPLATES)).toEqual(["Node", "Rust", "Python", "macOS", "Windows", "JetBrains", "VSCode"]);
  const a = addTemplate("", "Rust");
  expect(a).toEqual({ text: "# Rust\ntarget/\n**/*.rs.bk\n*.pdb\n", added: true });
  const b = addTemplate("dist/", "macOS");
  expect(b.text.startsWith("dist/\n\n# macOS\n.DS_Store")).toBe(true);
  expect(addTemplate(b.text, "macOS")).toEqual({ text: b.text, added: false }); // 같은 템플릿은 두 번 넣지 않는다
  expect(addTemplate("x\n", "Node").text.startsWith("x\n\n# Node\n")).toBe(true);
});

// ---- 열기 ----
test("⌘/Ctrl+, 로 열고 Esc로 닫는다. 모든 탭이 열린다", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+,");
  await expect(dlg(page)).toBeVisible();
  await expect(tab(page, "일반")).toHaveAttribute("aria-selected", "true");
  const names = ["일반", "도구", "Git", "gitignore", "이슈 링크", "계정", "SSH 키", "AI"]; // 묶음 순서: 앱 · 저장소 · 연결
  await expect(dlg(page).getByRole("tab")).toHaveText(names);
  const panels: Record<string, string> = {
    일반: "테마", Git: "사용자 (전역)", 계정: "토큰", AI: "전송 동의", 도구: "터미널 앱", gitignore: "이 저장소의 .gitignore", "SSH 키": "새 키 만들기", "이슈 링크": "이슈 링크 규칙",
  };
  for (const n of names) {
    await tab(page, n).click();
    await expect(tab(page, n)).toHaveAttribute("aria-selected", "true");
    await expect(dlg(page).getByRole("tabpanel")).toContainText(panels[n]);
  }
  // 화살표로 탭 이동
  await tab(page, "AI").focus();
  await page.keyboard.press("ArrowDown");
  await expect(tab(page, "일반")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(dlg(page)).toHaveCount(0);
  // 저장소 없이도 열린다 (메뉴 진입점)
  await page.locator(".toolbar").getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "설정…" }).click();
  await expect(dlg(page)).toBeVisible();
  await dlg(page).locator(".sheet-actions").getByRole("button", { name: "닫기" }).click();
  await expect(dlg(page)).toHaveCount(0);
});

test("저장소가 없어도 단축키로 열리고 Git 전역 설정을 읽는다", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("저장소를 열어 시작하세요")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+,");
  await tab(page, "Git").click();
  await expect(dlg(page).getByLabel("전역 이름")).toHaveValue("데모 사용자");
  await expect(dlg(page).getByText("저장소를 열면 이 저장소에만 적용할 이름·이메일")).toBeVisible();
});

// ---- 일반 ----
test("일반: 테마·탭 복원·그래프 상한·자동 fetch가 저장된다", async ({ page }) => {
  await open(page, "일반");
  const d = dlg(page);
  await d.getByLabel("테마").selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await d.getByLabel("테마").selectOption("system");
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);

  await expect(d.getByLabel("시작할 때 마지막 탭 복원")).toBeChecked();
  await expect(d.getByLabel(/그래프 커밋 개수 상한/)).toHaveValue("20000");
  await expect.poll(() => page.evaluate(() => (window as any).__graphLimit)).toBe(5000);
  // 처음 읽는 개수는 한 페이지(5000)고 설정값은 상한이다
  // 입력만으로는 반영되지 않는다 (blur 포함). 적용 버튼으로 범위 밖은 보정되고 저장소를 다시 읽는다
  await d.getByLabel(/그래프 커밋 개수 상한/).fill("5");
  await d.getByLabel(/그래프 커밋 개수 상한/).blur();
  expect(await page.evaluate(() => (window as any).__graphLimit)).toBe(5000);
  expect(await page.evaluate(() => localStorage.getItem("graphLimit"))).toBeNull();
  await d.getByRole("button", { name: "적용" }).click();
  await expect(d.getByLabel(/그래프 커밋 개수 상한/)).toHaveValue("100");
  await expect.poll(() => page.evaluate(() => (window as any).__graphLimit)).toBe(100);
  await d.getByLabel(/그래프 커밋 개수 상한/).fill("3000");
  await d.getByLabel(/그래프 커밋 개수 상한/).press("Enter");
  await expect.poll(() => page.evaluate(() => (window as any).__graphLimit)).toBe(3000);

  await d.getByLabel("자동 Fetch 간격").selectOption("10");
  expect(await page.evaluate(() => ["graphLimit", "autoFetch", "restoreTabs"].map((k) => localStorage.getItem(k)))).toEqual(["3000", "10", null]);
  await d.getByLabel("시작할 때 마지막 탭 복원").uncheck();
  expect(await page.evaluate(() => localStorage.getItem("restoreTabs"))).toBe("false");
});

test("그래프 상한: Esc로 닫으면 입력 중이던 값은 반영되지 않는다", async ({ page }) => {
  await open(page, "일반");
  await dlg(page).getByLabel(/그래프 커밋 개수 상한/).fill("500");
  await page.keyboard.press("Escape");
  await expect(dlg(page)).toHaveCount(0);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => [(window as any).__graphLimit, localStorage.getItem("graphLimit")])).toEqual([5000, null]);
  await page.keyboard.press("ControlOrMeta+,");
  await expect(dlg(page).getByLabel(/그래프 커밋 개수 상한/)).toHaveValue("20000");
});

test("시작할 때 마지막 탭 복원을 끄면 빈 화면으로 시작한다", async ({ page }) => {
  await open(page, "일반");
  await dlg(page).getByLabel("시작할 때 마지막 탭 복원").uncheck();
  await page.reload();
  await expect(page.getByText("저장소를 열어 시작하세요")).toBeVisible();
  await expect(page.getByRole("tablist", { name: "열린 저장소" })).toHaveCount(0);
  // 다시 켜면 복원
  await page.keyboard.press("ControlOrMeta+,");
  await dlg(page).getByLabel("시작할 때 마지막 탭 복원").check();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "저장소 열기" }).first().click();
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
  await page.reload();
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
});

test("자동 fetch: 간격마다 활성 탭을 fetch하고, 원격 작업 중이면 건너뛰고, 끄면 멈춘다", async ({ page }) => {
  await page.clock.install();
  await open(page, "일반", { __job: { ms: 8 * 60_000 } });
  const fetches = async () => (await callsOf(page, "start_job")).filter((c) => JSON.parse(c[1]).args[0] === "fetch");
  await dlg(page).getByLabel("자동 Fetch 간격").selectOption("5");
  await page.keyboard.press("Escape"); // 시트가 열려 있으면 자동 fetch는 건너뛴다
  await page.clock.runFor(4 * 60_000);
  expect(await fetches()).toHaveLength(0);
  await page.clock.runFor(61_000);
  const first = await fetches();
  expect(first).toHaveLength(1);
  expect(JSON.parse(first[0][1])).toEqual({ repo: "/demo/git403", args: ["fetch", "--all", "--prune", "--progress"], interactive: false }); // 인증 창 없는 비대화 실행
  // 10분 시점: 첫 작업(5분 시작, 8분 소요 = 13분 종료)이 아직 돌고 있어 건너뜀
  await page.clock.runFor(5 * 60_000);
  expect(await fetches()).toHaveLength(1);
  // 15분 시점: 13분에 끝났으므로 다시 fetch
  await page.clock.runFor(5 * 60_000);
  expect(await fetches()).toHaveLength(2);
  // 끄면 더 이상 안 한다
  await page.clock.runFor(14 * 60_000); // 진행 중이던 작업 정리
  await page.keyboard.press("ControlOrMeta+,");
  await dlg(page).getByLabel("자동 Fetch 간격").selectOption("0");
  await page.keyboard.press("Escape");
  const n = (await fetches()).length;
  await page.clock.runFor(60 * 60_000);
  expect(await fetches()).toHaveLength(n);
});

test("자동 fetch: 시트가 열려 있으면 건너뛴다", async ({ page }) => {
  await page.clock.install();
  await open(page, "일반");
  await dlg(page).getByLabel("자동 Fetch 간격").selectOption("5");
  await page.clock.runFor(11 * 60_000); // 설정 창이 열린 채
  expect(await callsOf(page, "start_job")).toHaveLength(0);
  await page.keyboard.press("Escape");
  await page.clock.runFor(5 * 60_000);
  expect(await callsOf(page, "start_job")).toHaveLength(1);
});

test("자동 fetch: 실패는 배너 없이 상태바에만, 연속 실패는 한 번만 알리고 재조회하지 않는다", async ({ page }) => {
  await page.clock.install();
  await open(page, "일반", { __job: { early: true, err: "fatal: Authentication failed" } });
  await dlg(page).getByLabel("자동 Fetch 간격").selectOption("5");
  await page.keyboard.press("Escape");
  const graphCalls = () => page.evaluate(() => (window as any).__renders.CommitGraph as number);
  const before = await graphCalls();
  await page.clock.runFor(5 * 60_000 + 500);
  await page.clock.runFor(1000);
  await expect(page.locator(".toast", { hasText: "자동 Fetch 실패" })).toContainText("fatal: Authentication failed");
  await expect(page.getByRole("alert")).toHaveCount(0);
  // 사용자가 다른 메시지를 띄운 뒤 또 실패해도 다시 알리지 않는다
  await page.evaluate(() => (window as any).__emit("job", { job: 0, event: { kind: "progress", line: "other" } }));
  await page.clock.runFor(5 * 60_000 + 500);
  expect((await callsOf(page, "start_job")).length).toBe(2);
  await expect(page.locator(".status-progress")).toHaveText("other"); // 새 알림이 없어 진행률 줄이 그대로
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await graphCalls()).toBe(before); // 전체 재조회 없음
});

test("자동 fetch가 도는 중 사용자가 Fetch를 누르면 자동 작업은 취소되고 사용자 작업이 실행된다", async ({ page }) => {
  await page.clock.install();
  await open(page, "일반", { __job: { ms: 8 * 60_000 } });
  await dlg(page).getByLabel("자동 Fetch 간격").selectOption("5");
  await page.keyboard.press("Escape");
  await page.clock.runFor(5 * 60_000 + 500);
  expect(await callsOf(page, "start_job")).toHaveLength(1);
  // 툴바 Fetch 버튼은 잠기지 않는다
  await page.locator(".toolbar").getByRole("button", { name: "Fetch", exact: true }).click();
  await expect.poll(async () => (await callsOf(page, "start_job")).length).toBe(2);
  expect(await callsOf(page, "cancel_job")).toHaveLength(1);
  const [auto, user] = (await callsOf(page, "start_job")).map((c) => JSON.parse(c[1]));
  expect(auto.interactive).toBe(false);
  expect(user.interactive).toBeUndefined(); // 사용자 작업은 인증 창을 쓴다
  // 밀려난 자동 작업의 완료 이벤트가 와도 사용자 작업 상태를 건드리지 않는다
  await page.evaluate(() => (window as any).__emit("job-done", [1, "Cancelled"]));
  await expect(page.getByRole("button", { name: "Fetch 취소" })).toBeVisible();
});

test("자동 fetch: 저장소가 없으면 아무것도 하지 않는다", async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  await expect(page.getByText("저장소를 열어 시작하세요")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+,");
  await dlg(page).getByLabel("자동 Fetch 간격").selectOption("5");
  await page.clock.runFor(11 * 60_000);
  expect(await callsOf(page, "start_job")).toHaveLength(0);
});

// ---- Git ----
test("Git: 전역 이름·이메일·기본 브랜치·pull 기본값 저장은 config --global 인자로 간다", async ({ page }) => {
  await open(page, "Git");
  const d = dlg(page);
  await expect(d.getByLabel("전역 이메일")).toHaveValue("demo@example.com");
  await expect(d.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  await d.getByLabel("전역 이름").fill("새 이름");
  await d.getByLabel("전역 이메일").fill("new@example.com");
  await d.getByLabel("기본 브랜치 이름").fill("main");
  await d.getByLabel("Pull 기본 동작").selectOption("ff-only");
  await d.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.locator(".toast", { hasText: "Git 설정 저장됨" }).first()).toBeVisible();
  expect(await configCalls(page)).toEqual([
    ["config", "--global", "user.name", "새 이름"],
    ["config", "--global", "user.email", "new@example.com"],
    ["config", "--global", "init.defaultBranch", "main"],
    ["config", "--global", "pull.rebase", "false"],
    ["config", "--global", "pull.ff", "only"],
  ]);
  // 저장 뒤 다시 읽어도 같은 값, 저장 버튼은 다시 꺼진다
  await expect(d.getByLabel("Pull 기본 동작")).toHaveValue("ff-only");
  await expect(d.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  // rebase로 바꾸면 ff는 삭제
  await d.getByLabel("Pull 기본 동작").selectOption("rebase");
  await d.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(async () => (await configCalls(page)).slice(5)).toEqual([
    ["config", "--global", "pull.rebase", "true"],
    ["config", "--global", "--unset", "pull.ff"],
  ]);
});

test("Git: 이메일 형식이 틀리면 저장하지 않고 안내한다", async ({ page }) => {
  await open(page, "Git");
  const d = dlg(page);
  await d.getByLabel("전역 이메일").fill("not-an-email");
  await d.getByLabel("전역 이름").fill("바뀜");
  await d.getByRole("button", { name: "저장", exact: true }).click();
  await expect(d.getByRole("alert")).toContainText("전역 이메일 형식이 올바르지 않습니다");
  expect(await configCalls(page)).toEqual([]);
  await d.getByLabel("저장소 이메일").fill("x@y");
  await d.getByLabel("전역 이메일").fill("ok@example.com");
  await d.getByRole("button", { name: "저장", exact: true }).click();
  await expect(d.getByRole("alert")).toContainText("이 저장소 이메일 형식이 올바르지 않습니다");
  await d.getByLabel("저장소 이메일").fill("repo@example.com");
  await d.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.locator(".toast", { hasText: "Git 설정 저장됨" }).first()).toBeVisible();
  expect(await configCalls(page)).toEqual([
    ["config", "--global", "user.name", "바뀜"],
    ["config", "--global", "user.email", "ok@example.com"],
    ["config", "--local", "user.email", "repo@example.com"],
  ]);
});

test("Git: 저장소 덮어쓰기(--local)는 비우면 unset, 비운 전역 값도 unset", async ({ page }) => {
  await open(page, "Git", { __cfg: { global: { "user.name": "전역", "user.email": "g@example.com" }, local: { "user.name": "로컬", "user.email": "l@example.com" } } });
  const d = dlg(page);
  await expect(d.getByLabel("저장소 이름")).toHaveValue("로컬");
  await expect(d.getByLabel("저장소 이름")).toHaveAttribute("placeholder", "전역");
  await d.getByLabel("저장소 이름").fill("");
  await d.getByLabel("전역 이메일").fill("");
  await d.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.locator(".toast", { hasText: "Git 설정 저장됨" }).first()).toBeVisible();
  expect(await configCalls(page)).toEqual([
    ["config", "--global", "--unset", "user.email"],
    ["config", "--local", "--unset", "user.name"],
  ]);
  await expect(d.getByLabel("저장소 이름")).toHaveValue("");
  await expect(d.getByLabel("저장소 이메일")).toHaveValue("l@example.com");
});

test("Git: 커밋 서명은 상태만 보여 준다 (읽기 전용)", async ({ page }) => {
  await open(page, "Git");
  await expect(dlg(page).getByLabel("커밋 서명 상태")).toContainText("꺼짐");
  await page.evaluate(() => Object.assign((window as any).__cfg.global, { "commit.gpgsign": "true", "gpg.format": "ssh", "user.signingkey": "~/.ssh/id_ed25519.pub" }));
  await tab(page, "일반").click();
  await tab(page, "Git").click();
  await expect(dlg(page).getByLabel("커밋 서명 상태")).toContainText("켜짐 (ssh, 키 ~/.ssh/id_ed25519.pub)");
  await expect(dlg(page).getByRole("button", { name: /서명/ })).toHaveCount(0);
});

// ---- 계정·도구·이슈 (기존 시트 재사용) ----
test("계정 탭: 기존 계정 목록·연결 폼이 들어 있다", async ({ page }) => {
  await open(page, "계정");
  await expect(dlg(page).getByRole("list", { name: "연결된 계정" })).toContainText("GitHub · demo-user");
});

test("도구 탭: 현재 값을 보여 주고 기존 시트를 연 뒤 설정 창으로 돌아온다", async ({ page }) => {
  await open(page, "도구");
  const d = dlg(page);
  await expect(d).toContainText("diff: meld · merge: meld");
  await d.getByRole("button", { name: "터미널 앱…" }).click();
  const t = page.getByRole("dialog", { name: "터미널 앱" });
  await t.getByRole("combobox").selectOption({ index: 1 });
  await t.getByRole("button", { name: "저장" }).click();
  await expect(d.getByRole("tabpanel")).not.toContainText("기본값");
  await page.keyboard.press("Escape"); // 시트가 닫힌 뒤에도 포커스가 설정 창에 돌아와 Esc가 먹는다
  await expect(dlg(page)).toHaveCount(0);
});

// ---- gitignore ----
test("gitignore: 저장소 .gitignore를 고쳐 저장하고 템플릿을 붙인다", async ({ page }) => {
  await open(page, "gitignore");
  const ed = dlg(page).getByLabel(".gitignore", { exact: true });
  await expect(ed).toHaveValue("node_modules/\n");
  const save = dlg(page).getByRole("button", { name: "저장" }).first();
  await expect(save).toBeDisabled();
  await ed.fill("node_modules/\n*.log\n");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.locator(".toast", { hasText: ".gitignore 저장됨" }).first()).toBeVisible();
  expect(await callsOf(page, "ignore_write")).toEqual([["ignore_write", "node_modules/\n*.log\n"]]);
  await expect(save).toBeDisabled();

  await dlg(page).getByLabel(".gitignore 템플릿").selectOption("Rust");
  await dlg(page).getByRole("button", { name: "템플릿 추가" }).first().click();
  await expect(ed).toHaveValue("node_modules/\n*.log\n\n# Rust\ntarget/\n**/*.rs.bk\n*.pdb\n");
  // 저장 전에는 파일이 바뀌지 않았다
  expect(await callsOf(page, "ignore_write")).toHaveLength(1);
  await dlg(page).getByRole("button", { name: "템플릿 추가" }).first().click();
  await expect(page.locator(".toast", { hasText: "Rust 템플릿이 이미 있습니다" }).first()).toBeVisible();
  await save.click();
  expect((await callsOf(page, "ignore_write"))[1][1]).toContain("# Rust\ntarget/");
});

test("gitignore: 전역 excludesfile이 없으면 ~/.gitignore_global을 만들고 설정한 뒤 편집·저장", async ({ page }) => {
  await open(page, "gitignore");
  const d = dlg(page);
  await expect(d).toContainText("설정돼 있지 않습니다");
  await d.getByRole("button", { name: "~/.gitignore_global 만들고 설정" }).click();
  await expect(d).toContainText("core.excludesFile = /home/demo/.gitignore_global");
  expect(await callsOf(page, "global_ignore_ensure")).toHaveLength(1);
  expect(await configCalls(page)).toEqual([["config", "--global", "core.excludesFile", "/home/demo/.gitignore_global"]]);
  const ed = d.getByLabel("전역 ignore", { exact: true });
  await expect(ed).toHaveValue("");
  await d.getByLabel("전역 ignore 템플릿").selectOption("macOS");
  await d.getByRole("button", { name: "템플릿 추가" }).last().click();
  await d.getByRole("button", { name: "저장" }).last().click();
  await expect(page.locator(".toast", { hasText: "전역 ignore 저장됨" }).first()).toBeVisible();
  expect(await callsOf(page, "global_ignore_write")).toEqual([["global_ignore_write", "/home/demo/.gitignore_global", expect.stringMatching(/^# macOS\n\.DS_Store/)]]);
  // 다시 열어도 설정이 유지된다 (이미 있으면 만들기 버튼 없음)
  await tab(page, "일반").click();
  await tab(page, "gitignore").click();
  await expect(d.getByLabel("전역 ignore", { exact: true })).toHaveValue(/# macOS/);
  expect(await callsOf(page, "global_ignore_ensure")).toHaveLength(1);
});

test("gitignore: 저장소 밖 경로 같은 오류는 편집기 아래에 표시된다", async ({ page }) => {
  await open(page, "gitignore", { __cfg: { global: { "core.excludesfile": "/etc/passwd_ignore" }, local: {} } });
  await expect(dlg(page).getByRole("alert")).toContainText("홈 폴더 밖 경로입니다");
});

// ---- SSH 키 ----
test("SSH 키: 목록(이름·유형·지문)과 공개키 복사, 비공개키 내용은 오지 않는다", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__clip = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: (t: string) => ((window as any).__clip.push(t), Promise.resolve()) }, configurable: true });
  });
  await open(page, "SSH 키");
  const list = dlg(page).getByRole("list", { name: "SSH 공개키" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list.getByRole("listitem").first()).toContainText("id_ed25519.pub");
  await expect(list.getByRole("listitem").first()).toContainText("ED25519 256");
  await expect(list.getByRole("listitem").first()).toContainText("SHA256:Zk3qA9mP");
  await expect(list.getByRole("listitem").nth(1)).toContainText("RSA 3072");
  await dlg(page).getByRole("button", { name: "id_rsa.pub 공개키 복사" }).click();
  await expect(page.locator(".toast", { hasText: "복사함" }).first()).toBeVisible();
  expect(await page.evaluate(() => (window as any).__clip)).toEqual(["ssh-rsa AAAAB3NzaC1yc2EAAAADemoRsaKey old-laptop"]);
  // 화면에 비공개키 흔적이 없다
  await expect(dlg(page)).not.toContainText("PRIVATE KEY");
});

test("SSH 키: 새 ed25519 키는 이메일을 코멘트로 만들고, 같은 이름은 거부한다", async ({ page }) => {
  await open(page, "SSH 키");
  const d = dlg(page);
  // 기본 이름은 겹치지 않게, 코멘트는 git 이메일
  await expect(d.getByLabel("키 파일 이름")).toHaveValue("id_ed25519_2");
  await expect(d.getByLabel("키 코멘트")).toHaveValue("demo@example.com");
  // 암호 불일치
  await d.getByLabel("키 암호", { exact: true }).fill("pw1");
  await d.getByLabel("키 암호 확인").fill("pw2");
  await d.getByRole("button", { name: "키 만들기" }).click();
  await expect(d.getByRole("alert")).toContainText("암호가 서로 다릅니다");
  expect(await callsOf(page, "ssh_generate")).toHaveLength(0);
  // 생성
  await d.getByLabel("키 파일 이름").fill("work");
  await d.getByLabel("키 암호 확인").fill("pw1");
  await d.getByRole("button", { name: "키 만들기" }).click();
  await expect(page.locator(".toast").first()).toBeVisible();
  expect((await callsOf(page, "ssh_generate")).map((c) => JSON.parse(c[1]))).toEqual([{ name: "work", passphrase: "pw1", comment: "demo@example.com" }]);
  await expect(d.getByRole("list", { name: "SSH 공개키" })).toContainText("work.pub");
  await expect(d.getByRole("alert")).toHaveCount(0);
  await expect(d).toContainText("ssh-add");
  await expect(d).toContainText("~/.ssh/work");
  // 입력한 암호는 지워진다
  await expect(d.getByLabel("키 암호", { exact: true })).toHaveValue("");
  // 이미 있는 이름은 거부 (덮어쓰기 없음)
  await d.getByLabel("키 파일 이름").fill("id_rsa");
  await d.getByRole("button", { name: "키 만들기" }).click();
  await expect(d.getByRole("alert")).toContainText("id_rsa 키 파일이 이미 있습니다");
  expect(await callsOf(page, "ssh_generate")).toHaveLength(1);
  await expect(d.getByRole("list", { name: "SSH 공개키" }).getByRole("listitem")).toHaveCount(3);
});

test("SSH 키: macOS가 아니면 keychain 옵션 없는 ssh-add 안내", async ({ page }) => {
  await open(page, "SSH 키");
  await dlg(page).getByLabel("키 파일 이름").fill("k1");
  await dlg(page).getByRole("button", { name: "키 만들기" }).click();
  const hint = dlg(page).getByRole("status").filter({ hasText: "ssh-add" });
  const isMac = await page.evaluate(() => /Mac/i.test(navigator.userAgent));
  await expect(hint).toContainText(isMac ? "ssh-add --apple-use-keychain ~/.ssh/k1" : "ssh-add ~/.ssh/k1");
});

// ---- 이슈 링크 ----
test("이슈 링크 탭: 규칙 목록과 편집 시트 진입", async ({ page }) => {
  await open(page, "이슈 링크", { __issue: { "git403.issue.0.regex": "ABC-\\d+", "git403.issue.0.url": "https://jira.example.com/browse/$&" } });
  const list = dlg(page).getByRole("list", { name: "이슈 링크 규칙 목록" });
  await expect(list).toContainText("ABC-\\d+");
  await expect(list).toContainText("자동"); // GitHub 원격의 #123 자동 규칙
  await dlg(page).getByRole("button", { name: "이슈 링크 규칙…" }).click();
  await expect(page.getByRole("dialog", { name: "이슈 링크 규칙" })).toBeVisible();
  await page.getByRole("dialog", { name: "이슈 링크 규칙" }).getByRole("button", { name: "취소" }).click();
  await expect(dlg(page)).toBeVisible();
});

test("일반: 강조색을 고르면 --accent가 바뀌고 저장된다, 시스템으로 되돌린다", async ({ page }) => {
  await open(page, "일반");
  const group = dlg(page).getByRole("radiogroup", { name: "강조색" });
  await expect(group.getByRole("radio", { name: "시스템" })).toHaveAttribute("aria-checked", "true");
  await group.getByRole("radio", { name: "보라" }).click();
  await expect(group.getByRole("radio", { name: "보라" })).toHaveAttribute("aria-checked", "true");
  const accent = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  expect(await accent()).toBe("#7a5bd0");
  expect(await page.evaluate(() => localStorage.getItem("accent"))).toBe("purple");
  await group.getByRole("radio", { name: "시스템" }).click();
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--accent"))).toBe("");
});

// ---- Jira ----
const jiraDlg = (page: Page) => dlg(page).getByRole("form", { name: "Jira" });
const rulesList = (page: Page) => dlg(page).getByRole("list", { name: "이슈 링크 규칙 목록" });
const jiraLog = "ABC-34 작업 큐 추가\n\nABC-34 본문\nhttps://jira.acme.test/jira/browse/ABC-12 참고\n\nABC-35 다른 작업\nUTF-8 UTF-8\nXYZ-1 한 번만\n";
const SHOTS = "e2e/results/screens";
const subjectLinks = async (page: Page) => {
  await page.keyboard.press("Escape");
  await page.locator(".commits").getByText("작업 큐 추가").click();
  return page.locator(".info-subject").getByRole("link");
};

test("Jira 순수 로직: 주소·키 검증, 규칙 생성, 추천 후보", () => {
  expect(cleanJiraUrl(" https://jira.acme.test/ ")).toBe("https://jira.acme.test");
  expect(cleanJiraUrl("https://x.test/jira//")).toBe("https://x.test/jira");
  expect(cleanJiraUrl("")).toBe("");
  for (const bad of ["http://x.test", "jira.acme.test", "https://x test", "https://x.test/?a=1", "ftp://x"]) expect(cleanJiraUrl(bad), bad).toBeNull();
  expect(cleanJiraKeys("ABC, DEF2 ,ABC")).toBe("ABC,DEF2");
  expect(cleanJiraKeys("")).toBe("");
  for (const bad of ["abc", "A", "1AB", "AB-C", "ABC;DEF"]) expect(cleanJiraKeys(bad), bad).toBeNull();
  expect(jiraRule(null)).toBeNull();
  expect(jiraRule({ url: "", keys: "ABC" })).toBeNull();
  expect(jiraRule({ url: "https://j.test", keys: "ABC,DEF" })).toEqual({ id: "jira", regex: "\\b(ABC|DEF)-\\d+\\b", url: "https://j.test/browse/$&" });
  expect(jiraRule({ url: "https://j.test", keys: "" })!.regex).toBe("\\b[A-Z][A-Z0-9]+-\\d+\\b");
  // 추천: 경로 접두 포함 주소, 2회 이상 나온 키(UTF 제외) 상위 3, 브랜치 이름도 센다
  expect(jiraSuggest(jiraLog, [], ["feature/ABC-99-x"])).toEqual({ url: "https://jira.acme.test/jira", keys: ["ABC"] });
  expect(jiraSuggest("", ["문서 https://co.atlassian.net/ 참고"], [])).toEqual({ url: "https://co.atlassian.net", keys: [] });
  expect(jiraSuggest("MEL-1 MEL-2 a", [], [])).toEqual({ url: "", keys: ["MEL"] });
  expect(jiraSuggest("http://old.test/browse/AB-1 SHA-256 SHA-1", [], [])).toBeNull();
});

const scopeRadio = (page: Page, name: RegExp) => jiraDlg(page).getByRole("radiogroup", { name: "저장 범위" }).getByRole("radio", { name });
const origin = (page: Page) => jiraDlg(page).getByLabel("Jira 값 출처");
const jiraKeys = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).filter(([k]) => k.startsWith("git403.jira.")));

test("Jira: 기본값이 없다 — 입력란은 비어 있고 규칙·링크도 없고, 저장 범위 기본은 이 저장소만", async ({ page }) => {
  await open(page, "이슈 링크");
  await expect(jiraDlg(page).getByLabel("Jira 주소", { exact: true })).toHaveValue("");
  await expect(jiraDlg(page).getByLabel("프로젝트 키", { exact: true })).toHaveValue("");
  await expect(origin(page)).toHaveText("설정되지 않음");
  await expect(scopeRadio(page, /이 저장소만/)).toBeChecked();
  await expect(scopeRadio(page, /모든 저장소/)).not.toBeChecked();
  await expect(jiraDlg(page).getByRole("status")).toHaveCount(0);
  await expect(jiraDlg(page).getByRole("button", { name: "전역 값 삭제" })).toHaveCount(0);
  await expect(rulesList(page)).not.toContainText("browse");
  expect((await configCalls(page)).filter((c) => c.join(" ").includes("jira"))).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).__jiraG ?? {})).toEqual({});
});

test("Jira: 입력 검증 → 이 저장소에 저장(--local, 전역 파일은 안 건드림) → 규칙 생성 → 커밋 제목에 링크, 키를 비우면 모든 KEY-123", async ({ page }) => {
  await open(page, "이슈 링크");
  const f = jiraDlg(page);
  await f.getByLabel("Jira 주소", { exact: true }).fill("http://jira.acme.test");
  await f.getByRole("button", { name: "저장" }).click();
  await expect(f.getByRole("alert")).toContainText("https://");
  await f.getByLabel("Jira 주소", { exact: true }).fill("https://jira.acme.test/");
  await f.getByLabel("프로젝트 키", { exact: true }).fill("abc");
  await f.getByRole("button", { name: "저장" }).click();
  await expect(f.getByRole("alert")).toContainText("대문자");
  expect((await configCalls(page)).filter((c) => c.join(" ").includes("jira"))).toHaveLength(0);
  await f.getByLabel("프로젝트 키", { exact: true }).fill("XYZ");
  await f.getByRole("button", { name: "저장" }).click();
  await expect(f.getByRole("alert")).toHaveCount(0);
  expect(jiraKeys(await page.evaluate(() => (window as any).__issue))).toEqual({ "git403.jira.url": "https://jira.acme.test", "git403.jira.keys": "XYZ" });
  expect(await page.evaluate(() => (window as any).__jiraG ?? {})).toEqual({}); // 전역(~/.gitconfig)은 건드리지 않는다
  expect((await configCalls(page)).every((c) => !c.includes("--global"))).toBe(true);
  await expect(origin(page)).toHaveText("이 저장소 값");
  await expect(rulesList(page)).toContainText("\\b(XYZ)-\\d+\\b");
  await expect(rulesList(page)).toContainText("https://jira.acme.test/browse/$&");
  let links = await subjectLinks(page);
  await expect(links).toHaveCount(1);
  await expect(links.first()).toHaveText("#12");
  await page.keyboard.press("ControlOrMeta+,");
  await tab(page, "이슈 링크").click();
  await jiraDlg(page).getByLabel("프로젝트 키", { exact: true }).fill("");
  await jiraDlg(page).getByRole("button", { name: "저장" }).click();
  await expect(rulesList(page)).toContainText("\\b[A-Z][A-Z0-9]+-\\d+\\b");
  links = await subjectLinks(page);
  await expect(links).toHaveCount(2);
  await expect(links.filter({ hasText: "ABC-34" })).toHaveAttribute("href", "https://jira.acme.test/browse/ABC-34");
  await links.filter({ hasText: "ABC-34" }).click();
  await expect.poll(async () => (await callsOf(page, "open_url")).at(-1)?.[1]).toBe("https://jira.acme.test/browse/ABC-34");
});

test("Jira: 모든 저장소를 고르면 --global(~/.gitconfig)에 저장하고, 선택은 기억되며, 전역 값 삭제는 확인 뒤 지운다", async ({ page }, info) => {
  await open(page, "이슈 링크");
  const f = jiraDlg(page);
  await expect(f).toContainText("~/.gitconfig에 저장됩니다");
  await scopeRadio(page, /모든 저장소/).check();
  await f.getByLabel("Jira 주소", { exact: true }).fill("https://jira.acme.test");
  await f.getByLabel("프로젝트 키", { exact: true }).fill("ABC");
  await f.getByRole("button", { name: "저장" }).click();
  expect(await page.evaluate(() => (window as any).__jiraG)).toEqual({ "git403.jira.url": "https://jira.acme.test", "git403.jira.keys": "ABC" });
  expect(jiraKeys(await page.evaluate(() => (window as any).__issue))).toEqual({});
  await expect(origin(page)).toHaveText("전역 값 사용 중");
  await expect(rulesList(page)).toContainText("https://jira.acme.test/browse/$&");
  await page.screenshot({ path: `${SHOTS}/jira-scope-${info.project.name}.png` });
  expect(await page.evaluate(() => localStorage.getItem("jiraScope"))).toBe("global");
  // 다시 열면 마지막 선택
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+,");
  await tab(page, "이슈 링크").click();
  await expect(scopeRadio(page, /모든 저장소/)).toBeChecked();
  await expect(jiraDlg(page).getByLabel("Jira 주소", { exact: true })).toHaveValue("https://jira.acme.test");
  // 전역 값 삭제
  await jiraDlg(page).getByRole("button", { name: "전역 값 삭제" }).click();
  await expect(origin(page)).toHaveText("설정되지 않음");
  expect(await page.evaluate(() => (window as any).__jiraG)).toEqual({});
  await expect(rulesList(page)).not.toContainText("browse");
  await expect(jiraDlg(page).getByRole("button", { name: "전역 값 삭제" })).toHaveCount(0);
});

test("Jira: 저장소를 열지 않았으면 전역만 가능하다는 안내", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "저장소 열기" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+,");
  await tab(page, "이슈 링크").click();
  const f = jiraDlg(page);
  await expect(f).toContainText("저장소를 열지 않아 모든 저장소(~/.gitconfig)에만 저장");
  await expect(f.getByRole("radiogroup", { name: "저장 범위" })).toHaveCount(0);
  await f.getByLabel("Jira 주소", { exact: true }).fill("https://jira.acme.test");
  await f.getByRole("button", { name: "저장" }).click();
  expect(await page.evaluate(() => (window as any).__jiraG)).toEqual({ "git403.jira.url": "https://jira.acme.test" });
});

test("Jira: 사용자 규칙 → Jira → #123 순서", async ({ page }) => {
  await open(page, "이슈 링크", { __jiraG: { "git403.jira.url": "https://jira.acme.test" }, __issue: { "git403.issue.0.regex": "ABC-\\d+", "git403.issue.0.url": "https://mine.test/$&" } });
  const items = rulesList(page).getByRole("listitem");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText("https://mine.test/$&");
  await expect(items.nth(1)).toContainText("https://jira.acme.test/browse/$&");
  await expect(items.nth(2)).toContainText("자동");
  const links = await subjectLinks(page);
  await expect(links.filter({ hasText: "ABC-34" })).toHaveAttribute("href", "https://mine.test/ABC-34");
});

test("Jira: 전역 값 위에 이 저장소 값으로 덮어쓰기·끄기, 비우면 전역 값으로 돌아간다", async ({ page }) => {
  await open(page, "이슈 링크", { __jiraG: { "git403.jira.url": "https://jira.acme.test", "git403.jira.keys": "ABC" } });
  const f = jiraDlg(page);
  await expect(origin(page)).toHaveText("전역 값 사용 중");
  await expect(scopeRadio(page, /이 저장소만/)).toBeChecked();
  await expect(f.getByLabel("Jira 주소", { exact: true })).toHaveAttribute("placeholder", "https://jira.acme.test");
  await f.getByLabel("Jira 주소", { exact: true }).fill("https://other.test/jira");
  await f.getByLabel("프로젝트 키", { exact: true }).fill("QQ");
  await f.getByRole("button", { name: "저장" }).click();
  await expect(origin(page)).toHaveText("전역 값을 이 저장소에서 덮어씀");
  await expect(rulesList(page)).toContainText("https://other.test/jira/browse/$&");
  await expect(rulesList(page)).toContainText("\\b(QQ)-\\d+\\b");
  expect(jiraKeys(await page.evaluate(() => (window as any).__issue))).toEqual({ "git403.jira.url": "https://other.test/jira", "git403.jira.keys": "QQ" });
  expect((await page.evaluate(() => (window as any).__jiraG))["git403.jira.url"]).toBe("https://jira.acme.test");
  await f.getByLabel("Jira 주소", { exact: true }).fill("");
  await f.getByLabel("프로젝트 키", { exact: true }).fill("");
  await f.getByRole("button", { name: "저장" }).click();
  await expect(origin(page)).toHaveText("전역 값 사용 중");
  await expect(rulesList(page)).toContainText("https://jira.acme.test/browse/$&");
  expect(await page.evaluate(() => (window as any).__issue)).toEqual({});
  let links = await subjectLinks(page);
  await expect(links.filter({ hasText: "ABC-34" })).toHaveAttribute("href", "https://jira.acme.test/browse/ABC-34");
  await page.keyboard.press("ControlOrMeta+,");
  await tab(page, "이슈 링크").click();
  await jiraDlg(page).getByLabel("이 저장소에서 Jira 링크 끄기").check();
  await jiraDlg(page).getByRole("button", { name: "저장" }).click();
  await expect(origin(page)).toHaveText("이 저장소에서 Jira 링크가 꺼져 있습니다");
  await expect(rulesList(page)).not.toContainText("browse");
  expect(await page.evaluate(() => (window as any).__issue)).toEqual({ "git403.jira.off": "true" });
  expect((await page.evaluate(() => (window as any).__jiraG))["git403.jira.url"]).toBe("https://jira.acme.test");
  links = await subjectLinks(page);
  await expect(links).toHaveCount(1);
});

test("Jira 추천: 로그의 주소·키 → 안내줄, 자동 저장 없음, 적용하면 선택한 범위(기본 이 저장소)에 저장", async ({ page }, info) => {
  await open(page, "이슈 링크", { __jiraLog: jiraLog, __jiraDocs: { "README.md": "문서" } });
  const bar = jiraDlg(page).getByRole("status");
  await expect(bar).toContainText("이 저장소는 https://jira.acme.test/jira의 ABC 이슈를 쓰는 것 같습니다.");
  expect((await configCalls(page)).filter((c) => c.join(" ").includes("jira"))).toHaveLength(0);
  await page.screenshot({ path: `${SHOTS}/jira-suggest-${info.project.name}.png` });
  await bar.getByRole("button", { name: "적용" }).click();
  await expect(jiraDlg(page).getByLabel("Jira 주소", { exact: true })).toHaveValue("https://jira.acme.test/jira");
  await expect(jiraDlg(page).getByLabel("프로젝트 키", { exact: true })).toHaveValue("ABC");
  await expect(bar).toHaveCount(0);
  expect(jiraKeys(await page.evaluate(() => (window as any).__issue))).toEqual({ "git403.jira.url": "https://jira.acme.test/jira", "git403.jira.keys": "ABC" });
  expect(await page.evaluate(() => (window as any).__jiraG ?? {})).toEqual({}); // 전역에 자동으로 쓰지 않는다
  await expect(origin(page)).toHaveText("이 저장소 값");
  await expect(rulesList(page)).toContainText("https://jira.acme.test/jira/browse/$&");
  await page.screenshot({ path: `${SHOTS}/jira-${info.project.name}.png` });
});

test("Jira 추천: 저장 범위를 '모든 저장소'로 고른 상태면 적용도 전역에 쓴다", async ({ page }) => {
  await open(page, "이슈 링크", { __jiraLog: jiraLog });
  await expect(jiraDlg(page).getByRole("status")).toBeVisible();
  await scopeRadio(page, /모든 저장소/).check();
  await jiraDlg(page).getByRole("status").getByRole("button", { name: "적용" }).click();
  expect(await page.evaluate(() => (window as any).__jiraG)).toEqual({ "git403.jira.url": "https://jira.acme.test/jira", "git403.jira.keys": "ABC" });
  expect(jiraKeys(await page.evaluate(() => (window as any).__issue))).toEqual({});
});

test("Jira 추천: 전역 Jira가 이미 있으면 추천하지 않는다", async ({ page }) => {
  await open(page, "이슈 링크", { __jiraLog: jiraLog, __jiraG: { "git403.jira.url": "https://g.test" } });
  await expect(jiraDlg(page).getByRole("status")).toHaveCount(0); // 이미 설정됨 → 추천 없음
});

test("Jira 추천: 무시하면 이 저장소는 다시 묻지 않는다 (저장소별 기억)", async ({ page }) => {
  await open(page, "이슈 링크", { __jiraLog: jiraLog });
  await jiraDlg(page).getByRole("status").getByRole("button", { name: "무시" }).click();
  await expect(jiraDlg(page).getByRole("status")).toHaveCount(0);
  expect((await configCalls(page)).filter((c) => c.join(" ").includes("jira"))).toHaveLength(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+,");
  await tab(page, "이슈 링크").click();
  await expect(jiraDlg(page).getByLabel("Jira 주소", { exact: true })).toBeVisible();
  await page.waitForTimeout(200);
  await expect(jiraDlg(page).getByRole("status")).toHaveCount(0);
});

test("Jira 추천: 키만 보이면 주소 입력 안내, 아무것도 없으면 안내줄 없음", async ({ page }) => {
  await open(page, "이슈 링크", { __jiraLog: "MEL-1 a\nMEL-2 b\nMEL-3 c\n" });
  const bar = jiraDlg(page).getByRole("status");
  await expect(bar).toContainText("MEL-123 같은 키가 보입니다. Jira 주소를 입력하면 링크가 됩니다.");
  await bar.getByRole("button", { name: "키 채우기" }).click();
  await expect(jiraDlg(page).getByLabel("프로젝트 키", { exact: true })).toHaveValue("MEL");
  expect(await page.evaluate(() => (window as any).__jiraG ?? {})).toEqual({}); // 채우기만, 저장 아님
});

test("Jira 추천: 아무것도 없는 저장소는 안내줄이 없다", async ({ page }) => {
  await open(page, "이슈 링크");
  await expect(jiraDlg(page).getByLabel("Jira 주소", { exact: true })).toBeVisible();
  await page.waitForTimeout(200);
  await expect(jiraDlg(page).getByRole("status")).toHaveCount(0);
});

test("이슈 링크: 전역에 Jira off가 있어도 저장소(--local) 값이 있으면 그 저장소 기준으로 규칙이 만들어진다(--global·--local 따로 읽기)", async ({ page }) => {
  await open(page, "이슈 링크", { __jiraG: { "git403.jira.off": "true" }, __issue: { "git403.jira.url": "https://jira.acme.test", "git403.jira.keys": "ABC" } });
  await expect(rulesList(page)).toContainText("https://jira.acme.test/browse/$&");
});

// ---- 설정 내보내기·가져오기 ----
const impDlg = (page: Page) => page.getByRole("dialog", { name: "설정 가져오기" });
const openGeneral = async (page: Page, flags: Record<string, unknown> = {}) => {
  await open(page, "일반", flags);
  await expect(dlg(page).getByRole("button", { name: "설정 가져오기…" })).toBeVisible();
};
const importUntilSheet = async (page: Page) => {
  await dlg(page).getByRole("button", { name: "설정 가져오기…" }).click();
  await expect(impDlg(page)).toBeVisible();
};

test("내보내기: ui 인자는 허용 목록 키만(저장소별 키 없음), 기본 이름 git403-settings.json", async ({ page }) => {
  await page.addInitScript(() => {
    for (const [k, v] of Object.entries({ theme: "dark", graphLimit: "3000", "cols:hidden": '["date"]', "split:side": "280", "prr.listCollapsed": "1", customCommands: "[]", "hidden:/demo/git403": '["x"]', eolDeclined: '["/demo"]', jiraDismissed: "[]", jiraScope: "global", updateCheckedAt: "1" })) localStorage.setItem(k, v);
  });
  await openGeneral(page);
  await dlg(page).getByRole("button", { name: "설정 내보내기…" }).click();
  await expect(page.locator(".toast")).toContainText("/demo/git403-settings.json");
  const [c] = await callsOf(page, "settings_export_file");
  const a = JSON.parse(c[1]) as { ui: Record<string, string>; path: string };
  expect(a.path).toBe("/demo/git403-settings.json");
  expect(a.ui.theme).toBe("dark");
  expect(a.ui.graphLimit).toBe("3000");
  expect(a.ui["cols:hidden"]).toBe('["date"]');
  expect(a.ui["split:side"]).toBe("280");
  expect(a.ui["prr.listCollapsed"]).toBe("1");
  for (const k of Object.keys(a.ui)) expect(k, k).not.toMatch(/^(hidden:|eolDeclined$|jiraDismissed$|jiraScope$|updateCheckedAt$)/);
});

test("내보내기·가져오기 대화상자 취소는 조용하다", async ({ page }) => {
  await openGeneral(page, { __dialog: { save: null, open: null } });
  await dlg(page).getByRole("button", { name: "설정 내보내기…" }).click();
  await dlg(page).getByRole("button", { name: "설정 가져오기…" }).click();
  await page.waitForTimeout(200);
  expect(await callsOf(page, "settings_export_file")).toHaveLength(0);
  expect(await callsOf(page, "settings_import_preview")).toHaveLength(0);
  await expect(impDlg(page)).toHaveCount(0);
  await expect(page.locator(".toast")).toHaveCount(0);
  await expect(dlg(page).getByRole("alert")).toHaveCount(0);
});

test("가져오기: 미리보기(섹션·변경 n건·펼침·skipped·warnings·셸 경고)와 선택 적용이 localStorage·앱에 반영된다", async ({ page }, info) => {
  await openGeneral(page);
  await importUntilSheet(page);
  const d = impDlg(page);
  for (const [l, n] of [["앱 환경설정", 3], ["AI 설정", 1], ["호스팅 계정", 1], ["전역 git403 git 설정", 1], ["외부 diff·merge 도구", 1]] as const) {
    await expect(d.getByRole("checkbox", { name: l })).toBeChecked();
    await expect(d.locator(".imp-section", { hasText: l })).toContainText(`변경 ${n}건`);
  }
  await expect(d).toContainText("더 새 버전 git403이 만든 파일입니다");
  await expect(d).toContainText("건너뜀: hidden:/demo/other");
  await expect(d).toContainText("실행 가능한 명령이 포함됨");
  await expect(d).toContainText("도구 이름만 가져옵니다");
  await d.locator(".imp-section", { hasText: "앱 환경설정" }).getByText("변경 내용 보기").click();
  await expect(d).toContainText("theme: light → dark");
  await expect(d).toContainText("graphLimit: 20000 → 3000");
  await page.screenshot({ path: `${SHOTS}/settings-import-preview-${info.project.name}.png` });
  // 선택 적용: 계정·도구·Git은 빼고 화면·AI만
  for (const l of ["호스팅 계정", "전역 git403 git 설정", "외부 diff·merge 도구"]) await d.getByRole("checkbox", { name: l }).uncheck();
  await d.getByRole("button", { name: "선택한 항목 가져오기" }).click();
  await expect(d.getByRole("status")).toContainText("백업: /demo/backup/git403-settings-before.json");
  const [c] = await callsOf(page, "settings_import_apply");
  expect((JSON.parse(c[1]) as { sections: string[] }).sections).toEqual(["ui", "ai"]);
  expect(await page.evaluate(() => [localStorage.getItem("theme"), localStorage.getItem("graphLimit"), localStorage.getItem("split:side")])).toEqual(["dark", "3000", "300"]);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark"); // 앱 상태 반영
  await expect(d).toContainText("다시 시작한 뒤 적용");
  await expect(d.getByRole("button", { name: "계정 설정 열기" })).toHaveCount(0); // reconnect 없음
  await page.screenshot({ path: `${SHOTS}/settings-import-done-${info.project.name}.png` });
});

test("가져오기: 계정이 들어 있으면 다시 연결 안내와 계정 설정 열기 버튼", async ({ page }, info) => {
  await openGeneral(page);
  await importUntilSheet(page);
  await impDlg(page).getByRole("button", { name: "선택한 항목 가져오기" }).click();
  await expect(impDlg(page)).toContainText("계정 다시 연결 필요: octo@github.com");
  await page.screenshot({ path: `${SHOTS}/settings-import-reconnect-${info.project.name}.png` });
  await impDlg(page).getByRole("button", { name: "계정 설정 열기" }).click();
  await expect(impDlg(page)).toHaveCount(0);
  await expect(tab(page, "계정")).toHaveAttribute("aria-selected", "true");
});

test("가져오기: 닫기·Escape는 적용하지 않고, 아무것도 선택하지 않으면 적용 버튼이 막힌다", async ({ page }) => {
  await openGeneral(page);
  await importUntilSheet(page);
  for (const l of ["앱 환경설정", "AI 설정", "호스팅 계정", "전역 git403 git 설정", "외부 diff·merge 도구"]) await impDlg(page).getByRole("checkbox", { name: l }).uncheck();
  await expect(impDlg(page).getByRole("button", { name: "선택한 항목 가져오기" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(impDlg(page)).toHaveCount(0);
  await expect(dlg(page)).toBeVisible(); // 설정 창은 그대로
  expect(await callsOf(page, "settings_import_apply")).toHaveLength(0);
});

test("가져오기: 바꿀 내용이 없으면 안내, 읽기·미리보기·적용 오류는 화면에 보인다", async ({ page }) => {
  await openGeneral(page, { __settingsPreview: { version: 1, sections: [], skipped: [], warnings: [] } });
  await importUntilSheet(page);
  await expect(impDlg(page)).toContainText("바꿀 내용이 없습니다");
  await page.keyboard.press("Escape");
  // 미리보기 오류(토큰 모양 값): 시트 없이 설정 창 안에 오류
  await page.evaluate(() => ((window as any).__settingsFail = { preview: "토큰처럼 보이는 값이 있어 가져올 수 없습니다: ghp_***" }));
  await dlg(page).getByRole("button", { name: "설정 가져오기…" }).click();
  await expect(dlg(page).getByRole("alert")).toContainText("토큰처럼 보이는 값이 있어");
  await expect(impDlg(page)).toHaveCount(0);
  // 적용 오류: 시트 안에 오류, 시트는 유지
  await page.evaluate(() => ((window as any).__settingsFail = { apply: "백업을 만들 수 없습니다" }, (window as any).__settingsPreview = undefined));
  await dlg(page).getByRole("button", { name: "설정 가져오기…" }).click();
  await impDlg(page).getByRole("button", { name: "선택한 항목 가져오기" }).click();
  await expect(impDlg(page).getByRole("alert").filter({ hasText: "백업을 만들 수 없습니다" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("graphLimit"))).toBeNull();
});

test("가져오기: 언어 설정이 바로 앱 문구에 반영된다(허용 목록 밖 키는 무시)", async ({ page }) => {
  await openGeneral(page, { __settingsApplied: { applied: ["ui"], backup: "/demo/b.json", ui: { language: '"en"', "hidden:/demo/git403": '["x"]' }, reconnect: [], skipped: [] } });
  await importUntilSheet(page);
  await impDlg(page).getByRole("button", { name: "선택한 항목 가져오기" }).click();
  await expect(page.getByRole("dialog", { name: "Import settings" })).toContainText("Backup: /demo/b.json");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  expect(await page.evaluate(() => [localStorage.getItem("language"), localStorage.getItem("hidden:/demo/git403")])).toEqual(['"en"', null]);
});

// ---- 레이아웃: VS Code 설정 화면식(제목 → 설명 → 컨트롤, 카드 없음) ----
test("설정 레이아웃: 제목줄·검색칸·항목 세로 배치·고정 폭 컨트롤", async ({ page }) => {
  await open(page, "일반");
  const d = dlg(page);
  await expect(d.locator(".sheet-head")).toContainText("설정");
  await expect(d.locator(".sheet-actions").getByRole("button", { name: "닫기" })).toBeVisible();
  await expect(d.getByLabel("설정 검색")).toBeVisible();
  await expect(d.locator(".settings-title")).toHaveText("일반");
  expect(await d.locator(".sgroup").count()).toBeGreaterThanOrEqual(5); // 모양·시작·Diff·업데이트·백업
  const panel = (await d.getByRole("tabpanel").boundingBox())!;
  for (const l of ["테마", "자동 Fetch 간격"]) {
    const w = (await d.getByLabel(l).boundingBox())!.width;
    expect(w, l).toBeLessThanOrEqual(320);
    expect(w, l).toBeGreaterThanOrEqual(120);
  }
  // 컨트롤은 제목·설명 아래 왼쪽 정렬
  const item = d.locator(".sitem", { hasText: "자동 Fetch 간격" });
  const name = (await item.locator(".sitem-name").boundingBox())!;
  const desc = (await item.locator(".sitem-desc").boundingBox())!;
  const sel = (await d.getByLabel("자동 Fetch 간격").boundingBox())!;
  expect(desc.y).toBeGreaterThan(name.y);
  expect(sel.y).toBeGreaterThan(desc.y);
  expect(Math.abs(sel.x - name.x)).toBeLessThan(4);
  expect(sel.x + sel.width).toBeLessThan(panel.x + panel.width / 2 + 200);
  // 항목 hover/포커스 시 왼쪽 강조선
  await item.hover();
  expect(await item.evaluate((el) => getComputedStyle(el).borderLeftColor)).not.toBe("rgba(0, 0, 0, 0)");
  // 버튼도 제목·설명 있는 항목, 업데이트 확인은 자동 확인 항목 안
  await expect(d.locator(".sitem", { hasText: "업데이트 자동 확인" }).getByRole("button", { name: "지금 확인" })).toBeVisible();
  for (const n of ["Git", "계정", "AI", "도구", "gitignore", "SSH 키", "이슈 링크"]) {
    await tab(page, n).click();
    await expect(d.locator(".settings-title")).toHaveText(n);
  }
});

test("설정 검색: 모든 탭 항목을 제목·설명으로 거르고, 지우면 원래 탭으로 돌아온다", async ({ page }) => {
  await open(page, "Git");
  const d = dlg(page);
  const q = d.getByLabel("설정 검색");
  await q.fill("fetch");
  expect(await d.locator(".sitem").count()).toBeGreaterThan(0);
  await expect(d.getByLabel("자동 Fetch 간격")).toBeVisible();
  await expect(d.locator(".settings-title:visible").first()).toHaveText("일반"); // 일치한 항목이 있는 탭 제목만
  await q.fill("이메일");
  await expect(d.getByLabel("전역 이메일")).toBeVisible();
  await expect(d.getByLabel("자동 Fetch 간격")).toHaveCount(0);
  await q.fill("zzzz없는설정");
  await expect(d.locator(".sitem")).toHaveCount(0);
  await expect(d.getByText("일치하는 설정이 없습니다")).toBeVisible();
  // 설명에서도 찾는다: Diff 줄바꿈 설명
  await q.fill("CR");
  expect(await d.locator(".sitem").count()).toBeGreaterThan(0);
  // Esc: 검색어부터 지우고(창은 유지), 한 번 더 누르면 닫힌다
  await q.press("Escape");
  await expect(q).toHaveValue("");
  await expect(dlg(page)).toBeVisible();
  await expect(d.locator(".settings-title")).toHaveText("Git");
  await q.press("Escape");
  await expect(dlg(page)).toHaveCount(0);
});

test("설정 레이아웃: 좁은 창에서도 가로 넘침 없음", async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 700 });
  await open(page, "일반");
  const p = dlg(page).getByRole("tabpanel");
  expect(await p.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  for (const n of ["Git", "AI", "SSH 키"]) {
    await tab(page, n).click();
    expect(await p.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), n).toBe(true);
  }
});

// 시각 확인용: 탭마다 라이트·다크(프로젝트 light·dark) (결과: e2e/results/screens/settings-<탭>-<테마>.png)
test("설정 스크린샷: 모든 탭", async ({ page }, info) => {
  await open(page, "일반");
  const ids: Record<string, string> = { 일반: "general", Git: "git", 계정: "accounts", AI: "ai", 도구: "tools", gitignore: "ignore", "SSH 키": "ssh", "이슈 링크": "issues" };
  for (const [n, id] of Object.entries(ids)) {
    await tab(page, n).click();
    await page.waitForTimeout(150);
    await dlg(page).screenshot({ path: `e2e/results/screens/settings-${id}-${info.project.name}.png` });
  }
});
