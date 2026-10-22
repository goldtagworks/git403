import { expect, test, type Page } from "@playwright/test";
import { build, expand, quoteShell, splitArgs, type CustomCommand } from "../src/shared/lib/custom";

// 로드맵 14단계: 터미널·파일 열기, 외부 diff/merge 도구, 사용자 정의 명령
const gitCalls = (page: Page) => page.evaluate(() => (window as any).__git as string[][]);
const lastCall = async (page: Page) => (await gitCalls(page)).at(-1);
const settingsTab = async (page: Page, tab: string, button?: string) => {
  await page.locator(".toolbar").getByRole("button", { name: "설정", exact: true }).click();
  await menuItem(page, "설정…").click();
  const dlg = page.getByRole("dialog", { name: "설정" });
  await dlg.getByRole("tab", { name: tab, exact: true }).click();
  if (button) await dlg.getByRole("button", { name: button }).click();
};
const menuItem = (page: Page, name: string | RegExp) => page.getByRole("menu").getByRole("menuitem", { name, exact: typeof name === "string" });
const unstaged = (page: Page) => page.getByRole("listbox", { name: "스테이지 안 됨" });
const staged = (page: Page) => page.getByRole("listbox", { name: "스테이지됨", exact: true });
const REVEAL = /(Finder|탐색기|파일 관리자)에서 보기/;
// 셸 인용은 앱이 도는 OS를 따른다 (Windows는 cmd 큰따옴표, 그 밖은 POSIX 작은따옴표)
const quoter = async (page: Page) => {
  const win = await page.evaluate(() => /Windows/i.test(navigator.userAgent));
  return (v: string) => quoteShell(v, win);
};

const seed = (page: Page, cmds: Partial<CustomCommand>[]) =>
  page.evaluate((list) => localStorage.setItem("customCommands", JSON.stringify(list.map((c, i) => ({ id: String(i), confirm: false, ...c })))), cmds);

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
});

// ---- 순수 로직 (치환·인용·인자 나누기) ----
test("변수 치환: git 인자는 나눈 뒤 치환하고, 셸 값은 인용한다", () => {
  expect(splitArgs(`log --format="%h %s" -n 3 ''`)).toEqual(["log", "--format=%h %s", "-n", "3", ""]);
  const vars = { repo: "/r p", sha: "abc", file: `it's "a" $(rm -rf ~); x.txt`, branch: "feat/x" };
  // git: 값에 공백·따옴표가 있어도 인자 하나
  const git = (command: string) => build({ id: "1", name: "n", target: "file", kind: "git", command, confirm: false }, vars, false);
  expect(git("git show ${sha}:${file}").args).toEqual(["show", `abc:${vars.file}`]);
  expect(git("log -- ${file} ${repo}").args).toEqual(["log", "--", vars.file, "/r p"]);
  // 셸(POSIX): 작은따옴표 인용, 내부의 '는 '\'' 로
  expect(quoteShell(vars.file, false)).toBe(`'it'\\''s "a" $(rm -rf ~); x.txt'`);
  expect(build({ id: "1", name: "n", target: "file", kind: "shell", command: "echo ${file} ${branch}", confirm: false }, vars, false).shell).toBe(`echo 'it'\\''s "a" $(rm -rf ~); x.txt' 'feat/x'`);
  // 셸(Windows cmd): 큰따옴표, 위험 문자가 있으면 거부
  expect(quoteShell("a b.txt", true)).toBe('"a b.txt"');
  for (const bad of ['a"b', "a&b", "100%", "a|b", "a^b", "a\nb"]) expect(() => quoteShell(bad, true), bad).toThrow();
  // 없는 변수는 오류
  expect(() => expand("echo ${sha}", { repo: "/r" })).toThrow(/sha/);
});

// ---- 열기 ----
test("파일 우클릭: 파일 관리자에서 보기·기본 앱으로 열기 (변경 화면)", async ({ page }) => {
  await page.getByText("로컬 변경사항").click();
  await unstaged(page).getByText("ui/src/Toolbar.tsx").click({ button: "right" });
  await menuItem(page, REVEAL).click();
  await expect.poll(() => lastCall(page)).toEqual(["open_in", "reveal", "null", "ui/src/Toolbar.tsx"]);
  await unstaged(page).getByText("ui/src/Toolbar.tsx").click({ button: "right" });
  await menuItem(page, "기본 앱으로 열기").click();
  await expect.poll(() => lastCall(page)).toEqual(["open_in", "open", "null", "ui/src/Toolbar.tsx"]);
  // 추적 안 하는 파일에도 열기 항목은 있다 (diff·히스토리는 없다)
  await unstaged(page).getByText("notes.md").click({ button: "right" });
  await expect(menuItem(page, REVEAL)).toBeVisible();
  await expect(menuItem(page, "외부 diff 도구로 열기")).toHaveCount(0);
});

