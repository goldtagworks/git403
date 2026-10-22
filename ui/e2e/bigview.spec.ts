import { expect, test, type Page } from "@playwright/test";
import { AFTER, BEFORE, seed, sha } from "./png";
import { cellXib, textDiff } from "./ib";

// 로드맵 25e: diff 크게 보기. 진입(버튼·더블클릭·단축키)·종료(Esc·X)·레이아웃·hunk 이동·공백 무시·줄바꿈·가이드·스크린샷
const calls = (page: Page) => page.evaluate(() => (window as any).__git as string[][]);
const callsOf = async (page: Page, name: string) => (await calls(page)).filter((c) => c[0] === name);
const open = async (page: Page, flags: Record<string, unknown> = {}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript((f) => Object.assign(window, f), { __ai: { consent: true }, ...flags });
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click({ timeout: 3000 }).catch(() => {});
  await expect(flags.__bigGraph ? page.locator(".graph-scroll") : page.locator(".commits").getByText("Initial commit")).toBeVisible();
};
const merge = async (page: Page) => {
  await page.locator(".commits").getByText("Merge branch 'feature/graph'").click();
  await expect(page.locator(".diff .add").first()).toBeVisible();
};
const isBig = (page: Page) => page.evaluate(() => document.documentElement.hasAttribute("data-big"));
const bigBtn = (page: Page) => page.locator(".diff-file").getByRole("button", { name: "크게 보기" });
const closeBtn = (page: Page) => page.locator(".diff-file").getByRole("button", { name: "크게 보기 닫기 (Esc)" });
const box = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!;
const diffPath = (page: Page) => page.locator(".diff-path");
const fileList = (page: Page) => page.getByRole("listbox", { name: "변경 파일", exact: true });
/** 헌크 6개짜리 긴 diff */
const hunks = (n = 6) => {
  const out = ["diff --git a/crates/graph/src/lib.rs b/crates/graph/src/lib.rs", "index 1..2 100644", "--- a/crates/graph/src/lib.rs", "+++ b/crates/graph/src/lib.rs"];
  for (let h = 0; h < n; h++) {
    const s = h * 100 + 1;
    out.push(`@@ -${s},30 +${s},31 @@ fn part${h}()`);
    for (let i = 0; i < 30; i++) out.push(i === 12 ? `+    let added_${h} = ${h};` : `     let line_${h}_${i} = ${i}; // 긴 줄 ${"가나다라마바사 ".repeat(h === 0 ? 14 : 1)}`);
  }
  return out.join("\n") + "\n";
};

test("버튼으로 진입: diff가 그래프 자리 전체를 덮고 오른쪽 열이 세로 전체, 사이드바 접힘, X로 닫으면 원래대로", async ({ page }) => {
  await open(page);
  await merge(page);
  const side0 = await box(page, ".pane.side");
  const graph0 = await box(page, ".pane.graph");
  const loads = await page.evaluate(() => (window as any).__graphLoads);
  await bigBtn(page).hover();
  await expect(bigBtn(page)).toHaveAttribute("title", /^크게 보기 \(.+\)$/);
  await expect(bigBtn(page)).toContainText("크게 보기"); // 아이콘만이 아니라 글자도 보인다
  await expect(bigBtn(page)).toBeVisible();
  await bigBtn(page).click();
  expect(await isBig(page)).toBe(true);
  await expect(page.locator(".pane.graph")).toBeHidden();
  await expect(page.locator(".pane.side")).toBeHidden();
  const main = await box(page, ".main");
  const wrap = await box(page, ".diff-wrap");
  const info = await box(page, ".details > .info");
  expect(wrap.y).toBeLessThanOrEqual(main.y + 1);
  expect(wrap.height).toBeGreaterThanOrEqual(main.height - 2); // 그래프 자리까지 덮는다
  expect(wrap.x).toBeLessThanOrEqual(main.x + 1); // 사이드바 자리까지 넓어짐
  expect(info.x).toBeGreaterThan(wrap.x + wrap.width - 2); // 상세 열은 오른쪽
  expect(info.height).toBeGreaterThanOrEqual(main.height - 2);
  expect(info.x + info.width).toBeGreaterThanOrEqual(main.x + main.width - 1);
  await expect(page.locator(".info-subject")).toContainText("Merge branch 'feature/graph'"); // 커밋 정보·파일 목록 그대로
  await expect(fileList(page).getByRole("option")).not.toHaveCount(0);
  await expect(closeBtn(page)).toBeVisible();
  await closeBtn(page).click();
  expect(await isBig(page)).toBe(false);
  expect(await box(page, ".pane.side")).toEqual(side0);
  expect(await box(page, ".pane.graph")).toEqual(graph0);
  await expect(page.locator(".pane.graph")).toBeVisible();
  expect(await page.evaluate(() => (window as any).__graphLoads)).toBe(loads); // 그래프 재조회 없음
});

