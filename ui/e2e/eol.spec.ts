import { expect, test, type Page } from "@playwright/test";

// 줄바꿈(CRLF/LF) 자동 처리: .gitattributes 제안, 커밋 전 CRLF 검사, diff CR 무시
const calls = (page: Page) => page.evaluate(() => (window as any).__git as string[][]);
const open = async (page: Page, flags: Record<string, unknown> = {}) => {
  await page.addInitScript((f) => Object.assign(window, f), flags);
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
};
const sheet = (page: Page, name: string) => page.getByRole("dialog", { name });

test("저장소를 열 때는 묻지 않는다 (git 설정을 따른다)", async ({ page }) => {
  await open(page, { __eolRule: false });
  await page.waitForTimeout(300);
  await expect(sheet(page, "줄바꿈을 LF로 통일할까요?")).toHaveCount(0);
});

test("설정에서 고르면 .gitattributes에 규칙을 추가한다 (커밋은 안 함)", async ({ page }) => {
  await open(page, { __eolRule: false });
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByRole("button", { name: /줄바꿈 LF 통일/ }).click();
  await sheet(page, "줄바꿈을 LF로 통일할까요?").getByRole("button", { name: "추가" }).click();
  const c = (await calls(page)).find((x) => x[0] === "append_line")!;
  expect(JSON.parse(c[1])).toMatchObject({ file: ".gitattributes", line: "* text=auto eol=lf" });
  expect((await calls(page)).some((x) => x[0] === "commit")).toBe(false);
});

test("규칙이 이미 있으면 설정에서 골라도 알림만", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByRole("button", { name: /줄바꿈 LF 통일/ }).click();
  await expect(sheet(page, "줄바꿈을 LF로 통일할까요?")).toHaveCount(0);
});

const startCommit = async (page: Page) => {
  await page.getByText("로컬 변경사항").click();
  await page.getByLabel("커밋 제목").fill("줄바꿈");
  await page.getByRole("button", { name: "커밋", exact: true }).click();
};

test("커밋 전 CRLF 파일이 있으면 확인: LF로 바꿔서 커밋", async ({ page }) => {
  await open(page, { __crlf: ["a.txt", "b.txt"] });
  await startCommit(page);
  const s = sheet(page, "CRLF 줄바꿈 확인");
  await expect(s).toContainText("2개");
  await s.getByRole("button", { name: "커밋" }).click();
  const names = (await calls(page)).map((c) => c[0]);
  expect(names.indexOf("fix_crlf")).toBeGreaterThan(-1);
  expect(names.indexOf("fix_crlf")).toBeLessThan(names.indexOf("commit"));
});

test("커밋 전 CRLF: 그대로 커밋 / 취소", async ({ page }) => {
  await open(page, { __crlf: ["a.txt"] });
  await startCommit(page);
  await sheet(page, "CRLF 줄바꿈 확인").getByRole("combobox").selectOption("그대로 커밋");
  await sheet(page, "CRLF 줄바꿈 확인").getByRole("button", { name: "커밋" }).click();
  let names = (await calls(page)).map((c) => c[0]);
  expect(names).toContain("commit");
  expect(names).not.toContain("fix_crlf");
});

test("커밋 전 CRLF: 취소하면 커밋하지 않는다", async ({ page }) => {
  await open(page, { __crlf: ["a.txt"] });
  await startCommit(page);
  await sheet(page, "CRLF 줄바꿈 확인").getByRole("button", { name: "취소" }).click();
  const names = (await calls(page)).map((c) => c[0]);
  expect(names).not.toContain("commit");
  expect(names).not.toContain("fix_crlf");
});

test("줄 끝 CR 무시: 기본 꺼짐, 켜면 diff 요청에 반영되고 hunk 스테이지가 꺼진다", async ({ page }) => {
  await open(page);
  await page.getByText("로컬 변경사항").click();
  const unstaged = page.getByRole("listbox", { name: "스테이지 안 됨" });
  await unstaged.getByRole("option", { name: /Toolbar.tsx/ }).click();
  await expect(page.getByRole("button", { name: /^hunk 스테이지/ }).first()).toBeVisible();
  expect((await calls(page)).some((c) => c[0] === "diff_eol")).toBe(false);

  await page.keyboard.press("ControlOrMeta+,");
  await page.getByLabel("diff에서 줄 끝(CR) 차이 무시").check();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: /^hunk 스테이지/ })).toHaveCount(0);
  await expect(page.getByText("줄 끝(CR) 차이를 숨기는 중")).toBeVisible();
  expect((await calls(page)).some((c) => c[0] === "diff_eol")).toBe(true);
});
