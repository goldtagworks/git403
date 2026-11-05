import { expect, test, type Page } from "@playwright/test";

// AI 채팅 열(맨 오른쪽 독립 열). 백엔드는 mock(src/shared/api/mock.ts)이고 가짜 이벤트 스트림을 흘린다.
// Rust 쪽(실행기·이력·백업)은 crates 테스트, 실제 앱 흐름은 e2e/app/run.mjs가 검증한다.
const calls = (page: Page) => page.evaluate(() => (window as any).__git as string[][]);
const callsOf = async (page: Page, name: string) => (await calls(page)).filter((c) => c[0] === name);
const col = (page: Page) => page.getByRole("complementary", { name: "AI 채팅" });
const input = (page: Page) => col(page).getByRole("textbox", { name: "AI에게 보낼 메시지" });
const open = async (page: Page, flags: Record<string, unknown> = {}, extra = () => {}) => {
  await page.addInitScript((f) => Object.assign(window, { __asked: [], __ai: { consent: true } }, f), flags);
  await page.addInitScript(extra);
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
};
const toggle = (page: Page) => page.keyboard.press("ControlOrMeta+j");
const send = async (page: Page, text: string) => {
  await input(page).fill(text);
  await input(page).press("Enter");
};
const done = (page: Page) => expect(col(page).getByRole("button", { name: "이 작업 되돌리기" })).toBeVisible();

test("⌘J로 열고 닫고, 저장소별로 열림을 기억한다", async ({ page }) => {
  await open(page);
  await expect(col(page)).toHaveCount(0);
  await toggle(page);
  await expect(col(page)).toBeVisible();
  await page.reload(); // 탭 복원으로 같은 저장소가 다시 열린다
  await expect(col(page)).toBeVisible(); // 열림을 기억한다
  await col(page).getByRole("button", { name: "AI 채팅 닫기" }).click();
  await expect(col(page)).toHaveCount(0);
  await toggle(page);
  await expect(col(page)).toBeVisible();
  // 빠른 실행에도 있다
  await toggle(page);
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("dialog", { name: "빠른 실행" }).getByRole("textbox").fill("AI 채팅");
  await page.getByRole("dialog", { name: "빠른 실행" }).getByRole("option", { name: /AI 채팅 열기·닫기/ }).click();
  await expect(col(page)).toBeVisible();
  // 툴바 버튼으로도 열고 닫는다
  const btn = page.locator(".toolbar").getByRole("button", { name: "AI 채팅", exact: true });
  await btn.click();
  await expect(col(page)).toHaveCount(0);
  await btn.click();
  await expect(col(page)).toBeVisible();
});

test("보내면 입력·AI 글·도구 줄이 스트림으로 나오고, 도구는 접힌 한 줄이며 펼치면 출력이 보인다", async ({ page }) => {
  await open(page);
  await toggle(page);
  await input(page).fill("원격 변경 가져와 줘");
  await input(page).press("Shift+Enter"); // 줄바꿈이지 전송이 아니다
  expect(await callsOf(page, "ai_chat_start")).toHaveLength(0);
  await input(page).fill("원격 변경 가져와 줘");
  await input(page).press("Enter");
  await expect(input(page)).toHaveValue("");
  await expect(col(page).getByText("원격 변경 가져와 줘")).toBeVisible();
  await expect(col(page).getByText("원격 변경을 가져옵니다.")).toBeVisible();
  const row = col(page).getByRole("button", { name: "Bash git pull --no-rebase origin main" });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("aria-expanded", "false");
  await expect(col(page).getByText("CONFLICT (content)")).toHaveCount(0);
  await row.click();
  await expect(col(page).getByText("CONFLICT (content): Merge conflict in a.txt")).toBeVisible();
  await done(page);
  const [start] = await callsOf(page, "ai_chat_start");
  expect(JSON.parse(start[1])).toMatchObject({ repo: "/demo/git403", input: "원격 변경 가져와 줘" });
  expect(JSON.parse(start[1]).sessionId).toBeUndefined();
});

test("동의가 없으면 OS 확인 후 이어서 보낸다", async ({ page }) => {
  await open(page, { __ai: { consent: false } });
  await toggle(page);
  await send(page, "상태 알려 줘");
  await expect(col(page).getByText("충돌을 해결하고 병합을 마쳤습니다.").first()).toBeVisible();
  expect((await page.evaluate(() => (window as any).__asked as string[])).some((m) => m.includes("Anthropic"))).toBe(true);
  expect((await callsOf(page, "ai_chat_start")).length).toBe(2); // 거부 → 동의 → 재시도
  expect((await callsOf(page, "ai_settings_set")).some((c) => c[1].includes('"consent":true'))).toBe(true);
});

