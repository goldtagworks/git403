import { expect, test, type Page } from "@playwright/test";
import { AFTER, BEFORE, seedNow, sha } from "./png";
import { cellXib, textDiff } from "./ib";

// 가볍고 빠른 앱이 목표라서 리렌더링 회귀를 테스트로 막는다 (docs/performance.md).
const renders = (page: Page) => page.evaluate(() => ({ ...(window as any).__renders }) as Record<string, number>);

test.beforeEach(async ({ page }) => {
  // 열 때 도는 자동 Fetch가 느린 실행에서 측정 구간 안에 끝나 StatusBar(job prop)를 다시 그리지 않게
  await page.addInitScript(() => localStorage.setItem("autoFetch", "0"));
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".diff .add").first()).toBeVisible(); // 첫 로드가 다 끝날 때까지
});

test("작업 진행률 이벤트는 그래프·사이드바·상세를 다시 그리지 않는다", async ({ page }) => {
  await page.locator(".toolbar").getByRole("button", { name: "Pull", exact: true }).click();
  // 작업 시작(버튼 비활성화)까지는 정상 렌더링. 그 뒤 진행률 동안은 늘면 안 된다.
  await expect(page.getByRole("button", { name: "Pull 취소" })).toBeVisible();
  const before = await renders(page);
  await expect(page.locator(".status-progress")).toContainText("Receiving objects");
  const during = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Details", "Toolbar"]) expect(during[id], id).toBe(before[id]);
});

test("진행률 이벤트 동안 상태바의 GhStatusItem·AiStatusItem(memo)은 다시 그려지지 않는다", async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, { __gh: { installed: true, accounts: [{ user: "me", active: true }] } }));
  await page.reload();
  await expect(page.locator(".diff .add").first()).toBeVisible();
  await page.locator(".toolbar").getByRole("button", { name: "Pull", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pull 취소" })).toBeVisible();
  const before = await renders(page);
  expect(before.GhStatusItem).toBeGreaterThan(0);
  await expect(page.locator(".status-progress")).toContainText("Receiving objects");
  const during = await renders(page);
  for (const id of ["GhStatusItem", "AiStatusItem"]) expect(during[id], id).toBe(before[id]);
});

test("파일 감시 이벤트(작업 디렉터리 변경)는 그래프·사이드바를 다시 그리지 않는다", async ({ page }) => {
  const before = await renders(page);
  await page.locator(".commits").getByText("로컬 변경사항").click();
  const afterSelect = await renders(page);
  // 스테이지(=repo-changed 이벤트 → 상태만 다시 읽음)
  await page.getByRole("listbox", { name: "스테이지 안 됨" }).getByRole("option").first().dblclick();
  await expect(page.getByRole("listbox", { name: "스테이지됨", exact: true }).getByRole("option")).toHaveCount(2);
  const after = await renders(page);
  expect(after.Sidebar, "Sidebar").toBe(before.Sidebar);
  expect(after.CommitGraph, "CommitGraph").toBe(afterSelect.CommitGraph);
});

test("스플리터 드래그 중에는 리렌더링이 없고, 놓을 때 한 번만 반영된다", async ({ page }) => {
  const splitter = page.locator(".splitter.x").first();
  const box = (await splitter.boundingBox())!;
  const before = await renders(page);

  await page.mouse.move(box.x + 1, box.y + 200);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(box.x + 1 + i * 5, box.y + 200);
  const during = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Details"]) expect(during[id], id).toBe(before[id]);

  await page.mouse.up();
  const width = await page.locator(".pane").first().evaluate((el) => el.getBoundingClientRect().width);
  expect(Math.round(width)).toBe(240 + 100);
});

test("탭 상태 변경(저장소 전환 없음)은 그래프·사이드바를 다시 그리지 않는다", async ({ page }) => {
  await page.locator(".toolbar .picker").first().click();
  await page.getByRole("menu").getByRole("menuitem", { name: "폴더에서 저장소 찾기…" }).click();
  // 다른 탭을 하나 열었다가 원래 탭으로 돌아온다
  const bar = page.getByRole("tablist", { name: "열린 저장소" });
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("dialog", { name: "빠른 실행" }).getByRole("textbox").fill("열기 api-server");
  await page.keyboard.press("Enter");
  await expect(bar.getByRole("tab", { name: "api-server" })).toHaveAttribute("aria-selected", "true");
  await bar.getByRole("tab", { name: "git403" }).click();
  await expect(page.locator(".toolbar .picker").first()).toContainText("git403");
  // 전환 직후 상세 패널의 파일·diff 비동기 로드가 끝날 때까지 (이전 저장소의 diff가 이미 보여서 표시로는 못 기다린다)
  await page.waitForTimeout(300);

  const before = await renders(page);
  // 활성 아닌 탭 닫기, 작업공간 저장 = 탭 상태만 바뀐다
  await bar.getByRole("tab", { name: "api-server" }).hover(); // 닫기 버튼은 활성·호버 탭에만 보인다
  await bar.getByRole("button", { name: "api-server 탭 닫기" }).click();
  await expect(bar.getByRole("tab")).toHaveCount(1);
  await bar.getByRole("button", { name: "작업공간" }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "현재 탭을 작업공간으로 저장…" }).click();
  await page.getByRole("dialog", { name: "작업공간 저장" }).getByLabel("이름").fill("하나");
  await page.getByRole("dialog", { name: "작업공간 저장" }).getByRole("button", { name: "저장" }).click();
  await expect(page.locator(".toast", { hasText: "작업공간 하나 저장됨" }).first()).toBeVisible();
  const after = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Details"]) expect(after[id], id).toBe(before[id]);
});

test("서브모듈·Worktree 섹션은 작업 진행률 동안 다시 그려지지 않는다", async ({ page }) => {
  await expect(page.locator(".sidebar").getByRole("button", { name: /^서브모듈/ })).toBeVisible();
  await page.locator(".toolbar").getByRole("button", { name: "Pull", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pull 취소" })).toBeVisible();
  const before = await renders(page);
  await expect(page.locator(".status-progress")).toContainText("Receiving objects");
  expect((await renders(page)).Sidebar).toBe(before.Sidebar);
});

test("사용자 정의 셸 명령의 진행 출력도 그래프·사이드바·상세를 다시 그리지 않는다", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem("customCommands", JSON.stringify([{ id: "1", name: "빌드", target: "repo", kind: "shell", command: "make", confirm: false }])));
  await page.locator(".toolbar").getByRole("button", { name: "열기 옵션" }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "빌드", exact: true }).click();
  await expect(page.getByRole("button", { name: "빌드 취소" })).toBeVisible();
  const before = await renders(page);
  await expect(page.locator(".status-progress")).toContainText("Receiving objects");
  const during = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Details", "Toolbar"]) expect(during[id], id).toBe(before[id]);
});

test("PR 목록 조회(Fetch 뒤·새로고침)는 그래프·사이드바·상세를 다시 그리지 않고 PR 섹션만 갱신한다", async ({ page }) => {
  const sec = page.locator(".sidebar").getByRole("button", { name: /^Pull Requests/ });
  await expect(sec).toContainText("2");
  const before = await renders(page);
  await page.evaluate(() => ((window as any).__prs = [{ number: 1, title: "하나", url: "https://github.com/demo/git403/pull/1", head: "a", base: "main", author: "x" }]));
  await sec.click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Pull Request 새로고침" }).click();
  await expect(sec).toContainText("1");
  const after = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Details", "Toolbar"]) expect(after[id], id).toBe(before[id]);
  expect(after.PrSection).toBeGreaterThan(before.PrSection);
});

