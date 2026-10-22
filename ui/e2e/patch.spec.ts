import { expect, test, type Page } from "@playwright/test";

// 로드맵 13단계: 패치 저장·적용, 스냅샷
// file_blob는 diff를 그린 뒤 idle에 미리 읽는 문맥 펼치기(25f)라 사용자 동작이 아니다
const gitCalls = (page: Page) => page.evaluate(() => ((window as any).__git as string[][]).filter((c) => c[0] !== "file_blob"));
const menuItem = (page: Page, name: string | RegExp) => page.getByRole("menu").getByRole("menuitem", { name, exact: typeof name === "string" });
const DIFF_OPTS = ["--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"];
const unstaged = (page: Page) => page.getByRole("listbox", { name: "스테이지 안 됨" });


test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
});

test("커밋 우클릭: format-patch로 고른 폴더에 저장 (범위 포함)", async ({ page }) => {
  await page.locator(".commits").getByText("Initial commit").click({ button: "right" });
  await menuItem(page, "패치로 저장…").click();
  await expect.poll(async () => (await gitCalls(page)).at(-1)).toEqual(["format-patch", "-o", "/demo", "-1", expect.stringMatching(/^[0-9a-f]+$/)]);
  await expect(page.getByText(/패치 1개 저장됨/)).toBeVisible();

  await page.locator(".commits").getByText("Initial commit").click({ button: "right" });
  await menuItem(page, /여기부터 현재 브랜치 끝까지/).click();
  await expect.poll(async () => (await gitCalls(page)).at(-1)).toEqual(["format-patch", "-o", "/demo", expect.stringMatching(/^[0-9a-f]+\^\.\.HEAD$/)]);
  expect((await gitCalls(page)).some((a) => a[0] === "merge-base" && a[1] === "--is-ancestor" && a[3] === "HEAD")).toBe(true);
});

test("범위 패치: 루트 커밋이면 --root, 현재 브랜치에 없는 커밋이면 안내만", async ({ page }) => {
  await page.evaluate(() => ((window as any).__rootCommit = true));
  await page.locator(".commits").getByText("Initial commit").click({ button: "right" });
  await menuItem(page, /여기부터 현재 브랜치 끝까지/).click();
  await expect.poll(async () => (await gitCalls(page)).at(-1)).toEqual(["format-patch", "-o", "/demo", "--root", "HEAD"]);

  await page.evaluate(() => ((window as any).__notAncestor = true));
  const before = (await gitCalls(page)).length;
  await page.locator(".commits").getByText("Initial commit").click({ button: "right" });
  await menuItem(page, /여기부터 현재 브랜치 끝까지/).click();
  await expect(page.getByText(/현재 브랜치에 포함되어 있지 않아/)).toBeVisible();
  expect((await gitCalls(page)).slice(before).some((a) => a[0] === "format-patch")).toBe(false);
});

test("저장할 변경이 없으면 파일을 만들지 않고 안내한다", async ({ page }) => {
  await page.evaluate(() => ((window as any).__noDiff = true));
  await page.getByText("로컬 변경사항").click();
  await page.getByRole("button", { name: "패치 저장" }).first().click();
  await expect(page.getByText(/저장할 변경이 없습니다/)).toBeVisible();
  expect((await gitCalls(page)).some((a) => a[0] === "diff")).toBe(false);
});

test("커밋 없는 저장소의 전체 패치는 빈 트리 기준", async ({ page }) => {
  await page.evaluate(() => ((window as any).__noHead = true));
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByLabel("빠른 실행 검색").fill("모든 변경");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await gitCalls(page)).at(-1)).toEqual(["diff", "--binary", ...DIFF_OPTS, "--output=/demo/changes.patch", "4b825dc642cb6eb9a060e54bf8d69288fbee4904"]);
});

test("작업 디렉터리 변경: diff --binary --output (스테이지됨·안 됨·선택 파일)", async ({ page }) => {
  await page.getByText("로컬 변경사항").click();
  await page.getByRole("button", { name: "패치 저장" }).first().click();
  await expect.poll(async () => (await gitCalls(page)).at(-1)).toEqual(["diff", "--binary", ...DIFF_OPTS, "--output=/demo/unstaged.patch"]);

  await page.getByRole("button", { name: "패치 저장" }).last().click();
  await expect.poll(async () => (await gitCalls(page)).at(-1)).toEqual(["diff", "--binary", ...DIFF_OPTS, "--output=/demo/staged.patch", "--cached"]);

  await unstaged(page).getByRole("option", { name: /Toolbar.tsx/ }).click({ button: "right" });
  await menuItem(page, "이 파일 패치로 저장…").click();
  await expect.poll(async () => (await gitCalls(page)).at(-1)).toEqual(["diff", "--binary", ...DIFF_OPTS, "--output=/demo/unstaged.patch", "--", "ui/src/Toolbar.tsx"]);
});