test("동의를 거절하면 보내지 않는다", async ({ page }) => {
  await open(page, { __ai: { consent: false }, __askNo: true });
  await toggle(page);
  await send(page, "해 줘");
  await expect(input(page)).toBeEnabled();
  await expect(col(page).getByText("해 줘")).toHaveCount(0);
});

test("claude CLI가 없으면 설치 안내 오류를 보인다", async ({ page }) => {
  await open(page, { __chatFail: JSON.stringify({ code: "aiChat.cliMissing", vars: {}, message: "x" }) });
  await toggle(page);
  await send(page, "pull");
  await expect(col(page).getByRole("alert")).toContainText("https://claude.com/claude-code");
});

test("Read·Edit 파일 경로를 누르면 그 파일을 diff 화면에서 연다", async ({ page }) => {
  await open(page);
  await toggle(page);
  await send(page, "파일 봐 줘");
  await done(page);
  await col(page).getByRole("button", { name: "ui/src/Toolbar.tsx", exact: true }).click();
  await expect(page.getByRole("listbox", { name: "스테이지 안 됨" }).getByRole("option", { name: /Toolbar\.tsx/ })).toHaveAttribute("aria-selected", "true");
  await col(page).getByRole("button", { name: "crates/core/src/status.rs", exact: true }).click();
  await expect(page.getByRole("listbox", { name: "스테이지됨", exact: true }).getByRole("option", { name: /status\.rs/ })).toHaveAttribute("aria-selected", "true");
});

test("중지 버튼과 Esc가 진행 중인 대화를 취소한다", async ({ page }) => {
  await open(page, { __chatSlow: 400 });
  await toggle(page);
  await send(page, "오래 걸리는 일");
  await expect(col(page).getByRole("button", { name: "중지" })).toBeVisible();
  await col(page).getByRole("button", { name: "중지" }).click();
  await expect(col(page).getByText("중지했습니다.")).toBeVisible();
  expect(await callsOf(page, "ai_chat_cancel")).toHaveLength(1);
  await expect(col(page).getByRole("button", { name: "전송" })).toBeVisible();
  await send(page, "또 오래 걸리는 일");
  await expect(col(page).getByRole("button", { name: "중지" })).toBeVisible();
  await input(page).press("Escape");
  await expect(col(page).getByText("중지했습니다.")).toHaveCount(2);
  expect(await callsOf(page, "ai_chat_cancel")).toHaveLength(2);
});

test("이력: 제목은 첫 입력, 고르면 복원하고 마지막 sessionId로 이어 간다", async ({ page }) => {
  await open(page);
  await toggle(page);
  await send(page, "첫 번째 대화\n둘째 줄");
  await done(page);
  await col(page).getByRole("button", { name: "새 대화" }).click();
  await expect(col(page).getByText("첫 번째 대화")).toHaveCount(0);
  await send(page, "두 번째 대화");
  await done(page);
  await col(page).getByRole("button", { name: "새 대화" }).click();
  await col(page).getByRole("button", { name: "이력" }).click();
  const items = page.getByRole("menu").getByRole("menuitem");
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText("두 번째 대화"); // 최신순
  await items.nth(1).click();
  await expect(col(page).getByText("첫 번째 대화")).toBeVisible();
  await expect(col(page).getByRole("button", { name: "Bash git pull --no-rebase origin main" })).toBeVisible();
  await send(page, "이어서");
  await done(page);
  const starts = (await callsOf(page, "ai_chat_start")).map((c) => JSON.parse(c[1]));
  expect(starts[2]).toMatchObject({ input: "이어서", sessionId: "sess-1" });
  expect(starts[2].conversation).toBe(starts[0].conversation);
});

test("빈 입력이면 상태 기반 추천 칩이 뜨고, 누르면 입력란을 채운다", async ({ page }) => {
  await open(page);
  await toggle(page);
  const chip = col(page).getByRole("button", { name: "원격에서 pull" }); // mock 저장소는 원격보다 뒤처져 있다
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(input(page)).toHaveValue(/pull/);
  await expect(chip).toHaveCount(0); // 입력이 있으면 칩은 숨는다
});

