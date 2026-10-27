import { expect, test } from "@playwright/test";

// 스플래시 창(public/splash.html)은 OS 설정이 아니라 앱 테마 설정을 따른다
for (const [scheme, theme, bg] of [
  ["dark", "light", "rgb(241, 242, 245)"],
  ["light", "dark", "rgb(19, 21, 25)"],
  ["dark", "system", "rgb(19, 21, 25)"],
  ["light", "system", "rgb(241, 242, 245)"],
] as const) {
  test(`스플래시: OS ${scheme} + 설정 ${theme} → ${bg}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.addInitScript((t) => localStorage.setItem("theme", t), theme);
    await page.goto("/splash.html");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(bg);
  });
}