test("저장소 통계 로딩·줄 수 토글은 그래프·사이드바·상세를 다시 그리지 않는다", async ({ page }) => {
  await page.evaluate(() => ((window as any).__slowStats = 200));
  await page.locator(".picker").first().click();
  await page.getByRole("menu").getByRole("menuitem", { name: "저장소 통계…" }).click();
  const sheet = page.getByRole("dialog", { name: "저장소 통계" });
  await expect(sheet.locator(".stat-card").first()).toBeVisible();
  const before = await renders(page);
  await sheet.getByLabel("줄 수 포함").check();
  await expect(sheet.getByRole("status")).toContainText("계산 중");
  await expect(sheet.getByRole("status")).toHaveCount(0);
  await sheet.getByRole("button", { name: "30일" }).click();
  await expect(sheet.getByRole("status")).toHaveCount(0);
  const after = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Details", "Toolbar"]) expect(after[id], id).toBe(before[id]);
});

test("설정 창 열기·탭 이동·입력은 그래프·사이드바·상세·툴바를 다시 그리지 않는다", async ({ page }) => {
  await page.waitForTimeout(300); // 첫 로드 직후 비동기 갱신이 끝날 때까지
  const before = await renders(page);
  await page.keyboard.press("ControlOrMeta+,");
  const dlg = page.getByRole("dialog", { name: "설정" });
  await expect(dlg).toBeVisible();
  await dlg.getByLabel(/그래프 커밋 개수 상한/).fill("1234"); // 확정(blur) 전 입력
  await dlg.getByRole("tab", { name: "Git", exact: true }).click();
  await dlg.getByLabel("전역 이름").pressSequentially("입력 중인 이름", { delay: 5 });
  await dlg.getByLabel("Pull 기본 동작").selectOption("rebase");
  await dlg.getByRole("tab", { name: "gitignore", exact: true }).click();
  await dlg.getByLabel(".gitignore", { exact: true }).pressSequentially("*.tmp", { delay: 5 });
  await dlg.getByRole("tab", { name: "SSH 키", exact: true }).click();
  await dlg.getByLabel("키 파일 이름").pressSequentially("x", { delay: 5 });
  const during = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Details", "Toolbar"]) expect(during[id], id).toBe(before[id]);
  expect(during.Settings, "Settings").toBeGreaterThan(before.Settings ?? 0);
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  const after = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Details", "Toolbar"]) expect(after[id], id).toBe(before[id]);
});

test("설정 가져오기 시트(열기·섹션 토글·펼침·적용·닫기)는 그래프·사이드바·상세·툴바를 다시 그리지 않는다", async ({ page }) => {
  await page.evaluate(() => ((window as any).__settingsApplied = { applied: ["ui", "ai"], backup: "/demo/b.json", ui: { graphLimit: "3000", "split:side": "300" }, reconnect: [], skipped: [] })); // 테마·언어가 안 바뀌는 적용
  await page.waitForTimeout(300);
  const before = await renders(page);
  await page.keyboard.press("ControlOrMeta+,");
  const dlg = page.getByRole("dialog", { name: "설정" });
  await dlg.getByRole("button", { name: "설정 가져오기…" }).click();
  const imp = page.getByRole("dialog", { name: "설정 가져오기" });
  await imp.getByRole("checkbox", { name: "호스팅 계정" }).uncheck();
  await imp.getByRole("checkbox", { name: "전역 git403 git 설정" }).uncheck(); // 이슈 규칙 재조회(setIssues)는 Details가 쓰는 값이라 한 번 다시 그려지는 게 맞다
  await imp.getByText("변경 내용 보기").first().click();
  await imp.getByRole("button", { name: "선택한 항목 가져오기" }).click();
  await expect(imp.getByRole("status")).toContainText("백업");
  await imp.locator(".sheet-actions").getByRole("button", { name: "닫기" }).click();
  await expect(imp).toHaveCount(0);
  const during = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Details", "Toolbar"]) expect(during[id], id).toBe(before[id]);
});

