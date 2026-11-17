import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import { execSync } from "node:child_process";
import path from "node:path";
import { sha } from "./png";

// jj 30f: 작업 기록·undo·북마크·abandon 문구·jj 끄기 시트. mock `window.__jj`(ops·bookmarks·checks·checkFail·disableFail·disableWarn·disablePartialGone·delay·backwards·fail)
const STATUS = {
  workingCopy: sha("m3"),
  changeIds: { [sha("m3")]: { short: "kkmpptxzrspx", full: "kkmpptxzrspxqwertyuiopasdfghjklz" }, [sha("c5")]: { short: "rlvkpnrzqnoo", full: "rlvkpnrzqnooqwertyuiopasdfghjklz" } },
  conflicted: [] as string[],
  truncated: false,
};
const row = (page: Page, subject: string) => page.locator(".commits .row").filter({ hasText: subject });
const menuItem = (page: Page, name: string | RegExp) => page.getByRole("menu").getByRole("menuitem", { name });
const repoMenu = async (page: Page, name: string | RegExp) => {
  await page.locator(".toolbar .picker").first().click();
  await menuItem(page, name).click();
};
const calls = async (page: Page, name: string) => (await page.evaluate(() => (window as any).__git as string[][])).filter((c) => c[0] === name);
const asked = (page: Page) => page.evaluate(() => (window as any).__asked as string[]);
const toast = (page: Page, text: string | RegExp) => page.locator(".toast", { hasText: text });
/** 앱 다시 읽기(⌘R/Ctrl+R = loadAll): mock 상태(__clean 등)를 바꾼 뒤 ctx.status를 갱신한다 */
const refresh = async (page: Page) => {
  await page.keyboard.press("Control+r");
  await page.waitForTimeout(300);
};
const jj = (page: Page, patch: object) => page.evaluate((p) => Object.assign((window as any).__jj, p), patch);

async function open(page: Page, extra: object = {}, tabs?: string[]) {
  await page.addInitScript(
    ([j, tb]) => {
      Object.assign(window, { __asked: [], __jj: j });
      localStorage.setItem("autoFetch", "0");
      if (tb) {
        localStorage.setItem("tabs", JSON.stringify(tb));
        localStorage.setItem("activeTab", JSON.stringify(tb[0]));
      }
    },
    [{ enabled: true, status: STATUS, ...extra }, tabs ?? null] as const,
  );
  await page.goto("/");
  if (!tabs) await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(row(page, "README 정리")).toBeVisible();
}

test("저장소 메뉴: jj가 켜져 있으면 jj 항목(작업 기록·북마크·되돌리기·jj 끄기)이 있고, 꺼져 있으면 없다", async ({ page }) => {
  await open(page);
  await page.locator(".toolbar .picker").first().click();
  for (const n of ["작업 기록…", "북마크…", "되돌리기", "jj 끄기…"]) await expect(menuItem(page, n)).toBeVisible();
});

test("저장소 메뉴: jj가 꺼져 있으면 jj 서브메뉴 항목이 없다", async ({ page }) => {
  await open(page, { enabled: false });
  await page.locator(".toolbar .picker").first().click();
  await expect(menuItem(page, "jj 모드 켜기…")).toBeVisible();
  await expect(menuItem(page, "jj 끄기…")).toHaveCount(0);
  await expect(menuItem(page, "작업 기록…")).toHaveCount(0);
});

test("작업 기록 시트: 목록·현재 행·복원(확인창·op id)·취소·더 보기", async ({ page }, info) => {
  await open(page);
  await repoMenu(page, "작업 기록…");
  const dlg = page.getByRole("dialog", { name: "작업 기록" });
  const items = dlg.getByRole("option");
  await expect(items).toHaveCount(5);
  await expect(items.first()).toContainText("현재");
  await expect(items.first().getByRole("button", { name: "이 시점으로" })).toBeDisabled();
  await expect(items.nth(2)).toContainText("describe commit");
  await expect(items.nth(2)).toContainText("c3c3c3c3c3c3");
  await page.screenshot({ path: `e2e/results/screens/jj-oplog-${info.project.name}.png` });
  // 취소하면 호출 없음
  await page.evaluate(() => ((window as any).__askNo = true));
  await items.nth(2).getByRole("button", { name: "이 시점으로" }).click();
  await expect.poll(async () => (await asked(page)).length).toBe(1);
  expect((await asked(page))[0]).toContain("describe commit");
  expect(await calls(page, "jj_op_restore")).toEqual([]);
  // 승인: 전체 id로 호출하고 목록을 다시 읽는다(시트는 열려 있다)
  await page.evaluate(() => ((window as any).__askNo = false));
  const logs = (await calls(page, "jj_op_log")).length;
  await items.nth(2).getByRole("button", { name: "이 시점으로" }).click();
  await expect.poll(async () => (await calls(page, "jj_op_restore")).length).toBe(1);
  expect(await calls(page, "jj_op_restore")).toEqual([["jj_op_restore", "c3".repeat(32)]]);
  await expect(toast(page, "이 시점으로 되돌렸습니다")).toBeVisible();
  await expect.poll(async () => (await calls(page, "jj_op_log")).length).toBeGreaterThan(logs);
  await expect(dlg).toBeVisible();
});

