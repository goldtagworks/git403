import { expect, test, type Page } from "@playwright/test";

// 그래프 페이지 로딩: 처음엔 한 페이지(5000)만 읽고, 맨 아래 근처로 스크롤하면 두 배씩(상한까지) 더 읽는다.
const calls = (page: Page) => page.evaluate(() => [...((window as any).__graphCalls ?? [])] as number[]);
const scroller = (page: Page) => page.locator(".graph-scroll");
const toBottom = (page: Page) => scroller(page).evaluate((el) => (el.scrollTop = el.scrollHeight));

async function start(page: Page, total: number, cap?: number) {
  await page.addInitScript(([t, c]) => {
    (window as any).__bigGraph = t;
    if (c) localStorage.setItem("graphLimit", String(c));
  }, [total, cap ?? 0]);
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".commits .row", { hasText: "커밋 0" }).first()).toBeVisible();
}

test("처음엔 한 페이지만 읽고, 아래로 스크롤하면 두 배로 더 읽는다", async ({ page }) => {
  await start(page, 30000, 30000);
  expect(await calls(page)).toEqual([5000]);
  await toBottom(page);
  await expect.poll(() => calls(page)).toEqual([5000, 10000]);
  // 늘어난 높이만큼 스크롤이 이어진다 (맨 위로 돌아가지 않는다)
  await expect.poll(() => scroller(page).evaluate((el) => el.scrollHeight)).toBeGreaterThan(9000 * 26);
  expect(await scroller(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(4000 * 26);
  await toBottom(page);
  await expect.poll(() => calls(page)).toEqual([5000, 10000, 20000]);
  await toBottom(page);
  await expect.poll(() => calls(page)).toEqual([5000, 10000, 20000, 30000]);
  await toBottom(page);
  await page.waitForTimeout(300);
  expect((await calls(page)).length).toBe(4); // 더 읽을 게 없으면 다시 부르지 않는다
});

test("선택한 커밋과 스크롤 위치는 더 읽어도 유지된다", async ({ page }) => {
  await start(page, 30000);
  await page.locator(".commits .row", { hasText: "커밋 5" }).first().click();
  await expect(page.locator(".commits .row.selected")).toContainText("커밋 5");
  await toBottom(page);
  await expect.poll(() => calls(page)).toEqual([5000, 10000]);
  await expect.poll(() => scroller(page).evaluate((el) => el.scrollHeight)).toBeGreaterThan(9000 * 26);
  const top = await scroller(page).evaluate((el) => el.scrollTop);
  expect(top).toBeGreaterThan(4000 * 26); // 선택 커밋(맨 위 근처)으로 끌려가지 않는다
  await scroller(page).evaluate((el) => (el.scrollTop = 0));
  await expect(page.locator(".commits .row.selected")).toContainText("커밋 5");
});

test("상한 설정을 넘지 않는다", async ({ page }) => {
  await start(page, 30000, 8000);
  expect(await calls(page)).toEqual([5000]);
  await toBottom(page);
  await expect.poll(() => calls(page)).toEqual([5000, 8000]);
  await toBottom(page);
  await page.waitForTimeout(300);
  expect(await calls(page)).toEqual([5000, 8000]);
});

test("더 읽는 동안 다시 그려지는 횟수가 한 번(새 목록)으로 제한된다", async ({ page }) => {
  await start(page, 30000);
  const before = await page.evaluate(() => (window as any).__renders?.CommitGraph ?? 0);
  await toBottom(page);
  await expect.poll(() => calls(page)).toEqual([5000, 10000]);
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => (window as any).__renders?.CommitGraph ?? 0);
  // 스크롤 상태 갱신(프레임 단위)을 빼면 로드 자체는 새 view로 한 번이다. 사이드바는 다시 그려지지 않는다.
  expect(after - before).toBeLessThan(20);
  expect(await page.evaluate(() => (window as any).__renders?.Sidebar ?? 0)).toBeLessThan(5);
});

test("저장소를 열면 commit-graph 보장을 한 번 요청한다", async ({ page }) => {
  await start(page, 100);
  await expect.poll(() => page.evaluate(() => (window as any).__cgCalls)).toEqual(["/demo/git403"]);
});
