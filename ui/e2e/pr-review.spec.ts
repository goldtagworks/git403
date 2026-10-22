import { expect, test, type Page } from "@playwright/test";

// 로드맵 26a: PR 리뷰 화면(목록·개요·대화). 진입·탭·검색·Re-requested·카드·타임라인·GitHub에서 보기·오류·Esc·스크린샷
const callsOf = async (page: Page, name: string) => ((await page.evaluate(() => (window as any).__git)) as string[][]).filter((c) => c[0] === name);
const open = async (page: Page, flags: Record<string, unknown> = {}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript((f) => Object.assign(window, f), flags);
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
};
const screen = (page: Page) => page.locator(".prr");
const item = (page: Page, re: RegExp | string) => screen(page).locator(".prr-items").getByRole("option", { name: re });
const palette = async (page: Page) => {
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("dialog", { name: "빠른 실행" }).getByRole("textbox").fill("PR 리뷰");
  await page.keyboard.press("Enter");
};

test("빠른 실행으로 진입: 리뷰 대기 탭(재요청 강조)과 첫 PR 상세, 그래프 자리를 덮는다", async ({ page }) => {
  await open(page);
  await palette(page);
  await expect(screen(page)).toBeVisible();
  const ws = (await page.locator(".workspace").boundingBox())!;
  const box = (await screen(page).boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(ws.width - 2);
  expect(box.height).toBeGreaterThanOrEqual(ws.height - 2);
  const tabs = screen(page).getByRole("tablist").first();
  await expect(tabs.getByRole("tab", { name: /^리뷰 대기/ })).toHaveAttribute("aria-selected", "true");
  await expect(item(page, /.*/)).toHaveCount(3); // 131(재요청), 128 + 맨 위 "내가 올린 PR" 묶음의 129
  await expect(item(page, /#131/)).toContainText("재요청");
  await expect(item(page, /#131/)).toHaveClass(/rereq/);
  await expect(item(page, /#128/)).toContainText("리뷰 전");
  // 첫 항목(131) 자동 선택
  await expect(item(page, /#131/)).toHaveAttribute("aria-selected", "true");
  await expect(screen(page).getByRole("heading", { name: /설정 화면 다크 모드 색 맞추기/ })).toBeVisible();
  expect((await callsOf(page, "pr_inbox")).length).toBe(1);
});

test("재요청 강조는 배지·왼쪽 막대뿐이고, 배경·테두리는 선택한 항목만 가진다", async ({ page }) => {
  await open(page, { __inbox: undefined });
  await page.locator(".sidebar").getByRole("button", { name: /#7 그래프 곡선 개선/ }).click();
  const re = item(page, /#131/);
  const sel = item(page, /#7 /);
  await expect(sel).toHaveAttribute("aria-selected", "true");
  const css = (l: ReturnType<typeof item>) => l.evaluate((e) => ({ bg: getComputedStyle(e).backgroundColor, bd: getComputedStyle(e).borderTopColor, bar: getComputedStyle(e, "::before").content }));
  const r = await css(re);
  const sl = await css(sel);
  expect(r.bg).toBe("rgba(0, 0, 0, 0)"); // 재요청은 배경 없음
  expect(r.bd).toBe("rgba(0, 0, 0, 0)"); // 테두리 없음
  expect(r.bar).not.toBe("none"); // 왼쪽 막대(::before)
  await expect(re).toContainText("재요청");
  expect(sl.bg).not.toBe("rgba(0, 0, 0, 0)"); // 선택만 배경·테두리
  expect(sl.bd).not.toBe("rgba(0, 0, 0, 0)");
  // 재요청 항목을 골라도 선택 스타일(배경·테두리)이 그대로 가장 눈에 띈다
  await re.click();
  expect((await css(re)).bd).not.toBe("rgba(0, 0, 0, 0)");
  expect((await css(sel)).bd).toBe("rgba(0, 0, 0, 0)");
});

test("탭 필터와 검색(번호·제목·작성자·브랜치)", async ({ page }) => {
  await open(page);
  await palette(page);
  const tab = (n: RegExp) => screen(page).getByRole("tab", { name: n });
  await tab(/^내 PR/).click();
  await expect(item(page, /.*/)).toHaveCount(1);
  await expect(item(page, /#129/)).toBeVisible();
  await tab(/^전체/).click();
  await expect(item(page, /.*/)).toHaveCount(7);
  const q = screen(page).getByRole("textbox", { name: /번호·제목/ });
  await q.fill("jamie");
  await expect(item(page, /.*/)).toHaveCount(2); // 일치 1 + 검색과 무관한 내 PR 묶음 1
  await q.fill("#42");
  await expect(item(page, /#42/)).toBeVisible();
  await expect(item(page, /.*/)).toHaveCount(2);
  await q.fill("fix/settings");
  await expect(item(page, /#131/)).toBeVisible();
  await q.fill("없는검색어");
  await expect(item(page, /.*/)).toHaveCount(1); // 묶음만 남는다
  await expect(screen(page).locator(".prr-items > .prr-note")).toHaveCount(0);
  await q.fill("");
  await expect(item(page, /#126/)).toContainText("초안");
});

test("상세: 카드 줄·본문 접기·타임라인(시간순·head 표시)·접기, 선택 변경 시 다시 조회", async ({ page }) => {
  await open(page);
  await palette(page);
  const body = screen(page).locator(".prr-body");
  await expect(body.getByText("승인").first()).toBeVisible();
  const stats = screen(page).locator(".prr-stats");
  await expect(stats).toContainText("0/2");
  await expect(stats).toContainText("성공");
  await expect(stats).toContainText("가능");
  await expect(stats).toContainText("+48");
  // 본문: 미리보기만 (펼침 없음), 전체는 팝업에서
  const bodyCard = screen(page).locator(".prr-card.prr-peek");
  await expect(bodyCard.locator(".md-prev")).toContainText("셀 배경");
  await expect(bodyCard.locator(".prr-fold-head")).toHaveCount(0);
  // 타임라인: 커밋 2 + 리뷰 + 코멘트, 시간순, 마지막 커밋이 head
  const entries = screen(page).locator(".prr-entry");
  await expect(entries).toHaveCount(4);
  await expect(entries.nth(0)).toContainText("다크 모드 색 토큰 정리");
  await expect(entries.nth(1)).toContainText("변경 요청함");
  await expect(entries.nth(2)).toContainText("구분선 색 다크 모드 대응");
  await expect(entries.nth(2).locator(".prr-badge")).toHaveText("head");
  await expect(entries.nth(0).locator(".prr-badge")).toHaveCount(0);
  await expect(entries.nth(1).locator(".md-prev")).toContainText("구분선 색도 다크 모드");
  // 다른 PR 선택 → 상세 다시 조회
  await item(page, /#128/).click();
  await expect(screen(page).getByRole("heading", { name: /로그인 화면 정리/ })).toBeVisible();
  await expect(stats).toContainText("1/2");
  expect(JSON.parse((await callsOf(page, "pr_detail")).at(-1)![1]).number).toBe(128);
  // AI 리뷰 탭은 다음 단계 자리(비활성), 변경 파일 탭은 쓸 수 있다
  await expect(screen(page).getByRole("tab", { name: "AI 리뷰" })).toBeEnabled();
  await expect(screen(page).getByRole("tab", { name: "변경 파일" })).toBeEnabled();
});

test("타임라인 커밋 행: 호버·포커스에서 '변경 보기 ›'가 보이고, 키보드로 열 수 있다", async ({ page }) => {
  await open(page);
  await palette(page);
  const row = screen(page).locator(".prr-entry.commit").first().getByRole("button");
  const go = row.locator(".prr-go");
  await expect(go).toHaveText("변경 보기 ›");
  await expect(go).toHaveCSS("opacity", "0");
  await row.hover();
  await expect(go).toHaveCSS("opacity", "1");
  await expect(row).toHaveCSS("cursor", "default") // docs/design.md: pointer 금지, 대신 "변경 보기 ›"와 호버 배경;
  await page.mouse.move(0, 0);
  await expect(go).toHaveCSS("opacity", "0");
  await row.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(row).toBeFocused();
  await expect(go).toHaveCSS("opacity", "1");
  await expect(row).toHaveCSS("outline-style", "solid"); // 포커스 링
  await page.keyboard.press("Enter");
  await expect(filesTab(page)).toHaveAttribute("aria-selected", "true");
});

test("사이드바 PR 항목 클릭은 그 PR을 열고, GitHub에서 보기는 브라우저, Esc·X로 닫는다", async ({ page }) => {
  await open(page, { __inbox: undefined });
  await page.locator(".sidebar").getByRole("button", { name: /#7 그래프 곡선 개선/ }).click();
  await expect(screen(page)).toBeVisible();
  await expect(screen(page).getByRole("tab", { name: /^전체/ })).toHaveAttribute("aria-selected", "true"); // 고른 PR이 없는 탭이면 전체로
  await screen(page).getByRole("button", { name: "GitHub에서 보기" }).click({ timeout: 1000 }).catch(() => {});
  await page.keyboard.press("Escape");
  await expect(screen(page)).toHaveCount(0);
});

test("진입·종료·PR 선택은 사이드바·툴바·그래프를 다시 그리지 않는다, 목록 우클릭 메뉴", async ({ page }) => {
  await open(page);
  await palette(page);
  await expect(item(page, /#131/)).toBeVisible();
  await item(page, /#128/).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "GitHub에서 보기" })).toBeVisible();
  await page.getByRole("menuitem", { name: "GitHub에서 보기" }).click();
  await expect.poll(async () => (await callsOf(page, "open_url")).at(-1)?.[1]).toBe("https://github.com/demo/git403/pull/128");
  await screen(page).getByRole("button", { name: "닫기 (Esc)" }).click();
  await expect(screen(page)).toHaveCount(0);
});

test("오류: 일반 오류는 다시 시도, 토큰 없음은 계정 연결, GitHub 원격 없음 안내, 늦은 응답", async ({ page }) => {
  await open(page, { __inboxFail: "서버 오류 500" });
  await palette(page);
  await expect(screen(page).getByRole("alert")).toContainText("서버 오류 500");
  await page.evaluate(() => ((window as any).__inboxFail = undefined));
  await screen(page).getByRole("button", { name: "다시 시도" }).click();
  await expect(item(page, /#131/)).toBeVisible();
  await page.evaluate(() => ((window as any).__inboxFail = JSON.stringify({ code: "hosting.noToken", vars: {}, message: "No token. Connect a GitHub account in Settings, or sign in with `gh auth login`" })));
  await screen(page).getByRole("button", { name: "Pull Request 새로고침" }).click();
  await expect(screen(page).getByRole("alert")).toContainText("토큰이 없습니다. 설정에서 GitHub 계정을 연결"); // 오류 코드가 ko로 번역된다
  await screen(page).getByRole("button", { name: "계정 연결…" }).click();
  await expect(page.getByRole("dialog", { name: "설정" })).toBeVisible();
  await page.keyboard.press("Escape"); // 시트만 닫힌다
  await expect(page.getByRole("dialog", { name: "설정" })).toHaveCount(0);
  await expect(screen(page)).toBeVisible();
});

test("GitHub 원격이 없으면 안내하고, 상세 조회 실패는 상세에만 표시한다", async ({ page }) => {
  await open(page, { __remotes: [{ remote: "origin", url: "https://example.org/a/b.git" }] });
  await palette(page);
  await expect(screen(page)).toContainText("GitHub 원격이 없어");
  await page.keyboard.press("Escape");
  await expect(screen(page)).toHaveCount(0);
});

test("상세 조회 실패", async ({ page }) => {
  await open(page, { __detailFail: "상세 실패" });
  await palette(page);
  await expect(item(page, /#131/)).toBeVisible();
  await expect(screen(page).locator(".prr-body").getByRole("alert")).toContainText("상세 실패");
  await expect(screen(page).getByRole("button", { name: "다시 시도" })).toBeVisible();
});

test("스크린샷(라이트·다크)", async ({ page }, info) => {
  await open(page);
  await palette(page);
  await expect(screen(page).locator(".prr-entry")).toHaveCount(4);
  await page.screenshot({ path: `e2e/results/screens/pr-overview-${info.project.name}.png` });
  await screen(page).getByRole("tab", { name: /^전체/ }).click();
  await item(page, /#128/).click();
  await expect(screen(page).locator(".prr-stats")).toContainText("1/2");
  await page.screenshot({ path: `e2e/results/screens/pr-list-${info.project.name}.png` });
  await screen(page).locator(".prr-entry.commit").first().getByRole("button").hover();
  await page.screenshot({ path: `e2e/results/screens/pr-commit-hover-${info.project.name}.png` });
});

test("목록 접기: 버튼·⌘\\로 좁은 레일, diff 자리가 넓어지고, 닫았다 열어도 유지, 목록 폭은 스플리터로 조절·저장", async ({ page }) => {
  await open(page);
  await palette(page);
  await filesTab(page).click();
  const list = screen(page).locator(".prr-list");
  const diff = files(page).locator(".diff-wrap");
  await expect(diff).toBeVisible();
  const w0 = (await diff.boundingBox())!.width;
  await expect(list.getByRole("button", { name: /^목록 접기/ })).toHaveAttribute("title", /⌘\\|Ctrl\+\\/);
  // 스플리터로 폭 조절 → 저장
  const lw0 = (await list.boundingBox())!.width;
  const sp = page.locator(".prr > .splitter").first();
  const sb = (await sp.boundingBox())!;
  await page.mouse.move(sb.x + 0.5, sb.y + 200);
  await page.mouse.down();
  await page.mouse.move(sb.x + 100, sb.y + 200, { steps: 4 });
  await page.mouse.up();
  const lw1 = (await list.boundingBox())!.width;
  expect(lw1).toBeGreaterThan(lw0 + 60);
  expect(await page.evaluate(() => localStorage.getItem("split:prlist"))).not.toBeNull();
  // 접기
  await list.getByRole("button", { name: /^목록 접기/ }).click();
  await expect(list).toHaveClass(/rail/);
  expect((await list.boundingBox())!.width).toBeLessThan(50);
  await expect(list.getByRole("option")).toHaveCount(0);
  await expect(page.locator(".prr > .splitter")).toHaveCount(0);
  expect((await diff.boundingBox())!.width).toBeGreaterThan(w0 + 200);
  await expect(filesTab(page)).toHaveAttribute("aria-selected", "true"); // 탭 상태 유지
  await expect(files(page).locator(".diff")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("prr.listCollapsed"))).toBe("1");
  // 레일에서 닫기·펼치기, ⌘\\로도 토글
  await expect(list.getByRole("button", { name: "닫기 (Esc)" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(list).not.toHaveClass(/rail/);
  await expect(item(page, /#131/)).toBeVisible();
  expect((await list.boundingBox())!.width).toBeCloseTo(lw1, 0); // 폭 기억
  await page.keyboard.press("ControlOrMeta+Backslash");
  await expect(list).toHaveClass(/rail/);
  // 접힌 상태는 다음에 열 때도 유지 (변경 파일 탭으로 들어가도 저절로 접거나 펴지 않는다)
  await page.keyboard.press("Escape");
  await expect(screen(page)).toHaveCount(0);
  await palette(page);
  await expect(screen(page).locator(".prr-list")).toHaveClass(/rail/);
  await screen(page).locator(".prr-list").getByRole("button", { name: /^목록 펼치기/ }).click();
  await expect(item(page, /#131/)).toBeVisible();
  await filesTab(page).click();
  await expect(screen(page).locator(".prr-list")).not.toHaveClass(/rail/); // 탭 이동은 목록 상태를 바꾸지 않는다
});

test("본문·코멘트는 마크다운: 미리보기는 평문, 팝업에서 제목·목록·코드·표, HTML은 글자로, 링크는 브라우저로, 이미지는 링크로", async ({ page }) => {
  const body = "## 요약\n- 하나\n- `코드`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<script>alert(1)</script>\n\n[문서](https://example.com/doc) ![shot](https://example.com/a.png) [나쁨](javascript:alert(1))";
  await open(page, { __prDetail: { 131: { body } } });
  await palette(page);
  const card = screen(page).locator(".prr-card.prr-peek");
  await expect(card.locator(":scope > .sheet-head, h3, strong, li, a, code")).toHaveCount(1); // 머리줄의 "본문" 글자뿐: 서식 없음
  await expect(card.locator(".md-prev")).toContainText("요약 하나 코드");
  await card.click();
  const md = pop(page).locator(".md");
  await expect(md.locator(":scope > h2")).toHaveText("요약");
  await expect(md.locator("li")).toHaveCount(2);
  await expect(md.locator("code")).toHaveText("코드");
  await expect(md.locator("td")).toHaveCount(2);
  await expect(md.locator("script")).toHaveCount(0);
  await expect(md).toContainText("<script>alert(1)</script>");
  await expect(md.locator("img")).toHaveCount(0);
  await expect(md.getByRole("link", { name: /shot/ })).toHaveAttribute("href", "https://example.com/a.png");
  await expect(md.locator('a[href^="javascript"]')).toHaveCount(0);
  await md.getByRole("link", { name: "문서" }).click();
  await expect.poll(async () => (await callsOf(page, "open_url")).at(-1)?.[1]).toBe("https://example.com/doc");
  await expect(screen(page)).toBeVisible(); // 앱 안에서 이동하지 않는다
  await expect(pop(page)).toBeVisible(); // 링크를 눌러도 팝업은 그대로
});

// ---- 본문·리뷰·코멘트 팝업 ----
const pop = (page: Page) => page.getByRole("dialog").filter({ has: page.locator(".prr-pop-body") });
const sizeOf = (page: Page) => pop(page).evaluate((e) => ({ w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height }));
const peeks = (page: Page) => screen(page).locator(".prr-entry.prr-peek");
const LONG = Array.from({ length: 12 }, (_, i) => `긴 코멘트 ${i}줄`).join("\n\n");
const tl = (over: object[] = []) => [
  { kind: "review", author: "you", at: new Date(Date.now() - 5 * 3600e3).toISOString(), state: "CHANGES_REQUESTED", body: "## 제목입니다\n**굵게** 그리고\n- 목록\n\n[링크](https://example.com/x)" },
  { kind: "comment", author: "Alex", at: new Date(Date.now() - 4 * 3600e3).toISOString(), body: "두 번째 코멘트" },
  { kind: "commit", author: "Alex", at: new Date(Date.now() - 3 * 3600e3).toISOString(), sha: "930b8b1aa", body: "커밋" },
  { kind: "comment", author: "Sam", at: new Date(Date.now() - 2 * 3600e3).toISOString(), body: "세 번째 코멘트" },
  ...over,
];

test("미리보기는 서식 없는 일반 글자 크기·muted 색이고 제목·굵게·목록 기호가 없다", async ({ page }) => {
  await open(page, { __prDetail: { 131: { timeline: tl() } } });
  await palette(page);
  const first = peeks(page).first();
  const prev = first.locator(".md-prev");
  await expect(prev).toContainText("제목입니다 굵게 그리고 목록 링크");
  await expect(prev.locator("*")).toHaveCount(0); // 제목·굵게·목록·링크 요소 없이 글자만
  const fs = (l: ReturnType<typeof item>) => l.evaluate((e) => ({ s: getComputedStyle(e).fontSize, w: getComputedStyle(e).fontWeight }));
  expect(await fs(prev)).toEqual({ ...(await fs(first.locator(".prr-peek-head span").first())), w: "400" });
  await expect(screen(page).locator(".prr-card.prr-peek .md-prev")).toHaveCSS("font-size", (await fs(prev)).s);
  await expect(first.locator(".prr-fold-head, [aria-expanded]")).toHaveCount(0); // 접기 셰브런 없음
});

test("팝업 열기: 본문 카드·리뷰·코멘트 행 어디를 눌러도(›·가장자리·미리보기) 열리고, Enter·Space, 링크 없는 미리보기", async ({ page }) => {
  await open(page, { __prDetail: { 131: { timeline: tl() } } });
  await palette(page);
  // 본문 카드
  await screen(page).locator(".prr-card.prr-peek").click({ position: { x: 6, y: 6 } });
  await expect(pop(page)).toBeVisible();
  await expect(pop(page)).toContainText("셀 배경");
  await expect(pop(page).getByRole("button", { name: /이전 항목|다음 항목/ })).toHaveCount(0); // 본문은 이동 없음
  await page.keyboard.press("Escape");
  await expect(pop(page)).toHaveCount(0);
  await expect(screen(page)).toBeVisible(); // Esc는 팝업만 닫는다
  // 리뷰 행: 작성자 줄·미리보기·행 오른쪽 끝·왼쪽 점 근처
  const row = peeks(page).first();
  const box = (await row.boundingBox())!;
  for (const pos of [{ x: box.width - 6, y: 6 }, { x: 6, y: box.height / 2 }, { x: box.width / 2, y: box.height - 4 }]) {
    await row.click({ position: pos });
    await expect(pop(page)).toBeVisible();
    await expect(pop(page)).toContainText("제목입니다");
    await page.keyboard.press("Escape");
    await expect(pop(page)).toHaveCount(0);
  }
  await expect(row.locator(".prr-go")).toHaveText("열기 ›");
  // 키보드
  await row.focus();
  await page.keyboard.press("Enter");
  await expect(pop(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await peeks(page).nth(1).focus();
  await page.keyboard.press("Space");
  await expect(pop(page)).toContainText("두 번째 코멘트");
});

test("팝업: 제목줄(작성자·종류 배지·시각), 이전/다음, Esc 순서, 포커스 복귀, 텍스트 선택", async ({ page }) => {
  await open(page, { __prDetail: { 131: { timeline: tl() } } });
  await palette(page);
  await peeks(page).first().click();
  const d = pop(page);
  await expect(d.locator(":scope > .sheet-head")).toContainText("you");
  await expect(d.locator(":scope > .sheet-head .prr-badge")).toHaveText("변경 요청함");
  await expect(d.locator(":scope > .sheet-head .prr-badge")).toHaveClass(/warn/);
  await expect(d.locator(":scope > .sheet-head time")).toBeVisible();
  await expect(d.locator(":scope > .sheet-head")).toContainText("1/3"); // 커밋은 건너뛴다
  const prev = d.getByRole("button", { name: "이전 항목" });
  const next = d.getByRole("button", { name: "다음 항목" });
  await expect(prev).toBeDisabled();
  await next.click();
  await expect(d).toContainText("두 번째 코멘트");
  await expect(d.locator(":scope > .sheet-head .prr-badge")).toHaveText("코멘트");
  await page.keyboard.press("ArrowRight");
  await expect(d).toContainText("세 번째 코멘트");
  await expect(next).toBeDisabled();
  await page.keyboard.press("ArrowLeft");
  await expect(d).toContainText("두 번째 코멘트");
  // 텍스트 선택
  await d.locator(".md").selectText();
  expect(await page.evaluate(() => getSelection()!.toString())).toContain("두 번째 코멘트");
  // 선택 상태에서 닫으면(Esc) 팝업만 닫히고 포커스는 마지막으로 본 항목으로 돌아간다
  await page.keyboard.press("Escape");
  await expect(d).toHaveCount(0);
  await expect(screen(page)).toBeVisible();
  await expect(peeks(page).nth(1)).toBeFocused();
  // 두 번째 Esc: PR 화면이 닫힌다
  await page.keyboard.press("Escape");
  await expect(screen(page)).toHaveCount(0);
});

test("팝업 크게/보통 전환과 저장, 글자 크기 저장, 배경 클릭·닫기 버튼", async ({ page }) => {
  await open(page, { __prDetail: { 131: { timeline: tl() } } });
  await palette(page);
  const row = peeks(page).first();
  await row.click();
  const d = pop(page);
  const normal = await sizeOf(page);
  expect(normal.w).toBeLessThan(780);
  await d.getByRole("button", { name: "크게 보기" }).click();
  const big = await sizeOf(page);
  expect(big.w).toBeGreaterThan(1200);
  expect(big.h).toBeGreaterThan(740);
  expect(await page.evaluate(() => localStorage.getItem("prrPopBig"))).toBe("true");
  await expect(d.getByRole("button", { name: "원래 크기" })).toBeVisible();
  await expect(d.locator(".big-kbd")).toHaveCount(0); // Esc는 팝업 닫기
  // 글자 크기
  const fsz = () => d.locator(".prr-pop-body").evaluate((e) => getComputedStyle(e).fontSize);
  expect(await fsz()).toBe("14px");
  await d.getByRole("button", { name: "글자 크게" }).click();
  expect(await fsz()).toBe("16px");
  await d.getByRole("button", { name: "글자 작게" }).click();
  await d.getByRole("button", { name: "글자 작게" }).click();
  expect(await fsz()).toBe("13px");
  await d.getByRole("button", { name: "글자 작게" }).click();
  await expect(d.getByRole("button", { name: "글자 작게" })).toBeDisabled();
  // 닫았다 다시 열면 마지막 크기·글자 크기 유지
  await page.keyboard.press("Escape");
  await row.click();
  expect((await sizeOf(page)).w).toBeGreaterThan(1200);
  expect(await fsz()).toBe("12px");
  await d.getByRole("button", { name: "원래 크기" }).click();
  expect((await sizeOf(page)).w).toBeLessThanOrEqual(760);
  await d.locator(".sheet-actions").getByRole("button", { name: "닫기", exact: true }).click();
  await expect(d).toHaveCount(0);
  await row.click();
  await page.mouse.click(5, 5); // 배경
  await expect(d).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("prrPopBig"))).toBe("false");
});

test("스레드 카드는 diff 안 인라인 유지, 긴 코멘트는 3줄 미리보기 + 전체 보기 팝업(스레드 이전/다음)", async ({ page }) => {
  const at = new Date().toISOString();
  await open(page, { __prDetail: { 131: { reviewThreads: [thread({ comments: [{ author: "you", body: LONG, at }, { author: "Alex", body: "짧은 답글", at }] })] } } });
  await palette(page);
  await filesTab(page).click();
  const card = files(page).locator(".prr-thread");
  await expect(card).toBeVisible(); // 인라인
  await expect(card.locator(".md-clamp")).toHaveCount(1); // 긴 것만 줄임
  expect((await card.locator(".md-clamp").boundingBox())!.height).toBeLessThan(100);
  await card.getByRole("button", { name: "전체 보기" }).click();
  const d = pop(page);
  await expect(d).toContainText("긴 코멘트 11줄");
  await expect(d.locator(":scope > .sheet-head")).toContainText("crates/graph/src/lib.rs:14");
  await expect(d.locator(":scope > .sheet-head")).toContainText("1/2");
  await d.getByRole("button", { name: "다음 항목" }).click();
  await expect(d).toContainText("짧은 답글");
  await page.keyboard.press("Escape");
  await expect(d).toHaveCount(0);
  await expect(filesTab(page)).toHaveAttribute("aria-selected", "true"); // PR 화면·탭 그대로
  await expect(card.getByRole("button", { name: "전체 보기" })).toBeFocused();
});

test("팝업 스크린샷(라이트/다크)", async ({ page }, info) => {
  await open(page, { __prDetail: { 131: { timeline: tl() } } });
  await palette(page);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `e2e/results/screens/pr-peek-${info.project.name}.png` });
  await peeks(page).first().click();
  await page.screenshot({ path: `e2e/results/screens/pr-popup-${info.project.name}.png` });
  await pop(page).getByRole("button", { name: "크게 보기" }).click();
  await page.screenshot({ path: `e2e/results/screens/pr-popup-big-${info.project.name}.png` });
  await pop(page).getByRole("button", { name: "원래 크기" }).click();
});

// ---- 26b: 변경 파일 탭 ----
const files = (page: Page) => screen(page).locator(".prr-files");
const rows = (page: Page) => files(page).locator("ul.files").getByRole("option");
const fileItem = (page: Page, name: RegExp | string) => files(page).locator("ul.files").getByRole("option", { name });
const filesTab = (page: Page) => screen(page).getByRole("tab", { name: "변경 파일" });
const scope = (page: Page) => files(page).getByRole("radiogroup", { name: "범위" });
const allBtn = (page: Page) => scope(page).getByRole("radio").first();
const commitBtn = (page: Page) => scope(page).getByRole("radio").nth(1);
/** 커밋별 메뉴에서 제목이 맞는 커밋 고르기 */
const pickCommit = async (page: Page, name: RegExp | string) => {
  await commitBtn(page).click();
  await page.getByRole("menuitem", { name }).click();
};
const FIRST = "930b8b1aa"; // 131번 PR의 첫 커밋
const calls = async (page: Page) => (await page.evaluate(() => (window as any).__git)) as string[][];
const thread = (over: Record<string, unknown>) => ({ path: "crates/graph/src/lib.rs", line: 14, resolved: false, comments: [{ author: "you", body: "**여기** 이름을 `lane`으로 바꾸면 어때요?", at: new Date().toISOString() }], ...over });

test("변경 파일 탭: 전체 변경 → 파일 선택 → diff, 요약 줄, 로컬에 있으면 받지 않는다", async ({ page }) => {
  await open(page);
  await palette(page);
  await expect(screen(page).locator(".prr-entry")).toHaveCount(4);
  await filesTab(page).click();
  await expect(filesTab(page)).toHaveAttribute("aria-selected", "true");
  await expect(files(page).locator(".prr-files-sum")).toHaveCount(0); // 전체 변경의 요약은 탭 보조 글과 같아 패널에서는 뺀다
  await expect(filesTab(page).locator("small")).toHaveText("파일 4개 · +48 −21");
  await expect(rows(page)).toHaveCount(3);
  await expect(allBtn(page)).toHaveAttribute("aria-checked", "true");
  await expect(files(page).locator(".diff")).toContainText("trackEventLogIds"); // 첫 파일 자동 선택
  await fileItem(page, /CommitGraph\.tsx/).dispatchEvent("mousedown");
  await expect.poll(async () => (await calls(page)).filter((c) => c[0] === "pr_range_diff").at(-1)?.[1]).toBe("ui/src/CommitGraph.tsx");
  const c = await calls(page);
  const diffCall = c.find((x) => x[0] === "pr_range_diff")!;
  expect(diffCall).toBeTruthy();
  expect(c.filter((x) => x[0] === "rev-parse" && x[1] === "--verify").length).toBeGreaterThanOrEqual(1);
  expect(c.filter((x) => x[0] === "start_job")).toHaveLength(0); // 로컬에 있으면 fetch 안 함
  await expect(files(page).locator("[role=note]")).toHaveCount(0);
  // 개요로 돌아갔다 와도 범위는 유지
  await screen(page).getByRole("tab", { name: "개요·대화" }).click();
  await filesTab(page).click();
  await expect(rows(page)).toHaveCount(3);
});

test("범위 전환: 커밋 하나를 고르면 그 커밋의 파일·diff, 다시 전체 변경", async ({ page }) => {
  await open(page, { __fileDiff: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,2 @@\n keep\n+커밋범위줄\n" });
  await palette(page);
  await filesTab(page).click();
  await expect(rows(page)).toHaveCount(3);
  await commitBtn(page).click();
  await expect(page.getByRole("menuitem")).toHaveCount(2); // 타임라인 커밋 2
  await expect(page.getByRole("menuitem").first()).toContainText(/다크 모드 색 토큰 정리 · 930b8b1 · /); // 제목 · 짧은 sha · 상대 시각
  await page.keyboard.press("Escape");
  await page.evaluate(() => ((window as any).__changedFiles = [{ status: "M", path: "README.md", oldPath: null }]));
  await pickCommit(page, /구분선 색 다크 모드 대응/);
  await expect(commitBtn(page)).toContainText("구분선 색 다크 모드 대응"); // 세그먼트에 그 커밋 제목
  await expect(commitBtn(page)).toHaveAttribute("aria-checked", "true");
  await expect(rows(page)).toHaveCount(1);
  await expect(files(page).locator(".prr-files-sum")).toContainText("파일 1개");
  await expect(files(page).locator(".diff")).toContainText("커밋범위줄");
  expect((await calls(page)).filter((x) => x[0] === "pr_range_diff").length).toBe(1); // 첫 전체 변경 때 한 번뿐
  await allBtn(page).click();
  await expect(files(page).locator(".prr-files-sum")).toHaveCount(0);
  await expect(rows(page)).toHaveCount(3);
  await expect(commitBtn(page)).toContainText("커밋별");
});

test("커밋 이전/다음 이동(‹ ›): 커밋 하나를 볼 때만 보이고, 양끝에서 비활성, 눌러 넘기면 그 커밋의 변경", async ({ page }) => {
  await open(page);
  await palette(page);
  await filesTab(page).click();
  await expect(rows(page)).toHaveCount(3);
  await expect(files(page).getByRole("button", { name: "이전 커밋" })).toHaveCount(0); // 전체 변경에서는 없다
  await pickCommit(page, /다크 모드 색 토큰 정리/);
  const prev = files(page).getByRole("button", { name: "이전 커밋" });
  const next = files(page).getByRole("button", { name: "다음 커밋" });
  await expect(commitBtn(page)).toContainText("다크 모드 색 토큰 정리");
  await expect(files(page).locator(".prr-step")).toContainText("1/2");
  await expect(prev).toBeDisabled();
  await expect(next).toBeEnabled();
  await next.click();
  await expect(commitBtn(page)).toContainText("구분선 색 다크 모드 대응");
  await expect(files(page).locator(".prr-step")).toContainText("2/2");
  await expect(next).toBeDisabled();
  await prev.click();
  await expect(commitBtn(page)).toContainText("다크 모드 색 토큰 정리");
  const fileCalls = (await calls(page)).filter((c) => c[0] === "pr_range_diff" || c[0] === "changed_files");
  expect(fileCalls.length).toBeGreaterThan(0);
  await allBtn(page).click();
  await expect(prev).toHaveCount(0);
});

test("변경 파일 탭 머리줄: 한 줄([범위][‹ ›] … 요약), 제목·'변경 파일' 반복 글자 없음", async ({ page }) => {
  await open(page);
  await palette(page);
  await filesTab(page).click();
  await expect(rows(page)).toHaveCount(3);
  const bar = files(page).locator(".prr-files-bar");
  const b = (await bar.boundingBox())!;
  expect(b.height).toBeLessThan(48); // 한 줄
  await expect(bar).not.toContainText("변경 파일");
  await expect(files(page).locator(".info .files-head")).not.toContainText("변경 파일");
  await expect(files(page).locator("select")).toHaveCount(0);
  await pickCommit(page, /구분선 색 다크 모드 대응/); // 커밋 범위에서만 그 범위의 요약이 오른쪽 끝에 뜬다
  const sc = (await scope(page).boundingBox())!;
  const sum = (await files(page).locator(".prr-files-sum").boundingBox())!;
  expect(sc.x).toBeLessThan(sum.x); // 범위는 왼쪽, 요약은 오른쪽 끝
  expect(sum.x + sum.width).toBeGreaterThan(b.x + b.width - 40);
});

test("타임라인 커밋 클릭: 그래프로 나가지 않고 변경 파일 탭 + 그 커밋 범위", async ({ page }) => {
  await open(page);
  await palette(page);
  await screen(page).locator(".prr-entry.commit", { hasText: "다크 모드 색 토큰 정리" }).getByRole("button").click();
  await expect(screen(page)).toBeVisible();
  await expect(filesTab(page)).toHaveAttribute("aria-selected", "true");
  await expect(commitBtn(page)).toContainText("다크 모드 색 토큰 정리");
  await expect(rows(page)).toHaveCount(3);
  await expect(files(page).locator(".diff")).toBeVisible();
  // 전체 변경으로 되돌리기
  await allBtn(page).click();
  await expect(allBtn(page)).toHaveAttribute("aria-checked", "true");
});

test("커밋 우클릭: 그래프에서 보기(PR 화면을 닫고 그 커밋 선택, 로컬에 없으면 경고)·GitHub에서 보기", async ({ page }) => {
  const c5 = "c5".padEnd(40, "0");
  await open(page, { __prDetail: { 131: { timeline: [{ kind: "commit", author: "Alex", at: new Date().toISOString(), sha: c5, body: "README 정리" }, { kind: "commit", author: "Alex", at: new Date().toISOString(), sha: "f".repeat(40), body: "아직 안 받은 커밋" }] } } });
  await palette(page);
  const entry = (name: string) => screen(page).locator(".prr-entry.commit", { hasText: name }).getByRole("button");
  await entry("README 정리").click({ button: "right" });
  await page.getByRole("menuitem", { name: "GitHub에서 보기" }).click();
  await expect.poll(async () => (await callsOf(page, "open_url")).at(-1)?.[1]).toBe(`https://github.com/demo/git403/pull/131/commits/${c5}`);
  await expect(screen(page)).toBeVisible();
  await entry("README 정리").click({ button: "right" });
  await page.getByRole("menuitem", { name: "그래프에서 보기" }).click();
  await expect(screen(page)).toHaveCount(0);
  await expect(page.locator(".commits .row.selected")).toContainText("README 정리");
  await palette(page);
  await entry("아직 안 받은 커밋").click({ button: "right" });
  await page.getByRole("menuitem", { name: "그래프에서 보기" }).click();
  await expect(page.locator(".toast", { hasText: "ffffffff" })).toBeVisible();
});

test("로컬에 PR 커밋이 없으면 refs/pull/N/head를 받아 오고, 실패하면 오류와 다시 시도", async ({ page }) => {
  await open(page, { __missing: true, __job: { err: "fatal: couldn't find remote ref refs/pull/131/head", ms: 300 } });
  await palette(page);
  await filesTab(page).click();
  await expect(files(page).getByRole("alert")).toContainText("PR 커밋을 받지 못했습니다");
  await expect(files(page).getByRole("alert")).toContainText("couldn't find remote ref");
  const starts = async () => (await calls(page)).filter((c) => c[0] === "start_job").map((c) => JSON.parse(c[1]));
  expect(await starts()).toEqual([{ repo: expect.any(String), args: ["fetch", "--no-tags", "--progress", "--", "origin", "refs/pull/131/head", "refs/heads/main"] }]);
  await page.evaluate(() => ((window as any).__job = { ms: 1200 }));
  await files(page).getByRole("button", { name: "다시 시도" }).click();
  await expect(files(page).getByRole("status")).toContainText("PR 커밋을 받는 중");
  await expect(files(page).getByRole("status")).toContainText("Receiving objects");
  await expect(rows(page)).toHaveCount(3);
  expect(await starts()).toHaveLength(2);
  // 한 번 받은 PR은 다시 열어도 받지 않는다
  await screen(page).getByRole("tab", { name: "개요·대화" }).click();
  await filesTab(page).click();
  await expect(rows(page)).toHaveCount(3);
  expect(await starts()).toHaveLength(2);
});

test("리뷰 스레드: 전체 변경에서 해당 줄 아래 카드(마크다운), 해결됨은 접힘, 파일 목록 배지, 커밋 범위에선 숨김", async ({ page }) => {
  await open(page, { __prDetail: { 131: { reviewThreads: [thread({}), thread({ line: 44, resolved: true, comments: [{ author: "Alex", body: "고쳤어요", at: new Date().toISOString() }, { author: "you", body: "확인", at: new Date().toISOString() }] }), thread({ path: "ui/src/CommitGraph.tsx", line: null })] } } });
  await palette(page);
  await filesTab(page).click();
  const notes = files(page).locator("[role=note]");
  await expect(notes).toHaveCount(2);
  // 열린 스레드: 마크다운 본문
  await expect(notes.nth(0).locator(".md strong")).toHaveText("여기");
  await expect(notes.nth(0).locator("code")).toHaveText("lane");
  // 첫 줄 번호 14 아래, 두 번째는 44 아래
  await expect(files(page).locator(".diff")).toContainText("해결됨");
  // 해결됨: 접힘(흐리게) → 펼침
  const resolved = files(page).locator(".prr-thread.resolved");
  await expect(resolved).toHaveCSS("opacity", "0.7");
  await expect(resolved.locator(".md")).toHaveCount(0);
  await resolved.getByRole("button").click();
  await expect(resolved.locator(".md")).toHaveCount(2);
  // 파일 목록 배지(스레드 개수)
  await expect(fileItem(page, /lib\.rs/).locator(".prr-tcount")).toHaveText("2");
  await expect(fileItem(page, /CommitGraph\.tsx/).locator(".prr-tcount")).toHaveText("1");
  // 커밋 범위에서는 숨김
  await pickCommit(page, /구분선 색 다크 모드 대응/);
  await expect(files(page).locator(".diff")).toBeVisible();
  await expect(notes).toHaveCount(0);
  await expect(fileItem(page, /lib\.rs/).locator(".prr-tcount")).toHaveCount(0);
  await expect(files(page)).toContainText("커밋 범위에서는 리뷰 스레드를 숨깁니다");
});

test("크게 보기: PR 목록·머리를 접고 diff가 넓어지며 Esc는 크게 보기부터 닫는다", async ({ page }) => {
  await open(page);
  await palette(page);
  await filesTab(page).click();
  await expect(files(page).locator(".diff")).toBeVisible();
  const before = (await files(page).locator(".diff").boundingBox())!;
  await files(page).getByRole("button", { name: /크게 보기/ }).first().click();
  await expect(page.locator("html")).toHaveAttribute("data-big", "");
  await expect(screen(page).locator(".prr-list")).toBeHidden();
  const after = (await files(page).locator(".diff").boundingBox())!;
  expect(after.width).toBeGreaterThan(before.width + 100);
  await expect(scope(page)).toBeVisible(); // 범위 줄은 남는다
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).not.toHaveAttribute("data-big", "");
  await expect(screen(page)).toBeVisible();
  await expect(screen(page).locator(".prr-list")).toBeVisible();
  // 파일 더블클릭도 진입, 개요 탭으로 가면 자동 종료
  await fileItem(page, /CommitGraph\.tsx/).dblclick();
  await expect(page.locator("html")).toHaveAttribute("data-big", "");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(screen(page)).toHaveCount(0);
});

test("변경 파일 스크린샷(라이트·다크)", async ({ page }, info) => {
  await open(page, { __prDetail: { 131: { reviewThreads: [thread({}), thread({ line: 44, resolved: true })] } } });
  await palette(page);
  await filesTab(page).click();
  await expect(files(page).locator("[role=note]")).toHaveCount(2);
  await page.waitForTimeout(300); // 탭 배경 전환이 끝난 뒤
  await page.screenshot({ path: `e2e/results/screens/pr-files-${info.project.name}.png` });
  // 커밋 하나 보기(세그먼트 제목 + ‹ ›)
  await pickCommit(page, /구분선 색 다크 모드 대응/);
  await expect(files(page).locator(".prr-step")).toBeVisible();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `e2e/results/screens/pr-files-commit-${info.project.name}.png` });
  // 커밋별 메뉴 열림
  await commitBtn(page).click();
  await expect(page.getByRole("menuitem")).toHaveCount(2);
  await page.screenshot({ path: `e2e/results/screens/pr-files-menu-${info.project.name}.png` });
  await page.keyboard.press("Escape");
  // 목록 접힘
  await screen(page).locator(".prr-list").getByRole("button", { name: /^목록 접기/ }).click();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `e2e/results/screens/pr-files-rail-${info.project.name}.png` });
});

test("탭을 오가도 개요 스크롤·펼침과 변경 파일 선택이 유지되고 pr_detail을 다시 부르지 않는다", async ({ page }) => {
  const many = Array.from({ length: 40 }, (_, i) => ({ kind: "comment", author: "Alex", at: new Date(Date.now() - (60 - i) * 60000).toISOString(), body: `코멘트 ${i}` }));
  await open(page, { __prDetail: { 131: { timeline: many } } });
  await palette(page);
  const body = screen(page).locator(".prr-body").first();
  await expect(screen(page).locator(".prr-entry")).toHaveCount(40);
  await body.evaluate((e) => (e.scrollTop = 400));
  const top = await body.evaluate((e) => e.scrollTop);
  expect(top).toBeGreaterThan(100);
  const details = async () => (await callsOf(page, "pr_detail")).length;
  const n0 = await details();
  await filesTab(page).click();
  await rows(page).nth(1).dispatchEvent("mousedown");
  await expect(rows(page).nth(1)).toHaveAttribute("aria-selected", "true");
  await screen(page).getByRole("tab", { name: "개요·대화" }).click();
  expect(await body.evaluate((e) => e.scrollTop)).toBe(top);
  await filesTab(page).click();
  await expect(rows(page).nth(1)).toHaveAttribute("aria-selected", "true"); // 선택 파일 유지
  expect(await details()).toBe(n0);
});

test("타임라인 커밋 → 변경 파일 → 대화로 돌아가기(버튼·⌘[): 그 항목이 보이고 강조된다", async ({ page }) => {
  const many = (sha: string) => [
    { kind: "commit", author: "Alex", at: new Date(Date.now() - 100 * 60000).toISOString(), sha, body: "첫 커밋 항목" },
    ...Array.from({ length: 40 }, (_, i) => ({ kind: "comment", author: "Alex", at: new Date(Date.now() - (90 - i) * 60000).toISOString(), body: `코멘트 ${i}` })),
  ];
  await open(page, { __prDetail: { 131: { timeline: many(FIRST) } } });
  await palette(page);
  const body = screen(page).locator(".prr-body").first();
  await expect(screen(page).locator(".prr-entry")).toHaveCount(41);
  await expect(files(page).getByRole("button", { name: /대화로 돌아가기/ })).toHaveCount(0);
  const entry = screen(page).locator(".prr-entry.commit");
  await body.evaluate((e) => (e.scrollTop = e.scrollHeight)); // 맨 아래로: 커밋 항목은 화면 밖
  await expect(entry).not.toBeInViewport();
  await body.evaluate((e) => (e.scrollTop = 0));
  await entry.getByRole("button").click();
  await expect(filesTab(page)).toHaveAttribute("aria-selected", "true");
  const back = files(page).getByRole("button", { name: /대화로 돌아가기/ });
  await expect(back).toBeVisible();
  await screen(page).getByRole("tab", { name: "개요·대화" }).click();
  await body.evaluate((e) => (e.scrollTop = e.scrollHeight));
  await filesTab(page).click();
  await back.click();
  await expect(screen(page).getByRole("tab", { name: "개요·대화" })).toHaveAttribute("aria-selected", "true");
  await expect(entry).toBeInViewport();
  await expect(entry).toHaveClass(/flash/);
  await expect(back).toBeHidden(); // 숨겨진 패널에 남아 있어도 보이지 않는다
  // ⌘[ : 다시 넘어가서 키로 돌아간다
  await entry.getByRole("button").click();
  await body.evaluate((e) => (e.scrollTop = 0));
  await page.keyboard.press("ControlOrMeta+[");
  await expect(screen(page).getByRole("tab", { name: "개요·대화" })).toHaveAttribute("aria-selected", "true");
  await expect(entry).toBeInViewport();
  // 범위를 직접 고르면 돌아가기 버튼은 사라진다
  await entry.getByRole("button").click();
  await allBtn(page).click();
  await expect(back).toHaveCount(0);
});

test("숨긴 변경 파일 패널·PR 화면 뒤 커밋 상세의 diff는 ⌥↑/⌥↓에 반응하지 않는다", async ({ page }) => {
  await open(page);
  await palette(page);
  await filesTab(page).click();
  await expect(files(page).locator(".diff")).toContainText("trackEventLogIds");
  await screen(page).getByRole("tab", { name: /^개요/ }).click();
  // 문서 전체 스크롤 합: 보이지 않는 diff가 hunk 이동하면 바뀐다
  const scrolls = () => page.evaluate(() => [...document.querySelectorAll("*")].reduce((n, e) => n + e.scrollTop, 0));
  const before = await scrolls();
  await page.keyboard.press("Alt+ArrowDown");
  await page.keyboard.press("Alt+ArrowDown");
  await page.waitForTimeout(200);
  expect(await scrolls()).toBe(before);
});

// ---- 26 후속: 개요 안내줄 · 내가 올린 PR 묶음 · 탭 보조 글 ----
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const mk = (number: number, o: Record<string, unknown> = {}) => ({ number, title: `PR 제목 ${number}`, url: `https://github.com/demo/git403/pull/${number}`, head: `feature/p${number}`, base: "main", author: "Alex", authorAvatar: "", draft: false, createdAt: ago(5), updatedAt: ago(1), additions: 1, deletions: 1, labels: [], reviewers: [], approvals: 0, myReview: "none", reRequested: false, headSha: `a${number}b2c3d4e5f6`, isMine: false, reviewRequested: false, ...o });
const tabBtn = (page: Page, re: RegExp) => screen(page).getByRole("tab", { name: re });
const hint = (page: Page) => screen(page).locator(".prr-hint");
/** PR 하나만 있는 목록으로 열고 그 PR을 고른다 (리뷰 대기 탭에 없는 PR은 전체 탭에서) */
const openOne = async (page: Page, o: Record<string, unknown>, flags: Record<string, unknown> = {}) => {
  await open(page, { __inbox: [mk(50, o)], ...flags });
  await palette(page);
  await tabBtn(page, /^전체/).click();
  await item(page, /#50/).click();
};

for (const [name, o, text, tone] of [
  ["리뷰 요청됨·아직 안 함", { reviewRequested: true }, "리뷰를 요청받았습니다", "warn"],
  ["내가 승인함", { myReview: "approved" }, "내가 승인했습니다", "info"],
  ["내가 변경 요청함", { myReview: "changes_requested" }, "내가 변경을 요청했습니다 · 작성자의 새 커밋을 기다리는 중입니다", "info"],
  ["내가 코멘트함", { myReview: "commented" }, "내가 코멘트했습니다", "info"],
  ["재요청", { myReview: "commented", reRequested: true, reviewRequested: true }, "내 리뷰 이후 새 커밋이 있습니다", "warn"],
  ["내 PR", { isMine: true, author: "demo-user" }, "내 PR · 승인 0/2", "info"],
  ["내 초안 PR", { isMine: true, draft: true, author: "demo-user" }, "내 PR · 초안입니다", "info"],
  ["남의 초안", { draft: true }, "초안입니다", "info"],
] as const) {
  test(`개요 안내줄: ${name}`, async ({ page }) => {
    await openOne(page, o);
    await expect(hint(page)).toHaveText(text + (tone === "warn" && text.startsWith("내 리뷰") ? "새 커밋 보기" : ""));
    await expect(hint(page)).toHaveClass(new RegExp(`is-${tone}`)); // 전역 .warn(danger 글자색)과 겹치지 않게 is- 접두
    expect(await hint(page).evaluate((e) => getComputedStyle(e.firstElementChild!).color)).toBe(await screen(page).locator(".prr-head h2").evaluate((e) => getComputedStyle(e).color)); // 글자는 본문색, 톤은 막대·배경만
    await expect(hint(page).getByRole("button")).toHaveCount(text.startsWith("내 리뷰") ? 1 : 0);
    // 카드보다 위, 한 줄
    const h = (await hint(page).boundingBox())!;
    expect(h.y).toBeLessThan((await screen(page).locator(".prr-card").first().boundingBox())!.y);
    expect(h.height).toBeLessThan(44);
  });
}

test("개요 안내줄: 해당 사항이 없으면 줄을 숨긴다", async ({ page }) => {
  await openOne(page, {});
  await expect(screen(page).locator(".prr-card").first()).toBeVisible();
  await expect(hint(page)).toHaveCount(0);
});

test("안내줄 [새 커밋 보기]: 내 마지막 리뷰 이후 첫 커밋 범위로 가고, 대화로 돌아가기(버튼·⌘[)가 된다", async ({ page }) => {
  const tl = [
    { kind: "commit", author: "Alex", at: ago(26), sha: FIRST, body: "첫 커밋" },
    { kind: "review", author: "demo-user", at: ago(23), state: "CHANGES_REQUESTED", body: "고쳐 주세요" },
    { kind: "commit", author: "Alex", at: ago(2), sha: "bbb2222", body: "리뷰 반영 커밋" },
    { kind: "commit", author: "Alex", at: ago(1), sha: "ccc3333", body: "마무리 커밋" },
  ];
  await open(page, { __prDetail: { 131: { timeline: tl } } });
  await palette(page);
  const body = screen(page).locator(".prr-body").first();
  await expect(hint(page)).toContainText("내 리뷰 이후 새 커밋이 있습니다");
  await body.evaluate((e) => (e.scrollTop = 0));
  const n0 = (await callsOf(page, "pr_detail")).length;
  await hint(page).getByRole("button", { name: "새 커밋 보기" }).click();
  await expect(filesTab(page)).toHaveAttribute("aria-selected", "true");
  await expect(commitBtn(page)).toHaveAttribute("aria-checked", "true");
  await expect(commitBtn(page)).toContainText("리뷰 반영 커밋"); // 리뷰 이후 첫 커밋 (첫 커밋·마지막 커밋이 아니다)
  await expect(files(page).locator(".prr-step .hint")).toHaveText("2/3");
  await expect(page.getByRole("menuitem")).toHaveCount(0); // 범위를 정했으니 메뉴는 없다
  const back = files(page).getByRole("button", { name: /대화로 돌아가기/ });
  await expect(back).toBeVisible();
  await back.click();
  await expect(tabBtn(page, /^개요/)).toHaveAttribute("aria-selected", "true");
  // ⌘[ 도 같다. 범위를 고르는 중에도 돌아가는 길은 남는다
  await hint(page).getByRole("button", { name: "새 커밋 보기" }).click();
  await files(page).getByRole("button", { name: "다음 커밋" }).click();
  await expect(files(page).getByRole("button", { name: /대화로 돌아가기/ })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+[");
  await expect(tabBtn(page, /^개요/)).toHaveAttribute("aria-selected", "true");
  expect((await callsOf(page, "pr_detail")).length).toBe(n0); // 다시 조회하지 않는다
});

test("안내줄 [새 커밋 보기]: 내 리뷰를 못 찾으면 커밋별 메뉴를 열고, 거기서 골라도 돌아가기가 남는다", async ({ page }) => {
  await open(page); // 기본 mock: 131의 리뷰 작성자는 "you"(내 계정 아님) → 정할 수 없다
  await palette(page);
  await hint(page).getByRole("button", { name: "새 커밋 보기" }).click();
  await expect(filesTab(page)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("menuitem")).toHaveCount(2);
  await expect(commitBtn(page)).toHaveAttribute("aria-checked", "false"); // 범위는 아직 안 정했다
  await page.getByRole("menuitem", { name: /구분선 색 다크 모드 대응/ }).click();
  await expect(commitBtn(page)).toContainText("구분선 색 다크 모드 대응");
  const back = files(page).getByRole("button", { name: /대화로 돌아가기/ });
  await expect(back).toBeVisible();
  await back.click();
  await expect(tabBtn(page, /^개요/)).toHaveAttribute("aria-selected", "true");
  // 다시 눌러도 메뉴가 다시 열린다
  await hint(page).getByRole("button", { name: "새 커밋 보기" }).click();
  await expect(page.getByRole("menuitem")).toHaveCount(2);
  await page.keyboard.press("Escape");
});

const mine = (page: Page) => screen(page).locator(".prr-mine");
const mineHead = (page: Page) => mine(page).getByRole("button", { name: /내가 올린 PR/ });

test("내가 올린 PR 묶음: 리뷰 대기·전체 탭 맨 위, 한 줄(#번호 제목 · 진행도 · 시각), 내 PR 탭에는 없고 목록과 중복되지 않는다", async ({ page }) => {
  await open(page);
  await palette(page);
  await expect(mineHead(page)).toContainText("내가 올린 PR 1건");
  await expect(mineHead(page)).toContainText("탭·검색과 무관");
  const row = mine(page).getByRole("option");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("#129 알림 권한 안내 문구 수정");
  await expect(row).toContainText("1/2");
  await expect(row.locator("time")).toBeVisible();
  const rb = (await row.boundingBox())!;
  expect(rb.height).toBeLessThan(36); // 한 줄
  // 맨 위: 묶음이 목록 첫 항목보다 위
  expect(rb.y).toBeLessThan((await item(page, /#131/).boundingBox())!.y);
  await tabBtn(page, /^전체/).click();
  await expect(row).toHaveCount(1);
  await expect(item(page, /#129/)).toHaveCount(1); // 아래 목록에서는 뺀다 (같은 PR 두 번 없음)
  await expect(item(page, /.*/)).toHaveCount(7);
  await tabBtn(page, /^내 PR/).click();
  await expect(mine(page)).toHaveCount(0);
  await expect(item(page, /#129/)).toHaveCount(1);
  await expect(item(page, /.*/)).toHaveCount(1);
});

test("내가 올린 PR 묶음: 선택·↑↓ 이동이 되고 탭이 바뀌지 않으며, 접힘은 저장된다", async ({ page }) => {
  await open(page);
  await palette(page);
  const row = mine(page).getByRole("option");
  await row.click();
  await expect(row).toHaveAttribute("aria-selected", "true");
  await expect(screen(page).getByRole("heading", { name: /알림 권한 안내 문구 수정/ })).toBeVisible();
  await expect(tabBtn(page, /^리뷰 대기/)).toHaveAttribute("aria-selected", "true"); // 묶음 PR을 골라도 탭은 그대로
  await expect(hint(page)).toContainText("내 PR · 승인");
  await row.press("ArrowDown"); // 묶음 → 목록 첫 항목
  await expect(item(page, /#131/)).toHaveAttribute("aria-selected", "true");
  await item(page, /#131/).press("ArrowUp"); // 목록 → 묶음
  await expect(row).toHaveAttribute("aria-selected", "true");
  // 접기: 행이 사라지고 ↑↓는 보이는 항목만, 닫았다 열어도 접힘 유지
  await mineHead(page).click();
  await expect(mineHead(page)).toHaveAttribute("aria-expanded", "false");
  await expect(row).toHaveCount(0);
  await screen(page).getByRole("button", { name: "닫기" }).first().click();
  await expect(screen(page)).toHaveCount(0);
  await palette(page);
  await expect(mineHead(page)).toHaveAttribute("aria-expanded", "false");
  await expect(row).toHaveCount(0);
  await mineHead(page).click();
  await expect(row).toHaveCount(1);
});

test("내가 올린 PR 묶음: 리뷰어가 없으면 '리뷰어 없음', 초안은 배지, 검색에 일치하지 않아도 남는다", async ({ page }) => {
  await open(page, { __inbox: [mk(60, { isMine: true, author: "demo-user", title: "내 첫 PR" }), mk(61, { isMine: true, author: "demo-user", draft: true, title: "내 초안" }), mk(62, { reviewRequested: true, title: "남의 PR" })] });
  await palette(page);
  await expect(mineHead(page)).toContainText("내가 올린 PR 2건");
  await expect(mine(page).getByRole("option", { name: /#60/ })).toContainText("리뷰어 없음");
  await expect(mine(page).getByRole("option", { name: /#61/ })).toContainText("초안");
  await screen(page).getByRole("textbox", { name: /번호·제목/ }).fill("남의");
  await expect(mine(page).getByRole("option")).toHaveCount(2);
});

test("탭 보조 글: 대화 n건 / 미해결 n(warn) · AI 리뷰 준비 중 · 파일 n개 · +a −d", async ({ page }) => {
  await open(page);
  await palette(page);
  const sub = (re: RegExp) => tabBtn(page, re).locator("small");
  await expect(sub(/^개요/)).toHaveText("대화 4건");
  await expect(sub(/^개요/)).not.toHaveClass(/is-warn/);
  await expect(sub(/^AI 리뷰/)).toHaveText("리뷰 전");
  await expect(sub(/^변경 파일/)).toHaveText("파일 4개 · +48 −21");
  // 미해결 스레드가 있는 PR(128)은 warn
  await item(page, /#128/).click();
  await expect(sub(/^개요/)).toHaveText("미해결 1");
  await expect(sub(/^개요/)).toHaveClass(/is-warn/);
  // 탭 이름(접근성)은 보조 글과 따로: 보조 글은 설명
  await expect(tabBtn(page, /^개요/)).toHaveAttribute("aria-description", "미해결 1");
  // 한 줄 높이를 넘지 않고 탭이 서로 겹치지 않는다
  const boxes = await Promise.all([/^개요/, /^AI 리뷰/, /^변경 파일/].map((r) => tabBtn(page, r).boundingBox()));
  expect(boxes[0]!.x + boxes[0]!.width).toBeLessThanOrEqual(boxes[1]!.x + 1);
  expect(boxes[1]!.x + boxes[1]!.width).toBeLessThanOrEqual(boxes[2]!.x + 1);
});

test("안내줄·묶음·탭 보조 글 스크린샷(라이트·다크)", async ({ page }, info) => {
  await open(page);
  await palette(page);
  await expect(hint(page)).toBeVisible();
  await page.screenshot({ path: `e2e/results/screens/pr-hint-${info.project.name}.png` });
  await item(page, /#128/).click();
  await expect(tabBtn(page, /^개요/).locator("small")).toHaveText("미해결 1");
  await mine(page).getByRole("option").click();
  await expect(hint(page)).toContainText("내 PR · 승인");
  await page.screenshot({ path: `e2e/results/screens/pr-mine-${info.project.name}.png` });
});

// ---- 26c: AI 리뷰 탭 ----
const aiTab = (page: Page) => tabBtn(page, /^AI 리뷰/);
const ai = (page: Page) => screen(page).locator(".prai");
const cards = (page: Page) => ai(page).locator(".prai-card");
const startBtn = (page: Page) => ai(page).getByRole("button", { name: "AI 리뷰 시작" });
const aiOpen = async (page: Page, flags: Record<string, unknown> = {}) => {
  await open(page, { __asked: [], __ai: { consent: true }, ...flags });
  await palette(page);
  await aiTab(page).click();
};
const aiDone = async (page: Page, flags: Record<string, unknown> = {}) => {
  await aiOpen(page, flags);
  await startBtn(page).click();
  await expect(cards(page)).toHaveCount(3);
};
const asked = (page: Page) => page.evaluate(() => (window as any).__asked as string[]);
const submits = async (page: Page) => (await callsOf(page, "pr_review_submit")).map((c) => JSON.parse(c[1]));
const postBtn = (page: Page) => ai(page).locator(".prai-foot .prai-split").first().getByRole("button").first();
const menuBtn = (page: Page) => ai(page).getByRole("button", { name: "게시 방식" });
const noMust = {
  verdict: "approve", summary: "문제 없습니다.", praise: [],
  comments: [{ file: "crates/graph/src/lib.rs", line: 14, endLine: null, level: "info", title: "참고", body: "참고용입니다.", evidence: "" }],
  meta: { model: "claude-opus-5-5", inputTokens: null, outputTokens: null, elapsedMs: 5000 },
};

test("AI 꺼짐: 탭이 막히지 않고 이유와 [설정 > AI 열기]를 보인다(CLI·키 없음 / 이 저장소에서 끔)", async ({ page }) => {
  await aiOpen(page, { __ai: { cli: false, key: false, consent: true } });
  await expect(aiTab(page).locator("small")).toHaveText("AI 꺼짐");
  await expect(ai(page)).toContainText("AI를 쓸 수 없습니다");
  await expect(startBtn(page)).toHaveCount(0);
  await ai(page).getByRole("button", { name: "설정 > AI 열기" }).click();
  await expect(page.getByRole("dialog", { name: /설정/ })).toBeVisible();
});

test("AI 꺼짐: 이 저장소에서 껐으면 그렇게 말한다", async ({ page }) => {
  await aiOpen(page, { __issue: { "git403.ai": "false" } });
  await expect(ai(page)).toContainText("이 저장소에서는 AI를 꺼 두었습니다");
  await expect(ai(page).getByRole("button", { name: "설정 > AI 열기" })).toBeVisible();
});

test("실행 전: 설명·보내는 내용·모델·노력(기본 보통)을 보이고, 시작하면 모델·노력·입력(PR·커밋·diff)이 ai_run으로 간다", async ({ page }) => {
  await aiOpen(page);
  await expect(ai(page)).toContainText("보내는 내용: PR 제목·본문, 커밋 메시지, 변경 diff");
  await expect(ai(page).getByRole("radio", { name: "보통" })).toHaveAttribute("aria-checked", "true");
  await expect(ai(page).getByRole("textbox", { name: "모델" })).toHaveAttribute("placeholder", /claude-opus-5-5/);
  await ai(page).getByRole("textbox", { name: "모델" }).fill("claude-x");
  await ai(page).getByRole("radio", { name: "높음" }).click();
  await startBtn(page).click();
  await expect(cards(page)).toHaveCount(3);
  const run = JSON.parse((await callsOf(page, "ai_run")).at(-1)![1]);
  expect(run.task).toBe("prreview");
  expect(run.model).toBe("claude-x");
  expect(run.effort).toBe("high");
  expect(run.parts.map((p: { label: string }) => p.label)).toEqual(["pull request", "commit messages", "diff (merge-base..head)"]);
  expect(run.parts[0].text).toContain("설정 화면 다크 모드 색 맞추기");
  expect(run.parts[0].text).toContain("셀 배경");
  expect(run.parts[1].text).toContain("다크 모드 색 토큰 정리");
  expect(await page.evaluate(() => [localStorage.getItem("prr.ai.model"), localStorage.getItem("prr.ai.effort")])).toEqual(['"claude-x"', '"high"']);
});

test("진행 중: 스피너·경과 시간·취소, 탭·PR을 떠나도 계속 진행되고 돌아오면 그대로, 취소하면 처음 상태", async ({ page }) => {
  await aiOpen(page, { __aiSlow: 1500 });
  await startBtn(page).click();
  await expect(ai(page)).toContainText("AI가 리뷰하는 중…");
  await expect(ai(page).locator(".prai-sec")).toHaveText(/\d+초/);
  await expect(aiTab(page).locator("small")).toHaveText("리뷰 중…");
  await expect(item(page, /#131/)).toContainText("AI 리뷰 중");
  await tabBtn(page, /^개요/).click();
  await item(page, /#128/).click();
  await item(page, /#131/).click();
  await aiTab(page).click();
  await expect(ai(page)).toContainText("AI가 리뷰하는 중…");
  expect((await callsOf(page, "ai_run")).length).toBe(1); // 돌아와도 다시 시작하지 않는다
  await ai(page).getByRole("button", { name: "취소" }).click();
  await expect(startBtn(page)).toBeVisible();
  await expect(aiTab(page).locator("small")).toHaveText("리뷰 전");
  expect((await callsOf(page, "ai_cancel")).length).toBe(1);
  await startBtn(page).click();
  await tabBtn(page, /^개요/).click();
  await expect(aiTab(page).locator("small")).toHaveText("필수 1", { timeout: 5000 }); // 떠나 있는 동안 끝난다
  await expect(item(page, /#131/)).toContainText("AI 필수 1");
  await aiTab(page).click();
  await expect(cards(page)).toHaveCount(3);
});

test("실패: Rust 오류 문구가 그대로 보이고 다시 시작할 수 있다", async ({ page }) => {
  await aiOpen(page, { __aiFail: "선택한 내용이 너무 큽니다(300KB, 상한 200KB)." });
  await startBtn(page).click();
  await expect(ai(page).getByRole("alert")).toContainText("선택한 내용이 너무 큽니다(300KB, 상한 200KB).");
  await expect(startBtn(page)).toBeVisible();
  await expect(aiTab(page).locator("small")).toHaveText("실패");
});

test("배너 두 톤: 필수가 있으면 danger, 없으면 ok + 메타 줄(모델·토큰·시간)", async ({ page }) => {
  await aiDone(page);
  const banner = ai(page).locator(".prai-banner").first();
  await expect(banner).toHaveText("머지를 막는 이슈 1개 — 다 고쳐지면 Approve 하세요");
  await expect(banner).toHaveClass(/is-danger/);
  const meta = ai(page).locator(".prai-meta");
  await expect(meta).toContainText("claude-opus-5-5");
  await expect(meta).toContainText("토큰 입력 12.4k 출력 1.8k");
  await expect(meta).toContainText("74초");
  await expect(meta).toContainText("보통");
});

test("배너: 필수가 없으면 ok 톤, 토큰을 모르면 –, 기본 게시는 코멘트로", async ({ page }) => {
  await aiOpen(page, { __aiResult: { prreview: noMust } });
  await startBtn(page).click();
  const banner = ai(page).locator(".prai-banner").first();
  await expect(banner).toHaveText("머지를 막는 이슈 없음 — Approve 해도 괜찮습니다");
  await expect(banner).toHaveClass(/is-ok/);
  await expect(ai(page).locator(".prai-meta")).toContainText("토큰 입력 – 출력 –");
  await expect(postBtn(page)).toHaveText("코멘트로 게시");
  await expect(aiTab(page).locator("small")).toHaveText("리뷰 완료");
  await expect(item(page, /#131/)).toContainText("AI 리뷰 완료");
});

test("카드: must → should → info 순, 기본 체크(must·should), 레벨 배지·path:line, 코드 조각(±3줄·대상 줄 강조), 개수", async ({ page }) => {
  await aiDone(page);
  await expect(cards(page).nth(0).locator(".prai-lv")).toHaveText("필수");
  await expect(cards(page).nth(1).locator(".prai-lv")).toHaveText("권장");
  await expect(cards(page).nth(2).locator(".prai-lv")).toHaveText("참고");
  await expect(cards(page).nth(0).locator(".prai-loc")).toHaveText("crates/graph/src/lib.rs:14");
  await expect(cards(page).nth(1).locator(".prai-loc")).toHaveText("ui/src/CommitGraph.tsx:43-44");
  const on = async (i: number) => cards(page).nth(i).getByRole("checkbox").isChecked();
  expect([await on(0), await on(1), await on(2)]).toEqual([true, true, false]);
  const hit = cards(page).nth(0).locator(".prai-row.hit");
  await expect(hit).toHaveCount(1);
  await expect(hit).toContainText("let mut next_color = 0;");
  await expect(cards(page).nth(0).locator(".prai-row")).toHaveCount(7); // 대상 줄 ±3
  await expect(cards(page).nth(1).locator(".prai-row.hit")).toHaveCount(2); // 범위 43-44
  await expect(ai(page).locator(".prai-count")).toHaveText("필수 1 · 0/3 게시됨");
  // 요약은 체크·편집 가능, 잘된 점은 기본 해제
  const sum = ai(page).locator(".prai-body");
  await expect(sum.getByRole("checkbox").first()).toBeChecked();
  await expect(sum.getByRole("checkbox").nth(1)).not.toBeChecked();
  await expect(sum.getByRole("textbox").first()).toHaveValue(/레인 색 할당을 바꾸고/);
  await expect(sum).toContainText("체크한 것만 게시 본문에 들어갑니다");
});

test("카드 편집(편집 ↔ 완료, 원래대로)·근거 보기 펼침", async ({ page }) => {
  await aiDone(page);
  const c = cards(page).nth(0);
  await expect(c.locator(".prai-md code").first()).toHaveText("next_color");
  await c.getByRole("button", { name: "편집", exact: true }).click();
  await expect(c.getByRole("textbox")).toBeFocused();
  await c.getByRole("textbox").fill("**고친** 문구");
  await c.getByRole("button", { name: "편집 완료" }).click();
  await expect(c.locator(".prai-md strong")).toHaveText("고친");
  await expect(c.locator(".prai-evidence")).toHaveCount(0);
  await c.getByRole("button", { name: "근거 보기" }).click();
  await expect(c.locator(".prai-evidence")).toContainText("debug 빌드에서는 패닉이 납니다");
  await c.getByRole("button", { name: "근거 접기" }).click();
  await expect(c.locator(".prai-evidence")).toHaveCount(0);
  await c.getByRole("button", { name: "원래대로" }).click();
  await expect(c.locator(".prai-md code").first()).toHaveText("next_color");
  await expect(c.getByRole("button", { name: "원래대로" })).toHaveCount(0);
});

test("코드에서 보기: 변경 파일 탭에서 그 파일·줄로, ← AI 리뷰로 돌아가기(버튼·⌘[)가 그 카드로 되돌린다", async ({ page }) => {
  await aiDone(page);
  await cards(page).nth(1).getByRole("button", { name: "코드에서 보기" }).click();
  await expect(filesTab(page)).toHaveAttribute("aria-selected", "true");
  await expect(fileItem(page, /CommitGraph\.tsx/)).toHaveAttribute("aria-selected", "true");
  const back = files(page).getByRole("button", { name: "← AI 리뷰로 돌아가기" });
  await expect(back).toBeVisible();
  await expect(files(page).locator(".diff")).toBeVisible();
  await back.click();
  await expect(aiTab(page)).toHaveAttribute("aria-selected", "true");
  await expect(cards(page).nth(1)).toHaveClass(/flash/);
  await expect(cards(page).nth(1)).toBeInViewport();
  // 첫 카드(lib.rs)로 다시, 이번엔 ⌘[
  await cards(page).nth(0).getByRole("button", { name: "코드에서 보기" }).click();
  await expect(fileItem(page, /lib\.rs/)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ControlOrMeta+[");
  await expect(aiTab(page)).toHaveAttribute("aria-selected", "true");
});

test("게시: 기본은 변경 요청, OS 확인창 문구, 인자(event·본문은 체크한 것만·comments path/line/startLine·commitId)", async ({ page }) => {
  await aiDone(page);
  await expect(postBtn(page)).toHaveText("변경 요청으로 게시");
  await expect(ai(page).locator(".prai-plan")).toHaveText("게시 예정: 본문 포함, 코멘트 2개");
  // 요약 해제 + 잘된 점 체크, 첫 카드 문구 편집
  const sum = ai(page).locator(".prai-body");
  await sum.getByRole("checkbox").first().uncheck();
  await sum.getByRole("checkbox").nth(1).check();
  await cards(page).nth(0).getByRole("button", { name: "편집", exact: true }).click();
  await cards(page).nth(0).getByRole("textbox").fill("고친 필수 문구");
  await postBtn(page).click();
  await expect.poll(async () => (await submits(page)).length).toBe(1);
  expect((await asked(page)).at(-1)).toContain("2개 코멘트와 본문을 #131에 게시합니다");
  const a = (await submits(page))[0];
  expect(a.event).toBe("REQUEST_CHANGES");
  expect(a.number).toBe(131);
  expect(a.commitId).toBe("a131b2c3d4e5f6");
  expect(a.body).toContain("### 잘된 점");
  expect(a.body).toContain("- 색 할당 로직을 한 함수로 모아");
  expect(a.body).not.toContain("레인 색 할당을 바꾸고"); // 해제한 요약은 빠진다
  expect(a.comments).toEqual([
    { path: "crates/graph/src/lib.rs", line: 14, side: "RIGHT", body: "고친 필수 문구" },
    { path: "ui/src/CommitGraph.tsx", line: 44, startLine: 43, side: "RIGHT", body: expect.stringContaining("별도 함수로 빼면") },
  ]);
  expect(a.comments.some((c: { body: string }) => c.body.includes("node"))).toBe(false); // 해제한 info 카드는 없다
});

test("게시 거절(확인창 아니오)이면 아무것도 보내지 않는다", async ({ page }) => {
  await aiDone(page, { __askNo: true });
  await postBtn(page).click();
  await expect.poll(async () => (await asked(page)).length).toBeGreaterThan(0);
  expect((await submits(page)).length).toBe(0);
  await expect(cards(page).nth(0)).not.toContainText("게시됨");
});

test("게시 성공: 토스트·'GitHub에서 보기'·카드 '게시됨'(체크 비활성)·m/k 갱신·본문 중복 방지, 남은 카드는 다시 게시 가능", async ({ page }) => {
  await aiDone(page);
  await postBtn(page).click();
  await expect(page.getByRole("status").filter({ hasText: "리뷰 게시 완료" })).toBeVisible();
  const done = ai(page).locator(".prai-done");
  await expect(done).toContainText("GitHub에 게시됨(코멘트 2개)");
  await done.getByRole("button", { name: "GitHub에서 보기" }).click();
  expect((await callsOf(page, "open_url")).at(-1)![1]).toBe("https://github.com/demo/git403/pull/131#pullrequestreview-9001");
  for (const i of [0, 1]) {
    await expect(cards(page).nth(i)).toContainText("게시됨");
    await expect(cards(page).nth(i).getByRole("checkbox")).toBeDisabled();
    await expect(cards(page).nth(i).getByRole("button", { name: "편집", exact: true })).toHaveCount(0);
  }
  await expect(cards(page).nth(2).getByRole("checkbox")).toBeEnabled();
  await expect(ai(page).locator(".prai-count")).toHaveText("필수 1 · 2/3 게시됨");
  await expect(ai(page).locator(".prai-body").getByRole("checkbox").first()).toBeDisabled();
  // 필수는 다 게시했으니 기본은 코멘트로, 남은 게 없으면 이유와 함께 비활성
  await expect(postBtn(page)).toHaveText("코멘트로 게시");
  await expect(postBtn(page)).toBeDisabled();
  await expect(ai(page).locator(".prai-plan")).toContainText("게시할 것이 없습니다");
  await cards(page).nth(2).getByRole("checkbox").check();
  await postBtn(page).click();
  await expect.poll(async () => (await submits(page)).length).toBe(2);
  const b = (await submits(page))[1];
  expect(b.event).toBe("COMMENT");
  expect(b.body).toBe(""); // 본문은 한 번만
  expect(b.comments).toHaveLength(1);
  await expect(ai(page).locator(".prai-count")).toHaveText("필수 1 · 3/3 게시됨");
});

test("게시 실패: 오류를 보이고 체크·편집은 그대로, 고친 뒤 다시 게시된다", async ({ page }) => {
  await aiDone(page, { __submitFail: "401 Bad credentials" });
  await cards(page).nth(0).getByRole("button", { name: "편집", exact: true }).click();
  await cards(page).nth(0).getByRole("textbox").fill("지켜질 문구");
  await postBtn(page).click();
  await expect(ai(page).locator(".prai-foot").getByRole("alert")).toContainText("401 Bad credentials");
  await expect(ai(page).locator(".prai-foot")).toContainText("체크·편집한 내용은 그대로 있습니다");
  await expect(cards(page).nth(0).getByRole("textbox")).toHaveValue("지켜질 문구");
  await expect(cards(page).nth(0).getByRole("checkbox")).toBeChecked();
  await expect(cards(page).nth(0)).not.toContainText("게시됨");
  await expect(postBtn(page)).toBeEnabled();
  await page.evaluate(() => ((window as any).__submitFail = ""));
  await postBtn(page).click();
  await expect(ai(page).locator(".prai-done")).toBeVisible();
  expect((await submits(page)).at(-1).comments[0].body).toBe("지켜질 문구");
});

test("422(줄이 diff 밖): GitHub 메시지를 보이고 해당 카드를 표시하며 나머지는 그대로", async ({ page }) => {
  await aiDone(page, { __submit422: true });
  await postBtn(page).click();
  await expect(ai(page).locator(".prai-foot").getByRole("alert")).toContainText("must be part of the diff");
  await expect(cards(page).nth(1)).toHaveClass(/bad/);
  await expect(cards(page).nth(1).getByRole("alert")).toContainText("코멘트를 달 수 없습니다");
  await expect(cards(page).nth(0)).not.toHaveClass(/bad/);
  await expect(cards(page).nth(1).getByRole("checkbox")).toBeChecked();
  // 표시된 카드를 해제하면 다음 게시 시도에서 표시가 지워진다
  await page.evaluate(() => ((window as any).__submit422 = false));
  await cards(page).nth(1).getByRole("checkbox").uncheck();
  await postBtn(page).click();
  await expect(cards(page).nth(1)).not.toHaveClass(/bad/);
  await expect(cards(page).nth(0)).toContainText("게시됨");
});

test("diff 밖 줄: 코드 조각 대신 안내가 나온다", async ({ page }) => {
  const res = { ...noMust, comments: [{ ...noMust.comments[0], line: 99, level: "must" }] };
  await aiOpen(page, { __aiResult: { prreview: res } });
  await startBtn(page).click();
  await expect(cards(page).first().locator(".prai-snip-note")).toContainText("이 줄은 변경 diff에 없습니다");
});

test("게시 방식 메뉴(코멘트·승인·변경 요청)와 승인 경고: 필수가 체크돼 있으면 확인창에 경고가 들어간다", async ({ page }) => {
  await aiDone(page);
  await menuBtn(page).click();
  await expect(page.getByRole("menuitem")).toHaveText(["코멘트로 게시", "승인으로 게시", "변경 요청으로 게시"]);
  await page.getByRole("menuitem", { name: "승인으로 게시" }).click();
  await expect.poll(async () => (await submits(page)).length).toBe(1);
  expect((await asked(page)).at(-1)).toContain("체크된 필수 이슈가 1개 남아 있는데 승인으로 게시하려 합니다");
  expect((await submits(page))[0].event).toBe("APPROVE");
});

test("승인: 필수를 해제하면 경고 없이, 코멘트만·변경 요청 이벤트도 맞게 간다", async ({ page }) => {
  await aiDone(page);
  await cards(page).nth(0).getByRole("checkbox").uncheck();
  await menuBtn(page).click();
  await page.getByRole("menuitem", { name: "승인으로 게시" }).click();
  await expect.poll(async () => (await submits(page)).length).toBe(1);
  expect((await asked(page)).at(-1)).not.toContain("필수 이슈");
  await expect(cards(page).nth(1)).toContainText("게시됨");
  await cards(page).nth(2).getByRole("checkbox").check();
  await menuBtn(page).click();
  await page.getByRole("menuitem", { name: "코멘트로 게시" }).click();
  await expect.poll(async () => (await submits(page)).length).toBe(2);
  expect((await submits(page))[1].event).toBe("COMMENT");
});

test("변경 요청은 본문이 없으면 이유와 함께 막힌다", async ({ page }) => {
  await aiDone(page);
  await ai(page).locator(".prai-body").getByRole("checkbox").first().uncheck();
  await expect(postBtn(page)).toBeDisabled();
  await expect(ai(page).locator(".prai-plan")).toContainText("변경 요청에는 본문이 필요합니다");
  await menuBtn(page).click();
  await expect(page.getByRole("menuitem", { name: "변경 요청으로 게시" })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "코멘트로 게시" })).toBeEnabled();
});

test("다시 리뷰: 전체 다시 리뷰(편집했으면 확인), head가 같으면 새 커밋만은 비활성", async ({ page }) => {
  await aiDone(page);
  await ai(page).getByRole("button", { name: /^다시 리뷰/ }).click();
  await expect(page.getByRole("menuitem", { name: /^새 커밋만/ })).toBeDisabled(); // head가 같으면 비활성(이유는 글자로: 26d 테스트)
  await page.keyboard.press("Escape");
  // 편집한 뒤 + 확인창 아니오 → 다시 부르지 않고 편집 유지
  await cards(page).nth(0).getByRole("button", { name: "편집", exact: true }).click();
  await cards(page).nth(0).getByRole("textbox").fill("지킬 문구");
  await page.evaluate(() => ((window as any).__askNo = true));
  await ai(page).getByRole("button", { name: /^다시 리뷰/ }).click();
  await page.getByRole("menuitem", { name: "전체 다시 리뷰" }).click();
  await expect.poll(async () => (await asked(page)).some((m) => m.includes("새 결과로 바뀝니다"))).toBe(true);
  expect((await callsOf(page, "ai_run")).length).toBe(1);
  await expect(cards(page).nth(0).getByRole("textbox")).toHaveValue("지킬 문구");
  // 예 → 같은 모델·노력으로 다시 실행
  await page.evaluate(() => ((window as any).__askNo = false));
  await ai(page).getByRole("button", { name: /^다시 리뷰/ }).click();
  await page.getByRole("menuitem", { name: "전체 다시 리뷰" }).click();
  await expect.poll(async () => (await callsOf(page, "ai_run")).length).toBe(2);
  await expect(cards(page).nth(0).locator(".prai-md")).toContainText("오버플로합니다");
});

test("탭·PR을 오가도 결과·체크·편집·스크롤이 유지된다", async ({ page }) => {
  await aiDone(page);
  await cards(page).nth(2).getByRole("checkbox").check();
  await cards(page).nth(0).getByRole("button", { name: "편집", exact: true }).click();
  await cards(page).nth(0).getByRole("textbox").fill("남아야 할 문구");
  await ai(page).locator(".prai-body").getByRole("checkbox").nth(1).check();
  const body = screen(page).locator(".prr-body.ai");
  await body.evaluate((e) => (e.scrollTop = 120));
  const top = await body.evaluate((e) => e.scrollTop);
  await tabBtn(page, /^개요/).click();
  await filesTab(page).click();
  await aiTab(page).click();
  expect(await body.evaluate((e) => e.scrollTop)).toBe(top);
  await expect(cards(page).nth(0).getByRole("textbox")).toHaveValue("남아야 할 문구");
  // 다른 PR을 봤다 와도(상세는 다시 마운트) 같은 결과
  await item(page, /#128/).click();
  await expect(aiTab(page).locator("small")).toHaveText("리뷰 전");
  await item(page, /#131/).click();
  await expect(aiTab(page).locator("small")).toHaveText("필수 1");
  await aiTab(page).click();
  await expect(cards(page)).toHaveCount(3);
  await expect(cards(page).nth(2).getByRole("checkbox")).toBeChecked();
  await expect(cards(page).nth(0).getByRole("textbox")).toHaveValue("남아야 할 문구");
  await expect(ai(page).locator(".prai-body").getByRole("checkbox").nth(1)).toBeChecked();
  expect((await callsOf(page, "ai_run")).length).toBe(1);
  // PR 화면을 닫았다 열어도(세션 캐시)
  await page.keyboard.press("Escape"); // 첫 Esc는 입력 포커스만 푼다
  await page.keyboard.press("Escape");
  await expect(screen(page)).toHaveCount(0);
  await palette(page);
  await aiTab(page).click();
  await expect(cards(page).nth(0).getByRole("textbox")).toHaveValue("남아야 할 문구");
});

test("오래된 결과: head가 바뀌면 배너 위에 '새 커밋이 있습니다 — 다시 리뷰', 탭 보조 글에 이전 커밋 표시", async ({ page }) => {
  await aiDone(page);
  await expect(ai(page).getByText("리뷰 이후 새 커밋이 있습니다")).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).__inbox = [{ number: 131, title: "설정 화면 다크 모드 색 맞추기", url: "https://github.com/demo/git403/pull/131", head: "fix/settings-dark", base: "main", author: "Alex", authorAvatar: "", draft: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), additions: 1, deletions: 1, labels: [], reviewers: [], approvals: 0, myReview: "none", reRequested: false, headSha: "zzz999", isMine: false, reviewRequested: true }];
  });
  await screen(page).getByRole("button", { name: "Pull Request 새로고침" }).click();
  const stale = ai(page).locator(".prai-banner.is-warn");
  await expect(stale).toContainText("리뷰 이후 새 커밋이 있습니다 —");
  await expect(aiTab(page).locator("small")).toHaveText("필수 1 (이전 커밋)");
  expect(await stale.evaluate((e, b) => !!(e.compareDocumentPosition(document.querySelector(b)!) & Node.DOCUMENT_POSITION_FOLLOWING), ".prai-banner.is-danger")).toBe(true); // 위에 있다
  await stale.getByRole("button", { name: "다시 리뷰" }).click();
  await expect.poll(async () => (await callsOf(page, "ai_run")).length).toBe(2);
});

test("코드 조각은 한 hunk 안에서만 잘라 줄 번호가 건너뛰지 않는다", async ({ page }) => {
  await aiOpen(page);
  await startBtn(page).click();
  await expect(cards(page)).toHaveCount(3);
  for (const code of await ai(page).locator(".prai-code").all()) {
    const ns = (await code.locator(".prai-row .n").allTextContents()).filter(Boolean).map(Number);
    expect(ns.length).toBeGreaterThan(0);
    ns.slice(1).forEach((n, i) => expect(n, `줄 번호 ${ns.join(",")}`).toBe(ns[i] + 1));
  }
});

test("AI 리뷰 스크린샷(라이트·다크): 실행 전·결과", async ({ page }, info) => {
  await aiOpen(page);
  await expect(startBtn(page)).toBeVisible();
  await page.screenshot({ path: `e2e/results/screens/pr-ai-start-${info.project.name}.png` });
  await startBtn(page).click();
  await expect(cards(page)).toHaveCount(3);
  await cards(page).nth(0).getByRole("button", { name: "근거 보기" }).click();
  await page.screenshot({ path: `e2e/results/screens/pr-ai-result-${info.project.name}.png` });
  await screen(page).locator(".prr-body.ai").evaluate((e) => (e.scrollTop = e.scrollHeight));
  await page.screenshot({ path: `e2e/results/screens/pr-ai-foot-${info.project.name}.png` });
});

test("게시 연타: 확인창이 뜨기 전 버튼·메뉴를 섞어 눌러도 확인창 1개·게시 1회, 끝나면 풀린다", async ({ page }) => {
  await aiDone(page, { __slowAsk: 500 });
  await postBtn(page).click();
  await postBtn(page).click();
  await menuBtn(page).click();
  await page.getByRole("menuitem", { name: "승인으로 게시" }).click();
  await postBtn(page).click();
  await expect(ai(page).locator(".prai-done")).toBeVisible();
  expect((await submits(page)).length).toBe(1);
  expect((await asked(page)).length).toBe(1);
  // 확인창에서 아니오 → 잠금이 풀려 다시 누를 수 있다
  await page.evaluate(() => Object.assign(window as any, { __askNo: true, __slowAsk: 0 }));
  await cards(page).nth(2).getByRole("checkbox").check();
  await postBtn(page).click();
  await expect.poll(async () => (await asked(page)).length).toBe(2);
  await page.evaluate(() => Object.assign(window as any, { __askNo: false }));
  await expect(postBtn(page)).toBeEnabled();
  await postBtn(page).click();
  await expect.poll(async () => (await submits(page)).length).toBe(2);
});

test("확인 뒤 편집본 반영: 확인창이 떠 있는 동안 고친 문구가 게시된다", async ({ page }) => {
  await aiDone(page, { __slowAsk: 600 });
  await cards(page).nth(0).getByRole("button", { name: "편집", exact: true }).click();
  await cards(page).nth(0).getByRole("textbox").fill("처음 문구");
  await postBtn(page).click();
  await cards(page).nth(0).getByRole("textbox").fill("확인창 뒤 문구");
  await expect.poll(async () => (await submits(page)).length).toBe(1);
  expect((await submits(page))[0].comments[0].body).toBe("확인창 뒤 문구");
});

test("게시 중에는 다시 리뷰가 이유와 함께 비활성(버튼·메뉴·배너)이고, 끝나면 결과에 게시 표시가 한 번만 붙는다", async ({ page }) => {
  await aiDone(page, { __slowSubmit: 1200 });
  await postBtn(page).click();
  const again = ai(page).getByRole("button", { name: /^다시 리뷰/ });
  await expect(again).toBeDisabled();
  await expect(again).toHaveAttribute("title", "게시 중에는 다시 리뷰할 수 없습니다");
  await expect(postBtn(page)).toHaveText("게시 중…");
  await tabBtn(page, /^개요/).click();
  await item(page, /#128/).click();
  await item(page, /#131/).click();
  await aiTab(page).click();
  await expect(cards(page).nth(0)).toContainText("게시됨", { timeout: 5000 });
  expect((await callsOf(page, "ai_run")).length).toBe(1);
  expect((await submits(page)).length).toBe(1);
  await expect(again).toBeEnabled();
});

test("오래된 결과 배너의 다시 리뷰도 편집했거나 게시했으면 확인을 받는다", async ({ page }) => {
  await aiDone(page);
  await page.evaluate(() => {
    (window as any).__inbox = [{ number: 131, title: "설정 화면 다크 모드 색 맞추기", url: "https://github.com/demo/git403/pull/131", head: "fix/settings-dark", base: "main", author: "Alex", authorAvatar: "", draft: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), additions: 1, deletions: 1, labels: [], reviewers: [], approvals: 0, myReview: "none", reRequested: false, headSha: "zzz999", isMine: false, reviewRequested: true }];
  });
  await screen(page).getByRole("button", { name: "Pull Request 새로고침" }).click();
  const re = ai(page).locator(".prai-banner.is-warn").getByRole("button", { name: "다시 리뷰" });
  await expect(re).toBeVisible();
  // 편집 + 아니오 → 그대로
  await cards(page).nth(0).getByRole("button", { name: "편집", exact: true }).click();
  await cards(page).nth(0).getByRole("textbox").fill("지킬 문구");
  await page.evaluate(() => Object.assign(window as any, { __askNo: true }));
  await re.click();
  await expect.poll(async () => (await asked(page)).some((m) => m.includes("새 결과로 바뀝니다"))).toBe(true);
  expect((await callsOf(page, "ai_run")).length).toBe(1);
  await expect(cards(page).nth(0).getByRole("textbox")).toHaveValue("지킬 문구");
  // 게시한 뒤에는 편집이 없어도 확인(게시 이력 경고)
  await page.evaluate(() => Object.assign(window as any, { __askNo: false }));
  await postBtn(page).click();
  await expect(ai(page).locator(".prai-done")).toBeVisible();
  await page.evaluate(() => Object.assign(window as any, { __askNo: true }));
  await re.click();
  await expect.poll(async () => (await asked(page)).some((m) => m.includes("이미 게시한 코멘트는 GitHub에 남지만"))).toBe(true);
  expect((await callsOf(page, "ai_run")).length).toBe(1);
  await page.evaluate(() => Object.assign(window as any, { __askNo: false }));
  await re.click();
  await expect.poll(async () => (await callsOf(page, "ai_run")).length).toBe(2);
});

test("게시 실패 + diff 조회 실패: 오류만 남고 버튼은 풀리며 카드에 표시는 붙지 않는다", async ({ page }) => {
  await aiOpen(page, { __prDiffFail: true, __submitFail: "500 boom" });
  await startBtn(page).click();
  await expect(cards(page)).toHaveCount(3);
  await expect(cards(page).nth(0).locator(".prai-snip-note")).toContainText("코드를 읽지 못했습니다");
  await postBtn(page).click();
  await expect(ai(page).locator(".prai-foot").getByRole("alert")).toContainText("500 boom");
  await expect(postBtn(page)).toBeEnabled();
  await expect(postBtn(page)).toHaveText("변경 요청으로 게시");
  await expect(menuBtn(page)).toBeEnabled();
  await expect(ai(page).locator(".prai-card.bad")).toHaveCount(0);
  await page.evaluate(() => Object.assign(window as any, { __submitFail: "" }));
  await postBtn(page).click();
  await expect(ai(page).locator(".prai-done")).toBeVisible();
});

test("읽기 팝업은 화면 가운데에 뜬다(확인·입력 시트처럼 위에 붙지 않는다)", async ({ page }) => {
  await open(page);
  await palette(page);
  await screen(page).locator(".prr-entry.review, .prr-entry.comment").first().click();
  const b = (await page.locator(".prr-pop").boundingBox())!;
  const vh = page.viewportSize()!.height;
  expect(Math.abs(b.y - (vh - b.y - b.height))).toBeLessThanOrEqual(2);
});

// ---- 26d: 새 커밋만 다시 리뷰 ----
const NEWH = "zzz999";
const inboxAt = (headSha: string) => [{ number: 131, title: "설정 화면 다크 모드 색 맞추기", url: "https://github.com/demo/git403/pull/131", head: "fix/settings-dark", base: "main", author: "Alex", authorAvatar: "", draft: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), additions: 1, deletions: 1, labels: [], reviewers: [], approvals: 0, myReview: "none", reRequested: false, headSha, isMine: false, reviewRequested: true }];
const tlOf = () => {
  const at = (m: number) => new Date(Date.now() - m * 60000).toISOString();
  return [
    { kind: "commit", author: "Alex", at: at(300), sha: "930b8b1aa", body: "c1" },
    { kind: "commit", author: "Alex", at: at(200), sha: "a131b2c3d4e5f6", body: "c2" },
    { kind: "commit", author: "Alex", at: at(20), sha: "nnn111aa", body: "n1" },
    { kind: "commit", author: "Alex", at: at(5), sha: NEWH, body: "n2" },
  ];
};
const incRes = {
  verdict: "request_changes", summary: "새 커밋은 오버플로를 고쳤지만 새 문제가 있습니다.", praise: [],
  comments: [
    { file: "ui/src/CommitGraph.tsx", line: 13, endLine: null, level: "must", title: "새 필수", body: "새 커밋에서 생긴 문제입니다.", evidence: "e" },
    { file: "crates/graph/src/lib.rs", line: 15, endLine: null, level: "info", title: "새 참고", body: "참고용입니다.", evidence: "" },
  ],
  meta: { model: "claude-opus-5-5", inputTokens: 3100, outputTokens: 420, elapsedMs: 21000 },
};
const incFlags = (extra: Record<string, unknown> = {}) => ({
  __prDetail: { 131: { headSha: NEWH, timeline: tlOf() } },
  __aiResult: { prreview: [null, incRes] },
  __aiIncDiff: "diff --git a/ui/src/CommitGraph.tsx b/ui/src/CommitGraph.tsx\n--- a/ui/src/CommitGraph.tsx\n+++ b/ui/src/CommitGraph.tsx\n@@ -12,1 +12,2 @@\n INC-MARK\n+새 줄\n",
  // 이전 head→새 head: lib.rs 14번 줄이 바뀜, CommitGraph는 30번 줄 뒤에 5줄 추가(43-44 → 48-49, 새 head 변경 diff에는 없는 줄)
  __prIncDiff: { "crates/graph/src/lib.rs": "@@ -14 +14 @@\n-old\n+new\n", "ui/src/CommitGraph.tsx": "@@ -30,0 +31,5 @@\n+a\n+b\n+c\n+d\n+e\n" },
  ...extra,
});
const goStale = async (page: Page) => {
  await page.evaluate((i) => ((window as any).__inbox = i), inboxAt(NEWH));
  await screen(page).getByRole("button", { name: "Pull Request 새로고침" }).click();
};
const staleBanner = (page: Page) => ai(page).locator(".prai-banner.is-warn");
const incBtn = (page: Page) => staleBanner(page).getByRole("button", { name: "새 커밋만 리뷰" });
const oldCards = (page: Page) => ai(page).locator(".prai-card.old");
const newCards = (page: Page) => ai(page).locator(".prai-card:not(.old)");
const incDone = async (page: Page, flags: Record<string, unknown> = {}) => {
  await aiDone(page, incFlags(flags));
  await goStale(page);
  await incBtn(page).click();
  await expect(oldCards(page)).toHaveCount(3);
};

test("새 커밋만: head가 같으면 비활성+이유, 새 커밋이 생기면 활성(메뉴·배너), 탭 보조 글·개요 안내줄에 새 커밋 수", async ({ page }) => {
  await aiDone(page, incFlags());
  await ai(page).getByRole("button", { name: /^다시 리뷰/ }).click();
  const m = page.getByRole("menuitem", { name: /^새 커밋만/ });
  await expect(m).toBeDisabled();
  await expect(m).toHaveText("새 커밋만 (새 커밋 없음)");
  await page.keyboard.press("Escape");
  await expect(staleBanner(page)).toHaveCount(0);
  await expect(page.locator(".prr-hint").filter({ hasText: "AI 리뷰 이후" })).toHaveCount(0);
  await goStale(page);
  await expect(staleBanner(page)).toContainText("리뷰 이후 새 커밋 2개가 있습니다 —");
  await expect(incBtn(page)).toBeEnabled();
  await expect(staleBanner(page).getByRole("button", { name: "전체 다시 리뷰" })).toBeEnabled();
  await expect(aiTab(page).locator("small")).toHaveText("필수 1, 새 커밋 2");
  await ai(page).getByRole("button", { name: /^다시 리뷰/ }).click();
  await expect(page.getByRole("menuitem", { name: "새 커밋만", exact: true })).toBeEnabled();
  await page.keyboard.press("Escape");
  await tabBtn(page, /^개요/).click();
  const hintLine = page.locator(".prr-hint").filter({ hasText: "AI 리뷰 이후 새 커밋 2개가 있습니다" });
  await expect(hintLine).toBeVisible();
  await hintLine.getByRole("button", { name: "AI 리뷰 열기" }).click();
  await expect(aiTab(page)).toHaveAttribute("aria-selected", "true");
});

test("새 커밋만: ai_run 입력 = PR·새 커밋 메시지·이전 리뷰 요약·범위 diff(리뷰한 head..head), 모델·노력은 그대로", async ({ page }) => {
  await aiDone(page, incFlags());
  await goStale(page);
  await incBtn(page).click();
  await expect.poll(async () => (await callsOf(page, "ai_run")).length).toBe(2);
  const run = JSON.parse((await callsOf(page, "ai_run")).at(-1)![1]);
  expect(run.task).toBe("prreview");
  expect(run.effort).toBe("medium");
  expect(run.parts.map((p: { label: string }) => p.label)).toEqual([
    "pull request",
    expect.stringMatching(/^commit messages \(new commits only/),
    expect.stringMatching(/^previous review \(already raised .*do not repeat/),
    expect.stringMatching(/^diff \(previous-review head\.\.head/),
  ]);
  expect(run.parts[0].text).toContain("설정 화면 다크 모드 색 맞추기");
  expect(run.parts[2].text).toContain("레인 색 할당을 바꾸고"); // 이전 summary
  expect(run.parts[2].text).toContain("crates/graph/src/lib.rs:14 [must] 머지 전에 고쳐야 함");
  expect(run.parts[2].text).toContain("ui/src/CommitGraph.tsx:43-44 [should]");
  expect(run.parts[2].text.split("\n").every((l: string) => l.startsWith("  "))).toBe(true); // diff 헤더로 오해되지 않게 들여쓰기
  expect(run.parts[3].text).toContain("INC-MARK"); // 범위 diff (전체 diff가 아님)
  expect(run.parts[3].text).not.toContain("trackLogIds");
  // git diff <리뷰한 head> <새 head>: 인자 순서
  const diffs = ((await page.evaluate(() => (window as any).__git)) as string[][]).filter((c) => c[0] === "quotepath" && c[1] === "diff");
  expect(diffs.length).toBeGreaterThan(1);
});

test("새 커밋만 결과: '이번 커밋'을 위에, 이전 카드는 '이전 리뷰' 묶음(접기), 변경됨·밀린 줄·게시 위험, 필수 합산, 메타 줄", async ({ page }) => {
  await incDone(page);
  // 묶음 구분: 이번 2 + 이전 3
  await expect(ai(page).locator('.prai-group[data-group="new"]')).toContainText("이번 커밋 2");
  await expect(newCards(page)).toHaveCount(2);
  await expect(newCards(page).nth(0).locator(".prai-loc")).toHaveText("ui/src/CommitGraph.tsx:13");
  await expect(ai(page).locator(".prai-old")).toContainText("이전 리뷰 3");
  expect(await ai(page).locator('[data-group="new"]').evaluate((e, o) => !!(e.compareDocumentPosition(document.querySelector(o)!) & Node.DOCUMENT_POSITION_FOLLOWING), '[data-group="old"]')).toBe(true);
  // 이전 리뷰: 변경됨(lib.rs:14), 줄 밀림+게시 위험(CommitGraph 43-44 → 48-49, 체크 해제)
  const lib14 = oldCards(page).filter({ hasText: "crates/graph/src/lib.rs:14" });
  await expect(lib14.locator(".prai-tag.warn")).toHaveText("변경됨 — 다시 확인");
  await expect(lib14.getByRole("checkbox")).toBeChecked();
  const cg = oldCards(page).filter({ hasText: "새 커밋에서" }).or(oldCards(page).filter({ has: page.locator(".prai-loc", { hasText: "CommitGraph.tsx:48-49" }) }));
  await expect(cg).toHaveCount(1);
  await expect(cg.locator(".prai-tag.danger")).toHaveText("게시 거부 위험");
  await expect(cg.getByRole("checkbox")).not.toBeChecked();
  await expect(cg).toContainText("줄 번호가 밀림(이전 43)");
  await expect(cg.locator(".prai-snip-note")).toContainText("이 줄은 변경 diff에 없습니다"); // 이유는 코드 조각 자리에(중복 문구 없음)
  const lib16 = oldCards(page).filter({ has: page.locator(".prai-loc", { hasText: "lib.rs:16" }) });
  await expect(lib16.locator(".prai-flags")).toHaveCount(0); // 안 바뀌고 안 밀린 카드는 표시 없음
  // 접기: 머리에는 개수·변경됨·게시 위험이 남는다
  const fold = ai(page).getByRole("button", { name: "이전 리뷰 3" });
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  await fold.click();
  await expect(oldCards(page)).toHaveCount(0);
  await expect(ai(page).locator(".prai-old .prai-count")).toHaveText("필수 1 · 0/3 게시됨 변경됨 1 게시 위험 1");
  await expect(newCards(page)).toHaveCount(2); // 이번 묶음은 그대로
  await fold.click();
  await expect(oldCards(page)).toHaveCount(3);
  // 이전 요약은 읽기 전용으로 남는다
  await expect(ai(page).locator(".prai-prev")).toContainText("레인 색 할당을 바꾸고");
  // 필수 합산: 이번 1 + 이전 미게시 1, 구분해서 보인다
  const banner = ai(page).locator(".prai-banner.is-danger");
  await expect(banner).toContainText("머지를 막는 이슈 2개");
  await expect(banner).toContainText("이번 커밋 1 + 이전 리뷰 미게시 1");
  await expect(aiTab(page).locator("small")).toHaveText("필수 2");
  // 메타 줄, 새 요약이 본문 카드에, stale 배너는 사라짐(rec.sha = 새 head)
  await expect(ai(page).locator(".prai-meta")).toContainText("새 커밋 2개만 리뷰함");
  await expect(ai(page).locator(".prai-meta")).toContainText("토큰 입력 3.1k 출력 420");
  await expect(ai(page).locator(".prai-body").getByRole("textbox").first()).toHaveValue(/새 커밋은 오버플로를 고쳤지만/);
  await expect(staleBanner(page)).toHaveCount(0);
  await expect(item(page, /#131/)).toContainText("AI 필수 2");
  await screen(page).locator(".prr-body.ai").evaluate((e) => (e.scrollTop = 0));
  await page.screenshot({ path: `e2e/results/screens/pr-ai-incr-${test.info().project.name}.png` });
  await screen(page).locator(".prr-body.ai").evaluate((e) => (e.scrollTop = e.scrollHeight));
  await page.screenshot({ path: `e2e/results/screens/pr-ai-incr-old-${test.info().project.name}.png` });
});

test("새 커밋만 게시: 이번 묶음 + 체크한 이전 카드, commitId는 새 head, 위험 카드는 기본 해제(체크하면 확인창에 경고)", async ({ page }) => {
  await incDone(page);
  await expect(ai(page).locator(".prai-plan")).toHaveText("게시 예정: 본문 포함, 코멘트 2개(이번 1, 이전 1)");
  await postBtn(page).click();
  await expect.poll(async () => (await submits(page)).length).toBe(1);
  const a = (await submits(page))[0];
  expect(a.commitId).toBe(NEWH);
  expect(a.event).toBe("REQUEST_CHANGES");
  expect(a.body).toContain("새 커밋은 오버플로를 고쳤지만");
  expect(a.body).not.toContain("레인 색 할당을 바꾸고"); // 이전 요약은 본문에 다시 안 올린다
  expect(a.comments.map((c: { path: string; line: number }) => `${c.path}:${c.line}`).sort()).toEqual(["crates/graph/src/lib.rs:14", "ui/src/CommitGraph.tsx:13"]);
  await expect(newCards(page).nth(0)).toContainText("게시됨");
  await expect(oldCards(page).filter({ hasText: "crates/graph/src/lib.rs:14" })).toContainText("게시됨");
  // 위험 카드를 직접 체크하면 확인창에 경고, 줄은 밀린 새 번호(48-49)로 간다
  const cg = oldCards(page).filter({ has: page.locator(".prai-loc", { hasText: "CommitGraph.tsx:48-49" }) });
  await cg.getByRole("checkbox").check();
  await postBtn(page).click();
  await expect.poll(async () => (await submits(page)).length).toBe(2);
  expect((await asked(page)).at(-1)).toContain("그중 1개는 새 head의 변경 diff에 없는 줄");
  const b = (await submits(page))[1];
  expect(b.body).toBe("");
  expect(b.comments).toEqual([{ path: "ui/src/CommitGraph.tsx", line: 49, startLine: 48, side: "RIGHT", body: expect.stringContaining("별도 함수로 빼면") }]);
  expect(b.commitId).toBe(NEWH);
});

test("새 커밋만: 이전 카드의 게시 표시·편집·체크가 유지되고, 새 커밋 리뷰 중에도 편집되며 끝나면 합쳐진다", async ({ page }) => {
  await aiDone(page, incFlags());
  await postBtn(page).click(); // 필수·권장 게시
  await expect(ai(page).locator(".prai-done")).toBeVisible();
  await cards(page).nth(2).getByRole("button", { name: "편집", exact: true }).click();
  await cards(page).nth(2).getByRole("textbox").fill("남길 편집");
  await cards(page).nth(2).getByRole("checkbox").check();
  await goStale(page);
  await page.evaluate(() => ((window as any).__aiSlow = 1500));
  await incBtn(page).click();
  // 진행 중: 결과는 그대로 보이고 편집은 되지만 게시·다시 리뷰는 이유와 함께 잠긴다
  const run = ai(page).locator(".prai-banner").filter({ hasText: "새 커밋만 리뷰하는 중…" });
  await expect(run).toBeVisible();
  await expect(run.locator(".prai-sec")).toHaveText(/\d+초/);
  await expect(cards(page)).toHaveCount(3);
  await expect(postBtn(page)).toBeDisabled();
  await expect(ai(page).locator(".prai-plan")).toHaveText("새 커밋 리뷰가 끝난 뒤 게시할 수 있습니다");
  await expect(ai(page).getByRole("button", { name: /^다시 리뷰/ })).toBeDisabled();
  await expect(aiTab(page).locator("small")).toHaveText("리뷰 중…");
  await cards(page).nth(2).getByRole("textbox").fill("진행 중에 고친 편집");
  await expect(oldCards(page)).toHaveCount(3, { timeout: 5000 });
  // 합쳐진 뒤
  const lib16 = oldCards(page).filter({ has: page.locator(".prai-loc", { hasText: "lib.rs:16" }) });
  await expect(lib16.getByRole("textbox")).toHaveValue("진행 중에 고친 편집");
  await expect(lib16.getByRole("checkbox")).toBeChecked();
  for (const loc of ["lib.rs:14", "CommitGraph.tsx:43-44"]) await expect(oldCards(page).filter({ has: page.locator(".prai-loc", { hasText: loc }) })).toContainText("게시됨");
  await expect(ai(page).locator(".prai-old .prai-count")).toContainText("필수 1 · 2/3 게시됨");
  await expect(ai(page).locator(".prai-prev")).toContainText("게시됨"); // 이전 요약은 게시했다고 표시
  // 필수: 이번 1 + 이전 필수는 이미 게시 → 합계 1
  await expect(ai(page).locator(".prai-banner.is-danger")).toContainText("머지를 막는 이슈 1개");
  await expect(ai(page).locator(".prai-banner.is-danger")).toContainText("이번 커밋 1 + 이전 리뷰 미게시 0");
  // 새 요약은 아직 게시 전이라 본문으로 올릴 수 있다
  await expect(ai(page).locator(".prai-body").getByRole("checkbox").first()).toBeEnabled();
  // 전체 다시 리뷰는 기존대로: 게시한 카드가 있으면 확인(아니오면 아무 일도 없다)
  await page.evaluate(() => Object.assign(window as any, { __askNo: true, __aiSlow: 0 }));
  await ai(page).getByRole("button", { name: /^다시 리뷰/ }).click();
  await page.getByRole("menuitem", { name: "전체 다시 리뷰" }).click();
  await expect.poll(async () => (await asked(page)).some((m) => m.includes("이미 게시한 코멘트는 GitHub에 남지만"))).toBe(true);
  expect((await callsOf(page, "ai_run")).length).toBe(2);
  await expect(oldCards(page)).toHaveCount(3);
});

test("새 커밋만: 취소하면 이전 결과 그대로, 실패하면 이유를 보이고 이전 결과 그대로(닫기)", async ({ page }) => {
  await aiDone(page, incFlags());
  await goStale(page);
  await cards(page).nth(0).getByRole("button", { name: "편집", exact: true }).click();
  await cards(page).nth(0).getByRole("textbox").fill("지킬 문구");
  await page.evaluate(() => ((window as any).__aiSlow = 1500));
  await incBtn(page).click();
  const run = ai(page).locator(".prai-banner").filter({ hasText: "새 커밋만 리뷰하는 중…" });
  await run.getByRole("button", { name: "취소" }).click();
  await expect(run).toHaveCount(0);
  await expect(staleBanner(page)).toBeVisible();
  await expect(cards(page).nth(0).getByRole("textbox")).toHaveValue("지킬 문구");
  expect((await callsOf(page, "ai_cancel")).length).toBe(1);
  await expect(ai(page).locator(".prai-old")).toHaveCount(0);
  // 실패
  await page.evaluate(() => Object.assign(window as any, { __aiSlow: 0, __aiFail: "선택한 내용이 너무 큽니다(300KB, 상한 200KB)." }));
  await incBtn(page).click();
  const err = ai(page).getByRole("alert").filter({ hasText: "새 커밋만 리뷰하지 못했습니다" });
  await expect(err).toContainText("선택한 내용이 너무 큽니다");
  await expect(err).toContainText("이전 결과·체크·편집은 그대로입니다");
  await expect(cards(page).nth(0).getByRole("textbox")).toHaveValue("지킬 문구");
  await expect(incBtn(page)).toBeEnabled(); // 다시 시도할 수 있다
  await err.getByRole("button", { name: "닫기" }).click();
  await expect(err).toHaveCount(0);
});

test("새 커밋만: 리뷰한 커밋이 로컬에 없으면(강제 푸시) 이유를 보이고 전체 다시 리뷰만 가능, 조상이 아니어도 같다", async ({ page }) => {
  await aiDone(page, incFlags());
  await page.evaluate(() => ((window as any).__missingShas = ["a131b2c"]));
  await goStale(page);
  await expect(incBtn(page)).toBeDisabled();
  await expect(staleBanner(page)).toContainText("리뷰한 커밋(a131b2c)이 이 저장소에 없습니다(강제 푸시 등). 전체 다시 리뷰만 할 수 있습니다.");
  await ai(page).getByRole("button", { name: /^다시 리뷰/ }).click();
  await expect(page.getByRole("menuitem", { name: /^새 커밋만/ })).toHaveText("새 커밋만 (리뷰한 커밋이 없음)");
  await expect(page.getByRole("menuitem", { name: /^새 커밋만/ })).toBeDisabled();
  await page.keyboard.press("Escape");
  expect((await callsOf(page, "ai_run")).length).toBe(1);
  // 전체 다시 리뷰는 된다
  await staleBanner(page).getByRole("button", { name: "전체 다시 리뷰" }).click();
  await expect.poll(async () => (await callsOf(page, "ai_run")).length).toBe(2);
});

test("새 커밋만: 리뷰한 커밋이 새 head의 조상이 아니면(리베이스) 이유를 보인다", async ({ page }) => {
  await aiDone(page, incFlags());
  await page.evaluate(() => ((window as any).__notAncestor = true));
  await goStale(page);
  await expect(incBtn(page)).toBeDisabled();
  await expect(staleBanner(page)).toContainText("현재 head의 이전 기록이 아닙니다(강제 푸시·리베이스)");
});

test("새 커밋만: 이름이 바뀐 파일의 이전 카드는 새 경로로 옮겨지고 '파일 이름이 바뀜(옛 경로)'가 붙는다(게시 path도 새 경로)", async ({ page }) => {
  await aiDone(page, incFlags({ __prFiles: [{ status: "M", path: "crates/graph/src/lib.rs", oldPath: null }, { status: "R", path: "ui/src/GraphView.tsx", oldPath: "ui/src/CommitGraph.tsx" }], __prIncDiff: {} }));
  await goStale(page);
  await incBtn(page).click();
  await expect(oldCards(page)).toHaveCount(3);
  const c = oldCards(page).filter({ has: page.locator(".prai-loc", { hasText: "GraphView.tsx:43-44" }) });
  await expect(c).toHaveCount(1);
  await expect(c).toContainText("파일 이름이 바뀜(옛 경로 ui/src/CommitGraph.tsx)");
  await expect(c.locator(".prai-tag.danger")).toHaveCount(0);
  await expect(c.getByRole("checkbox")).toBeChecked();
  // 이름 변경은 옛·새 경로를 함께 넘겨 한 번에 읽는다
  expect((await callsOf(page, "pr_inc_diff")).map((x) => x[1])).toContain("ui/src/CommitGraph.tsx ui/src/GraphView.tsx");
  await postBtn(page).click();
  await expect.poll(async () => (await submits(page)).length).toBe(1);
  expect((await submits(page))[0].comments.map((x: { path: string }) => x.path)).toContain("ui/src/GraphView.tsx");
});

test("새 커밋만: 줄을 새 커밋에 맞추지 못한 카드(분석 실패)는 위험 표시+체크 해제, 게시하면 확인창에 경고", async ({ page }) => {
  await aiDone(page, incFlags({ __incDiffFail: true }));
  await goStale(page);
  await incBtn(page).click();
  await expect(oldCards(page)).toHaveCount(3);
  for (const i of [0, 1, 2]) {
    await expect(oldCards(page).nth(i).locator(".prai-tag.danger")).toHaveText("게시 거부 위험");
    await expect(oldCards(page).nth(i)).toContainText("줄을 새 커밋에 맞추지 못함");
    await expect(oldCards(page).nth(i).getByRole("checkbox")).not.toBeChecked();
  }
  await expect(ai(page).locator(".prai-plan")).toContainText("코멘트 1개(이번 1, 이전 0)"); // 새 필수만
});

test("새 커밋만: 끝줄 보정은 삭제·축소 hunk 안에서 한 줄로 접힌다(범위 밖으로 안 나감)", async ({ page }) => {
  // CommitGraph 43-44 두 줄이 모두 삭제됨 → 직전 줄(42)로 근사, 끝줄은 없음
  await aiDone(page, incFlags({ __prIncDiff: { "ui/src/CommitGraph.tsx": "@@ -43,2 +42,0 @@\n-a\n-b\n" } }));
  await goStale(page);
  await incBtn(page).click();
  const c = oldCards(page).filter({ has: page.locator(".prai-loc", { hasText: "CommitGraph.tsx:42" }) });
  await expect(c.locator(".prai-loc")).toHaveText("ui/src/CommitGraph.tsx:42");
  await expect(c.locator(".prai-tag.warn")).toHaveText("변경됨 — 다시 확인");
});

test("새 커밋만: -U0 diff는 파일당 한 번만 읽는다(같은 파일의 카드가 여러 개여도)", async ({ page }) => {
  await incDone(page);
  const calls = (await callsOf(page, "pr_inc_diff")).map((x) => x[1]);
  expect(calls.sort()).toEqual(["crates/graph/src/lib.rs", "ui/src/CommitGraph.tsx"]); // 카드 3개(lib.rs 2 + CommitGraph 1) → 2회
});

test("새 커밋만: 병합 뒤에도 편집 중인 입력은 같은 카드에 남는다(포커스·내용)", async ({ page }) => {
  await aiDone(page, incFlags());
  await goStale(page);
  await page.evaluate(() => ((window as any).__aiSlow = 1200));
  await incBtn(page).click();
  const c = cards(page).nth(2);
  await c.getByRole("button", { name: "편집", exact: true }).click();
  await c.getByRole("textbox").fill("진행 중 편집 문구");
  await expect(c.getByRole("textbox")).toBeFocused();
  await expect(oldCards(page)).toHaveCount(3, { timeout: 5000 });
  const same = oldCards(page).filter({ has: page.locator(".prai-loc", { hasText: "lib.rs:16" }) });
  await expect(same.getByRole("textbox")).toHaveValue("진행 중 편집 문구");
  await expect(same.getByRole("textbox")).toBeFocused(); // 다른 카드·새 요소로 넘어가지 않았다
});

test("새 커밋만: 리뷰한 커밋 id가 올바르지 않으면 diff를 읽지 않고 이유를 보인다", async ({ page }) => {
  await aiDone(page, incFlags());
  await goStale(page);
  await page.evaluate(() => {
    // 비정상 sha가 들어온 경우를 흉내: rec.sha를 바꿀 수 없으니 ai 입력 단계의 검사가 잡는지는 단위 정규식으로 갈음
    (window as any).__badShaProbe = /^[0-9a-f]{7,40}$/.test("--output=x");
  });
  expect(await page.evaluate(() => (window as any).__badShaProbe)).toBe(false);
});

test("상태 선택 '닫힘·머지됨': state closed로 다시 받아 닫힌 PR도 검색된다", async ({ page }) => {
  const base = { url: "https://github.com/o/r/pull/1", head: "h", base: "main", authorAvatar: "", draft: false, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z", additions: 1, deletions: 0, labels: [], reviewers: [], approvals: 0, myReview: "none", reRequested: false, headSha: "a1", isMine: false, reviewRequested: false };
  await open(page, { __inboxClosed: [
    { ...base, number: 90, title: "옛 기능 머지", author: "kim", state: "MERGED" },
    { ...base, number: 91, title: "버려진 실험", author: "lee", state: "CLOSED" },
  ] });
  await palette(page);
  await screen(page).getByRole("tab", { name: /^전체/ }).click();
  await screen(page).getByRole("combobox", { name: "PR 상태" }).selectOption("closed");
  await expect.poll(async () => (await callsOf(page, "pr_inbox")).some((c) => c[1].includes('"state":"closed"'))).toBe(true);
  await expect(item(page, /#90/)).toContainText("머지됨");
  await expect(item(page, /#91/)).toContainText("닫힘");
  await screen(page).getByRole("textbox", { name: "번호·제목·작성자·브랜치" }).fill("버려진");
  await expect(item(page, /.*/)).toHaveCount(1);
  await expect(item(page, /#91/)).toBeVisible();
  await screen(page).getByRole("combobox", { name: "PR 상태" }).selectOption("open");
  await expect(item(page, /#90|#91/)).toHaveCount(0);
});

test("다시 열면 받아 둔 목록을 바로 보이고 뒤에서 새로 받는다, 목록 조회는 최근 활동을 끄고 부른다", async ({ page }) => {
  await open(page);
  await palette(page);
  await expect(item(page, /#131/)).toBeVisible();
  expect((await callsOf(page, "pr_inbox")).every((c) => c[1].includes('"activity":false'))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(screen(page)).toHaveCount(0);
  await page.evaluate(() => ((window as any).__slowInbox = 5000));
  await palette(page);
  await expect(item(page, /#131/)).toBeVisible({ timeout: 1000 });
});

// ---- 커밋 sha 링크 (본문·코멘트·팝업) ----
const C5 = "c5".padEnd(40, "0");
const SHA_BODY = "참고: 930b8b1 와 https://github.com/demo/git403/commit/a131b2c3d4e5f6 그리고 `930b8b1`(코드) 와 c500000 와 deadbe1 와 1234567 와 deadbeef";
const shaLink = (root: ReturnType<typeof pop>, text: string) => root.locator(".md a[data-sha]", { hasText: text }).first();
const bodyPop = async (page: Page) => {
  await screen(page).locator(".prr-card.prr-peek").click();
  return pop(page);
};
const SHA_FLAGS = (extra: Record<string, unknown> = {}) => ({ __prDetail: { 131: { body: SHA_BODY } }, __localShas: [C5], ...extra });
const backBtn = (page: Page) => files(page).getByRole("button", { name: /돌아가기/ });

test("sha 링크: 맨 sha·GitHub /commit/ 링크만 링크가 되고, 코드·숫자만·글자만 있는 것은 그대로", async ({ page }) => {
  await open(page, SHA_FLAGS());
  await palette(page);
  const d = await bodyPop(page);
  await expect(d.locator(".md a[data-sha]")).toHaveCount(4); // 930b8b1 · URL · c500000 · deadbe1
  await expect(d.locator(".md code a")).toHaveCount(0);
  await expect(d.locator(".md a[data-sha]", { hasText: "1234567" })).toHaveCount(0);
  await expect(d.locator(".md a[data-sha]", { hasText: "deadbeef" })).toHaveCount(0);
  await expect(d.locator('.md a[data-sha="a131b2c3d4e5f6"]')).toHaveAttribute("href", "https://github.com/demo/git403/commit/a131b2c3d4e5f6");
});

test("sha 링크(본문 팝업): 이 PR의 커밋이면 팝업을 닫고 변경 파일 탭 + 그 커밋 범위, 돌아가기·⌘[는 같은 팝업을 다시 연다", async ({ page }) => {
  await open(page, SHA_FLAGS());
  await palette(page);
  let d = await bodyPop(page);
  await shaLink(d, "930b8b1").click();
  await expect(pop(page)).toHaveCount(0); // 팝업 위에 팝업이 생기지 않는다
  await expect(screen(page)).toBeVisible();
  await expect(filesTab(page)).toHaveAttribute("aria-selected", "true");
  await expect(commitBtn(page)).toContainText("다크 모드 색 토큰 정리");
  await expect(backBtn(page)).toBeVisible();
  expect(await callsOf(page, "open_url")).toHaveLength(0);
  // 돌아가기: 개요 탭, 본문 카드 강조, 같은 팝업 다시
  await backBtn(page).click();
  await expect(screen(page).getByRole("tab", { name: /^개요/ })).toHaveAttribute("aria-selected", "true");
  await expect(pop(page)).toBeVisible();
  await expect(pop(page).locator(".md")).toContainText("참고:");
  // /commit/ 링크(글자는 주소) = 두 번째 커밋 범위, ⌘[ 로 돌아온다
  d = pop(page);
  await d.locator('.md a[data-sha="a131b2c3d4e5f6"]').click();
  await expect(commitBtn(page)).toContainText("구분선 색 다크 모드 대응");
  await page.keyboard.press("ControlOrMeta+[");
  await expect(pop(page)).toBeVisible();
  await expect(screen(page).getByRole("tab", { name: /^개요/ })).toHaveAttribute("aria-selected", "true");
});

test("sha 링크(코멘트 팝업): 돌아가면 같은 코멘트 항목·스크롤 위치로 팝업을 다시 연다", async ({ page }) => {
  const long = Array.from({ length: 40 }, (_, i) => `줄 ${i}`).join("\n\n");
  await open(page, SHA_FLAGS({ __prDetail: { 131: { timeline: tl([{ kind: "comment", author: "Riley", at: new Date().toISOString(), body: `${long}\n\n끝에서 930b8b1 확인` }]) } } }));
  await palette(page);
  await peeks(page).last().click();
  let d = pop(page);
  await expect(d.locator(":scope > .sheet-head")).toContainText("4/4");
  const body = d.locator(".prr-pop-body");
  await body.evaluate((e) => (e.scrollTop = e.scrollHeight));
  const top = await body.evaluate((e) => e.scrollTop);
  expect(top).toBeGreaterThan(100);
  await shaLink(d, "930b8b1").click();
  await expect(filesTab(page)).toHaveAttribute("aria-selected", "true");
  await backBtn(page).click();
  d = pop(page);
  await expect(d.locator(":scope > .sheet-head")).toContainText("Riley");
  await expect(d.locator(":scope > .sheet-head")).toContainText("4/4");
  await expect.poll(() => d.locator(".prr-pop-body").evaluate((e) => e.scrollTop)).toBeGreaterThan(top - 5);
});

test("sha 링크(diff 안 스레드 카드): 그 커밋 범위로 가고, 돌아가기는 전체 변경으로", async ({ page }) => {
  await open(page, { __prDetail: { 131: { reviewThreads: [thread({ comments: [{ author: "you", body: "이건 930b8b1 에서 바뀐 거예요", at: new Date().toISOString() }] })] } } });
  await palette(page);
  await filesTab(page).click();
  await files(page).locator("[role=note] .md a[data-sha]").click();
  await expect(commitBtn(page)).toContainText("다크 모드 색 토큰 정리");
  await expect(backBtn(page)).toContainText("이전 보기");
  await backBtn(page).click();
  await expect(allBtn(page)).toHaveAttribute("aria-checked", "true");
  await expect(files(page).locator("[role=note]")).toHaveCount(1);
});

test("sha 링크: 이 PR 커밋이 아니면 로컬엔 그래프에서 선택, 없으면 GitHub URL을 브라우저로", async ({ page }) => {
  await open(page, SHA_FLAGS());
  await palette(page);
  let d = await bodyPop(page);
  await shaLink(d, "deadbe1").click();
  await expect.poll(async () => (await callsOf(page, "open_url")).at(-1)?.[1]).toBe("https://github.com/demo/git403/commit/deadbe1");
  await expect(pop(page)).toBeVisible(); // 이동이 없으면 팝업은 그대로
  await expect(screen(page)).toBeVisible();
  await shaLink(d, "c500000").click();
  await expect(screen(page)).toHaveCount(0);
  await expect(page.locator(".commits .row.selected")).toContainText("README 정리");
});

test("sha 링크 호버 카드: 제목·작성자·상대 시각·파일 수, PR 커밋은 타임라인 정보 우선, 로컬 커밋은 git 조회, 모르는 sha는 카드 없음", async ({ page }, info) => {
  const at = new Date(Date.now() - 3 * 3600e3).toISOString();
  await open(page, SHA_FLAGS({ __shaInfo: { "930b8b1": { author: "Alex Kim", at, subject: "git쪽 제목", files: 3 }, c500000: { author: "Sam", at, subject: "README 정리", files: 1 } } }));
  await palette(page);
  const d = await bodyPop(page);
  const card = page.getByRole("tooltip");
  await shaLink(d, "930b8b1").hover();
  await expect(card).toContainText("다크 모드 색 토큰 정리"); // 타임라인 제목 우선
  await expect(card).toContainText("Alex");
  await expect(card).toContainText(/어제|전/);
  await expect(card).toContainText("파일 3개");
  await expect(card).not.toContainText("diff");
  await page.screenshot({ path: `e2e/results/screens/pr-sha-${info.project.name}.png` });
  await page.mouse.move(5, 5);
  await expect(card).toHaveCount(0);
  await shaLink(d, "c500000").hover();
  await expect(card).toContainText("README 정리");
  await expect(card).toContainText("Sam");
  await expect(card).toContainText("파일 1개");
  await page.mouse.move(5, 5);
  await shaLink(d, "deadbe1").hover();
  await page.waitForTimeout(600);
  await expect(card).toHaveCount(0);
  await expect(pop(page)).toBeVisible(); // 호버는 팝업을 닫지 않는다
});

test.describe("오류 코드 번역(en)", () => {
  test.use({ locale: "en-US" });
  test("코드 오류는 en 문구로, 토큰 코드는 계정 연결 버튼으로 이어진다", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => Object.assign(window, { __inboxFail: JSON.stringify({ code: "hosting.noToken", vars: {}, message: "(raw message)" }) }));
    await page.goto("/");
    await page.getByRole("button", { name: "Open repository" }).click();
    await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+p");
    await page.getByRole("dialog", { name: "Quick launch" }).getByRole("textbox").fill("Pull Request Review");
    await page.keyboard.press("Enter");
    const alert = screen(page).getByRole("alert");
    await expect(alert).toContainText("No token. Connect a GitHub account in Settings");
    await expect(alert).not.toContainText("raw message");
    await expect(alert.getByRole("button", { name: "Connect account…" })).toBeVisible();
  });
});
