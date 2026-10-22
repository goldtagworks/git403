import { expect, test } from "@playwright/test";

// 다국어: 기본 설정(system)은 브라우저 언어를 따르고, 설정 창에서 바꾸면 재시작 없이 바로 바뀐다.
// 다른 스펙은 playwright.config의 locale: "ko-KR"로 한국어 고정(ko 문구 = 원래 문구라 단언 그대로 유효).
const calls = (page: import("@playwright/test").Page) => page.evaluate(() => (window as any).__git as string[][]);
const openRepo = async (page: import("@playwright/test").Page, btn: string) => {
  await page.goto("/");
  await page.getByRole("button", { name: btn }).click();
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
};

test.describe("브라우저가 ko면 한국어", () => {
  test.use({ locale: "ko-KR" });
  test("system → ko 감지 + Rust에 set_locale(ko)", async ({ page }) => {
    await openRepo(page, "저장소 열기");
    await expect(page.locator("html")).toHaveAttribute("lang", "ko");
    expect((await calls(page)).filter((c) => c[0] === "set_locale")).toEqual([["set_locale", "ko"]]);
  });
});

test.describe("브라우저가 en이면 영어, 설정에서 즉시 전환", () => {
  test.use({ locale: "en-US" });
  test("en 감지 → 설정에서 한국어 → 다시 system", async ({ page }, info) => {
    await openRepo(page, "Open repository");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await page.keyboard.press("ControlOrMeta+,");
    const dlg = page.getByRole("dialog", { name: "Settings" });
    await expect(dlg).toBeVisible();
    await page.screenshot({ path: info.outputPath(`i18n-en-${info.project.name}.png`) });
    await dlg.getByRole("combobox", { name: "Language" }).selectOption("ko");
    // 열려 있던 설정 창과 툴바·사이드바가 새로고침 없이 바뀐다
    await expect(page.getByRole("dialog", { name: "설정" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "ko");
    await expect(page.locator(".toolbar").getByText("브랜치", { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: info.outputPath(`i18n-ko-${info.project.name}.png`) });
    expect(await page.evaluate(() => localStorage.getItem("language"))).toBe('"ko"');
    expect((await calls(page)).filter((c) => c[0] === "set_locale").map((c) => c[1])).toEqual(["en", "ko"]);
    await page.getByRole("combobox", { name: "언어" }).selectOption("system");
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    expect((await calls(page)).filter((c) => c[0] === "set_locale").map((c) => c[1])).toEqual(["en", "ko", "en"]);
  });
});
