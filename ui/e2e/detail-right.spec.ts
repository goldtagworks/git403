import { expect, test, type Page } from "@playwright/test";

// 상세 오른쪽 배치(설정 detailLayout = right, 앱 기본값): 그래프 | 상세 열. 파일을 누르면 diff가 그래프 자리(크게 보기)에 열린다.
const renders = (page: Page) => page.evaluate(() => ({ ...(window as any).__renders }) as Record<string, number>);
const box = (page: Page, sel: string) => page.locator(sel).first().boundingBox();

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("detailLayout", JSON.stringify("right")));
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".detail-col")).toBeVisible();
});

test("그래프는 세로 전체, 상세는 오른쪽 열이고 메시지 전체가 열 안에 보이며 diff는 숨는다", async ({ page }) => {
  await page.locator(".commits").getByText("NUL 구분자").first().click();
  const g = (await box(page, ".main > .pane.graph"))!, d = (await box(page, ".detail-col"))!, m = (await box(page, ".main"))!;
  expect(d.x).toBeGreaterThan(g.x + g.width - 2);
  expect(g.height).toBeGreaterThan(m.height - 2);
  expect(d.height).toBeGreaterThan(m.height - 2);
  await expect(page.locator(".info-body .head").first()).toHaveText("What:");
  await expect(page.locator(".info-body .msg-trailers dt")).toHaveText(["Resolves", "AI-Use"]);
  await expect(page.locator(".msg-box-subject")).toContainText("로그 파서");
  await expect(page.locator(".info-head")).toContainText("c300000");
  await expect(page.locator(".detail-col .diff-wrap")).toBeHidden();
  await page.screenshot({ path: `e2e/results/screens/detail-right-${test.info().project.name}.png` });
});

test("파일을 누르면 diff가 그래프 자리에 열리고 상세 열 폭은 그대로, Esc로 돌아온다 (그래프·사이드바 리렌더 없음)", async ({ page }) => {
  await page.locator(".commits").getByText("NUL 구분자").first().click();
  const w = (await box(page, ".detail-col .info"))!.width;
  const before = await renders(page);
  await page.locator(".files [role=option]").first().click();
  await expect(page.locator("html")).toHaveAttribute("data-big", "");
  await expect(page.locator(".detail-col .diff").first()).toBeVisible();
  await expect(page.locator(".main > .pane.graph")).toBeHidden();
  const info = (await box(page, ".detail-col .info"))!, diff = (await box(page, ".detail-col .diff-wrap"))!;
  expect(Math.abs(info.width - w)).toBeLessThan(2);
  expect(info.x).toBeGreaterThan(diff.x + diff.width - 2); // 상세 열은 오른쪽에 남는다
  const after = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Toolbar"]) expect(after[id], id).toBe(before[id]);
  await page.screenshot({ path: `e2e/results/screens/detail-right-diff-${test.info().project.name}.png` });
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).not.toHaveAttribute("data-big", "");
  await expect(page.locator(".main > .pane.graph")).toBeVisible();
  await expect(page.locator(".detail-col .diff-wrap")).toBeHidden();
});

test("로컬 변경사항도 오른쪽 열: 파일을 누르면 diff가 그래프 자리에", async ({ page }) => {
  await page.locator(".commits").getByText("로컬 변경사항").click();
  await expect(page.locator(".detail-col .info.changes")).toBeVisible();
  await page.locator(".detail-col .info.changes [role=option]").first().click();
  await expect(page.locator("html")).toHaveAttribute("data-big", "");
  await expect(page.locator(".detail-col .diff").first()).toBeVisible();
});

test("설정에서 아래로 바꾸면 바로 그래프 아래 배치가 된다", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByRole("combobox").filter({ has: page.locator("option", { hasText: "오른쪽" }) }).selectOption("bottom");
  await page.keyboard.press("Escape");
  await expect(page.locator(".detail-col")).toHaveCount(0);
  const g = (await box(page, ".main > .pane.graph"))!, d = (await box(page, ".details"))!;
  expect(d.y).toBeGreaterThan(g.y + g.height - 2);
});

test("메시지 상자: 가로 분할선으로 높이 조절(저장), 누르면 그 자리에서 고치고 메시지 수정·취소", async ({ page }) => {
  await page.locator(".commits").getByText("NUL 구분자").first().click();
  const msgBox = page.locator(".msg-box");
  const h = (await msgBox.boundingBox())!.height;
  const sp = (await page.locator(".detail-col .info > .splitter.y").boundingBox())!;
  await page.mouse.move(sp.x + sp.width / 2, sp.y + 2);
  await page.mouse.down();
  await page.mouse.move(sp.x + sp.width / 2, sp.y + 82, { steps: 5 });
  await page.mouse.up();
  expect(Math.round((await msgBox.boundingBox())!.height - h)).toBe(80);
  expect(await page.evaluate(() => Number(localStorage.getItem("split:detail-msg")))).toBe(Math.round(h + 80));
  // 누르면 편집: 제목 입력·글자 수·본문, 바꾸지 않으면 수정 버튼 비활성, Esc·취소로 원래대로
  await msgBox.click();
  const subj = page.getByRole("textbox", { name: "제목" });
  await expect(subj).toHaveValue("로그 파서");
  await expect(page.getByRole("textbox", { name: "본문(선택)" })).toHaveValue(/^What:\n/);
  const run = page.locator(".msg-actions").getByRole("button", { name: "메시지 수정" });
  await expect(run).toBeDisabled();
  await subj.fill("로그 파서 고침");
  await expect(page.locator(".msg-box .msg-count")).toHaveText("8");
  await expect(run).toBeEnabled();
  await page.screenshot({ path: `e2e/results/screens/detail-right-edit-${test.info().project.name}.png` });
  await page.locator(".msg-actions").getByRole("button", { name: "취소" }).click();
  await expect(page.locator(".msg-box-subject")).toContainText("로그 파서");
  await expect(subj).toHaveCount(0);
});