test("작업 기록: 50개 이상이면 '이전 기록 더 보기'가 limit 200으로 다시 읽는다", async ({ page }) => {
  const ops = Array.from({ length: 80 }, (_, i) => ({ id: String(i).padStart(2, "0").repeat(32), short: String(i).padStart(2, "0").repeat(6), time: Date.now() - i * 1000, description: `op ${i}`, user: null }));
  await open(page, { ops });
  await repoMenu(page, "작업 기록…");
  const dlg = page.getByRole("dialog", { name: "작업 기록" });
  await expect(dlg.getByRole("option")).toHaveCount(50);
  await dlg.getByRole("button", { name: "이전 기록 더 보기" }).click();
  await expect(dlg.getByRole("option")).toHaveCount(80);
  expect((await calls(page, "jj_op_log")).map((c) => c[1]).slice(-2)).toEqual(["50", "200"]); // 앞의 50은 개발 StrictMode가 효과를 두 번 돌린 것
  await expect(dlg.getByRole("button", { name: "이전 기록 더 보기" })).toHaveCount(0);
});

test("되돌리기: 변경이 없으면 확인창 없이 jj_undo, 있으면 안내 확인창(취소하면 호출 없음), 끝에 닿으면 정보 토스트", async ({ page }) => {
  await open(page);
  await page.evaluate(() => ((window as any).__clean = true));
  await refresh(page);
  await page.getByRole("button", { name: "되돌리기" }).click();
  await expect.poll(async () => (await calls(page, "jj_undo")).length).toBe(1);
  expect(await asked(page)).toEqual([]);
  await expect(toast(page, "마지막 작업을 되돌렸습니다")).toBeVisible();
  // 변경 있음
  await page.evaluate(() => (delete (window as any).__clean, ((window as any).__askNo = true)));
  await refresh(page);
  await page.getByRole("button", { name: "되돌리기" }).click();
  await expect.poll(async () => (await asked(page)).length).toBe(1);
  expect((await asked(page))[0]).toMatch(/변경 \d+개 파일/);
  expect((await asked(page))[0]).toContain("snapshot working copy");
  expect(await calls(page, "jj_undo")).toEqual([["jj_undo"]].slice(0, 0).concat((await calls(page, "jj_undo")).slice(0, 1)));
  // 끝: 정보 토스트
  await page.evaluate(() => ((window as any).__askNo = false));
  await jj(page, { fail: JSON.stringify({ code: "jj.nothingToUndo", vars: {}, message: "x" }) });
  await page.getByRole("button", { name: "되돌리기" }).click();
  await expect(toast(page, "되돌릴 작업이 없습니다")).toBeVisible();
  await expect(page.locator(".toast.error")).toHaveCount(0);
  await jj(page, { fail: JSON.stringify({ code: "jj.cannotUndo", vars: {}, message: "x" }) });
  await page.getByRole("button", { name: "되돌리기" }).click();
  await expect(toast(page, "여기서 더 되돌릴 수 없습니다")).toBeVisible();
  await expect(page.locator(".toast.error")).toHaveCount(0);
});

test("되돌리기 단축키(Ctrl+Alt+Z): jj 보기에서만, 입력창·키 반복·확인창 대기 중에는 한 번만/무시", async ({ page }) => {
  await open(page);
  await page.evaluate(() => ((window as any).__clean = true));
  await refresh(page);
  await page.keyboard.press("Control+Alt+Z");
  await expect.poll(async () => (await calls(page, "jj_undo")).length).toBe(1);
  // 입력창 포커스: 무시
  await page.locator(".side-filter input").focus();
  await page.keyboard.press("Control+Alt+Z");
  await page.waitForTimeout(150);
  expect((await calls(page, "jj_undo")).length).toBe(1);
  await page.locator(".side-filter input").blur();
  // 변경 있음 + 확인창이 떠 있는 동안 두 번 눌러도 확인창·호출은 1회
  await page.evaluate(() => (delete (window as any).__clean, ((window as any).__slowAsk = 400)));
  await refresh(page);
  const n0 = (await asked(page)).length;
  await page.keyboard.press("Control+Alt+Z");
  await page.keyboard.press("Control+Alt+Z");
  await page.keyboard.press("Control+Alt+Z");
  await expect.poll(async () => (await calls(page, "jj_undo")).length).toBe(2);
  expect((await asked(page)).length - n0).toBe(1);
  // git 보기: 버튼도 단축키도 없다
  await repoMenu(page, /✓ jj 보기/);
  await expect(page.getByRole("button", { name: "되돌리기" })).toHaveCount(0);
  await page.keyboard.press("Control+Alt+Z");
  await page.waitForTimeout(150);
  expect((await calls(page, "jj_undo")).length).toBe(2);
  // 저장소 메뉴에서는 git 보기에서도 가능
  await page.evaluate(() => ((window as any).__clean = true));
  await page.locator(".toolbar .picker").first().click();
  await expect(menuItem(page, "되돌리기")).toBeVisible();
});

const BM = [
  { name: "main", target: sha("c1"), targets: [sha("c1")], local: true, remotes: [{ remote: "origin", sha: sha("c1"), tracked: true }] },
  { name: "topic", target: sha("c2"), targets: [sha("c2")], local: true, remotes: [{ remote: "origin", sha: sha("c2"), tracked: false }] },
  { name: "feature/x", target: null, targets: [], local: false, remotes: [{ remote: "origin", sha: sha("c3"), tracked: false }] },
  { name: "clash", target: null, targets: [sha("x1"), sha("x2")], local: true, remotes: [] },
];

