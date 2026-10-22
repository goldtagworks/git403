import { expect, test, type Page } from "@playwright/test";

// 로드맵 18단계: git 작업용 AI (커밋 메시지·코드 리뷰·충돌 도우미·PR 설명). 백엔드는 mock(src/mock.ts)이고 실제 API·CLI는 부르지 않는다.
// Rust 쪽(요청 바디·헤더·stop_reason·오류 매핑·CLI 파싱)은 crates/ai 테스트가 검증한다.
const calls = (page: Page) => page.evaluate(() => (window as any).__git as string[][]);
const callsOf = async (page: Page, name: string) => (await calls(page)).filter((c) => c[0] === name);
const runs = async (page: Page) => (await callsOf(page, "ai_run")).map((c) => JSON.parse(c[1]) as { task: string; repo?: string; parts: { label: string; text: string }[] });
const menuItem = (page: Page, name: string | RegExp) => page.getByRole("menu").getByRole("menuitem", { name, exact: typeof name === "string" });
const hasItem = (page: Page, name: string) => page.getByRole("menu").getByRole("menuitem", { name, exact: true }).count();
const sheet = (page: Page, name: string | RegExp) => page.getByRole("dialog", { name });
const ASK = "선택한 변경 내용과 저장소 규칙 문서가 전송됩니다(전송 대상: Anthropic)";
const open = async (page: Page, flags: Record<string, unknown> = {}) => {
  await page.addInitScript((f) => Object.assign(window, { __asked: [] }, f), flags);
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
};
/** 커밋 목록 맨 위(로컬 변경사항) 선택 */
const changes = async (page: Page) => {
  await page.locator(".commits").getByText("로컬 변경사항").click();
  await expect(page.getByRole("listbox", { name: "스테이지됨", exact: true })).toBeVisible();
};
const commitMenu = async (page: Page, subject = "로그 파서") => {
  const back = page.getByRole("button", { name: "← 그래프" }); // 넓은 변경 화면이면 그래프로 돌아온다
  if (await back.isVisible()) await back.click();
  await page.locator(".commits").getByText(subject).click({ button: "right" });
};
const consented = { __ai: { consent: true } };

test("메뉴 숨김: CLI도 키도 없으면 AI 메뉴·버튼이 없다", async ({ page }) => {
  await open(page, { __ai: { cli: false, key: false, consent: true } });
  await commitMenu(page);
  expect(await hasItem(page, "AI 리뷰…")).toBe(0);
  await page.keyboard.press("Escape");
  await page.locator(`.sidebar [title="feature/graph"]`).click({ button: "right" });
  expect(await hasItem(page, "AI 리뷰 (base 대비)…")).toBe(0);
  await page.keyboard.press("Escape");
  await changes(page);
  await expect(page.getByRole("button", { name: "AI로 작성" })).toHaveCount(0);
  // 빠른 실행에도 리뷰 항목이 없다 (AI 설정은 있다)
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("dialog", { name: "빠른 실행" }).getByRole("textbox").fill("AI");
  await expect(page.getByRole("dialog", { name: "빠른 실행" }).getByRole("option", { name: /AI 리뷰/ })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "빠른 실행" }).getByRole("option", { name: /AI 설정/ })).toBeVisible();
});

test("메뉴 표시: CLI만, 또는 키만 있어도 보인다", async ({ page }) => {
  await open(page, { __ai: { cli: false, key: true, consent: true } });
  await commitMenu(page);
  await expect(menuItem(page, "AI 리뷰…")).toBeVisible();
});

