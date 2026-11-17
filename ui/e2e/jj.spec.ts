import { expect, test, type Page } from "@playwright/test";
import { sha } from "./png";

// jj 보기(30d): jj 켜기·git/jj 보기 전환·행의 change ID·@·충돌 배지. mock의 `window.__jj = {enabled, status}`.
const STATUS = {
  workingCopy: sha("m3"),
  changeIds: {
    [sha("m3")]: { short: "kkmpptxzrspx", full: "kkmpptxzrspxqwertyuiopasdfghjklz" },
    [sha("c5")]: { short: "rlvkpnrzqnoo", full: "rlvkpnrzqnooqwertyuiopasdfghjklz" },
    [sha("c3")]: { short: "zzzzzzzzzzzz", full: "zzzzzzzzzzzzqwertyuiopasdfghjklz" },
  },
  conflicted: [sha("c5")],
  truncated: false,
};
const row = (page: Page, subject: string) => page.locator(".commits .row").filter({ hasText: subject });
const menuItem = (page: Page, name: string | RegExp) => page.getByRole("menu").getByRole("menuitem", { name });
const openRepoMenu = (page: Page) => page.locator(".toolbar .picker").first().click();
const hiddenArgs = (page: Page) => page.evaluate(() => ((window as any).__graphHidden as string[][]).at(-1)!);

async function open(page: Page, jj?: object) {
  await page.addInitScript((j) => {
    Object.assign(window, { __asked: [] }, j ? { __jj: j } : {});
  }, jj);
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(row(page, "README 정리")).toBeVisible();
}

test("jj가 꺼져 있으면 git 보기이고 메뉴에 'jj 모드 켜기'만 보인다 (refs/jj 제외는 백엔드)", async ({ page }) => {
  await open(page);
  await expect(page.locator(".jj-mark")).toHaveCount(0);
  expect(await hiddenArgs(page)).toEqual([]);
  await openRepoMenu(page);
  await expect(menuItem(page, "jj 모드 켜기…")).toBeVisible();
  await expect(menuItem(page, /jj 보기/)).toHaveCount(0);
});

test("jj 모드 켜기: OS 확인창 → jj_enable → jj 보기로 change ID·@가 보인다", async ({ page }) => {
  await open(page, { enabled: false, status: STATUS });
  await openRepoMenu(page);
  await menuItem(page, "jj 모드 켜기…").click();
  await expect(page.locator(".jj-mark")).toHaveCount(3);
  expect(await page.evaluate(() => (window as any).__asked as string[])).toEqual([expect.stringContaining(".jj 폴더")]);
  expect((await page.evaluate(() => (window as any).__git as string[][])).some((c) => c[0] === "jj_enable")).toBe(true);
  expect(await hiddenArgs(page)).toEqual([`+jj:${sha("m3")}`]);
  await openRepoMenu(page);
  await expect(menuItem(page, "jj 모드 켜기…")).toHaveCount(0);
  await expect(menuItem(page, /✓ jj 보기/)).toBeVisible();
});

test("확인창에서 취소하면 jj_enable을 부르지 않는다", async ({ page }) => {
  await open(page, { enabled: false, status: STATUS });
  await page.evaluate(() => ((window as any).__askNo = true));
  await openRepoMenu(page);
  await menuItem(page, "jj 모드 켜기…").click();
  await expect(page.locator(".jj-mark")).toHaveCount(0);
  expect((await page.evaluate(() => (window as any).__git as string[][])).some((c) => c[0] === "jj_enable")).toBe(false);
});

