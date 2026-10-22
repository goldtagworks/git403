import { expect, test, type Page } from "@playwright/test";

// 스플리터를 끝까지 끌거나 창이 작아져도 패널이 사라지거나 툴바가 튀어나오지 않는다.
const inView = (page: Page, sel: string) =>
  page.locator(sel).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 50 && r.height > 50 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
  });

async function drag(page: Page, sel: string, dx: number, dy: number) {
  const b = (await page.locator(sel).first().boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 + dy, { steps: 4 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".diff .add").first()).toBeVisible();
});

test("작은 창에서도 상세 패널이 남고 툴바는 한 줄이다", async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 450 });
  expect(await inView(page, ".details")).toBe(true);
  expect(await inView(page, ".main")).toBe(true);
  expect((await page.locator(".toolbar").boundingBox())!.height).toBeLessThan(60);
});

test("스플리터를 끝까지 끌어도 옆·아래 패널이 사라지지 않고, 되돌리면 바로 따라온다", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 650 });
  await drag(page, ".workspace > .splitter.x", 2000, 0);
  await drag(page, ".main > .splitter.y", 0, 2000);
  await drag(page, ".details > .splitter.x", 2000, 0);
  for (const sel of [".main", ".details", ".details .diff-wrap, .details .diff-pane"]) expect(await inView(page, sel), sel).toBe(true);
  // CSS로 줄어 보이는 크기에서 드래그가 시작돼야 한다 (저장값 2000에서 시작하면 위로 끌어도 안 움직임)
  const before = (await page.locator(".main > .pane").boundingBox())!.height;
  await drag(page, ".main > .splitter.y", 0, -100);
  expect((await page.locator(".main > .pane").boundingBox())!.height).toBeLessThan(before - 50);
});

test("각 패널은 창이 작아져도 스플리터 최소값 아래로 줄지 않는다", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 560 }); // 앱 창 최소 크기
  await page.locator(".workspace > .splitter.x").first().dblclick();
  await drag(page, ".workspace > .splitter.x", -2000, 0);
  await drag(page, ".main > .splitter.y", 0, -2000);
  await drag(page, ".details > .splitter.x", -2000, 0);
  const size = (sel: string) => page.locator(sel).first().boundingBox().then((b) => b!);
  expect((await size(".workspace > .pane")).width).toBeGreaterThanOrEqual(159);
  expect((await size(".main > .pane")).height).toBeGreaterThanOrEqual(119);
  expect((await size(".details > .info")).width).toBeGreaterThanOrEqual(199);
  for (const sel of [".main", ".details"]) expect(await inView(page, sel), sel).toBe(true);
});

test("창 크기를 바꾸면 그래프·상세가 같은 비율로 함께 늘고 준다", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 800 });
  const ratio = () => page.locator(".main > .pane").evaluate((el) => el.getBoundingClientRect().height / el.parentElement!.getBoundingClientRect().height);
  await drag(page, ".main > .splitter.y", 0, -80);
  const r0 = await ratio();
  await page.setViewportSize({ width: 1200, height: 1100 });
  expect(Math.abs((await ratio()) - r0)).toBeLessThan(0.01);
  await page.setViewportSize({ width: 1200, height: 600 });
  expect(Math.abs((await ratio()) - r0)).toBeLessThan(0.01);
});

test("사이드바: 뒤쪽에 접힌 섹션들은 아래쪽에 붙고, 펼치면 다시 위로 올라온다", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  const titles = page.locator(".sidebar > section > .section-title");
  const n = await titles.count();
  for (let i = 1; i < n; i++) if ((await titles.nth(i).getAttribute("aria-expanded")) === "true") await titles.nth(i).click();
  const side = (await page.locator(".sidebar").boundingBox())!;
  const last = (await titles.nth(n - 1).boundingBox())!;
  expect(side.y + side.height - (last.y + last.height)).toBeLessThan(40);
  const second = (await titles.nth(1).boundingBox())!;
  expect(second.y - (await titles.nth(0).boundingBox())!.y).toBeGreaterThan(60); // 첫 섹션 목록 아래로 떨어져 있다
  await page.screenshot({ path: `e2e/results/screens/sidebar-dock.png`, clip: side });
});

test("사이드바: 첫 섹션 뒤 섹션들은 펼쳐져 있어도 아래쪽에 붙고, 접은 상태는 다시 열어도 유지된다", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  const titles = page.locator(".sidebar > section > .section-title");
  const n = await titles.count();
  const side = (await page.locator(".sidebar").boundingBox())!;
  const lastSection = (await page.locator(".sidebar > section").nth(n - 1).boundingBox())!;
  expect(side.y + side.height - (lastSection.y + lastSection.height)).toBeLessThan(40);
  await page.locator(".sidebar .section-title", { hasText: "원격" }).click();
  await expect(page.locator(".sidebar .section-title", { hasText: "원격" })).toHaveAttribute("aria-expanded", "false");
  await page.reload();
  await expect(page.locator(".sidebar .section-title", { hasText: "원격" })).toHaveAttribute("aria-expanded", "false");
});
