import { expect, test, type Locator, type Page } from "@playwright/test";

// 29단계: 브랜치 비교(사이드바 다중 선택 → 우클릭 "비교" → 두 목록 + 기존 Details)와 드래그 체리픽(커밋 행 → 현재 브랜치).
// mock 그래프: feature/graph = f3·f2·f1 + c3…, hotfix/pull-lock = h2·h1 + c3…, main(HEAD) = 전부.
const id = (s: string) => s.padEnd(40, "0");
const MULTI = "ControlOrMeta";
const calls = (page: Page) => page.evaluate(() => (window as any).__git as string[][]);
const cherry = async (page: Page) => (await calls(page)).filter((c) => c[0] === "cherry-pick");
const asked = (page: Page) => page.evaluate(() => (window as any).__asked as string[]);

const start = async (page: Page, flags: object = {}) => {
  await page.addInitScript((f) => {
    localStorage.setItem("autoFetch", "0");
    Object.assign(window, { __asked: [] }, f);
  }, flags);
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
};
const side = (page: Page, name: string | RegExp) => page.locator(".side").getByRole("button", { name }).first();
const menuItems = (page: Page) => page.getByRole("menu").getByRole("menuitem");
/** graph·pull-lock을 ⌘/Ctrl-클릭으로 고르고 우클릭 "비교" */
const openCompare = async (page: Page) => {
  await side(page, "graph").click({ modifiers: [MULTI] });
  await side(page, "pull-lock").click({ modifiers: [MULTI] });
  await side(page, "pull-lock").click({ button: "right" });
  await page.getByRole("menuitem", { name: "feature/graph와(과) hotfix/pull-lock 비교" }).click();
};
const col = (page: Page, side: "a" | "b") => page.locator(`.cmp-col[data-side="${side}"]`);
const row = (page: Page, side: "a" | "b", text: string) => col(page, side).getByRole("option").filter({ hasText: text });

/** from → to 위로 끌어 간다 (놓지 않는다). 놓기는 호출 쪽이 mouse.up() */
const dragOver = async (page: Page, from: Locator, to: Locator) => {
  const a = (await from.boundingBox())!;
  await page.mouse.move(a.x + 30, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 50, a.y + a.height / 2 + 12, { steps: 3 });
  await expect(page.locator(".dnd-ghost")).toBeVisible();
  await to.evaluate((el) => el.scrollIntoView({ block: "nearest" })); // 클릭이 섹션 안 목록을 스크롤해 두면 가려질 수 있다
  const b = (await to.boundingBox())!; // 누른 뒤(선택 렌더링 뒤) 위치를 잰다
  await page.mouse.move(b.x + 30, b.y + b.height / 2, { steps: 8 });
};