test("jj가 켜진 저장소는 기본이 jj 보기: change ID 앞 8자, @ 표시, 충돌 배지", async ({ page }) => {
  await open(page, { enabled: true, status: STATUS });
  await expect(page.locator(".jj-mark")).toHaveCount(3); // 상태에 있는 커밋만
  const m3 = row(page, "Merge branch 'feature/graph'");
  await expect(m3.locator(".jj-id")).toHaveText("kkmpptxz");
  await expect(m3.locator(".jj-id")).toHaveAttribute("title", "Change ID: kkmpptxzrspxqwertyuiopasdfghjklz");
  await expect(m3.locator(".jj-at")).toHaveText("@");
  await expect(m3.locator(".jj-conflict")).toHaveCount(0);
  const c5 = row(page, "README 정리");
  await expect(c5.locator(".jj-id")).toHaveText("rlvkpnrz");
  await expect(c5.locator(".jj-at")).toHaveCount(0);
  await expect(c5.locator(".jj-conflict")).toHaveText("충돌");
  await expect(page.locator(".jj-at")).toHaveCount(1);
  await expect(page.locator(".jj-conflict")).toHaveCount(1);
  expect(await hiddenArgs(page)).toEqual([`+jj:${sha("m3")}`]);
  await page.screenshot({ path: `e2e/results/screens/jj-${test.info().project.name}.png` });
});

test("git 보기로 전환하면 표시가 사라지고 표지 없이 다시 읽으며, 새로고침해도 저장소별로 기억한다", async ({ page }) => {
  await open(page, { enabled: true, status: STATUS });
  await openRepoMenu(page);
  await menuItem(page, /✓ jj 보기/).click();
  await expect(page.locator(".jj-mark")).toHaveCount(0);
  await expect.poll(() => hiddenArgs(page)).toEqual([]);
  await page.reload(); // 열린 탭이 복원된다
  await expect(row(page, "README 정리")).toBeVisible();
  await expect(page.locator(".jj-mark")).toHaveCount(0);
  await openRepoMenu(page);
  await menuItem(page, /jj 보기/).click(); // 다시 켜기
  await expect(page.locator(".jj-mark")).toHaveCount(3);
});

test("jj_status가 오류(꺼짐·실패)여도 git 보기로 그래프는 뜬다", async ({ page }) => {
  await open(page, { enabled: false });
  await expect(page.locator(".jj-mark")).toHaveCount(0);
  await expect(row(page, "README 정리")).toBeVisible();
});

// ---- 30e: 쓰기 작업 (커밋 우클릭 메뉴·변경 화면). 호출 인자는 mock이 gitCalls(`__git`)에 [cmd, ...인자]로 기록 ----
const calls = async (page: Page, name: string) => (await page.evaluate(() => (window as any).__git as string[][])).filter((c) => c[0] === name);
const rightClick = async (page: Page, subject: string) => {
  await row(page, subject).click({ button: "right" });
};
const toast = (page: Page, text: string | RegExp) => page.locator(".toast", { hasText: text });

test("jj 보기 커밋 우클릭: 새 변경·편집·부모로 합치기가 jj_* 를 그 커밋 SHA로 부른다", async ({ page }) => {
  await open(page, { enabled: true, status: STATUS });
  await rightClick(page, "README 정리");
  await menuItem(page, "여기서 새 변경").click();
  expect(await calls(page, "jj_new")).toEqual([["jj_new", sha("c5")]]);
  await expect(toast(page, "새 변경을 만들었습니다")).toBeVisible();
  await rightClick(page, "README 정리");
  await menuItem(page, "편집 (@로 만들기)").click();
  expect(await calls(page, "jj_edit")).toEqual([["jj_edit", sha("c5")]]);
  await rightClick(page, "README 정리");
  await menuItem(page, "부모로 합치기").click();
  expect(await calls(page, "jj_squash")).toEqual([["jj_squash", sha("c5")]]);
  // 끝나면 그래프를 다시 읽는다 (jj 표지 유지)
  expect(await hiddenArgs(page)).toEqual([`+jj:${sha("m3")}`]);
});

test("git 보기에서는 jj 메뉴 항목이 없다", async ({ page }) => {
  await open(page, { enabled: true, status: STATUS });
  await openRepoMenu(page);
  await menuItem(page, /✓ jj 보기/).click();
  await rightClick(page, "README 정리");
  await expect(menuItem(page, "여기서 새 변경")).toHaveCount(0);
  await expect(menuItem(page, "버리기…")).toHaveCount(0);
});

