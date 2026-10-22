import { expect, test, type Page } from "@playwright/test";

// 로드맵 11단계: 서브모듈 · Worktree · Git LFS
const gitCalls = (page: Page) => page.evaluate(() => (window as any).__git as string[][]);
const menuItem = (page: Page, name: string | RegExp) => page.getByRole("menu").getByRole("menuitem", { name });
const side = (page: Page) => page.locator(".sidebar");
const section = (page: Page, title: string) => side(page).locator("section", { has: page.getByRole("button", { name: new RegExp("^" + title) }) });
const jobs = async (page: Page) => (await gitCalls(page)).filter((c) => c[0] === "start_job").map((c) => JSON.parse(c[1]).args as string[]);

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
});

test("서브모듈·Worktree 섹션이 상태와 함께 보인다", async ({ page }) => {
  const sub = section(page, "서브모듈");
  await expect(sub.getByRole("button", { name: /vendor\/libgit/ })).toBeVisible();
  await expect(sub.getByRole("button", { name: /vendor\/theme/ })).toContainText("수정됨");
  await expect(sub.getByRole("button", { name: /docs\/site/ })).toContainText("미초기화");
  const wt = section(page, "Worktree");
  await expect(wt.getByRole("button", { name: "main" })).toBeVisible();
  await expect(wt.getByRole("button", { name: "hotfix/pull-lock" })).toBeVisible();
});

test("서브모듈이 없으면 섹션이 없다", async ({ page }) => {
  await page.evaluate(() => ((window as any).__noModules = true));
  await page.keyboard.press("ControlOrMeta+r");
  await expect(side(page).getByRole("button", { name: /^로컬 브랜치/ })).toBeVisible();
  await expect(side(page).getByRole("button", { name: /^서브모듈/ })).toHaveCount(0);
  await expect(side(page).getByRole("button", { name: /^Worktree/ })).toHaveCount(0);
});

test("서브모듈: 열기·업데이트·동기화·추가·제거", async ({ page }) => {
  const item = (n: RegExp) => section(page, "서브모듈").getByRole("button", { name: n });
  // 더블클릭 = 하위 저장소를 새 탭으로
  await item(/vendor\/libgit/).dblclick();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.locator(".toolbar .picker").first()).toContainText("libgit");

  await item(/vendor\/theme/).click({ button: "right" });
  await menuItem(page, "업데이트").click();
  expect((await jobs(page)).at(-1)).toEqual(["submodule", "update", "--init", "--recursive", "--", "vendor/theme"]);
  await expect(page.locator(".toast", { hasText: "서브모듈 업데이트 완료" }).first()).toBeVisible();

  await side(page).getByRole("button", { name: /^서브모듈/ }).click({ button: "right" });
  await menuItem(page, "모두 업데이트").click();
  expect((await jobs(page)).at(-1)).toEqual(["submodule", "update", "--init", "--recursive"]);
  await expect(page.locator(".toast", { hasText: "서브모듈 업데이트 완료" }).first()).toBeVisible();

  await side(page).getByRole("button", { name: /^서브모듈/ }).click({ button: "right" });
  await menuItem(page, "URL 동기화").click();
  await expect.poll(async () => (await gitCalls(page)).at(-1)).toEqual(["submodule", "sync", "--recursive"]);

  await side(page).getByRole("button", { name: /^서브모듈/ }).click({ button: "right" });
  await menuItem(page, "서브모듈 추가…").click();
  const sheet = page.getByRole("dialog", { name: "서브모듈 추가" });
  await expect(sheet.getByRole("button", { name: "추가" })).toBeDisabled();
  await sheet.getByLabel("URL").fill("https://example.com/lib/extra.git");
  await expect(sheet.getByLabel("경로")).toHaveValue("extra");
  await sheet.getByLabel("경로").fill("vendor/extra");
  await sheet.getByRole("button", { name: "추가" }).click();
  expect((await jobs(page)).at(-1)).toEqual(["submodule", "add", "--", "https://example.com/lib/extra.git", "vendor/extra"]);
});