test("AI 리뷰 시트·설정 AI 탭 입력·커밋 상자 AI 작성은 그래프·사이드바·상세·툴바를 다시 그리지 않는다", async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, { __ai: { consent: true }, __aiSlow: 200 }));
  await page.reload(); // 마지막 탭이 복원되어 저장소가 다시 열린다
  await expect(page.locator(".diff .add").first()).toBeVisible();
  const same = async (before: Record<string, number>) => {
    const now = await renders(page);
    for (const id of ["CommitGraph", "Sidebar", "Details", "Toolbar"]) expect(now[id], id).toBe(before[id]);
  };
  // 1) 커밋 상자의 AI 작성: 대기 → 채움, 설정 AI 탭 입력
  await page.locator(".commits").getByText("로컬 변경사항").click();
  await page.getByRole("button", { name: "← 그래프" }).click(); // 넓은 변경 화면에서 그래프로
  await expect(page.getByRole("button", { name: "AI로 작성" })).toBeVisible();
  await page.waitForTimeout(400); // AI 상태 조회 등 비동기 갱신이 끝날 때까지
  let before = await renders(page);
  await page.getByRole("button", { name: "AI로 작성" }).click();
  await expect(page.getByRole("button", { name: "작성 중… 취소" })).toBeVisible();
  await expect(page.getByLabel("커밋 제목")).toHaveValue("feat: AI 커밋 메시지 추가");
  await page.keyboard.press("ControlOrMeta+,");
  const dlg = page.getByRole("dialog", { name: "설정" });
  await dlg.getByRole("tab", { name: "AI", exact: true }).click();
  await dlg.getByLabel("API 키", { exact: true }).pressSequentially("sk-ant-typing", { delay: 5 });
  await dlg.getByLabel("모델", { exact: true }).pressSequentially("x", { delay: 5 });
  // 공급자 전환·키 저장도 그래프·사이드바를 다시 그리지 않는다
  await dlg.getByRole("radio", { name: /Gemini/ }).check();
  await expect(dlg.getByRole("list", { name: "AI 방식 감지" })).toContainText("Gemini CLI");
  await dlg.getByLabel("API 키", { exact: true }).fill("AIza-x");
  await dlg.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dlg.getByRole("radiogroup").getByRole("listitem").filter({ hasText: /Gemini/ })).toContainText("키 설정됨");
  await dlg.getByRole("radio", { name: /Claude/ }).check();
  await page.keyboard.press("Escape");
  await same(before);
  // 2) 리뷰 시트: 대기 → 결과 (같은 커밋을 우클릭하면 선택이 안 바뀐다)
  await page.locator(".commits").getByText("로그 파서").click();
  await expect(page.locator(".info .sha, .info").first()).toBeVisible();
  await page.waitForTimeout(300);
  before = await renders(page);
  await page.locator(".commits").getByText("로그 파서").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "AI 리뷰…", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: /AI 리뷰/ });
  await expect(sheet.getByRole("status")).toBeVisible();
  await expect(sheet.getByRole("list", { name: "리뷰 지적 사항" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await same(before);
});

test("토스트가 뜨고 닫히고 사라져도 그래프·사이드바·상세·툴바를 다시 그리지 않는다", async ({ page }) => {
  await page.clock.install();
  await page.waitForFunction(() => typeof (window as any).__toast === "function");
  await page.waitForTimeout(300); // 첫 로드 직후 비동기 갱신이 끝날 때까지
  const before = await renders(page);
  const show = (t: string, o?: object) => page.evaluate(([a, b]) => (window as any).__toast(a, b), [t, o] as const);
  await show("저장됨", { kind: "success" });
  await show("오류", { kind: "error", detail: "a\nb" });
  await show("정보", { kind: "info" });
  await show("정보", { kind: "info" }); // 합치기
  await expect(page.locator(".toast")).toHaveCount(3);
  await page.locator(".toast").first().hover(); // 마우스 올리기(타이머 멈춤)
  await page.getByRole("alert").getByRole("button", { name: "자세히" }).click();
  await page.mouse.move(2, 2);
  await page.clock.runFor(5000); // 성공·정보 자동 사라짐
  await expect(page.locator(".toast")).toHaveCount(1);
  await page.getByRole("alert").getByRole("button", { name: "닫기" }).click();
  await expect(page.locator(".toast")).toHaveCount(0);
  const after = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Details", "Toolbar"]) expect(after[id], id).toBe(before[id]);
});

test("파일 이전/다음 이동은 그래프·사이드바를 다시 그리지 않는다", async ({ page }) => {
  await page.locator(".commits").getByText("Merge branch 'feature/graph'").click();
  await page.getByRole("option", { name: /lib.rs/ }).click();
  const before = await renders(page);
  await page.getByRole("button", { name: "다음 파일" }).click();
  await expect(page.getByRole("option", { selected: true })).toContainText("CommitGraph.tsx");
  await page.keyboard.press("Alt+ArrowRight");
  await expect(page.getByRole("option", { selected: true })).toContainText("old.css");
  const after = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Toolbar"]) expect(after[id], id).toBe(before[id]);
});

test("이미지 diff 비교 방식 전환·슬라이더 드래그는 그래프·사이드바·툴바를 다시 그리지 않는다", async ({ page }) => {
  // beforeEach가 연 페이지에 이미지 mock을 심는다
  const m3 = sha("m3");
  await seedNow(page, { blobs: { [`${m3}^:img/a.png`]: BEFORE, [`${m3}:img/a.png`]: AFTER } });
  await page.locator(".commits").getByText("로컬 변경사항").click(); // 다른 커밋을 거쳐 와야 변경 파일을 다시 읽는다
  await page.getByRole("button", { name: "← 그래프" }).click(); // 넓은 변경 화면에서 그래프로
  await page.locator(".commits").getByText("Merge branch 'feature/graph'").click();
  await page.getByRole("option", { name: /a\.png/ }).click();
  await expect(page.locator(".img-info")).toContainText("바뀐 픽셀");
  const before = await renders(page);
  const modes = page.getByRole("radiogroup", { name: "이미지 비교 방식" });
  for (const m of ["슬라이더", "겹쳐 보기", "차이", "나란히"]) await modes.getByRole("radio", { name: m }).click();
  await modes.getByRole("radio", { name: "슬라이더" }).click();
  const f = (await page.locator(".img-frame").boundingBox())!;
  await page.mouse.move(f.x + f.width / 2, f.y + f.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(f.x + f.width / 2 - i * 3, f.y + f.height / 2);
  await page.mouse.up();
  const after = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Toolbar"]) expect(after[id], id).toBe(before[id]);
  // 드래그는 React 상태 없이 CSS 변수만 바꾸므로 이미지 diff도 다시 그려지지 않는다
  const mid = await renders(page);
  await page.mouse.move(f.x + 5, f.y + 5);
  expect((await renders(page)).ImageDiff).toBe(mid.ImageDiff);
});

test("변경 화면에서 status가 새로 읽혀도 같은 이미지는 file_blob을 다시 부르지 않는다", async ({ page }) => {
  await seedNow(page, { commitFiles: false, blobs: { "::img/a.png": BEFORE, "WORKTREE:img/a.png": AFTER }, status: [{ path: "img/a.png", index: ".", worktree: "M" }] });
  await page.evaluate(() => (window as any).__emit("repo-changed", { worktree: true, refs: false })); // 덧붙인 파일이 보이게 상태를 다시 읽는다
  await page.locator(".commits").getByText("로컬 변경사항").click();
  await page.getByRole("listbox", { name: "스테이지 안 됨", exact: true }).getByRole("option", { name: /a\.png/ }).click();
  await expect(page.locator(".img-info")).toContainText("바뀐 픽셀");
  const blobs = () => page.evaluate(() => (window as any).__git.filter((c: string[]) => c[0] === "file_blob").length);
  await page.waitForTimeout(300);
  const n = await blobs();
  expect(n).toBeGreaterThan(0);
  const before = await renders(page);
  for (let i = 0; i < 3; i++) await page.evaluate(() => (window as any).__emit("repo-changed", { worktree: true, refs: false }));
  await page.waitForTimeout(600);
  expect(await blobs()).toBe(n);
  const after = await renders(page);
  for (const id of ["CommitGraph", "Sidebar"]) expect(after[id], id).toBe(before[id]);
});

test("xib 시각 diff: 변경 목록 호버·클릭은 그래프·사이드바·상세·diff 본체를 다시 그리지 않는다", async ({ page }) => {
  const m3 = sha("m3"), p = "ui/SongCell.xib", b64 = (s: string) => Buffer.from(s).toString("base64");
  await seedNow(page, { path: p, diff: textDiff(p), blobs: { [`${m3}^:${p}`]: b64(cellXib(false)), [`${m3}:${p}`]: b64(cellXib(true)) } });
  await page.locator(".commits").getByText("로컬 변경사항").click();
  await page.getByRole("button", { name: "← 그래프" }).click(); // 넓은 변경 화면에서 그래프로
  await page.locator(".commits").getByText("Merge branch 'feature/graph'").click();
  await page.getByRole("option", { name: /SongCell\.xib/ }).click();
  await expect(page.locator(".ib-summary")).toBeVisible();
  const before = await renders(page);
  const items = page.getByRole("listbox", { name: "변경 목록" }).getByRole("option");
  for (let i = 0; i < 6; i++) await items.nth(i).hover();
  await items.nth(1).click();
  await expect(page.locator(".ib-hl").first()).toBeVisible();
  const after = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Details", "Toolbar", "DiffView", "IbDiff"]) expect(after[id], id).toBe(before[id]);
});

test("AI 읽는 흐름: 가이드 만들기·단계 이동·패널 열고 닫기는 그래프·사이드바·툴바를 다시 그리지 않고 diff는 주석만 갱신한다", async ({ page }) => {
  await page.locator(".commits").getByText("Merge branch 'feature/graph'").click();
  await expect(page.locator(".diff .add").first()).toBeVisible();
  const before = await renders(page);
  await page.getByRole("radiogroup", { name: "상세 보기" }).getByRole("radio", { name: "읽는 흐름" }).click();
  await page.getByRole("button", { name: "가이드 만들기" }).click();
  await expect(page.locator(".guide-step")).toHaveCount(3);
  const made = await renders(page);
  await page.locator(".guide-step").nth(1).click();
  await expect(page.locator(".note-card.cur")).toContainText("2단계");
  await page.keyboard.press("ControlOrMeta+]");
  await expect(page.locator(".note-card.cur")).toContainText("3단계");
  await page.keyboard.press("ControlOrMeta+[");
  await page.locator(".guide-sect-head").first().click(); // 접기·펴기·체크는 패널 안 상태
  await page.getByRole("checkbox").first().check();
  await page.keyboard.press("ControlOrMeta+Alt+i");
  await page.keyboard.press("ControlOrMeta+Alt+i");
  await expect(page.locator(".note-card.cur")).toContainText("2단계");
  const after = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Toolbar"]) expect(after[id], id).toBe(before[id]);
  // 단계 이동 중 그래프·사이드바·툴바는 0회
  const mid = await renders(page);
  await page.locator(".guide-step").nth(0).click();
  await expect(page.locator(".note-card.cur")).toContainText("1단계");
  const end = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Toolbar", "StatusBar"]) expect(end[id], id).toBe(mid[id]);
});

test("크게 보기(25e): 진입·종료·hunk 이동·줄바꿈 토글은 그래프·사이드바·툴바·상세를 다시 그리지 않고 그래프를 다시 읽지 않는다", async ({ page }) => {
  await page.locator(".commits").getByText("Merge branch 'feature/graph'").click();
  await expect(page.locator(".diff .add").first()).toBeVisible();
  const loads = await page.evaluate(() => (window as any).__graphLoads);
  const before = await renders(page);
  await page.locator(".diff-file").getByRole("button", { name: "크게 보기" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-big", "");
  await page.locator(".diff-file").getByRole("button", { name: "다음 변경 (⌥↓)" }).click();
  await page.keyboard.press("Alt+ArrowUp");
  await page.locator(".diff-file").getByRole("button", { name: "줄바꿈", exact: true }).click();
  await page.locator(".diff-file").getByRole("button", { name: "줄바꿈", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).not.toHaveAttribute("data-big", "");
  const after = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Details", "Toolbar", "StatusBar"]) expect(after[id], id).toBe(before[id]);
  expect(await page.evaluate(() => (window as any).__graphLoads)).toBe(loads);
});

test("가이드 단계 이동은 ImageDiff(memo)를 다시 그리지 않는다 (머리·추가 요소 props 안정)", async ({ page }) => {
  const m3 = sha("m3"), x = "ui/SongCell.xib", b64 = (s: string) => Buffer.from(s).toString("base64");
  const step = (title: string, file: string) => ({ title, file, startLine: 1, endLine: 1, detail: title });
  await page.evaluate(([g]) => ((window as any).__aiResult = { guide: g }), [{ overview: "o", decision: null, steps: [step("a", "img/a.png"), step("b", "img/a.png")], focus: [], apis: [], checks: [] }]);
  await seedNow(page, { blobs: { [`${m3}^:img/a.png`]: BEFORE, [`${m3}:img/a.png`]: AFTER } });
  await page.locator(".commits").getByText("로컬 변경사항").click();
  await page.getByRole("button", { name: "← 그래프" }).click(); // 넓은 변경 화면에서 그래프로
  await page.locator(".commits").getByText("Merge branch 'feature/graph'").click();
  await page.getByRole("option", { name: /a\.png/ }).click();
  await expect(page.locator(".img-info")).toContainText("바뀐 픽셀");
  await page.getByRole("radiogroup", { name: "상세 보기" }).getByRole("radio", { name: "읽는 흐름" }).click();
  await page.getByRole("button", { name: "가이드 만들기" }).click();
  await expect(page.locator(".guide-step")).toHaveCount(2);
  const before = await renders(page);
  await page.locator(".guide-step").nth(1).click();
  await expect(page.locator(".guide-count")).toHaveText("2 / 2");
  await page.keyboard.press("ControlOrMeta+[");
  await expect(page.locator(".guide-count")).toHaveText("1 / 2");
  const after = await renders(page);
  expect(after.DiffView, "DiffView는 단계 이동에 갱신(reveal)").toBeGreaterThan(before.DiffView);
  for (const id of ["CommitGraph", "Sidebar", "Toolbar", "ImageDiff"]) expect(after[id], id).toBe(before[id]);
});

test("가이드 단계 이동은 IbDiff(memo)를 다시 그리지 않는다", async ({ page }) => {
  const m3 = sha("m3"), x = "ui/SongCell.xib", b64 = (s: string) => Buffer.from(s).toString("base64");
  const step = (title: string, file: string) => ({ title, file, startLine: 1, endLine: 1, detail: title });
  await page.evaluate(([g]) => ((window as any).__aiResult = { guide: g }), [{ overview: "o", decision: null, steps: [step("a", x), step("b", x)], focus: [], apis: [], checks: [] }]);
  await seedNow(page, { path: x, diff: textDiff(x), blobs: { [`${m3}^:${x}`]: b64(cellXib(false)), [`${m3}:${x}`]: b64(cellXib(true)) } });
  await page.locator(".commits").getByText("로컬 변경사항").click();
  await page.getByRole("button", { name: "← 그래프" }).click(); // 넓은 변경 화면에서 그래프로
  await page.locator(".commits").getByText("Merge branch 'feature/graph'").click();
  await page.getByRole("option", { name: /SongCell\.xib/ }).click();
  await expect(page.locator(".ib-summary")).toBeVisible();
  await page.getByRole("radiogroup", { name: "상세 보기" }).getByRole("radio", { name: "읽는 흐름" }).click();
  await page.getByRole("button", { name: "가이드 만들기" }).click();
  await expect(page.locator(".guide-step")).toHaveCount(2);
  const b2 = await renders(page);
  await page.locator(".guide-step").nth(1).click();
  await expect(page.locator(".guide-count")).toHaveText("2 / 2");
  const a2 = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Toolbar", "IbDiff"]) expect(a2[id], id).toBe(b2[id]);
});

test("변경 화면 가이드: 상태가 계속 새로 읽혀도 쓰기 조회(write-tree) 없이 가이드가 유지되고 AI는 다시 부르지 않는다", async ({ page }) => {
  await page.locator(".commits").getByText("로컬 변경사항").click();
  await page.getByRole("radiogroup", { name: "상세 보기" }).getByRole("radio", { name: "읽는 흐름" }).click();
  await page.getByRole("button", { name: "가이드 만들기" }).click();
  await expect(page.locator(".guide-step")).toHaveCount(3);
  const n = () => page.evaluate(() => (window as any).__rawCalls as number);
  const before = await n();
  for (let i = 0; i < 5; i++) await page.evaluate(() => (window as any).__emit("repo-changed", { worktree: true, refs: false }));
  await page.waitForTimeout(300);
  expect(await n()).toBeLessThanOrEqual(before + 5); // 읽기 전용 조회만 (이벤트당 한 번 이하)
  await expect(page.locator(".guide-step")).toHaveCount(3); // 같은 내용이라 같은 키 → 캐시 유지
  const calls = (await page.evaluate(() => (window as any).__git as string[][])).map((c) => c[0] + " " + c[1]);
  expect(calls.filter((c) => c.includes("write-tree"))).toHaveLength(0);
  expect(calls.filter((c) => c.startsWith("ai_run"))).toHaveLength(1);
});

test("열 폭 드래그(그래프·작성자·날짜)는 CommitGraph·행을 다시 그리지 않고, 놓을 때만 반영된다", async ({ page }) => {
  const sp = page.locator(".commits-head .splitter.x");
  const before = await renders(page);
  for (const [i, dx] of [[1, -30], [2, -20], [3, -20]] as const) {
    const box = (await sp.nth(i).boundingBox())!;
    await page.mouse.move(box.x + 0.5, box.y + 10);
    await page.mouse.down();
    for (let k = 1; k <= 10; k++) await page.mouse.move(box.x + 0.5 + (dx * k) / 10, box.y + 10);
    const during = await renders(page);
    for (const id of ["CommitGraph", "CommitRow", "Sidebar", "Details"]) expect(during[id], `${id} 드래그 중`).toBe(before[id]);
    await page.mouse.up();
    before.CommitGraph = (await renders(page)).CommitGraph;
    before.CommitRow = (await renders(page)).CommitRow;
  }
  // 열 숨김 토글은 CommitGraph(와 행)만 다시 그린다. 사이드바·상세는 그대로
  const b2 = await renders(page);
  await page.locator(".commits-head").click({ button: "right", position: { x: 300, y: 10 } });
  await page.getByRole("menuitem", { name: "날짜" }).click();
  await expect(page.locator(".commits-head .date")).toHaveCount(0);
  const a2 = await renders(page);
  for (const id of ["Sidebar", "Details", "Toolbar"]) expect(a2[id], id).toBe(b2[id]);
});

test("PR 리뷰 화면: 열기·PR 선택·탭·검색·범위·목록 접기·폭 조절·닫기는 CommitGraph·Sidebar·Details·Toolbar를 다시 그리지 않는다", async ({ page }) => {
  const before = await renders(page);
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("dialog", { name: "빠른 실행" }).getByRole("textbox").fill("PR 리뷰");
  await page.keyboard.press("Enter");
  const scr = page.locator(".prr");
  await expect(scr.getByRole("option", { name: /#131/ })).toBeVisible();
  await expect(scr.locator(".prr-entry")).toHaveCount(4);
  await scr.getByRole("tab", { name: /^전체/ }).click();
  await scr.getByRole("option", { name: /#128/ }).click();
  await expect(scr.locator(".prr-stats")).toContainText("1/2");
  // 내가 올린 PR 묶음 접기·펼치기, 안내줄 [새 커밋 보기](→ 변경 파일 탭 + 커밋 메뉴) · 돌아가기, 탭 보조 글도 PR 화면 안에서만 다시 그린다
  await scr.getByRole("button", { name: /내가 올린 PR/ }).click();
  await scr.getByRole("button", { name: /내가 올린 PR/ }).click();
  await scr.locator(".prr-mine").getByRole("option").click();
  await scr.getByRole("option", { name: /#131/ }).click();
  await scr.locator(".prr-hint").getByRole("button", { name: "새 커밋 보기" }).click();
  await expect(page.getByRole("menuitem")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await scr.locator(".prr-files").getByRole("button", { name: /대화로 돌아가기/ }).click();
  await expect(scr.getByRole("tab", { name: /^개요/ }).locator("small")).toHaveText("대화 4건");
  // 변경 파일 탭(26b): 탭 진입·범위 전환·파일 선택·크게 보기도 PR 화면 안에서만 다시 그린다
  await scr.getByRole("tab", { name: "변경 파일" }).click();
  await expect(scr.locator(".prr-files ul.files").getByRole("option")).toHaveCount(3);
  await scr.locator(".prr-files").getByRole("radio", { name: "커밋별" }).click();
  await page.getByRole("menuitem").first().click();
  await scr.locator(".prr-files").getByRole("button", { name: "다음 커밋" }).click();
  // 목록 접기·펼치기·폭 조절
  await scr.getByRole("button", { name: /^목록 접기/ }).click();
  await scr.getByRole("button", { name: /^목록 펼치기/ }).click();
  const sp = (await page.locator(".prr > .splitter").first().boundingBox())!;
  await page.mouse.move(sp.x + 0.5, sp.y + 200);
  await page.mouse.down();
  await page.mouse.move(sp.x + 60, sp.y + 200, { steps: 3 });
  await page.mouse.up();
  await expect(scr.locator(".prr-files").locator(".diff")).toBeVisible();
  await scr.locator(".prr-files").getByRole("option", { name: /CommitGraph\.tsx/ }).dispatchEvent("mousedown");
  await scr.locator(".prr-files").getByRole("button", { name: /크게 보기/ }).first().click();
  await expect(page.locator("html")).toHaveAttribute("data-big", "");
  await page.keyboard.press("Escape");
  await scr.getByRole("tab", { name: "개요·대화" }).click();
  // AI 리뷰 탭(26c): 시작·결과·편집·체크·근거·코드에서 보기·게시·다시 리뷰도 PR 화면 안에서만 다시 그린다
  await scr.getByRole("tab", { name: /^AI 리뷰/ }).click();
  await scr.getByRole("button", { name: "AI 리뷰 시작" }).click();
  const cs = scr.locator(".prai-card");
  await expect(cs).toHaveCount(3);
  await cs.nth(0).getByRole("button", { name: "편집", exact: true }).click();
  await cs.nth(0).getByRole("textbox").fill("고친 문구");
  await cs.nth(0).getByRole("button", { name: "편집 완료" }).click();
  await cs.nth(2).getByRole("checkbox").check();
  await cs.nth(0).getByRole("button", { name: "근거 보기" }).click();
  await cs.nth(1).getByRole("button", { name: "코드에서 보기" }).click();
  await scr.locator(".prr-files").getByRole("button", { name: "← AI 리뷰로 돌아가기" }).click();
  await scr.locator(".prai-foot .prai-split").first().getByRole("button").first().click();
  await expect(scr.locator(".prai-done")).toBeVisible();
  await scr.getByRole("button", { name: /^다시 리뷰/ }).click();
  await page.getByRole("menuitem", { name: "전체 다시 리뷰" }).click();
  await expect(scr.locator(".prai-card").nth(0).locator(".prai-md")).toContainText("오버플로합니다");
  await scr.getByRole("tab", { name: "개요·대화" }).click();
  // 본문·리뷰 팝업(열기·이전/다음·크게·글자 크기·닫기)도 팝업 안에서만 다시 그린다
  await scr.locator(".prr-card.prr-peek").click();
  const pop = page.getByRole("dialog").filter({ has: page.locator(".prr-pop-body") });
  await expect(pop).toBeVisible();
  await page.keyboard.press("Escape");
  await scr.locator(".prr-entry.prr-peek").first().click();
  await pop.getByRole("button", { name: "다음 항목" }).click();
  await pop.getByRole("button", { name: "크게 보기" }).click();
  await pop.getByRole("button", { name: "글자 크게" }).click();
  await pop.getByRole("button", { name: "원래 크기" }).click();
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
  await scr.getByRole("textbox", { name: /번호·제목/ }).fill("로그인");
  await expect(scr.locator(".prr-items").getByRole("option")).toHaveCount(2); // 일치 1 + 검색과 무관한 내 PR 묶음 1
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(scr).toHaveCount(0);
  const after = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Details", "Toolbar", "StatusBar"]) expect(after[id], id).toBe(before[id]);
});

test("PR AI 새 커밋만 리뷰(시작·진행·합치기·묶음 접기·편집·체크·게시)는 CommitGraph·Sidebar·Details·Toolbar·StatusBar를 다시 그리지 않는다", async ({ page }) => {
  const newHead = "zzz999";
  const at = (m: number) => new Date(Date.now() - m * 60000).toISOString();
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("dialog", { name: "빠른 실행" }).getByRole("textbox").fill("PR 리뷰");
  await page.keyboard.press("Enter");
  const scr = page.locator(".prr");
  await expect(scr.getByRole("option", { name: /#131/ })).toBeVisible();
  await scr.getByRole("tab", { name: /^AI 리뷰/ }).click();
  await scr.getByRole("button", { name: "AI 리뷰 시작" }).click();
  await expect(scr.locator(".prai-card")).toHaveCount(3);
  const before = await renders(page);
  await page.evaluate(({ h, t1, t2 }) => {
    const w = window as any;
    w.__prDetail = { 131: { headSha: h, timeline: [{ kind: "commit", author: "A", at: t1, sha: "a131b2c3d4e5f6", body: "c" }, { kind: "commit", author: "A", at: t2, sha: h, body: "n" }] } };
    w.__aiSlow = 600;
    w.__aiResult = { prreview: { verdict: "comment", summary: "새 요약", praise: [], comments: [{ file: "crates/graph/src/lib.rs", line: 15, endLine: null, level: "must", title: "새 필수", body: "b", evidence: "" }], meta: { model: "m", inputTokens: 1, outputTokens: 1, elapsedMs: 1000 } } };
    w.__inbox = [{ number: 131, title: "설정 화면 다크 모드 색 맞추기", url: "u", head: "fix/settings-dark", base: "main", author: "Alex", authorAvatar: "", draft: false, createdAt: t1, updatedAt: t2, additions: 1, deletions: 1, labels: [], reviewers: [], approvals: 0, myReview: "none", reRequested: false, headSha: h, isMine: false, reviewRequested: true }];
  }, { h: newHead, t1: at(100), t2: at(5) });
  await scr.getByRole("button", { name: "Pull Request 새로고침" }).click();
  await scr.locator(".prai-banner.is-warn").getByRole("button", { name: "새 커밋만 리뷰" }).click();
  await scr.locator(".prai-card").nth(0).getByRole("button", { name: "편집", exact: true }).click();
  await scr.locator(".prai-card").nth(0).getByRole("textbox").fill("진행 중 편집");
  await expect(scr.locator(".prai-old")).toBeVisible();
  await scr.getByRole("button", { name: /^이전 리뷰/ }).click();
  await scr.getByRole("button", { name: /^이전 리뷰/ }).click();
  await scr.locator(".prai-card.old").nth(0).getByRole("checkbox").uncheck();
  await scr.locator(".prai-foot .prai-split").first().getByRole("button").first().click();
  await expect(scr.locator(".prai-done")).toBeVisible();
  const after = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Details", "Toolbar", "StatusBar"]) expect(after[id], id).toBe(before[id]);
});

test("탭 전환·넘침 메뉴·⌘⌥←/→는 CommitGraph·Sidebar·Details·Toolbar를 다시 그리지 않고 Tabs만 다시 그린다", async ({ page }) => {
  // 탭 15개를 열어 넘치게 한다 (작업공간 열기 = 탭 묶음 교체)
  await page.evaluate(() => localStorage.setItem("workspaces", JSON.stringify({ many: Array.from({ length: 15 }, (_, i) => `/work/projects/repo-${i + 1}`) })));
  await page.getByRole("tablist", { name: "열린 저장소" }).getByRole("button", { name: "작업공간" }).click();
  await page.getByRole("menuitem", { name: /작업공간: many/ }).click();
  const bar = page.getByRole("tablist", { name: "열린 저장소" });
  await expect(bar.getByRole("button", { name: "탭 15개" })).toBeVisible();
  await expect(bar.getByRole("tab", { selected: true })).toHaveText("repo-1");
  await expect(page.locator(".diff .add").first()).toBeVisible();
  const before = await renders(page);
  // 휠·스크롤은 렌더 0
  const b = (await page.locator(".tabs-scroll").boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.wheel(0, 300);
  await page.mouse.wheel(0, -300);
  const scrolled = await renders(page);
  expect(scrolled.Tabs, "Tabs").toBe(before.Tabs);
  // 넘침 메뉴로 전환 → 저장소가 바뀌면 그래프도 다시 읽는 건 정상이므로, 전환 중이 아닌 "메뉴 열기·닫기"만 따로 본다
  await bar.getByRole("button", { name: "탭 15개" }).click();
  await expect(page.getByRole("menu").getByRole("menuitem")).toHaveCount(15);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  const menu = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Details", "Toolbar", "StatusBar", "Tabs"]) expect(menu[id], id).toBe(before[id]);
  // 창 폭이 바뀌어 넘침이 켜지고 꺼져도 탭 줄만 다시 그린다
  await page.setViewportSize({ width: 1600, height: 720 });
  await expect(bar.getByRole("button", { name: "탭 15개" })).toHaveCount(0);
  await page.setViewportSize({ width: 1100, height: 720 });
  await expect(bar.getByRole("button", { name: "탭 15개" })).toBeVisible();
  const resized = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Details", "Toolbar", "StatusBar"]) expect(resized[id], id).toBe(before[id]);
  expect(resized.Tabs).toBeLessThanOrEqual(before.Tabs + 6);
  // 탭 전환(⌘⌥→)은 저장소를 다시 읽으니 그래프·사이드바도 다시 그리는 게 정상이다. 다만 탭 줄 스크롤·넘침 갱신이 렌더 루프를 만들면 안 되므로 한 번 전환에 상한을 둔다
  const t0 = await renders(page);
  await page.keyboard.press("ControlOrMeta+Alt+ArrowRight");
  await expect(bar.getByRole("tab", { selected: true })).toHaveText("repo-2");
  await expect(page.locator(".diff .add").first()).toBeVisible();
  await page.waitForTimeout(300);
  const t1 = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Details", "Toolbar"]) expect(t1[id] - t0[id], `${id} 전환 한 번`).toBeLessThanOrEqual(10);
  expect(t1.Tabs - t0.Tabs, "Tabs 전환 한 번").toBeLessThanOrEqual(6);
});

test("상태바 AI 항목: 공급자 전환·설정에서 공급자 변경·저장소별 끄기는 상태바 항목만 바꾸고 그래프·사이드바·툴바·상태바 본체는 다시 그리지 않는다(상세는 공급자 전환까지)", async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, { __ai: { consent: true, providers: { google: { key: true } } } }));
  await page.reload();
  await expect(page.locator(".diff .add").first()).toBeVisible();
  const item = page.locator(".statusbar .status-item");
  await expect(item).toHaveText("AI Claude · CLI");
  await page.waitForTimeout(400); // AI 상태 조회 등 비동기 갱신이 끝날 때까지
  const before = await renders(page);
  const same = async () => {
    const now = await renders(page);
    for (const id of ["CommitGraph", "Sidebar", "Details", "Toolbar", "StatusBar"]) expect(now[id], id).toBe(before[id]);
  };
  // 상태바 메뉴로 전환
  await item.click();
  await page.getByRole("menu").getByRole("menuitem", { name: /Gemini/ }).click();
  await expect(item).toHaveText("AI Gemini · API 키");
  // 설정에서 공급자·방식·저장소별 끄기를 바꾸면 항목이 따라 바뀐다
  await page.keyboard.press("ControlOrMeta+,");
  const dlg = page.getByRole("dialog", { name: "설정" });
  await dlg.getByRole("tab", { name: "AI", exact: true }).click();
  await dlg.getByRole("radio", { name: /Claude/ }).check();
  await expect(item).toHaveText("AI Claude · CLI");
  await same();
  // 저장소별 끄기는 AI 버튼이 있는 쪽(useAiOn 구독)이 바뀌는 게 맞으므로 그래프·사이드바·툴바·상태바 본체만 확인한다
  const base = await renders(page);
  await dlg.getByLabel(/이 저장소에서 AI 끄기/).check();
  await expect(item).toHaveText("AI 꺼짐(이 저장소)");
  await dlg.getByLabel(/이 저장소에서 AI 끄기/).uncheck();
  await expect(item).toHaveText("AI Claude · CLI");
  await page.keyboard.press("Escape");
  const now = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Toolbar", "StatusBar"]) expect(now[id], id).toBe(base[id]);
});

test("설정 > 이슈 링크 Jira: 입력·추천 적용·저장소별 끄기는 그래프·사이드바·툴바를 다시 그리지 않는다(상세는 링크 갱신만)", async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, { __jiraLog: "ABC-1 a\nABC-2 b\nhttps://j.acme.test/browse/ABC-3\n" }));
  await page.reload();
  await expect(page.locator(".diff .add").first()).toBeVisible();
  await page.waitForTimeout(300);
  const before = await renders(page);
  const same = async () => {
    const now = await renders(page);
    for (const id of ["CommitGraph", "Sidebar", "Toolbar"]) expect(now[id], id).toBe(before[id]);
  };
  await page.keyboard.press("ControlOrMeta+,");
  const dlg = page.getByRole("dialog", { name: "설정" });
  await dlg.getByRole("tab", { name: "이슈 링크", exact: true }).click();
  const jira = dlg.getByRole("form", { name: "Jira" });
  await jira.getByRole("status").getByRole("button", { name: "적용" }).click();
  await expect(dlg.getByRole("list", { name: "이슈 링크 규칙 목록" })).toContainText("https://j.acme.test/browse/$&");
  await jira.getByLabel("프로젝트 키", { exact: true }).fill("ZZZ");
  await jira.getByLabel("이 저장소에서 Jira 링크 끄기").check();
  await jira.getByRole("button", { name: "저장" }).click();
  await expect(dlg.getByRole("list", { name: "이슈 링크 규칙 목록" })).not.toContainText("browse");
  await same();
});

test("상태바 gh 계정 항목: 전환·연결·해제·접근 확인·포커스 재조회는 그래프·사이드바·상세·툴바·상태바 본체를 다시 그리지 않는다", async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, { __gh: { installed: true, accounts: [{ user: "me", active: true }, { user: "goldtagworks", active: false }] } }));
  await page.reload();
  await expect(page.locator(".diff .add").first()).toBeVisible();
  const item = page.locator(".statusbar .status-item").first();
  await expect(item).toHaveText("GitHub 계정 me");
  await page.waitForTimeout(400);
  const before = await renders(page);
  const menu = () => page.getByRole("menu").getByRole("menuitem");
  await item.click();
  await menu().filter({ hasText: /^\s*goldtagworks\s*$/ }).click();
  await expect(item).toHaveText("GitHub 계정 goldtagworks");
  await item.click();
  await menu().filter({ hasText: "이 저장소를 me에 연결" }).click();
  await expect(item).toHaveText("GitHub 계정 goldtagworks → me");
  await item.click();
  await menu().filter({ hasText: "원격 접근 확인" }).click();
  await expect(menu().first()).toContainText("접근 가능");
  await page.keyboard.press("Escape");
  await item.click();
  await menu().filter({ hasText: "이 저장소 연결 해제" }).click();
  await expect(item).toHaveText("GitHub 계정 goldtagworks");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(200);
  const now = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Details", "Toolbar", "StatusBar"]) expect(now[id], id).toBe(before[id]);
});

test("PR 화면 sha 링크: 호버 카드·팝업에서 PR 커밋으로 이동·돌아가기·비PR 커밋 그래프 선택 전까지 CommitGraph·Sidebar·Toolbar를 다시 그리지 않는다", async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, { __prDetail: { 131: { body: "참고 930b8b1 와 deadbe1" } }, __shaInfo: { "930b8b1": { author: "Alex", at: new Date().toISOString(), subject: "제목", files: 2 } } }));
  await page.reload();
  await expect(page.locator(".diff .add").first()).toBeVisible();
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("dialog", { name: "빠른 실행" }).getByRole("textbox").fill("PR 리뷰");
  await page.keyboard.press("Enter");
  const scr = page.locator(".prr");
  await expect(scr.locator(".prr-card.prr-peek")).toBeVisible();
  await page.waitForTimeout(300);
  const before = await renders(page);
  await scr.locator(".prr-card.prr-peek").click();
  const pop = page.getByRole("dialog").filter({ has: page.locator(".prr-pop-body") });
  await pop.locator("a[data-sha]", { hasText: "930b8b1" }).hover();
  await expect(page.getByRole("tooltip")).toContainText("파일 2개");
  await pop.locator("a[data-sha]", { hasText: "930b8b1" }).click();
  await expect(scr.getByRole("tab", { name: "변경 파일" })).toHaveAttribute("aria-selected", "true");
  await scr.locator(".prr-files").getByRole("button", { name: /돌아가기/ }).click();
  await expect(pop).toBeVisible();
  const now = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Toolbar"]) expect(now[id], id).toBe(before[id]);
});

const BASE = ["CommitGraph", "Sidebar", "Details", "Toolbar", "StatusBar"];

test("gh 항목: 창 포커스·원격 작업 완료 재조회는 값이 같든 바뀌든 GhStatusItem만 다시 그린다", async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, { __gh: { installed: true, accounts: [{ user: "me", active: true }, { user: "goldtagworks", active: false }] } }));
  await page.reload();
  await expect(page.locator(".diff .add").first()).toBeVisible();
  const item = page.locator(".statusbar .status-item").first();
  await expect(item).toHaveText("GitHub 계정 me");
  await page.waitForTimeout(400);
  const before = await renders(page);
  // 값이 같을 때: 포커스 → 렌더 증가 없음
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(250);
  const same = await renders(page);
  for (const id of [...BASE, "GhStatusItem"]) expect(same[id], id).toBe(before[id]);
  // 값이 바뀔 때(외부 gh auth switch): GhStatusItem만
  await page.evaluate(() => Object.assign((window as any).__gh, { accounts: [{ user: "me", active: false }, { user: "goldtagworks", active: true }] }));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(item).toHaveText("GitHub 계정 goldtagworks");
  // 원격 작업(Fetch) 완료 뒤 재조회: 작업 자체의 렌더(버튼 잠금 등)는 정상이므로, 값이 같을 때와 바뀔 때의 증가분이 같아야 한다(gh 때문에 더 그려지지 않음)
  const fetchOnce = async (expectText: string) => {
    const b = await renders(page);
    await page.locator(".toolbar").getByRole("button", { name: "Fetch", exact: true }).click();
    await expect(item).toHaveText(expectText, { timeout: 5000 });
    await page.waitForTimeout(1500);
    const a = await renders(page);
    return Object.fromEntries(BASE.map((id) => [id, a[id] - b[id]]));
  };
  const dSame = await fetchOnce("GitHub 계정 goldtagworks");
  await page.evaluate(() => Object.assign((window as any).__gh, { accounts: [{ user: "me", active: true }, { user: "goldtagworks", active: false }] }));
  const dChanged = await fetchOnce("GitHub 계정 me");
  expect(dChanged).toEqual(dSame);
});

test("AI 공급자 전환(상태바 메뉴·설정, 사용 가능 여부는 그대로)은 그래프·사이드바·툴바·상태바·상세·변경 화면을 다시 그리지 않는다", async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, { __ai: { consent: true, providers: { google: { key: true } } } }));
  await page.reload();
  await expect(page.locator(".diff .add").first()).toBeVisible();
  await page.locator(".commits").getByText("로컬 변경사항").click(); // ChangesView 마운트 (useAiOn 구독)
  await expect(page.getByRole("listbox", { name: "스테이지됨", exact: true })).toBeVisible();
  const item = page.locator(".statusbar .status-item");
  await expect(item).toHaveText("AI Claude · CLI");
  await page.waitForTimeout(500);
  const before = await renders(page);
  await item.click();
  await page.getByRole("menu").getByRole("menuitem", { name: /Gemini/ }).click(); // 둘 다 "쓸 수 있음" → useAiOn 값 그대로
  await expect(item).toHaveText("AI Gemini · API 키");
  await page.keyboard.press("ControlOrMeta+,");
  const dlg = page.getByRole("dialog", { name: "설정" });
  await dlg.getByRole("tab", { name: "AI", exact: true }).click();
  await dlg.getByRole("radio", { name: /Claude/ }).check();
  await expect(item).toHaveText("AI Claude · CLI");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const now = await renders(page);
  for (const id of [...BASE, "ChangesView"]) expect(now[id], id).toBe(before[id]);
});