test("merge가 충돌로 멈추면 실패 토스트에 'AI에게 맡기기', 열면 '충돌 해결하고 계속' 칩", async ({ page }) => {
  await open(page, { __gitFail: { prefix: "merge", conflict: true } });
  await page.locator(".sidebar").getByRole("button", { name: "pull-lock", exact: true }).click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "현재 브랜치에 머지…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "머지" }).click();
  await expect(page.locator(".toast").getByRole("button", { name: "AI에게 맡기기" })).toBeVisible();
  await page.evaluate(() => (window as any).__emit("repo-changed", { worktree: true, refs: true })); // 파일 감시가 하는 일
  await expect(page.locator(".banner.op")).toBeVisible();
  await toggle(page);
  await expect(col(page).getByRole("button", { name: "충돌 해결하고 계속" })).toBeVisible();
});

test("pull 실패 토스트의 'AI에게 맡기기'가 열을 열고 오류를 담은 새 대화를 시작한다", async ({ page }) => {
  await open(page, { __job: { err: "fatal: Not possible to fast-forward, aborting." } });
  await page.locator(".toolbar").getByRole("button", { name: "Pull", exact: true }).click();
  const toast = page.locator(".toast").filter({ hasText: "Pull 실패" });
  await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: "AI에게 맡기기" }).click();
  await expect(col(page)).toBeVisible();
  await expect(col(page).getByText(/Not possible to fast-forward/).first()).toBeVisible();
  const [start] = await callsOf(page, "ai_chat_start");
  expect(JSON.parse(start[1]).input).toContain("git pull");
  expect(JSON.parse(start[1]).input).toContain("Not possible to fast-forward");
});

test("끝나면 되돌리기 한 줄: OS 확인 후 백업으로 되돌리고, 진행 중인 작업이 있으면 중단 확인", async ({ page }) => {
  await open(page, { __restoreFail: { code: "aiBackup.operationInProgress", vars: { op: "merge" } } });
  await toggle(page);
  await send(page, "해 줘");
  await col(page).getByRole("button", { name: "이 작업 되돌리기" }).click();
  await expect(col(page).getByText("되돌렸습니다")).toBeVisible();
  const asked = await page.evaluate(() => (window as any).__asked as string[]);
  expect(asked.some((m) => m.includes("merge"))).toBe(true);
  const r = (await callsOf(page, "ai_backup_restore")).map((c) => JSON.parse(c[1]));
  expect(r).toEqual([{ id: "b1", branch: "main", abortOngoing: false, branches: false, wip: false, digest: "0123456789abcdef" }, { id: "b1", branch: "main", abortOngoing: true, branches: false, wip: false, digest: "0123456789abcdef" }]);
});

test("백업이 없으면(커밋 없는 저장소) 되돌리기 줄이 없다", async ({ page }) => {
  await open(page, { __chatNoBackup: true });
  await toggle(page);
  await send(page, "해 줘");
  await expect(col(page).getByRole("button", { name: "전송" })).toBeVisible();
  await expect(col(page).getByRole("button", { name: "이 작업 되돌리기" })).toHaveCount(0);
});

test("끝나면 그래프를 다시 읽고, 앱이 백그라운드면 OS 알림을 보낸다", async ({ page }) => {
  await open(page);
  await toggle(page);
  await page.evaluate(() => (document.hasFocus = () => false));
  const before = await page.evaluate(() => (window as any).__graphLoads ?? 0);
  await send(page, "해 줘");
  await done(page);
  await expect.poll(async () => (await callsOf(page, "notify")).length).toBe(1);
  expect((await callsOf(page, "notify"))[0][1]).toContain("AI 작업 완료");
  expect(await page.evaluate(() => (window as any).__graphLoads ?? 0)).toBeGreaterThan(before);
});

test("열이 닫혀 있어도 진행 중이면 상태바에 'AI 작업 중…', 누르면 열린다", async ({ page }) => {
  await open(page, { __chatSlow: 500 });
  await toggle(page);
  await send(page, "해 줘");
  await expect(page.locator(".statusbar").getByText("AI 작업 중…")).toHaveCount(0); // 열려 있으면 안 보인다
  await col(page).getByRole("button", { name: "AI 채팅 닫기" }).click();
  const item = page.locator(".statusbar").getByRole("button", { name: "AI 작업 중…" });
  await expect(item).toBeVisible();
  await item.click();
  await expect(col(page)).toBeVisible();
  await expect(item).toHaveCount(0);
});

