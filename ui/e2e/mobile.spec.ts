import { expect, test, type Page } from "@playwright/test";

// 모바일(Android 태블릿) 레이아웃 (27e). 모바일 판정 = UA의 Android (shared/lib/platform.ts), 저장소 폴더 = mock window.__reposRoot,
// 백엔드 지원 = gix 목록(crates/core/src/gix_backend/mod.rs `OPS`와 같은 값).
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const ROOT = "/data/user/0/app.git403/files/repos";
const GIX = {
  all: false,
  ops: ["read_log", "head_commit", "read_refs", "read_status", "changed_files", "file_diff", "worktree_diff", "file_blob", "commit_message", "committer", "stage", "unstage", "commit", "clone"],
};
const SIZES = [{ width: 1180, height: 820 }, { width: 820, height: 1180 }];

test.use({ userAgent: ANDROID, hasTouch: true });

const start = async (page: Page, size: { width: number; height: number }) => {
  await page.setViewportSize(size);
  await page.addInitScript(([root, caps]) => {
    localStorage.setItem("autoFetch", "0");
    (window as any).__reposRoot = root;
    (window as any).__caps = caps;
  }, [ROOT, GIX] as const);
  await page.goto("/");
};
const openRepo = async (page: Page) => {
  await page.getByRole("button", { name: /^api-server/ }).click();
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
};
const touch = (page: Page, text: string, type: string, dx = 0) =>
  page.locator(".commits").getByText(text).dispatchEvent(type, { pointerType: "touch", isPrimary: true, bubbles: true, clientX: 100 + dx, clientY: 100 });
const press = async (page: Page, text: string) => {
  await touch(page, text, "pointerdown");
  await page.waitForTimeout(650);
};

for (const size of SIZES) {
  const tag = `${size.width}x${size.height}`;

  test(`${tag}: 시작 화면은 앱 폴더의 저장소 목록과 복제만 보이고 저장소를 열 수 있다`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await start(page, size);
    await expect(page.locator("html")).toHaveAttribute("data-mobile", "");
    const list = page.getByRole("list", { name: "저장소 목록" });
    for (const n of ["api-server", "design-system", "git403"]) await expect(list.getByRole("button", { name: new RegExp(`^${n}`) })).toBeVisible();
    await expect(list.getByRole("button", { name: /^api-server/ })).toContainText(`${ROOT}/api-server`);
    await expect(page.getByRole("button", { name: "복제…" })).toBeVisible();
    for (const n of ["저장소 열기", "새 저장소…"]) await expect(page.getByRole("button", { name: n, exact: true })).toHaveCount(0);
    await page.screenshot({ path: `e2e/results/screens/mobile-start-${tag}-${info.project.name}.png` });

    await openRepo(page);
    // 메뉴 막대(appMenu)는 만들지 않는다
    expect(await page.evaluate(() => (window as any).__appMenuModel)).toBeUndefined();
    // 데스크탑 전용 UI 숨김: 터미널·폴더 열기, 업데이트 안내
    await expect(page.locator(".toolbar").getByRole("button", { name: /터미널|열기/ })).toHaveCount(0);
    expect(errors.filter((e) => /plugin|menu/i.test(e))).toEqual([]);
    await page.screenshot({ path: `e2e/results/screens/mobile-repo-${tag}-${info.project.name}.png` });
  });

  test(`${tag}: 복제 대화상자는 위치를 앱 폴더로 고정한다`, async ({ page }) => {
    await start(page, size);
    await page.getByRole("button", { name: "복제…" }).click();
    const d = page.getByRole("dialog");
    await expect(d.getByText(ROOT)).toBeVisible();
    await expect(d.getByRole("button", { name: "선택…" })).toHaveCount(0);
    await expect(d.getByLabel("위치")).toHaveCount(0);
    await d.getByRole("textbox", { name: "URL" }).fill("https://github.com/demo/tablet-app.git");
    await expect(d.getByRole("textbox", { name: "이름" })).toHaveValue("tablet-app"); // 이름 기본값은 URL에서
    await d.getByRole("button", { name: "복제", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__git.find((c: string[]) => c[0] === "start_job")?.[1])).toContain(`"repo":"${ROOT}"`);
    const call = JSON.parse(await page.evaluate(() => (window as any).__git.find((c: string[]) => c[0] === "start_job")[1]));
    expect(call.args).toEqual(["clone", "--progress", "--", "https://github.com/demo/tablet-app.git", "tablet-app"]);
  });

  test(`${tag}: 길게 누르면 우클릭과 같은 메뉴가 뜨고 미지원 작업은 없다`, async ({ page }) => {
    await start(page, size);
    await openRepo(page);
    await press(page, "로그 파서");
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "SHA 복사" })).toBeVisible();
    for (const n of [/새 브랜치/, /cherry-pick/, /머지/, /revert/, /Reset/i, /태그/]) await expect(menu.getByRole("menuitem", { name: n })).toHaveCount(0);
    // 터치 타깃
    expect((await menu.getByRole("menuitem").first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // 메뉴 밖을 누르면 닫힌다
    await page.waitForTimeout(450); // 열린 직후 400ms는 손 떼는 이벤트가 닫지 않게 무시
    await page.mouse.click(5, 5);
    await expect(menu).toHaveCount(0);
  });

  test(`${tag}: 짧게 탭하면 메뉴 없이 선택만 되고, 손가락이 움직이면 메뉴가 안 뜬다`, async ({ page }) => {
    await start(page, size);
    await openRepo(page);
    await page.locator(".commits").getByText("로그 파서").tap();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await touch(page, "Initial commit", "pointerdown");
    await touch(page, "Initial commit", "pointermove", 30);
    await page.waitForTimeout(650);
    await expect(page.getByRole("menu")).toHaveCount(0);
  });
}