test("설정 가져오기: 언어가 같은 파일을 적용해도 렌더 횟수가 늘지 않는다", async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, { __settingsApplied: { applied: ["ui"], backup: "/demo/b.json", ui: { language: "ko" }, reconnect: [], skipped: [] } }));
  await page.reload();
  await expect(page.locator(".diff .add").first()).toBeVisible();
  await page.keyboard.press("ControlOrMeta+,");
  const dlg = page.getByRole("dialog", { name: "설정" });
  await dlg.getByRole("tab", { name: "일반", exact: true }).click();
  await dlg.getByRole("button", { name: "설정 가져오기…" }).click();
  const imp = page.getByRole("dialog", { name: "설정 가져오기" });
  await expect(imp).toBeVisible();
  await page.waitForTimeout(300);
  const before = await renders(page);
  for (const l of ["AI 설정", "호스팅 계정", "전역 git403 git 설정", "외부 diff·merge 도구"]) await imp.getByRole("checkbox", { name: l }).uncheck();
  await imp.getByRole("button", { name: "선택한 항목 가져오기" }).click();
  await expect(imp.getByRole("status")).toContainText("백업");
  await page.waitForTimeout(200);
  const now = await renders(page);
  for (const id of [...BASE, "Toolbar", "GhStatusItem", "AiStatusItem"]) expect(now[id], id).toBe(before[id]);
});