test("진입 경로: 머리줄 경로 더블클릭·파일 우클릭 메뉴·빠른 실행, 닫기 버튼은 \"닫기 Esc\"", async ({ page }) => {
  await open(page);
  await merge(page);
  await page.locator(".diff-path").dblclick();
  expect(await isBig(page)).toBe(true);
  await expect(closeBtn(page)).toContainText("닫기");
  await expect(closeBtn(page)).toContainText("Esc");
  await expect(closeBtn(page)).toHaveAttribute("title", "크게 보기 닫기 (Esc)");
  await page.keyboard.press("Escape");
  await fileList(page).getByRole("option", { name: /lib.rs/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "크게 보기" }).click();
  expect(await isBig(page)).toBe(true);
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("dialog").getByRole("textbox").fill("diff 크게");
  await page.keyboard.press("Enter");
  expect(await isBig(page)).toBe(true);
  await page.keyboard.press("Escape");
  // 변경 화면의 파일 우클릭 메뉴
  await page.getByText("로컬 변경사항").click();
  await page.getByRole("listbox", { name: "스테이지 안 됨", exact: true }).getByRole("option").first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "크게 보기" }).click();
  expect(await isBig(page)).toBe(true);
});

test("첫 사용 안내는 한 번만 뜨고, 닫거나 크게 보기를 쓰면 다시 안 뜬다", async ({ page }, info) => {
  await open(page, { __showHint: true });
  await merge(page);
  const hint = page.getByRole("note").filter({ hasText: "크게 볼 수 있어요" });
  await expect(hint).toBeVisible();
  await page.mouse.move(640, 790);
  await page.screenshot({ path: `e2e/results/screens/big-hint-${info.project.name}.png` });
  await hint.getByRole("button", { name: "안내 닫기" }).click();
  await expect(hint).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "저장소 열기" }).click({ timeout: 3000 }).catch(() => {});
  await merge(page);
  await expect(hint).toHaveCount(0);
  // 다른 경로(더블클릭)로 써도 기록된다
  await page.evaluate(() => localStorage.removeItem("bigHint"));
  await page.reload();
  await page.getByRole("button", { name: "저장소 열기" }).click({ timeout: 3000 }).catch(() => {});
  await merge(page);
  await expect(hint).toBeVisible(); // __showHint는 addInitScript라 새로고침에도 유지
  await fileList(page).getByRole("option", { name: /lib.rs/ }).dblclick();
  await page.keyboard.press("Escape");
  await expect(hint).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("bigHint"))).toBe("1");
});