test("저장소별 끄기: git403.ai=false면 이 저장소에서 숨고, 설정에서 켜고 끌 수 있다", async ({ page }) => {
  await open(page, { ...consented, __issue: { "git403.ai": "false" } });
  await commitMenu(page);
  expect(await hasItem(page, "AI 리뷰…")).toBe(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+,");
  await sheet(page, "설정").getByRole("tab", { name: "AI", exact: true }).click();
  const off = sheet(page, "설정").getByLabel(/이 저장소에서 AI 끄기/);
  await expect(off).toBeChecked();
  await off.uncheck();
  await expect.poll(async () => (await callsOf(page, "config")).map((c) => c.join(" "))).toContain("config --local --unset git403.ai");
  await page.keyboard.press("Escape");
  await commitMenu(page);
  await expect(menuItem(page, "AI 리뷰…")).toBeVisible();
  await page.keyboard.press("Escape");
  // 다시 끈다 → git config --local git403.ai false
  await page.keyboard.press("ControlOrMeta+,");
  await sheet(page, "설정").getByLabel(/이 저장소에서 AI 끄기/).check();
  await expect.poll(async () => (await callsOf(page, "config")).map((c) => c.join(" "))).toContain("config --local git403.ai false");
  await page.keyboard.press("Escape");
  await commitMenu(page);
  expect(await hasItem(page, "AI 리뷰…")).toBe(0);
});

test("동의: 처음 한 번 묻고, 거절하면 아무것도 보내지 않고, 승낙하면 저장해 다시 묻지 않는다", async ({ page }) => {
  await open(page, { __askNo: true });
  await changes(page);
  await page.getByRole("button", { name: "AI로 작성" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__asked.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__asked[0])).toContain(ASK);
  await expect(page.getByRole("button", { name: "AI로 작성" })).toBeVisible();
  expect(await runs(page)).toHaveLength(0);
  expect(await callsOf(page, "ai_settings_set")).toHaveLength(0);

  await page.evaluate(() => ((window as any).__askNo = false));
  await page.getByRole("button", { name: "AI로 작성" }).click();
  await expect(page.getByLabel("커밋 제목")).toHaveValue("feat: AI 커밋 메시지 추가");
  expect(JSON.parse((await callsOf(page, "ai_settings_set"))[0][1])).toMatchObject({ consent: true });
  await page.getByRole("button", { name: "AI로 작성" }).click(); // 두 번째부터는 묻지 않는다
  await expect.poll(async () => (await runs(page)).length).toBe(2);
  expect(await page.evaluate(() => (window as any).__asked.length)).toBe(2);

  // 설정 > AI에서 동의 초기화 → 다시 묻는다
  await page.keyboard.press("ControlOrMeta+,");
  const dlg = sheet(page, "설정");
  await dlg.getByRole("tab", { name: "AI", exact: true }).click();
  await expect(dlg).toContainText("전송 동의: 받음");
  await dlg.getByRole("button", { name: "동의 초기화" }).click();
  await expect(dlg).toContainText("아직 안 받음");
  await page.keyboard.press("Escape"); // 누른 버튼이 disabled가 돼도 Escape가 시트를 닫는다
  await expect(dlg).toBeHidden();
  await page.getByRole("button", { name: "AI로 작성" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__asked.length)).toBe(3);
});

test("커밋 메시지: 스테이지된 diff·최근 커밋 제목을 보내고 제목·본문을 채운다(고칠 수 있다)", async ({ page }) => {
  await open(page, consented);
  await changes(page);
  await page.getByRole("button", { name: "AI로 작성" }).click();
  await expect(page.getByLabel("커밋 제목")).toHaveValue("feat: AI 커밋 메시지 추가");
  await expect(page.getByLabel("커밋 설명")).toHaveValue("스테이지된 변경을 요약합니다.");
  const [r] = await runs(page);
  expect(r.task).toBe("commit");
  expect(r.parts.map((p) => p.label)).toEqual(["recent commits", "staged diff"]);
  expect(r.parts[0].text).toContain("그래프 곡선 렌더링"); // 언어를 따르도록 최근 제목
  expect(r.parts[1].text).toContain("diff --git");
  expect((await calls(page)).some((c) => c[0] === "diff" || c.join(" ").startsWith("diff --cached"))).toBe(false); // 조회는 기록하지 않는 mock
  await page.getByLabel("커밋 제목").fill("직접 고친 제목");
  await page.getByRole("button", { name: "커밋", exact: true }).click();
  await expect.poll(async () => (await callsOf(page, "commit")).map((c) => c[1])).toEqual(["직접 고친 제목\n\n스테이지된 변경을 요약합니다."]);
});

test("커밋 메시지: 스테이지된 변경이 없으면 보내지 않고 안내한다", async ({ page }) => {
  await open(page, { ...consented, __stagedDiff: "\n" });
  await changes(page);
  await page.getByRole("button", { name: "AI로 작성" }).click();
  await expect(page.getByRole("alert")).toContainText("스테이지된 변경이 없습니다");
  expect(await runs(page)).toHaveLength(0);
});

test("크기 초과: 200KB를 넘으면 자르지 않고 파일을 골라 달라고 안내한다", async ({ page }) => {
  await open(page, { ...consented, __stagedDiff: "+" + "x".repeat(210_000) });
  await changes(page);
  await page.getByRole("button", { name: "AI로 작성" }).click();
  await expect(page.getByRole("alert")).toContainText("너무 큽니다");
  await expect(page.getByRole("alert")).toContainText("파일을 골라서");
  await expect(page.getByLabel("커밋 제목")).toHaveValue("");
  // 보낸 입력은 잘리지 않았다 (mock이 Rust처럼 거부했다)
  expect((await runs(page))[0].parts[1].text.length).toBeGreaterThan(200_000);

  // 리뷰 시트에서도 같은 안내
  await page.locator(".toast").getByRole("button", { name: "닫기", exact: true }).click();
  await page.evaluate(() => ((window as any).__aiDiff = "+" + "y".repeat(250_000)));
  await commitMenu(page);
  await menuItem(page, "AI 리뷰…").click();
  await expect(sheet(page, /AI 리뷰/).getByRole("alert")).toContainText("파일을 골라서");
});

test("AI 거절·서버 오류 문구는 그대로 보인다", async ({ page }) => {
  await open(page, { ...consented, __aiFail: "Claude가 이 요청에 응답하지 않았습니다 (분류: cyber). 입력 내용을 확인하세요" });
  await changes(page);
  await page.getByRole("button", { name: "AI로 작성" }).click();
  await expect(page.getByRole("alert")).toContainText("분류: cyber");
  await page.locator(".toast").getByRole("button", { name: "닫기", exact: true }).click();
  await page.evaluate(() => ((window as any).__aiFail = "Anthropic 서버가 혼잡하거나 오류 상태입니다(529). 잠시 후 다시 시도하세요"));
  await commitMenu(page);
  await menuItem(page, "AI 리뷰…").click();
  await expect(sheet(page, /AI 리뷰/).getByRole("alert")).toContainText("혼잡");
});

test("커밋 리뷰: 우클릭 → 시트에 지적 목록(심각도 순)", async ({ page }) => {
  await open(page, consented);
  await commitMenu(page, "로그 파서");
  await menuItem(page, "AI 리뷰…").click();
  const dlg = sheet(page, /AI 리뷰: c30/);
  const list = dlg.getByRole("list", { name: "리뷰 지적 사항" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list.getByRole("listitem").first()).toContainText("높음");
  await expect(list.getByRole("listitem").first()).toContainText("crates/graph/src/lib.rs:14");
  await expect(list.getByRole("listitem").first()).toContainText("오버플로");
  const [r] = await runs(page);
  expect(r.task).toBe("review");
  expect(r.parts.map((p) => p.label)).toEqual(["commit message", "diff"]);
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await page.evaluate(() => ((window as any).__aiResult = { review: { findings: [] } }));
  await commitMenu(page, "로그 파서");
  await menuItem(page, "AI 리뷰…").click();
  await expect(sheet(page, /AI 리뷰/)).toContainText("지적할 문제를 찾지 못했습니다");
});

test("브랜치 리뷰: base(origin/main) 대비 diff와 커밋 제목을 보낸다", async ({ page }) => {
  await open(page, consented);
  await page.locator(`.sidebar [title="feature/graph"]`).click({ button: "right" });
  await menuItem(page, "AI 리뷰 (base 대비)…").click();
  await expect(sheet(page, /AI 리뷰: feature\/graph/).getByRole("listitem")).toHaveCount(2);
  const [r] = await runs(page);
  expect(r.parts.map((p) => p.label)).toEqual(["commit subjects", "diff (origin/main...feature/graph)"]);
  // 로컬 main도 원격 기본 브랜치(origin/main) 대비로 본다
  await page.keyboard.press("Escape");
  await page.locator(`.sidebar [title="main"]`).first().click({ button: "right" });
  await menuItem(page, "AI 리뷰 (base 대비)…").click();
  await expect(sheet(page, /AI 리뷰: main/).getByRole("listitem")).toHaveCount(2);
  expect((await runs(page))[1].parts[1].label).toBe("diff (origin/main...main)");
});

test("충돌 도우미: 세 버전을 보내고 설명·병합안 미리보기, 적용하면 파일에 쓴다(스테이지는 안 함)", async ({ page }) => {
  await open(page, { ...consented, __conflict: true, __stage: { "2": "내 쪽 줄\n", "3": "상대 쪽 줄\n" } });
  await changes(page);
  const file = page.getByRole("listbox", { name: "스테이지 안 됨" }).getByText("conflict.txt");
  await file.click({ button: "right" });
  await menuItem(page, "AI 충돌 도우미…").click();
  const dlg = sheet(page, /AI 충돌 도우미: conflict.txt/);
  await expect(dlg).toContainText("둘 다 살렸습니다");
  await expect(dlg.getByLabel("병합안 미리보기")).toContainText("합쳐진 제목");
  const [r] = await runs(page);
  expect(r.task).toBe("conflict");
  expect(r.parts.map((p) => p.label)).toEqual(["file", "base (공통 조상, :1)", "ours (:2)", "theirs (:3)"]);
  expect(r.parts.map((p) => p.text)).toEqual(["conflict.txt", "(없음)", "내 쪽 줄\n", "상대 쪽 줄\n"]); // 공통 조상이 없는 add/add 충돌
  expect(await callsOf(page, "write_in_repo")).toHaveLength(0); // 미리보기만으로는 쓰지 않는다
  await dlg.getByRole("button", { name: "적용" }).click();
  await expect(dlg).toHaveCount(0);
  const [w] = await callsOf(page, "write_in_repo");
  expect(JSON.parse(w[1])).toMatchObject({ repo: "/demo/git403", path: "conflict.txt", text: "합쳐진 제목\n합쳐진 본문\n", expected: "fp1" }); // 요청 시점 저장소·지문
  expect(await page.evaluate(() => (window as any).__asked.some((m: string) => m.includes("덮어씁니다")))).toBe(true); // 적용 전 OS 확인
  expect((await calls(page)).some((c) => c[0] === "stage" || (c[0] === "add"))).toBe(false);
  await expect(page.locator(".toast").last()).toContainText("해결됨으로 표시");
});

/** 충돌 도우미 시트를 연다 */
const conflictSheet = async (page: Page, flags: Record<string, unknown> = {}) => {
  await open(page, { ...consented, __conflict: true, ...flags });
  await changes(page);
  await page.getByRole("listbox", { name: "스테이지 안 됨" }).getByText("conflict.txt").click({ button: "right" });
  await menuItem(page, "AI 충돌 도우미…").click();
  return sheet(page, /AI 충돌 도우미/);
};

test("충돌 도우미: 비UTF-8·NUL 파일은 AI에 보내지 않고 거부한다", async ({ page }) => {
  const dlg = await conflictSheet(page, { __stageBad: "NUL" });
  await expect(dlg.getByRole("alert")).toContainText("NUL");
  expect(await runs(page)).toHaveLength(0);
});

test("충돌 도우미: 적용 전 확인을 거절하면 쓰지 않는다", async ({ page }) => {
  const dlg = await conflictSheet(page);
  await expect(dlg.getByLabel("병합안 미리보기")).toBeVisible();
  await page.evaluate(() => ((window as any).__askNo = true));
  await dlg.getByRole("button", { name: "적용" }).click();
  await expect(dlg.getByRole("button", { name: "적용" })).toBeEnabled();
  expect(await callsOf(page, "write_in_repo")).toHaveLength(0);
});

test("충돌 도우미: 요청 뒤 작업 파일이 바뀌었으면 거부한다(덮어쓰기 안 함)", async ({ page }) => {
  const dlg = await conflictSheet(page);
  await expect(dlg.getByLabel("병합안 미리보기")).toBeVisible();
  await page.evaluate(() => ((window as any).__fp = "fp2")); // 사용자가 그사이 파일을 고침
  await dlg.getByRole("button", { name: "적용" }).click();
  await expect(page.getByRole("alert")).toContainText("바뀌었습니다");
  await expect(dlg).toBeVisible();
});

test("충돌 도우미: 이미 충돌이 아니면(해결됨) 확인·쓰기 없이 안내한다", async ({ page }) => {
  const dlg = await conflictSheet(page);
  await expect(dlg.getByLabel("병합안 미리보기")).toBeVisible();
  await page.evaluate(() => ((window as any).__lsU = ""));
  await dlg.getByRole("button", { name: "적용" }).click();
  await expect(page.getByRole("alert")).toContainText("더 이상 충돌 상태가 아닙니다");
  expect(await callsOf(page, "write_in_repo")).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).__asked.some((m: string) => m.includes("덮어씁니다")))).toBe(false);
});