test("서브모듈 제거는 확인 뒤 deinit과 rm을 실행한다", async ({ page }) => {
  await section(page, "서브모듈").getByRole("button", { name: /vendor\/theme/ }).click({ button: "right" });
  await menuItem(page, "제거…").click();
  // 이름(theme-mod)은 .gitmodules 매핑에서 찾아 .git/modules/theme-mod까지 지운다
  await expect.poll(async () => (await gitCalls(page)).slice(-3)).toEqual([
    ["submodule", "deinit", "-f", "--", "vendor/theme"],
    ["rm", "-f", "--", "vendor/theme"],
    ["remove_git_dir", ".git/modules/theme-mod"],
  ]);
});

test("서브모듈 제거: 확인을 거절하면 아무것도 실행하지 않는다", async ({ page }) => {
  await page.evaluate(() => {
    // 확인창(ask)이 "아니오"를 돌려주게 한다
    const orig = (window as any).__TAURI_INTERNALS__.invoke;
    (window as any).__TAURI_INTERNALS__.invoke = (cmd: string, ...r: unknown[]) => (cmd === "plugin:dialog|message" ? Promise.resolve("No") : orig(cmd, ...r));
  });
  await section(page, "서브모듈").getByRole("button", { name: /vendor\/theme/ }).click({ button: "right" });
  await menuItem(page, "제거…").click();
  await page.waitForTimeout(200);
  expect((await gitCalls(page)).filter((c) => c[0] === "submodule" || c[0] === "rm")).toEqual([]);
});

test("미초기화 서브모듈은 열 수 없다", async ({ page }) => {
  await section(page, "서브모듈").getByRole("button", { name: /docs\/site/ }).dblclick();
  await expect(page.getByRole("tab")).toHaveCount(1);
});

test("Worktree: 열기·잠금·prune, main은 제거 불가", async ({ page }) => {
  const wt = section(page, "Worktree");
  await wt.getByRole("button", { name: "hotfix/pull-lock" }).dblclick();
  await expect(page.getByRole("tab")).toHaveCount(2);
  await expect(page.locator(".toolbar .picker").first()).toContainText("git403-hotfix");

  await wt.getByRole("button", { name: "hotfix/pull-lock" }).click({ button: "right" });
  await menuItem(page, "잠금").click();
  await expect.poll(async () => (await gitCalls(page)).at(-1)).toEqual(["worktree", "lock", "--", "/demo/git403-hotfix"]);

  await wt.getByRole("button", { name: "main" }).click({ button: "right" });
  await expect(menuItem(page, "제거…")).toBeDisabled();
  await expect(menuItem(page, "잠금")).toBeDisabled();
  await page.keyboard.press("Escape");

  await side(page).getByRole("button", { name: /^Worktree/ }).click({ button: "right" });
  await menuItem(page, /prune/).click();
  await expect.poll(async () => (await gitCalls(page)).at(-1)).toEqual(["worktree", "prune"]);
});

test("Worktree 제거: 확인 시트, --force는 별도 옵션", async ({ page }) => {
  const item = () => section(page, "Worktree").getByRole("button", { name: "hotfix/pull-lock" });
  await item().click({ button: "right" });
  await menuItem(page, "제거…").click();
  const sheet = page.getByRole("dialog", { name: "Worktree 제거" });
  await sheet.getByRole("button", { name: "취소" }).click();
  expect((await gitCalls(page)).filter((c) => c[0] === "worktree")).toEqual([]);

  await item().click({ button: "right" });
  await menuItem(page, "제거…").click();
  await sheet.getByRole("button", { name: "제거" }).click();
  await expect.poll(async () => (await gitCalls(page)).at(-1)).toEqual(["worktree", "remove", "--", "/demo/git403-hotfix"]);

  await item().click({ button: "right" });
  await menuItem(page, "제거…").click();
  await sheet.getByLabel(/--force/).check();
  await sheet.getByRole("button", { name: "제거" }).click();
  await expect.poll(async () => (await gitCalls(page)).at(-1)).toEqual(["worktree", "remove", "--force", "--", "/demo/git403-hotfix"]);
});

