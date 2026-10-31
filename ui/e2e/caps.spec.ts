import { expect, test, type Page } from "@playwright/test";

// 백엔드가 지원하는 작업만 보인다 (shared/lib/caps.ts). mock의 window.__caps = {all, ops}.
const LIMITED = { all: false, ops: ["log", "status", "commit", "fetch", "switch", "branch"] };
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const start = async (page: Page, caps?: object) => {
  await page.addInitScript((c) => {
    localStorage.setItem("autoFetch", "0");
    if (c) (window as any).__caps = c;
  }, caps);
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
};
const palette = async (page: Page, q: string) => {
  await page.keyboard.press("ControlOrMeta+p");
  const d = page.getByRole("dialog", { name: "빠른 실행" });
  await d.getByRole("textbox").fill(q);
  return d.getByRole("option");
};

test.use({ userAgent: MAC });

test("all:true(기본)면 툴바·메뉴·빠른 실행이 그대로다", async ({ page }) => {
  await start(page);
  const bar = page.locator(".toolbar");
  for (const n of ["Fetch", "Pull", "Push", "스태시", "팝"]) await expect(bar.getByRole("button", { name: n, exact: true })).toBeVisible();
  await expect(await palette(page, "Push")).not.toHaveCount(0);
  await page.keyboard.press("Escape");
  const labels = await page.evaluate(() => (window as any).__appMenu.model().find((r: any) => r.label === "저장소").items.map((i: any) => i.label));
  expect(labels).toContain("Push");
  expect(labels).toContain("서브모듈 추가…");
});

test("지원 작업이 제한되면 툴바 버튼·메뉴 막대·빠른 실행·우클릭 메뉴에서 미지원 항목이 사라지고 지원 항목은 남는다", async ({ page }) => {
  await start(page, LIMITED);
  const bar = page.locator(".toolbar");
  await expect(bar.getByRole("button", { name: "Fetch", exact: true })).toBeVisible();
  await expect(bar.getByRole("button", { name: "브랜치", exact: true })).toBeVisible();
  for (const n of ["Pull", "Push", "스태시", "팝"]) await expect(bar.getByRole("button", { name: n, exact: true })).toHaveCount(0);

  // 메뉴 막대
  const repo = await page.evaluate(() => (window as any).__appMenu.model().find((r: any) => r.label === "저장소").items.map((i: any) => (i.sep ? "-" : i.label)));
  expect(repo).toEqual(["Fetch", "-", "새 브랜치…", "-", "Pull Request 만들기…"]);
  for (const n of ["Pull", "Push", "스태시…", "서브모듈 추가…", "Worktree 추가…", "패치 적용…"]) expect(repo).not.toContain(n);

  // 빠른 실행
  await expect(await palette(page, "Fetch")).not.toHaveCount(0);
  for (const q of ["Push", "Pull…", "스태시", "서브모듈", "Worktree", "Git Flow", "LFS"]) await expect(await palette(page, q)).toHaveCount(0);
  await page.keyboard.press("Escape");

  // 커밋 우클릭: merge·rebase·cherry-pick·revert·reset·태그는 숨고 브랜치 만들기는 남는다
  await page.locator(".commits").getByText("로그 파서").click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: /새 브랜치/ })).toBeVisible();
  for (const n of [/cherry-pick/, /머지/, /리베이스|Rebase/i, /revert/, /Reset/i, /태그/]) await expect(menu.getByRole("menuitem", { name: n })).toHaveCount(0);
  const rows = await menu.evaluate((m) => [...m.children].map((c) => (c.tagName === "HR" ? "-" : c.textContent!.trim())));
  expect(rows[0]).not.toBe("-");
  expect(rows.at(-1)).not.toBe("-");
  expect(rows.some((r, i) => r === "-" && rows[i + 1] === "-")).toBe(false);
});

test("지원 제한 화면의 툴바 드롭다운에서 미지원 항목이 빠진다", async ({ page }) => {
  await start(page, { all: false, ops: ["fetch", "pull", "pull_opts"] }); // "Pull…"은 op pull_opts (gix는 --rebase·--autostash를 못 받아 숨김)
  await page.locator(".toolbar").getByRole("button", { name: "Pull 옵션" }).click();
  await expect(page.getByRole("menuitem", { name: "옵션 선택해서 Pull…" })).toBeVisible();
});

test("git.unsupported 오류는 번역된 문구로 보인다", async ({ page }) => {
  await start(page);
  await page.evaluate(() => ((window as any).__job = { early: true, errCode: { code: "git.unsupported", vars: { op: "push" }, message: "not supported in this environment: push" } }));
  await page.locator(".toolbar").getByRole("button", { name: "Push", exact: true }).click();
  await expect(page.getByText("이 환경에서는 지원하지 않는 작업입니다: push")).toBeVisible();
});