test("북마크 시트: 로컬·원격만·충돌·추적 표시, 추적·삭제(확인창)", async ({ page }, info) => {
  await open(page, { bookmarks: BM });
  await repoMenu(page, "북마크…");
  const dlg = page.getByRole("dialog", { name: "북마크" });
  const items = dlg.getByRole("option");
  await expect(items).toHaveCount(4);
  await expect(items.filter({ hasText: "clash" })).toContainText("충돌");
  await expect(items.filter({ hasText: "clash" })).toContainText(sha("x1").slice(0, 7));
  await expect(items.filter({ hasText: "feature/x" })).toContainText("원격만");
  await expect(items.filter({ hasText: "feature/x" })).toContainText("—"); // 로컬 대상이 없으면 대시
  await expect(items.filter({ hasText: "main" })).toContainText("origin ✓");
  await page.screenshot({ path: `e2e/results/screens/jj-bookmarks-${info.project.name}.png` });
  await items.filter({ hasText: "topic" }).getByRole("button", { name: "추적" }).click();
  await expect.poll(async () => (await calls(page, "jj_bookmark_track")).length).toBe(1);
  expect(await calls(page, "jj_bookmark_track")).toEqual([["jj_bookmark_track", "topic", "origin"]]);
  await page.evaluate(() => ((window as any).__askNo = true));
  await items.filter({ hasText: "main" }).getByRole("button", { name: "삭제…" }).click();
  await expect.poll(async () => (await asked(page)).length).toBe(1);
  expect((await asked(page))[0]).toContain("main");
  expect(await calls(page, "jj_bookmark_delete")).toEqual([]);
  await page.evaluate(() => ((window as any).__askNo = false));
  await items.filter({ hasText: "main" }).getByRole("button", { name: "삭제…" }).click();
  await expect.poll(async () => (await calls(page, "jj_bookmark_delete")).length).toBe(1);
  expect(await calls(page, "jj_bookmark_delete")).toEqual([["jj_bookmark_delete", "main"]]);
  // 사이드바 브랜치 섹션 제목 우클릭 메뉴
  await page.keyboard.press("Escape");
  await page.locator('.sidebar section[data-sec="local"] .section-title').click({ button: "right" });
  await expect(menuItem(page, "북마크…")).toBeVisible();
});

test("북마크 시트에서 Cf가 든 이름은 보이는 표기로 나오고, 삭제·추적이 거절되면 jj CLI 안내가 뜬다", async ({ page }) => {
  const evil = "fix‮fdp";
  await open(page, { bookmarks: [{ name: evil, target: sha("c1"), targets: [sha("c1")], local: true, remotes: [{ remote: "or​igin", sha: sha("c1"), tracked: false }] }] });
  await repoMenu(page, "북마크…");
  const dlg = page.getByRole("dialog", { name: "북마크" });
  await expect(dlg).toContainText("fix⟦U+202E⟧fdp");
  await expect(dlg).toContainText("or⟦U+200B⟧igin");
  expect(await dlg.innerText()).not.toContain("‮");
  await dlg.getByRole("button", { name: "삭제…" }).click();
  await expect.poll(async () => (await asked(page)).length).toBe(1);
  expect((await asked(page))[0]).toContain("⟦U+202E⟧");
  expect((await asked(page))[0]).not.toContain("‮");
  await expect(toast(page, "jj CLI")).toBeVisible();
  expect(await calls(page, "jj_bookmark_delete")).toEqual([]);
  await dlg.getByRole("button", { name: "추적" }).click();
  await expect(page.locator(".toast.error", { hasText: "jj CLI" }).locator(".toast-n")).toHaveText("×2"); // 같은 오류는 합쳐진다
  expect(await calls(page, "jj_bookmark_track")).toEqual([]);
});

test("백엔드 오류의 불신 문자열은 tErr가 치환할 때도 영어 폴백일 때도 보이는 표기로 바뀐다", async ({ page }) => {
  await open(page);
  await jj(page, { fail: JSON.stringify({ code: "jj.badBookmark", vars: { name: "a‮b" }, message: "x" }) });
  await row(page, "README 정리").click({ button: "right" });
  await menuItem(page, "북마크 만들기…").click();
  await page.getByRole("dialog", { name: "북마크 만들기" }).getByLabel("이름").fill("zz");
  await page.getByRole("dialog", { name: "북마크 만들기" }).getByRole("button", { name: "만들기" }).click();
  await expect(toast(page, "a⟦U+202E⟧b")).toBeVisible();
  await jj(page, { fail: JSON.stringify({ code: "jj.unknownCodeXyz", vars: {}, message: "boom ‮ x" }) });
  await row(page, "README 정리").click({ button: "right" });
  await menuItem(page, "북마크 만들기…").click();
  await page.getByRole("dialog", { name: "북마크 만들기" }).getByLabel("이름").fill("zz");
  await page.getByRole("dialog", { name: "북마크 만들기" }).getByRole("button", { name: "만들기" }).click();
  await expect(toast(page, "boom ⟦U+202E⟧ x")).toBeVisible();
});

