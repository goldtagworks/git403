import { expect, test, type Page } from "@playwright/test";

// 로드맵 25d: AI 읽는 흐름 가이드. 백엔드는 mock(__aiResult.guide)이고 실제 AI는 부르지 않는다. Rust 쪽 정규화는 crates/ai 테스트가 검증한다.
const calls = (page: Page) => page.evaluate(() => (window as any).__git as string[][]);
const callsOf = async (page: Page, name: string) => (await calls(page)).filter((c) => c[0] === name);
const runs = async (page: Page) => (await callsOf(page, "ai_run")).map((c) => JSON.parse(c[1]) as { task: string; parts: { label: string; text: string }[] });
const consented = { __ai: { consent: true } };
const open = async (page: Page, flags: Record<string, unknown> = consented) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript((f) => Object.assign(window, f), flags);
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
};
const merge = async (page: Page) => {
  await page.locator(".commits").getByText("Merge branch 'feature/graph'").click();
  await expect(page.locator(".diff .add").first()).toBeVisible();
};
const tab = (page: Page, name: "파일" | "읽는 흐름") => page.getByRole("radiogroup", { name: "상세 보기" }).getByRole("radio", { name });
const panel = (page: Page) => page.getByRole("region", { name: "읽는 흐름 가이드" });
const steps = (page: Page) => page.locator(".guide-step");
const diffPath = (page: Page) => page.locator(".diff-path");
/** 커밋 상세에서 가이드를 만들어 둔 상태 */
const made = async (page: Page, flags?: Record<string, unknown>) => {
  await open(page, flags);
  await merge(page);
  await tab(page, "읽는 흐름").click();
  await panel(page).getByRole("button", { name: "가이드 만들기" }).click();
  await expect(steps(page)).toHaveCount(3);
};
const renders = (page: Page) => page.evaluate(() => ({ ...(window as any).__renders }) as Record<string, number>);

test("만들기: 개요·핵심 결정(접힘)·읽는 흐름 1/N·집중·API·확인할 점이 나오고 diff 주석이 붙는다", async ({ page }) => {
  await made(page);
  const r = (await runs(page))[0];
  expect(r.task).toBe("guide");
  expect(r.parts.map((p) => p.label)).toEqual(["commit message", "diff"]);
  expect((await callsOf(page, "quotepath")).map((c) => c[1])).toContain("show"); // 한글 경로를 인용하지 않게 읽는다
  const p = panel(page);
  // 패널이 열려도 제목·짧은 sha·작성자 한 줄은 남는다 (파일 목록 자리만 패널)
  await expect(page.locator(".info-brief")).toContainText("Merge branch 'feature/graph'");
  await expect(page.locator(".info-brief .sha")).toHaveText(/^[0-9a-z]{7}$/);
  await expect(page.locator(".info-brief .brief-who")).toContainText("김개발");
  await expect(p.getByRole("button", { name: "변경 개요" })).toHaveAttribute("aria-expanded", "true");
  await expect(p).toContainText("그래프 색 할당을 안전하게");
  // 핵심 기술 결정은 처음엔 접혀 있고, 열면 결정·이유·다른 방법
  const dec = p.getByRole("button", { name: "핵심 기술 결정" });
  await expect(dec).toHaveAttribute("aria-expanded", "false");
  await expect(p).not.toContainText("u32 포화 덧셈");
  await dec.click();
  await expect(p).toContainText("색 인덱스를 모듈러로 순환");
  await expect(p).toContainText("오버플로를 피하면서");
  await expect(p).toContainText("검토한 다른 방법");
  await expect(p).toContainText("u32 포화 덧셈");
  await dec.click();
  await expect(p).not.toContainText("u32 포화 덧셈");
  // 읽는 흐름: 1 / 3, 단계 카드(번호·제목·파일 L범위·설명), 현재 단계 강조
  await expect(p.locator(".guide-count")).toHaveText("1 / 3");
  await expect(steps(page).nth(0)).toContainText("색 할당 로직");
  await expect(steps(page).nth(0)).toContainText("lib.rs L13–15");
  await expect(steps(page).nth(0)).toContainText("next_color가 어떻게 순환하는지");
  await expect(steps(page).nth(0)).toHaveAttribute("aria-current", "step");
  await expect(steps(page).nth(1)).not.toHaveAttribute("aria-current", "step");
  // 집중해서 볼 곳 · API · 확인할 점
  await expect(p.locator(".guide-focus")).toContainText("L14");
  await expect(p.locator(".guide-focus")).toContainText("오버플로 가능 지점");
  await expect(p.locator(".guide-api")).toHaveCount(2);
  await expect(p.locator(".guide-api").first().locator(".mono")).toHaveText("next_color");
  await expect(p.getByRole("button", { name: /정의 열기/ })).toHaveCount(1); // file 없는 API에는 링크가 없다
  const checks = p.getByRole("checkbox");
  await expect(checks).toHaveCount(2);
  await checks.first().check();
  await expect(checks.first()).toBeChecked();
  await expect(checks.nth(1)).not.toBeChecked();
  await expect(p).toContainText("AI 결과는 틀릴 수 있습니다");
  // diff: 첫 파일(lib.rs)에 1단계·3단계 배지, 1단계 카드 강조, 집중 점
  await expect(diffPath(page)).toContainText("lib.rs");
  await expect(page.locator(".nb").filter({ hasText: /^1$/ })).toHaveCount(1);
  await expect(page.locator(".nb").filter({ hasText: /^3$/ })).toHaveCount(1);
  await expect(page.locator(".nb.dot")).toHaveCount(1);
  await expect(page.locator(".note-card.cur")).toContainText("1단계 · 색 할당 로직");
  await expect(page.locator(".note-card.cur")).toContainText("next_color가 어떻게 순환하는지");
  await expect(page.locator(".note-card.focus")).toContainText("오버플로 가능 지점");
  await expect(page.locator(".dl.nr")).toHaveCount(5); // 1단계 13~15 + 3단계 43~44 (집중 14는 1단계 안)
});

