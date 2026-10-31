import { expect, test, type Page } from "@playwright/test";

// 모바일(Android 폰·태블릿) 전용 화면 (27f). 모바일 판정 = UA의 Android (shared/lib/platform.ts), 저장소 폴더 = mock window.__reposRoot,
// 백엔드 지원 = gix 목록(crates/core/src/gix_backend/mod.rs `OPS`와 같은 값). 폰 = 폭 < 600(스택 내비게이션), 태블릿 = 폭 ≥ 600(두 칸).
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
const ROOT = "/data/user/0/app.git403/files/repos";
const GIX = {
  all: false,
  ops: ["read_log", "head_commit", "read_refs", "read_status", "changed_files", "file_diff", "worktree_diff", "file_blob", "commit_message", "committer", "stage", "unstage", "commit", "clone"],
};
const PHONES = [{ width: 390, height: 844 }, { width: 412, height: 915 }];
const TABLETS = [{ width: 1280, height: 800 }, { width: 800, height: 1280 }];

test.use({ userAgent: ANDROID, hasTouch: true });

type Size = { width: number; height: number };
const start = async (page: Page, size: Size, extra?: () => void) => {
  await page.setViewportSize(size);
  await page.addInitScript(([root, caps]) => {
    localStorage.setItem("autoFetch", "0");
    (window as any).__reposRoot = root;
    (window as any).__caps = caps;
  }, [ROOT, GIX] as const);
  if (extra) await page.addInitScript(extra);
  await page.goto("/");
};
const openRepo = async (page: Page) => {
  await page.getByRole("button", { name: /^api-server/ }).tap();
  await expect(page.locator(".commits").getByText("로그 파서")).toBeVisible();
};
const shot = async (page: Page, name: string, size: Size, info: { project: { name: string } }) => (await page.waitForTimeout(350), page.screenshot({ path: `e2e/results/screens/mobile-${name}-${size.width}x${size.height}-${info.project.name}.png` }));
const touch = (page: Page, text: string, type: string, dx = 0) =>
  page.locator(".commits").getByText(text).dispatchEvent(type, { pointerType: "touch", isPrimary: true, bubbles: true, clientX: 100 + dx, clientY: 100 });
const press = async (page: Page, text: string) => {
  await touch(page, text, "pointerdown");
  await page.waitForTimeout(650);
};
const noDesktopShell = async (page: Page) => {
  for (const sel of [".toolbar", ".tabs", ".statusbar", ".commits-head", ".pane.side"]) await expect(page.locator(sel)).toHaveCount(sel === ".commits-head" ? 1 : 0);
  await expect(page.locator(".commits-head")).toBeHidden(); // 열 머리글은 그리지 않는다
};