test("설명 편집: 현재 메시지로 채운 시트에서 저장하면 jj_describe, 취소하면 부르지 않는다", async ({ page }) => {
  await open(page, { enabled: true, status: STATUS });
  await rightClick(page, "README 정리");
  await menuItem(page, "설명 편집…").click();
  const dlg = page.getByRole("dialog", { name: "설명 편집" });
  await expect(dlg.getByLabel("제목")).toHaveValue("README 정리");
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  expect(await calls(page, "jj_describe")).toEqual([]);
  await rightClick(page, "README 정리");
  await menuItem(page, "설명 편집…").click();
  await dlg.getByLabel("제목").fill("새 설명");
  await dlg.getByLabel("본문(선택)").fill("본문 줄");
  await dlg.getByRole("button", { name: "메시지 수정" }).click();
  expect(await calls(page, "jj_describe")).toEqual([["jj_describe", sha("c5"), "새 설명\n\n본문 줄\n"]]);
  await expect(toast(page, "설명을 저장했습니다")).toBeVisible();
});

test("버리기는 확인창을 거치고, 취소하면 jj_abandon을 부르지 않는다", async ({ page }) => {
  await open(page, { enabled: true, status: STATUS });
  await page.evaluate(() => ((window as any).__askNo = true));
  await rightClick(page, "README 정리");
  await menuItem(page, "버리기…").click();
  expect(await calls(page, "jj_abandon")).toEqual([]);
  expect(await page.evaluate(() => (window as any).__asked as string[])).toEqual([expect.stringContaining("이 변경을 버릴까요")]);
  await page.evaluate(() => ((window as any).__askNo = false));
  await rightClick(page, "README 정리");
  await menuItem(page, "버리기…").click();
  await expect.poll(async () => (await calls(page, "jj_abandon")).length).toBe(1);
  expect(await calls(page, "jj_abandon")).toEqual([["jj_abandon", sha("c5")]]);
  await expect(toast(page, "변경을 버렸습니다")).toBeVisible();
});

test("커밋 2개를 고르고 우클릭하면 머지 변경(jj_new 부모 2개), 하나면 일반 새 변경", async ({ page }) => {
  await open(page, { enabled: true, status: STATUS });
  await row(page, "README 정리").click();
  await row(page, "Merge branch 'feature/graph'").click({ modifiers: ["ControlOrMeta"] });
  await rightClick(page, "Merge branch 'feature/graph'");
  await expect(menuItem(page, "여기서 새 변경")).toHaveCount(0);
  await menuItem(page, "선택한 2개로 머지 변경 만들기").click();
  const [c] = await calls(page, "jj_new");
  expect(c[1].split(",")).toEqual([sha("m3"), sha("c5")]); // 우클릭한 커밋이 첫 부모 (정렬하지 않는다)
  await expect(toast(page, "머지 변경을 만들었습니다")).toBeVisible();
  await rightClick(page, "README 정리");
  await menuItem(page, "선택한 2개로 머지 변경 만들기").click();
  expect((await calls(page, "jj_new"))[1][1].split(",")).toEqual([sha("c5"), sha("m3")]);
});

