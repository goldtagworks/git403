import { expect, test, type Page } from "@playwright/test";

// diff 화면: 파일 머리줄, 줄 번호, 단어 강조, 구문 강조, 한 줄/나란히, 큰 diff
const renders = (page: Page) => page.evaluate(() => ({ ...(window as any).__renders }) as Record<string, number>);
const open = async (page: Page, fileDiff?: string, ready = ".diff .add") => {
  await page.addInitScript((d) => d && ((window as any).__fileDiff = d), fileDiff);
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(ready).first()).toBeVisible();
};

test("머리줄은 폴더 흐리게·파일 이름 굵게, diff 원문 머리는 숨긴다", async ({ page }) => {
  await open(page);
  const file = page.locator(".diff-file");
  await expect(file.locator(".dir")).toHaveText("crates/graph/src/");
  await expect(file.locator("b")).toHaveText("lib.rs");
  await expect(page.locator(".diff")).not.toContainText("diff --git");
  await expect(page.locator(".diff")).not.toContainText("index 3f2a1b0");
  await expect(page.locator(".diff")).not.toContainText("+++ b/");
});

test("새 파일·이름 변경·모드 변경은 머리줄에 작게 표시된다", async ({ page }) => {
  await open(page, "diff --git a/old/a.txt b/new/b.txt\nsimilarity index 90%\nrename from old/a.txt\nrename to new/b.txt\nold mode 100644\nnew mode 100755\n", ".diff-file");
  const file = page.locator(".diff-file");
  await expect(file.locator("b")).toHaveText("b.txt");
  await expect(file.locator(".diff-tag")).toHaveText(["이름 변경 · old/a.txt", "모드 644 → 755"]);
});

test("옛·새 줄 번호 두 칸: 삭제는 옛 번호만, 추가는 새 번호만", async ({ page }) => {
  await open(page);
  const nums = (sel: string) => page.locator(sel).first().locator(".ln").allTextContents();
  expect(await nums(".dl:not(.add):not(.del)")).toEqual(["12", "12"]);
  expect(await nums(".dl.del")).toEqual(["13", ""]);
  expect(await nums(".dl.add")).toEqual(["", "13"]);
  expect(await page.locator(".dl.add").nth(2).locator(".ln").allTextContents()).toEqual(["", "15"]);
  expect(await page.locator(".dl:not(.add):not(.del)").nth(1).locator(".ln").allTextContents()).toEqual(["14", "16"]);
  // 두 번째 hunk(@@ -40 +42)
  expect(await page.locator(".dl.del").nth(1).locator(".ln").allTextContents()).toEqual(["41", ""]);
});

test("짝지은 삭제·추가 줄은 바뀐 글자만 더 진하게", async ({ page }) => {
  await open(page);
  await expect(page.locator(".dl.add .wd")).toHaveText("Event");
  await expect(page.locator(".dl.del .wd")).toHaveCount(0);
});

test("확장자로 구문 강조 (라이트·다크 모두 토큰 색)", async ({ page }) => {
  await open(page);
  const kw = page.locator(".dl .hl-keyword").first();
  await expect(kw).toBeVisible();
  const [kwColor, plain] = await page.evaluate(() => [getComputedStyle(document.querySelector(".hl-keyword")!).color, getComputedStyle(document.querySelector(".dl .code")!).color]);
  expect(kwColor).not.toBe(plain);
});

test("한 줄/나란히 전환은 저장되고, 다른 큰 컴포넌트를 다시 그리지 않는다", async ({ page }) => {
  await open(page);
  const before = await renders(page);
  await page.getByRole("radio", { name: "나란히" }).click();
  await expect(page.locator(".diff.split .sr").first()).toBeVisible();
  await expect(page.getByRole("radio", { name: "나란히" })).toHaveAttribute("aria-checked", "true");
  const after = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Details", "Toolbar"]) expect(after[id], id).toBe(before[id]);
  // 나란히: 삭제는 왼쪽, 추가는 오른쪽, 문맥은 양쪽
  const first = page.locator(".sr").first();
  await expect(first.locator(".sc")).toHaveCount(2);
  await expect(page.locator(".sr .sc.del").first()).toContainText("let color = 0;");
  await expect(page.locator(".sr .sc.add").first()).toContainText("// 레인마다");
  await page.reload(); // 저장소는 기억돼 있어 바로 열린다
  await expect(page.locator(".diff.split .sr").first()).toBeVisible();
  await page.getByRole("radio", { name: "한 줄" }).click();
  await expect(page.locator(".diff.unified .dl").first()).toBeVisible();
});

test("나란히에서도 줄을 골라 그 줄만 스테이지한다", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("diffMode", '"split"'));
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await page.getByText("로컬 변경사항").click();
  await page.getByRole("listbox", { name: "스테이지 안 됨" }).getByRole("option", { name: /Toolbar.tsx/ }).click();
  const diff = page.locator(".diff.split");
  await diff.getByText("// 레인마다 색을 다르게 준다.").click();
  await diff.getByText("let mut next_color = 0;").click({ modifiers: ["Shift"] });
  await diff.getByRole("button", { name: "선택한 줄 스테이지" }).first().click();
  const [cmd, args] = (await page.evaluate(() => (window as any).__git as string[][])).at(-1)!;
  expect(cmd).toBe("apply_partial");
  expect(JSON.parse(args)).toMatchObject({ hunk: 0, lines: [2, 3], target: "stage" });
});

test("큰 diff는 일부만 먼저 그리고, 끝에 닿으면 더 그린다 (구문 강조는 끈다)", async ({ page }) => {
  const big = (n: number) => `diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n@@ -1,${n} +1,${n} @@\n` + Array.from({ length: n }, (_, i) => (i % 2 ? `+const v${i} = ${i};` : `-const v${i} = ${i + 1};`)).join("\n") + "\n";
  await open(page, big(30000));
  const rows = page.locator(".diff .dl");
  expect(await rows.count()).toBeLessThan(5000);
  await expect(page.locator(".diff-more")).toBeVisible();
  await expect(page.locator(".diff .hl-keyword")).toHaveCount(0);
  await page.locator(".diff").evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect.poll(() => rows.count()).toBeGreaterThan(2500);
});
