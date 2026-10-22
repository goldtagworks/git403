import { expect, test, type Page } from "@playwright/test";
import { AFTER, BEFORE, WIDER, seed, sha } from "./png";

// 이미지 diff (25b): 4가지 비교 방식, 바뀐 픽셀 %·변경 영역, 한쪽만 있는 파일, 모드 저장, 변경 화면
const M3 = sha("m3");
const commitBlobs = { [`${M3}^:img/a.png`]: BEFORE, [`${M3}:img/a.png`]: AFTER };

async function open(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click({ timeout: 3000 }).catch(() => {}); // 새로고침하면 마지막 탭이 복원돼 버튼이 없다
  await page.locator(".commits").getByText("Merge branch 'feature/graph'").click();
  await page.getByRole("option", { name: /a\.png/ }).click();
}
const modes = (page: Page) => page.getByRole("radiogroup", { name: "이미지 비교 방식" });

test("커밋 상세: 이전/이후 정보·바뀐 픽셀·변경 영역과 4가지 비교 방식", async ({ page }) => {
  await seed(page, { blobs: commitBlobs });
  await open(page);
  const info = page.locator(".img-info");
  await expect(info).toContainText("이전 16×16 px");
  await expect(info).toContainText("이후 16×16 px");
  await expect(info).toContainText("바뀐 픽셀 4.7%");
  await expect(info).toContainText("변경 영역 (5, 6) 4×3");
  await expect(page.locator(".hunk-btn")).toHaveCount(0);

  // 나란히(기본): 양쪽 이미지, 양쪽에 점선 박스. 작은 이미지는 픽셀 그대로 확대
  await expect(modes(page).getByRole("radio", { name: "나란히" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".img-layer")).toHaveCount(2);
  await expect(page.locator(".img-box")).toHaveCount(2);
  await expect(page.locator(".img-layer").first()).toHaveClass(/pix/);
  expect(await page.locator(".img-layer").first().evaluate((e) => getComputedStyle(e).imageRendering)).toBe("pixelated");
  // 영역에 맞춰 확대되어도 이미지가 영역 밖으로 나가지 않는다
  const stage = (await page.locator(".img-stage").boundingBox())!;
  const fr = (await page.locator(".img-frame").first().boundingBox())!;
  expect(fr.width).toBeGreaterThan(64);
  expect(fr.x + fr.width).toBeLessThanOrEqual(stage.x + stage.width);
  await expect(page.getByText("이전", { exact: true })).toBeVisible();

  // 슬라이더: 핸들을 끌면 경계(--p)가 바뀐다
  await modes(page).getByRole("radio", { name: "슬라이더" }).click();
  const handle = page.getByRole("separator", { name: "이전/이후 경계" });
  await expect(handle).toBeVisible();
  await expect(page.locator(".img-box")).toHaveCount(1);
  const f = (await page.locator(".img-frame").boundingBox())!;
  await page.mouse.move(f.x + f.width / 2, f.y + f.height / 2);
  await page.mouse.down();
  await page.mouse.move(f.x + f.width * 0.25, f.y + f.height / 2, { steps: 4 });
  await page.mouse.up();
  const p = await page.locator(".img-frame").evaluate((e) => parseFloat((e as HTMLElement).style.getPropertyValue("--p")));
  expect(p).toBeGreaterThan(15);
  expect(p).toBeLessThan(35);

  // 겹쳐 보기: 불투명도 슬라이더
  await modes(page).getByRole("radio", { name: "겹쳐 보기" }).click();
  const range = page.getByRole("slider", { name: "불투명도 (이전 ↔ 이후)" });
  await range.fill("80");
  await expect(page.locator(".img-col")).toHaveCSS("--o", "0.8");
  await expect(page.locator(".img-layer").nth(1)).toHaveCSS("opacity", "0.8");

  // 차이: 바뀐 픽셀만 강조, 나머지는 흐리게
  await modes(page).getByRole("radio", { name: "차이" }).click();
  await expect(page.locator(".img-mask")).toBeVisible();
  await expect(page.locator(".img-layer")).toHaveCSS("opacity", "0.25");
  await expect(page.locator(".img-box")).toHaveCount(1);
});

test("마지막에 쓴 비교 방식이 저장되어 다시 열어도 유지된다", async ({ page }) => {
  await seed(page, { blobs: commitBlobs });
  await open(page);
  await modes(page).getByRole("radio", { name: "차이" }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("imgDiffMode"))).toBe('"diff"');
  await page.reload();
  await open(page);
  await expect(modes(page).getByRole("radio", { name: "차이" })).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".img-mask")).toBeVisible();
});

