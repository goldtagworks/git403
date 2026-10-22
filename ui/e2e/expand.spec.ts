import { expect, test, type Page } from "@playwright/test";
import { sha } from "./png";

// diff 문맥 펼치기·파일 전체(25f): 헝크 사이·앞·뒤 숨은 줄, 위/아래/전부, 구문 강조, 한 줄/나란히, 공백 표시, 리렌더링
// mock 기본 diff: lib.rs 새 쪽 hunk가 12..20, 42..48 → 숨은 줄 11 / 21 / (60줄 파일이면) 12
const M3 = sha("m3");
const PATH = "crates/graph/src/lib.rs";
const b64 = (s: string) => Buffer.from(s).toString("base64");
const FILE = Array.from({ length: 60 }, (_, i) => `let v${i + 1} = ${i + 1};${i === 29 ? "\t  // tab" : ""}`).join("\n") + "\n";
const blobCalls = (page: Page) => page.evaluate(() => (window as any).__git.filter((c: string[]) => c[0] === "file_blob").length as number);

async function open(page: Page, blob: string | null = FILE) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript((b) => b && ((window as any).__blobs = { [b[0]]: b[1] }), blob === null ? null : [`${M3}:${PATH}`, b64(blob)]);
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click({ timeout: 3000 }).catch(() => {});
  await page.locator(".commits").getByText("Merge branch 'feature/graph'").click();
  await page.getByRole("option", { name: /lib\.rs/ }).click();
  await expect(page.locator(".diff .add").first()).toBeVisible();
}
// 공백 표시는 넓으면 도구줄 버튼, 좁으면 ⋯ 메뉴
const toggleWs = async (page: Page) => {
  if (await page.locator(".tools-wide").isVisible()) return page.getByRole("button", { name: "공백 표시" }).click();
  await page.getByRole("button", { name: "diff 도구 더 보기" }).click();
  await page.getByRole("menuitem", { name: "공백 표시" }).click();
};
const rowsOf = (page: Page) => page.locator(".diff .xrow");
const nums = (page: Page, i: number) => page.locator(".dl.xl").nth(i).locator(".ln").allTextContents();

test("숨은 줄 자리마다 펼치기 행: 첫 hunk 위·사이·마지막 아래, 위/아래/전부", async ({ page }) => {
  await open(page);
  // 맨 끝 행은 줄 수를 알아야 보인다: diff를 그린 뒤 한가할 때 파일을 한 번 미리 읽어 줄 수를 알면 나타난다
  await expect(rowsOf(page)).toHaveText([/↕ 11줄 펼치기/, /↕ 21줄 펼치기/, /↕ 12줄 펼치기/]);
  expect(await blobCalls(page)).toBe(1);
  await expect(rowsOf(page).first().getByRole("button")).toHaveText(["위로 11줄", "전부"]); // 첫 hunk 앞: 위로만
  await expect(rowsOf(page).nth(1).getByRole("button")).toHaveText(["위로 20줄", "아래로 20줄", "전부"]);

  // 사이 구간 "위로": 다음 hunk에 이웃한 20줄 (새 22~41, 옛 20~39), 1줄 남는다
  await rowsOf(page).nth(1).getByRole("button", { name: "위로 20줄" }).click();
  await expect(page.locator(".dl.xl")).toHaveCount(20);
  expect(await nums(page, 0)).toEqual(["20", "22"]);
  expect(await nums(page, 19)).toEqual(["39", "41"]);
  await expect(rowsOf(page).nth(1)).toContainText("↕ 1줄 펼치기");
  expect(await blobCalls(page)).toBe(1);
  // 구문 강조는 펼친 줄에도
  await expect(page.locator(".dl.xl .hl-keyword").first()).toBeVisible();
  // 원래 hunk 줄·번호는 그대로, 펼친 줄은 고르기 대상(data-i)이 아니다
  expect(await page.locator(".dl.xl[data-i]").count()).toBe(0);
  expect(await page.locator(".dl.del").first().locator(".ln").allTextContents()).toEqual(["13", ""]);

  // 첫 구간 "전부": 1~11
  await rowsOf(page).first().getByRole("button", { name: "전부" }).click();
  await expect(rowsOf(page)).toHaveCount(2);
  expect(await nums(page, 0)).toEqual(["1", "1"]);
  // 맨 끝: 파일을 읽은 뒤 12줄이 남고 "아래로 20줄"로 모두 펼치면 행이 없어진다
  await rowsOf(page).last().getByRole("button", { name: "아래로 12줄" }).click();
  await expect(rowsOf(page)).toHaveCount(1);
  expect(await blobCalls(page)).toBe(1); // 처음 한 번만
});

