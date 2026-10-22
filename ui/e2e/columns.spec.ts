import { expect, test, type Page } from "@playwright/test";

// 커밋 목록 열 폭 조절·숨김: 브랜치/태그 | 그래프 | 설명 | 작성자 | 날짜 | 커밋
const renders = (page: Page) => page.evaluate(() => ({ ...(window as any).__renders }) as Record<string, number>);
const open = async (page: Page) => {
  await page.addInitScript(() => ((window as any).__multiRef = true));
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".diff .add").first()).toBeVisible();
};
const head = (page: Page) => page.locator(".commits-head");
const cssVar = (page: Page, v: string) => page.locator(".commits").evaluate((el, n) => el.style.getPropertyValue(n), v);
const num = async (page: Page, v: string) => parseFloat(await cssVar(page, v));
const store = (page: Page, k: string) => page.evaluate((key) => localStorage.getItem(key), k);
/** 열 머리 경계 splitter 드래그. i: .commits-head .splitter.x 의 순번 (refs, graph, author, date, sha) */
const drag = async (page: Page, i: number, dx: number) => {
  const box = (await head(page).locator(".splitter.x").nth(i).boundingBox())!;
  await page.mouse.move(box.x + 0.5, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 0.5 + dx, box.y + 10, { steps: 6 });
  await page.mouse.up();
};
const menu = async (page: Page) => {
  await head(page).click({ button: "right", position: { x: 300, y: 10 } });
  await expect(page.getByRole("menu")).toBeVisible();
};
const pick = async (page: Page, name: string) => {
  await menu(page);
  await page.getByRole("menuitem", { name }).click();
};

test("머리글: 브랜치/태그 | 그래프 | 설명 | 작성자 | 날짜 | 커밋", async ({ page }) => {
  await open(page);
  await expect(head(page).locator("> span, .head-left > span")).toHaveText(["브랜치/태그", "그래프", "설명", "작성자", "날짜", "커밋"]);
  expect(await head(page).locator(".splitter.x").count()).toBe(5);
});

test("그래프 열을 좁히면 레인 간격이 줄고 저장되며, 더블클릭하면 자동 폭", async ({ page }) => {
  await open(page);
  const auto = await num(page, "--graph-w");
  const step0 = await num(page, "--lstep");
  expect(step0).toBe(22);
  const row = page.locator(".graph-scroll .row").nth(1);
  const nx = () => row.evaluate((el) => parseFloat(getComputedStyle(el, "::before").left));
  const x0 = await nx();
  const before = await renders(page);
  await drag(page, 1, -(auto - 50));
  await expect.poll(() => num(page, "--graph-w")).toBeLessThan(auto - 30);
  expect(await num(page, "--lstep")).toBeLessThan(step0);
  expect(await num(page, "--lstep")).toBeGreaterThanOrEqual(8);
  // 노드 위치(틴트 시작)가 같은 레인 기준으로 왼쪽으로 당겨진다 / 캔버스는 열 폭만큼만
  const x1 = await nx();
  expect(x1).toBeLessThan(x0 + 0.01);
  const gw = await num(page, "--graph-w");
  const rw = await num(page, "--ref-w");
  await expect.poll(() => page.locator(".graph-canvas").evaluate((c: HTMLCanvasElement) => c.width)).toBe(Math.round(rw + gw));
  expect(await store(page, "split:graph-w")).toBe(String(gw));
  expect((await renders(page)).CommitRow, "행은 놓을 때 한 번만").toBeLessThanOrEqual(before.CommitRow);
  // 다시 열어도 유지
  await page.reload();
  await expect(head(page)).toBeVisible();
  expect(await num(page, "--graph-w")).toBe(gw);
  // 더블클릭 = 자동 폭
  await head(page).locator(".splitter.x").nth(1).dblclick();
  await expect.poll(() => num(page, "--graph-w")).toBe(auto);
  expect(await num(page, "--lstep")).toBe(22);
  expect(await store(page, "split:graph-w")).toBeNull();
});

