import { expect, test, type Page } from "@playwright/test";

// 로드맵 12단계: Git Flow (feature · release · hotfix)
const gitCalls = (page: Page) => page.evaluate(() => (window as any).__git as string[][]);
const menuItem = (page: Page, name: string | RegExp) => page.getByRole("menu").getByRole("menuitem", { name });
const FLOW = { "gitflow.branch.master": "main", "gitflow.branch.develop": "develop", "gitflow.prefix.feature": "feature/", "gitflow.prefix.release": "release/", "gitflow.prefix.hotfix": "hotfix/", "gitflow.prefix.versiontag": "v" };

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
});

/** 설정이 있는 상태로 다시 읽기 */
async function initialized(page: Page) {
  await page.evaluate((f) => ((window as any).__flow = { ...f }, (window as any).__clean = true), FLOW);
  await page.keyboard.press("ControlOrMeta+r");
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
  // 설정 읽기가 끝날 때까지 (메뉴는 캐시를 보고 만들어진다)
  await expect(async () => {
    await page.locator(".toolbar .picker").first().click();
    await expect(menuItem(page, "Feature 시작…")).toBeVisible({ timeout: 300 });
    await page.keyboard.press("Escape");
  }).toPass();
}
// DOM 메뉴(데모·E2E)는 하위 메뉴를 펼쳐서 보여 준다
const openFlow = (page: Page) => page.locator(".toolbar .picker").first().click();

test("미초기화면 Git Flow 메뉴에 초기화만 있고, 초기화는 설정을 저장하고 develop을 만든다", async ({ page }) => {
  await openFlow(page);
  await expect(menuItem(page, "Feature 시작…")).toHaveCount(0);
  await menuItem(page, "초기화…").click();
  const sheet = page.getByRole("dialog", { name: "Git Flow 초기화" });
  await expect(sheet.getByLabel("운영 브랜치")).toHaveValue("main");
  await expect(sheet.getByLabel("개발 브랜치")).toHaveValue("develop");
  await expect(sheet.getByLabel("버전 태그 접두사")).toHaveValue("");
  await sheet.getByRole("button", { name: "초기화" }).click();
  await expect.poll(async () => (await gitCalls(page)).slice(-7)).toEqual([
    ["branch", "develop", "main"],
    ["config", "gitflow.branch.master", "main"],
    ["config", "gitflow.branch.develop", "develop"],
    ["config", "gitflow.prefix.feature", "feature/"],
    ["config", "gitflow.prefix.release", "release/"],
    ["config", "gitflow.prefix.hotfix", "hotfix/"],
    ["config", "gitflow.prefix.versiontag", ""],
  ]);
  await openFlow(page);
  await expect(menuItem(page, "Feature 시작…")).toBeVisible();
});