test("sha 호버 카드: 호버로 카드가 뜨는 순간과 같은 sha 위 재호버는 PR 화면·팝업·그래프·사이드바·상세·툴바·상태바를 다시 그리지 않는다", async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, { __prDetail: { 131: { body: "참고 930b8b1 와 deadbe1" } }, __shaInfo: { "930b8b1": { author: "Alex", at: new Date().toISOString(), subject: "제목", files: 2 } } }));
  await page.reload();
  await expect(page.locator(".diff .add").first()).toBeVisible();
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("dialog", { name: "빠른 실행" }).getByRole("textbox").fill("PR 리뷰");
  await page.keyboard.press("Enter");
  const scr = page.locator(".prr");
  await expect(scr.locator(".prr-card.prr-peek")).toBeVisible();
  await scr.locator(".prr-card.prr-peek").click();
  const pop = page.getByRole("dialog").filter({ has: page.locator(".prr-pop-body") });
  const link = pop.locator("a[data-sha]", { hasText: "930b8b1" });
  await expect(link).toBeVisible();
  await page.waitForTimeout(400);
  const before = await renders(page); // 클릭 전 단계: 팝업이 이미 열린 상태
  await link.hover();
  await expect(page.getByRole("tooltip")).toContainText("파일 2개");
  const shown = await renders(page);
  for (const id of [...BASE, "PrReview", "PrPopupHost", "Popup"]) expect(shown[id], id).toBe(before[id]);
  await link.hover({ position: { x: 3, y: 3 } }); // 같은 sha 위 재호버
  await page.mouse.move(0, 0, { steps: 1 });
  await link.hover({ position: { x: 5, y: 5 } });
  await page.waitForTimeout(500);
  const again = await renders(page);
  for (const id of [...BASE, "PrReview", "PrPopupHost", "Popup"]) expect(again[id], id).toBe(before[id]);
});

