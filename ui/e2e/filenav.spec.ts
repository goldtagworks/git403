import { expect, test } from "@playwright/test";

// diff 화면의 이전/다음 파일 이동 (25a)
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".diff .add").first()).toBeVisible();
});

const selected = (page: import("@playwright/test").Page, list: string) =>
  page.getByRole("listbox", { name: list, exact: true }).getByRole("option", { selected: true });

test("커밋 상세: 버튼·단축키로 이동, 끝에서 버튼 숨김, 목록 선택 동기화", async ({ page }) => {
  const prev = page.getByRole("button", { name: "이전 파일" });
  const next = page.getByRole("button", { name: "다음 파일" });
  const sel = selected(page, "변경 파일");
  await page.locator(".commits").getByText("Merge branch 'feature/graph'").click();
  await page.getByRole("option", { name: /lib.rs/ }).click();
  await expect(prev).toHaveCount(0); // 첫 파일
  await expect(next).toBeVisible();
  await next.hover();
  await expect(next).toHaveAttribute("title", "다음 파일");
  await next.click();
  await expect(sel).toContainText("CommitGraph.tsx");
  await expect(prev).toBeVisible();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(sel).toContainText("old.css");
  await expect(next).toHaveCount(0); // 마지막 파일
  await page.keyboard.press("Alt+ArrowRight"); // 끝에서는 아무 일 없음
  await expect(sel).toContainText("old.css");
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(sel).toContainText("CommitGraph.tsx");
});

test("변경 화면: 보고 있는 목록 안에서만 이동하고 입력창에서는 단축키를 무시한다", async ({ page }) => {
  await page.getByText("로컬 변경사항").click();
  const unstaged = page.getByRole("listbox", { name: "스테이지 안 됨", exact: true }).getByRole("option");
  await unstaged.first().click();
  const prev = page.getByRole("button", { name: "이전 파일" });
  const next = page.getByRole("button", { name: "다음 파일" });
  await expect(prev).toHaveCount(0);
  await next.click();
  await expect(selected(page, "스테이지 안 됨")).toContainText("notes.md");
  await expect(next).toHaveCount(0); // 끝에 닿아도 스테이지됨 목록으로 넘어가지 않는다
  await page.keyboard.press("Alt+ArrowRight");
  await expect(selected(page, "스테이지 안 됨")).toContainText("notes.md");
  await page.getByLabel("커밋 제목", { exact: true }).focus();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(selected(page, "스테이지 안 됨")).toContainText("notes.md");
  await page.locator(".diff-pane").click();
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(selected(page, "스테이지 안 됨")).toContainText("Toolbar.tsx");
  // 스테이지됨 목록은 파일이 하나라 버튼이 없다
  await page.getByRole("listbox", { name: "스테이지됨", exact: true }).getByRole("option").first().click();
  await expect(prev).toHaveCount(0);
  await expect(next).toHaveCount(0);
});
