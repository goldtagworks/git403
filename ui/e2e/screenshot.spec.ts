import { expect, test } from "@playwright/test";
import { AFTER, BEFORE, seed, sha } from "./png";
import { cellXib, textDiff } from "./ib";

// 시각 확인용 스크린샷 (테스트 판정 없음). 결과: e2e/results/screens/
test("화면 캡처", async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await page.locator(".commits").getByText("Merge branch 'feature/graph'").click();
  await page.getByRole("option", { name: /lib.rs/ }).click();
  await expect(page.getByRole("button", { name: "다음 파일" })).toBeVisible(); // 이전/다음 파일 버튼 포함
  await page.screenshot({ path: `e2e/results/screens/main-${info.project.name}.png` });
  await page.getByText("로컬 변경사항").click();
  await page.getByRole("listbox", { name: "스테이지 안 됨" }).getByRole("option").first().click();
  await expect(page.getByRole("button", { name: "다음 파일" })).toBeVisible();
  await page.screenshot({ path: `e2e/results/screens/changes-${info.project.name}.png` });
});

// diff 확인용 캡처: 한 줄·나란히, 라이트·다크 (결과: e2e/results/screens/diff-*.png)
const DIR = "apps/web/src/features/home/";
const TS = `diff --git a/${DIR}HomePlaylist.tsx b/${DIR}HomePlaylist.tsx
index 3f2a1b0..9c4d2e1 100644
--- a/${DIR}HomePlaylist.tsx
+++ b/${DIR}HomePlaylist.tsx
@@ -13,7 +13,7 @@ import { useTracker } from "@/lib/tracker";
 export function HomePlaylist({ items }: Props) {
   const { track } = useTracker();
   // 클릭 로그: 영역별로 남긴다.
-  const ids = items.map((i) => i.trackLogIds);
+  const ids = items.map((i) => i.trackEventLogIds);
   const total = ids.length + 1;
   return <List data={items} onClick={() => track("click", ids)} />;
 }
@@ -40,6 +40,9 @@ export const RULES = {
   retries: 3,
   timeout: 1500,
-  label: "dj",
+  label: "dj-playlist",
+  enabled: true,
+  /* 새 설정 */
+  limit: \`max-\${3}\`,
 };
`;
for (const mode of ["unified", "split"]) {
  test(`diff 캡처 ${mode}`, async ({ page }, info) => {
    await page.addInitScript(([d, m]) => ((window as any).__fileDiff = d, localStorage.setItem("diffMode", JSON.stringify(m))), [TS, mode]);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.getByRole("button", { name: "저장소 열기" }).click();
    await expect(page.locator(".diff .hl-keyword").first()).toBeVisible();
    await page.screenshot({ path: `e2e/results/screens/diff-${mode}-${info.project.name}.png` });
    await page.getByText("로컬 변경사항").click();
    await page.getByRole("listbox", { name: "스테이지 안 됨" }).getByRole("option").first().click();
    await expect(page.locator(".hunk-btn").first()).toBeVisible();
    await page.screenshot({ path: `e2e/results/screens/diff-${mode}-changes-${info.project.name}.png` });
  });
}

// 이미지 diff 캡처: 나란히·슬라이더·차이, 라이트·다크 (결과: e2e/results/screens/image-*.png)
for (const mode of ["side", "slide", "diff"]) {
  test(`이미지 diff 캡처 ${mode}`, async ({ page }, info) => {
    const m3 = sha("m3");
    await seed(page, { blobs: { [`${m3}^:img/a.png`]: BEFORE, [`${m3}:img/a.png`]: AFTER } });
    await page.addInitScript((m) => localStorage.setItem("imgDiffMode", JSON.stringify(m)), mode);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.getByRole("button", { name: "저장소 열기" }).click();
    await page.locator(".commits").getByText("Merge branch 'feature/graph'").click();
    await page.getByRole("option", { name: /a\.png/ }).click();
    await expect(page.locator(".img-info")).toContainText("바뀐 픽셀 4.7%");
    await page.screenshot({ path: `e2e/results/screens/image-${mode}-${info.project.name}.png` });
  });
}

// xib 시각 diff 캡처: 라이트·다크 (결과: e2e/results/screens/xib-*.png)
test("xib diff 캡처", async ({ page }, info) => {
  const m3 = sha("m3"), p = "ui/Song/SongCell.xib", b64 = (s: string) => Buffer.from(s).toString("base64");
  await seed(page, { path: p, diff: textDiff(p), blobs: { [`${m3}^:${p}`]: b64(cellXib(false)), [`${m3}:${p}`]: b64(cellXib(true)) } });
  await page.setViewportSize({ width: 1280, height: 1150 });
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await page.locator(".commits").getByText("Merge branch 'feature/graph'").click();
  await page.getByRole("option", { name: /SongCell\.xib/ }).click();
  const row = (await page.getByRole("listbox", { name: "변경 목록" }).getByRole("option", { name: /제약 기준 변경/ }).boundingBox())!;
  await page.mouse.move(row.x + 20, row.y + row.height / 2);
  await expect(page.locator(".ib-hl").first()).toBeVisible();
  await page.screenshot({ path: `e2e/results/screens/xib-${info.project.name}.png` });
});
