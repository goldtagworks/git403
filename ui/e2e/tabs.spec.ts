import { expect, test, type Page } from "@playwright/test";

// 저장소 탭 줄 넘침 처리: 균등 축소 → 가로 스크롤 → "탭 n개" 메뉴. 선택한 탭은 항상 보인다.
const NAMES = Array.from({ length: 15 }, (_, i) => `repo-${String(i + 1).padStart(2, "0")}`);
NAMES[2] = "a-very-long-repository-name-that-cannot-fit";
const PATHS = NAMES.map((n) => `/work/projects/${n}`);

async function start(page: Page, paths = PATHS, active = paths[0]) {
  await page.addInitScript(([p, a]) => {
    localStorage.setItem("tabs", JSON.stringify(p));
    localStorage.setItem("activeTab", JSON.stringify(a));
  }, [paths, active] as const);
  await page.goto("/");
  await expect(page.getByRole("tab", { selected: true })).toHaveAttribute("title", /./).catch(() => {});
  await expect(page.locator(".tab.active")).toHaveAttribute("data-path", active);
}

const bar = (page: Page) => page.getByRole("tablist", { name: "열린 저장소" });
const activePath = (page: Page) => page.locator(".tab.active").getAttribute("data-path");
const allBtn = (page: Page) => bar(page).getByRole("button", { name: /^탭 \d+개$/ });
const wsBtn = (page: Page) => bar(page).getByRole("button", { name: "작업공간" });
const menuItems = (page: Page) => page.getByRole("menu").getByRole("menuitem");
/** 활성 탭이 스크롤 영역 안에 온전히 보이는가 */
const activeVisible = (page: Page) =>
  page.evaluate(() => {
    const a = document.querySelector(".tab.active")!.getBoundingClientRect();
    const v = document.querySelector(".tabs-scroll")!.getBoundingClientRect();
    return a.left >= v.left - 1 && a.right <= v.right + 1;
  });
const fade = (page: Page) =>
  page.evaluate(() => {
    const v = document.querySelector(".tabs-view")!;
    return { l: getComputedStyle(v, "::before").opacity === "1", r: getComputedStyle(v, "::after").opacity === "1" };
  });
const scrollLeft = (page: Page) => page.locator(".tabs-scroll").evaluate((e) => e.scrollLeft);
const next = (page: Page) => page.keyboard.press("ControlOrMeta+Alt+ArrowRight");
const prev = (page: Page) => page.keyboard.press("ControlOrMeta+Alt+ArrowLeft");