test("생성 중: 스피너와 취소, 그동안 diff는 그대로 보이고 취소하면 처음 상태로 돌아간다", async ({ page }) => {
  await open(page, { ...consented, __aiSlow: 5000 });
  await merge(page);
  await tab(page, "읽는 흐름").click();
  await expect(panel(page)).toContainText("AI가 이 변경을 읽고");
  await panel(page).getByRole("button", { name: "가이드 만들기" }).click();
  await expect(panel(page).getByRole("status")).toContainText("변경을 읽는 중");
  await expect(panel(page).locator(".guide-spin")).toBeVisible();
  await expect(page.locator(".diff .add").first()).toBeVisible();
  await expect.poll(async () => (await runs(page)).length).toBe(1);
  await panel(page).getByRole("button", { name: "취소" }).click();
  await expect(panel(page).getByRole("button", { name: "가이드 만들기" })).toBeVisible();
  expect(await callsOf(page, "ai_cancel")).toHaveLength(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(steps(page)).toHaveCount(0);
});

test("오류: 문구가 보이고 다시 시도할 수 있다", async ({ page }) => {
  await open(page, { ...consented, __aiFail: "응답을 읽지 못했습니다" });
  await merge(page);
  await tab(page, "읽는 흐름").click();
  await panel(page).getByRole("button", { name: "가이드 만들기" }).click();
  await expect(panel(page).getByRole("alert")).toContainText("응답을 읽지 못했습니다");
  await page.evaluate(() => delete (window as any).__aiFail);
  await panel(page).getByRole("button", { name: "다시 시도" }).click();
  await expect(steps(page)).toHaveCount(3);
});

test("단계 클릭: 그 파일을 열고 배지·범위·카드가 해당 단계로 바뀐다", async ({ page }) => {
  await made(page);
  await steps(page).nth(1).click();
  await expect(diffPath(page)).toContainText("CommitGraph.tsx");
  await expect(panel(page).locator(".guide-count")).toHaveText("2 / 3");
  await expect(steps(page).nth(1)).toHaveAttribute("aria-current", "step");
  await expect(steps(page).nth(0)).not.toHaveAttribute("aria-current", "step");
  await expect(page.locator(".nb").filter({ hasText: /^2$/ })).toHaveCount(1);
  await expect(page.locator(".note-card")).toHaveCount(1);
  await expect(page.locator(".note-card.cur")).toContainText("2단계 · 화면 사용부");
  await expect(page.locator(".dl.nr.cur")).toHaveCount(3);
  // 같은 파일 안의 다른 단계: 이전 카드는 강조가 빠지고 새 카드가 강조된다
  await steps(page).nth(2).click();
  await expect(diffPath(page)).toContainText("lib.rs");
  await expect(page.locator(".note-card.cur")).toHaveCount(1);
  await expect(page.locator(".note-card.cur")).toContainText("3단계 · 끝맺음 정리");
  await expect(page.locator(".note-card:not(.cur)").filter({ hasText: "1단계 · 색 할당 로직" })).toBeVisible();
  // 파일 목록 쪽에서도 선택돼 있다
  await tab(page, "파일").click();
  await expect(page.getByRole("listbox", { name: "변경 파일", exact: true }).getByRole("option", { selected: true })).toContainText("lib.rs");
  await tab(page, "읽는 흐름").click();
  await expect(steps(page)).toHaveCount(3); // 다시 열어도 캐시
  expect(await runs(page)).toHaveLength(1);
});

test("단계 클릭은 긴 diff에서 그 줄이 보이게 스크롤한다", async ({ page }) => {
  const body = Array.from({ length: 161 }, (_, i) => (i === 99 ? "+added" : ` line ${i + 1}`)).join("\n");
  const long = `diff --git a/crates/graph/src/lib.rs b/crates/graph/src/lib.rs\nindex 1..2 100644\n--- a/crates/graph/src/lib.rs\n+++ b/crates/graph/src/lib.rs\n@@ -1,160 +1,161 @@\n${body}\n`;
  const guide = { overview: "o", decision: null, steps: [{ title: "위", file: "crates/graph/src/lib.rs", startLine: 3, endLine: 4, detail: "위쪽" }, { title: "아래", file: "crates/graph/src/lib.rs", startLine: 140, endLine: 142, detail: "아래쪽" }], focus: [], apis: [], checks: [] };
  await open(page, { ...consented, __fileDiff: long, __aiResult: { guide } });
  await merge(page);
  await tab(page, "읽는 흐름").click();
  await panel(page).getByRole("button", { name: "가이드 만들기" }).click();
  await expect(steps(page)).toHaveCount(2);
  const inView = async (n: number) => {
    const row = page.locator(`.diff [data-i="${n - 1}"]`).first();
    const [d, r] = await Promise.all([page.locator("pre.diff").boundingBox(), row.boundingBox()]);
    return !!d && !!r && r.y >= d.y && r.y + r.height <= d.y + d.height;
  };
  await steps(page).nth(1).click();
  await expect.poll(() => inView(140)).toBe(true);
  expect(await page.locator("pre.diff").evaluate((e) => e.scrollTop)).toBeGreaterThan(1000);
  await expect(page.locator(".note-card.cur")).toContainText("2단계 · 아래");
  await steps(page).nth(0).click();
  await expect.poll(() => inView(3)).toBe(true);
  // 같은 단계를 다시 눌러도(스크롤을 옮겨 둔 뒤) 다시 그 줄로 온다
  await page.locator("pre.diff").evaluate((e) => (e.scrollTop = 1500));
  await steps(page).nth(0).click();
  await expect.poll(() => inView(3)).toBe(true);
});

test("⌘]/⌘[ 로 단계 이동, 끝에서는 멈추고 입력창에서는 무시한다", async ({ page }) => {
  await made(page);
  const count = panel(page).locator(".guide-count");
  await page.keyboard.press("ControlOrMeta+[");
  await expect(count).toHaveText("1 / 3"); // 첫 단계에서 이전은 아무 일 없음
  await page.keyboard.press("ControlOrMeta+]");
  await expect(count).toHaveText("2 / 3");
  await expect(diffPath(page)).toContainText("CommitGraph.tsx");
  await expect(page.locator(".note-card.cur")).toContainText("2단계");
  await page.keyboard.press("ControlOrMeta+]");
  await expect(count).toHaveText("3 / 3");
  await expect(diffPath(page)).toContainText("lib.rs");
  await page.keyboard.press("ControlOrMeta+]");
  await expect(count).toHaveText("3 / 3"); // 끝
  await page.keyboard.press("ControlOrMeta+[");
  await expect(count).toHaveText("2 / 3");
  // 화면의 이전/다음 단계 버튼
  await panel(page).getByRole("button", { name: /^다음 단계/ }).click();
  await expect(count).toHaveText("3 / 3");
  await expect(panel(page).getByRole("button", { name: /^다음 단계/ })).toBeDisabled();
  await panel(page).getByRole("button", { name: /^이전 단계/ }).click();
  await expect(count).toHaveText("2 / 3");
  // 입력창 포커스 중엔 무시
  await page.evaluate(() => {
    const i = document.createElement("input");
    i.id = "tmp-input";
    document.body.append(i);
    i.focus();
  });
  await page.keyboard.press("ControlOrMeta+]");
  await expect(count).toHaveText("2 / 3");
  // 25a 파일 이동(⌥←/→)과 겹치지 않는다
  await page.evaluate(() => (document.getElementById("tmp-input") as HTMLElement).remove());
  await page.locator(".diff-wrap").click({ position: { x: 300, y: 100 } });
  await page.keyboard.press("Alt+ArrowRight");
  await expect(count).toHaveText("2 / 3");
});

test("⌥⌘I: 가이드 패널(읽는 흐름 탭) 열기·닫기, 열면 diff 주석이 보이고 닫으면 사라진다", async ({ page }) => {
  await made(page);
  await expect(page.locator(".note-card").first()).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Alt+i");
  await expect(tab(page, "파일")).toHaveAttribute("aria-checked", "true");
  await expect(panel(page)).toHaveCount(0);
  await expect(page.locator(".note-card")).toHaveCount(0);
  await expect(page.locator(".nb")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Alt+i");
  await expect(tab(page, "읽는 흐름")).toHaveAttribute("aria-checked", "true");
  await expect(steps(page)).toHaveCount(3);
  await expect(page.locator(".note-card").first()).toBeVisible();
  // 닫혀 있다가 처음 열어도 된다 (만들기 전)
  await page.keyboard.press("ControlOrMeta+Alt+i");
  await page.locator(".commits").getByText("로그 파서").click();
  await page.keyboard.press("ControlOrMeta+Alt+i");
  await expect(panel(page).getByRole("button", { name: "가이드 만들기" })).toBeVisible();
});

test("API 설명: file이 있으면 '정의 열기'로 그 파일 diff로 이동한다", async ({ page }) => {
  await made(page);
  await steps(page).nth(1).click();
  await expect(diffPath(page)).toContainText("CommitGraph.tsx");
  await panel(page).getByRole("button", { name: "정의 열기 · crates/graph/src/lib.rs:14" }).click();
  await expect(diffPath(page)).toContainText("lib.rs");
  await expect(panel(page).locator(".guide-count")).toHaveText("2 / 3"); // 단계는 그대로
  // 집중해서 볼 곳도 눌러서 이동
  await steps(page).nth(1).click();
  await panel(page).locator(".guide-focus button").click();
  await expect(diffPath(page)).toContainText("lib.rs");
});

test("AI를 쓸 수 없으면 '파일 / 읽는 흐름' 탭이 없고 ⌥⌘I도 아무 일 없다", async ({ page }) => {
  await open(page, { __ai: { cli: false, key: false, consent: true } });
  await merge(page);
  await expect(page.getByRole("radiogroup", { name: "상세 보기" })).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Alt+i");
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByRole("listbox", { name: "변경 파일", exact: true })).toBeVisible();
});

test("대상이 바뀌면 이전 가이드는 숨고, 돌아오면 캐시된 가이드가 다시 나온다", async ({ page }) => {
  await made(page);
  await page.locator(".commits").getByText("로그 파서").click();
  await expect(panel(page).getByRole("button", { name: "가이드 만들기" })).toBeVisible();
  await expect(steps(page)).toHaveCount(0);
  await expect(page.locator(".note-card")).toHaveCount(0);
  await page.locator(".commits").getByText("Merge branch 'feature/graph'").click();
  await expect(steps(page)).toHaveCount(3);
  await expect(page.locator(".note-card").first()).toBeVisible();
  expect(await runs(page)).toHaveLength(1); // 다시 부르지 않았다
  // 다시 만들기는 새로 부른다
  await panel(page).getByRole("button", { name: "다시 만들기" }).click();
  await expect.poll(async () => (await runs(page)).length).toBe(2);
  await expect(steps(page)).toHaveCount(3);
});

test("진입점: 커밋 우클릭 '읽는 흐름 가이드'와 빠른 실행이 패널을 열고 바로 만든다", async ({ page }) => {
  await open(page);
  await page.locator(".commits").getByText("로그 파서").click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "AI 리뷰…", exact: true })).toBeVisible();
  await menu.getByRole("menuitem", { name: "읽는 흐름 가이드", exact: true }).click();
  await expect(tab(page, "읽는 흐름")).toHaveAttribute("aria-checked", "true");
  await expect(steps(page)).toHaveCount(3);
  expect(await runs(page)).toHaveLength(1);
  // 이미 만든 대상에서 다시 누르면 다시 부르지 않는다
  await page.locator(".commits").getByText("로그 파서").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "읽는 흐름 가이드", exact: true }).click();
  await expect(steps(page)).toHaveCount(3);
  expect(await runs(page)).toHaveLength(1);
  // 빠른 실행: 다른 커밋에서도
  await page.locator(".commits").getByText("Initial commit").click();
  await page.keyboard.press("ControlOrMeta+p");
  const dlg = page.getByRole("dialog", { name: "빠른 실행" });
  await dlg.getByRole("textbox").fill("읽는 흐름");
  await dlg.getByRole("option", { name: /읽는 흐름 가이드/ }).click();
  await expect.poll(async () => (await runs(page)).length).toBe(2);
  await expect(steps(page)).toHaveCount(3);
  // 이미 만든 대상에서 빠른 실행: 다시 부르지 않고, 남은 요청이 다른 대상에서 터지지 않는다
  await page.keyboard.press("ControlOrMeta+p");
  await dlg.getByRole("textbox").fill("읽는 흐름");
  await dlg.getByRole("option", { name: /읽는 흐름 가이드/ }).click();
  await page.locator(".commits").getByText("Merge branch 'feature/graph'").click();
  await expect(panel(page).getByRole("button", { name: "가이드 만들기" })).toBeVisible();
  await page.waitForTimeout(300);
  expect(await runs(page)).toHaveLength(2);
});

