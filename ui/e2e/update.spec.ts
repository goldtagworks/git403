import { expect, test, type Page } from "@playwright/test";
import { autoCheckDue } from "../src/shared/lib/update";

// 로드맵 19단계: 자동 업데이트 알림·설정 토글·지금 확인, git 미설치 배너 (Tauri 업데이터는 mock)
const calls = (page: Page) => page.evaluate(() => (window as any).__git as string[][]);
const checks = (page: Page) => page.evaluate(() => (window as any).__updateChecks ?? 0);
const start = async (page: Page, flags: Record<string, unknown> = {}, storage: Record<string, string> = {}) => {
  await page.addInitScript(([f, st]) => {
    Object.assign(window, f);
    // 첫 로드에만 심는다 (새로고침해도 지우지 않도록)
    for (const [k, v] of Object.entries(st as Record<string, string>)) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
  }, [flags, storage] as const);
  await page.goto("/");
};
const openGeneral = async (page: Page) => {
  await page.getByRole("button", { name: "저장소 열기" }).waitFor();
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByRole("dialog", { name: "설정" })).toBeVisible();
};

test("자동 확인은 켜져 있고 하루가 지났을 때만", () => {
  const day = 24 * 3600_000;
  expect(autoCheckDue(day, 0, true)).toBe(true);
  expect(autoCheckDue(day - 1, 0, true)).toBe(false);
  expect(autoCheckDue(10 * day, 0, false)).toBe(false);
  expect(autoCheckDue(2 * day, day + 5, true)).toBe(false);
});

test("새 버전이 있으면 배너로 알리고, 누르면 진행률 → 설치 → 재시작", async ({ page }) => {
  await start(page, { __update: { version: "0.2.0" } });
  const banner = page.getByRole("status").filter({ hasText: "새 버전 0.2.0" });
  await expect(banner).toBeVisible();
  await banner.getByRole("button", { name: "업데이트하고 재시작" }).click();
  await expect(page.getByRole("progressbar", { name: "업데이트 다운로드" })).toHaveAttribute("value", "40");
  await expect.poll(async () => (await calls(page)).map((c) => c[0])).toEqual(expect.arrayContaining(["update_install", "relaunch"]));
});

test("다운로드가 실패하면 사유를 보이고 다시 누를 수 있다", async ({ page }) => {
  await start(page, { __update: { version: "0.2.0" }, __downloadFail: "연결 끊김" });
  await page.getByRole("button", { name: "업데이트하고 재시작" }).click();
  await expect(page.getByRole("status").filter({ hasText: "업데이트 실패: 연결 끊김" })).toBeVisible();
  await expect(page.getByRole("button", { name: "업데이트하고 재시작" })).toBeVisible();
});

test("최신이면 배너가 없다. 자동 확인은 하루 한 번(최근에 확인했으면 건너뜀)", async ({ page }) => {
  await start(page);
  await expect.poll(() => checks(page)).toBe(1);
  await expect(page.getByRole("button", { name: "업데이트하고 재시작" })).toHaveCount(0);
  await page.reload(); // 방금 확인했으므로 두 번째 로드에서는 확인하지 않는다
  await page.getByRole("button", { name: "저장소 열기" }).waitFor();
  await page.waitForTimeout(300);
  expect(await checks(page)).toBe(0);
});

test("자동 확인 실패는 조용하다", async ({ page }) => {
  await start(page, { __updateFail: "offline" });
  await expect.poll(() => checks(page)).toBe(1);
  await expect(page.getByText("offline")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("설정 일반 탭: 자동 확인 끄기, 지금 확인", async ({ page }) => {
  await start(page, {}, { autoUpdate: "false" });
  await page.getByRole("button", { name: "저장소 열기" }).waitFor();
  await page.waitForTimeout(300);
  expect(await checks(page)).toBe(0); // 끄면 자동 확인 없음
  await openGeneral(page);
  const box = page.getByRole("checkbox", { name: /업데이트 자동 확인/ });
  await expect(box).not.toBeChecked();
  await box.check();
  expect(await page.evaluate(() => localStorage.getItem("autoUpdate"))).toBe("true");
  await page.getByRole("button", { name: "지금 확인" }).click();
  await expect(page.getByText("최신 버전입니다")).toBeVisible();
  expect(await checks(page)).toBe(1);
});

test("지금 확인: 새 버전·실패 문구", async ({ page }) => {
  await start(page, { __updateFail: "offline" }, { autoUpdate: "false" });
  await openGeneral(page);
  await page.getByRole("button", { name: "지금 확인" }).click();
  await expect(page.getByText("업데이트 확인 실패: offline")).toBeVisible(); // 수동 확인은 실패를 알린다
  await page.evaluate(() => ((window as any).__updateFail = null, ((window as any).__update = { version: "0.3.0" })));
  await page.getByRole("button", { name: "지금 확인" }).click();
  await expect(page.getByText("새 버전 0.3.0이 있습니다")).toBeVisible();
});

test("git이 없으면 설치 안내 배너", async ({ page }) => {
  await start(page, { __noGit: true });
  await expect(page.getByRole("alert").filter({ hasText: "git을 찾을 수 없습니다" })).toBeVisible();
  await page.getByRole("button", { name: "닫기" }).first().click();
  await expect(page.getByText("git을 찾을 수 없습니다")).toHaveCount(0);
});

test("git은 있는데 실행이 실패하면(Xcode 라이선스 등) 미설치가 아니라 git이 낸 원인을 보여 준다", async ({ page }) => {
  const msg = "You have not agreed to the Xcode license agreements.";
  await start(page, { __gitError: msg });
  await expect(page.getByRole("alert").filter({ hasText: msg })).toBeVisible();
  await expect(page.getByText("git을 찾을 수 없습니다")).toHaveCount(0);
});

test("git이 있으면 배너가 없다", async ({ page }) => {
  await start(page);
  await page.getByRole("button", { name: "저장소 열기" }).waitFor();
  await expect(page.getByText("git을 찾을 수 없습니다")).toHaveCount(0);
});

test("git이 2.31보다 낮으면 업데이트 안내, 2.31은 통과", async ({ page }) => {
  await start(page, { __gitVersion: "2.30.9" });
  await expect(page.getByRole("alert").filter({ hasText: "git 2.30.9은 너무 오래됐습니다" })).toBeVisible();
  await start(page, { __gitVersion: "2.31.0.windows.1" });
  await page.getByRole("button", { name: "저장소 열기" }).waitFor();
  await expect(page.getByText("너무 오래됐습니다")).toHaveCount(0);
});