test("충돌 도우미: 한쪽이 삭제한 충돌에는 메뉴가 없다", async ({ page }) => {
  await open(page, { ...consented, __conflict: "DU" });
  await changes(page);
  await page.getByRole("listbox", { name: "스테이지 안 됨" }).getByText("conflict.txt").click({ button: "right" });
  expect(await hasItem(page, "AI 충돌 도우미…")).toBe(0);
});

test("PR 설명: 'AI로 작성'이 커밋 제목·diff --stat·diff로 제목·본문을 채운다", async ({ page }) => {
  await open(page, consented);
  await page.locator(`.sidebar [title="feature/graph"]`).click({ button: "right" });
  await menuItem(page, "Pull Request 만들기…").click();
  const dlg = sheet(page, "Pull Request 만들기");
  await dlg.getByRole("button", { name: "AI로 작성" }).click();
  await expect(dlg.getByRole("textbox", { name: "제목" })).toHaveValue("AI가 쓴 PR 제목");
  await expect(dlg.getByRole("textbox", { name: "본문" })).toHaveValue("## 요약\n- 변경 사항 설명");
  const [r] = await runs(page);
  expect(r.task).toBe("pr");
  expect(r.parts.map((p) => p.label)).toEqual(["commit subjects", "diff --stat", "diff"]);
  expect(r.parts[1].text).toContain("1 file changed");
  // 직접 고칠 수 있다
  await dlg.getByRole("textbox", { name: "제목" }).fill("내가 고친 제목");
  await dlg.getByRole("button", { name: /만들기/ }).last().click();
  await expect.poll(async () => (await callsOf(page, "pr_create")).length).toBe(1);
  expect(JSON.parse((await callsOf(page, "pr_create"))[0][1])).toMatchObject({ title: "내가 고친 제목", body: "## 요약\n- 변경 사항 설명" });
});

