import { expect, test, type Page } from "@playwright/test";

// 사이드바에서 ref·폴더를 그래프에서 숨기기. mock의 wip/spike는 그 브랜치로만 닿는 커밋 "스파이크 실험"을 가진다.
const renders = (page: Page) => page.evaluate(() => ({ ...(window as any).__renders }) as Record<string, number>);
const row = (page: Page, name: string | RegExp) => page.locator(".sidebar .item").filter({ has: page.locator(".label", { hasText: name }) });
const eye = async (page: Page, name: string | RegExp) => {
  const r = row(page, name).first();
  await r.hover();
  await r.locator(".eye").click();
};
const title = (page: Page, label: string) => page.locator(".sidebar .section-title").filter({ hasText: label });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => ((window as any).__spike = true));
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".commits").getByText("스파이크 실험")).toBeVisible();
});

test("눈 아이콘으로 브랜치를 숨기면 흐려지고 그 브랜치로만 닿는 커밋이 그래프에서 빠진다", async ({ page }) => {
  await expect(title(page, "브랜치").locator(".count")).toHaveText("4");
  await expect(page.locator(".commits .badge", { hasText: "wip/spike" })).toBeVisible();
  await eye(page, "spike");
  await expect(row(page, "spike")).toHaveClass(/off/);
  await expect(row(page, "spike").locator(".eye")).toBeVisible(); // 마우스를 치워도 눈 가림이 보인다
  await expect(page.locator(".commits").getByText("스파이크 실험")).toHaveCount(0);
  await expect(page.locator(".commits .badge", { hasText: "wip/spike" })).toHaveCount(0);
  await expect(page.locator(".commits").getByText("Merge branch 'feature/graph'")).toBeVisible();
  await expect(title(page, "브랜치").locator(".count")).toHaveText("3/4");
  await expect(title(page, "원격").locator(".count")).toHaveText("2"); // 숨긴 게 없으면 개수만

  // 다시 보이기
  await eye(page, "spike");
  await expect(row(page, "spike")).not.toHaveClass(/off/);
  await expect(page.locator(".commits").getByText("스파이크 실험")).toBeVisible();
  await expect(title(page, "브랜치").locator(".count")).toHaveText("4");
});

test("그래프 라벨에서도 숨긴 ref는 빠지지만 커밋은 다른 ref로 닿으면 남는다", async ({ page }) => {
  await expect(page.locator('.commits .badge[title*="origin/feature/graph"]')).toBeVisible(); // 같은 커밋의 로컬+원격은 한 칩(title에 전부)
  await eye(page, "origin");
  await expect(title(page, "원격").locator(".count")).toHaveText("0/2");
  await expect(page.locator(".commits .badge.remote")).toHaveCount(0);
  await expect(page.locator(".commits").getByText("README 정리")).toBeVisible(); // main으로 닿는다
});

test("폴더를 숨기면 그 아래 전부 숨는다", async ({ page }) => {
  await eye(page, /^wip$/);
  await expect(row(page, /^wip$/)).toHaveClass(/off/);
  await expect(row(page, "spike")).toHaveClass(/off/);
  await expect(title(page, "브랜치").locator(".count")).toHaveText("3/4");
  await expect(page.locator(".commits").getByText("스파이크 실험")).toHaveCount(0);
  // 숨긴 폴더 안에서 하나만 다시 보이게 할 수 있다(폴더 숨김은 그대로, 그 항목만 예외)
  await eye(page, "spike");
  await expect(page.locator(".commits").getByText("스파이크 실험")).toBeVisible();
  await expect(row(page, /^wip$/)).toHaveClass(/off/);
  await expect(row(page, "spike")).not.toHaveClass(/off/);
  // 다시 숨기면 예외만 지워지고 폴더 숨김으로 돌아간다
  await eye(page, "spike");
  await expect(row(page, "spike")).toHaveClass(/off/);
  await expect(page.locator(".commits").getByText("스파이크 실험")).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("hidden:")).map((k) => JSON.parse(localStorage.getItem(k)!)))).toEqual([["refs/heads/wip/*"]]);
});

