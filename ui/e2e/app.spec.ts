import { expect, test, type Page } from "@playwright/test";

const openRepo = async (page: Page) => {
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
};
// file_blob는 diff를 그린 뒤 idle에 미리 읽는 문맥 펼치기(25f)라 사용자 동작이 아니다
const gitCalls = (page: Page) => page.evaluate(() => ((window as any).__git as string[][]).filter((c) => c[0] !== "file_blob"));
const menuItem = (page: Page, name: string | RegExp) => page.getByRole("menu").getByRole("menuitem", { name });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
});

test("저장소를 열면 툴바·그래프·사이드바가 채워진다", async ({ page }) => {
  await expect(page.getByText("저장소를 열어 시작하세요")).toBeVisible();
  await openRepo(page);

  const toolbar = page.locator(".toolbar");
  await expect(toolbar.locator(".picker").first()).toContainText("git403");
  await expect(toolbar.locator(".picker").nth(1)).toContainText("main");
  // ahead/behind 배지: Pull ↓2, Push ↑1, 스태시 1개
  await expect(toolbar.getByRole("button", { name: "Pull", exact: true })).toContainText("2");
  await expect(toolbar.getByRole("button", { name: "Push", exact: true })).toContainText("1");
  await expect(page.locator(".statusbar")).toContainText("↑1 ↓2");

  const canvas = page.locator("canvas");
  expect((await canvas.boundingBox())!.width).toBeGreaterThan(40);
});

test("사이드바에서 브랜치를 고르면 커밋 상세와 diff가 보인다", async ({ page }) => {
  await openRepo(page);
  const branches = page.locator(".sidebar section").first();
  await expect(branches.getByRole("button", { name: "feature", exact: true })).toHaveAttribute("aria-expanded", "true");
  await branches.getByRole("button", { name: "pull-lock", exact: true }).click();
  await expect(page.locator(".row.selected")).toContainText("pull 중 UI 멈춤 수정");
  // 그래프에서 고르면 그 커밋을 가리키는 ref가 강조된다 (main = 로컬 main + origin/main 아님: m300000)
  await page.locator(".commits").getByText("README 정리").click();
  await expect(page.locator(".sidebar [aria-current]")).toHaveText(["main"]);
  await expect(page.locator(".sidebar [aria-current]")).toHaveCount(1);
  await page.locator(".commits").getByText("진행률 이벤트 분리").click();
  await expect(page.locator(".sidebar [aria-current]")).toHaveCount(0);
  await branches.getByRole("button", { name: "pull-lock", exact: true }).click();
  await expect(branches.getByRole("button", { name: "pull-lock", exact: true })).toHaveAttribute("aria-current", "true");
  await branches.getByRole("button", { name: "graph", exact: true }).click();
  await expect(page.locator(".sidebar [aria-current]")).toHaveCount(1);
  await expect(branches.getByRole("button", { name: "graph", exact: true })).toHaveClass(/picked/);
  await branches.getByRole("button", { name: "pull-lock", exact: true }).click();
  await expect(page.locator(".info-subject")).toHaveText("pull 중 UI 멈춤 수정");

  await page.getByRole("option", { name: /CommitGraph.tsx/ }).click();
  await expect(page.locator(".diff")).toContainText("ui/src/CommitGraph.tsx");
});

test("변경 파일을 트리와 목록으로 전환할 수 있다", async ({ page }) => {
  await openRepo(page);
  await page.locator(".commits").getByText("Initial commit").click();
  const files = page.getByRole("listbox", { name: "변경 파일" });
  await page.getByRole("radio", { name: "트리" }).click();
  await expect(files.locator("li.dir", { hasText: "crates/graph/src" })).toBeVisible();
  await page.getByRole("radio", { name: "목록" }).click();
  await expect(files.locator("li.dir")).toHaveCount(0);
});

