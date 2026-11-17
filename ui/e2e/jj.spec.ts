import { expect, test, type Page } from "@playwright/test";
import { sha } from "./png";

// jj 보기(30d): jj 켜기·git/jj 보기 전환·행의 change ID·@·충돌 배지. mock의 `window.__jj = {enabled, status}`.
const STATUS = {
  workingCopy: sha("m3"),
  changeIds: {
    [sha("m3")]: { short: "kkmpptxzrspx", full: "kkmpptxzrspxqwertyuiopasdfghjklz" },
    [sha("c5")]: { short: "rlvkpnrzqnoo", full: "rlvkpnrzqnooqwertyuiopasdfghjklz" },
    [sha("c3")]: { short: "zzzzzzzzzzzz", full: "zzzzzzzzzzzzqwertyuiopasdfghjklz" },
  },
  conflicted: [sha("c5")],
  truncated: false,
};
const row = (page: Page, subject: string) => page.locator(".commits .row").filter({ hasText: subject });
const menuItem = (page: Page, name: string | RegExp) => page.getByRole("menu").getByRole("menuitem", { name });
const openRepoMenu = (page: Page) => page.locator(".toolbar .picker").first().click();
const hiddenArgs = (page: Page) => page.evaluate(() => ((window as any).__graphHidden as string[][]).at(-1)!);

async function open(page: Page, jj?: object) {
  await page.addInitScript((j) => {
    Object.assign(window, { __asked: [] }, j ? { __jj: j } : {});
  }, jj);
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(row(page, "README 정리")).toBeVisible();
}

test("jj가 꺼져 있으면 git 보기이고 메뉴에 'jj 모드 켜기'만 보인다 (refs/jj 제외는 백엔드)", async ({ page }) => {
  await open(page);
  await expect(page.locator(".jj-mark")).toHaveCount(0);
  expect(await hiddenArgs(page)).toEqual([]);
  await openRepoMenu(page);
  await expect(menuItem(page, "jj 모드 켜기…")).toBeVisible();
  await expect(menuItem(page, /jj 보기/)).toHaveCount(0);
});

test("jj 모드 켜기: OS 확인창 → jj_enable → jj 보기로 change ID·@가 보인다", async ({ page }) => {
  await open(page, { enabled: false, status: STATUS });
  await openRepoMenu(page);
  await menuItem(page, "jj 모드 켜기…").click();
  await expect(page.locator(".jj-mark")).toHaveCount(3);
  expect(await page.evaluate(() => (window as any).__asked as string[])).toEqual([expect.stringContaining(".jj 폴더")]);
  expect((await page.evaluate(() => (window as any).__git as string[][])).some((c) => c[0] === "jj_enable")).toBe(true);
  expect(await hiddenArgs(page)).toEqual([`+jj:${sha("m3")}`]);
  await openRepoMenu(page);
  await expect(menuItem(page, "jj 모드 켜기…")).toHaveCount(0);
  await expect(menuItem(page, /✓ jj 보기/)).toBeVisible();
});

test("확인창에서 취소하면 jj_enable을 부르지 않는다", async ({ page }) => {
  await open(page, { enabled: false, status: STATUS });
  await page.evaluate(() => ((window as any).__askNo = true));
  await openRepoMenu(page);
  await menuItem(page, "jj 모드 켜기…").click();
  await expect(page.locator(".jj-mark")).toHaveCount(0);
  expect((await page.evaluate(() => (window as any).__git as string[][])).some((c) => c[0] === "jj_enable")).toBe(false);
});

test("jj가 켜진 저장소는 기본이 jj 보기: change ID 앞 8자, @ 표시, 충돌 배지", async ({ page }) => {
  await open(page, { enabled: true, status: STATUS });
  await expect(page.locator(".jj-mark")).toHaveCount(3); // 상태에 있는 커밋만
  const m3 = row(page, "Merge branch 'feature/graph'");
  await expect(m3.locator(".jj-id")).toHaveText("kkmpptxz");
  await expect(m3.locator(".jj-id")).toHaveAttribute("title", "Change ID: kkmpptxzrspxqwertyuiopasdfghjklz");
  await expect(m3.locator(".jj-at")).toHaveText("@");
  await expect(m3.locator(".jj-conflict")).toHaveCount(0);
  const c5 = row(page, "README 정리");
  await expect(c5.locator(".jj-id")).toHaveText("rlvkpnrz");
  await expect(c5.locator(".jj-at")).toHaveCount(0);
  await expect(c5.locator(".jj-conflict")).toHaveText("충돌");
  await expect(page.locator(".jj-at")).toHaveCount(1);
  await expect(page.locator(".jj-conflict")).toHaveCount(1);
  expect(await hiddenArgs(page)).toEqual([`+jj:${sha("m3")}`]);
  await page.screenshot({ path: `e2e/results/screens/jj-${test.info().project.name}.png` });
});

test("git 보기로 전환하면 표시가 사라지고 표지 없이 다시 읽으며, 새로고침해도 저장소별로 기억한다", async ({ page }) => {
  await open(page, { enabled: true, status: STATUS });
  await openRepoMenu(page);
  await menuItem(page, /✓ jj 보기/).click();
  await expect(page.locator(".jj-mark")).toHaveCount(0);
  await expect.poll(() => hiddenArgs(page)).toEqual([]);
  await page.reload(); // 열린 탭이 복원된다
  await expect(row(page, "README 정리")).toBeVisible();
  await expect(page.locator(".jj-mark")).toHaveCount(0);
  await openRepoMenu(page);
  await menuItem(page, /jj 보기/).click(); // 다시 켜기
  await expect(page.locator(".jj-mark")).toHaveCount(3);
});

test("jj_status가 오류(꺼짐·실패)여도 git 보기로 그래프는 뜬다", async ({ page }) => {
  await open(page, { enabled: false });
  await expect(page.locator(".jj-mark")).toHaveCount(0);
  await expect(row(page, "README 정리")).toBeVisible();
});