test("불변 커밋 오류·stale·경고·상태 오류는 토스트로 보이고 stale은 다시 읽는다(자동 재시도 없음)", async ({ page }) => {
  await open(page, { enabled: true, status: STATUS });
  const fail = (code: string) => page.evaluate((c) => ((window as any).__jj.fail = JSON.stringify({ code: c, vars: { sha: "abc" }, message: "x" })), code);
  await fail("jj.immutable");
  await rightClick(page, "README 정리");
  await menuItem(page, "버리기…").click();
  await expect(toast(page, "고칠 수 없습니다")).toBeVisible();
  // stale: 한 번만 부르고, 그래프를 다시 읽고(hidden 목록이 늘어남), 안내한다
  await fail("jj.stale");
  const loads = async () => (await page.evaluate(() => (window as any).__graphHidden as string[][])).length;
  const n0 = await loads();
  await rightClick(page, "README 정리");
  await menuItem(page, "편집 (@로 만들기)").click();
  await expect(toast(page, "다시 읽었으니 다시 시도하세요")).toBeVisible();
  await expect.poll(loads).toBeGreaterThan(n0);
  expect(await calls(page, "jj_edit")).toEqual([]); // mock은 fail이면 기록하지 않는다 = 재시도 호출도 없음
  // 경고: 성공 토스트 + 경고 토스트
  await page.evaluate(() => {
    const j = (window as any).__jj;
    delete j.fail;
    j.warn = [{ code: "jj.exportFailed", vars: { name: "main", reason: "locked" }, message: "x" }];
  });
  await rightClick(page, "README 정리");
  await menuItem(page, "편집 (@로 만들기)").click();
  await expect(toast(page, "이 변경을 편집합니다")).toBeVisible();
  await expect(toast(page, "git ref main")).toContainText("locked");
  await expect(page.locator(".toast.warning, .toast.warn").filter({ hasText: "git ref main" })).toHaveCount(1);
});

test("jj_status가 notEnabled·notRepo 외 오류면 git 보기로 뜨되 오류 토스트를 보인다", async ({ page }) => {
  await open(page, { enabled: true, status: STATUS, statusFail: JSON.stringify({ code: "jj.failed", vars: { step: "load", detail: "boom" }, message: "x" }) });
  await expect(row(page, "README 정리")).toBeVisible();
  await expect(page.locator(".jj-mark")).toHaveCount(0);
  await expect(toast(page, "jj 작업 실패 (load): boom").or(toast(page, "jj 상태를 읽지 못했습니다"))).toBeVisible();
  await expect(toast(page, "jj 상태를 읽지 못했습니다")).toContainText("boom");
});

test("jj_status가 notRepo(worktree·서브모듈)면 조용히 git 보기", async ({ page }) => {
  await open(page, { enabled: true, statusFail: JSON.stringify({ code: "jj.notRepo", vars: {}, message: "x" }) });
  await expect(row(page, "README 정리")).toBeVisible();
  await expect(page.locator(".toast")).toHaveCount(0);
});

test.describe("로컬 변경 화면(jj 보기)", () => {
  const openChanges = async (page: Page) => {
    await open(page, { enabled: true, status: STATUS });
    await page.locator(".commits").getByText("로컬 변경사항").click();
    await expect(page.getByRole("listbox", { name: "@의 변경" })).toBeVisible();
  };
  const files = (page: Page) => page.getByRole("listbox", { name: "@의 변경" }).getByRole("option");

  test("스테이징 대신 @의 변경 한 목록 + jj 작업 줄(스테이지 버튼 없음)", async ({ page }) => {
    await openChanges(page);
    await expect(page.getByRole("listbox", { name: "스테이지됨", exact: true })).toHaveCount(0);
    expect(await files(page).count()).toBeGreaterThan(1);
    await expect(page.locator(".row-btn")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /모두 스테이지/ })).toHaveCount(0);
    await expect(page.locator(".commit-box")).toHaveClass(/jj-box/);
    await expect(page.getByRole("button", { name: "선택 파일 부모로 합치기" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "선택 파일로 나누기" })).toBeDisabled();
    await page.screenshot({ path: `e2e/results/screens/jj-changes-${test.info().project.name}.png` });
  });

  test("파일을 체크하면 squash·split이 그 경로로 호출되고 체크가 풀린다", async ({ page }) => {
    await openChanges(page);
    const names = await files(page).locator(".label").allTextContents();
    await page.getByRole("checkbox", { name: `${names[0]} 선택` }).check();
    await page.getByRole("button", { name: "선택 파일 부모로 합치기" }).click();
    await expect.poll(async () => (await calls(page, "jj_squash")).length).toBe(1);
    expect(await calls(page, "jj_squash")).toEqual([["jj_squash", names[0]]]);
    await expect(page.getByRole("button", { name: "선택 파일로 나누기" })).toBeDisabled();
    await page.getByRole("checkbox", { name: `${names[1]} 선택` }).check();
    await page.getByRole("button", { name: "선택 파일로 나누기" }).click();
    await expect.poll(async () => (await calls(page, "jj_split")).length).toBe(1);
    expect(await calls(page, "jj_split")).toEqual([["jj_split", sha("m3"), names[1]]]);
  });

  test("새 변경은 @ 위에, 설명은 @의 설명 편집 시트로", async ({ page }) => {
    await openChanges(page);
    await page.getByRole("button", { name: "새 변경", exact: true }).click();
    await expect.poll(async () => (await calls(page, "jj_new")).length).toBe(1);
    expect(await calls(page, "jj_new")).toEqual([["jj_new", sha("m3")]]);
    await page.getByRole("button", { name: "설명", exact: true }).click();
    const dlg = page.getByRole("dialog", { name: "설명 편집" });
    await dlg.getByLabel("제목").fill("@ 설명");
    await dlg.getByRole("button", { name: "메시지 수정" }).click();
    await expect.poll(async () => (await calls(page, "jj_describe")).length).toBe(1);
    expect(await calls(page, "jj_describe")).toEqual([["jj_describe", sha("m3"), "@ 설명\n"]]);
  });

  test("git 보기로 바꾸면 스테이징 화면으로 돌아온다", async ({ page }) => {
    await openChanges(page);
    await openRepoMenu(page);
    await menuItem(page, /✓ jj 보기/).click();
    await expect(page.getByRole("listbox", { name: "스테이지 안 됨" })).toBeVisible();
    await expect(page.locator(".commit-box")).not.toHaveClass(/jj-box/);
  });
});