test("로컬 변경사항: 스테이지 → 커밋", async ({ page }) => {
  await openRepo(page);
  await page.getByText("로컬 변경사항").click();
  const unstaged = page.getByRole("listbox", { name: "스테이지 안 됨" });
  const staged = page.getByRole("listbox", { name: "스테이지됨", exact: true });
  await expect(unstaged.getByRole("option")).toHaveCount(2);
  await expect(staged.getByRole("option")).toHaveCount(1);

  // 더블클릭으로 스테이지
  await unstaged.getByRole("option", { name: /Toolbar.tsx/ }).dblclick();
  await expect(staged.getByRole("option")).toHaveCount(2);

  // hunk 스테이지 버튼과 줄 선택
  await unstaged.getByRole("option", { name: /notes.md/ }).click();
  await expect(page.locator(".diff")).toContainText("notes.md");

  const commit = page.getByRole("button", { name: "커밋", exact: true });
  await expect(commit).toBeDisabled(); // 제목 없음
  await page.getByLabel("커밋 제목").fill("툴바 개편");
  await page.getByLabel("커밋 설명").fill("아이콘과 배지");
  await commit.click();
  expect((await gitCalls(page)).at(-1)).toEqual(["commit", "툴바 개편\n\n아이콘과 배지"]);
  await expect(staged.getByRole("option")).toHaveCount(0);
});

test("diff에서 줄을 골라 그 줄만 스테이지한다", async ({ page }) => {
  await openRepo(page);
  await page.getByText("로컬 변경사항").click();
  await page.getByRole("listbox", { name: "스테이지 안 됨" }).getByRole("option", { name: /Toolbar.tsx/ }).click();
  const diff = page.locator(".diff");
  await diff.getByText("// 레인마다 색을 다르게 준다.").click();
  await diff.getByText("let mut next_color = 0;").click({ modifiers: ["Shift"] });
  await diff.getByRole("button", { name: "선택한 줄 스테이지" }).click();
  const [cmd, args] = (await gitCalls(page)).at(-1)!;
  expect(cmd).toBe("apply_partial");
  expect(JSON.parse(args)).toMatchObject({ hunk: 0, lines: [2, 3], target: "stage" });
});

test("커밋 우클릭 메뉴로 브랜치를 만든다", async ({ page }) => {
  await openRepo(page);
  await page.locator(".commits").getByText("로그 파서").click({ button: "right" });
  await menuItem(page, "여기서 새 브랜치…").click();
  const sheet = page.getByRole("dialog", { name: "새 브랜치" });
  await sheet.getByRole("textbox").fill("feature/menu");
  await sheet.getByRole("button", { name: "만들기" }).click();
  expect((await gitCalls(page)).at(-1)).toEqual(["switch", "-c", "feature/menu", "c3".padEnd(40, "0")]);
});

test("사이드바 우클릭: 브랜치 머지, 스태시 적용", async ({ page }) => {
  await openRepo(page);
  await page.locator(".sidebar").getByRole("button", { name: "pull-lock", exact: true }).click({ button: "right" });
  await menuItem(page, "현재 브랜치에 머지…").click();
  await page.getByRole("dialog").getByRole("button", { name: "머지" }).click();
  expect((await gitCalls(page)).at(-1)).toEqual(["merge", "--no-edit", "hotfix/pull-lock"]);

  await page.locator(".sidebar").getByRole("button", { name: /툴바 배치 실험/ }).click({ button: "right" });
  await menuItem(page, "적용하고 삭제 (pop)").click();
  expect((await gitCalls(page)).at(-1)).toEqual(["stash", "pop", "stash@{0}"]);
});

test("빠른 실행으로 브랜치를 체크아웃한다", async ({ page }) => {
  await openRepo(page);
  await page.keyboard.press("ControlOrMeta+p");
  const palette = page.getByRole("dialog", { name: "빠른 실행" });
  await palette.getByRole("textbox").fill("체크아웃 graph");
  await expect(palette.getByRole("option").first()).toContainText("feature/graph");
  await page.keyboard.press("Enter");
  expect((await gitCalls(page)).at(-1)).toEqual(["switch", "feature/graph"]);
});

test("⌘W는 열린 팝업 → 저장소 탭 → 창 숨기기 순으로 하나만 닫는다", async ({ page }) => {
  await openRepo(page);
  const palette = page.getByRole("dialog", { name: "빠른 실행" });
  const tabs = page.getByRole("tablist").getByRole("tab");
  const n = await tabs.count();
  await page.keyboard.press("ControlOrMeta+p");
  await expect(palette).toBeVisible();
  await page.keyboard.press("ControlOrMeta+w"); // Ctrl+W(Windows) 경로
  await expect(palette).toBeHidden();
  await expect(tabs).toHaveCount(n);
  await page.keyboard.press("ControlOrMeta+p");
  await expect(palette).toBeVisible();
  await page.evaluate(() => (window as any).__emit("close-key", null)); // macOS 메뉴 "닫기" 경로
  await expect(palette).toBeHidden();
  await expect(tabs).toHaveCount(n);
  await page.evaluate(() => (window as any).__emit("close-key", null));
  await expect(tabs).toHaveCount(n - 1);
  const hidden = async () => (await gitCalls(page)).some((c) => c[0] === "window_hide");
  expect(await hidden()).toBe(false);
  for (let k = 1; k < n; k++) await page.evaluate(() => (window as any).__emit("close-key", null));
  await expect(tabs).toHaveCount(0);
  await page.evaluate(() => (window as any).__emit("close-key", null));
  await expect.poll(hidden).toBe(true);
});