test("크기가 다르면 바뀐 픽셀 % 대신 크기 변경을 보여 준다", async ({ page }) => {
  await seed(page, { blobs: { [`${M3}^:img/a.png`]: BEFORE, [`${M3}:img/a.png`]: WIDER } });
  await open(page);
  await expect(page.locator(".img-info")).toContainText("이후 20×16 px");
  await expect(page.locator(".img-info")).toContainText("크기 변경");
  await expect(page.locator(".img-info")).not.toContainText("바뀐 픽셀");
  await expect(page.locator(".img-box")).toHaveCount(0);
  await modes(page).getByRole("radio", { name: "차이" }).click();
  await expect(page.getByText("크기가 달라 바뀐 픽셀을 표시할 수 없습니다")).toBeVisible();
});

test("새 파일은 이후만, 삭제 파일은 이전만 보여 주고 다른 쪽은 없음", async ({ page }) => {
  await seed(page, { state: "new", blobs: { [`${M3}:img/a.png`]: AFTER } });
  await open(page);
  await expect(page.locator(".img-layer")).toHaveCount(1);
  await expect(page.locator(".img-none")).toHaveText("없음");
  await expect(page.locator(".img-info")).toContainText("이후 16×16 px");
  await expect(page.locator(".img-info")).not.toContainText("이전");
  await expect(page.locator(".img-info")).not.toContainText("바뀐 픽셀");
});

test("삭제된 파일", async ({ page }) => {
  await seed(page, { state: "deleted", blobs: { [`${M3}^:img/a.png`]: BEFORE } });
  await open(page);
  await expect(page.locator(".img-layer")).toHaveCount(1);
  await expect(page.locator(".img-none")).toHaveText("없음");
  await expect(page.locator(".img-info")).toContainText("이전 16×16 px");
});

test("변경 화면: 스테이지 안 됨은 인덱스↔작업 트리, 스테이지됨은 HEAD↔인덱스, hunk 버튼 없음", async ({ page }) => {
  await seed(page, {
    commitFiles: false,
    blobs: { "::img/a.png": BEFORE, "WORKTREE:img/a.png": AFTER, "HEAD:img/a.png": BEFORE },
    status: [{ path: "img/a.png", index: ".", worktree: "M" }],
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await page.getByText("로컬 변경사항").click();
  await page.getByRole("listbox", { name: "스테이지 안 됨", exact: true }).getByRole("option", { name: /a\.png/ }).click();
  await expect(page.locator(".img-info")).toContainText("바뀐 픽셀 4.7%");
  await expect(page.locator(".hunk-btn")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "이전 파일" })).toBeVisible(); // 25a FileNav와 공존
});

test("변경 화면 스테이지됨: HEAD와 인덱스를 비교한다", async ({ page }) => {
  await seed(page, {
    commitFiles: false,
    blobs: { "HEAD:img/a.png": BEFORE, "::img/a.png": AFTER },
    status: [{ path: "img/a.png", index: "M", worktree: "." }],
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await page.getByText("로컬 변경사항").click();
  await page.getByRole("listbox", { name: "스테이지됨", exact: true }).getByRole("option", { name: /a\.png/ }).click();
  await expect(page.locator(".img-info")).toContainText("변경 영역 (5, 6) 4×3");
});

test("읽기 오류(상한 초과 등)는 diff 영역에 문구로 보인다", async ({ page }) => {
  await seed(page, { blobs: {} });
  await page.addInitScript(() => {
    (window as any).__blobs = new Proxy({}, { get: () => { throw new Error("파일이 너무 커서 미리 볼 수 없습니다(25MB, 상한 20MB)"); } });
  });
  await open(page);
  await expect(page.locator(".img-diff .meta.bin")).toContainText("파일이 너무 커서 미리 볼 수 없습니다");
});

test("svg는 이미지로 보되 텍스트 diff로 전환할 수 있다", async ({ page }) => {
  const svg = (c: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="${c}"/></svg>`).toString("base64");
  await seed(page, {
    path: "img/a.svg",
    diff: "diff --git a/img/a.svg b/img/a.svg\nindex 1..2 100644\n--- a/img/a.svg\n+++ b/img/a.svg\n@@ -1 +1 @@\n-<svg fill=\"red\"/>\n+<svg fill=\"blue\"/>\n",
    blobs: { [`${M3}^:img/a.svg`]: svg("red"), [`${M3}:img/a.svg`]: svg("blue") },
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await page.locator(".commits").getByText("Merge branch 'feature/graph'").click();
  await page.getByRole("option", { name: /a\.svg/ }).click();
  await expect(page.locator(".img-info")).toContainText("바뀐 픽셀 100.0%");
  const toggle = page.getByRole("radiogroup", { name: "SVG 보기" });
  await toggle.getByRole("radio", { name: "텍스트" }).click();
  await expect(page.locator(".diff .add")).toContainText("blue");
  await toggle.getByRole("radio", { name: "이미지" }).click();
  await expect(page.locator(".img-info")).toBeVisible();
});