test("긴 줄: 한 줄 모드는 가로 스크롤로 줄 끝까지 보이고(행 배경도 끝까지), 줄바꿈을 켜면 넘치지 않는다 (일반·크게 보기)", async ({ page }) => {
  const line = "render(<Foo a={1} b=\"hello world\" />, { wrapper: Wrapper, ...opts }); ".repeat(14);
  const d = `diff --git a/a.test.tsx b/a.test.tsx\nindex 1..2 100644\n--- a/a.test.tsx\n+++ b/a.test.tsx\n@@ -1,3 +1,3 @@\n ctx\n-old ${line}\n+new ${line}END\n ctx2\n`;
  await open(page, { __fileDiff: d });
  await merge(page);
  const pre = page.locator("pre.diff");
  const check = async () => {
    expect(await pre.evaluate((e) => e.scrollWidth > e.clientWidth + 200)).toBe(true);
    await pre.evaluate((e) => (e.scrollLeft = e.scrollWidth));
    const r = await page.evaluate(() => {
      const p = document.querySelector("pre.diff")!.getBoundingClientRect();
      const row = document.querySelector(".dl.add")!;
      return { code: row.querySelector(".code")!.getBoundingClientRect().right, row: row.getBoundingClientRect().right, pre: p.right };
    });
    expect(Math.abs(r.code - r.pre)).toBeLessThanOrEqual(2); // 줄 끝 글자가 보인다
    expect(r.row).toBeGreaterThanOrEqual(r.pre - 1); // 행 배경이 끝까지
    await pre.evaluate((e) => (e.scrollLeft = 0));
  };
  await check();
  await bigBtn(page).click();
  await check();
  await page.locator(".diff-file").getByRole("button", { name: "줄바꿈", exact: true }).click();
  expect(await pre.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  await page.locator(".diff-file").getByRole("button", { name: "줄바꿈", exact: true }).click();
  // 나란히: 줄바꿈 끔이면 두 쪽이 같은 폭으로 가로 스크롤되고 줄 끝이 보이며, 켜면 넘치지 않는다
  await page.locator(".diff-file").getByRole("radio", { name: "나란히" }).click();
  expect(await pre.evaluate((e) => e.scrollWidth > e.clientWidth + 200)).toBe(true);
  await pre.evaluate((e) => (e.scrollLeft = e.scrollWidth));
  const end = await page.evaluate(() => ({ code: document.querySelector(".sc.add .code")!.getBoundingClientRect().right, pre: document.querySelector("pre.diff")!.getBoundingClientRect().right, old: document.querySelector(".sc.del")!.getBoundingClientRect().width, nu: document.querySelector(".sc.add")!.getBoundingClientRect().width }));
  expect(Math.abs(end.code - end.pre)).toBeLessThanOrEqual(2);
  expect(Math.abs(end.old - end.nu)).toBeLessThanOrEqual(1);
  await page.locator(".diff-file").getByRole("button", { name: "줄바꿈", exact: true }).click();
  expect(await pre.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
});

test("그래프 스크롤 위치는 크게 보기를 열고 닫아도 유지되고 그동안 그리지 않는다", async ({ page }) => {
  await open(page, { __bigGraph: 3000, __changedFiles: [{ status: "M", path: "a.ts", oldPath: null }] });
  await expect(page.locator(".graph-scroll")).toBeVisible();
  await page.mouse.click(600, 150); // 커밋 하나 선택
  await page.locator(".graph-scroll").evaluate((e) => (e.scrollTop = 3000));
  await expect.poll(() => page.locator(".graph-scroll").evaluate((e) => e.scrollTop)).toBe(3000);
  const loads = await page.evaluate(() => (window as any).__graphLoads);
  await expect(page.locator("pre.diff")).toBeVisible(); // 크게 볼 diff가 있어야 진입한다
  await page.keyboard.press("ControlOrMeta+Shift+Enter");
  expect(await isBig(page)).toBe(true);
  expect(await page.locator(".graph-scroll").evaluate((e) => e.scrollTop)).toBe(3000);
  await page.keyboard.press("Escape");
  expect(await isBig(page)).toBe(false);
  expect(await page.locator(".graph-scroll").evaluate((e) => e.scrollTop)).toBe(3000);
  await expect(page.locator(".pane.graph")).toBeVisible();
  expect(await page.evaluate(() => (window as any).__graphLoads)).toBe(loads);
});

test("더블클릭·⌘⇧↩로 진입하고 Esc·⌘⇧↩로 닫는다 (입력창에서는 단축키 무시)", async ({ page }) => {
  await open(page);
  await merge(page);
  await fileList(page).getByRole("option", { name: /CommitGraph.tsx/ }).dblclick();
  expect(await isBig(page)).toBe(true);
  await expect(diffPath(page)).toContainText("CommitGraph.tsx"); // 더블클릭한 파일
  await page.keyboard.press("Escape");
  expect(await isBig(page)).toBe(false);
  await page.keyboard.press("ControlOrMeta+Shift+Enter");
  expect(await isBig(page)).toBe(true);
  await page.keyboard.press("ControlOrMeta+Shift+Enter");
  expect(await isBig(page)).toBe(false);
  // 시트가 열려 있으면 Esc는 시트만 닫는다
  await bigBtn(page).click();
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await isBig(page)).toBe(true);
  await page.keyboard.press("Escape");
  expect(await isBig(page)).toBe(false);
  // 변경 화면의 입력창에서는 단축키를 무시한다
  await page.getByText("로컬 변경사항").click();
  await page.getByLabel("커밋 제목", { exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+Shift+Enter");
  expect(await isBig(page)).toBe(false);
  expect(await callsOf(page, "commit")).toHaveLength(0);
});

test("변경 화면: 버튼·단축키로 진입, 두 목록과 커밋 상자가 오른쪽에 남고 더블클릭은 스테이지 그대로", async ({ page }) => {
  await open(page);
  await page.getByText("로컬 변경사항").click();
  const unstaged = page.getByRole("listbox", { name: "스테이지 안 됨", exact: true }).getByRole("option");
  await expect(page.locator(".diff .add").first()).toBeVisible();
  await bigBtn(page).click();
  expect(await isBig(page)).toBe(true);
  const wrap = await box(page, ".diff-pane");
  const info = await box(page, ".details > .info");
  const main = await box(page, ".main");
  expect(wrap.height).toBeGreaterThanOrEqual(main.height - 2);
  expect(info.x).toBeGreaterThan(wrap.x + wrap.width - 2);
  await expect(page.getByLabel("커밋 제목", { exact: true })).toBeVisible();
  await expect(page.getByRole("listbox", { name: "스테이지됨", exact: true })).toBeVisible();
  // 파일 목록 클릭은 덮은 diff를 바꾼다
  await unstaged.nth(1).click();
  await expect(diffPath(page)).toContainText("notes.md");
  expect(await isBig(page)).toBe(true);
  // 더블클릭은 기존 동작(스테이지)
  await unstaged.first().dblclick();
  await expect(page.getByRole("listbox", { name: "스테이지됨", exact: true }).getByRole("option")).toHaveCount(2);
  expect(await isBig(page)).toBe(true);
  await page.keyboard.press("Escape");
  expect(await isBig(page)).toBe(false);
});

test("파일 목록 클릭·이전/다음 파일 버튼은 크게 보기를 유지한 채 덮은 diff를 바꾼다", async ({ page }) => {
  await open(page);
  await merge(page);
  await bigBtn(page).click();
  await fileList(page).getByRole("option", { name: /CommitGraph.tsx/ }).click();
  await expect(diffPath(page)).toContainText("CommitGraph.tsx");
  await page.getByRole("button", { name: "이전 파일" }).click();
  await expect(diffPath(page)).toContainText("lib.rs");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(diffPath(page)).toContainText("CommitGraph.tsx");
  expect(await isBig(page)).toBe(true);
  // 다른 커밋(저장소 화면을 떠남)은 크게 보기를 닫는다: 탭을 바꾸는 대신 변경 화면 단축키가 없으므로 Esc 확인만
  await page.keyboard.press("Escape");
  expect(await isBig(page)).toBe(false);
});

test("이전/다음 변경 hunk: 버튼·⌥↑/⌥↓로 머리줄 아래에 hunk를 올리고, 입력창에서는 단축키를 무시한다", async ({ page }) => {
  await open(page, { __fileDiff: hunks() });
  await merge(page);
  await bigBtn(page).click();
  const top = async () => {
    const [d, f, h] = await Promise.all([box(page, "pre.diff"), box(page, ".diff-file"), page.locator(".hunk").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top))]);
    const line = d.y + f.height;
    return h.map((y) => Math.round(y - line));
  };
  const next = page.getByRole("button", { name: "다음 변경 (⌥↓)" });
  const prev = page.getByRole("button", { name: "이전 변경 (⌥↑)" });
  expect(Math.abs((await top())[0])).toBeLessThanOrEqual(2);
  await next.click();
  expect(Math.abs((await top())[1])).toBeLessThanOrEqual(2);
  await page.keyboard.press("Alt+ArrowDown");
  expect(Math.abs((await top())[2])).toBeLessThanOrEqual(2);
  await page.keyboard.press("Alt+ArrowUp");
  expect(Math.abs((await top())[1])).toBeLessThanOrEqual(2);
  await prev.click();
  expect(Math.abs((await top())[0])).toBeLessThanOrEqual(2);
  // 입력창 포커스 중에는 무시
  await page.locator(".diff").click();
  await page.evaluate(() => { const i = document.createElement("input"); i.id = "tmp"; document.body.append(i); i.focus(); });
  await page.keyboard.press("Alt+ArrowDown");
  expect(Math.abs((await top())[0])).toBeLessThanOrEqual(2);
  await page.evaluate(() => document.getElementById("tmp")!.remove());
});

test("공백 무시·줄바꿈: 토글은 저장되고, 공백 무시 중엔 hunk 스테이지가 꺼진다", async ({ page }) => {
  await open(page, { __fileDiff: hunks(2) });
  await merge(page);
  await bigBtn(page).click(); // 크게 보기에서는 도구가 줄에 펼쳐진다
  const ws = page.locator(".diff-file").getByRole("button", { name: "공백 무시", exact: true });
  const wrap = page.locator(".diff-file").getByRole("button", { name: "줄바꿈", exact: true });
  await expect(ws).toHaveAttribute("aria-pressed", "false");
  expect(await callsOf(page, "diff_ws")).toHaveLength(0);
  await ws.click();
  await expect(ws).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await callsOf(page, "diff_ws")).length).toBeGreaterThan(0); // 다시 읽을 때 -w
  await expect(page.locator("pre.diff")).not.toHaveClass(/wrap/);
  await wrap.click();
  await expect(page.locator("pre.diff")).toHaveClass(/wrap/);
  // 긴 줄이 가로 스크롤 없이 줄바꿈된다
  expect(await page.locator("pre.diff").evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => [localStorage.getItem("ignoreWs"), localStorage.getItem("diffWrap")])).toEqual(["true", "true"]);
  await page.reload();
  await page.getByRole("button", { name: "저장소 열기" }).click({ timeout: 3000 }).catch(() => {});
  await merge(page);
  await expect(page.locator("pre.diff")).toHaveClass(/wrap/);
  await bigBtn(page).click();
  await expect(ws).toHaveAttribute("aria-pressed", "true");
  await closeBtn(page).click();
  // 변경 화면: 공백 무시 중에는 hunk 버튼이 없고 안내가 보인다
  await page.getByText("로컬 변경사항").click();
  await expect(page.locator(".diff .add").first()).toBeVisible();
  await expect(page.locator(".hunk-btn")).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "공백 차이를 숨기는 중" })).toBeVisible();
  await bigBtn(page).click();
  await page.locator(".diff-file").getByRole("button", { name: "공백 무시", exact: true }).click();
  await expect(page.locator(".hunk-btn").first()).toBeVisible();
});