test("커밋 우클릭 북마크: 만들기·옮기기(이름순 15개 + 직접 입력)·뒤로 옮기기 확인 뒤 allowBackwards", async ({ page }) => {
  await open(page);
  await row(page, "README 정리").click({ button: "right" });
  await menuItem(page, "북마크 만들기…").click();
  const dlg = page.getByRole("dialog", { name: "북마크 만들기" });
  await dlg.getByLabel("이름").fill("  feat  ");
  await dlg.getByRole("button", { name: "만들기" }).click();
  await expect.poll(async () => (await calls(page, "jj_bookmark_set")).length).toBe(1);
  expect(await calls(page, "jj_bookmark_set")).toEqual([["jj_bookmark_set", sha("c5"), "feat", "false"]]);
  await expect(toast(page, "북마크를 만들었습니다")).toBeVisible();
  // 옮기기: 기존 로컬 이름 + 직접 입력
  await row(page, "README 정리").click({ button: "right" });
  await expect(menuItem(page, "이름 직접 입력…")).toBeVisible();
  await menuItem(page, "main").first().click();
  await expect.poll(async () => (await calls(page, "jj_bookmark_set")).length).toBe(2);
  expect((await calls(page, "jj_bookmark_set"))[1].slice(2)).toEqual(["main", "false"]);
  await expect(toast(page, "북마크를 옮겼습니다")).toBeVisible();
  // 뒤로 옮기기: 거절 → 확인(취소하면 두 번째 호출·성공 토스트 없음)
  await jj(page, { backwards: true });
  await page.evaluate(() => ((window as any).__askNo = true));
  const n = (await calls(page, "jj_bookmark_set")).length;
  await row(page, "README 정리").click({ button: "right" });
  await menuItem(page, "북마크 만들기…").click();
  await dlg.getByLabel("이름").fill("back");
  await dlg.getByRole("button", { name: "만들기" }).click();
  await expect.poll(async () => (await asked(page)).length).toBe(1);
  expect((await asked(page))[0]).toContain("뒤쪽이나 다른 가지");
  await page.waitForTimeout(150);
  expect((await calls(page, "jj_bookmark_set")).length).toBe(n);
  await expect(toast(page, "북마크를 만들었습니다")).toHaveCount(1); // 처음 것만
  // 승인하면 allowBackwards=true로 다시
  await page.evaluate(() => ((window as any).__askNo = false));
  await row(page, "README 정리").click({ button: "right" });
  await menuItem(page, "북마크 만들기…").click();
  await dlg.getByLabel("이름").fill("back");
  await dlg.getByRole("button", { name: "만들기" }).click();
  await expect.poll(async () => (await calls(page, "jj_bookmark_set")).length).toBe(n + 1);
  expect((await calls(page, "jj_bookmark_set")).at(-1)).toEqual(["jj_bookmark_set", sha("c5"), "back", "true"]);
});

test("버리기 확인창: 그 커밋의 북마크가 삭제된다는 안내(이름은 보이는 표기), 없으면 기존 문구", async ({ page }) => {
  await open(page, { bookmarks: [{ name: "feat‮evil", target: sha("c5"), targets: [sha("c5")], local: true, remotes: [] }] });
  await page.evaluate(() => ((window as any).__askNo = true));
  await row(page, "README 정리").click({ button: "right" });
  await menuItem(page, "버리기…").click();
  await expect.poll(async () => (await asked(page)).length).toBe(1);
  const msg = (await asked(page))[0];
  expect(msg).toContain("이 변경을 버릴까요");
  expect(msg).toContain("feat⟦U+202E⟧evil");
  expect(msg).toContain("삭제됩니다");
  expect(msg).not.toContain("‮");
  await jj(page, { bookmarks: [] });
  await row(page, "README 정리").click({ button: "right" });
  await menuItem(page, "버리기…").click();
  await expect.poll(async () => (await asked(page)).length).toBe(2);
  expect((await asked(page))[1]).not.toContain("북마크");
});

// ---- jj 끄기 ----
const CHECK = { orphans: [{ sha: sha("f1"), changeId: "abcdefabcdef0123", description: "내 실험\n둘째 줄" }, { sha: sha("f2"), changeId: "fedcbafedcba0123", description: "" }], workingCopyDescribed: true, workingCopyMerge: false, otherWorkspaces: 0, opId: "op1" };
const disableDlg = (page: Page) => page.getByRole("dialog", { name: "jj 끄기" });
const startDisable = async (page: Page) => {
  await repoMenu(page, "jj 끄기…");
  await expect(disableDlg(page)).toBeVisible();
};
const toConfirm = async (page: Page) => {
  await startDisable(page);
  await disableDlg(page).getByRole("button", { name: "jj 삭제…" }).click();
  await expect(disableDlg(page).getByRole("button", { name: "jj 삭제", exact: true })).toBeVisible();
};

test("jj 끄기: 선택 시트의 취소·보기만 끄기(호출 없음)", async ({ page }) => {
  await open(page, { checks: [CHECK] });
  await startDisable(page);
  await expect(disableDlg(page).getByRole("button", { name: "취소" })).toBeVisible();
  await disableDlg(page).getByRole("button", { name: "취소" }).click();
  await expect(disableDlg(page)).toHaveCount(0);
  await startDisable(page);
  await disableDlg(page).getByRole("button", { name: "보기만 끄기" }).click();
  await expect(page.locator(".jj-mark")).toHaveCount(0);
  await expect.poll(async () => await page.evaluate(() => ((window as any).__graphHidden as string[][]).at(-1))).toEqual([]);
  expect((await calls(page, "jj_disable_check")).length + (await calls(page, "jj_disable")).length).toBe(0);
  // 이미 git 보기면 보기만 끄기는 비활성
  await startDisable(page);
  await expect(disableDlg(page).getByRole("button", { name: "보기만 끄기" })).toBeDisabled();
});

