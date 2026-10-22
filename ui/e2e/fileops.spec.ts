import { expect, test, type Page } from "@playwright/test";

// 파일 휴지통 이동(trash_files)·이 버전으로 되돌리기(restore_file): 메뉴 위치, 확인창, 호출 인자, 오류 코드 번역
const calls = (page: Page, cmd: string) => page.evaluate((c) => ((window as any).__git as string[][]).filter((x) => x[0] === c), cmd);
const menu = (page: Page) => page.getByRole("menu");
const item = (page: Page, name: string) => menu(page).getByRole("menuitem", { name, exact: true });
const unstaged = (page: Page) => page.getByRole("listbox", { name: "스테이지 안 됨" });
const staged = (page: Page) => page.getByRole("listbox", { name: "스테이지됨", exact: true });
const M3 = "m3".padEnd(40, "0");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
  await page.evaluate(() => ((window as any).__asked = []));
});

const localChanges = async (page: Page) => {
  await page.getByText("로컬 변경사항").click();
  await expect(unstaged(page).getByRole("option").first()).toBeVisible();
};

test("변경 파일 메뉴: '휴지통으로 이동…'은 '변경 버리기…' 바로 아래(스테이지 안 됨·스테이지됨 모두), 확인 후 trash_files", async ({ page }) => {
  await localChanges(page);
  const f = unstaged(page).getByRole("option").first();
  const path = (await f.locator(".label").textContent())!;
  await f.click({ button: "right" });
  const labels = await menu(page).getByRole("menuitem").allTextContents();
  expect(labels.indexOf("휴지통으로 이동…")).toBe(labels.indexOf("변경 버리기…") + 1);
  await item(page, "휴지통으로 이동…").click();
  await expect.poll(() => page.evaluate(() => (window as any).__asked.length)).toBe(1);
  const msg = await page.evaluate(() => (window as any).__asked[0] as string);
  expect(msg).toContain(path);
  expect(msg).toContain("되살릴 수 있습니다");
  expect(await calls(page, "trash_files")).toEqual([["trash_files", JSON.stringify({ repo: "/demo/git403", paths: [path] })]]);

  // 스테이지됨 파일에도 있다 (변경 버리기 아래가 아니라 되돌리기 목록 안)
  const s = staged(page).getByRole("option").first();
  if (await s.count()) {
    await s.click({ button: "right" });
    await expect(item(page, "휴지통으로 이동…")).toBeVisible();
    await page.keyboard.press("Escape");
  }
});

test("확인창에서 아니오면 아무것도 호출하지 않는다", async ({ page }) => {
  await localChanges(page);
  await page.evaluate(() => ((window as any).__askNo = true));
  await unstaged(page).getByRole("option").first().click({ button: "right" });
  await item(page, "휴지통으로 이동…").click();
  await page.waitForTimeout(300);
  expect(await calls(page, "trash_files")).toEqual([]);
});

test("폴더(끝이 /)는 '휴지통으로 이동…'이 비활성", async ({ page }) => {
  await page.addInitScript(() => ((window as any).__statusExtra = [{ path: "build/", oldPath: null, index: ".", worktree: ".", untracked: true, conflict: false }]));
  await page.reload();
  await page.getByRole("button", { name: "저장소 열기" }).click({ timeout: 3000 }).catch(() => {});
  await localChanges(page);
  await unstaged(page).getByRole("option", { name: /build\// }).click({ button: "right" });
  await expect(item(page, "휴지통으로 이동…")).toBeDisabled();
});

test("휴지통 오류 코드는 번역해 보인다", async ({ page }) => {
  await localChanges(page);
  await page.evaluate(() => ((window as any).__fileOpFail = JSON.stringify({ code: "trash.isDirectory", vars: { path: "sub" }, message: "cannot trash a folder: sub" })));
  await unstaged(page).getByRole("option").first().click({ button: "right" });
  await item(page, "휴지통으로 이동…").click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("폴더는 휴지통으로 옮길 수 없습니다: sub");
  await expect(alert).not.toContainText('"code"');
});

test("커밋 상세 변경 파일 우클릭: 이 버전으로 되돌리기… → restore_file(rev, 경로)", async ({ page }) => {
  await page.locator(".commits").getByText("Merge branch 'feature/graph'").click();
  await page.getByRole("option", { name: /lib\.rs/ }).click({ button: "right" });
  await item(page, "이 버전으로 되돌리기…").click();
  await expect.poll(() => page.evaluate(() => (window as any).__asked.length)).toBe(1);
  const msg = await page.evaluate(() => (window as any).__asked[0] as string);
  expect(msg).toContain("crates/graph/src/lib.rs");
  expect(msg).toContain("덮어써집니다");
  expect(await calls(page, "restore_file")).toEqual([["restore_file", JSON.stringify({ repo: "/demo/git403", rev: M3, paths: ["crates/graph/src/lib.rs"] })]]);
});

test("복원 오류 코드(커밋에 없음)는 번역해 보인다", async ({ page }) => {
  await page.evaluate(() => ((window as any).__fileOpFail = JSON.stringify({ code: "restore.notInRev", vars: { path: "a.rs", rev: "m300000" }, message: "x" })));
  await page.locator(".commits").getByText("Merge branch 'feature/graph'").click();
  await page.getByRole("option", { name: /lib\.rs/ }).click({ button: "right" });
  await item(page, "이 버전으로 되돌리기…").click();
  await expect(page.getByRole("alert")).toContainText("a.rs은(는) m300000에 없습니다");
});

test("파일 히스토리 목록의 커밋 우클릭: 이 버전으로 되돌리기… (그 커밋 rev)", async ({ page }) => {
  await page.locator(".commits").getByText("Merge branch 'feature/graph'").click();
  await page.getByRole("option", { name: /lib\.rs/ }).click({ button: "right" });
  await item(page, "파일 히스토리").click();
  const hist = page.getByRole("dialog", { name: "파일 히스토리" });
  await hist.getByRole("option").nth(1).click({ button: "right" });
  await item(page, "이 버전으로 되돌리기…").click();
  await expect.poll(async () => (await calls(page, "restore_file")).length).toBe(1);
  const [, a] = (await calls(page, "restore_file"))[0];
  expect(JSON.parse(a).paths).toEqual(["crates/graph/src/lib.rs"]);
  expect(JSON.parse(a).rev).toHaveLength(40);
});