test("취소: 작성 중 다시 누르면(커밋)·시트를 닫으면(리뷰) 요청을 취소하고 결과를 반영하지 않는다", async ({ page }) => {
  await open(page, { ...consented, __aiSlow: 5000 });
  await changes(page);
  await page.getByRole("button", { name: "AI로 작성" }).click();
  await expect(page.getByRole("button", { name: "작성 중… 취소" })).toBeVisible();
  await expect.poll(async () => (await runs(page)).length).toBe(1);
  await page.getByRole("button", { name: "작성 중… 취소" }).click();
  await expect(page.getByRole("button", { name: "AI로 작성" })).toBeVisible();
  await expect(page.getByLabel("커밋 제목")).toHaveValue("");
  await expect(page.getByRole("alert")).toHaveCount(0); // 취소는 오류가 아니다
  expect(await callsOf(page, "ai_cancel")).toHaveLength(1);

  await commitMenu(page);
  await menuItem(page, "AI 리뷰…").click();
  const dlg = sheet(page, /AI 리뷰/);
  await expect(dlg.getByRole("status")).toContainText("분석하는 중");
  await expect.poll(async () => (await runs(page)).length).toBe(2);
  await dlg.getByRole("button", { name: "취소" }).click();
  await expect(dlg).toHaveCount(0);
  await expect.poll(async () => (await callsOf(page, "ai_cancel")).length).toBe(2);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("설정 > AI: 감지 표시, 키 저장·삭제(값은 화면에 돌아오지 않음), 모델, 방식", async ({ page }) => {
  await open(page, { __ai: { cli: false, key: false } });
  await page.keyboard.press("ControlOrMeta+,");
  const dlg = sheet(page, "설정");
  await dlg.getByRole("tab", { name: "AI", exact: true }).click();
  const detect = dlg.getByRole("list", { name: "AI 방식 감지" });
  await expect(detect).toContainText("찾지 못함");
  await expect(detect).toContainText("없음 — AI 메뉴가 숨겨집니다");

  await dlg.getByLabel("API 키", { exact: true }).fill("sk-ant-secret-123");
  await dlg.getByRole("button", { name: "저장", exact: true }).click();
  await expect(detect).toContainText("설정됨");
  await expect(detect).toContainText("API 키"); // 사용 중인 방식
  await expect(dlg.getByLabel("API 키", { exact: true })).toHaveValue("");
  await expect(page.locator("body")).not.toContainText("sk-ant-secret-123");
  expect(await callsOf(page, "ai_key_set")).toEqual([["ai_key_set", "sk-ant-secret-123"]]);
  // ai_status 응답에는 키 값이 없다
  expect(JSON.stringify(await page.evaluate(() => (window as any).__ai))).not.toContain("sk-ant");

  await dlg.getByLabel("모델", { exact: true }).fill("claude-sonnet-5-5");
  await dlg.getByLabel("모델", { exact: true }).press("Enter");
  await expect.poll(async () => (await callsOf(page, "ai_settings_set")).map((c) => JSON.parse(c[1]).model).filter(Boolean)).toEqual(["claude-sonnet-5-5"]);

  await dlg.getByLabel("사용할 방식").selectOption("cli"); // CLI는 없으니 쓸 방식이 없다
  await expect(detect).toContainText("없음 — AI 메뉴가 숨겨집니다");
  await dlg.getByLabel("사용할 방식").selectOption("auto");
  await dlg.getByRole("button", { name: "삭제" }).click();
  await expect(detect).toContainText("없음 — AI 메뉴가 숨겨집니다");
  expect(await callsOf(page, "ai_key_delete")).toHaveLength(1);

  // 방식이 생기면(설정에서 키 저장) 메뉴가 나타난다
  await dlg.getByLabel("API 키", { exact: true }).fill("sk-ant-x");
  await dlg.getByRole("button", { name: "저장", exact: true }).click();
  await page.keyboard.press("Escape");
  await commitMenu(page);
  await expect(menuItem(page, "AI 리뷰…")).toBeVisible();
});

test("설정 > AI: CLI 감지", async ({ page }) => {
  await open(page);
  await page.keyboard.press("ControlOrMeta+,");
  await sheet(page, "설정").getByRole("tab", { name: "AI", exact: true }).click();
  const detect = sheet(page, "설정").getByRole("list", { name: "AI 방식 감지" });
  await expect(detect).toContainText("감지됨 (2.1.0 (Claude Code))");
  await expect(detect).toContainText("Claude Code CLI");
});

// ---- 공급자 선택 (Claude·Codex/GPT·Gemini·Grok) ----
const aiTab = async (page: Page) => {
  await page.keyboard.press("ControlOrMeta+,");
  const dlg = sheet(page, "설정");
  await dlg.getByRole("tab", { name: "AI", exact: true }).click();
  return dlg;
};

test("설정 > AI: 공급자 4곳 상태 표시, 전환하면 그 공급자의 방식·모델·키 안내가 나온다", async ({ page }, info) => {
  await open(page, { __ai: { consent: true, providers: { openai: { cli: true, cliVersion: "0.9.1", model: "gpt-5" }, google: { key: true } } } });
  const dlg = await aiTab(page);
  const group = dlg.getByRole("radiogroup", { name: "AI 공급자" });
  await expect(group.getByRole("radio")).toHaveCount(4);
  await expect(group.getByRole("radio", { name: /Claude/ })).toBeChecked();
  await expect(group).toContainText("CLI 2.1.0 (Claude Code) · 로그인 위임 · 지금 CLI 사용");
  await expect(group.getByRole("listitem").filter({ hasText: /Codex/ })).toContainText("CLI 0.9.1 · 로그인 위임");
  await expect(group.getByRole("listitem").filter({ hasText: /Gemini/ })).toContainText("키 설정됨 · 지금 API 키 사용");
  await expect(group.getByRole("listitem").filter({ hasText: /Grok/ })).toContainText("사용 불가");
  await page.screenshot({ path: `e2e/results/screens/ai-providers-${info.project.name}.png` });

  // Grok으로 전환: CLI 없음 안내(grok login), 모델은 그 공급자 것, 키는 그 공급자로 저장
  await group.getByRole("radio", { name: /Grok/ }).check();
  await expect(group.getByRole("radio", { name: /Grok/ })).toBeChecked();
  expect(JSON.parse((await callsOf(page, "ai_settings_set")).at(-1)![1])).toMatchObject({ provider: "xai", select: true });
  const detect = dlg.getByRole("list", { name: "AI 방식 감지" });
  await expect(detect).toContainText("Grok CLI");
  await expect(detect).toContainText("PATH에 grok 없음");
  await expect(dlg.getByRole("note")).toContainText("grok login");
  await expect(dlg.getByLabel("모델", { exact: true })).toHaveValue("grok-4");
  await expect(dlg.getByLabel("API 키", { exact: true })).toHaveAttribute("placeholder", "xai-…");
  await dlg.getByLabel("API 키", { exact: true }).fill("xai-secret-1");
  await dlg.getByRole("button", { name: "저장", exact: true }).click();
  expect(await callsOf(page, "ai_key_set")).toEqual([["ai_key_set", "xai-secret-1"]]);
  await expect(group.getByRole("listitem").filter({ hasText: /Grok/ })).toContainText("키 설정됨 · 지금 API 키 사용");
  await expect(page.locator("body")).not.toContainText("xai-secret-1");
  await page.screenshot({ path: `e2e/results/screens/ai-providers-grok-${info.project.name}.png` });

  // 모델·방식은 선택된 공급자(생략 provider)에 적용되고 다른 공급자는 그대로
  await dlg.getByLabel("모델", { exact: true }).fill("grok-4-fast");
  await dlg.getByLabel("모델", { exact: true }).press("Enter");
  await expect.poll(async () => (await callsOf(page, "ai_settings_set")).map((c) => JSON.parse(c[1]).model).filter(Boolean)).toEqual(["grok-4-fast"]);
  await group.getByRole("radio", { name: /Claude/ }).check();
  await expect(dlg.getByLabel("모델", { exact: true })).toHaveValue("claude-opus-5-5");
  await expect(dlg.getByRole("note")).toHaveCount(0); // Claude CLI는 있다
  // 키 삭제는 선택된 공급자만
  await group.getByRole("radio", { name: /Grok/ }).check();
  await dlg.getByRole("button", { name: "삭제" }).click();
  await expect(group.getByRole("listitem").filter({ hasText: /Grok/ })).toContainText("사용 불가");
  await expect(group.getByRole("listitem").filter({ hasText: /Gemini/ })).toContainText("키 설정됨");
});

test("공급자 선택: AI 메뉴 숨김 판단은 선택된 공급자 기준, 동의 문구는 공급자 이름", async ({ page }) => {
  await open(page, { __askNo: true, __asked: [], __ai: { cli: true, providers: { openai: { cli: false, key: false }, google: { key: true, consent: false } } } });
  const dlg = await aiTab(page);
  await dlg.getByRole("radio", { name: /Codex/ }).check(); // 쓸 방식 없음 → 메뉴 숨김
  await expect(dlg.getByRole("list", { name: "AI 방식 감지" })).toContainText("없음 — AI 메뉴가 숨겨집니다");
  await page.keyboard.press("Escape");
  await commitMenu(page);
  expect(await hasItem(page, "AI 리뷰…")).toBe(0);
  await page.keyboard.press("Escape");

  const dlg2 = await aiTab(page);
  await dlg2.getByRole("radio", { name: /Gemini/ }).check();
  await page.keyboard.press("Escape");
  await changes(page);
  await page.getByRole("button", { name: "AI로 작성" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__asked.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__asked[0])).toContain("선택한 변경 내용과 저장소 규칙 문서가 전송됩니다(전송 대상: Google)");
  expect(await runs(page)).toHaveLength(0);
  // Grok: 키를 넣고 선택하면 xAI 문구
  const dlg3 = await aiTab(page);
  await dlg3.getByRole("radio", { name: /Grok/ }).check();
  await dlg3.getByLabel("API 키", { exact: true }).fill("xai-k");
  await dlg3.getByRole("button", { name: "저장", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "AI로 작성" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__asked.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).__asked[1])).toContain("선택한 변경 내용과 저장소 규칙 문서가 전송됩니다(전송 대상: xAI)");
});

// ---- 상태바 AI 항목 ----
const barAi = (page: Page) => page.locator(".statusbar .status-item");
const SHOTS = "e2e/results/screens";

test("상태바 AI 항목: 연결된 공급자·방식을 보여 주고, 메뉴로 공급자를 바꾸면 설정 화면도 따라간다", async ({ page }, info) => {
  await open(page, { __ai: { providers: { google: { key: true } } } });
  await expect(barAi(page)).toHaveText("AI Claude · CLI");
  await barAi(page).click();
  const menu = page.getByRole("menu");
  const items = menu.getByRole("menuitem");
  await expect(items).toHaveCount(5); // 공급자 4 + AI 설정…
  await expect(items.nth(0)).toContainText("✓ Claude");
  await expect(items.nth(0)).toContainText("CLI");
  await expect(items.nth(1)).toBeDisabled(); // Codex: CLI도 키도 없음
  await expect(items.nth(1)).toContainText("사용 불가");
  await expect(items.nth(2)).toBeEnabled();
  await expect(items.nth(2)).toContainText("API 키");
  await expect(items.nth(3)).toBeDisabled();
  await page.screenshot({ path: `${SHOTS}/statusbar-ai-${info.project.name}.png` });
  // Gemini 선택 → ai_settings_set({provider, select}) 뒤 상태바 갱신
  await items.nth(2).click();
  await expect(barAi(page)).toHaveText("AI Gemini · API 키");
  expect((await callsOf(page, "ai_settings_set")).map((c) => JSON.parse(c[1]))).toEqual([expect.objectContaining({ provider: "google", select: true })]);
  // 설정 > AI도 같은 선택을 보여 준다
  const dlg = await aiTab(page);
  await expect(dlg.getByRole("radio", { name: /Gemini/ })).toBeChecked();
  // 설정 화면에서 바꾸면 상태바도 바뀐다
  await dlg.getByRole("radio", { name: /Claude/ }).check();
  await expect(barAi(page)).toHaveText("AI Claude · CLI");
  await dlg.getByLabel("사용할 방식").selectOption("key"); // Claude는 키가 없다 → 쓸 수 없음
  await expect(barAi(page)).toHaveText("AI 꺼짐");
  await page.keyboard.press("Escape");
  // 메뉴의 "AI 설정…" → 설정 창 AI 탭
  await barAi(page).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "AI 설정…" }).click();
  await expect(sheet(page, "설정").getByRole("tab", { name: "AI", exact: true })).toHaveAttribute("aria-selected", "true");
});