test("로컬 변경사항 넓게 보기를 끄면(← 그래프로) CommitGraph를 다시 그리지 않는다", async ({ page }) => {
  await page.locator(".commits").getByText("로컬 변경사항").click();
  await expect(page.locator(".main[data-wide]")).toBeVisible();
  await page.waitForTimeout(400);
  const before = await renders(page);
  await page.locator(".wide-bar").getByRole("button").click();
  await expect(page.locator(".main[data-wide]")).toHaveCount(0);
  const now = await renders(page);
  expect(now.CommitGraph, "CommitGraph").toBe(before.CommitGraph);
  expect(now.Sidebar, "Sidebar").toBe(before.Sidebar);
});

test("diff 문맥 펼치기·파일 전체·공백 표시는 CommitGraph·Sidebar·Toolbar·StatusBar를 다시 그리지 않는다", async ({ page }) => {
  const M3 = sha("m3");
  const file = Array.from({ length: 60 }, (_, i) => `let v${i + 1} = ${i + 1};`).join("\n") + "\n";
  // 파일은 diff를 그린 뒤 미리 한 번 읽어 두므로 처음부터 심고 다시 연다
  await page.addInitScript(([k, v]) => ((window as any).__blobs = { [k]: v }), [`${M3}:crates/graph/src/lib.rs`, Buffer.from(file).toString("base64")]);
  await page.reload();
  await page.getByRole("button", { name: "저장소 열기" }).click({ timeout: 3000 }).catch(() => {});
  await page.locator(".commits").getByText("Merge branch 'feature/graph'").click();
  await page.getByRole("option", { name: /lib\.rs/ }).click();
  await expect(page.locator(".diff .xrow").first()).toBeVisible();
  await page.waitForTimeout(400);
  const before = await renders(page);
  await page.locator(".diff .xrow").nth(1).getByRole("button", { name: "위로 20줄" }).click();
  await expect(page.locator(".dl.xl")).toHaveCount(20);
  await page.getByRole("radiogroup", { name: "보여 줄 내용" }).getByRole("radio", { name: "파일 전체" }).click();
  await expect(page.locator(".dl.xl")).toHaveCount(44);
  await page.getByRole("radiogroup", { name: "보여 줄 내용" }).getByRole("radio", { name: "Diff" }).click();
  await expect(page.locator(".dl.xl")).toHaveCount(20); // 따로 펼친 줄은 그대로
  const now = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Toolbar", "StatusBar"]) expect(now[id], id).toBe(before[id]);
});