test("Worktree 추가: 없는 브랜치는 새로, 있는 브랜치는 그대로", async ({ page }) => {
  const add = async () => {
    await side(page).getByRole("button", { name: /^Worktree/ }).click({ button: "right" });
    await menuItem(page, "Worktree 추가…").click();
    return page.getByRole("dialog", { name: "Worktree 추가" });
  };
  let sheet = await add();
  await sheet.getByLabel("위치").fill("/demo/wt-new");
  await sheet.getByLabel("브랜치").fill("feature/wt");
  await sheet.getByRole("button", { name: "추가" }).click();
  await expect.poll(async () => (await gitCalls(page)).at(-1)).toEqual(["worktree", "add", "-b", "feature/wt", "--", "/demo/wt-new"]);

  sheet = await add();
  await sheet.getByLabel("위치").fill("/demo/wt-old");
  await sheet.getByLabel("브랜치").fill("feature/graph");
  await sheet.getByRole("button", { name: "추가" }).click();
  await expect.poll(async () => (await gitCalls(page)).at(-1)).toEqual(["worktree", "add", "--", "/demo/wt-old", "feature/graph"]);

  // 원격에만 있는 브랜치: -b 없이 이름만 (git이 추적 브랜치로 만든다)
  await page.evaluate(() => ((window as any).__remoteOnly = true));
  await page.keyboard.press("ControlOrMeta+r");
  await expect(side(page).getByRole("button", { name: "release", exact: true })).toBeVisible();
  sheet = await add();
  await sheet.getByLabel("위치").fill("/demo/wt-remote");
  await sheet.getByLabel("브랜치").fill("release");
  await sheet.getByRole("button", { name: "추가" }).click();
  await expect.poll(async () => (await gitCalls(page)).at(-1)).toEqual(["worktree", "add", "--", "/demo/wt-remote", "release"]);

  // 비우면 detached
  sheet = await add();
  await sheet.getByLabel("위치").fill("/demo/wt-detached");
  await sheet.getByRole("button", { name: "추가" }).click();
  await expect.poll(async () => (await gitCalls(page)).at(-1)).toEqual(["worktree", "add", "--detach", "--", "/demo/wt-detached"]);
});

test("LFS: 상태 시트에 패턴과 파일이 보이고 패턴을 해제할 수 있다", async ({ page }) => {
  await page.locator(".picker").first().click();
  await menuItem(page, "LFS 상태…").click();
  const sheet = page.getByRole("dialog", { name: "Git LFS" });
  await expect(sheet.getByRole("list", { name: "추적 패턴" })).toContainText("*.psd");
  await expect(sheet.getByRole("list", { name: "LFS 파일" })).toContainText("assets/model.bin");
  await expect(sheet.getByRole("list", { name: "LFS 파일" })).toContainText("포인터");

  await sheet.getByRole("button", { name: "*.psd 추적 해제" }).click();
  await expect.poll(async () => (await gitCalls(page)).at(-1)).toEqual(["lfs", "untrack", "*.psd"]);
});