test("상태바 AI 항목: 쓸 방식이 없으면 흐린 'AI 꺼짐', 저장소별로 끄면 'AI 꺼짐(이 저장소)'", async ({ page }, info) => {
  await open(page, { __ai: { cli: false, key: false } });
  await expect(barAi(page)).toHaveText("AI 꺼짐");
  await expect(barAi(page)).toHaveClass(/muted/);
  await barAi(page).click();
  const items = page.getByRole("menu").getByRole("menuitem");
  for (let i = 0; i < 4; i++) await expect(items.nth(i)).toBeDisabled();
  await expect(items.nth(4)).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `${SHOTS}/statusbar-ai-off-${info.project.name}.png` });
});

test("상태바 AI 항목: git403.ai=false인 저장소는 '이 저장소' 꺼짐, 설정에서 켜면 돌아온다", async ({ page }) => {
  await open(page, { __ai: { consent: true }, __issue: { "git403.ai": "false" } });
  await expect(barAi(page)).toHaveText("AI 꺼짐(이 저장소)");
  const dlg = await aiTab(page);
  await dlg.getByLabel(/이 저장소에서 AI 끄기/).uncheck();
  await expect(barAi(page)).toHaveText("AI Claude · CLI");
});

// ---- 저장소 규칙(conventions) ----
test("저장소 규칙: 커밋·PR 작성은 repo 경로를 넘기고, 다른 작업은 넘기지 않는다", async ({ page }) => {
  await open(page, consented);
  await changes(page);
  await page.getByRole("button", { name: "AI로 작성" }).click();
  await expect(page.getByLabel("커밋 제목")).toHaveValue("feat: AI 커밋 메시지 추가");
  await page.locator(`.sidebar [title="feature/graph"]`).click({ button: "right" });
  await menuItem(page, "Pull Request 만들기…").click();
  await sheet(page, "Pull Request 만들기").getByRole("button", { name: "AI로 작성" }).click();
  await expect(sheet(page, "Pull Request 만들기").getByRole("textbox", { name: "제목" })).toHaveValue("AI가 쓴 PR 제목");
  await page.keyboard.press("Escape");
  await commitMenu(page);
  await menuItem(page, "AI 리뷰…").click();
  await expect(sheet(page, /AI 리뷰/).getByRole("list", { name: "리뷰 지적 사항" })).toBeVisible();
  expect((await runs(page)).map((r) => [r.task, r.repo])).toEqual([["commit", "/demo/git403"], ["pr", "/demo/git403"], ["review", undefined]]);
});