test("루트(origin)를 숨기고 하나만 보이게 하면 나머지는 숨긴 채 그 하나만 보인다", async ({ page }) => {
  await eye(page, /^origin$/);
  await expect(title(page, "원격").locator(".count")).toHaveText("0/2");
  // 원격 섹션의 origin/main 행(로컬 main과 이름이 같아 원격 섹션 안에서 고른다)
  const remoteMain = page.locator(".sidebar section").filter({ has: page.locator(".section-title", { hasText: "원격" }) }).locator(".item").filter({ has: page.locator(".label", { hasText: /^main$/ }) });
  await remoteMain.hover();
  await remoteMain.locator(".eye").click();
  await expect(remoteMain).not.toHaveClass(/off/);
  await expect(row(page, /^origin$/)).toHaveClass(/off/);
  await expect(title(page, "원격").locator(".count")).toHaveText("1/2");
  await expect(page.locator('.commits .badge[title*="origin/main"]')).toBeVisible();
  await expect(page.locator('.commits .badge[title*="origin/feature/graph"]')).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("hidden:")).map((k) => JSON.parse(localStorage.getItem(k)!)))).toEqual([["refs/remotes/origin/*", "!refs/remotes/origin/main"]]);
});

test("원격 서버(origin) 폴더를 숨기면 원격 브랜치가 전부 숨는다", async ({ page }) => {
  await eye(page, /^origin$/);
  await expect(title(page, "원격").locator(".count")).toHaveText("0/2");
  await expect(row(page, "main").nth(1)).toHaveClass(/off/);
});

test("현재(HEAD) 브랜치와 스태시에는 눈이 없다", async ({ page }) => {
  await expect(row(page, /^main$/).first().locator(".eye")).toHaveCount(0);
  await expect(row(page, "WIP on main").locator(".eye")).toHaveCount(0);
});

test("우클릭 메뉴로 숨기고 보이고, 숨김은 저장소별로 저장돼 다시 열어도 유지된다", async ({ page }) => {
  await row(page, "spike").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "그래프에서 숨기기" }).click();
  await expect(page.locator(".commits").getByText("스파이크 실험")).toHaveCount(0);
  expect(await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith("hidden:")).map(([, v]) => v))).toEqual(['["refs/heads/wip/spike"]']);

  await page.evaluate(() => localStorage.setItem("restoreTabs", "false")); // 탭 복원과 겹치지 않게 직접 연다
  await page.reload();
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".commits").getByText("README 정리")).toBeVisible();
  await expect(page.locator(".commits").getByText("스파이크 실험")).toHaveCount(0);
  await expect(row(page, "spike")).toHaveClass(/off/);
  await expect(title(page, "브랜치").locator(".count")).toHaveText("3/4");

  await row(page, "spike").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "그래프에서 보이기" }).click();
  await expect(page.locator(".commits").getByText("스파이크 실험")).toBeVisible();
  await row(page, /^wip$/).click({ button: "right" });
  await expect(page.getByRole("menu").getByRole("menuitem", { name: "그래프에서 숨기기" })).toBeVisible();
});

test("숨김 목록은 ref 전체 이름(폴더는 글롭)으로 저장된다", async ({ page }) => {
  await eye(page, /^wip$/);
  await expect(page.locator(".commits").getByText("스파이크 실험")).toHaveCount(0);
  await eye(page, /^origin$/);
  await expect(title(page, "원격").locator(".count")).toHaveText("0/2");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem([...Object.keys(localStorage)].find((k) => k.startsWith("hidden:"))!)!))).toEqual(["refs/heads/wip/*", "refs/remotes/origin/*"]);
});

test("숨김 토글은 사이드바 전체를 다시 그리지 않고 바뀐 항목만 갱신한다", async ({ page }) => {
  await page.waitForTimeout(300);
  const before = await renders(page);
  await eye(page, "spike");
  await expect(page.locator(".commits").getByText("스파이크 실험")).toHaveCount(0);
  await eye(page, /^origin$/);
  await expect(title(page, "원격").locator(".count")).toHaveText("0/2");
  const after = await renders(page);
  expect(after.Sidebar, "Sidebar").toBe(before.Sidebar);
  expect(after.Details, "Details").toBe(before.Details);
  expect(after.CommitGraph - before.CommitGraph, "CommitGraph(토글마다 숨김 집합 1번 + 다시 읽은 view가 바뀌는 만큼만)").toBeLessThanOrEqual(3 * 2);
});

test("라이트/다크: 숨긴 항목 스크린샷", async ({ page }, info) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await eye(page, "spike");
  await eye(page, /^origin$/);
  await expect(title(page, "원격").locator(".count")).toHaveText("0/2");
  await row(page, /^graph$/).first().hover();
  await page.screenshot({ path: `e2e/results/screens/hidden-${info.project.name}.png` });
});