test("탭 15개: 균등하게 최소 폭까지 줄고, 이름은 말줄임·title은 전체 경로, 닫기는 활성·호버 탭에만 보인다", async ({ page }, info) => {
  await start(page);
  const widths = await page.locator(".tab").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
  for (const w of widths) expect(w).toBeGreaterThanOrEqual(89.5), expect(w).toBeLessThanOrEqual(90.5);
  const long = page.locator(".tab").nth(2);
  await expect(long).toHaveAttribute("title", PATHS[2]);
  expect(await long.getByRole("tab").evaluate((e) => getComputedStyle(e).textOverflow + e.scrollWidth + ">" + e.clientWidth)).toMatch(/^ellipsis\d+>\d+$/);
  expect(await long.getByRole("tab").evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  // 닫기: 활성 탭만 보이고, 다른 탭은 호버하면 나타난다
  const close = (n: number) => page.locator(".tab").nth(n).locator(".tab-close");
  await expect(close(0)).toBeVisible();
  await expect(close(1)).toBeHidden();
  await page.locator(".tab").nth(1).hover();
  await expect(close(1)).toBeVisible();
  await expect(close(1)).toHaveAttribute("title", "repo-02 탭 닫기"); // 글자(툴팁)로도 보인다
  // 포인터 커서 금지
  expect(await page.locator(".tab").nth(1).getByRole("tab").evaluate((e) => getComputedStyle(e).cursor)).not.toBe("pointer");
  expect(await allBtn(page).evaluate((e) => getComputedStyle(e).cursor)).not.toBe("pointer");
  // 스크린샷은 마지막 탭을 열어 양쪽 페이드가 모두 보이는 가운데 탭으로
  await page.locator(".tab").nth(7).getByRole("tab").click();
  await expect(page.locator(".tab.active")).toHaveAttribute("data-path", PATHS[7]);
  await page.mouse.move(600, 400);
  await page.screenshot({ path: `e2e/results/screens/tabs-overflow-${info.project.name}.png`, clip: { x: 0, y: 0, width: 1280, height: 200 } });
});

test("넘칠 때만 \"탭 n개\" 버튼이 나타나고, 목록에서 고르면 전환한다", async ({ page }) => {
  await start(page);
  await expect(allBtn(page)).toHaveText("탭 15개");
  await expect(allBtn(page)).toHaveAttribute("title", /15개 모두 보기/);
  await allBtn(page).click();
  await expect(menuItems(page)).toHaveCount(15);
  await expect(menuItems(page).first()).toHaveText(/✓ repo-01 — \/work\/projects/); // 이름·경로, 활성 탭 체크
  await expect(menuItems(page).nth(2)).toContainText(`${NAMES[2]} — /work/projects`);
  await expect(menuItems(page).nth(1)).not.toContainText("✓");
  await menuItems(page).nth(11).click();
  await expect(page.locator(".tab.active")).toHaveAttribute("data-path", PATHS[11]);
  expect(await activeVisible(page)).toBe(true); // 숨어 있던 탭이 전환되면서 보인다
});

test("넘치지 않으면 메뉴 버튼도 페이드도 없다", async ({ page }) => {
  await start(page, PATHS.slice(0, 3));
  await expect(page.locator(".tab")).toHaveCount(3);
  await expect(allBtn(page)).toHaveCount(0);
  expect(await fade(page)).toEqual({ l: false, r: false });
  const w = await page.locator(".tab").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
  for (const x of w) expect(x).toBeCloseTo(200, 0); // 여유가 있으면 200px
  // 창을 줄이면 나타나고, 다시 넓히면 사라진다 (경계에서 깜빡이지 않는다)
  await page.setViewportSize({ width: 300, height: 700 });
  await expect(allBtn(page)).toHaveText("탭 3개");
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(allBtn(page)).toHaveCount(0);
});

test("창 폭을 경계 근처로 바꿔도 메뉴 버튼이 깜빡이지 않고 안정된다", async ({ page }) => {
  await start(page, PATHS.slice(0, 5)); // 5 * 90 + 4 + 16(패딩) + 작업공간 버튼
  let flips = 0;
  await page.exposeFunction("__flip", () => flips++);
  await page.evaluate(() => new MutationObserver(() => (window as any).__flip()).observe(document.querySelector(".tabs")!, { childList: true }));
  for (let w = 700; w >= 440; w -= 10) {
    await page.setViewportSize({ width: w, height: 700 });
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(100);
  expect(flips).toBeLessThanOrEqual(1); // 켜지는 한 번뿐
  await expect(allBtn(page)).toHaveText("탭 5개");
});

test("활성 탭이 바뀌면(전환·⌘⌥←/→) 그 탭이 보이게 스크롤되고 smooth는 없다", async ({ page }) => {
  await start(page);
  expect(await scrollLeft(page)).toBe(0);
  for (let i = 0; i < 14; i++) {
    await next(page);
    await expect(page.locator(".tab.active")).toHaveAttribute("data-path", PATHS[i + 1]);
    expect(await activeVisible(page), `${i + 1}`).toBe(true); // 바로 보여야 한다(애니메이션 대기 없음)
  }
  expect(await scrollLeft(page)).toBeGreaterThan(0);
  for (let i = 13; i >= 0; i--) {
    await prev(page);
    await expect(page.locator(".tab.active")).toHaveAttribute("data-path", PATHS[i]);
    expect(await activeVisible(page)).toBe(true);
  }
  expect(await scrollLeft(page)).toBe(0);
  // 숨은 탭 쪽에서 가려지지 않게 페이드 너비만큼 여유를 두고 맞춘다
  await page.locator(".tabs-scroll").evaluate((e) => ((e.scrollLeft = e.scrollWidth), 0));
  await page.locator(".tab").nth(14).getByRole("tab").click();
  expect(await activeVisible(page)).toBe(true);
});

test("페이드는 숨은 탭이 있는 쪽에만 보인다", async ({ page }) => {
  await start(page);
  expect(await fade(page)).toEqual({ l: false, r: true });
  await page.locator(".tab").nth(7).getByRole("tab").click();
  await page.locator(".tabs-scroll").evaluate((e) => (e.scrollLeft = (e.scrollWidth - e.clientWidth) / 2));
  await expect.poll(() => fade(page)).toEqual({ l: true, r: true });
  await page.locator(".tab").nth(14).getByRole("tab").click();
  await expect.poll(() => fade(page)).toEqual({ l: true, r: false });
  // 페이드는 포인터를 막지 않는다
  expect(await page.locator(".tabs-view").evaluate((e) => getComputedStyle(e, "::before").pointerEvents)).toBe("none");
});

test("\"작업공간\" 버튼은 탭 스크롤 영역 밖 오른쪽에 고정되어 밀려나지 않는다", async ({ page }) => {
  await start(page);
  const box = async () => (await wsBtn(page).boundingBox())!;
  const first = await box();
  await page.locator(".tab").nth(14).getByRole("tab").click();
  await next(page).catch(() => {});
  const last = await box();
  expect(last.x).toBeCloseTo(first.x, 0);
  expect(last.y).toBeCloseTo(first.y, 0);
  const tabsRight = (await page.locator(".tabs").boundingBox())!;
  expect(last.x + last.width).toBeLessThanOrEqual(tabsRight.x + tabsRight.width + 0.5);
  expect(last.x + last.width).toBeGreaterThan(tabsRight.x + tabsRight.width - 20); // 오른쪽 끝
  const scr = (await page.locator(".tabs-scroll").boundingBox())!;
  expect(scr.x + scr.width).toBeLessThanOrEqual(last.x); // 스크롤 영역과 겹치지 않는다
  await wsBtn(page).click();
  await expect(page.getByRole("menu").getByRole("menuitem", { name: /작업공간으로 저장/ })).toBeVisible();
});

test("⌘⌥←/→: 이전·다음 탭, 양끝에서 멈추고 입력창에서는 무시한다", async ({ page }) => {
  await start(page, PATHS.slice(0, 3));
  await prev(page);
  expect(await activePath(page)).toBe(PATHS[0]); // 처음에서 멈춤
  await next(page);
  await expect(page.locator(".tab.active")).toHaveAttribute("data-path", PATHS[1]);
  await next(page);
  await expect(page.locator(".tab.active")).toHaveAttribute("data-path", PATHS[2]);
  await next(page);
  await page.waitForTimeout(100);
  expect(await activePath(page)).toBe(PATHS[2]); // 끝에서 멈춤
  // 연타해도 건너뛰지 않는다
  await prev(page);
  await prev(page);
  await expect(page.locator(".tab.active")).toHaveAttribute("data-path", PATHS[0]);
  // 입력창 포커스 중에는 무시 — 빠른 실행의 입력창
  await page.keyboard.press("ControlOrMeta+p");
  const input = page.getByRole("dialog", { name: "빠른 실행" }).getByRole("textbox");
  await input.focus();
  await next(page);
  await page.waitForTimeout(100);
  expect(await activePath(page)).toBe(PATHS[0]);
  // 빠른 실행에 "다음 탭"·"이전 탭"이 있다 (단축키가 힌트로 보인다)
  await input.fill("다음 탭");
  const opt = page.getByRole("dialog", { name: "빠른 실행" }).getByRole("option", { name: /다음 탭/ });
  await expect(opt).toContainText(/⌘⌥→|Ctrl\+Alt\+→/);
  await page.keyboard.press("Enter");
  await expect(page.locator(".tab.active")).toHaveAttribute("data-path", PATHS[1]);
});

test("마우스 휠의 세로 스크롤이 탭 줄을 가로로 움직인다", async ({ page }) => {
  await start(page);
  const b = (await page.locator(".tabs-scroll").boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.wheel(0, 200);
  await expect.poll(() => scrollLeft(page)).toBeGreaterThan(100);
  await page.mouse.wheel(0, -1000);
  await expect.poll(() => scrollLeft(page)).toBe(0);
  // 스크롤바는 보이지 않는다
  expect(await page.locator(".tabs-scroll").evaluate((e) => e.offsetHeight - e.clientHeight)).toBe(0);
});