test("설정 > AI: 대화 이력 저장·보관 기간·이 저장소 이력 지우기", async ({ page }) => {
  await open(page);
  await toggle(page);
  await send(page, "기록할 대화");
  await done(page);
  await page.keyboard.press("ControlOrMeta+,");
  const sheet = page.getByRole("dialog", { name: "설정" });
  await sheet.getByRole("tab", { name: "AI", exact: true }).click();
  const save = sheet.getByLabel("대화 이력 저장");
  await expect(save).toBeChecked();
  await save.uncheck();
  await expect.poll(async () => (await callsOf(page, "ai_chat_settings_set")).map((c) => c[1])).toContain('{"save":false}');
  await save.check();
  const days = sheet.getByLabel("보관 기간(일)");
  await expect(days).toHaveValue("90");
  await days.fill("0");
  await days.blur();
  await expect(sheet.getByRole("alert")).toContainText("1 이상");
  await days.fill("30");
  await days.blur();
  await expect.poll(async () => (await callsOf(page, "ai_chat_settings_set")).map((c) => c[1])).toContain('{"retentionDays":30}');
  await sheet.getByRole("button", { name: "이력 지우기" }).click();
  await expect.poll(async () => (await callsOf(page, "ai_history_clear")).length).toBe(1);
  expect((await page.evaluate(() => (window as any).__asked as string[])).some((m) => m.includes("이력을 모두 지울까요"))).toBe(true);
});

test.describe("좁은 창", () => {
  test.use({ viewport: { width: 1100, height: 720 } });
  test("상세가 오른쪽이면 상세 위에 겹쳐 열린다", async ({ page }) => {
    await open(page, {}, () => localStorage.setItem("detailLayout", '"right"'));
    await toggle(page);
    await expect(col(page)).toBeVisible();
    await expect(page.locator(".ai-wrap")).toHaveCSS("position", "absolute");
    const a = (await col(page).boundingBox())!, d = (await page.locator(".detail-col").boundingBox())!;
    expect(a.x + a.width).toBeCloseTo(d.x + d.width, 0); // 상세 열 오른쪽 끝과 맞닿아 위에 겹침
  });
  test("아래 배치면 겹치지 않고 옆에 붙는다", async ({ page }) => {
    await open(page);
    await toggle(page);
    await expect(page.locator(".ai-wrap")).toHaveCSS("position", "static");
  });
});

test.describe("넓은 창", () => {
  test.use({ viewport: { width: 1500, height: 800 } });
  test("상세가 오른쪽이어도 AI 열은 그 오른쪽에 독립으로 붙고, 너비를 끌어 조절한다", async ({ page }, info) => {
    await open(page, {}, () => localStorage.setItem("detailLayout", '"right"'));
    await toggle(page);
    await expect(page.locator(".ai-wrap")).toHaveCSS("position", "static");
    const a = (await col(page).boundingBox())!, d = (await page.locator(".detail-col").boundingBox())!;
    expect(a.x).toBeGreaterThanOrEqual(d.x + d.width - 1);
    const sp = (await page.locator(".ai-wrap > .splitter").boundingBox())!;
    await page.mouse.move(sp.x + 2, sp.y + 200);
    await page.mouse.down();
    await page.mouse.move(sp.x - 98, sp.y + 200, { steps: 5 });
    await page.mouse.up();
    expect((await col(page).boundingBox())!.width).toBeGreaterThan(a.width + 80);
    await send(page, "화면 확인용");
    await done(page);
    await col(page).getByRole("button", { name: "Edit /demo/git403/crates/core/src/status.rs" }).click().catch(() => {});
    await col(page).getByRole("button", { name: "Bash git pull --no-rebase origin main" }).click();
    await page.screenshot({ path: `e2e/results/screens/aichat-${info.project.name}.png` });
  });
});

test("모바일(Android)에는 열이 없다", async ({ browser }) => {
  const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 Chrome/124.0 Safari/537.36", viewport: { width: 900, height: 1200 }, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto("/");
  await page.keyboard.press("ControlOrMeta+j");
  await expect(page.getByRole("complementary", { name: "AI 채팅" })).toHaveCount(0);
  await ctx.close();
});