test("일반 diff 머리줄은 좁으면 도구를 ⋯ 메뉴로 모으고 Blame·히스토리는 기존 검사 창을 연다", async ({ page }) => {
  await open(page);
  await merge(page);
  await expect(page.locator(".tools-wide")).toBeHidden();
  await page.getByRole("button", { name: "diff 도구 더 보기" }).click();
  const menu = page.getByRole("menu");
  for (const name of ["Blame", "히스토리", "공백 무시", "줄바꿈"]) await expect(menu.getByRole("menuitem", { name })).toBeVisible();
  await menu.getByRole("menuitem", { name: "Blame" }).click();
  await expect(page.getByRole("dialog", { name: "Blame" })).toBeVisible();
  await page.keyboard.press("Escape");
  await bigBtn(page).click();
  await expect(page.locator(".tools-wide")).toBeVisible();
  await expect(page.getByRole("button", { name: "diff 도구 더 보기" })).toBeHidden();
  await page.locator(".diff-file").getByRole("button", { name: "히스토리" }).click();
  await expect(page.getByRole("dialog", { name: /히스토리|History/ })).toBeVisible();
});

test("가이드: 크게 보기에서도 단계 클릭·⌘]/⌘[가 파일을 바꾸고 줄로 스크롤한다", async ({ page }) => {
  await open(page);
  await merge(page);
  await page.getByRole("radiogroup", { name: "상세 보기" }).getByRole("radio", { name: "읽는 흐름" }).click();
  await page.getByRole("region", { name: "읽는 흐름 가이드" }).getByRole("button", { name: "가이드 만들기" }).click();
  await expect(page.locator(".guide-step")).toHaveCount(3);
  await bigBtn(page).click();
  expect(await isBig(page)).toBe(true);
  await expect(page.locator(".guide-step")).toHaveCount(3);
  await page.locator(".guide-step").nth(1).click();
  await expect(diffPath(page)).toContainText("CommitGraph.tsx");
  await expect(page.locator(".note-card.cur")).toContainText("2단계");
  await page.keyboard.press("ControlOrMeta+]");
  await expect(page.locator(".note-card.cur")).toContainText("3단계");
  await expect(diffPath(page)).toContainText("lib.rs");
  await page.keyboard.press("ControlOrMeta+[");
  await expect(page.locator(".note-card.cur")).toContainText("2단계");
  await page.keyboard.press("ControlOrMeta+Alt+i"); // 패널 닫기
  await expect(page.locator(".guide-step")).toHaveCount(0);
  expect(await isBig(page)).toBe(true);
});

