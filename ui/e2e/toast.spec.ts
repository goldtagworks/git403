import { expect, test, type Page } from "@playwright/test";

// 토스트: 오른쪽 아래 카드 스택 (src/Toasts.tsx, src/toast.ts). 시계를 가짜로 바꿔 자동 사라짐을 빠르게 확인한다.
const show = (page: Page, title: string, opts?: { kind?: string; detail?: string }) =>
  page.evaluate(([t, o]) => (window as any).__toast(t, o), [title, opts] as const);
const toasts = (page: Page) => page.locator(".toast");

test.beforeEach(async ({ page }) => {
  await page.clock.install();
  await page.goto("/");
  await page.waitForFunction(() => typeof (window as any).__toast === "function"); // mock 로드 완료
});

test("종류별 aria: 오류는 alert, 나머지는 status", async ({ page }) => {
  await show(page, "저장됨", { kind: "success" });
  await show(page, "알림", { kind: "info" });
  await show(page, "주의", { kind: "warning" });
  await show(page, "실패", { kind: "error" });
  await expect(page.getByRole("status")).toHaveCount(3);
  await expect(page.getByRole("alert")).toHaveCount(1);
  await expect(toasts(page).nth(0)).toHaveClass(/success/);
  await expect(toasts(page).nth(3)).toHaveClass(/error/);
});

test("문자열만 주면 '…완료/…됨'은 성공, 그 밖에는 정보", async ({ page }) => {
  await show(page, "Fetch 완료");
  await show(page, "스냅샷할 변경이 없습니다");
  await expect(toasts(page).nth(0)).toHaveClass(/success/);
  await expect(toasts(page).nth(1)).toHaveClass(/info/);
});

test("성공·정보는 4초 뒤 사라지고, 오류는 닫을 때까지 남는다", async ({ page }) => {
  await show(page, "저장됨", { kind: "success" });
  await show(page, "Push 실패", { kind: "error", detail: "rejected" });
  await page.clock.runFor(3500);
  await expect(toasts(page)).toHaveCount(2);
  await page.clock.runFor(1000);
  await expect(toasts(page)).toHaveCount(1);
  await page.clock.runFor(60_000);
  await expect(page.getByRole("alert")).toContainText("Push 실패");
  await page.getByRole("alert").getByRole("button", { name: "닫기" }).click();
  await expect(toasts(page)).toHaveCount(0);
});

test("마우스를 올리면 타이머가 멈추고, 내리면 남은 시간부터 다시 센다", async ({ page }) => {
  await show(page, "저장됨", { kind: "success" });
  await page.clock.runFor(2000);
  await toasts(page).first().hover();
  await page.clock.runFor(30_000);
  await expect(toasts(page)).toHaveCount(1);
  await page.mouse.move(2, 2);
  await page.clock.runFor(1500);
  await expect(toasts(page)).toHaveCount(1); // 2초 남아 있었다
  await page.clock.runFor(1000);
  await expect(toasts(page)).toHaveCount(0);
});

test("최대 4개까지 쌓이고 넘치면 오래된 것부터 밀려난다", async ({ page }) => {
  for (const n of [1, 2, 3, 4, 5, 6]) await show(page, `알림 ${n}`, { kind: "info" });
  await expect(toasts(page)).toHaveCount(4);
  await expect(toasts(page).first()).toContainText("알림 3");
  await expect(toasts(page).last()).toContainText("알림 6");
});

test("같은 문구가 연속으로 오면 합치고 타이머를 다시 시작한다", async ({ page }) => {
  await show(page, "복사함");
  await page.clock.runFor(3000);
  await show(page, "복사함");
  await show(page, "복사함");
  await expect(toasts(page)).toHaveCount(1);
  await expect(toasts(page).first()).toContainText("×3");
  await page.clock.runFor(3000);
  await expect(toasts(page)).toHaveCount(1); // 마지막 알림부터 다시 4초
  await page.clock.runFor(1500);
  await expect(toasts(page)).toHaveCount(0);
});

test("긴 오류는 '자세히'로 펼치고 여러 줄 메시지는 첫 줄이 제목이 된다", async ({ page }) => {
  await show(page, "fatal: unable to access\nline2 of git output\nline3", { kind: "error" });
  const t = page.getByRole("alert");
  await expect(t.locator(".toast-title")).toHaveText("fatal: unable to access");
  const more = t.getByRole("button", { name: "자세히" });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await expect(t.getByRole("button", { name: "접기" })).toHaveAttribute("aria-expanded", "true");
  await expect(t.locator(".toast-detail")).toContainText("line3");
  await expect(t.locator(".toast-detail")).toHaveCSS("white-space", "pre-wrap");
});

test("모션 줄이기면 들어올 때 애니메이션이 없다", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await show(page, "저장됨", { kind: "success" });
  await expect(toasts(page).first()).toHaveCSS("animation-name", "none");
});

test("화면 캡처: 라이트/다크에서 종류별 토스트", async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
  await show(page, "Pull 완료", { kind: "success", detail: "커밋 3개 받음" });
  await show(page, "이미 최신", { kind: "info", detail: "받을 커밋이 없습니다" });
  await show(page, "자동 Fetch 실패", { kind: "warning", detail: "fatal: Authentication failed" });
  await show(page, "origin Push 실패", { kind: "error", detail: "! [rejected] main -> main (non-fast-forward)\nerror: failed to push some refs" });
  await expect(toasts(page)).toHaveCount(4);
  await page.waitForTimeout(300); // 들어오는 애니메이션이 끝나도록
  await page.screenshot({ path: `e2e/results/screens/toast-${info.project.name}.png` });
});