// ---- 위험 저장소 확인(공개·다수 협업자·판정 불가는 대화 첫 실행 전 OS 확인, 로컬 전용은 생략) ----
const confirmAsks = (page: Page) => page.evaluate(() => ((window as any).__asked as string[]).filter((m) => m.includes("허용된 git 명령")));
const riskCases: [string, Record<string, unknown>, RegExp][] = [
  ["공개 저장소", { __risk: { level: "public" } }, /공개 저장소입니다/],
  ["협업자가 여러 명인 저장소", { __risk: { level: "shared", collaborators: 3 } }, /협업자 3명과 공유/],
  ["판정 불가(호스팅 미연결)", { __risk: { level: "unknown" } }, /확인하지 못했습니다/],
  ["판정 불가(조회 실패)", { __riskFail: "network error" }, /확인하지 못했습니다/],
];
for (const [name, flags, why] of riskCases) {
  test(`${name}: 첫 실행 전에 이유와 범위를 담아 묻고, 이어 가기 차례는 다시 묻지 않는다`, async ({ page }) => {
    await open(page, flags);
    await toggle(page);
    await send(page, "상태 알려줘");
    await done(page);
    const asks = await confirmAsks(page);
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatch(why);
    expect(asks[0]).toContain("이 저장소 밖 파일 읽기·수정은 할 수 없습니다");
    expect(asks[0]).toContain("git 훅은 실행되지 않습니다");
    const [start] = await callsOf(page, "ai_chat_start");
    expect(JSON.parse(start[1]).confirmed).toBe(true);
    await send(page, "이어서");
    await expect.poll(async () => (await callsOf(page, "ai_chat_start")).length).toBe(2);
    await expect(col(page).getByRole("button", { name: "이 작업 되돌리기" })).toHaveCount(2);
    expect(await confirmAsks(page)).toHaveLength(1); // 이어 가기는 묻지 않는다
    expect(await callsOf(page, "ai_chat_risk")).toHaveLength(1);
  });
}

test("로컬 전용 저장소는 확인 없이 진행한다", async ({ page }) => {
  await open(page);
  await toggle(page);
  await send(page, "상태 알려줘");
  await done(page);
  expect(await confirmAsks(page)).toHaveLength(0);
  expect(await callsOf(page, "ai_chat_start")).toHaveLength(1);
});

test("확인을 거절하면 실행하지 않는다", async ({ page }) => {
  await open(page, { __risk: { level: "public" }, __askNo: true });
  await toggle(page);
  await send(page, "상태 알려줘");
  await expect.poll(async () => (await confirmAsks(page)).length).toBe(1);
  await expect(col(page).getByText("상태 알려줘")).toHaveCount(0); // 입력 줄도 거둔다
  expect(await callsOf(page, "ai_chat_start")).toHaveLength(0);
  await expect(input(page)).toBeEnabled();
});

test("이력 저장 실패 알림(note)은 토스트로 보인다", async ({ page }) => {
  await open(page, { __chatScript: [{ kind: "text", text: "끝" }, { kind: "note", code: "aiChat.historySaveFailed", message: "disk full" }, { kind: "done", sessionId: "s", result: "끝", isError: false }] });
  await toggle(page);
  await send(page, "해줘");
  await done(page);
  await expect(page.getByText("채팅을 이력에 저장하지 못했습니다")).toBeVisible();
});

test("저장소 쪽 git 설정에 안전 목록 밖 항목이 있으면 로컬 전용이어도 이유(키 이름)를 담아 묻는다", async ({ page }) => {
  await open(page, { __risk: { level: "none", config: ["diff.evil.textconv", "core.sshcommand"] } });
  await toggle(page);
  await send(page, "상태 알려줘");
  await done(page);
  const asks = await confirmAsks(page);
  expect(asks).toHaveLength(1);
  expect(asks[0]).toContain("diff.evil.textconv, core.sshcommand");
  expect(asks[0]).toContain("훅·외부 diff·textconv는 꺼지지만");
  expect(asks[0]).not.toContain("공개 저장소입니다");
  expect(JSON.parse((await callsOf(page, "ai_chat_start"))[0][1]).confirmed).toBe(true);
});

test("되돌리기: 다른 로컬 브랜치·작업 트리 스냅숏이 있으면 각각 한 번 더 묻고, 승낙한 것만 함께 되돌린다", async ({ page }) => {
  await open(page, { __chatHeads: 3, __chatWip: true });
  await toggle(page);
  await send(page, "정리해 줘");
  await done(page);
  await col(page).getByRole("button", { name: "이 작업 되돌리기" }).click();
  await expect.poll(async () => (await callsOf(page, "ai_backup_restore")).length).toBe(1);
  const asked = await page.evaluate(() => (window as any).__asked as string[]);
  expect(asked.some((m) => m.includes("다른 로컬 브랜치 위치도"))).toBe(true);
  expect(asked.some((m) => m.includes("커밋하지 않고 바꿔 두었던 파일도"))).toBe(true);
  expect(JSON.parse((await callsOf(page, "ai_backup_restore"))[0][1])).toMatchObject({ branches: true, wip: true });
});