test("상태바 버전을 누르면 그 버전의 릴리스 노트를 연다", async ({ page }) => {
  await openRepo(page);
  const v = page.locator(".statusbar .status-version");
  await expect(v).toHaveAttribute("title", "릴리스 노트 보기");
  await v.click();
  await expect.poll(async () => ((await page.evaluate(() => (window as any).__git)) as string[][]).filter((c) => c[0] === "open_url").at(-1)?.[1]).toBe(`https://github.com/goldtagworks/git403/releases/tag/v${await v.textContent()}`);
});

test("Pull 중에도 UI가 반응하고 상태바에 진행률과 완료가 표시된다", async ({ page }) => {
  await openRepo(page);
  await page.locator(".toolbar").getByRole("button", { name: "Pull", exact: true }).click();
  const bar = page.locator(".statusbar");
  await expect(bar.getByRole("button", { name: "Pull 취소" })).toBeVisible();
  // 작업 중에도 다른 조작이 된다
  await page.locator(".commits").getByText("로그 파서").click();
  await expect(page.locator(".info-subject")).toHaveText("로그 파서");
  // 받을 커밋이 없으면 "이미 최신"
  await expect(page.locator(".toast", { hasText: "이미 최신" })).toContainText("받을 커밋이 없습니다");
});

test("Pull 완료 토스트는 받은 커밋 수를, Push 완료 토스트는 올린 커밋 수를 알려 준다", async ({ page }) => {
  await openRepo(page);
  await page.evaluate(() => ((window as any).__behind = new Proxy({}, { get: () => 3 })));
  await page.locator(".toolbar").getByRole("button", { name: "Pull", exact: true }).click();
  await expect(page.locator(".toast", { hasText: "Pull 완료" })).toContainText("커밋 3개 받음");
  await page.locator(".toolbar").getByRole("button", { name: "Push", exact: true }).click();
  await expect(page.locator(".toast", { hasText: "Push 완료" })).toContainText("커밋 1개 올림");
});

test("원격 인증 요청이 오면 비밀번호를 입력받아 돌려준다", async ({ page }) => {
  await openRepo(page);
  await page.evaluate(() => (window as any).__emit("askpass", { id: 7, prompt: "Password for 'https://me@github.com':" }));
  const sheet = page.getByRole("dialog", { name: "인증 필요" });
  await expect(sheet).toContainText("https://me@github.com");
  const input = sheet.locator("input[type=password]");
  await input.fill("ghp_token");
  await sheet.getByRole("button", { name: "확인" }).click();
  const [cmd, args] = (await gitCalls(page)).at(-1)!;
  expect(cmd).toBe("askpass_reply");
  expect(JSON.parse(args)).toEqual({ id: 7, answer: "ghp_token" });
});

test("interactive rebase: 커밋 순서·동작을 골라 실행한다", async ({ page }) => {
  await openRepo(page);
  // main(m3)의 첫 부모 사슬: m3 ← c5 ← m2 … 머지가 끼면 막힌다
  await page.locator(".commits").getByText("README 정리").click({ button: "right" });
  await menuItem(page, "여기 다음부터 interactive rebase…").click();
  await expect(page.getByRole("alert")).toContainText("머지 커밋");
});

test("커밋 검색: 메시지로 찾고 Enter로 이동, 내용 검색", async ({ page }) => {
  await openRepo(page);
  await page.keyboard.press("ControlOrMeta+f");
  const box = page.getByLabel("커밋 검색");
  await box.fill("그래프");
  await expect(page.locator(".search-bar")).toContainText("/ 2");
  await box.press("Enter");
  await expect(page.locator(".row.selected")).toContainText("그래프");

  await page.locator(".search-bar").getByLabel("내용").check();
  await box.fill("lanes");
  await box.press("Enter");
  await expect(page.locator(".row.match")).toHaveCount(2);
});