test("빠른 실행: 대상이 정해지기 전에 닫으면 요청이 사라지고, 변경 화면에서 스테이지가 비면 안내가 나온다", async ({ page }) => {
  await open(page);
  await page.locator(".commits").getByText("로컬 변경사항").click();
  await page.getByRole("button", { name: "← 그래프" }).click(); // 넓은 변경 화면에서 그래프로
  await page.getByRole("listbox", { name: "스테이지됨", exact: true }).getByRole("option").first().dblclick();
  await expect(page.getByRole("listbox", { name: "스테이지됨", exact: true }).getByRole("option")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+p");
  const dlg = page.getByRole("dialog", { name: "빠른 실행" });
  await dlg.getByRole("textbox").fill("읽는 흐름");
  await dlg.getByRole("option", { name: /읽는 흐름 가이드/ }).click();
  await expect(panel(page)).toContainText("스테이지된 변경이 없습니다"); // 조용히 끝나지 않는다
  expect(await runs(page)).toHaveLength(0);
  // 나중에 스테이지해도 이전 요청이 남아 저절로 시작하지 않는다
  await page.keyboard.press("ControlOrMeta+Alt+i");
  await page.keyboard.press("ControlOrMeta+Alt+i");
  await page.locator(".commits").getByText("로그 파서").click();
  await expect(panel(page).getByRole("button", { name: "가이드 만들기" })).toBeVisible();
  expect(await runs(page)).toHaveLength(0);
});

test("AI가 꺼진 저장소에서는 우클릭·빠른 실행에 항목이 없다", async ({ page }) => {
  await open(page, { __ai: { cli: false, key: false, consent: true } });
  await page.locator(".commits").getByText("로그 파서").click({ button: "right" });
  await expect(page.getByRole("menu").getByRole("menuitem", { name: "읽는 흐름 가이드", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("dialog", { name: "빠른 실행" }).getByRole("textbox").fill("읽는 흐름");
  await expect(page.getByRole("dialog", { name: "빠른 실행" }).getByRole("option", { name: /읽는 흐름/ })).toHaveCount(0);
});

const STAGED = (path: string) => `diff --git a/${path} b/${path}
index 3f2a1b0..9c4d2e1 100644
--- a/${path}
+++ b/${path}
@@ -12,7 +12,9 @@ pub fn layout(nodes: &[Node]) -> Layout {
     let mut lanes = Vec::new();
-    let color = 0;
+    // 레인마다 색을 다르게 준다.
+    let mut next_color = 0;
+    let mut fresh = || { next_color += 1; next_color };
     for node in nodes {
         let lane = place(&mut lanes, node);
`;
const changesGuide = { overview: "상태 읽기를 정리합니다.", decision: null, steps: [{ title: "상태 파싱", file: "crates/core/src/status.rs", startLine: 13, endLine: 15, detail: "스테이지된 쪽을 먼저 봅니다." }], focus: [], apis: [], checks: ["테스트가 통과하는지"] };

test("변경 화면: 스테이지된 diff 기준으로 만들고, 단계가 스테이지됨 파일을 열고 주석을 단다", async ({ page }) => {
  await open(page, { ...consented, __stagedDiff: STAGED("crates/core/src/status.rs"), __aiResult: { guide: changesGuide } });
  await page.locator(".commits").getByText("로컬 변경사항").click();
  await expect(page.getByRole("listbox", { name: "스테이지됨", exact: true })).toBeVisible();
  await tab(page, "읽는 흐름").click();
  await expect(page.getByRole("listbox", { name: "스테이지 안 됨", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("커밋 제목", { exact: true })).toBeVisible(); // 커밋 상자는 그대로
  await panel(page).getByRole("button", { name: "가이드 만들기" }).click();
  await expect(steps(page)).toHaveCount(1);
  const r = (await runs(page))[0];
  expect(r.task).toBe("guide");
  expect(r.parts[0].label).toBe("staged diff");
  expect(r.parts[0].text).toContain("crates/core/src/status.rs");
  expect((await callsOf(page, "quotepath")).map((c) => c[1])).toContain("diff");
  await steps(page).first().click();
  await expect(diffPath(page)).toContainText("status.rs");
  await expect(page.locator(".nb").filter({ hasText: /^1$/ })).toHaveCount(1);
  await expect(page.locator(".note-card.cur")).toContainText("1단계 · 상태 파싱");
  // 파일 탭: 스테이지됨 목록에서 선택돼 있고 주석은 닫으면 사라진다
  await tab(page, "파일").click();
  await expect(page.getByRole("listbox", { name: "스테이지됨", exact: true }).getByRole("option", { selected: true })).toContainText("status.rs");
  await expect(page.locator(".note-card")).toHaveCount(0);
  // 스테이지된 내용이 바뀌면(다른 지문) 이전 가이드는 숨는다
  await page.evaluate((d) => ((window as any).__stagedDiff = d), STAGED("crates/core/src/status.rs") + "+    // 더 바뀜\n");
  await tab(page, "읽는 흐름").click();
  await expect(panel(page).getByRole("button", { name: "가이드 만들기" })).toBeVisible();
  await expect(steps(page)).toHaveCount(0);
});

test("변경 화면: 스테이지된 변경이 없으면 버튼이 비활성이고 안내가 나온다", async ({ page }) => {
  await open(page);
  await page.locator(".commits").getByText("로컬 변경사항").click();
  await page.getByRole("listbox", { name: "스테이지됨", exact: true }).getByRole("option").first().dblclick(); // 스테이지 해제
  await expect(page.getByRole("listbox", { name: "스테이지됨", exact: true }).getByRole("option")).toHaveCount(0);
  await page.evaluate(() => ((window as any).__stagedDiff = ""));
  await tab(page, "읽는 흐름").click();
  await expect(panel(page)).toContainText("스테이지된 변경이 없습니다");
  await expect(panel(page).getByRole("button", { name: "가이드 만들기" })).toBeDisabled();
  expect(await runs(page)).toHaveLength(0);
});

test("나란히 보기에서도 새 쪽에 배지·강조·카드가 붙는다", async ({ page }) => {
  await made(page);
  await page.locator(".diff-file").getByRole("radio", { name: "나란히" }).click();
  await expect(page.locator("pre.diff.split")).toBeVisible();
  await expect(page.locator(".sc .nb").filter({ hasText: /^1$/ })).toHaveCount(1);
  await expect(page.locator(".sc.nr")).toHaveCount(5);
  await expect(page.locator(".note-card.cur")).toContainText("1단계 · 색 할당 로직");
  await steps(page).nth(1).click();
  await expect(page.locator(".note-card.cur")).toContainText("2단계 · 화면 사용부");
  await page.locator(".diff-file").getByRole("radio", { name: "한 줄" }).click(); // 저장된 보기 방식을 되돌린다
});

test("레이아웃: 탭은 고정되고 패널 안만 스크롤되며, 이전/다음 파일 버튼은 코드·카드를 가리지 않는다", async ({ page }) => {
  await made(page);
  await steps(page).nth(1).click();
  const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
  const tabs = await box(".guide-tabs");
  expect(await page.locator(".info.guide-on").evaluate((e) => getComputedStyle(e).overflowY)).toBe("hidden");
  await page.locator(".info.guide-on > .guide").evaluate((e) => (e.scrollTop = 120));
  const head = await box(".guide-flow-head");
  const guide = await box(".info.guide-on > .guide");
  expect(head.y).toBeGreaterThanOrEqual(guide.y - 1); // 헤더는 패널 위쪽에 붙는다
  expect(head.y).toBeGreaterThanOrEqual(tabs.y + tabs.height - 1); // 탭과 겹치지 않는다
  const nav = await page.locator(".file-nav").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
  const diff = await box("pre.diff");
  expect(nav.length).toBeGreaterThan(0);
  for (const n of nav) expect(n.x >= diff.x + diff.width - 1 || n.x + n.width <= diff.x + 1, "버튼은 diff 영역 밖 여백").toBe(true);
});

test("접힌 구간(2000줄 뒤)의 단계도 펼쳐서 그 줄로 스크롤한다", async ({ page }) => {
  const body = Array.from({ length: 3000 }, (_, i) => ` line ${i + 1}`);
  body[5] = "+added";
  const big = `diff --git a/crates/graph/src/lib.rs b/crates/graph/src/lib.rs\nindex 1..2 100644\n--- a/crates/graph/src/lib.rs\n+++ b/crates/graph/src/lib.rs\n@@ -1,2999 +1,3000 @@\n${body.join("\n")}\n`;
  const guide = { overview: "o", decision: null, steps: [{ title: "끝", file: "crates/graph/src/lib.rs", startLine: 2600, endLine: 2601, detail: "아래쪽" }], focus: [], apis: [], checks: [] };
  await open(page, { ...consented, __fileDiff: big, __aiResult: { guide } });
  await merge(page);
  await tab(page, "읽는 흐름").click();
  await panel(page).getByRole("button", { name: "가이드 만들기" }).click();
  await steps(page).first().click();
  await expect(page.locator('.diff [data-i="2599"]').first()).toBeVisible();
  await expect.poll(async () => {
    const [d, r] = await Promise.all([page.locator("pre.diff").boundingBox(), page.locator('.diff [data-i="2599"]').first().boundingBox()]);
    return !!d && !!r && r.y >= d.y && r.y + r.height <= d.y + d.height;
  }).toBe(true);
});

// 시각 확인용 (판정 없음). 결과: e2e/results/screens/guide-<light|dark>.png, guide-split-<light|dark>.png
test("스크린샷: 가이드 패널 + diff 주석 (라이트/다크)", async ({ page }, info) => {
  await made(page);
  await panel(page).getByRole("button", { name: "핵심 기술 결정" }).click();
  await steps(page).nth(1).click();
  await expect(page.locator(".note-card.cur")).toContainText("2단계");
  await page.mouse.move(900, 20);
  await page.locator(".info.guide-on > .guide").evaluate((e) => (e.scrollTop = 0));
  await page.screenshot({ path: `e2e/results/screens/guide-${info.project.name}.png` });
  await page.locator(".info.guide-on > .guide").evaluate((e) => (e.scrollTop = 140)); // 스크롤해도 헤더가 탭과 겹치지 않는다
  await page.screenshot({ path: `e2e/results/screens/guide-scrolled-${info.project.name}.png` });
  await page.locator(".info.guide-on > .guide").evaluate((e) => (e.scrollTop = 0));
  await steps(page).nth(0).click();
  await page.locator(".diff-file").getByRole("radio", { name: "나란히" }).click();
  await expect(page.locator(".sc .nb").first()).toBeVisible();
  await page.screenshot({ path: `e2e/results/screens/guide-split-${info.project.name}.png` });
  await page.locator(".diff-file").getByRole("radio", { name: "한 줄" }).click();
});
