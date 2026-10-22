import { expect, test, type Page } from "@playwright/test";
import { board, cellXib, textDiff } from "./ib";
import { seed, sha } from "./png";

// xib/storyboard 시각 diff (25c): 요약·범례·분류·목록 세부·강조·Raw 토글 저장·scene 선택·라이트/다크
const M3 = sha("m3");
const XIB = "ui/Song/SongCell.xib";
const SB = "ui/Main.storyboard";
const blobs = (path: string, a: string, b: string) => ({ [`${M3}^:${path}`]: Buffer.from(a).toString("base64"), [`${M3}:${path}`]: Buffer.from(b).toString("base64") });

async function open(page: Page, file: RegExp) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click({ timeout: 3000 }).catch(() => {});
  await page.locator(".commits").getByText("Merge branch 'feature/graph'").click();
  await page.getByRole("option", { name: file }).click();
}
const list = (page: Page) => page.getByRole("listbox", { name: "변경 목록" }).getByRole("option");
const item = (page: Page, text: string) => list(page).filter({ hasText: text });

test("xib: 요약·범례·분류·목록 세부 문구", async ({ page }) => {
  await seed(page, { path: XIB, diff: textDiff(XIB), blobs: blobs(XIB, cellXib(false), cellXib(true)) });
  await open(page, /SongCell\.xib/);
  await expect(page.locator(".ib-summary")).toHaveText("SongCell · 뷰 변경 4건 · 제약 변경 4건");
  const legend = page.locator(".ib-legend");
  for (const w of ["추가", "삭제", "수정", "이동", "제약에만 걸림"]) await expect(legend).toContainText(w);
  // 캔버스: 이전/이후, 분류별 색 박스, 제약에만 걸린 뷰는 점선
  await expect(page.locator(".ib-canvas")).toHaveCount(2);
  await expect(page.locator(".ib-canvas .ib-v.ib-k-ok")).toHaveCount(1); // badgeLabel (이후만)
  await expect(page.locator(".ib-canvas .ib-v.ib-k-del")).toHaveCount(1); // subLabel (이전만)
  await expect(page.locator(".ib-canvas .ib-v.ib-k-mod")).toHaveCount(2); // titleLabel
  await expect(page.locator(".ib-canvas .ib-v.ib-k-move")).toHaveCount(2); // moveView
  await expect(page.locator(".ib-canvas .ib-v.ib-conly").first()).toHaveCSS("border-top-style", "dashed");
  await expect(page.locator(".ib-chip", { hasText: "titleLabel" })).toHaveCount(2);

  await expect(list(page)).toHaveCount(8);
  const title = item(page, "뷰 수정 · titleLabel");
  await expect(title).toContainText("수정");
  await expect(title).toContainText("위치·크기 (120, 28) 173×20 → (120, 24) 169×21");
  await expect(title).toContainText("fontDescription: boldSystem 16 → boldSystem 17");
  await expect(item(page, "뷰 추가 · badgeLabel")).toContainText("추가");
  await expect(item(page, "뷰 삭제 · subLabel")).toContainText("삭제");
  const mv = item(page, "뷰 이동 · moveView");
  await expect(mv).toContainText("이동");
  await expect(mv).toContainText("위치·크기 (200, 4) 30×30 → (220, 4) 30×30");
  // 제약: 기준 변경은 별도 분류
  const re = item(page, "제약 기준 변경");
  await expect(re).toContainText("coverImageView.leading 기준: Upper View.leading → tableViewCellContentView.leading");
  await expect(item(page, "제약 수정 · titleLabel.top")).toContainText("constant: 8 → 12");
  await expect(item(page, "제약 추가 · badgeLabel.trailing")).toContainText("= tableViewCellContentView.trailing − 8");
  await expect(item(page, "제약 삭제 · subLabel.top")).toBeVisible();
});

test("목록 항목 호버·클릭은 해당 뷰·제약을 강조한다", async ({ page }) => {
  await seed(page, { path: XIB, diff: textDiff(XIB), blobs: blobs(XIB, cellXib(false), cellXib(true)) });
  await open(page, /SongCell\.xib/);
  await expect(page.locator(".ib-hl")).toHaveCount(0);
  await item(page, "뷰 수정 · titleLabel").hover();
  await expect(page.locator(".ib-hl")).toHaveCount(2); // 이전·이후
  await page.mouse.move(5, 5);
  await expect(page.locator(".ib-hl")).toHaveCount(0);
  await item(page, "뷰 추가 · badgeLabel").click(); // 클릭은 고정
  await page.mouse.move(5, 5);
  await expect(page.locator(".ib-hl")).toHaveCount(1);
  await expect(item(page, "뷰 추가 · badgeLabel")).toHaveAttribute("aria-selected", "true");
  // 제약: 기준·대상 뷰 박스 + 기준 아이템 쪽 가장자리 선
  await item(page, "제약 기준 변경").click();
  await expect(page.locator(".ib-hl")).toHaveCount(4);
  await expect(page.locator(".ib-edge")).toHaveCount(2);
  await item(page, "제약 기준 변경").click(); // 다시 누르면 해제
  await page.mouse.move(5, 5);
  await expect(page.locator(".ib-hl")).toHaveCount(0);
});