test("feature start / finish", async ({ page }) => {
  await initialized(page);
  await openFlow(page);
  await menuItem(page, "Feature 시작…").click();
  await page.getByRole("dialog", { name: "Feature 시작" }).getByLabel("이름").fill("login");
  await page.getByRole("button", { name: "시작" }).click();
  await expect.poll(async () => (await gitCalls(page)).at(-1)).toEqual(["switch", "-c", "feature/login", "develop"]);

  // 사이드바 우클릭: prefix 브랜치에만 Finish가 있다
  const side = page.locator(".sidebar");
  await side.locator('button[title="main"]').click({ button: "right" });
  await expect(menuItem(page, /^Finish/)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await side.locator('button[title="feature/graph"]').click({ button: "right" });
  await menuItem(page, "Finish feature…").click();
  const sheet = page.getByRole("dialog", { name: "Feature 마무리" });
  await sheet.getByRole("button", { name: "마무리" }).click();
  await expect.poll(async () => (await gitCalls(page)).slice(-3)).toEqual([
    ["switch", "develop"],
    ["merge", "--no-ff", "--no-edit", "feature/graph"],
    ["branch", "-d", "feature/graph"],
  ]);
});

test("release start / finish: main 머지 → 태그 → develop 머지 → 삭제", async ({ page }) => {
  await initialized(page);
  await openFlow(page);
  await menuItem(page, "Release 시작…").click();
  await page.getByRole("dialog", { name: "Release 시작" }).getByLabel("버전").fill("1.2.0");
  await page.getByRole("button", { name: "시작" }).click();
  await expect.poll(async () => (await gitCalls(page)).at(-1)).toEqual(["switch", "-c", "release/1.2.0", "develop"]);


  // mock에는 release 브랜치가 없어서 접두사를 바꿔 feature/graph를 release로 취급한다
  await page.evaluate(() => ((window as any).__flow["gitflow.prefix.feature"] = "zzz/", (window as any).__flow["gitflow.prefix.release"] = "feature/"));
  await page.keyboard.press("ControlOrMeta+r");
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
  await page.locator('.sidebar button[title="feature/graph"]').click({ button: "right" });
  await menuItem(page, "Finish release…").click();
  const sheet = page.getByRole("dialog", { name: "Release 마무리" });
  await expect(sheet.getByLabel("태그 메시지")).toHaveValue("Release graph");
  await sheet.getByLabel("태그 메시지").fill("그래프 릴리스");
  await sheet.getByRole("button", { name: "마무리" }).click();
  await expect.poll(async () => (await gitCalls(page)).slice(-6)).toEqual([
    ["switch", "main"],
    ["merge", "--no-ff", "--no-edit", "feature/graph"],
    ["tag", "-a", "-m", "그래프 릴리스", "vgraph"],
    ["switch", "develop"],
    ["merge", "--no-ff", "--no-edit", "feature/graph"],
    ["branch", "-d", "feature/graph"],
  ]);
});

test("hotfix finish는 release와 같은 순서이고 태그 접두사를 쓴다", async ({ page }) => {
  await initialized(page);
  await page.locator('.sidebar button[title="hotfix/pull-lock"]').click({ button: "right" });
  await menuItem(page, "Finish hotfix…").click();
  const sheet = page.getByRole("dialog", { name: "Hotfix 마무리" });
  await expect(sheet.getByLabel("태그 메시지")).toHaveValue("Hotfix pull-lock");
  await sheet.getByLabel("끝나면 브랜치 삭제").uncheck();
  await sheet.getByRole("button", { name: "마무리" }).click();
  await expect.poll(async () => (await gitCalls(page)).slice(-5)).toEqual([
    ["switch", "main"],
    ["merge", "--no-ff", "--no-edit", "hotfix/pull-lock"],
    ["tag", "-a", "-m", "Hotfix pull-lock", "vpull-lock"],
    ["switch", "develop"],
    ["merge", "--no-ff", "--no-edit", "hotfix/pull-lock"],
  ]);
  expect((await gitCalls(page)).filter((c) => c[0] === "branch")).toEqual([]);
});

test("finish 중 충돌이 나면 거기서 멈추고 충돌 해결 바와 남은 단계 안내를 보인다", async ({ page }) => {
  await initialized(page);
  await page.evaluate(() => ((window as any).__gitFail = { prefix: "merge --no-ff --no-edit hotfix/pull-lock", conflict: true }));
  await page.locator('.sidebar button[title="hotfix/pull-lock"]').click({ button: "right" });
  await menuItem(page, "Finish hotfix…").click();
  await page.getByRole("dialog", { name: "Hotfix 마무리" }).getByRole("button", { name: "마무리" }).click();
  await expect(page.getByRole("alert")).toContainText("충돌");
  await expect(page.getByRole("alert")).toContainText("git tag -a -m");
  // 이후 단계(tag, switch develop, branch -d)는 실행되지 않았다
  expect((await gitCalls(page)).map((c) => c[0])).not.toContain("tag");
  await page.evaluate(() => (window as any).__emit("repo-changed", { worktree: true, refs: false }));
  await expect(page.getByText("merge 진행 중입니다")).toBeVisible();
});

test("빠른 실행에 Git Flow 항목이 있다", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByLabel("빠른 실행 검색").fill("git flow");
  await expect(page.getByRole("dialog", { name: "빠른 실행" }).getByRole("option")).toHaveText(["Git Flow: 초기화…"]);
});

const finishHotfix = async (page: Page) => {
  await page.locator('.sidebar button[title="hotfix/pull-lock"]').click({ button: "right" });
  await menuItem(page, "Finish hotfix…").click();
};
const noMerge = async (page: Page) => expect((await gitCalls(page)).filter((c) => ["switch", "merge", "tag"].includes(c[0]))).toEqual([]);