test("이미지 diff는 크게 보기에서 넓어진 영역을 쓴다", async ({ page }) => {
  const M3 = sha("m3");
  await seed(page, { blobs: { [`${M3}^:img/a.png`]: BEFORE, [`${M3}:img/a.png`]: AFTER } });
  await open(page);
  await page.locator(".commits").getByText("Merge branch 'feature/graph'").click();
  await page.getByRole("option", { name: /a\.png/ }).click();
  await expect(page.locator(".img-frame").first()).toBeVisible();
  const small = (await box(page, ".img-frame")).width;
  await bigBtn(page).click();
  await expect.poll(async () => (await box(page, ".img-frame")).width).toBeGreaterThan(small + 40);
  const stage = await box(page, ".img-stage");
  const fr = await box(page, ".img-frame");
  expect(fr.x + fr.width).toBeLessThanOrEqual(stage.x + stage.width);
});

test("xib 캔버스는 크게 보기에서 넓어지고 이름 칩이 서로 겹치지 않는다", async ({ page }) => {
  const M3 = sha("m3");
  const XIB = "ui/Song/SongCell.xib";
  const b64 = (x: string) => Buffer.from(x).toString("base64");
  await seed(page, { path: XIB, diff: textDiff(XIB), blobs: { [`${M3}^:${XIB}`]: b64(cellXib(false)), [`${M3}:${XIB}`]: b64(cellXib(true)) } });
  await open(page);
  await page.locator(".commits").getByText("Merge branch 'feature/graph'").click();
  await page.getByRole("option", { name: /SongCell\.xib/ }).click();
  await expect(page.locator(".ib-canvas")).toHaveCount(2);
  const overlaps = async () =>
    page.locator(".ib-canvas").evaluateAll((cs) =>
      cs.flatMap((c) => {
        const r = [...c.querySelectorAll(".ib-chip")].map((e) => e.getBoundingClientRect());
        const hit: string[] = [];
        r.forEach((a, i) => r.slice(i + 1).forEach((b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom && hit.push(`${i}`)));
        return hit;
      }),
    );
  expect(await overlaps()).toEqual([]);
  const small = (await box(page, ".ib-canvas")).width;
  await bigBtn(page).click();
  await expect.poll(async () => (await box(page, ".ib-canvas")).width).toBeGreaterThan(small + 100);
  expect(await overlaps()).toEqual([]);
  const canvas = await box(page, ".ib-canvas");
  const body = await box(page, ".ib-body");
  expect(canvas.x + canvas.width).toBeLessThanOrEqual(body.x + body.width + 1);
});

// 시각 확인용 (판정 없음). 결과: e2e/results/screens/big-<종류>-<light|dark>.png
const shotTo = (page: Page, name: string, project: string) => page.screenshot({ path: `e2e/results/screens/big-${name}-${project}.png` });

test("스크린샷: 크게 보기 텍스트·나란히·가이드 (라이트/다크)", async ({ page }, info) => {
  await open(page);
  await merge(page);
  await bigBtn(page).click();
  await page.mouse.move(640, 790);
  await shotTo(page, "text", info.project.name);
  await page.locator(".diff-file").getByRole("radio", { name: "나란히" }).click();
  await shotTo(page, "split", info.project.name);
  await page.locator(".diff-file").getByRole("radio", { name: "한 줄" }).click();
  await page.getByRole("radiogroup", { name: "상세 보기" }).getByRole("radio", { name: "읽는 흐름" }).click();
  await page.getByRole("region", { name: "읽는 흐름 가이드" }).getByRole("button", { name: "가이드 만들기" }).click();
  await expect(page.locator(".guide-step")).toHaveCount(3);
  await page.locator(".guide-step").nth(0).click();
  await expect(page.locator(".note-card.cur")).toContainText("1단계");
  await page.mouse.move(640, 790);
  await shotTo(page, "guide", info.project.name);
});

test("스크린샷: 크게 보기 이미지 (라이트/다크)", async ({ page }, info) => {
  const M3 = sha("m3");
  await seed(page, { blobs: { [`${M3}^:img/a.png`]: BEFORE, [`${M3}:img/a.png`]: AFTER } });
  await open(page);
  await page.locator(".commits").getByText("Merge branch 'feature/graph'").click();
  await page.getByRole("option", { name: /a\.png/ }).click();
  await bigBtn(page).click();
  await expect(page.locator(".img-info")).toContainText("바뀐 픽셀 4.7%");
  await page.mouse.move(640, 790);
  await shotTo(page, "image", info.project.name);
});

test("스크린샷: 크게 보기 xib (라이트/다크)", async ({ page }, info) => {
  const M3 = sha("m3");
  const XIB = "ui/Song/SongCell.xib";
  const b64 = (x: string) => Buffer.from(x).toString("base64");
  await seed(page, { path: XIB, diff: textDiff(XIB), blobs: { [`${M3}^:${XIB}`]: b64(cellXib(false)), [`${M3}:${XIB}`]: b64(cellXib(true)) } });
  await open(page);
  await page.locator(".commits").getByText("Merge branch 'feature/graph'").click();
  await page.getByRole("option", { name: /SongCell\.xib/ }).click();
  await bigBtn(page).click();
  await expect(page.locator(".ib-canvas")).toHaveCount(2);
  await page.mouse.move(640, 790);
  await shotTo(page, "xib", info.project.name);
});

// 파일 히스토리·Blame 시트(features/inspect): 크게 보기·2줄 목록·목록 폭 스플리터·긴 줄 가로 스크롤
const sheetOpen = async (page: Page, kind: "히스토리" | "Blame", flags: Record<string, unknown> = {}) => {
  await open(page, flags);
  await merge(page);
  await page.getByRole("button", { name: "diff 도구 더 보기" }).click();
  await page.getByRole("menuitem", { name: kind }).click();
  return page.getByRole("dialog");
};
const sheetBtn = (dlg: ReturnType<Page["getByRole"]>) => dlg.locator(".sheet-head .big-btn");

test("파일 히스토리: 커밋 목록은 2줄(제목 / 짧은 sha·작성자·날짜), 스플리터로 폭 조절·저장", async ({ page }) => {
  const dlg = await sheetOpen(page, "히스토리");
  const item = dlg.getByRole("option").first();
  await expect(item.locator(".h-subject")).toBeVisible();
  await expect(item.locator(".h-meta")).toContainText(/^\S{7} · /);
  const sub = await item.locator(".h-subject").boundingBox();
  const meta = await item.locator(".h-meta").boundingBox();
  expect(meta!.y).toBeGreaterThan(sub!.y + sub!.height - 2); // 둘째 줄
  // 제목이 잘리지 않는다(목록 폭 안에 다 들어감)
  expect(await item.locator(".h-subject").evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  const list = dlg.getByRole("listbox");
  const w0 = (await list.boundingBox())!.width;
  const sp = (await dlg.locator(".splitter").boundingBox())!;
  await page.mouse.move(sp.x + 1, sp.y + 100);
  await page.mouse.down();
  await page.mouse.move(sp.x + 91, sp.y + 100, { steps: 4 });
  await page.mouse.up();
  expect(Math.round((await list.boundingBox())!.width)).toBe(Math.round(w0 + 90));
  expect(await page.evaluate(() => localStorage.getItem("split:history"))).not.toBeNull();
});

test("파일 히스토리: 크게 보기로 시트가 창 거의 전체로 커지고 저장되며 Esc는 먼저 작게, 다시 누르면 닫는다", async ({ page }, info) => {
  const dlg = await sheetOpen(page, "히스토리");
  const sheet = page.locator(".sheet.inspector");
  const w0 = (await sheet.boundingBox())!.width;
  await expect(dlg.locator("pre.diff .big-btn")).toHaveCount(0); // 시트 안 diff 머리줄에는 버튼이 없다
  await dlg.locator(".diff-path").dblclick();
  expect(await isBig(page)).toBe(false);
  await expect(sheetBtn(dlg)).toContainText("크게 보기");
  await sheetBtn(dlg).click();
  const b = (await sheet.boundingBox())!;
  expect(b.width).toBeGreaterThan(w0 + 100);
  expect(b.width).toBeGreaterThanOrEqual(1280 - 60);
  expect(b.height).toBeGreaterThanOrEqual(800 - 30);
  expect(await isBig(page)).toBe(false); // 앱 크게 보기와 별개
  await expect(sheetBtn(dlg)).toHaveAttribute("title", "원래 크기로 (Esc)");
  await expect(sheetBtn(dlg)).toContainText("원래 크기");
  await expect(sheetBtn(dlg)).toContainText("Esc");
  await page.mouse.move(640, 790);
  await page.screenshot({ path: `e2e/results/screens/big-history-${info.project.name}.png` });
  await page.reload();
  await page.getByRole("button", { name: "저장소 열기" }).click({ timeout: 3000 }).catch(() => {});
  await merge(page);
  await page.getByRole("button", { name: "diff 도구 더 보기" }).click();
  await page.getByRole("menuitem", { name: "히스토리" }).click();
  expect((await sheet.boundingBox())!.width).toBeGreaterThanOrEqual(1280 - 60); // 저장됨
  await page.keyboard.press("Escape");
  expect((await sheet.boundingBox())!.width).toBeLessThan(w0 + 5);
  await page.keyboard.press("ControlOrMeta+Shift+Enter");
  expect((await sheet.boundingBox())!.width).toBeGreaterThanOrEqual(1280 - 60);
  expect(await isBig(page)).toBe(false);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("Blame 시트도 같은 크게 보기 버튼을 쓴다", async ({ page }) => {
  const dlg = await sheetOpen(page, "Blame");
  const sheet = page.locator(".sheet.inspector");
  const w0 = (await sheet.boundingBox())!.width;
  await sheetBtn(dlg).click();
  expect((await sheet.boundingBox())!.width).toBeGreaterThan(w0 + 100);
});

test("파일 히스토리 시트의 긴 줄 diff도 가로 스크롤로 줄 끝까지 보인다", async ({ page }) => {
  const line = "render(<Foo a={1} b=\"hello world\" />, { wrapper: Wrapper, ...opts }); ".repeat(14);
  const d = `diff --git a/a.test.tsx b/a.test.tsx\nindex 1..2 100644\n--- a/a.test.tsx\n+++ b/a.test.tsx\n@@ -1,3 +1,3 @@\n ctx\n-old ${line}\n+new ${line}END\n ctx2\n`;
  const dlg = await sheetOpen(page, "히스토리", { __fileDiff: d });
  const pre = dlg.locator("pre.diff");
  await expect(dlg.locator(".dl.add")).toBeVisible();
  expect(await pre.evaluate((e) => e.scrollWidth > e.clientWidth + 200)).toBe(true);
  await pre.evaluate((e) => (e.scrollLeft = e.scrollWidth));
  const r = await dlg.evaluate((el) => ({ code: el.querySelector(".dl.add .code")!.getBoundingClientRect().right, pre: el.querySelector("pre.diff")!.getBoundingClientRect().right }));
  expect(Math.abs(r.code - r.pre)).toBeLessThanOrEqual(2);
});

test("공백 무시를 끈 직후 새 diff가 오기 전까지는 hunk 스테이지가 꺼져 있다", async ({ page }) => {
  await open(page);
  await page.getByText("로컬 변경사항").click();
  await expect(page.locator(".diff .add").first()).toBeVisible();
  await bigBtn(page).click();
  const ws = page.locator(".diff-file").getByRole("button", { name: "공백 무시", exact: true });
  await ws.click(); // 켬 (-w diff)
  await expect(page.locator(".hunk-btn")).toHaveCount(0);
  await page.evaluate(() => ((window as any).__diffDelay = 1500));
  await ws.click(); // 끔 → 새 diff는 1.5초 뒤에 도착
  await page.waitForTimeout(300);
  await expect(page.locator(".hunk-btn")).toHaveCount(0); // 아직 -w diff
  await expect(page.locator(".hunk-btn").first()).toBeVisible({ timeout: 5000 }); // 새 diff 도착 뒤
});

test("보여 줄 diff가 없으면(변경 파일 없음) 단축키로 진입하지 않고 빠른 실행에도 항목이 없다", async ({ page }) => {
  await open(page, { __changedFiles: [] });
  await page.locator(".commits").getByText("README 정리").click();
  await expect(page.locator(".details .info-subject")).toContainText("README 정리");
  await page.keyboard.press("ControlOrMeta+Shift+Enter");
  expect(await isBig(page)).toBe(false);
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("dialog").getByRole("textbox").fill("크게 보기");
  await expect(page.getByRole("dialog").getByText("diff 크게 보기")).toHaveCount(0);
  await page.keyboard.press("Escape");
  expect(await isBig(page)).toBe(false);
});

test("크게 보기 중 시트에서 다른 커밋을 골라도 크게 보기는 유지되고, ⌥↑/⌥↓는 시트 안 diff만 움직인다, 입력창의 Esc는 포커스만 푼다", async ({ page }) => {
  await open(page, { __fileDiff: hunks() });
  await merge(page);
  await bigBtn(page).click();
  await page.locator(".diff-file").getByRole("button", { name: "히스토리" }).click();
  const dlg = page.getByRole("dialog");
  const main = page.locator(".details > .diff-wrap pre.diff");
  const before = await main.evaluate((e) => e.scrollTop);
  await page.keyboard.press("Alt+ArrowDown");
  expect(await main.evaluate((e) => e.scrollTop)).toBe(before); // 뒤쪽(메인) diff는 안 움직인다
  await dlg.getByRole("option").nth(1).dblclick(); // 커밋 선택 → 시트 닫힘
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await isBig(page)).toBe(true);
  // 입력창의 Esc는 blur만
  await page.evaluate(() => { const i = document.createElement("input"); i.id = "tmp2"; document.body.append(i); i.focus(); });
  await page.keyboard.press("Escape");
  expect(await isBig(page)).toBe(true);
  expect(await page.evaluate(() => document.activeElement?.id)).not.toBe("tmp2");
  await page.keyboard.press("Escape");
  expect(await isBig(page)).toBe(false);
});

test("파일 우클릭 \"크게 보기\"는 그 파일을 먼저 고른 뒤 진입한다", async ({ page }) => {
  await open(page);
  await merge(page);
  await fileList(page).getByRole("option", { name: /CommitGraph.tsx/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "크게 보기" }).click();
  expect(await isBig(page)).toBe(true);
  await expect(diffPath(page)).toContainText("CommitGraph.tsx");
});

test("로컬 변경사항은 그래프 자리까지 넓게 열리고, ← 그래프로 돌아오면 다시 고를 때 또 넓게 열린다", async ({ page }) => {
  await open(page);
  await page.getByText("로컬 변경사항").click();
  const back = page.getByRole("button", { name: "← 그래프" });
  await expect(back).toBeVisible();
  await expect(page.locator(".main > .pane.graph")).toBeHidden();
  const list = await box(page, ".changes-lists, .details > .info");
  const main = await box(page, ".main");
  expect(list.height).toBeGreaterThan(main.height * 0.8);
  await back.click();
  await expect(page.locator(".main > .pane.graph")).toBeVisible();
  await expect(page.getByLabel("커밋 제목", { exact: true })).toBeVisible(); // 작은 패널로 그대로
  await page.locator(".commits").getByText("로컬 변경사항").click(); // 골라 둔 채 다시 눌러도 넓게
  await expect(back).toBeVisible();
  await back.click();
  await page.locator(".commits").getByText("Initial commit").click();
  await page.locator(".commits").getByText("로컬 변경사항").click();
  await expect(back).toBeVisible();
});
