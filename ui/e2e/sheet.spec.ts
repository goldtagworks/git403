import { expect, test, type Page } from "@playwright/test";

// 팝업 공용 틀(shared/ui/Sheet.tsx): 머리줄·버튼줄·Esc·Enter·첫 포커스·포커스 복귀·비활성 이유, 설정 창 왼쪽 탐색
const openRepo = async (page: Page) => {
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
};
const gitCalls = (page: Page) => page.evaluate(() => ((window as any).__git as string[][]).filter((c) => c[0] !== "file_blob"));
const newBranch = (page: Page) => page.locator(".toolbar").getByRole("button", { name: "브랜치", exact: true });

test("입력 시트: 첫 입력칸 포커스, 비워 두면 주 버튼이 비활성이고 이유가 보인다, Enter = 주 버튼", async ({ page }, info) => {
  await openRepo(page);
  await newBranch(page).click();
  const d = page.getByRole("dialog", { name: "새 브랜치" });
  await expect(d.getByRole("textbox")).toBeFocused();
  const primary = d.getByRole("button", { name: "만들기" });
  await expect(primary).toBeDisabled();
  await expect(d.getByRole("status")).toHaveText("필수 항목을 입력하세요");
  // 주 버튼은 맨 오른쪽, 취소는 그 왼쪽
  const [c, p] = [await d.getByRole("button", { name: "취소" }).boundingBox(), await primary.boundingBox()];
  expect(c!.x + c!.width).toBeLessThan(p!.x);
  await page.screenshot({ path: `e2e/results/screens/sheet-prompt-${info.project.name}.png` });
  await d.getByRole("textbox").fill("feature/enter");
  await expect(d.getByRole("status")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(d).toHaveCount(0);
  expect((await gitCalls(page)).some((x) => x[0] === "switch" && x.includes("feature/enter"))).toBe(true);
});

test("시트를 Esc로 닫으면 열기 전 포커스(눌렀던 툴바 버튼)로 돌아간다", async ({ page }) => {
  await openRepo(page);
  await newBranch(page).focus();
  await page.keyboard.press("Enter");
  const d = page.getByRole("dialog", { name: "새 브랜치" });
  await expect(d).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(d).toHaveCount(0);
  await expect(newBranch(page)).toBeFocused();
});

test("위험 작업: Reset은 hard를 고를 때만 주 버튼이 danger 색", async ({ page }) => {
  await openRepo(page);
  await page.locator(".commits").getByText("로그 파서").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "현재 브랜치를 여기로 reset…" }).click();
  const d = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Reset" }) });
  await expect(d.getByRole("button", { name: "Reset" })).not.toHaveClass(/danger/);
  await d.getByRole("combobox").selectOption({ index: 2 });
  await expect(d.getByRole("button", { name: "Reset" })).toHaveClass(/danger/);
  await page.keyboard.press("Escape");
  await expect(d).toHaveCount(0);
});

test("툴바: 저장소가 없으면 비활성 버튼에 이유(툴팁)가 있다", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".toolbar .tool").filter({ has: page.getByRole("button", { name: "Fetch", exact: true }) })).toHaveAttribute("title", "저장소를 먼저 여세요");
});

test("모든 시트는 머리줄 X와 바닥 닫기를 둔다: 파일 히스토리는 X·바닥 닫기·Esc로 닫힌다", async ({ page }) => {
  await openRepo(page);
  const open = async () => {
    await page.getByRole("listbox", { name: "변경 파일" }).getByRole("option").first().click({ button: "right" });
    await page.getByRole("menu").getByRole("menuitem", { name: "파일 히스토리" }).click();
    return page.getByRole("dialog", { name: "파일 히스토리" });
  };
  let d = await open();
  await expect(d.locator(".sheet-actions").getByRole("button", { name: "닫기" })).toBeVisible();
  await d.locator(".sheet-head").getByRole("button", { name: "닫기" }).click();
  await expect(d).toHaveCount(0);
  d = await open();
  await d.locator(".sheet-actions").getByRole("button", { name: "닫기" }).click();
  await expect(d).toHaveCount(0);
  d = await open();
  await page.keyboard.press("Escape");
  await expect(d).toHaveCount(0);
});

test("설정 창 왼쪽 탐색: 검색칸이 위에, 3묶음(앱·저장소·연결)·묶음마다 아이콘, 선택 항목 배경", async ({ page }, info) => {
  await openRepo(page);
  await page.keyboard.press("ControlOrMeta+,");
  const d = page.getByRole("dialog", { name: "설정" });
  const nav = d.locator(".settings-nav");
  const [s, first] = [await nav.getByLabel("설정 검색").boundingBox(), await nav.getByRole("tab").first().boundingBox()];
  expect(s!.y).toBeLessThan(first!.y);
  await expect(nav.locator(".nav-group")).toHaveCount(3);
  await expect(nav.locator("[role=tab] .icon")).toHaveCount(8);
  // 묶음 사이 간격이 같은 묶음 안 항목 간격보다 크다
  const t = await nav.getByRole("tab").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
  expect(t[2] - t[1]).toBeGreaterThan(t[1] - t[0] + 6);
  // 묶음별 아이콘 색이 서로 다르다
  const colors = await nav.locator("[role=tab] .icon").evaluateAll((els) => els.map((e) => getComputedStyle(e).color));
  expect(new Set([colors[0], colors[2], colors[5]]).size).toBe(3);
  expect(new Set(colors.slice(0, 2)).size).toBe(1);
  // 선택 항목은 둥근 배경
  const sel = nav.getByRole("tab", { selected: true });
  expect(await sel.evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  expect(await sel.evaluate((e) => parseFloat(getComputedStyle(e).borderTopLeftRadius))).toBeGreaterThanOrEqual(6);
  await page.screenshot({ path: `e2e/results/screens/settings-${info.project.name}.png` });
  await d.getByRole("tab", { name: "AI", exact: true }).click();
  await page.screenshot({ path: `e2e/results/screens/settings-ai-${info.project.name}.png` });
});

test("작업 시트(입력·Rebase·PR 등)도 머리줄 X가 있고 바닥 취소와 같이 닫는다", async ({ page }) => {
  await openRepo(page);
  await newBranch(page).click();
  const d = page.getByRole("dialog", { name: "새 브랜치" });
  await expect(d.locator(".sheet-head").getByRole("button", { name: "닫기" })).toBeVisible();
  await expect(d.locator(".sheet-actions").getByRole("button", { name: "취소" })).toBeVisible();
  await d.locator(".sheet-head").getByRole("button", { name: "닫기" }).click();
  await expect(d).toHaveCount(0);
});