test("저장 대화상자를 취소하면 git을 실행하지 않는다", async ({ page }) => {
  await page.evaluate(() => ((window as any).__saveCancel = true));
  const before = (await gitCalls(page)).length;
  await page.getByText("로컬 변경사항").click();
  await page.getByRole("button", { name: "← 그래프" }).click(); // 넓은 변경 화면에서 그래프로
  await page.getByRole("button", { name: "패치 저장" }).first().click();
  await page.locator(".commits").getByText("Initial commit").click({ button: "right" });
  await menuItem(page, "패치로 저장…").click();
  await page.waitForTimeout(300);
  expect((await gitCalls(page)).length).toBe(before);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("패치 적용: apply --check 후 apply (옵션 --index)", async ({ page }) => {
  await page.getByRole("button", { name: "저장소", exact: false }).first().click();
  await menuItem(page, "패치 적용…").click();
  const sheet = page.getByRole("dialog", { name: "패치 적용" });
  await sheet.getByLabel(/--index/).check();
  await sheet.getByRole("button", { name: "적용" }).click();
  await expect.poll(async () => (await gitCalls(page)).slice(-2)).toEqual([
    ["apply", "--check", "--index", "/demo/fix.patch"],
    ["apply", "--index", "/demo/fix.patch"],
  ]);
});

test("패치 적용: 3way 옵션", async ({ page }) => {
  await page.getByRole("button", { name: "저장소", exact: false }).first().click();
  await menuItem(page, "패치 적용…").click();
  const sheet = page.getByRole("dialog", { name: "패치 적용" });
  await sheet.getByLabel(/--3way/).check();
  await sheet.getByRole("button", { name: "적용" }).click();
  await expect.poll(async () => (await gitCalls(page)).at(-1)).toEqual(["apply", "--3way", "/demo/fix.patch"]);
});

test("apply --check가 실패하면 안내를 보이고 apply는 실행하지 않는다", async ({ page }) => {
  await page.evaluate(() => ((window as any).__gitFail = { prefix: "apply --check" }));
  await page.getByRole("button", { name: "저장소", exact: false }).first().click();
  await menuItem(page, "패치 적용…").click();
  await page.getByRole("dialog", { name: "패치 적용" }).getByRole("button", { name: "적용" }).click();
  await expect(page.getByRole("alert")).toContainText("패치를 적용할 수 없습니다");
  await expect(page.getByRole("alert")).toContainText("3-way");
  expect((await gitCalls(page)).some((a) => a[0] === "apply" && a[1] !== "--check")).toBe(false);
});

test("패치 선택을 취소하면 아무것도 하지 않는다", async ({ page }) => {
  await page.evaluate(() => ((window as any).__saveCancel = true));
  const before = (await gitCalls(page)).length;
  await page.getByRole("button", { name: "저장소", exact: false }).first().click();
  await menuItem(page, "패치 적용…").click();
  await page.waitForTimeout(300);
  await expect(page.getByRole("dialog", { name: "패치 적용" })).toHaveCount(0);
  expect((await gitCalls(page)).length).toBe(before);
});

test("메일 형식 패치는 am --3way, 충돌하면 충돌 바에서 계속·중단", async ({ page }) => {
  await page.evaluate(() => {
    (window as any).__patchFile = "/demo/0001-fix.patch";
    (window as any).__gitFail = { prefix: "am --3way", conflict: true, op: "am" };
  });
  await page.getByRole("button", { name: "저장소", exact: false }).first().click();
  await menuItem(page, "패치 적용…").click();
  await expect.poll(async () => (await gitCalls(page)).at(-1)).toEqual(["am", "--3way", "/demo/0001-fix.patch"]);
  await page.evaluate(() => (window as any).__emit("repo-changed", { worktree: true, refs: false }));
  const bar = page.locator(".banner.op");
  await expect(bar).toContainText("am 진행 중");
  await page.evaluate(() => ((window as any).__gitFail = null));
  await bar.getByRole("button", { name: "계속" }).click();
  await expect.poll(async () => (await gitCalls(page)).at(-1)).toEqual(["-c", "core.editor=true", "am", "--continue"]);
  await bar.getByRole("button", { name: "중단" }).click();
  await expect.poll(async () => (await gitCalls(page)).at(-1)).toEqual(["am", "--abort"]);
});

test("스냅샷: stash create → stash store, 변경은 그대로 남는다", async ({ page }) => {
  await page.getByText("로컬 변경사항").click();
  await expect(unstaged(page).getByRole("option")).toHaveCount(2);
  await page.getByRole("button", { name: "스냅샷" }).click();
  await expect.poll(async () => (await gitCalls(page)).slice(-2)).toEqual([
    ["stash", "create"],
    ["stash", "store", "-m", expect.stringMatching(/^Snapshot: \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/), "5nap5h0t"],
  ]);
  // push/drop 같은 작업 디렉터리를 바꾸는 명령은 없다
  expect((await gitCalls(page)).some((a) => a[0] === "stash" && ["push", "pop", "drop"].includes(a[1]))).toBe(false);
  await expect(unstaged(page).getByRole("option")).toHaveCount(2);
});

test("스냅샷: 툴바 스태시 메뉴와 빠른 실행에서도, 변경이 없으면 안내", async ({ page }) => {
  await page.getByRole("button", { name: "스태시 옵션" }).click();
  await menuItem(page, /스냅샷 저장/).click();
  await expect.poll(async () => (await gitCalls(page)).at(-2)).toEqual(["stash", "create"]);

  await page.keyboard.press("ControlOrMeta+p");
  await page.getByLabel("빠른 실행 검색").fill("스냅샷");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await gitCalls(page)).filter((a) => a[1] === "create").length).toBe(2);

  await page.evaluate(() => ((window as any).__clean = true));
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByLabel("빠른 실행 검색").fill("스냅샷");
  await page.keyboard.press("Enter");
  await expect(page.getByText("스냅샷할 변경이 없습니다")).toBeVisible();
});