test("jj 끄기: check 목록·고지·최종 확인 뒤 jj_disable(expect.opId)·경고 토스트·결과 화면, 다시 켜면 jj 보기가 기본", async ({ page }, info) => {
  const warn = [
    { code: "jj.disableKept", vars: { count: "2", total: "2", prefix: "refs/git403/jj-orphans" }, message: "x" },
    { code: "jj.disableDetached", vars: {}, message: "x" },
    { code: "jj.disableUnbornBranch", vars: { name: "main-2" }, message: "x" },
    { code: "jj.disableLeftover", vars: { path: "/r/.git/jj-removing-1", detail: "busy" }, message: "x" },
  ];
  await open(page, { checks: [CHECK], disableWarn: warn });
  await repoMenu(page, /✓ jj 보기/); // git 보기 설정을 저장해 둔다
  await page.evaluate(() => ((window as any).__askNo = true));
  await toConfirm(page);
  const d = disableDlg(page);
  await expect(d).toContainText("작업 기록(operation log)·되돌리기(undo)·이전 버전");
  await expect(d).toContainText("변경 2개");
  await expect(d).toContainText("abcdefabcdef");
  await expect(d).toContainText("내 실험");
  await expect(d).toContainText("(설명 없음)");
  expect(await d.locator("bdi").count()).toBeGreaterThanOrEqual(3); // changeId·설명은 bdi로 감싼다
  await expect(d).toContainText("작업 사본(@)에 설명이 있는");
  await page.screenshot({ path: `e2e/results/screens/jj-disable-${info.project.name}.png` });
  await d.getByRole("button", { name: "jj 삭제", exact: true }).click();
  await expect.poll(async () => (await asked(page)).length).toBe(1);
  expect((await asked(page))[0]).toContain("2개");
  expect(await calls(page, "jj_disable")).toEqual([]);
  await expect(d.getByRole("button", { name: "jj 삭제", exact: true })).toBeEnabled(); // 취소하면 confirm으로
  await page.evaluate(() => ((window as any).__askNo = false));
  await d.getByRole("button", { name: "jj 삭제", exact: true }).click();
  await expect.poll(async () => (await calls(page, "jj_disable")).length).toBe(1);
  expect(await calls(page, "jj_disable")).toEqual([["jj_disable", "op1"]]);
  await expect(page.locator(".toast", { hasText: "jj 삭제 알림" })).toHaveCount(4); // 토스트는 최대 4개라 성공 토스트는 밀려난다 — 결과 화면이 같은 내용을 보인다
  await expect(d).toContainText("jj를 삭제했습니다");
  await expect(d).toContainText("refs/git403/jj-orphans 아래 ref로 보존했습니다");
  await expect(d).toContainText("HEAD를 브랜치에 붙이지 못했습니다");
  await d.getByRole("button", { name: "닫기" }).first().click();
  await expect(page.locator(".jj-mark")).toHaveCount(0);
  await page.locator(".toolbar .picker").first().click();
  await expect(menuItem(page, "jj 끄기…")).toHaveCount(0);
  await expect(menuItem(page, "jj 모드 켜기…")).toBeVisible();
  // 다시 켜면 저장돼 있던 git 보기가 지워져 jj 보기가 기본
  await menuItem(page, "jj 모드 켜기…").click();
  await jj(page, { status: STATUS });
  await expect(page.locator(".jj-mark").first()).toBeVisible();
});

test("jj 끄기: otherWorkspaces>0이면 삭제 버튼 비활성+사유, check 실패(판단 불가)는 삭제 불가", async ({ page }) => {
  await open(page, { checks: [{ ...CHECK, otherWorkspaces: 2 }] });
  await toConfirm(page);
  const d = disableDlg(page);
  await expect(d.getByRole("button", { name: "jj 삭제", exact: true })).toBeDisabled();
  await expect(d).toContainText("다른 작업 공간이 2개");
  await expect(d).toContainText("jj workspace forget");
  await d.getByRole("button", { name: "취소" }).click();
  await jj(page, { checkFail: JSON.stringify({ code: "jj.disableUnknown", vars: { reason: "너무 큼" }, message: "x" }) });
  await startDisable(page);
  await d.getByRole("button", { name: "jj 삭제…" }).click();
  await expect(d.locator(".jj-err")).toContainText("너무 큼");
  await expect(d.getByRole("button", { name: "jj 삭제", exact: true })).toHaveCount(0);
  expect(await calls(page, "jj_disable")).toEqual([]);
});

test("jj 끄기: disableChanged면 check를 다시 불러 목록을 갱신하고 확인창을 다시 띄운다(새 opId, otherWorkspaces>0이면 비활성)", async ({ page }) => {
  await open(page, { checks: [CHECK, { ...CHECK, opId: "op2", orphans: CHECK.orphans.slice(0, 1) }, { ...CHECK, opId: "op3", otherWorkspaces: 1 }], disableFail: JSON.stringify({ code: "jj.disableChanged", vars: {}, message: "x" }) });
  await toConfirm(page);
  const d = disableDlg(page);
  await d.getByRole("button", { name: "jj 삭제", exact: true }).click();
  await expect(d).toContainText("저장소가 바뀌어 목록을 다시 불러왔습니다");
  await expect(d).toContainText("변경 1개");
  expect((await calls(page, "jj_disable_check")).length).toBe(2);
  expect((await asked(page)).length).toBe(1);
  await d.getByRole("button", { name: "jj 삭제", exact: true }).click(); // 확인창 다시 → 새 opId
  await expect.poll(async () => (await calls(page, "jj_disable")).length).toBe(2);
  expect((await calls(page, "jj_disable")).map((c) => c[1])).toEqual(["op1", "op2"]);
  expect((await asked(page)).length).toBe(2);
});

test("jj 끄기: disableChanged 뒤 다시 조회했을 때 otherWorkspaces>0이면 안내와 비활성이 함께 보인다", async ({ page }) => {
  await open(page, { checks: [CHECK, { ...CHECK, opId: "op3", otherWorkspaces: 1 }], disableFail: JSON.stringify({ code: "jj.disableChanged", vars: {}, message: "x" }) });
  await toConfirm(page);
  const d = disableDlg(page);
  await d.getByRole("button", { name: "jj 삭제", exact: true }).click();
  await expect(d).toContainText("저장소가 바뀌어 목록을 다시 불러왔습니다");
  await expect(d).toContainText("다른 작업 공간이 1개");
  await expect(d.getByRole("button", { name: "jj 삭제", exact: true })).toBeDisabled();
});