test("그래프 열이 레인보다 좁아 잘리면 오른쪽에 페이드가 칠해진다", async ({ page }) => {
  await open(page);
  const auto = await num(page, "--graph-w");
  const alphaAtEdge = () =>
    page.locator(".graph-canvas").evaluate((c: HTMLCanvasElement) => {
      const g = c.getContext("2d")!;
      // 마지막 한 칸의 알파 합 (페이드가 있으면 거의 0)
      const d = g.getImageData(c.width - 1, 0, 1, c.height).data;
      let a = 0;
      for (let i = 3; i < d.length; i += 4) a += d[i];
      return a;
    });
  await drag(page, 1, -(auto - 40)); // 최소 폭(40)까지
  await expect.poll(() => num(page, "--graph-w")).toBe(40);
  expect(await num(page, "--lstep")).toBe(8);
  await expect.poll(alphaAtEdge).toBe(0);
});

test("각 열 폭은 스플리터로 조절·저장되고 더블클릭하면 기본 폭", async ({ page }) => {
  await open(page);
  for (const [i, v, key, def, dx] of [[0, "--ref-w", "graph-refs", 150, 40], [2, "--author-w", "graph-author", 110, -40], [3, "--date-w", "graph-date", 150, -30], [4, "--sha-w", "graph-sha", 60, -30]] as const) {
    expect(await num(page, v), v).toBe(def);
    await drag(page, i, dx);
    const w = def + (i === 0 ? dx : -dx); // 오른쪽 열은 왼쪽으로 끌면 넓어진다
    await expect.poll(() => num(page, v), v).toBe(w);
    expect(await store(page, "split:" + key)).toBe(String(w));
    await head(page).locator(".splitter.x").nth(i).dblclick();
    await expect.poll(() => num(page, v), v).toBe(def);
    expect(await store(page, "split:" + key)).toBeNull();
  }
  // 작성자 열 실제 폭이 행에도 반영된다
  await drag(page, 2, -50);
  await expect.poll(async () => (await page.locator(".graph-scroll .row .author").first().boundingBox())!.width).toBe(160);
  expect((await head(page).locator(".author").boundingBox())!.width).toBe(160);
});

test("머리글 우클릭: 열 숨기기·보이기·저장·초기화", async ({ page }) => {
  await open(page);
  await menu(page);
  await expect(page.getByRole("menuitem")).toHaveText(["✓ 브랜치/태그", "✓ 그래프", "✓ 작성자", "✓ 날짜", "✓ 커밋", "열 폭 초기화"].map((t) => new RegExp(t)));
  await page.keyboard.press("Escape");
  const row = page.locator(".graph-scroll .row").first();
  await pick(page, "작성자");
  await expect(head(page).locator(".author")).toHaveCount(0);
  await expect(row.locator(".author")).toBeHidden();
  await pick(page, "날짜");
  await pick(page, "커밋");
  await expect(row.locator(".date")).toBeHidden();
  await expect(row.locator(".sha")).toBeHidden();
  expect(await store(page, "cols:hidden")).toBe('["author","date","sha"]');
  await page.reload();
  await expect(head(page)).toBeVisible();
  await expect(head(page).locator(".author")).toHaveCount(0);
  await menu(page);
  await expect(page.getByRole("menuitem", { name: "작성자" })).toHaveText(/^\s*작성자/); // 체크 없음
  await page.getByRole("menuitem", { name: "작성자" }).click();
  await expect(head(page).locator(".author")).toBeVisible();
  // 그래프 숨김: 캔버스·WIP 점 없음, 설명이 왼쪽으로
  const subjX = async () => (await head(page).locator(".subject").boundingBox())!.x;
  const x0 = await subjX();
  await pick(page, "그래프");
  await expect(page.locator(".graph-canvas")).toBeHidden();
  await expect(head(page).locator(".graph-head")).toHaveCount(0);
  expect(await subjX()).toBeLessThan(x0 - 40);
  // 폭을 바꿔 두고 초기화 → 모두 보이고 기본 폭
  await drag(page, 0, 30);
  await pick(page, "열 폭 초기화");
  await expect(head(page).locator(".graph-head")).toBeVisible();
  await expect(head(page).locator(".date")).toBeVisible();
  expect(await num(page, "--ref-w")).toBe(150);
  expect(await store(page, "cols:hidden")).toBeNull();
  expect(await store(page, "split:graph-refs")).toBeNull();
});