const EXTRA = [
  { path: "newdir/", oldPath: null, index: "?", worktree: "?", untracked: true, conflict: false },
  { path: "renamed.txt", oldPath: "before.txt", index: "R", worktree: ".", untracked: false, conflict: false },
  { path: "copied.txt", oldPath: "origin.txt", index: "C", worktree: ".", untracked: false, conflict: false },
];

test.describe("변경 화면 경로 (jj 보기)", () => {
  const go = async (page: Page) => {
    await page.addInitScript((x) => Object.assign(window, { __statusExtra: x }), EXTRA);
    await open(page, { enabled: true, status: STATUS });
    await page.locator(".commits").getByText("로컬 변경사항").click();
    await expect(page.getByRole("listbox", { name: "@의 변경" })).toBeVisible();
  };
  const pick = (page: Page, p: string) => page.getByRole("checkbox", { name: `${p} 선택` }).check();

  test("추적 안 된 폴더는 끝의 /를 떼서, 이름 바꾸기(R)는 옛 경로까지, 복사(C)는 새 경로만 보낸다", async ({ page }) => {
    await go(page);
    await pick(page, "newdir/");
    await page.getByRole("button", { name: "선택 파일 부모로 합치기" }).click();
    await expect.poll(async () => (await calls(page, "jj_squash")).length).toBe(1);
    expect(await calls(page, "jj_squash")).toEqual([["jj_squash", "newdir"]]);
    await pick(page, "renamed.txt");
    await page.getByRole("button", { name: "선택 파일로 나누기" }).click();
    await expect.poll(async () => (await calls(page, "jj_split")).length).toBe(1);
    expect(await calls(page, "jj_split")).toEqual([["jj_split", sha("m3"), "renamed.txt,before.txt"]]);
    await pick(page, "copied.txt");
    await page.getByRole("button", { name: "선택 파일로 나누기" }).click();
    await expect.poll(async () => (await calls(page, "jj_split")).length).toBe(2);
    expect((await calls(page, "jj_split"))[1]).toEqual(["jj_split", sha("m3"), "copied.txt"]);
  });

  test("스테이지만 된 파일을 보다가 jj 보기로 바꿔도 선택·diff가 남는다 (체크는 비워짐)", async ({ page }) => {
    await open(page, { enabled: true, status: STATUS });
    await openRepoMenu(page);
    await menuItem(page, /✓ jj 보기/).click(); // git 보기
    await page.locator(".commits").getByText("로컬 변경사항").click();
    await page.getByRole("listbox", { name: "스테이지됨", exact: true }).getByRole("option").first().click();
    await openRepoMenu(page);
    await menuItem(page, /jj 보기/).click();
    await expect(page.getByRole("listbox", { name: "@의 변경" }).getByRole("option", { selected: true })).toHaveCount(1);
    await expect(page.locator(".diff .add").first()).toBeVisible();
    await expect(page.locator(".jj-pick:checked")).toHaveCount(0);
  });
});

