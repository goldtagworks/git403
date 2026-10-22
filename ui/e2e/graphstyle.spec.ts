import { expect, test, type Page } from "@playwright/test";

// 그래프: 브랜치/태그 열 칩, 레인 색 행 틴트, 원형 노드, WIP 점선 행.
const renders = (page: Page) => page.evaluate(() => ({ ...(window as any).__renders }) as Record<string, number>);
const open = async (page: Page, multi = false) => {
  if (multi) await page.addInitScript(() => ((window as any).__multiRef = true));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".diff .add").first()).toBeVisible();
};
const chip = (page: Page, name: string) => page.locator(".graph-scroll .row-refs .badge", { hasText: name });

test("브랜치/태그 열: 머리글, HEAD 체크 아이콘, 로컬+원격 한 칩, 여러 개면 +N", async ({ page }) => {
  await open(page, true);
  await expect(page.locator(".commits-head .refs-head")).toHaveText("브랜치/태그");
  // 설명 열 안에는 더 이상 라벨이 없다
  await expect(page.locator(".graph-scroll .subject .badge")).toHaveCount(0);
  // HEAD(main) + 태그 하나 더 → "main" + "+1", 아이콘 하나(체크)
  const main = chip(page, "main").first();
  await expect(main).toHaveClass(/head/);
  await expect(main.locator(".badge-more")).toHaveText("+1");
  await expect(main).toHaveAttribute("title", /main[\s\S]*v0\.2\.0-rc/);
  await expect(main.locator("svg")).toHaveCount(2); // 체크 + 로컬(노트북)
  // 로컬 feature/graph + origin/feature/graph = 한 칩, 로컬·원격 아이콘(체크 아님)
  const fg = chip(page, "feature/graph");
  await expect(fg).toHaveCount(1);
  await expect(fg).toHaveAttribute("title", /origin\/feature\/graph/);
  await expect(fg.locator("svg")).toHaveCount(2);
  await expect(fg.locator(".badge-more")).toHaveCount(0);
  // 원격만 있는 커밋은 원격 칩: 원격 이름을 떼고 구름 아이콘, 전체 이름은 title에
  const om = page.locator('.graph-scroll .row-refs .badge[title="origin/main"]');
  await expect(om).toHaveClass(/remote/);
  await expect(om.locator(".badge-name")).toHaveText("main");
  await expect(om.locator("svg")).toHaveCount(1);
  // 칩에서 노드로 가는 선 요소
  await expect(page.locator(".graph-scroll .row-refs .ref-line").first()).toBeVisible();
});

test("행 틴트·노드·WIP 행: 레인 색 변수, 호버·선택이 더 진함, 점선 노드", async ({ page }) => {
  await open(page);
  const row = page.locator(".graph-scroll .row").nth(1);
  const bg = (r: typeof row) => r.evaluate((el) => getComputedStyle(el, "::before").backgroundColor);
  const style = await row.getAttribute("style");
  expect(style).toMatch(/--lane: var\(--g\d\)/);
  expect(style).toMatch(/--nx: min\(calc\(var\(--ref-w\) \+ 12px \+ [\d.]+ \* var\(--lstep\)\), calc\(var\(--ref-w\) \+ var\(--graph-w\)\)\)/);
  const alpha = (c: string) => Math.max(...[...c.matchAll(/\/ ([\d.]+)\)|, ([\d.]+)\)/g)].map((m) => Number(m[1] ?? m[2])), 0);
  const base = alpha(await bg(row));
  expect(base).toBeGreaterThan(0.03);
  await row.hover();
  const hover = alpha(await bg(row));
  expect(hover).toBeGreaterThan(base);
  await row.click();
  await page.mouse.move(0, 0);
  expect(alpha(await bg(row))).toBeGreaterThan(hover);
  // 레인 색이 실제 색으로 풀린다 (토큰 --graph에서 내보낸 --g0)
  expect(await page.locator(".commits").evaluate((el) => el.style.getPropertyValue("--g0"))).toMatch(/^#/);
  // 캔버스는 열 + 그래프 폭, 행 클릭을 가리지 않는다
  await expect(page.locator(".graph-canvas")).toHaveCSS("pointer-events", "none");
  // 맨 위 WIP 행: 점선 원
  await expect(page.locator(".local-row .wip-node")).toHaveCSS("border-top-style", "dashed");
});

test("브랜치/태그 열 너비는 스플리터로 조절·저장되고 드래그 중에는 다시 렌더링하지 않는다", async ({ page }) => {
  await open(page);
  const head = page.locator(".commits-head .refs-head");
  const w0 = (await head.boundingBox())!.width;
  const sp = page.locator(".commits-head .splitter.x").first();
  const box = (await sp.boundingBox())!;
  const before = await renders(page);
  await page.mouse.move(box.x + 0.5, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 10, { steps: 5 });
  expect((await renders(page)).CommitGraph).toBe(before.CommitGraph); // 드래그 중에는 DOM style만
  await page.mouse.up();
  await expect.poll(async () => (await head.boundingBox())!.width).toBeGreaterThan(w0 + 40);
  expect(await page.evaluate(() => localStorage.getItem("split:graph-refs"))).not.toBeNull();
  await expect // 놓은 뒤 한 번 렌더링되어 행의 열도 같은 너비가 된다
    .poll(async () => Math.abs((await page.locator(".graph-scroll .row-refs").first().boundingBox())!.width - (await head.boundingBox())!.width))
    .toBeLessThan(1);
  // 다시 열면 저장된 너비
  await page.reload();
  await expect(page.locator(".commits-head .refs-head")).toBeVisible();
  expect((await page.locator(".commits-head .refs-head").boundingBox())!.width).toBeGreaterThan(w0 + 40);
});

// 시각 확인용 (판정 없음). 결과: e2e/results/screens/graph-<light|dark>.png
test("화면 캡처: 그래프", async ({ page }, info) => {
  await open(page, true);
  await page.locator(".graph-scroll .row").nth(3).click();
  await page.mouse.move(0, 0);
  await page.locator(".commits").screenshot({ path: `e2e/results/screens/graph-${info.project.name}.png` });
});