test("우클릭 메뉴 열기·닫기는 CommitGraph·Sidebar·Details·Toolbar·StatusBar를 다시 그리지 않는다 (메뉴 상태는 DomMenuHost 안)", async ({ page }) => {
  await page.locator(".commits").getByText("로그 파서").click(); // 우클릭이 행을 고르는 렌더링은 빼고 잰다
  await page.waitForTimeout(400);
  const before = await renders(page);
  for (let i = 0; i < 2; i++) {
    await page.locator(".commits").getByText("로그 파서").click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Hard: 모든 변경 버리기" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
  }
  await page.locator(".side").getByRole("button", { name: /WIP on main/ }).click({ button: "right" });
  await page.keyboard.press("Escape");
  const now = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Details", "Toolbar", "StatusBar"]) expect(now[id], id).toBe(before[id]);
});

test("메뉴 막대로 실행한 Pull의 진행률 동안 그래프·사이드바·상세·툴바를 다시 그리지 않는다 (메뉴 막대는 렌더링과 무관한 외부 구성)", async ({ page }) => {
  await page.evaluate(() => (window as any).__appMenu.run("저장소", "Pull"));
  await expect(page.getByRole("button", { name: "Pull 취소" })).toBeVisible();
  const before = await renders(page);
  await expect(page.locator(".status-progress")).toContainText("Receiving objects");
  const during = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Details", "Toolbar"]) expect(during[id], id).toBe(before[id]);
});

test("지원 작업이 제한된 백엔드(capabilities)도 진행률 이벤트 동안 그래프·사이드바·상세·툴바를 다시 그리지 않는다", async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, { __caps: { all: false, ops: ["log", "status", "fetch", "pull"] } }));
  await page.reload();
  await expect(page.locator(".diff .add").first()).toBeVisible();
  await expect(page.locator(".toolbar").getByRole("button", { name: "Push", exact: true })).toHaveCount(0);
  await page.locator(".toolbar").getByRole("button", { name: "Pull", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pull 취소" })).toBeVisible();
  const before = await renders(page);
  await expect(page.locator(".status-progress")).toContainText("Receiving objects");
  const during = await renders(page);
  for (const id of ["CommitGraph", "Sidebar", "Details", "Toolbar"]) expect(during[id], id).toBe(before[id]);
});