test("파일 우클릭: 히스토리·blame 창", async ({ page }) => {
  await openRepo(page);
  const file = page.getByRole("listbox", { name: "변경 파일" }).getByRole("option").first();
  await file.click({ button: "right" });
  await menuItem(page, "파일 히스토리").click();
  const hist = page.getByRole("dialog", { name: "파일 히스토리" });
  await expect(hist.getByRole("option")).toHaveCount(4);
  await hist.locator(".sheet-actions").getByRole("button", { name: "닫기" }).click();

  await file.click({ button: "right" });
  await menuItem(page, "Blame").click();
  await expect(page.getByRole("dialog", { name: "Blame" })).toContainText("let lanes = Vec::new();");
});

test("추적 안 하는 파일을 .gitignore에 추가한다", async ({ page }) => {
  await openRepo(page);
  await page.getByText("로컬 변경사항").click();
  await page.getByRole("listbox", { name: "스테이지 안 됨" }).getByRole("option", { name: /notes.md/ }).click({ button: "right" });
  await menuItem(page, "무시 목록에 추가 (.gitignore)").click();
  await page.getByRole("dialog", { name: "무시 목록에 추가" }).getByRole("button", { name: "추가" }).click();
  const [cmd, args] = (await gitCalls(page)).at(-1)!;
  expect(cmd).toBe("append_line");
  expect(JSON.parse(args)).toMatchObject({ file: ".gitignore", line: "notes.md" });
});