for (const size of [...PHONES, ...TABLETS]) {
  const tag = `${size.width}x${size.height}`;
  const phone = size.width < 600;

  test(`${tag}: 시작 화면은 앱 폴더의 저장소 목록과 큰 복제 버튼만 있고, 복제 창은 저절로 열리지 않는다`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await start(page, size);
    await expect(page.locator("html")).toHaveAttribute("data-mobile", "");
    const list = page.getByRole("list", { name: "저장소 목록" });
    for (const n of ["api-server", "design-system", "git403"]) await expect(list.getByRole("button", { name: new RegExp(`^${n}`) })).toBeVisible();
    await expect(list.getByRole("button", { name: /^api-server/ })).toContainText(`${ROOT}/api-server`);
    const clone = page.getByRole("button", { name: "복제…" });
    await expect(clone).toBeVisible();
    expect((await clone.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    for (const n of ["저장소 열기", "새 저장소…"]) await expect(page.getByRole("button", { name: n, exact: true })).toHaveCount(0);
    for (const sel of [".toolbar", ".tabs", ".statusbar", ".empty"]) await expect(page.locator(sel)).toHaveCount(0);
    await page.waitForTimeout(500);
    await expect(page.getByRole("dialog")).toHaveCount(0); // 시작하자마자 복제 창이 뜨지 않는다
    await shot(page, "repos", size, info);
    expect(errors.filter((e) => /plugin|menu/i.test(e))).toEqual([]);
    expect(await page.evaluate(() => (window as any).__appMenuModel)).toBeUndefined(); // 메뉴 막대(appMenu)는 만들지 않는다
  });

  test(`${tag}: 설정은 전체 화면 — 그룹 목록 → 그룹 상세, 안드로이드에 없는 그룹은 없다`, async ({ page }, info) => {
    await start(page, size);
    await page.getByRole("button", { name: "설정" }).tap();
    const dlg = page.getByRole("dialog", { name: "설정" });
    await expect(dlg).toBeVisible();
    const b = (await dlg.boundingBox())!;
    expect(b.width).toBeGreaterThanOrEqual(size.width - 1);
    expect(b.height).toBeGreaterThanOrEqual(size.height - 1);
    await expect(dlg.getByRole("button", { name: "Git", exact: true })).toBeVisible();
    for (const n of [/도구/, /SSH/i, /계정/, /^AI/]) await expect(dlg.getByRole("button", { name: n })).toHaveCount(0);
    await shot(page, "settings-list", size, info);
    await dlg.getByRole("button", { name: "일반" }).tap();
    await expect(dlg.getByLabel("테마")).toBeVisible();
    for (const n of ["업데이트", "탭 복원", "자동 Fetch"]) await expect(dlg.getByText(n, { exact: false })).toHaveCount(0);
    const sel = (await dlg.getByLabel("테마").boundingBox())!;
    expect(sel.height).toBeGreaterThanOrEqual(44);
    expect(sel.x + sel.width).toBeLessThanOrEqual(size.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await shot(page, "settings-general", size, info);
    await dlg.getByRole("button", { name: "뒤로" }).tap();
    await expect(dlg.getByRole("button", { name: "Git", exact: true })).toBeVisible();
    await page.goBack(); // Android 뒤로 = 설정 닫기
    await expect(dlg).toHaveCount(0);
    await expect(page.getByRole("list", { name: "저장소 목록" })).toBeVisible();
  });

  test(`${tag}: 빈 목록은 안내 문구와 복제 버튼`, async ({ page }, info) => {
    await start(page, size, () => ((window as any).__noRepos = true));
    await expect(page.getByText("아직 저장소가 없습니다", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "복제…" })).toBeVisible();
    await expect(page.getByRole("list", { name: "저장소 목록" })).toHaveCount(0);
    await shot(page, "empty", size, info);
  });

  test(`${tag}: 복제 대화상자는 위치를 앱 폴더로 고정하고 https 안내만 한다`, async ({ page }, info) => {
    await start(page, size);
    await page.getByRole("button", { name: "복제…" }).tap();
    const d = page.getByRole("dialog");
    await expect(d.getByText(ROOT)).toBeVisible();
    await expect(d.getByRole("button", { name: "선택…" })).toHaveCount(0);
    await expect(d.getByLabel("위치")).toHaveCount(0);
    const url = d.getByRole("textbox", { name: "URL" });
    expect(await url.getAttribute("placeholder")).not.toContain("git@");
    await url.fill("https://github.com/demo/tablet-app.git");
    await expect(d.getByRole("textbox", { name: "이름" })).toHaveValue("tablet-app");
    await shot(page, "clone", size, info);
    await d.getByRole("button", { name: "복제", exact: true }).tap();
    await expect.poll(() => page.evaluate(() => (window as any).__git.find((c: string[]) => c[0] === "start_job")?.[1])).toContain(`"repo":"${ROOT}"`);
    const call = JSON.parse(await page.evaluate(() => (window as any).__git.find((c: string[]) => c[0] === "start_job")[1]));
    expect(call.args).toEqual(["clone", "--progress", "--", "https://github.com/demo/tablet-app.git", "tablet-app"]);
  });

  test(`${tag}: 저장소를 열면 탭·툴바·상태바·열 머리글 없이 상단바와 커밋 목록만`, async ({ page }, info) => {
    await start(page, size);
    await openRepo(page);
    await noDesktopShell(page);
    const bar = page.locator(".m-bar").first();
    await expect(bar.getByRole("button", { name: /^api-server/ })).toBeVisible();
    await expect(bar.getByRole("button", { name: "브랜치 선택" })).toContainText("main");
    // 행: 제목 + (작성자 · 상대 날짜) 두 줄, 터치 타깃 44px 이상
    const row = page.locator(".commits .row").first();
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(row.locator(".c-l2")).toContainText("김개발");
    // 글자가 잘리지 않는다: 가로 스크롤이 없다
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await shot(page, "commits", size, info);
  });

  test(`${tag}: 길게 누르면 바닥 액션 시트가 뜨고 미지원 작업은 없다`, async ({ page }, info) => {
    await start(page, size);
    await openRepo(page);
    await press(page, "로그 파서");
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: "SHA 복사" })).toBeVisible();
    for (const n of [/새 브랜치/, /cherry-pick/, /머지/, /revert/, /Reset/i, /태그/]) await expect(menu.getByRole("menuitem", { name: n })).toHaveCount(0);
    expect((await menu.getByRole("menuitem").first().boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const box = (await menu.boundingBox())!;
    expect(Math.abs(box.y + box.height - size.height)).toBeLessThan(2); // 화면 바닥에 붙는다
    expect(box.width).toBeGreaterThanOrEqual(size.width - 2);
    await shot(page, "action-sheet", size, info);
    await page.waitForTimeout(450); // 열린 직후 400ms는 손 떼는 이벤트가 닫지 않게 무시
    await page.mouse.click(5, 5);
    await expect(menu).toHaveCount(0);
  });

  test(`${tag}: 짧게 탭해도 메뉴는 안 뜨고, 손가락이 움직이면 메뉴가 안 뜬다`, async ({ page }) => {
    await start(page, size);
    await openRepo(page);
    await page.locator(".commits").getByText("로그 파서").tap();
    await expect(page.getByRole("menu")).toHaveCount(0);
    if (phone) await page.goBack(); // 상세에서 목록으로
    await touch(page, "Initial commit", "pointerdown");
    await touch(page, "Initial commit", "pointermove", 30);
    await page.waitForTimeout(650);
    await expect(page.getByRole("menu")).toHaveCount(0);
  });

  test(`${tag}: 브랜치 ▾ 로 브랜치·태그·원격을 고르고, 뒤로 가기는 시트부터 닫는다`, async ({ page }, info) => {
    await start(page, size);
    await openRepo(page);
    const trigger = page.getByRole("button", { name: "브랜치 선택" });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.tap();
    const sheet = page.getByRole("dialog", { name: "브랜치 선택" });
    await expect(sheet).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    for (const n of ["main", "feature", "원격", "태그", "스태시"]) await expect(sheet.getByText(n, { exact: false }).first()).toBeVisible();
    for (const n of ["보기", "Pull Request", "서브모듈"]) await expect(sheet.getByText(n, { exact: true })).toHaveCount(0); // 서랍·시트엔 브랜치·태그·원격·스태시만
    await shot(page, "branches", size, info);
    await page.goBack(); // Android 뒤로: 시트만 닫힌다
    await expect(sheet).toHaveCount(0);
    await expect(page.locator(".commits")).toBeVisible();
    await trigger.tap();
    await sheet.getByRole("button", { name: /^graph/ }).first().tap(); // 고르면 그 커밋이 선택되고 시트가 닫힌다
    await expect(sheet).toHaveCount(0);
    await expect(page.locator(".commits .row.selected")).toContainText("그래프");
  });

  if (phone) {
    test(`${tag}: 폰 흐름 — 목록 → 커밋 상세 → diff → 이전/다음 파일 → 뒤로 → 뒤로 → 저장소 목록`, async ({ page }, info) => {
      await start(page, size);
      await openRepo(page);
      await page.locator(".commits").getByText("로그 파서").tap();
      // ③ 상세: 제목·작성자·sha·부모·변경 파일, 목록은 가려진다
      const pane = page.locator(".m-pane");
      await expect(pane.getByRole("heading", { name: "로그 파서" })).toBeVisible();
      await expect(pane.getByText("김개발")).toBeVisible();
      await expect(pane.getByText("변경 파일 3개")).toBeVisible();
      await expect(page.locator(".commits")).toBeHidden(); // inert + 덮임
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await shot(page, "detail", size, info);
      // ④ diff: 한 줄 모드, 파일명 ‹ ›
      await pane.getByRole("button", { name: /lib\.rs/ }).tap();
      await expect(pane.locator(".m-bar-title")).toHaveText("lib.rs");
      await expect(pane.locator("pre.diff.unified")).toBeVisible();
      await expect(pane.locator("pre.diff.split")).toHaveCount(0);
      await expect(pane.getByRole("radio", { name: "나란히" })).toBeHidden(); // 보기 전환 없음
      await expect(pane.getByRole("button", { name: "이전 파일" })).toBeDisabled();
      await shot(page, "diff", size, info);
      await pane.getByRole("button", { name: "다음 파일" }).tap();
      await expect(pane.locator(".m-bar-title")).toHaveText("CommitGraph.tsx");
      await pane.getByRole("button", { name: "다음 파일" }).tap();
      await expect(pane.getByRole("button", { name: "다음 파일" })).toBeDisabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // 뒤로(Android 뒤로 버튼·제스처 = history): diff → 상세 → 목록 → 저장소 목록
      await page.goBack();
      await expect(pane.getByRole("heading", { name: "로그 파서" })).toBeVisible();
      await page.goBack();
      await expect(page.locator(".m-pane")).toHaveCount(0);
      await expect(page.locator(".commits")).toBeVisible();
      await page.getByRole("button", { name: "뒤로" }).tap(); // 상단바 ← 도 같은 동작
      await expect(page.getByRole("list", { name: "저장소 목록" })).toBeVisible();
    });

    test(`${tag}: 상단바 ← 로 한 단계씩 뒤로, 저장소 이름 ⌄ 로 저장소 전환`, async ({ page }) => {
      await start(page, size);
      await openRepo(page);
      await page.locator(".commits").getByText("로그 파서").tap();
      await page.locator(".m-pane").getByRole("button", { name: /lib\.rs/ }).tap();
      await page.locator(".m-pane").getByRole("button", { name: "뒤로" }).tap();
      await expect(page.locator(".m-pane .m-subject")).toBeVisible();
      await page.locator(".m-pane").getByRole("button", { name: "뒤로" }).tap();
      await expect(page.locator(".m-pane")).toHaveCount(0);
      await page.locator(".m-bar").first().getByRole("button", { name: /^api-server/ }).tap();
      await expect(page.getByRole("menuitem", { name: "design-system" })).toBeVisible();
      await page.getByRole("menuitem", { name: "저장소 목록" }).tap();
      await expect(page.getByRole("list", { name: "저장소 목록" })).toBeVisible();
    });
  } else {
    test(`${tag}: 태블릿 두 칸 — 왼쪽 목록, 오른쪽 상세 → 파일 → diff → ← 로 복귀, ☰ 서랍`, async ({ page }, info) => {
      await start(page, size);
      await openRepo(page);
      const pane = page.locator(".m-pane");
      // 두 칸: 목록과 상세가 같이 보인다
      await expect(page.locator(".commits")).toBeVisible();
      await expect(pane).toBeVisible();
      const l = (await page.locator(".m-list").boundingBox())!, r = (await pane.boundingBox())!;
      expect(r.x).toBeGreaterThanOrEqual(l.x + l.width - 1);
      await page.locator(".commits").getByText("로그 파서").tap();
      await expect(pane.getByRole("heading", { name: "로그 파서" })).toBeVisible();
      await expect(pane.getByRole("button", { name: "뒤로" })).toHaveCount(0); // 상세엔 ← 가 없다
      await shot(page, "split", size, info);
      await pane.getByRole("button", { name: /lib\.rs/ }).tap();
      await expect(pane.locator("pre.diff.unified")).toBeVisible();
      await expect(page.locator(".commits")).toBeVisible(); // 목록은 그대로
      await shot(page, "split-diff", size, info);
      await pane.getByRole("button", { name: "뒤로" }).tap();
      await expect(pane.getByRole("heading", { name: "로그 파서" })).toBeVisible();
      // 다른 커밋을 누르면 diff를 보던 칸이 그 커밋의 상세로
      await pane.getByRole("button", { name: /lib\.rs/ }).tap();
      await page.locator(".commits").getByText("Initial commit").tap();
      await expect(pane.getByRole("heading", { name: "Initial commit" })).toBeVisible();
      // ☰ 서랍: 브랜치·태그·원격·스태시만
      const bar = page.locator(".m-bar").first();
      const toggle = bar.getByRole("button", { name: "사이드바 열기/닫기" });
      expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await toggle.tap();
      const drawer = page.getByRole("dialog", { name: "브랜치 선택" });
      await expect(drawer).toBeVisible();
      await expect(drawer.getByText("feature").first()).toBeVisible();
      await shot(page, "drawer", size, info);
      await page.touchscreen.tap(size.width - 20, size.height / 2); // 서랍 밖
      await expect(drawer).toHaveCount(0);
      await expect(bar.getByRole("button", { name: "설정" })).toBeVisible();
    });
  }
}