test("커밋 파일 목록 우클릭: 파일 관리자에서 보기·기본 앱으로 열기", async ({ page }) => {
  await page.getByRole("listbox", { name: "변경 파일" }).getByText("lib.rs").click({ button: "right" });
  await menuItem(page, REVEAL).click();
  await expect.poll(() => lastCall(page)).toEqual(["open_in", "reveal", "null", "crates/graph/src/lib.rs"]);
  await page.getByRole("listbox", { name: "변경 파일" }).getByText("lib.rs").click({ button: "right" });
  await menuItem(page, "기본 앱으로 열기").click();
  await expect.poll(() => lastCall(page)).toEqual(["open_in", "open", "null", "crates/graph/src/lib.rs"]);
});

test("터미널 앱 선택은 저장되어 열기에 쓰인다", async ({ page }) => {
  await page.locator(".toolbar").getByRole("button", { name: "열기", exact: true }).click();
  expect((await gitCalls(page)).at(-1)).toEqual(["open_in", "terminal", "null", "null"]); // 기본값: 앱 지정 없음
  await settingsTab(page, "도구", "터미널 앱…");
  const dialog = page.getByRole("dialog", { name: "터미널 앱" });
  const second = await dialog.getByRole("combobox").locator("option").nth(1).textContent();
  await dialog.getByRole("combobox").selectOption({ index: 1 });
  await dialog.getByRole("button", { name: "저장" }).click();
  await page.keyboard.press("Escape"); // 설정 창 닫기
  await page.locator(".toolbar").getByRole("button", { name: "열기", exact: true }).click();
  await expect.poll(() => lastCall(page)).toEqual(["open_in", "terminal", second, "null"]);
});

// ---- 외부 diff / merge 도구 ----
test("외부 diff 도구: 스테이지 안 된 파일은 difftool -y, 스테이지된 파일은 --cached, 도구가 떠 있어도 Pull은 막히지 않는다", async ({ page }) => {
  await page.evaluate(() => ((window as any).__detached = { ms: 1500 }));
  await page.getByText("로컬 변경사항").click();
  await unstaged(page).getByText("ui/src/Toolbar.tsx").click({ button: "right" });
  await menuItem(page, "외부 diff 도구로 열기").click();
  await expect.poll(() => lastCall(page)).toEqual(["run_detached", "difftool", "-y", "--", "ui/src/Toolbar.tsx"]);
  await expect(page.locator(".toast", { hasText: "외부 diff 도구 실행 중" }).first()).toBeVisible();
  await expect(page.locator(".toolbar").getByRole("button", { name: "Pull", exact: true })).toBeEnabled();
  await expect(page.locator(".toast", { hasText: "외부 diff 도구 종료" }).first()).toBeVisible();

  await staged(page).getByText("crates/core/src/status.rs").click({ button: "right" });
  await menuItem(page, "외부 diff 도구로 열기").click();
  await expect.poll(() => lastCall(page)).toEqual(["run_detached", "difftool", "-y", "--cached", "--", "crates/core/src/status.rs"]);
});