test("jj 끄기: disablePartial — 아직 켜져 있으면 선택 화면+다시 실행 안내, 이미 꺼졌으면 닫고 무해 안내", async ({ page }) => {
  const partial = JSON.stringify({ code: "jj.disablePartial", vars: { step: "HEAD", detail: "locked" }, message: "x" });
  await open(page, { checks: [CHECK], disableFail: partial });
  await toConfirm(page);
  const d = disableDlg(page);
  await d.getByRole("button", { name: "jj 삭제", exact: true }).click();
  await expect(d).toContainText("일부만 지워졌습니다");
  await expect(d.getByRole("button", { name: "jj 삭제…" })).toBeVisible();
  await expect(page.locator(".toast.error", { hasText: "일부만 지웠습니다" })).toBeVisible();
  // 이번엔 `.jj` 단계 실패 뒤 이미 꺼진 상태
  await jj(page, { disableFail: JSON.stringify({ code: "jj.disablePartial", vars: { step: ".jj", detail: "/r/.git/jj-removing-9: busy" }, message: "x" }), disablePartialGone: true, checks: [CHECK] });
  await d.getByRole("button", { name: "jj 삭제…" }).click();
  await d.getByRole("button", { name: "jj 삭제", exact: true }).click();
  await expect(toast(page, "남은 찌꺼기는 git에 영향이 없고 무해합니다")).toBeVisible();
  await expect(toast(page, ".git/jj-removing-*")).toBeVisible();
  await expect(toast(page, "남은 찌꺼기").locator(".toast-detail")).toContainText("/r/.git/jj-removing-9: busy"); // 경로는 자세히에
  await expect(d).toHaveCount(0);
  await expect(page.locator(".jj-mark")).toHaveCount(0);
});

test("지연 응답: check 응답 전에 닫으면 되살아나지 않고, 응답 전에 탭을 옮기면 시트가 닫힌다", async ({ page }) => {
  await open(page, { checks: [CHECK] }, ["/work/a", "/work/b"]);
  await startDisable(page);
  await jj(page, { delay: 400 });
  await disableDlg(page).getByRole("button", { name: "jj 삭제…" }).click();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
  await expect(disableDlg(page)).toHaveCount(0);
  expect(await calls(page, "jj_disable")).toEqual([]);
  // 탭 전환
  await jj(page, { delay: 0 });
  await startDisable(page);
  await jj(page, { delay: 400 });
  await disableDlg(page).getByRole("button", { name: "jj 삭제…" }).click();
  await page.keyboard.press("Control+Alt+ArrowRight"); // 시트가 열려 있어 탭을 클릭할 수 없으니 다음 탭 단축키로
  await page.waitForTimeout(700);
  await expect(disableDlg(page)).toHaveCount(0);
});

test("지연 응답: disable 실행 중 탭을 옮겨도 시트는 유지되고, 끝나면 닫히며 토스트에 저장소 이름이 붙는다", async ({ page }) => {
  await open(page, { checks: [CHECK] }, ["/work/a", "/work/b"]);
  await toConfirm(page);
  await jj(page, { delay: 500 });
  await disableDlg(page).getByRole("button", { name: "jj 삭제", exact: true }).click();
  await expect.poll(async () => (await calls(page, "jj_disable")).length).toBe(1);
  await page.keyboard.press("Control+Alt+ArrowRight"); // 시트가 열려 있어 탭을 클릭할 수 없으니 다음 탭 단축키로
  await expect(disableDlg(page)).toBeVisible(); // working: 열어 둔다
  await expect(toast(page, "a: jj를 삭제했습니다")).toBeVisible();
  await expect(disableDlg(page)).toHaveCount(0);
  expect((await calls(page, "jj_disable")).length).toBe(1);
});

test("지연 응답: 복원 응답 전에 탭을 옮기면 같은 저장소에만 적용되고, 작업 기록 더 보기는 마지막 요청만 반영한다", async ({ page }) => {
  const ops = Array.from({ length: 80 }, (_, i) => ({ id: String(i).padStart(2, "0").repeat(32), short: String(i).padStart(2, "0").repeat(6), time: Date.now() - i * 1000, description: `op ${i}`, user: null }));
  await open(page, { ops }, ["/work/a", "/work/b"]);
  await page.evaluate(() => ((window as any).__clean = true));
  await repoMenu(page, "작업 기록…");
  const dlg = page.getByRole("dialog", { name: "작업 기록" });
  await expect(dlg.getByRole("option")).toHaveCount(50);
  await jj(page, { delay: 400 });
  await dlg.getByRole("option").nth(3).getByRole("button", { name: "이 시점으로" }).click();
  await expect.poll(async () => (await calls(page, "jj_op_restore")).length).toBe(1);
  await page.keyboard.press("Control+Alt+ArrowRight"); // 시트가 열려 있어 탭을 클릭할 수 없으니 다음 탭 단축키로
  await expect(toast(page, "a: 이 시점으로 되돌렸습니다")).toBeVisible();
  await expect(dlg).toHaveCount(0);
});