test("브랜치/태그 열을 숨기면 배지가 설명 앞 인라인 칩으로 보인다", async ({ page }, info) => {
  await open(page);
  const row = page.locator(".graph-scroll .row").filter({ has: page.locator(".badge", { hasText: "feature/graph" }) });
  const badge = row.locator(".badge");
  const before = (await badge.boundingBox())!;
  await pick(page, "브랜치/태그");
  await expect(head(page).locator(".refs-head")).toHaveCount(0);
  const after = (await badge.boundingBox())!;
  const subj = (await row.locator(".subject").boundingBox())!;
  expect(await row.locator(".row-refs").evaluate((el) => getComputedStyle(el).position)).toBe("static");
  expect(after.x + after.width).toBeLessThan(subj.x + 14); // 설명 바로 앞
  expect(after.y).toBeCloseTo(before.y, 0);
  await expect(row.locator(".ref-line")).toBeHidden();
  // 칩 클릭은 그대로 동작(선택)
  await badge.click();
  await page.mouse.move(0, 0);
  await page.locator(".commits").screenshot({ path: `e2e/results/screens/cols-hidden-${info.project.name}.png` });
});

// 시각 확인용 (판정 없음). 결과: e2e/results/screens/cols-narrow-<light|dark>.png
test("화면 캡처: 좁힌 그래프", async ({ page }, info) => {
  await open(page);
  await page.locator(".graph-scroll .row").nth(3).click();
  const auto = await num(page, "--graph-w");
  await drag(page, 1, -(auto - 64));
  await page.mouse.move(0, 0);
  await page.locator(".commits").screenshot({ path: `e2e/results/screens/cols-narrow-${info.project.name}.png` });
});

// 선택 행 틴트는 설명 열 시작을 넘어 칠해지지 않는다 (노드 x는 그래프 열 오른쪽 끝으로 clamp)
test("그래프 숨김·좁힘에서도 행 틴트 시작 x는 설명 열 시작 이내", async ({ page }) => {
  await open(page);
  const tintLeft = async () => {
    const r = page.locator(".graph-scroll .row").nth(6); // 오른쪽 레인 노드가 있는 행
    return r.evaluate((el) => ({ tint: el.getBoundingClientRect().left + parseFloat(getComputedStyle(el, "::before").left), pad: el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft) }));
  };
  const auto = await num(page, "--graph-w");
  await drag(page, 1, -(auto - 40));
  await expect.poll(() => num(page, "--graph-w")).toBe(40);
  let t = await tintLeft();
  expect(t.tint).toBeLessThanOrEqual(t.pad + 0.5);
  await pick(page, "그래프");
  await expect.poll(() => num(page, "--graph-w")).toBe(0);
  t = await tintLeft();
  expect(t.tint).toBeCloseTo(t.pad, 0);
});

test("브랜치/태그 숨김: Canvas에 칩→노드 선을 그리지 않는다", async ({ page }) => {
  await open(page);
  // 칩이 있는 행(main, y=ROW_H*0.5 근처) 왼쪽 끝 픽셀: 숨기기 전엔 선, 후엔 투명
  const leftAlpha = () =>
    page.locator(".graph-canvas").evaluate((c: HTMLCanvasElement) => {
      const g = c.getContext("2d")!;
      const d = g.getImageData(0, 0, 6, c.height).data;
      let a = 0;
      for (let i = 3; i < d.length; i += 4) a += d[i];
      return a;
    });
  expect(await leftAlpha()).toBe(0); // 칩 열(선은 칩 뒤 DOM). 열 폭 150이라 Canvas 왼쪽은 비어 있다
  await pick(page, "브랜치/태그");
  await expect(head(page).locator(".refs-head")).toHaveCount(0);
  await expect.poll(leftAlpha).toBeLessThan(1); // x=0부터 그려진 선이 없다
  const w = await page.locator(".graph-canvas").evaluate((c: HTMLCanvasElement) => c.width);
  expect(w).toBe(await num(page, "--graph-w"));
});