test("저장소 규칙: 커밋 메시지·PR 설명 결과 아래에 쓴 규칙 한 줄(호버·펼치면 경로), 없으면 안 보인다", async ({ page }, info) => {
  await open(page, consented);
  await changes(page);
  await expect(page.locator(".ai-sources")).toHaveCount(0);
  await page.getByRole("button", { name: "AI로 작성" }).click();
  const line = page.locator(".commit-box .ai-sources");
  await expect(line).toContainText("규칙: commit-message 스킬 · AGENTS.md · 최근 커밋 20개");
  await expect(line.locator("summary")).toHaveAttribute("title", /\.claude\/skills\/commit-message\/SKILL\.md\nAGENTS\.md\ngit log -n 20/);
  await line.locator("summary").click();
  await expect(line.getByRole("list", { name: "저장소 규칙 출처" }).getByRole("listitem")).toHaveText([".claude/skills/commit-message/SKILL.md", "AGENTS.md", "git log -n 20"]);
  await page.screenshot({ path: `${SHOTS}/ai-sources-${info.project.name}.png` });
  await line.locator("summary").click(); // 다시 누르면 접힌다
  await expect(line.getByRole("list", { name: "저장소 규칙 출처" })).toBeHidden();
  // 커밋하면 사라진다
  await page.getByRole("button", { name: "커밋", exact: true }).click();
  await expect(line).toHaveCount(0);
});