test("외부 diff 도구: 커밋 파일은 부모와 비교(c^ c), 루트 커밋은 빈 트리와 비교", async ({ page }) => {
  await page.getByRole("listbox", { name: "변경 파일" }).getByText("lib.rs").click({ button: "right" });
  await menuItem(page, "외부 diff 도구로 열기").click();
  await expect.poll(() => lastCall(page)).toEqual(["run_detached", "difftool", "-y", expect.stringMatching(/^m3\w*\^$/), expect.stringMatching(/^m3/), "--", "crates/graph/src/lib.rs"]);
  await page.locator(".commits").getByText("Initial commit").click();
  await page.getByRole("listbox", { name: "변경 파일" }).getByText("lib.rs").click({ button: "right" });
  await menuItem(page, "외부 diff 도구로 열기").click();
  await expect.poll(() => lastCall(page)).toEqual(["run_detached", "difftool", "-y", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", expect.stringMatching(/^c1/), "--", "crates/graph/src/lib.rs"]);
});

test("외부 도구가 실패하면 오류를 보인다", async ({ page }) => {
  await page.evaluate(() => ((window as any).__detached = { ms: 50, err: "meld: command not found" }));
  await page.getByRole("listbox", { name: "변경 파일" }).getByText("lib.rs").click({ button: "right" });
  await menuItem(page, "외부 diff 도구로 열기").click();
  await expect(page.getByRole("alert")).toContainText("meld: command not found");
});

test("외부 도구 실패가 오류 코드 JSON이면 번역해 보인다(이벤트 경로)", async ({ page }) => {
  await page.evaluate(() => ((window as any).__detached = { ms: 50, errCode: { code: "git.spawn", vars: { error: "boom" }, message: "failed to run git: boom" } }));
  await page.getByRole("listbox", { name: "변경 파일" }).getByText("lib.rs").click({ button: "right" });
  await menuItem(page, "외부 diff 도구로 열기").click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("git 실행 실패: boom");
  await expect(alert).not.toContainText('"code"');
});

test("도구가 설정되지 않았으면 안내와 설정 시트를 띄우고, 저장하면 이어서 연다 (vscode는 cmd 포함)", async ({ page }) => {
  await page.evaluate(() => ((window as any).__tools = {}));
  await page.getByRole("listbox", { name: "변경 파일" }).getByText("lib.rs").click({ button: "right" });
  await menuItem(page, "외부 diff 도구로 열기").click();
  const dialog = page.getByRole("dialog", { name: "외부 diff·merge 도구" });
  await expect(dialog).toContainText("외부 diff 도구가 설정되어 있지 않습니다");
  expect((await gitCalls(page)).some((a) => a[0] === "run_detached")).toBe(false);
  await dialog.getByRole("combobox").selectOption("vscode");
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect.poll(async () => (await gitCalls(page)).filter((a) => a[0] === "config" || a[0] === "run_detached")).toEqual([
    ["config", "--global", "diff.tool", "vscode"],
    ["config", "--global", "difftool.vscode.cmd", 'code --wait --diff "$LOCAL" "$REMOTE"'],
    ["run_detached", "difftool", "-y", expect.stringMatching(/\^$/), expect.any(String), "--", "crates/graph/src/lib.rs"],
  ]);
});

test("도구 설정 시트를 취소하면 아무것도 실행하지 않는다", async ({ page }) => {
  await page.evaluate(() => ((window as any).__tools = {}));
  await page.getByRole("listbox", { name: "변경 파일" }).getByText("lib.rs").click({ button: "right" });
  await menuItem(page, "외부 diff 도구로 열기").click();
  await page.getByRole("dialog", { name: "외부 diff·merge 도구" }).getByRole("button", { name: "취소" }).click();
  expect((await gitCalls(page)).some((a) => a[0] === "run_detached" || a[0] === "config")).toBe(false);
});

test("설정 메뉴의 도구 설정: diff·merge를 함께 저장한다", async ({ page }) => {
  await settingsTab(page, "도구", "외부 diff·merge 도구…");
  const dialog = page.getByRole("dialog", { name: "외부 diff·merge 도구" });
  await expect(dialog.getByRole("combobox")).toHaveCount(2);
  await expect(dialog.getByRole("combobox").first()).toHaveValue("meld"); // 현재 설정값이 미리 선택된다
  await dialog.getByRole("combobox").nth(1).selectOption("kdiff3");
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect.poll(async () => (await gitCalls(page)).filter((a) => a[0] === "config")).toEqual([
    ["config", "--global", "diff.tool", "meld"],
    ["config", "--global", "merge.tool", "kdiff3"],
  ]);
});

test("충돌 파일: 외부 merge 도구로 해결 = mergetool -y", async ({ page }) => {
  await page.evaluate(() => ((window as any).__conflict = true));
  await page.getByText("로컬 변경사항").click();
  await page.keyboard.press("ControlOrMeta+r");
  await unstaged(page).getByText("conflict.txt").click({ button: "right" });
  await menuItem(page, "외부 merge 도구로 해결").click();
  await expect.poll(() => lastCall(page)).toEqual(["run_detached", "mergetool", "-y", "--", "conflict.txt"]);
  await unstaged(page).getByText("conflict.txt").click();
  await page.getByRole("toolbar", { name: "충돌 해결" }).getByRole("button", { name: "외부 merge 도구" }).click();
  await expect.poll(async () => (await gitCalls(page)).filter((a) => a[0] === "run_detached").length).toBe(2);
});

test("삭제·심볼릭 링크 충돌은 외부 merge 도구 메뉴를 숨기거나 안내만 한다", async ({ page }) => {
  await page.evaluate(() => ((window as any).__conflict = "DU"));
  await page.getByText("로컬 변경사항").click();
  await page.keyboard.press("ControlOrMeta+r");
  await unstaged(page).getByText("conflict.txt").click({ button: "right" });
  await expect(menuItem(page, "외부 merge 도구로 해결")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await unstaged(page).getByText("conflict.txt").click();
  const bar = page.getByRole("toolbar", { name: "충돌 해결" });
  await expect(bar).toContainText("한쪽이 삭제한 파일");
  await expect(bar.getByRole("button", { name: "외부 merge 도구" })).toHaveCount(0);

  // 일반 상태 코드여도 index에 심볼릭 링크(120000)가 있으면 실행 전에 안내하고 멈춘다
  await page.evaluate(() => ((window as any).__conflict = true));
  await page.evaluate(() => ((window as any).__lsU = "120000 abc 1\tconflict.txt\n120000 abd 2\tconflict.txt\n120000 abe 3\tconflict.txt\n"));
  await page.keyboard.press("ControlOrMeta+r");
  await unstaged(page).getByText("conflict.txt").click({ button: "right" });
  await menuItem(page, "외부 merge 도구로 해결").click();
  await expect(page.getByRole("alert")).toContainText("심볼릭 링크");
  expect((await gitCalls(page)).some((a) => a[0] === "run_detached")).toBe(false);
});

test("도구를 연달아 열어도 완료 알림은 각각 한 번씩 (리스너는 하나)", async ({ page }) => {
  await page.evaluate(() => ((window as any).__detached = { ms: 100 }));
  for (let i = 0; i < 3; i++) {
    await page.getByRole("listbox", { name: "변경 파일" }).getByText("lib.rs").click({ button: "right" });
    await menuItem(page, "외부 diff 도구로 열기").click();
    await expect(page.locator(".toast", { hasText: "외부 diff 도구 종료" }).first()).toBeVisible();
  }
  expect((await gitCalls(page)).filter((a) => a[0] === "run_detached")).toHaveLength(3);
});

// ---- 사용자 정의 명령 ----
test("커밋 우클릭: git 명령은 start_job에 인자 배열로, 변수 치환", async ({ page }) => {
  await seed(page, [{ name: "통계 보기", target: "commit", kind: "git", command: 'git show --stat --format="%h %s" ${sha}' }]);
  await page.locator(".commits").getByText("Initial commit").click({ button: "right" });
  await menuItem(page, "통계 보기").click();
  await expect.poll(() => lastCall(page)).toEqual(["start_job", JSON.stringify({ repo: "/demo/git403", args: ["show", "--stat", "--format=%h %s", "c1".padEnd(40, "0")] })]);
  await expect(page.getByRole("button", { name: "통계 보기 취소" })).toBeVisible(); // 진행률 job으로 표시
  await expect(page.locator(".toast", { hasText: "통계 보기 완료" }).first()).toBeVisible();
});

test("셸 명령: 값은 셸 인용, 파일·브랜치 대상 메뉴", async ({ page }) => {
  await seed(page, [
    { name: "파일 크기", target: "file", kind: "shell", command: "wc -c ${file} # ${sha}" },
    { name: "브랜치 로그", target: "branch", kind: "shell", command: "git log -1 ${branch} && echo ${repo}" },
  ]);
  const q = await quoter(page);
  await page.getByRole("listbox", { name: "변경 파일" }).getByText("lib.rs").click({ button: "right" });
  await menuItem(page, "파일 크기").click();
  // ${sha}는 커밋 파일 목록에서만 값이 있다
  await expect.poll(() => lastCall(page)).toEqual(["start_shell", `wc -c ${q("crates/graph/src/lib.rs")} # ${q("m3".padEnd(40, "0"))}`]);
  await expect(page.locator(".toast", { hasText: "파일 크기 완료" }).first()).toBeVisible();

  await page.locator(".sidebar").getByRole("button", { name: "pull-lock", exact: true }).click({ button: "right" });
  await menuItem(page, "브랜치 로그").click();
  await expect.poll(() => lastCall(page)).toEqual(["start_shell", `git log -1 ${q("hotfix/pull-lock")} && echo ${q("/demo/git403")}`]);
});

test("파일 대상 명령에서 ${sha}는 변경 화면(작업 디렉터리)에는 없어서 오류", async ({ page }) => {
  await seed(page, [{ name: "해시 보기", target: "file", kind: "shell", command: "echo ${sha}" }]);
  await page.getByText("로컬 변경사항").click();
  await unstaged(page).getByText("ui/src/Toolbar.tsx").click({ button: "right" });
  await menuItem(page, "해시 보기").click();
  await expect(page.getByRole("alert")).toContainText("${sha}");
  expect((await gitCalls(page)).some((a) => a[0] === "start_shell")).toBe(false);
});

test("실행 전 확인: 최종 명령을 보여 주고, 아니오면 실행하지 않는다", async ({ page }) => {
  await seed(page, [{ name: "정리", target: "repo", kind: "shell", command: "echo ${repo}", confirm: true }]);
  await page.evaluate(() => ((window as any).__asked = []));
  const cmd = `echo ${(await quoter(page))("/demo/git403")}`;
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("dialog", { name: "빠른 실행" }).getByRole("textbox").fill("실행: 정리");
  await page.keyboard.press("Enter");
  await expect.poll(() => lastCall(page)).toEqual(["start_shell", cmd]);
  expect(await page.evaluate(() => (window as any).__asked)).toEqual([expect.stringContaining(cmd)]);

  await page.evaluate(() => ((window as any).__askNo = true));
  const before = (await gitCalls(page)).length;
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("dialog", { name: "빠른 실행" }).getByRole("textbox").fill("실행: 정리");
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => (window as any).__asked.length)).toBe(2);
  expect((await gitCalls(page)).length).toBe(before);
});

test("셸 명령 실패는 오류로 보인다", async ({ page }) => {
  await seed(page, [{ name: "실패", target: "repo", kind: "shell", command: "exit 1" }]);
  await page.evaluate(() => ((window as any).__job = { err: "exit 1", ms: 700 }));
  await page.locator(".toolbar").getByRole("button", { name: "열기 옵션" }).click();
  await menuItem(page, "실패").click();
  await expect(page.getByRole("alert")).toContainText("exit 1");
  await expect(page.locator(".toast", { hasText: "실패 실패" }).first()).toBeVisible();
});

test("관리 시트: 추가·편집·삭제", async ({ page }) => {
  const sheet = (title: string) => page.getByRole("dialog", { name: title });
  await settingsTab(page, "도구", "사용자 정의 명령…");
  // 추가
  await sheet("사용자 정의 명령").getByRole("button", { name: "편집" }).click();
  const edit = sheet("새 명령");
  await edit.getByRole("textbox", { name: "이름" }).fill("한 줄 로그");
  await edit.getByRole("combobox").first().selectOption("브랜치");
  await edit.getByRole("textbox", { name: "명령" }).fill("log --oneline -5 ${branch}");
  await edit.getByRole("checkbox", { name: "실행 전에 확인" }).check();
  await edit.getByRole("button", { name: "저장" }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("customCommands")!))).toEqual([
    expect.objectContaining({ name: "한 줄 로그", target: "branch", kind: "git", command: "log --oneline -5 ${branch}", confirm: true }),
  ]);
  // 편집: 목록으로 돌아오고, 같은 항목을 골라 수정
  await sheet("사용자 정의 명령").getByRole("combobox").selectOption("한 줄 로그 (브랜치)");
  await sheet("사용자 정의 명령").getByRole("button", { name: "편집" }).click();
  await sheet("명령 편집").getByRole("textbox", { name: "이름" }).fill("로그 5개");
  await sheet("명령 편집").getByRole("combobox").nth(1).selectOption("셸 명령");
  await sheet("명령 편집").getByRole("button", { name: "저장" }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("customCommands")!))).toEqual([expect.objectContaining({ name: "로그 5개", kind: "shell" })]);
  // 같은 이름·대상 중복은 거부
  await sheet("사용자 정의 명령").getByRole("button", { name: "편집" }).click();
  await sheet("새 명령").getByRole("textbox", { name: "이름" }).fill("로그 5개");
  await sheet("새 명령").getByRole("combobox").first().selectOption("브랜치");
  await sheet("새 명령").getByRole("textbox", { name: "명령" }).fill("echo");
  await sheet("새 명령").getByRole("button", { name: "저장" }).click();
  await expect(page.getByRole("alert")).toContainText("이미 있습니다");
  // 삭제
  await sheet("사용자 정의 명령").getByRole("combobox").selectOption("로그 5개 (브랜치)");
  await sheet("사용자 정의 명령").getByRole("button", { name: "편집" }).click();
  await sheet("명령 편집").getByRole("checkbox", { name: "이 명령 삭제" }).check();
  await sheet("명령 편집").getByRole("button", { name: "저장" }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("customCommands")!))).toEqual([]);
  await sheet("사용자 정의 명령").getByRole("button", { name: "취소" }).click();
  await expect(sheet("사용자 정의 명령")).toHaveCount(0);
});