test("뷰어/Raw 선택은 저장되고 Raw는 기존 텍스트 diff", async ({ page }) => {
  await seed(page, { path: XIB, diff: textDiff(XIB), blobs: blobs(XIB, cellXib(false), cellXib(true)) });
  await open(page, /SongCell\.xib/);
  const seg = page.getByRole("radiogroup", { name: "Interface Builder 보기 방식" });
  await expect(seg.getByRole("radio", { name: "뷰어" })).toHaveAttribute("aria-checked", "true");
  await seg.getByRole("radio", { name: "Raw" }).click();
  await expect(page.locator(".ib-summary")).toHaveCount(0);
  await expect(page.locator(".diff .add")).toContainText('<document new="1">');
  await expect.poll(() => page.evaluate(() => localStorage.getItem("ibView"))).toBe('"raw"');
  await page.reload();
  await open(page, /SongCell\.xib/);
  await expect(page.locator(".diff .add")).toContainText('<document new="1">');
  await seg.getByRole("radio", { name: "뷰어" }).click();
  await expect(page.locator(".ib-summary")).toBeVisible();
});

test("storyboard: 변경 있는 scene만 고를 수 있고 safeArea 이름이 보인다", async ({ page }) => {
  await seed(page, { path: SB, diff: textDiff(SB), blobs: blobs(SB, board(false), board(true)) });
  await open(page, /Main\.storyboard/);
  const sel = page.getByLabel("Scene");
  await expect(sel.locator("option")).toHaveText(["HomeViewController", "DetailViewController"]); // SameViewController는 변경 없음
  await expect(page.locator(".ib-summary")).toHaveText("HomeViewController · 뷰 변경 1건 · 제약 변경 2건");
  await expect(item(page, "제약 추가 · homeTitle.leading")).toContainText("= view.safeArea.leading + 16");
  await expect(item(page, "제약 수정 · homeTitle.top")).toContainText("constant: 16 → 20");
  await sel.selectOption({ label: "DetailViewController" });
  await expect(page.locator(".ib-summary")).toHaveText("DetailViewController · 뷰 변경 4건 · 제약 변경 0건");
  await expect(item(page, "뷰 추가 · buyButton")).toBeVisible();
  await expect(item(page, "뷰 수정 · protoTitle")).toContainText("text: Song → Song!"); // tableView 프로토타입 셀 안
  // frame 없는 부모는 조상 좌표를 이어받고(y 310), 스크롤뷰 자식은 contentOffset(50)을 뺀다(100+160-50=210)
  const top = (id: string) => page.locator(`.ib-canvas[data-scene="sB"]`).last().locator(`[data-v="${id}"]`).evaluate((e) => parseFloat((e as HTMLElement).style.top));
  expect(await top("nfc")).toBeCloseTo((310 / 667) * 100, 1);
  expect(await top("svc")).toBeCloseTo((210 / 667) * 100, 1);
});

test("목록 호버·클릭은 diff 영역의 스크롤 위치를 바꾸지 않는다", async ({ page }) => {
  await seed(page, { path: XIB, diff: textDiff(XIB), blobs: blobs(XIB, cellXib(false), cellXib(true)) });
  await open(page, /SongCell\.xib/);
  const pane = page.locator(".ib-diff");
  await expect(list(page)).toHaveCount(8);
  await pane.evaluate((e) => (e.scrollTop = e.scrollHeight));
  const top = await pane.evaluate((e) => e.scrollTop);
  expect(top).toBeGreaterThan(0);
  for (const i of [7, 5, 4]) {
    const b = (await list(page).nth(i).boundingBox())!;
    await page.mouse.move(b.x + 20, b.y + b.height / 2);
  }
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.locator(".ib-hl").first()).toBeVisible();
  expect(await pane.evaluate((e) => e.scrollTop)).toBe(top);
});

test("읽을 수 없는 파일은 안내 문구", async ({ page }) => {
  await seed(page, { path: XIB, diff: textDiff(XIB), blobs: blobs(XIB, cellXib(false), "<document><objects>") });
  await open(page, /SongCell\.xib/);
  await expect(page.locator(".diff")).toContainText("Interface Builder 파일을 읽을 수 없습니다");
});