test("저장소 규칙: 잘린 항목은 (일부), PR 시트에도 같은 줄", async ({ page }) => {
  await open(page, { ...consented, __aiSources: [{ kind: "claude", path: "CLAUDE.md", truncated: true }, { kind: "template", path: ".github/pull_request_template.md", truncated: false }] });
  await page.locator(`.sidebar [title="feature/graph"]`).click({ button: "right" });
  await menuItem(page, "Pull Request 만들기…").click();
  const dlg = sheet(page, "Pull Request 만들기");
  await expect(dlg.locator(".ai-sources")).toHaveCount(0);
  await dlg.getByRole("button", { name: "AI로 작성" }).click();
  await expect(dlg.locator(".ai-sources")).toContainText("규칙: CLAUDE.md(일부) · pull_request_template.md");
});

test("저장소 규칙: 지정된 스킬(CLAUDE.md:168 지정)·이름으로 찾은 스킬·못 찾은 스킬 표기와 호버 목록", async ({ page }) => {
  await open(page, { ...consented, __aiSources: [
    { kind: "skill", path: ".claude/skills/commit-message/SKILL.md", truncated: false, via: "referenced", from: "CLAUDE.md:168" },
    { kind: "skill", path: "~/.claude/skills/pr-style/SKILL.md", truncated: false, via: "matched" },
    { kind: "skill", path: "release-notes", truncated: false, via: "referenced", from: "~/.claude/CLAUDE.md:7", missing: true },
  ] });
  await changes(page);
  await page.getByRole("button", { name: "AI로 작성" }).click();
  const line = page.locator(".commit-box .ai-sources");
  await expect(line).toContainText("규칙: commit-message 스킬 (CLAUDE.md:168 지정) · pr-style 스킬 (이름으로 찾음) · 지정된 스킬 release-notes를 찾지 못함");
  await expect(line.locator(".src-missing")).toHaveText(/지정된 스킬 release-notes/);
  await expect(line.locator("summary")).toHaveAttribute("title", /SKILL\.md ← CLAUDE\.md:168\n~\/\.claude\/skills\/pr-style\/SKILL\.md\nrelease-notes ← ~\/\.claude\/CLAUDE\.md:7/);
  await line.locator("summary").click();
  await expect(line.getByRole("listitem")).toHaveCount(3);
  await expect(line.getByRole("listitem").nth(0)).toHaveText(".claude/skills/commit-message/SKILL.md ← CLAUDE.md:168");
});