test("gix가 거절하는 조회(서브모듈·worktree·commit-graph)는 오류 토스트·배너 없이 조용히 빈다", async ({ page }) => {
  await start(page, PHONES[0], () => ((window as any).__unsupported = ["load_submodules", "load_worktrees", "ensure_commit_graph", "lfs_status"]));
  await openRepo(page);
  await page.waitForTimeout(500);
  await expect(page.locator(".toast, [role=alert]")).toHaveCount(0);
});

test("자동 fetch는 gix가 받는 `fetch`만 보낸다 (--all·--prune·--tags·--progress 없이)", async ({ page }) => {
  await start(page, PHONES[0], () => localStorage.setItem("autoFetch", "5"));
  await openRepo(page);
  await expect.poll(async () => page.evaluate(() => ((window as any).__git as string[][]).filter((c) => c[0] === "start_job").map((c) => JSON.parse(c[1]).args))).toContainEqual(["fetch"]);
});

test("최상위 파일은 폴더 줄이 비고, 하위 파일은 폴더만 보인다", async ({ page }) => {
  await start(page, PHONES[0], () => ((window as any).__changedFiles = [{ path: "README", oldPath: null, status: "M" }, { path: "src/lib.rs", oldPath: null, status: "M" }]));
  await openRepo(page);
  await page.locator(".commits").getByText("로그 파서").tap();
  await expect(page.locator(".m-pane .m-fdir")).toHaveText(["", "src"]);
});

test("데스크탑 UA에서는 모바일 규칙·화면이 켜지지 않는다", async ({ browser }) => {
  const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36", viewport: { width: 820, height: 1180 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => (window as any).__reposRoot = "/should/be/ignored");
  await page.goto("/");
  await expect(page.locator("html")).not.toHaveAttribute("data-mobile", "");
  await expect(page.locator(".m-root")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "저장소 열기" })).toBeVisible();
  await page.getByRole("button", { name: "복제…" }).click();
  await expect(page.getByRole("dialog").getByText("/should/be/ignored")).toHaveCount(0);
  await expect(page.getByRole("dialog").getByRole("textbox", { name: "URL" })).toHaveAttribute("placeholder", /git@/); // 데스크탑은 ssh 주소도 안내
  await ctx.close();
});