test("되돌리기: 브랜치·스냅숏이 없으면 추가 질문 없이 HEAD만", async ({ page }) => {
  await open(page);
  await toggle(page);
  await send(page, "정리해 줘");
  await done(page);
  await col(page).getByRole("button", { name: "이 작업 되돌리기" }).click();
  await expect.poll(async () => (await callsOf(page, "ai_backup_restore")).length).toBe(1);
  const asked = await page.evaluate(() => (window as any).__asked as string[]);
  expect(asked.some((m) => m.includes("다른 로컬 브랜치 위치도") || m.includes("커밋하지 않고 바꿔 두었던 파일도"))).toBe(false);
  expect(JSON.parse((await callsOf(page, "ai_backup_restore"))[0][1])).toMatchObject({ branches: false, wip: false });
});

test("확인으로도 허용할 수 없는 저장소 설정(밖을 가리키는 worktree 등)은 묻지 않고 사유를 보이며 시작하지 않는다", async ({ page }) => {
  await open(page, { __risk: { level: "none", refuse: ["core.worktree points outside the repository folder (/etc)"] } });
  await toggle(page);
  await send(page, "상태 알려줘");
  await expect(col(page).getByRole("alert")).toContainText("git 설정 때문에 AI가 작업할 수 없습니다");
  await expect(col(page).getByRole("alert")).toContainText("core.worktree points outside");
  expect(await confirmAsks(page)).toHaveLength(0);
  expect(await callsOf(page, "ai_chat_start")).toHaveLength(0);
});

test("되돌리기는 백업의 지문을 함께 보낸다(백업 ref 변조 확인용)", async ({ page }) => {
  await open(page);
  await toggle(page);
  await send(page, "정리해 줘");
  await done(page);
  await col(page).getByRole("button", { name: "이 작업 되돌리기" }).click();
  await expect.poll(async () => (await callsOf(page, "ai_backup_restore")).length).toBe(1);
  expect(JSON.parse((await callsOf(page, "ai_backup_restore"))[0][1]).digest).toBe("0123456789abcdef");
});

test("AI 답의 링크는 실제 주소를 숨기지 않는다(호스트를 덧붙이고 title에 전체 주소)", async ({ page }) => {
  await open(page, { __chatScript: [{ kind: "text", text: "[여기 누르세요](https://evil.example/login?x=1) 그리고 https://github.com/o/r 와 [github.com 문서](https://github.com/docs) 그림 ![스크린샷](https://cdn.evil.example/a.png)" }, { kind: "done", sessionId: "s", result: "", isError: false }] });
  await toggle(page);
  await send(page, "링크 줘");
  await done(page);
  const a = col(page).locator(".ai-text a");
  await expect(a.nth(0)).toHaveText("여기 누르세요 (evil.example)");
  await expect(a.nth(0)).toHaveAttribute("title", "https://evil.example/login?x=1");
  await expect(a.nth(1)).toHaveText("https://github.com/o/r");
  await expect(a.nth(2)).toHaveText("github.com 문서");
  await expect(a.nth(3)).toHaveText("🖼 스크린샷 (cdn.evil.example)");
  await expect(a.nth(3)).toHaveAttribute("title", "https://cdn.evil.example/a.png");
});

test("샌드박스가 없는 플랫폼은 깨끗한 로컬 저장소도 경고 문단과 함께 매 대화 확인한다", async ({ page }) => {
  await open(page, { __risk: { level: "none", sandbox: "none" } });
  await toggle(page);
  await send(page, "상태 알려줘");
  await done(page);
  const asks = await confirmAsks(page);
  expect(asks).toHaveLength(1);
  expect(asks[0]).toContain("OS 샌드박스 안에서 실행할 수 없습니다");
  expect(asks[0]).toContain("신뢰하는 저장소에서만 계속하세요");
  await send(page, "이어서");
  await expect.poll(async () => (await callsOf(page, "ai_chat_start")).length).toBe(2);
  expect(await confirmAsks(page)).toHaveLength(1); // 이어 가기는 다시 묻지 않는다
});

test("샌드박스가 있으면(macOS·Linux) 추가 경고 없이 로컬 저장소는 확인 없이 진행한다", async ({ page }) => {
  await open(page, { __risk: { level: "none", sandbox: "seatbelt" } });
  await toggle(page);
  await send(page, "상태 알려줘");
  await done(page);
  expect(await confirmAsks(page)).toHaveLength(0);
});
