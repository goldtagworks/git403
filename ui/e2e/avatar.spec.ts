import { expect, test, type Page } from "@playwright/test";

const renders = (page: Page) => page.evaluate(() => ({ ...(window as any).__renders }) as Record<string, number>);
const open = async (page: Page) => {
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".diff .add").first()).toBeVisible();
};

test("작성자 사진: 보이는 고유 이메일을 한 번에 요청하고, 없으면 이니셜 동그라미", async ({ page }) => {
  await open(page);
  const rows = page.locator(".graph-scroll .row");
  await expect(rows.first().locator("img.avatar")).toHaveCount(1);
  const calls = await page.evaluate(() => (window as any).__avatarCalls as string[][]);
  expect(calls.length).toBe(1);
  expect([...calls[0]].sort()).toEqual(["dev@demo.dev", "merge@demo.dev", "review@demo.dev"]);
  // 12개 행 중 merge@ 작성자(4개)만 이니셜. 색 클래스는 이메일 해시 기반
  await expect(page.locator(".graph-scroll img.avatar")).toHaveCount(8);
  const initials = page.locator(".graph-scroll span.avatar");
  await expect(initials).toHaveCount(4);
  await expect(initials.first()).toHaveText("박");
  await expect(initials.first()).toHaveClass(/av-\d/);
  // 상세의 작성자도 같은 사진
  await expect(page.locator(".info .people .person:first-child .avatar")).toHaveCount(1);
  // 스크롤·재선택해도 다시 요청하지 않는다
  await page.locator(".graph-scroll").evaluate((e) => (e.scrollTop = 40));
  await rows.nth(2).click();
  expect(await page.evaluate(() => (window as any).__avatarCalls.length)).toBe(1);
});

test("일시적 실패(한도·네트워크)는 이니셜로 두었다가 잠시 뒤 다시 요청해 사진을 띄운다", async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => ((window as any).__avatarRetry = ["dev@demo.dev"]));
  await open(page);
  await expect(page.locator(".graph-scroll img.avatar")).toHaveCount(4); // review@만 사진, dev@는 실패로 이니셜
  await page.clock.fastForward(61_000);
  await expect(page.locator(".graph-scroll img.avatar")).toHaveCount(8);
  const calls = await page.evaluate(() => (window as any).__avatarCalls as string[][]);
  expect(calls.slice(1).flat()).toEqual(["dev@demo.dev"]); // 실패한 이메일만 다시 묻는다
});

test("사진이 늦게 도착해도 CommitGraph를 다시 렌더링하지 않는다", async ({ page }) => {
  await page.addInitScript(() => ((window as any).__avatarDelay = 600));
  await open(page);
  await expect(page.locator(".graph-scroll span.avatar")).toHaveCount(12); // 아직 전부 이니셜
  const before = await renders(page);
  await expect(page.locator(".graph-scroll img.avatar")).toHaveCount(8);
  const after = await renders(page);
  for (const id of ["CommitGraph", "Details", "Sidebar"]) expect(after[id], id).toBe(before[id]);
});

test("이미지가 깨지면 이니셜로 되돌아간다", async ({ page }) => {
  await page.addInitScript(() => ((window as any).__avatarUrls = { "dev@demo.dev": "data:image/png;base64,AAAA" }));
  await open(page);
  await expect(page.locator(".graph-scroll img.avatar")).toHaveCount(4); // review@만 남음
  await expect(page.locator(".graph-scroll span.avatar")).toHaveCount(8);
});

test("스플래시: 처음에 보였다가 짧게 보이고 사라지고 클릭을 막지 않는다", async ({ page }, info) => {
  await page.addInitScript(() => ((window as any).__splash = true));
  await page.goto("/");
  const splash = page.locator("#splash");
  await expect(splash).toBeAttached();
  await expect(splash.getByText("git403")).toBeVisible();
  expect(await splash.evaluate((e) => getComputedStyle(e).pointerEvents)).toBe("none");
  await page.screenshot({ path: `e2e/results/screens/splash-${info.project.name}.png` });
  await expect(splash).toHaveCount(0, { timeout: 2000 });
  await expect(page.getByRole("button", { name: "저장소 열기" })).toBeVisible();
});

test("작성자 사진 스크린샷", async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page);
  await page.screenshot({ path: `e2e/results/screens/avatars-${info.project.name}.png` });
});