test("jj 끄기: [jj 삭제]를 연타해도 OS 확인창은 1회, jj_disable도 1회", async ({ page }) => {
  await open(page, { checks: [CHECK] });
  await page.evaluate(() => ((window as any).__slowAsk = 400));
  await toConfirm(page);
  await disableDlg(page).getByRole("button", { name: "jj 삭제", exact: true }).dblclick();
  await expect.poll(async () => (await calls(page, "jj_disable")).length).toBe(1);
  await page.waitForTimeout(300);
  expect((await asked(page)).length).toBe(1);
  expect((await calls(page, "jj_disable")).length).toBe(1);
});

// ---- 확인창·입력창이 떠 있는 동안 탭을 옮기면 다른 저장소에서 실행되지 않는다(작업은 시작한 저장소 기준, 옮겼으면 중단+안내) ----
const nextTab = (page: Page) => page.keyboard.press("Control+Alt+ArrowRight");
const prevTab = (page: Page) => page.keyboard.press("Control+Alt+ArrowLeft");
const TABS = ["/work/a", "/work/b"];
const moved = (page: Page) => expect(toast(page, "저장소를 옮겨서 작업을 취소했습니다")).toBeVisible();

test("확인창 중 탭 전환: undo는 호출하지 않고 안내한다", async ({ page }) => {
  await open(page, {}, TABS);
  await page.evaluate(() => ((window as any).__slowAsk = 500));
  await page.keyboard.press("Control+Alt+Z");
  await expect.poll(async () => (await asked(page)).length).toBe(1);
  await nextTab(page);
  await moved(page);
  expect(await calls(page, "jj_undo")).toEqual([]);
});

test("확인창 중 탭 전환: 작업 기록 복원은 호출하지 않고 시트가 닫힌다", async ({ page }) => {
  await open(page, {}, TABS);
  await repoMenu(page, "작업 기록…");
  await page.evaluate(() => ((window as any).__slowAsk = 500));
  const dlg = page.getByRole("dialog", { name: "작업 기록" });
  await dlg.getByRole("option").nth(2).getByRole("button", { name: "이 시점으로" }).click();
  await expect.poll(async () => (await asked(page)).length).toBe(1);
  await nextTab(page);
  await moved(page);
  expect(await calls(page, "jj_op_restore")).toEqual([]);
  await expect(dlg).toHaveCount(0);
});

test("확인창 중 탭 전환: 북마크 삭제는 호출하지 않는다", async ({ page }) => {
  await open(page, { bookmarks: BM }, TABS);
  await repoMenu(page, "북마크…");
  await page.evaluate(() => ((window as any).__slowAsk = 500));
  await page.getByRole("dialog", { name: "북마크" }).getByRole("option").filter({ hasText: "main" }).getByRole("button", { name: "삭제…" }).click();
  await expect.poll(async () => (await asked(page)).length).toBe(1);
  await nextTab(page);
  await moved(page);
  expect(await calls(page, "jj_bookmark_delete")).toEqual([]);
});

test("확인창 중 탭 전환: abandon은 호출하지 않는다", async ({ page }) => {
  await open(page, {}, TABS);
  await page.evaluate(() => ((window as any).__slowAsk = 500));
  await row(page, "README 정리").click({ button: "right" });
  await menuItem(page, "버리기…").click();
  await expect.poll(async () => (await asked(page)).length).toBe(1);
  await nextTab(page);
  await moved(page);
  expect(await calls(page, "jj_abandon")).toEqual([]);
});

test("설명 편집 시트가 열린 채 탭 전환: 저장해도 jj_describe는 호출하지 않는다", async ({ page }) => {
  await open(page, {}, TABS);
  await row(page, "README 정리").click({ button: "right" });
  await menuItem(page, "설명 편집…").click();
  const dlg = page.getByRole("dialog", { name: "설명 편집" });
  await dlg.getByLabel("제목").fill("바뀐 설명");
  await dlg.evaluate((el) => (el as HTMLElement).focus());
  await nextTab(page);
  await expect(page.locator(".tab.active")).toHaveAttribute("data-path", "/work/b");
  await page.waitForTimeout(300);
  await dlg.getByRole("button", { name: "메시지 수정" }).click();
  await moved(page);
  expect(await calls(page, "jj_describe")).toEqual([]);
});

test("입력창·'그래도 옮기기' 확인창 중 탭 전환: 북마크 만들기·옮기기는 호출하지 않는다", async ({ page }) => {
  await open(page, {}, TABS);
  await row(page, "README 정리").click({ button: "right" });
  await menuItem(page, "북마크 만들기…").click();
  const dlg = page.getByRole("dialog", { name: "북마크 만들기" });
  await dlg.getByLabel("이름").fill("feat");
  await dlg.evaluate((el) => (el as HTMLElement).focus()); // 입력칸 포커스에서는 탭 단축키가 무시된다
  await nextTab(page); // prompt는 열려 있다
  await expect(page.locator('.tab.active')).toHaveAttribute("data-path", "/work/b");
  await page.waitForTimeout(300); // ctx.repo가 바뀔 때까지
  await dlg.getByRole("button", { name: "만들기" }).click();
  await moved(page);
  expect(await calls(page, "jj_bookmark_set")).toEqual([]);
  // 뒤로 옮기기 확인창 중
  await prevTab(page);
  await jj(page, { backwards: true });
  await page.evaluate(() => ((window as any).__slowAsk = 500));
  await row(page, "README 정리").click({ button: "right" });
  await menuItem(page, "북마크 만들기…").click();
  await dlg.getByLabel("이름").fill("back");
  await dlg.getByRole("button", { name: "만들기" }).click();
  await expect.poll(async () => (await asked(page)).length).toBe(1);
  await nextTab(page);
  await page.waitForTimeout(700);
  expect(await calls(page, "jj_bookmark_set")).toEqual([]);
});