for (const [name, flags] of [["전역 설정에서 끔", { __aiConv: false }], ["이 저장소에서 끔", { __issue: { "git403.aiConventions": "false" } }], ["찾은 규칙이 없음", { __aiSources: [] }]] as const) {
  test(`저장소 규칙: ${name}이면 결과 아래 규칙 한 줄이 없다`, async ({ page }) => {
    await open(page, { ...consented, ...flags });
    await changes(page);
    await page.getByRole("button", { name: "AI로 작성" }).click();
    await expect(page.getByLabel("커밋 제목")).toHaveValue("feat: AI 커밋 메시지 추가");
    await expect(page.locator(".ai-sources")).toHaveCount(0);
  });
}

test("설정 > AI: 저장소 규칙 따르기(전역)와 이 저장소에서 끄기(git403.aiConventions)", async ({ page }) => {
  await open(page, consented);
  const dlg = await aiTab(page);
  const conv = dlg.getByLabel("저장소 규칙 따르기", { exact: false });
  const repoOff = dlg.getByLabel(/이 저장소에서 끄기 \(git config/);
  await expect(conv).toBeChecked();
  await expect(repoOff).not.toBeChecked();
  await conv.uncheck();
  await expect.poll(async () => (await callsOf(page, "ai_settings_set")).map((c) => JSON.parse(c[1]).conventions)).toContain(false);
  await expect(conv).not.toBeChecked();
  await conv.check();
  await expect(conv).toBeChecked();
  await repoOff.check();
  await expect.poll(async () => (await callsOf(page, "config")).map((c) => c.join(" "))).toContain("config --local git403.aiConventions false");
  await expect(repoOff).toBeChecked();
  await repoOff.uncheck();
  await expect.poll(async () => (await callsOf(page, "config")).map((c) => c.join(" "))).toContain("config --local --unset git403.aiConventions");
  // 다시 열면 저장된 값
  await page.keyboard.press("Escape");
  const dlg2 = await aiTab(page);
  await expect(dlg2.getByLabel(/이 저장소에서 끄기 \(git config/)).not.toBeChecked();
});

test("설정 > AI: Grok을 CLI로 쓸 때만 명령줄 인자 노출 경고가 보인다", async ({ page }) => {
  const WARN = "Grok CLI는 입력(diff·규칙 문서)을 명령줄 인자로 받아";
  await open(page, { __ai: { consent: true, provider: "xai", providers: { xai: { cli: true, cliVersion: "1.0", key: true } } } });
  const dlg = await aiTab(page);
  await expect(dlg.getByRole("note").filter({ hasText: WARN })).toContainText("API 키 방식을 쓰세요");
  // 방식이 API 키면 경고 없음
  await dlg.getByLabel("사용할 방식").selectOption("key");
  await expect(dlg.getByRole("note")).toHaveCount(0);
  // 다른 공급자(Claude CLI)도 경고 없음
  await dlg.getByRole("radiogroup", { name: "AI 공급자" }).getByRole("radio", { name: /Claude/ }).check();
  await expect(dlg.getByRole("note")).toHaveCount(0);
});

test("저장소 규칙: 저장소·홈 밖 commit.template은 읽지 않았다고 흐리게 표시하고 목록엔 원래 값", async ({ page }) => {
  await open(page, { ...consented, __aiSources: [{ kind: "template", path: "commit.template (/etc/tpl.txt)", truncated: false, skipped: true }, { kind: "agents", path: "AGENTS.md", truncated: false }] });
  await changes(page);
  await page.getByRole("button", { name: "AI로 작성" }).click();
  const line = page.locator(".commit-box .ai-sources");
  await expect(line).toContainText("규칙: 커밋 템플릿(저장소·홈 밖이라 읽지 않음) · AGENTS.md");
  await expect(line.locator(".src-skipped")).toHaveCount(1);
  await line.locator("summary").click();
  await expect(line.getByRole("listitem").nth(0)).toHaveText("commit.template (/etc/tpl.txt)");
});