test("테마는 설정 메뉴에서 바꾸고 새로고침 후에도 유지된다", async ({ page }) => {
  await openRepo(page);
  await page.locator(".toolbar").getByRole("button", { name: "설정" }).click();
  await menuItem(page, /다크/).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("네이티브 앱 규칙: 버튼에 포인터 커서가 없다", async ({ page }) => {
  const cursor = await page.getByRole("button", { name: "저장소 열기" }).evaluate((el) => getComputedStyle(el).cursor);
  expect(cursor).not.toBe("pointer");
});

// ---- 저장소 관리 ----
const tabs = (page: Page) => page.getByRole("tablist", { name: "열린 저장소" });

test("복제: URL에서 이름을 추정하고, 끝나면 새 저장소를 탭으로 연다", async ({ page }) => {
  await page.getByRole("button", { name: "복제…" }).click();
  const sheet = page.getByRole("dialog", { name: "저장소 복제" });
  await sheet.getByLabel("URL").fill("https://github.com/me/hello-world.git");
  await expect(sheet.getByLabel("이름")).toHaveValue("hello-world");
  await sheet.getByRole("button", { name: "선택…" }).click();
  await expect(sheet.getByLabel("위치")).toHaveValue("/demo");
  await sheet.getByRole("button", { name: "복제" }).click();
  const [cmd, args] = (await gitCalls(page)).at(-1)!;
  expect(cmd).toBe("start_job");
  expect(JSON.parse(args)).toEqual({ repo: "/demo", args: ["clone", "--progress", "--", "https://github.com/me/hello-world.git", "hello-world"] });
  await expect(tabs(page).getByRole("tab", { name: "hello-world" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".toolbar .picker").first()).toContainText("hello-world");
});

test("복제: gh 계정이 여럿이면 고른 계정으로 받고 새 저장소에 연결한다 (하나면 선택 없음)", async ({ page }) => {
  await page.evaluate(() => ((window as any).__gh = { installed: true, accounts: [{ user: "alice", active: true }] }));
  await page.getByRole("button", { name: "복제…" }).click();
  const sheet = page.getByRole("dialog", { name: "저장소 복제" });
  await expect(sheet.getByLabel("계정")).toHaveCount(0);
  await sheet.getByRole("button", { name: "취소" }).click();
  await page.evaluate(() => ((window as any).__gh = { installed: true, accounts: [{ user: "alice", active: true }, { user: "gold", active: false }] }));
  await page.getByRole("button", { name: "복제…" }).click();
  await expect(sheet.getByLabel("계정")).toHaveValue("활성 gh 계정");
  await sheet.getByLabel("URL").fill("https://github.com/me/hello-world.git");
  await sheet.getByRole("button", { name: "선택…" }).click();
  await sheet.getByLabel("계정").selectOption("gold");
  await sheet.getByRole("button", { name: "복제" }).click();
  await expect(tabs(page).getByRole("tab", { name: "hello-world" })).toHaveAttribute("aria-selected", "true");
  const calls = await gitCalls(page);
  expect(JSON.parse(calls.find(([c]) => c === "start_job")![1])).toEqual({ repo: "/demo", args: ["clone", "--progress", "--", "https://github.com/me/hello-world.git", "hello-world"], ghUser: "gold" });
  expect(calls.some(([c, u]) => c === "gh_bind" && u === "gold")).toBe(true);
});

test("새 저장소: git init 후 연다", async ({ page }) => {
  await page.getByRole("button", { name: "새 저장소…" }).click();
  const sheet = page.getByRole("dialog", { name: "새 저장소" });
  await sheet.getByRole("button", { name: "선택…" }).click();
  await sheet.getByLabel("이름").fill("fresh");
  await sheet.getByRole("button", { name: "만들기" }).click();
  expect((await gitCalls(page)).at(-1)).toEqual(["init", "fresh"]);
  await expect(tabs(page).getByRole("tab", { name: "fresh" })).toBeVisible();
});

test("폴더에서 찾은 저장소가 빈 화면·빠른 실행 목록에 추가된다", async ({ page }) => {
  await page.getByRole("button", { name: "폴더에서 찾기…" }).click();
  const list = page.getByRole("list", { name: "저장소 목록" });
  // 지우기(×)는 행에 마우스를 올릴 때만 보인다. 클릭한 자리에 목록이 생기면 호버 여부가 달라지므로 저장소 버튼만 센다
  await expect(list.locator("li > button:not(.forget)")).toHaveCount(3);
  await page.keyboard.press("ControlOrMeta+p");
  const palette = page.getByRole("dialog", { name: "빠른 실행" });
  await palette.getByRole("textbox").fill("열기 design");
  await page.keyboard.press("Enter");
  await expect(tabs(page).getByRole("tab", { name: "design-system" })).toBeVisible();
  // 다시 스캔해도 중복되지 않는다
  await page.locator(".toolbar .picker").first().click();
  await menuItem(page, "폴더에서 저장소 찾기…").click();
  await page.locator(".toolbar .picker").first().click();
  await expect(page.getByRole("menu").getByRole("menuitem", { name: /api-server/ })).toHaveCount(1);
});

test("탭을 빨리 바꾸면 늦게 온 이전 저장소 결과는 버린다", async ({ page }) => {
  await page.getByRole("button", { name: "폴더에서 찾기…" }).click();
  const list = page.getByRole("list", { name: "저장소 목록" });
  await list.getByRole("button", { name: /api-server/ }).click();
  await page.evaluate(() => ((window as any).__slow = ["/demo/design-system"]));
  await page.locator(".toolbar .picker").first().click();
  await menuItem(page, /design-system/).click(); // 느린 저장소 열기 시작
  await tabs(page).getByRole("tab", { name: "api-server" }).click(); // 끝나기 전에 다른 탭으로
  await page.waitForTimeout(700);
  await expect(page.locator(".toolbar .picker").first()).toContainText("api-server");
  await expect(tabs(page).getByRole("tab", { name: "api-server" })).toHaveAttribute("aria-selected", "true");
});

test("탭: 열기·전환·닫기, 새로고침 후 복원", async ({ page }) => {
  await page.getByRole("button", { name: "폴더에서 찾기…" }).click();
  const list = page.getByRole("list", { name: "저장소 목록" });
  await list.getByRole("button", { name: /api-server/ }).click();
  await page.locator(".toolbar .picker").first().click();
  await menuItem(page, /design-system/).click();
  const bar = tabs(page);
  await expect(bar.getByRole("tab")).toHaveCount(2);
  await expect(bar.getByRole("tab", { name: "design-system" })).toHaveAttribute("aria-selected", "true");

  await bar.getByRole("tab", { name: "api-server" }).click();
  await expect(page.locator(".toolbar .picker").first()).toContainText("api-server");

  await page.reload();
  await expect(tabs(page).getByRole("tab")).toHaveCount(2);
  await expect(tabs(page).getByRole("tab", { name: "api-server" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();

  await tabs(page).getByRole("button", { name: "api-server 탭 닫기" }).click();
  await expect(tabs(page).getByRole("tab")).toHaveCount(1);
  await expect(page.locator(".toolbar .picker").first()).toContainText("design-system");
  await tabs(page).getByRole("button", { name: "design-system 탭 닫기" }).click();
  await expect(page.getByText("저장소를 열어 시작하세요")).toBeVisible();
});

test("작업공간: 현재 탭 저장 → 다른 탭으로 바꾼 뒤 전환 → 삭제", async ({ page }) => {
  await page.getByRole("button", { name: "폴더에서 찾기…" }).click();
  const list = page.getByRole("list", { name: "저장소 목록" });
  await list.getByRole("button", { name: /api-server/ }).click();
  await page.locator(".toolbar .picker").first().click();
  await menuItem(page, /design-system/).click();
  await expect(tabs(page).getByRole("tab")).toHaveCount(2);

  await tabs(page).getByRole("button", { name: "작업공간" }).click();
  await menuItem(page, "현재 탭을 작업공간으로 저장…").click();
  const sheet = page.getByRole("dialog", { name: "작업공간 저장" });
  await sheet.getByLabel("이름").fill("백엔드");
  await sheet.getByRole("button", { name: "저장" }).click();

  await tabs(page).getByRole("tab", { name: "api-server" }).hover(); // 닫기 버튼은 활성·호버 탭에만 보인다
  await tabs(page).getByRole("button", { name: "api-server 탭 닫기" }).click();
  await tabs(page).getByRole("button", { name: "design-system 탭 닫기" }).click();
  await openRepo(page);
  await expect(tabs(page).getByRole("tab")).toHaveCount(1);

  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("dialog", { name: "빠른 실행" }).getByRole("textbox").fill("작업공간: 백엔드");
  await page.keyboard.press("Enter");
  await expect(tabs(page).getByRole("tab")).toHaveText(["api-server", "design-system"]);
  await expect(tabs(page).getByRole("tab", { name: "api-server" })).toHaveAttribute("aria-selected", "true");

  await tabs(page).getByRole("button", { name: "작업공간" }).click();
  await menuItem(page, "삭제: 백엔드").click();
  await expect(page.locator(".toast", { hasText: "작업공간 백엔드 삭제됨" }).first()).toBeVisible();
  await tabs(page).getByRole("button", { name: "작업공간" }).click();
  await expect(menuItem(page, "작업공간: 백엔드")).toHaveCount(0);
});

// ---- 탭·작업 경합 ----
const openTwo = async (page: Page) => {
  await page.getByRole("button", { name: "폴더에서 찾기…" }).click();
  await page.getByRole("list", { name: "저장소 목록" }).getByRole("button", { name: /api-server/ }).click();
  await page.locator(".toolbar .picker").first().click();
  await menuItem(page, /design-system/).click();
  await expect(tabs(page).getByRole("tab", { name: "design-system" })).toHaveAttribute("aria-selected", "true");
};
const picker = (page: Page) => page.locator(".toolbar .picker").first();

test("탭 전환 중 들어온 새로고침 이벤트가 전환을 덮지 않는다", async ({ page }) => {
  await openTwo(page);
  await page.evaluate(() => ((window as any).__slow = ["/demo/api-server"]));
  await tabs(page).getByRole("tab", { name: "api-server" }).click();
  await page.evaluate(() => (window as any).__emit("repo-changed", { worktree: true, refs: true }));
  await page.waitForTimeout(700);
  await expect(picker(page)).toContainText("api-server");
});

test("완료 이벤트가 작업 시작 응답보다 먼저 와도 작업 중 상태가 풀린다", async ({ page }) => {
  await openRepo(page);
  await page.evaluate(() => ((window as any).__job = { early: true }));
  const fetch = page.locator(".toolbar").getByRole("button", { name: "Fetch", exact: true });
  await fetch.click();
  await expect(page.locator(".toast", { hasText: "Fetch 완료" }).first()).toBeVisible();
  await expect(fetch).toBeEnabled();
});

test("다른 탭에서 시작한 작업은 그 저장소 이름으로 알리고, 작업 중엔 모든 탭에서 원격 작업이 막힌다", async ({ page }) => {
  await openTwo(page);
  await page.evaluate(() => ((window as any).__job = { ms: 1200, err: "rejected" }));
  const push = page.locator(".toolbar").getByRole("button", { name: "Push", exact: true });
  await push.click();
  await tabs(page).getByRole("tab", { name: "api-server" }).click();
  await expect(picker(page)).toContainText("api-server");
  await expect(push).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("design-system: Push 실패");
  await expect(page.getByRole("alert")).toContainText("rejected");
  await expect(picker(page)).toContainText("api-server");
  await expect(push).toBeEnabled();
});

test("작업 실패가 오류 코드 JSON이면(취소 등) 번역해 토스트에 보인다", async ({ page }) => {
  await openRepo(page);
  await page.evaluate(() => ((window as any).__job = { errCode: { code: "git.cancelled", vars: {}, message: "Cancelled" }, ms: 100 }));
  await page.getByRole("button", { name: "Fetch" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("작업이 취소됨");
  await expect(alert).not.toContainText('"code"');
});

test("복제가 실패하면 탭을 열지 않는다", async ({ page }) => {
  await openRepo(page);
  await page.evaluate(() => ((window as any).__job = { err: "fatal: not found", ms: 100 }));
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("dialog", { name: "빠른 실행" }).getByRole("textbox").fill("저장소 복제");
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog", { name: "저장소 복제" });
  await sheet.getByLabel("URL").fill("https://x/y/nope.git");
  await sheet.getByRole("button", { name: "선택…" }).click();
  await sheet.getByRole("button", { name: "복제" }).click();
  await expect(page.getByRole("alert")).toContainText("fatal: not found");
  await expect(tabs(page).getByRole("tab")).toHaveCount(1);
});

test("활성 탭을 닫았는데 이웃 저장소를 못 열면 빈 화면이 된다", async ({ page }) => {
  await openTwo(page);
  await page.evaluate(() => ((window as any).__broken = ["/demo/api-server"]));
  await tabs(page).getByRole("button", { name: "design-system 탭 닫기" }).click();
  await expect(page.getByRole("alert")).toContainText("저장소를 열 수 없습니다");
  await expect(page.locator(".commits")).toHaveCount(0);
  await expect(picker(page)).not.toContainText("design-system");
});

test("작업공간 첫 저장소를 못 열면 빈 화면이 된다", async ({ page }) => {
  await openTwo(page);
  await tabs(page).getByRole("button", { name: "작업공간" }).click();
  await menuItem(page, "현재 탭을 작업공간으로 저장…").click();
  await page.getByRole("dialog", { name: "작업공간 저장" }).getByLabel("이름").fill("w");
  await page.getByRole("dialog", { name: "작업공간 저장" }).getByRole("button", { name: "저장" }).click();
  await tabs(page).getByRole("tab", { name: "api-server" }).hover(); // 닫기 버튼은 활성·호버 탭에만 보인다
  await tabs(page).getByRole("button", { name: "api-server 탭 닫기" }).click();
  await tabs(page).getByRole("button", { name: "design-system 탭 닫기" }).click();
  await openRepo(page);
  await page.evaluate(() => ((window as any).__broken = ["/demo/api-server"]));
  await tabs(page).getByRole("button", { name: "작업공간" }).click();
  await menuItem(page, "작업공간: w").click();
  await expect(page.getByRole("alert")).toContainText("저장소를 열 수 없습니다");
  await expect(page.locator(".commits")).toHaveCount(0);
});

test("복제·새 저장소: 필수 값이 비면 제출할 수 없다", async ({ page }) => {
  await page.getByRole("button", { name: "복제…" }).click();
  const clone = page.getByRole("dialog", { name: "저장소 복제" });
  const submit = clone.getByRole("button", { name: "복제" });
  await expect(submit).toBeDisabled();
  await clone.getByLabel("URL").fill("https://x/y/z.git");
  await expect(submit).toBeDisabled(); // 위치 없음
  await clone.getByRole("button", { name: "선택…" }).click();
  await expect(submit).toBeEnabled();
  await clone.getByLabel("이름").fill(" ");
  await expect(submit).toBeDisabled();
  await clone.getByRole("button", { name: "취소" }).click();

  await page.getByRole("button", { name: "새 저장소…" }).click();
  const init = page.getByRole("dialog", { name: "새 저장소" });
  await init.getByRole("button", { name: "선택…" }).click();
  await expect(init.getByRole("button", { name: "만들기" })).toBeDisabled();
});

test("저장소 목록 지우기: 시작 화면 ×·모두 지우기, 툴바 메뉴 '최근 목록 지우기'", async ({ page }) => {
  await page.getByRole("button", { name: "폴더에서 찾기…" }).click();
  const list = page.getByRole("list", { name: "저장소 목록" });
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await list.getByRole("listitem").filter({ hasText: "api-server" }).hover(); // ×는 마우스를 올리면 보인다
  await list.getByRole("button", { name: "목록에서 지우기: /demo/api-server" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(2);
  expect(await page.evaluate(() => localStorage.getItem("known"))).not.toContain("api-server");
  // 툴바 메뉴에서 전부 지우기 (저장소를 연 상태)
  await list.getByRole("button", { name: /design-system/ }).first().click();
  await page.locator(".toolbar .picker").first().click();
  await menuItem(page, "최근 목록 지우기").click();
  await page.locator(".toolbar .picker").first().click();
  await expect(page.getByRole("menu").getByRole("menuitem", { name: /git403|design-system/ })).toHaveCount(0);
  expect(await page.evaluate(() => [localStorage.getItem("recent"), localStorage.getItem("known")])).toEqual(["[]", "[]"]);
});

test("사이드바: 펼친 섹션들이 높이를 똑같이 나누고 안에서 스크롤한다, 접은 섹션은 제목 한 줄 (높이 스플리터 없음)", async ({ page }) => {
  await openRepo(page);
  const open = page.locator(".sidebar > section:has(> .section-title[aria-expanded=true])");
  const hs = await open.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  expect(Math.max(...hs) - Math.min(...hs)).toBeLessThanOrEqual(2);
  const closed = page.locator(".sidebar > section:has(> .section-title[aria-expanded=false])").first();
  expect((await closed.boundingBox())!.height).toBeLessThan(40);
  await expect(page.locator(".sidebar .splitter")).toHaveCount(0);
});

test("커밋 상세: 정보 열엔 제목만, 본문 있는 커밋은 파일 목록 맨 위 '커밋 메시지'를 누르면 넓은 영역에 전체 메시지", async ({ page }) => {
  await openRepo(page);
  await page.locator(".commits").getByText("NUL 구분자").first().click();
  await expect(page.locator(".info-subject")).toHaveText("로그 파서");
  // 본문이 있으면 메시지가 기본으로 열리고, 파일을 누르면 diff
  const item = page.getByRole("option", { name: "커밋 메시지" });
  await expect(item).toHaveAttribute("aria-selected", "true");
  const doc = page.locator(".msg-doc");
  await expect(doc.locator("h3")).toHaveText("로그 파서");
  await expect(doc.locator(".head")).toHaveText("What:");
  await expect(doc.locator(".li")).toHaveCount(8);
  // 트레일러는 표로 (공동 작성자는 사진으로 따로)
  await expect(doc.locator(".msg-trailers dt")).toHaveText(["Resolves", "AI-Use"]);
  await expect(doc.locator(".msg-trailers dd")).toHaveText(["ABC-34", "yes"]);
  await page.locator(".files [role=option]").nth(1).click();
  await expect(page.locator(".msg-view")).toHaveCount(0);
  await expect(page.locator(".diff")).toBeVisible();
  // 본문 없는 커밋엔 항목이 없다
  await page.locator(".commits").getByText("README 정리").click();
  await expect(item).toHaveCount(0);
  await expect(page.locator(".msg-view")).toHaveCount(0);
});

test("사이드바에서 브랜치를 누르면 선택만 하고 그래프는 흐리지 않는다", async ({ page }) => {
  await openRepo(page);
  const branches = page.locator(".sidebar section").first();
  await branches.getByRole("button", { name: "pull-lock", exact: true }).click();
  await expect(page.locator(".commits .row.selected > .subject")).toHaveText("pull 중 UI 멈춤 수정");
  await expect(page.locator(".commits .row.dim")).toHaveCount(0);
});

test("그래프에서 브랜치 배지를 누르면 그 계보만 진하고 나머지는 흐리게, 다른 커밋을 고르면 풀린다", async ({ page }) => {
  await openRepo(page);
  await page.locator(".commits .badge", { hasText: "hotfix/pull-lock" }).click();
  const rows = page.locator(".commits .row");
  // 로컬 변경사항 행 + hotfix 계보: h2 → h1 → c3 → c2 → c1
  await expect(page.locator(".commits .row:not(.dim) > .subject")).toHaveText(["로컬 변경사항 3", "pull 중 UI 멈춤 수정", "진행률 이벤트 분리", /^로그 파서/, "git 실행기", "Initial commit"]);
  await expect(rows.filter({ hasText: "README 정리" })).toHaveClass(/dim/);
  await page.locator(".commits").getByText("README 정리").click();
  await expect(page.locator(".commits .row.dim")).toHaveCount(0);
});
