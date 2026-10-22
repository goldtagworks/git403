import { expect, test, type Page } from "@playwright/test";

// 그래프 검색 카드·브랜치 선택 팝오버·사이드바 필터. 스크린샷: e2e/results/screens/
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".commits").getByText("README 정리")).toBeVisible();
});
const git = (page: Page) => page.evaluate(() => JSON.stringify((window as any).__git));

test("그래프 검색: 카드·순번·흐림·본문 검색", async ({ page }, info) => {
  await page.keyboard.press("ControlOrMeta+f");
  const bar = page.locator(".search-bar");
  await expect(bar).toBeVisible();
  await page.getByLabel("커밋 검색").fill("그래프");
  await expect(bar.locator(".search-count")).toHaveText("- / 2");
  await expect(page.locator(".row.dim")).not.toHaveCount(0);
  await expect(page.locator(".row.match")).toHaveCount(2);
  await expect(page.locator(".row.match.dim")).toHaveCount(0);
  await bar.getByRole("button", { name: "다음 결과" }).click();
  await expect(bar.locator(".search-count")).toHaveText("1 / 2");
  await bar.getByRole("button", { name: "다음 결과" }).click();
  await expect(bar.locator(".search-count")).toHaveText("2 / 2");
  await page.screenshot({ path: `e2e/results/screens/${info.project.name}-search.png` });
  // 본문(body)까지 검색, 설명 열에 본문 앞부분이 흐리게 붙는다
  await page.getByLabel("커밋 검색").fill("sidebar-body-hit");
  await expect(page.locator(".row.match")).toHaveCount(1);
  await expect(page.locator(".row.match .subject .body")).toContainText("레인 할당은");
  await page.getByLabel("커밋 검색").press("Escape");
  await expect(bar).toHaveCount(0);
  await expect(page.locator(".row.dim")).toHaveCount(0);
});

test("브랜치 팝오버: 필터·↑↓·Enter 체크아웃·Esc", async ({ page }, info) => {
  const pop = page.getByRole("dialog", { name: "브랜치 선택" });
  await page.locator(".branch-pop-wrap .picker").click();
  await expect(pop.locator("li.head")).toContainText("main"); // 현재 브랜치 강조
  await expect(pop.locator(".group")).toHaveText(["로컬", "원격"]);
  await page.screenshot({ path: `e2e/results/screens/${info.project.name}-branchpop.png` });
  await page.getByLabel("브랜치 검색").fill("graph");
  await expect(pop.locator("li[data-i]")).toHaveCount(2); // feature/graph + origin/feature/graph
  await page.keyboard.press("ArrowDown"); // 원격으로
  await page.keyboard.press("ArrowUp"); // 다시 로컬
  await page.keyboard.press("Enter");
  await expect(pop).toHaveCount(0);
  expect(await git(page)).toContain("feature/graph");
  await page.locator(".branch-pop-wrap .picker").click();
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
});

test("사이드바 필터: 폴더 펼침·강조, 단축키, 보는 중·모두 보기", async ({ page }, info) => {
  await page.keyboard.press("ControlOrMeta+Alt+f");
  await expect(page.getByLabel("사이드바 필터")).toBeFocused();
  await page.getByLabel("사이드바 필터").fill("graph");
  await expect(page.locator(".sidebar mark.hl").first()).toHaveText("graph");
  await expect(page.locator(".sidebar .item.folder", { hasText: "feature" }).first()).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".sidebar .section-body .item", { hasText: "hotfix" })).toHaveCount(0);
  await expect(page.locator(".sidebar .item .label", { hasText: "v0.1.0" })).toHaveCount(0);
  await page.screenshot({ path: `e2e/results/screens/${info.project.name}-sidefilter.png` });
  await page.getByLabel("사이드바 필터").fill("zzz");
  await expect(page.getByText("일치하는 항목이 없습니다")).toBeVisible();
  await page.getByLabel("사이드바 필터").press("Escape");
  await expect(page.getByLabel("사이드바 필터")).toHaveValue("");

  await expect(page.locator(".side-view")).toHaveCount(0);
  const r = page.locator(".sidebar .section-body .item").filter({ hasText: "hotfix" }).first();
  await r.hover();
  await r.locator(".eye").click();
  await expect(page.locator(".side-view")).toContainText("보는 중 5/6");
  await page.getByRole("button", { name: "모두 보기" }).click();
  await expect(page.locator(".side-view")).toHaveCount(0);
});