test("jj 끄기: asking 중 탭을 옮겼다 돌아와 승인해도 jj_disable은 호출되지 않는다", async ({ page }) => {
  await open(page, { checks: [CHECK] }, TABS);
  await toConfirm(page);
  await page.evaluate(() => ((window as any).__slowAsk = 700));
  await disableDlg(page).getByRole("button", { name: "jj 삭제", exact: true }).click();
  await expect.poll(async () => (await asked(page)).length).toBe(1);
  await nextTab(page);
  await prevTab(page);
  await page.waitForTimeout(1000);
  expect(await calls(page, "jj_disable")).toEqual([]);
  await expect(disableDlg(page)).toHaveCount(0);
});

test("tErr: 오류 변수의 줄바꿈은 표시로 바뀌고, 여러 줄 폴백 message만 줄바꿈을 유지한다", async ({ page }) => {
  await open(page);
  const create = async () => {
    await row(page, "README 정리").click({ button: "right" });
    await menuItem(page, "북마크 만들기…").click();
    const d = page.getByRole("dialog", { name: "북마크 만들기" });
    await d.getByLabel("이름").fill("zz");
    await d.getByRole("button", { name: "만들기" }).click();
  };
  await jj(page, { fail: JSON.stringify({ code: "jj.badBookmark", vars: { name: "a\nb" }, message: "x" }) });
  await create();
  await expect(toast(page, "a⟦U+000A⟧b")).toBeVisible();
  await jj(page, { fail: JSON.stringify({ code: "jj.unknownCodeXyz", vars: {}, message: "첫째 줄\n둘째 줄" }) });
  await create();
  const t = page.locator(".toast", { hasText: "첫째 줄" });
  await expect(t).toBeVisible();
  await expect(t.locator(".toast-detail")).toContainText("둘째 줄"); // 제목(첫 줄) + 자세히(나머지)로 갈라진다 = 줄바꿈이 유지됐다
});

test("200ms가 넘게 걸리면 '불러오는 중'을 보이고, 확인(checking) 중에도 취소할 수 있다", async ({ page }) => {
  await open(page, { checks: [CHECK], bookmarks: BM });
  await jj(page, { delay: 600 });
  await repoMenu(page, "작업 기록…");
  await expect(page.getByRole("dialog", { name: "작업 기록" }).getByText("불러오는 중")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "작업 기록" }).getByRole("option").first()).toBeVisible();
  await expect(page.getByRole("dialog", { name: "작업 기록" }).getByText("불러오는 중")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await jj(page, { delay: 0 });
  await startDisable(page);
  await jj(page, { delay: 600 });
  await disableDlg(page).getByRole("button", { name: "jj 삭제…" }).click();
  await expect(disableDlg(page).getByRole("button", { name: "취소" })).toBeEnabled();
  await disableDlg(page).getByRole("button", { name: "취소" }).click();
  await expect(disableDlg(page)).toHaveCount(0);
});

test("정적 점검: 새 오류 코드 18개의 변수 이름이 23개 locale 모두 en과 같다", async () => {
  const dir = path.join(process.cwd(), "src/shared/i18n/locales");
  const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");
  const pick = (src: string) => new Map([...src.matchAll(/^\s*"((?:err\.jj\.|ops\.jj\.|jjOps\.|jjBm\.|jjDis\.|toolbar\.jj|graph\.jj)[\w.]+)": "((?:[^"\\]|\\.)*)",?$/gm)].map((m) => [m[1], m[2]]));
  const en = pick(read("en.ts"));
  const codes = ["badBookmark", "badRemote", "badOpId", "ambiguousOpId", "noOperation", "noBookmark", "bookmarkBackwards", "rootCommit", "nothingToUndo", "cannotUndo", "disablePartial", "disableDetached", "disableKept", "disableLeftover", "disableUnknown", "otherWorkspaces", "disableChanged", "disableUnbornBranch"];
  for (const c of codes) expect(en.has("err.jj." + c), c).toBe(true);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts"));
  expect(files.length).toBe(23);
  for (const f of files) {
    const m = pick(read(f));
    for (const [k, v] of en) {
      if (!k.startsWith("err.jj.") && !/^(ops\.jj\.(undo|dirty|restore|bookmark|backwards|moveAnyway|badName|abandonBookmarks|abandonMore|disable)|jjOps|jjBm|jjDis)/.test(k)) continue;
      expect(m.has(k), `${f} ${k}`).toBe(true);
      expect(vars(m.get(k)!), `${f} ${k}`).toBe(vars(v));
    }
  }
});

test("정적 점검: 일반 빌드 결과물에는 실제 앱 E2E 훅(__e2eDomMenu)이 없고, VITE_E2E_APP=1 빌드에만 있다", async () => {
  test.setTimeout(120_000);
  const build = (e2e: boolean) => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "git403-dist-"));
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITE_")));
    execSync(`pnpm exec vite build --outDir ${out} --emptyOutDir`, { cwd: process.cwd(), env: { ...env, ...(e2e ? { VITE_E2E_APP: "1" } : {}) }, stdio: "ignore" });
    const hit = (dir: string): boolean => fs.readdirSync(dir, { withFileTypes: true }).some((f) => (f.isDirectory() ? hit(path.join(dir, f.name)) : f.name.endsWith(".js") && fs.readFileSync(path.join(dir, f.name), "utf8").includes("__e2eDomMenu")));
    const found = hit(out);
    fs.rmSync(out, { recursive: true, force: true });
    return found;
  };
  expect(build(false)).toBe(false);
  expect(build(true)).toBe(true);
});