test("파일 전체: 모든 숨은 구간을 펼치고 저장된다, 나란히에서도 동작", async ({ page }) => {
  await open(page);
  const scope = page.getByRole("radiogroup", { name: "보여 줄 내용" });
  await expect(scope.getByRole("radio", { name: "Diff" })).toHaveAttribute("aria-checked", "true");
  await scope.getByRole("radio", { name: "파일 전체" }).click();
  await expect(page.locator(".dl.xl")).toHaveCount(44); // 11 + 21 + 12
  await expect(rowsOf(page)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("diffFull"))).toBe("true");
  expect(await page.locator(".dl.add").count()).toBe(5); // hunk 줄은 그대로
  await page.getByRole("radiogroup", { name: "diff 보기" }).getByRole("radio", { name: "나란히" }).click();
  await expect(page.locator(".sr .xl")).toHaveCount(88);
  await expect(page.locator(".sc.xl .hl-keyword").first()).toBeVisible();
  // 다시 Diff로: 행이 돌아온다
  await scope.getByRole("radio", { name: "Diff" }).click();
  await expect(page.locator(".xl")).toHaveCount(0);
  await expect(rowsOf(page)).toHaveCount(3);
  await page.getByRole("radiogroup", { name: "diff 보기" }).getByRole("radio", { name: "한 줄" }).click();
});

test("읽을 수 없는 파일(없음·바이너리)은 행 대신 첫 자리에 흐린 안내 한 줄, 토글도 숨긴다", async ({ page }) => {
  await open(page, null);
  await expect(page.locator(".diff .xnote")).toHaveCount(1);
  await expect(page.locator(".diff .xnote")).toContainText("펼칠 수 없음");
  await expect(rowsOf(page)).toHaveCount(1); // 안내 행 하나뿐
  await expect(page.getByRole("radiogroup", { name: "보여 줄 내용" })).toHaveCount(0);
  await expect(page.locator(".diff .add").first()).toBeVisible(); // diff 자체는 그대로
});

test("바이너리(NUL 포함) 파일도 같은 안내", async ({ page }) => {
  await open(page, "ab\0cd\n");
  await expect(page.locator(".diff .xnote")).toHaveCount(1);
});

test("큰 파일(8000줄)도 펼친 구간에는 구문 강조가 들어간다", async ({ page }) => {
  await open(page, Array.from({ length: 8000 }, (_, i) => `let v${i + 1} = ${i + 1};`).join("\n") + "\n");
  await expect(rowsOf(page)).toHaveCount(3);
  await rowsOf(page).last().getByRole("button", { name: "아래로 20줄" }).click();
  await expect(page.locator(".dl.xl")).toHaveCount(20);
  await expect(page.locator(".dl.xl .hl-keyword")).toHaveCount(20);
});

test("공백 표시: 공백·탭·줄 끝 표시, 글자는 그대로", async ({ page }) => {
  await open(page);
  await expect(page.locator(".diff .ws-c")).toHaveCount(0);
  await toggleWs(page);
  await expect(page.locator(".diff .ws-c").first()).toBeVisible();
  await expect(page.locator(".diff")).toHaveClass(/showws/);
  expect(await page.locator(".dl.add .code").first().textContent()).toContain("    // 레인마다"); // 공백은 원문 그대로
  await toggleWs(page);
  await expect(page.locator(".diff .ws-c")).toHaveCount(0);
});

test("스크린샷: 펼친 diff·파일 전체·공백 표시", async ({ page }, info) => {
  await open(page);
  await rowsOf(page).nth(1).getByRole("button", { name: "위로 20줄" }).click();
  await page.screenshot({ path: `e2e/results/screens/diff-expand-${info.project.name}.png` });
  await toggleWs(page);
  await page.getByRole("radiogroup", { name: "보여 줄 내용" }).getByRole("radio", { name: "파일 전체" }).click();
  await page.getByRole("radiogroup", { name: "diff 보기" }).getByRole("radio", { name: "나란히" }).click();
  await expect(page.locator(".sr .xl").first()).toBeVisible();
  await page.screenshot({ path: `e2e/results/screens/diff-fullfile-${info.project.name}.png` });
});