test("설명 시트가 열린 채 다시 열면 이전 대기는 취소되고 새 시트가 뜬다 (jj_describe는 한 번만)", async ({ page }) => {
  await open(page, { enabled: true, status: STATUS });
  await rightClick(page, "README 정리");
  await menuItem(page, "설명 편집…").click();
  const dlg = page.getByRole("dialog", { name: "설명 편집" });
  await expect(dlg.getByLabel("제목")).toHaveValue("README 정리");
  // 시트 뒤 행에 우클릭 이벤트만 보내 다시 연다
  await row(page, "레인 색상 팔레트").dispatchEvent("contextmenu", { clientX: 400, clientY: 300 });
  await menuItem(page, "설명 편집…").click({ force: true });
  await expect(dlg.getByLabel("제목")).toHaveValue("레인 색상 팔레트");
  await dlg.getByRole("button", { name: "메시지 수정" }).click();
  await expect.poll(async () => (await calls(page, "jj_describe")).length).toBe(1);
  await page.waitForTimeout(300);
  expect((await calls(page, "jj_describe"))).toHaveLength(1);
});

test("메시지를 읽지 못하면 시트를 열지 않고 오류 토스트 (설명이 지워지지 않게)", async ({ page }) => {
  await open(page, { enabled: true, status: STATUS });
  await page.evaluate(() => ((window as any).__commitMessageFail = "메시지 읽기 실패"));
  await rightClick(page, "README 정리");
  await menuItem(page, "설명 편집…").click();
  await expect(toast(page, "메시지 읽기 실패")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "설명 편집" })).toHaveCount(0);
  expect(await calls(page, "jj_describe")).toEqual([]);
});

test("일반 저장소가 아닌(notRepo) 곳에서 'jj 모드 켜기'를 누르면 오류가 보인다", async ({ page }) => {
  const e = JSON.stringify({ code: "jj.notRepo", vars: {}, message: "x" });
  await open(page, { enabled: false, statusFail: e, enableFail: e });
  await openRepoMenu(page);
  await menuItem(page, "jj 모드 켜기…").click();
  await expect(toast(page, "일반 git 저장소가 아닙니다")).toBeVisible();
  await expect(page.locator(".jj-mark")).toHaveCount(0);
});

test("stale 안내는 그래프를 다시 읽은 뒤에 뜬다", async ({ page }) => {
  await open(page, { enabled: true, status: STATUS });
  await page.evaluate(() => {
    (window as any).__jj.fail = JSON.stringify({ code: "jj.stale", vars: {}, message: "x" });
    (window as any).__order = [];
    const orig = (window as any).__graphHidden;
    const push = orig.push.bind(orig);
    orig.push = (...a: unknown[]) => ((window as any).__order.push("graph"), push(...a));
    new MutationObserver(() => {
      if (document.querySelector(".toast") && !(window as any).__order.includes("toast")) (window as any).__order.push("toast");
    }).observe(document.body, { childList: true, subtree: true });
  });
  await rightClick(page, "README 정리");
  await menuItem(page, "편집 (@로 만들기)").click();
  await expect(toast(page, "다시 읽었으니 다시 시도하세요")).toBeVisible();
  const order = await page.evaluate(() => (window as any).__order as string[]);
  expect(order.indexOf("graph")).toBeGreaterThanOrEqual(0);
  expect(order.indexOf("graph")).toBeLessThan(order.indexOf("toast"));
});