test("폭 820: 사이드바는 서랍이고 상세는 그래프 아래다", async ({ page }) => {
  await start(page, SIZES[1]);
  await openRepo(page);
  const side = page.locator(".pane.side");
  const toggle = page.locator(".toolbar .side-toggle");
  await expect(toggle).toBeVisible();
  expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await expect(side).toBeHidden();
  await toggle.tap();
  await expect(side).toBeVisible();
  await expect(side.getByText("main").first()).toBeVisible();
  await page.mouse.click(780, 600); // 서랍 밖
  await expect(side).toBeHidden();
  // 상세는 오른쪽 열이 아니라 아래
  await expect(page.locator(".main")).not.toHaveAttribute("data-layout", "right");
  await page.locator(".commits").getByText("로그 파서").tap();
  const g = (await page.locator(".pane.graph").boundingBox())!, d = (await page.locator(".details").boundingBox())!;
  expect(d.y).toBeGreaterThanOrEqual(g.y + g.height - 1);
});

test("폭 1180: 사이드바가 그대로 보이고 서랍 버튼이 없으며 상세는 오른쪽 열이다", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("detailLayout", JSON.stringify("right")));
  await start(page, SIZES[0]);
  await openRepo(page);
  await expect(page.locator(".pane.side")).toBeVisible();
  await expect(page.locator(".toolbar .side-toggle")).toBeHidden();
  await expect(page.locator(".main")).toHaveAttribute("data-layout", "right");
});

test("서랍·메뉴 스크린샷 (라이트/다크)", async ({ page }, info) => {
  await start(page, SIZES[1]);
  await openRepo(page);
  await page.locator(".toolbar .side-toggle").tap();
  await expect(page.locator(".pane.side")).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `e2e/results/screens/mobile-drawer-820x1180-${info.project.name}.png` });
  await page.mouse.click(780, 600);
  await press(page, "로그 파서");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.screenshot({ path: `e2e/results/screens/mobile-menu-820x1180-${info.project.name}.png` });
});

test("데스크탑 UA에서는 모바일 규칙이 켜지지 않는다", async ({ browser }) => {
  const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36", viewport: { width: 820, height: 1180 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => (window as any).__reposRoot = "/should/be/ignored");
  await page.goto("/");
  await expect(page.locator("html")).not.toHaveAttribute("data-mobile", "");
  await expect(page.getByRole("button", { name: "저장소 열기" })).toBeVisible();
  await page.getByRole("button", { name: "복제…" }).click();
  await expect(page.getByRole("dialog").getByText("/should/be/ignored")).toHaveCount(0);
  await ctx.close();
});