test.describe("브랜치 비교", () => {
  test("두 브랜치를 ⌘/Ctrl-클릭으로 고르고 우클릭 '비교' → 양쪽에만 있는 커밋 두 목록", async ({ page }) => {
    await start(page);
    await openCompare(page);
    await expect(col(page, "a").getByRole("listbox", { name: "feature/graph에만 있는 커밋 (3)" })).toBeVisible();
    await expect(col(page, "b").getByRole("listbox", { name: "hotfix/pull-lock에만 있는 커밋 (2)" })).toBeVisible();
    await expect(col(page, "a").getByRole("option")).toHaveText([/그래프 곡선 렌더링/, /레인 색상 팔레트/, /그래프 레이아웃 초안/]);
    await expect(col(page, "b").getByRole("option")).toHaveText([/pull 중 UI 멈춤 수정/, /진행률 이벤트 분리/]);
    expect((await calls(page)).filter((c) => c[0] === "compare_refs")).toContainEqual(["compare_refs", "refs/heads/feature/graph", "refs/heads/hotfix/pull-lock"]);
    await expect(page.locator(".cmp-title")).toHaveText("feature/graph ↔ hotfix/pull-lock");
    // 그래프는 숨고, 돌아가기로 복귀
    await expect(page.locator(".commits")).toBeHidden();
    await page.getByRole("button", { name: /← 그래프/ }).click();
    await expect(page.locator(".cmp")).toHaveCount(0);
    await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
  });

  test("커밋을 고르면 기존 Details(변경 파일·diff)가 그 커밋을 보여 준다", async ({ page }) => {
    await start(page);
    await openCompare(page);
    await expect(page.getByRole("listbox", { name: "변경 파일" }).getByRole("option").first()).toBeVisible(); // 첫 커밋이 기본 선택
    await row(page, "b", "진행률 이벤트 분리").click();
    await expect(row(page, "b", "진행률 이벤트 분리")).toHaveAttribute("aria-selected", "true");
    await expect(row(page, "a", "그래프 곡선 렌더링")).toHaveAttribute("aria-selected", "false");
    await expect(page.locator(".details .info-subject")).toHaveText("진행률 이벤트 분리");
    await expect(page.locator(".diff .add").first()).toBeVisible();
  });

  test("한 브랜치만 우클릭하면 '현재 브랜치와 비교', HEAD 자신에는 없다", async ({ page }) => {
    await start(page);
    await side(page, "main").click({ button: "right" });
    await expect(menuItems(page).filter({ hasText: "비교" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await side(page, "pull-lock").click({ button: "right" });
    await page.getByRole("menuitem", { name: "현재 브랜치(main)와 비교" }).click();
    expect((await calls(page)).filter((c) => c[0] === "compare_refs")).toContainEqual(["compare_refs", "refs/heads/hotfix/pull-lock", "refs/heads/main"]);
    await expect(col(page, "a").getByText("여기에만 있는 커밋이 없습니다")).toBeVisible();
    await expect(col(page, "b").getByRole("option").first()).toBeVisible();
  });

  test("사이드바에서 다른 브랜치를 고르면 비교가 닫히고 그래프로 돌아간다", async ({ page }) => {
    await start(page);
    await openCompare(page);
    await side(page, "pull-lock").click();
    await expect(page.locator(".cmp")).toHaveCount(0);
  });

  test("미지원 백엔드(gix)에서는 비교 항목이 숨는다", async ({ page }) => {
    await start(page, { __caps: { all: false, ops: ["log", "status", "switch", "branch"] } });
    await side(page, "pull-lock").click({ button: "right" });
    await expect(menuItems(page).first()).toBeVisible();
    await expect(menuItems(page).filter({ hasText: "비교" })).toHaveCount(0);
  });
});

test.describe("비교 회귀", () => {
  test("사이드바 다중 선택은 aria-pressed (aria-selected 아님)", async ({ page }) => {
    await start(page);
    await side(page, "graph").click({ modifiers: [MULTI] });
    await expect(side(page, "graph")).toHaveAttribute("aria-pressed", "true");
    await expect(side(page, "graph")).not.toHaveAttribute("aria-selected", /.*/);
  });

  test("그래프에서 ⌘/Ctrl-클릭으로 해제하면 해제한 행이 선택으로 남지 않고 상세는 남은 커밋", async ({ page }) => {
    await start(page);
    const commits = page.locator(".commits");
    const r = (t: string) => commits.locator(".row").filter({ hasText: t });
    await r("그래프 곡선 렌더링").click();
    await r("레인 색상 팔레트").click({ modifiers: [MULTI] });
    await expect(commits.locator(".row.selected")).toHaveCount(2);
    await r("레인 색상 팔레트").click({ modifiers: [MULTI] }); // 해제
    await expect(commits.locator(".row.selected")).toHaveCount(1);
    await expect(r("그래프 곡선 렌더링")).toHaveClass(/selected/);
    await expect(page.locator(".details .info-subject")).toHaveText("그래프 곡선 렌더링");
    // 처음 고른 쪽을 해제하면 남은 것으로
    await r("레인 색상 팔레트").click({ modifiers: [MULTI] });
    await r("그래프 곡선 렌더링").click({ modifiers: [MULTI] });
    await expect(commits.locator(".row.selected")).toHaveCount(1);
    await expect(r("레인 색상 팔레트")).toHaveClass(/selected/);
    await expect(page.locator(".details .info-subject")).toHaveText("레인 색상 팔레트");
    // 마지막 하나까지 해제하면 선택 없음
    await r("레인 색상 팔레트").click({ modifiers: [MULTI] });
    await expect(commits.locator(".row.selected")).toHaveCount(0);
    await expect(page.locator(".details .info-subject")).toHaveCount(0);
  });

  test("비교 목록에서 해제하면 상세는 남은 선택(없으면 비움), 해제한 행은 강조되지 않는다", async ({ page }) => {
    await start(page);
    await openCompare(page);
    await row(page, "a", "레인 색상 팔레트").click({ modifiers: [MULTI] }); // 기본 선택(첫 커밋)에 더한다
    await expect(page.locator(".details .info-subject")).toHaveText("레인 색상 팔레트");
    await row(page, "a", "레인 색상 팔레트").click({ modifiers: [MULTI] }); // 해제
    await expect(row(page, "a", "레인 색상 팔레트")).toHaveAttribute("aria-selected", "false");
    await expect(page.locator(".details .info-subject")).toHaveText("그래프 곡선 렌더링");
    await row(page, "a", "그래프 곡선 렌더링").click({ modifiers: [MULTI] });
    await expect(col(page, "a").getByRole("option", { selected: true })).toHaveCount(0);
    await expect(page.locator(".details .info-subject")).toHaveCount(0);
  });

  test("비교가 열린 채 같은 두 브랜치로 다시 열어도 첫 커밋 상세가 보인다", async ({ page }) => {
    await start(page);
    await openCompare(page);
    await row(page, "b", "진행률 이벤트 분리").click();
    await expect(page.locator(".details .info-subject")).toHaveText("진행률 이벤트 분리");
    await side(page, "pull-lock").click({ button: "right" }); // 고른 두 브랜치가 그대로 남아 있다
    await page.getByRole("menuitem", { name: "feature/graph와(과) hotfix/pull-lock 비교" }).click();
    await expect(page.locator(".details .info-subject")).toHaveText("그래프 곡선 렌더링");
    await expect(col(page, "a").getByRole("option", { selected: true })).toHaveCount(1);
    await expect(col(page, "b").getByRole("option", { selected: true })).toHaveCount(0);
  });

  test("다른 쌍으로 바꿔 열면 목록·선택이 이전 것으로 남지 않는다", async ({ page }) => {
    await start(page);
    await openCompare(page);
    await row(page, "b", "진행률 이벤트 분리").click();
    await side(page, "graph").click({ modifiers: [MULTI] }); // 고름 해제 → pull-lock만
    await side(page, "graph").click({ modifiers: [MULTI] }); // 다시 고르면 순서가 바뀐다 (pull-lock, graph)
    await side(page, "graph").click({ button: "right" });
    await page.getByRole("menuitem", { name: "hotfix/pull-lock와(과) feature/graph 비교" }).click();
    await expect(page.locator(".cmp-title")).toHaveText("hotfix/pull-lock ↔ feature/graph");
    await expect(col(page, "a").getByRole("listbox", { name: "hotfix/pull-lock에만 있는 커밋 (2)" })).toBeVisible();
    await expect(col(page, "a").getByRole("option")).toHaveText([/pull 중 UI 멈춤 수정/, /진행률 이벤트 분리/]);
    await expect(col(page, "b").getByRole("option")).toHaveCount(3);
    await expect(col(page, "a").getByRole("option", { selected: true })).toHaveCount(1);
    await expect(col(page, "b").getByRole("option", { selected: true })).toHaveCount(0);
    await expect(page.locator(".details .info-subject")).toHaveText("pull 중 UI 멈춤 수정");
  });

  test("같은 이름의 태그가 있어도 브랜치끼리 비교한다 (전체 ref 이름을 넘기고 제목은 짧은 이름)", async ({ page }) => {
    await start(page, { __sameTag: true }); // 태그 hotfix/pull-lock은 c3를 가리킨다: 짧은 이름이면 태그가 풀려 두 번째 목록이 빈다
    await openCompare(page);
    await expect(page.locator(".cmp-title")).toHaveText("feature/graph ↔ hotfix/pull-lock");
    await expect(col(page, "b").getByRole("option")).toHaveText([/pull 중 UI 멈춤 수정/, /진행률 이벤트 분리/]);
    expect((await calls(page)).filter((c) => c[0] === "compare_refs")).toContainEqual(["compare_refs", "refs/heads/feature/graph", "refs/heads/hotfix/pull-lock"]);
  });

  test("원격 브랜치도 refs/remotes/… 전체 이름으로 비교한다", async ({ page }) => {
    await start(page);
    await page.locator('.side section[data-sec="remote"]').getByRole("button", { name: "graph", exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "현재 브랜치(main)와 비교" }).click();
    expect((await calls(page)).filter((c) => c[0] === "compare_refs")).toContainEqual(["compare_refs", "refs/remotes/origin/feature/graph", "refs/heads/main"]);
    await expect(page.locator(".cmp-title")).toHaveText("origin/feature/graph ↔ main");
  });
});

test("스크린샷: 비교 화면과 드래그 중 드롭 표시 (라이트·다크)", async ({ page }, info) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await start(page, { __notInHead: ["f3"] });
  await openCompare(page);
  await expect(page.locator(".diff .add").first()).toBeVisible();
  await page.screenshot({ path: `e2e/results/screens/compare-${info.project.name}.png` });
  await dragOver(page, row(page, "a", "그래프 곡선 렌더링"), side(page, "pull-lock"));
  await expect(side(page, "pull-lock")).toHaveClass(/drop-no/);
  await page.screenshot({ path: `e2e/results/screens/compare-drag-${info.project.name}.png` });
  await page.keyboard.press("Escape");
  await page.mouse.up();
});

test.describe("드래그 체리픽", () => {
  test("비교 목록의 커밋을 현재 브랜치 항목에 놓으면 확인 후 cherry-pick (드롭 가능 표시)", async ({ page }) => {
    await start(page, { __notInHead: ["f3"] });
    await openCompare(page);
    await dragOver(page, row(page, "a", "그래프 곡선 렌더링"), side(page, /^main/));
    await expect(side(page, /^main/)).toHaveClass(/drop-ok/);
    await expect(page.locator(".dnd-ghost")).toHaveText("그래프 곡선 렌더링");
    await expect(page.locator("html")).toHaveAttribute("data-dnd", "ok");
    await page.mouse.up();
    await expect(page.locator(".dnd-ghost")).toHaveCount(0);
    await expect.poll(() => cherry(page)).toEqual([["cherry-pick", id("f3")]]);
    expect(await asked(page)).toEqual(["커밋 1개를 main에 체리픽할까요?"]);
    await expect(page.locator(".toast").getByText("커밋 1개 cherry-pick됨")).toBeVisible();
  });

  test("여러 커밋(⌘/Ctrl-클릭)을 오래된 것부터 한 번에 cherry-pick", async ({ page }) => {
    await start(page, { __notInHead: ["f3", "f2"] });
    await openCompare(page);
    await row(page, "a", "레인 색상 팔레트").click({ modifiers: [MULTI] }); // 기본 선택(첫 커밋)에 더한다
    await expect(col(page, "a").getByRole("option", { selected: true })).toHaveCount(2);
    await dragOver(page, row(page, "a", "레인 색상 팔레트"), side(page, /^main/));
    await expect(page.locator(".dnd-ghost")).toHaveText("커밋 2개");
    await page.mouse.up();
    await expect.poll(() => cherry(page)).toEqual([["cherry-pick", id("f2"), id("f3")]]);
    expect(await asked(page)).toEqual(["커밋 2개를 main에 체리픽할까요?"]);
  });

  test("확인에서 아니오를 누르면 아무것도 하지 않는다", async ({ page }) => {
    await start(page, { __notInHead: ["f3"], __askNo: true });
    await openCompare(page);
    await dragOver(page, row(page, "a", "그래프 곡선 렌더링"), side(page, /^main/));
    await page.mouse.up();
    await expect.poll(() => asked(page)).toHaveLength(1);
    expect(await cherry(page)).toEqual([]);
  });

  test("현재 브랜치가 아닌 곳에는 불가 표시, 놓으면 안내만 하고 cherry-pick하지 않는다", async ({ page }) => {
    await start(page, { __notInHead: ["f3"] });
    await openCompare(page);
    await dragOver(page, row(page, "a", "그래프 곡선 렌더링"), side(page, "pull-lock"));
    await expect(side(page, "pull-lock")).toHaveClass(/drop-no/);
    await expect(page.locator(".dnd-ghost")).toHaveClass(/no/);
    await expect(page.locator("html")).toHaveAttribute("data-dnd", "no");
    await page.mouse.up();
    await expect(page.locator(".toast").getByText("커밋은 현재 브랜치(main)에만 놓을 수 있습니다")).toBeVisible();
    expect(await cherry(page)).toEqual([]);
    expect(await asked(page)).toEqual([]);
    await expect(side(page, "pull-lock")).not.toHaveClass(/drop-no/);
  });

  test("이미 현재 브랜치에 있는 커밋은 막고 이유를 보인다", async ({ page }) => {
    await start(page); // 목 그래프는 main이 전부 포함
    await openCompare(page);
    await dragOver(page, row(page, "a", "그래프 곡선 렌더링"), side(page, /^main/));
    await page.mouse.up();
    await expect(page.locator(".toast").getByText(`이미 현재 브랜치에 포함된 커밋입니다: ${id("f3").slice(0, 7)}`)).toBeVisible();
    expect(await cherry(page)).toEqual([]);
    expect(await asked(page)).toEqual([]);
  });

  test("머지 커밋이 섞이면 막고 이유를 보인다", async ({ page }) => {
    await start(page, { __notInHead: ["m2", "h2"] });
    await side(page, "pull-lock").click({ button: "right" });
    await page.getByRole("menuitem", { name: "현재 브랜치(main)와 비교" }).click();
    const merge = row(page, "b", "Merge branch 'hotfix/pull-lock'");
    await expect(merge).toBeVisible();
    await dragOver(page, merge, side(page, /^main/));
    await page.mouse.up();
    await expect(page.locator(".toast").getByText(`머지 커밋은 함께 체리픽할 수 없습니다: ${id("m2").slice(0, 7)}`)).toBeVisible();
    expect(await cherry(page)).toEqual([]);
  });

  test("Esc로 드래그를 취소하면 아무 일도 없다", async ({ page }) => {
    await start(page, { __notInHead: ["f3"] });
    await openCompare(page);
    await dragOver(page, row(page, "a", "그래프 곡선 렌더링"), side(page, /^main/));
    await expect(page.locator(".dnd-ghost")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".dnd-ghost")).toHaveCount(0);
    await page.mouse.up();
    await expect(side(page, /^main/)).not.toHaveClass(/drop-ok/);
    expect(await asked(page)).toEqual([]);
  });

  test("그래프의 커밋 행(⌘/Ctrl-클릭 다중 선택)을 현재 브랜치 항목에 놓아 cherry-pick", async ({ page }) => {
    await start(page, { __notInHead: ["f3", "f2"] });
    const commits = page.locator(".commits");
    await commits.getByText("그래프 곡선 렌더링").click();
    await commits.getByText("레인 색상 팔레트").click({ modifiers: [MULTI] });
    await expect(commits.locator(".row.selected")).toHaveCount(2);
    await dragOver(page, commits.locator(".row").filter({ hasText: "레인 색상 팔레트" }), side(page, /^main/));
    await expect(page.locator(".dnd-ghost")).toHaveText("커밋 2개");
    await page.mouse.up();
    await expect.poll(() => cherry(page)).toEqual([["cherry-pick", id("f2"), id("f3")]]);
  });

  test("그래프의 HEAD 행에 놓아도 받고, 다른 행은 불가 표시", async ({ page }) => {
    await start(page, { __notInHead: ["f1"] });
    const commits = page.locator(".commits");
    const src = commits.locator(".row").filter({ hasText: "그래프 레이아웃 초안" });
    await dragOver(page, src, commits.locator(".row").filter({ hasText: "로그 파서" }));
    await expect(commits.locator(".row").filter({ hasText: "로그 파서" })).toHaveClass(/drop-no/);
    const head = commits.locator(".row").filter({ hasText: "Merge branch 'feature/graph'" });
    const b = (await head.boundingBox())!;
    await page.mouse.move(b.x + 40, b.y + b.height / 2, { steps: 6 });
    await expect(head).toHaveClass(/drop-ok/);
    await page.mouse.up();
    await expect.poll(() => cherry(page)).toEqual([["cherry-pick", id("f1")]]);
  });

  test("그냥 클릭(5px 미만)은 드래그가 아니라 선택이다", async ({ page }) => {
    await start(page);
    await page.locator(".commits").getByText("로그 파서").click();
    await expect(page.locator(".commits .row.selected")).toContainText("로그 파서");
    await expect(page.locator(".dnd-ghost")).toHaveCount(0);
    expect(await asked(page)).toEqual([]);
  });
});

test("비교 목록 우클릭: 한 개면 커밋 메뉴(cherry-pick 포함), 여러 개면 'N개 cherry-pick'", async ({ page }) => {
  await start(page);
  await openCompare(page);
  await row(page, "a", "레인 색상 팔레트").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "cherry-pick", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await row(page, "a", "레인 색상 팔레트").click({ modifiers: [MULTI] });
  await row(page, "a", "레인 색상 팔레트").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "커밋 2개 cherry-pick" })).toBeVisible();
});