test("LFS: pull·fetch·push는 작업으로, 패턴 추적은 git lfs track", async ({ page }) => {
  const run = async (name: string) => {
    await page.locator(".picker").first().click();
    await menuItem(page, name).click();
  };
  await run("LFS Pull");
  await expect(page.locator(".toast", { hasText: "LFS Pull" }).first()).toBeVisible();
  expect((await jobs(page)).at(-1)).toEqual(["lfs", "pull"]);
  await expect(page.locator(".toast", { hasText: "LFS Pull 완료" }).first()).toBeVisible();
  await run("LFS Fetch");
  expect((await jobs(page)).at(-1)).toEqual(["lfs", "fetch"]);
  await expect(page.locator(".toast", { hasText: "LFS Fetch 완료" }).first()).toBeVisible();
  await run("LFS Push");
  expect((await jobs(page)).at(-1)).toEqual(["lfs", "push", "origin", "main"]);
  await expect(page.locator(".toast", { hasText: "LFS Push 완료" }).first()).toBeVisible();

  await run("패턴 추적…");
  const sheet = page.getByRole("dialog", { name: "LFS로 추적" });
  await sheet.getByLabel("패턴").fill("*.zip");
  await sheet.getByRole("button", { name: "추적" }).click();
  await expect.poll(async () => (await gitCalls(page)).at(-1)).toEqual(["lfs", "track", "*.zip"]);
  await expect(page.locator(".toast", { hasText: ".gitattributes" }).first()).toBeVisible();
});

test("변경 파일 우클릭 메뉴로 확장자 패턴을 LFS 추적", async ({ page }) => {
  await page.getByText("로컬 변경사항").click();
  await page.getByRole("listbox", { name: "스테이지 안 됨" }).getByRole("option", { name: /notes.md/ }).click({ button: "right" });
  await menuItem(page, /LFS로 추적/).click();
  const sheet = page.getByRole("dialog", { name: "LFS로 추적" });
  await expect(sheet.getByLabel("패턴")).toHaveValue("*.md");
  await sheet.getByRole("button", { name: "추적" }).click();
  await expect.poll(async () => (await gitCalls(page)).at(-1)).toEqual(["lfs", "track", "*.md"]);
});

test("LFS 미설치: 작업은 안내만 하고 실행하지 않는다", async ({ page }) => {
  await page.evaluate(() => ((window as any).__noLfs = true));
  for (const name of ["LFS Pull", "LFS Push", "패턴 추적…"]) {
    await page.locator(".picker").first().click();
    await menuItem(page, name).click();
    await expect(page.getByRole("alert")).toContainText("Git LFS가 설치되어 있지 않습니다");
    await page.getByRole("alert").getByRole("button", { name: "닫기" }).click();
  }
  expect((await gitCalls(page)).filter((c) => c[0] === "start_job" || c[0] === "lfs")).toEqual([]);

  await page.locator(".picker").first().click();
  await menuItem(page, "LFS 상태…").click();
  const sheet = page.getByRole("dialog", { name: "Git LFS" });
  await expect(sheet).toContainText("설치되어 있지 않습니다");
  await expect(sheet.getByRole("list")).toHaveCount(0);
});

test("빠른 실행에서 서브모듈·LFS 작업을 찾을 수 있다", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByLabel("빠른 실행 검색").fill("서브모듈 업데이트");
  await page.keyboard.press("Enter");
  expect((await jobs(page)).at(-1)).toEqual(["submodule", "update", "--init", "--recursive"]);
});

test("LFS Push: 추적 브랜치가 없으면 안내만 한다", async ({ page }) => {
  await page.evaluate(() => ((window as any).__noUpstream = true));
  await page.keyboard.press("ControlOrMeta+r");
  await expect(page.locator(".statusbar")).not.toContainText("↑1");
  await page.locator(".picker").first().click();
  await menuItem(page, "LFS Push").click();
  await expect(page.getByRole("alert")).toContainText("추적 원격이 없습니다");
  expect(await jobs(page)).toEqual([]);
});

test("서브모듈 조회가 느려도 그래프는 먼저 보인다", async ({ page }) => {
  await page.evaluate(() => ((window as any).__slowModules = 1500, (window as any).__noModules = true));
  await page.keyboard.press("ControlOrMeta+r");
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
  await expect(side(page).getByRole("button", { name: /^서브모듈/ })).toBeVisible(); // 이전 목록 유지(같은 저장소 새로고침)
  await expect(side(page).getByRole("button", { name: /^서브모듈/ })).toHaveCount(0, { timeout: 4000 }); // 느린 조회가 끝나면 반영
});
