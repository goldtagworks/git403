import { expect, test, type Page } from "@playwright/test";

// 로드맵 16단계: 저장소 통계
const gitCalls = (page: Page) => page.evaluate(() => (window as any).__git as string[][]);
const statCalls = async (page: Page) => (await gitCalls(page)).filter((c) => c[0] === "repo_stats").map((c) => JSON.parse(c[1]) as { token: string; range: string; branch: string | null; withLines: boolean });
const menuItem = (page: Page, name: string | RegExp) => page.getByRole("menu").getByRole("menuitem", { name });
const sheet = (page: Page) => page.getByRole("dialog", { name: "저장소 통계" });
const openStats = async (page: Page) => {
  await page.locator(".picker").first().click();
  await menuItem(page, "저장소 통계…").click();
};
const authorNames = (page: Page) => sheet(page).getByRole("table", { name: "작성자" }).locator("tbody tr td:first-child").allTextContents();

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
});

test("저장소 메뉴에서 통계 시트가 열리고 요약·차트가 보인다 (기본: 전체, 줄 수 없음)", async ({ page }) => {
  await openStats(page);
  await expect(sheet(page).locator(".stat-card", { hasText: "커밋" }).first()).toContainText("200");
  await expect(sheet(page).locator(".stat-card", { hasText: "추적 파일" })).toContainText("214");
  await expect(sheet(page).getByRole("img", { name: "주별 커밋 수" })).toBeVisible();
  await expect(sheet(page).locator(".heat-row i")).toHaveCount(7 * 24);
  await expect(sheet(page).getByRole("list", { name: "확장자" }).getByRole("listitem")).toHaveCount(10);
  await expect(sheet(page).getByRole("columnheader", { name: /^추가/ })).toHaveCount(0);
  // (개발 모드 StrictMode는 효과를 두 번 돌려 호출이 겹칠 수 있다. 인자만 본다)
  expect((await statCalls(page)).at(-1)).toMatchObject({ repo: "/demo/git403", range: "all", branch: null, withLines: false });
});

test("기간·브랜치를 바꾸면 그 인자로 다시 계산한다", async ({ page }) => {
  await openStats(page);
  await sheet(page).getByRole("button", { name: "30일" }).click();
  await expect(sheet(page).locator(".stat-card", { hasText: "커밋" }).first()).toContainText("20");
  await sheet(page).getByLabel("브랜치").selectOption("main");
  await expect.poll(async () => (await statCalls(page)).at(-1)).toMatchObject({ range: "30d", branch: "main", withLines: false });
  await sheet(page).getByRole("button", { name: "1년" }).click();
  await expect.poll(async () => (await statCalls(page)).at(-1)).toMatchObject({ range: "year", branch: "main" });
});

test("줄 수 포함 토글은 withLines로 다시 계산하고, 늦게 온 이전 결과는 버린다", async ({ page }) => {
  await page.evaluate(() => ((window as any).__slowStats = 300));
  await openStats(page);
  await expect(sheet(page).getByRole("status")).toContainText("계산 중");
  await expect(sheet(page).locator(".stat-card").first()).toBeVisible();

  await sheet(page).getByLabel("줄 수 포함").check();
  await expect(sheet(page).getByRole("status")).toContainText("계산 중");
  await expect(sheet(page).getByRole("columnheader", { name: /^추가/ })).toBeVisible();
  await expect(sheet(page).getByRole("table", { name: "작성자" })).toContainText("+4,800");
  expect((await statCalls(page)).at(-1)!.withLines).toBe(true);

  // 켰다가 바로 끄면 늦게 도착한 withLines 결과가 화면을 덮지 않는다
  await sheet(page).getByLabel("줄 수 포함").uncheck();
  await sheet(page).getByLabel("줄 수 포함").check();
  await sheet(page).getByLabel("줄 수 포함").uncheck();
  await expect(sheet(page).getByRole("status")).toHaveCount(0);
  await expect(sheet(page).getByRole("columnheader", { name: /^추가/ })).toHaveCount(0);
});

test("인자를 바꾸거나 시트를 닫으면 진행 중인 계산을 취소한다 (token)", async ({ page }) => {
  await page.evaluate(() => ((window as any).__slowStats = 500));
  await openStats(page);
  const cancels = async () => (await gitCalls(page)).filter((c) => c[0] === "cancel_stats").map((c) => c[1]);
  await sheet(page).getByRole("button", { name: "30일" }).click(); // 첫 계산이 끝나기 전에 인자 변경
  await expect.poll(async () => (await cancels()).length).toBeGreaterThan(0);
  const calls = await statCalls(page);
  expect(await cancels()).toContain(calls.at(-2)!.token);
  expect(new Set(calls.map((c) => c.token)).size).toBe(calls.length); // 요청마다 다른 token
  const before = (await cancels()).length;
  await sheet(page).locator(".sheet-actions").getByRole("button", { name: "닫기" }).click(); // 닫으면 마지막 계산도 취소
  await expect.poll(async () => (await cancels()).length).toBeGreaterThan(before);
  expect(await cancels()).toContain((await statCalls(page)).at(-1)!.token);
});

test("Escape는 시트 안 어디서든 닫는다 (열린 직후 포커스 이동 없이도)", async ({ page }) => {
  await openStats(page);
  await expect(sheet(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
});

test("작성자 표는 헤더를 눌러 정렬한다", async ({ page }) => {
  await openStats(page);
  await expect.poll(() => authorNames(page)).toEqual(["김개발", "이리뷰", "박머지"]); // 커밋 많은 순
  const header = (name: string) => sheet(page).getByRole("columnheader", { name: new RegExp("^" + name) });
  await header("커밋").getByRole("button").click(); // 같은 열 → 방향 반전
  await expect.poll(() => authorNames(page)).toEqual(["박머지", "이리뷰", "김개발"]);
  await expect(header("커밋")).toHaveAttribute("aria-sort", "ascending");
  await header("작성자").getByRole("button").click();
  await expect.poll(() => authorNames(page)).toEqual(["김개발", "박머지", "이리뷰"]);
  await header("작성자").getByRole("button").click();
  await expect.poll(() => authorNames(page)).toEqual(["이리뷰", "박머지", "김개발"]);
});

test("빠른 실행에서 저장소 통계를 열 수 있다", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByLabel("빠른 실행 검색").fill("저장소 통계");
  await page.keyboard.press("Enter");
  await expect(sheet(page)).toBeVisible();
  await sheet(page).locator(".sheet-actions").getByRole("button", { name: "닫기" }).click();
  await expect(sheet(page)).toHaveCount(0);
});