test("작업 트리에 변경이 있으면 start·finish를 거부한다", async ({ page }) => {
  await initialized(page);
  await page.evaluate(() => ((window as any).__clean = false));
  await page.keyboard.press("ControlOrMeta+r");
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
  await finishHotfix(page);
  await expect(page.getByRole("alert")).toContainText("커밋하지 않은 변경");
  await expect(page.getByRole("dialog", { name: "Hotfix 마무리" })).toHaveCount(0);
  await noMerge(page);
});

test("대상 브랜치가 원격보다 뒤처져 있으면 아무 단계도 실행하지 않는다", async ({ page }) => {
  await initialized(page);
  await page.evaluate(() => ((window as any).__behind = { "main..origin/main": 3 }));
  await finishHotfix(page);
  await expect(page.getByRole("alert")).toContainText("main이(가) origin/main보다 3커밋 뒤처져");
  await noMerge(page);
  // start도 기준 브랜치(develop 또는 main)를 확인한다: hotfix 시작은 main 기준
  await openFlow(page);
  await menuItem(page, "Hotfix 시작…").click();
  await page.getByRole("dialog", { name: "Hotfix 시작" }).getByLabel("버전").fill("1.0.1");
  await page.getByRole("button", { name: "시작" }).click();
  await expect(page.getByRole("alert")).toContainText("먼저 Pull");
  expect((await gitCalls(page)).filter((c) => c[0] === "switch")).toEqual([]);
});

test("태그가 이미 있으면 release·hotfix finish를 시작 전에 막는다", async ({ page }) => {
  await initialized(page);
  await page.evaluate(() => ((window as any).__tags = ["vpull-lock"]));
  await finishHotfix(page);
  await expect(page.getByRole("alert")).toContainText("태그 vpull-lock이(가) 이미 있습니다");
  await expect(page.getByRole("dialog", { name: "Hotfix 마무리" })).toHaveCount(0);
  await noMerge(page);
});

test("hotfix finish: 열린 release 브랜치가 있으면 develop 대신 거기에 머지한다", async ({ page }) => {
  await initialized(page);
  // mock에는 release 브랜치가 없어서 접두사를 바꿔 feature/graph를 release로 취급한다
  await page.evaluate(() => ((window as any).__flow["gitflow.prefix.feature"] = "zzz/", (window as any).__flow["gitflow.prefix.release"] = "feature/"));
  await page.keyboard.press("ControlOrMeta+r");
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
  await finishHotfix(page);
  const sheet = page.getByRole("dialog", { name: "Hotfix 마무리" });
  await expect(sheet).toContainText("feature/graph에도 머지");
  await sheet.getByRole("button", { name: "마무리" }).click();
  await expect.poll(async () => (await gitCalls(page)).slice(-6)).toEqual([
    ["switch", "main"],
    ["merge", "--no-ff", "--no-edit", "hotfix/pull-lock"],
    ["tag", "-a", "-m", "Hotfix pull-lock", "vpull-lock"],
    ["switch", "feature/graph"],
    ["merge", "--no-ff", "--no-edit", "hotfix/pull-lock"],
    ["branch", "-d", "hotfix/pull-lock"],
  ]);
});

test("초기화: 운영 브랜치가 로컬에 없으면 제출해도 시트가 남고 아무것도 저장하지 않는다", async ({ page }) => {
  await openFlow(page);
  await menuItem(page, "초기화…").click();
  const sheet = page.getByRole("dialog", { name: "Git Flow 초기화" });
  await sheet.getByLabel("운영 브랜치").fill("master");
  await sheet.getByRole("button", { name: "초기화" }).click();
  await expect(page.getByRole("dialog", { name: "Git Flow 초기화" })).toContainText("'master'이(가) 로컬에 없습니다");
  expect((await gitCalls(page)).filter((c) => c[0] === "config" || c[0] === "branch")).toEqual([]);
});

test("충돌이 아닌 실패는 현재 체크아웃 브랜치를 알려 준다", async ({ page }) => {
  await initialized(page);
  await page.evaluate(() => ((window as any).__gitFail = { prefix: "tag", conflict: false }));
  await finishHotfix(page);
  await page.getByRole("dialog", { name: "Hotfix 마무리" }).getByRole("button", { name: "마무리" }).click();
  await expect(page.getByRole("alert")).toContainText("지금 main에 체크아웃되어 있습니다");
  await expect(page.getByRole("alert")).toContainText("git switch develop");
});
