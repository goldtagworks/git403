import { expect, test, type Page } from "@playwright/test";

// 앱 메뉴 막대(shared/model/appMenu.ts)와 우클릭 메뉴(커밋·브랜치·태그·스태시·파일)의 항목 순서·동작.
// 실제 앱은 OS 메뉴라 목업에서는 메뉴 막대 구조를 window.__appMenu로 읽고 실행한다 (OS 메뉴 자체는 e2e:native가 확인).
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

type Row = { label: string; accelerator?: string; disabled?: boolean; predefined?: string; sep?: true; items?: Row[] };
const bar = async (page: Page): Promise<Row[]> => {
  await expect.poll(() => page.evaluate(() => (window as any).__appMenuModel?.length ?? 0)).toBeGreaterThan(0);
  return page.evaluate(() => (window as any).__appMenu.model());
};
const labels = (rows: Row[]) => rows.map((r) => (r.sep ? "-" : r.label));
const top = (rows: Row[], name: string) => rows.find((r) => r.label === name)!.items!;
const run = (page: Page, ...path: string[]) => page.evaluate((p) => (window as any).__appMenu.run(...p), path);
const gitCalls = (page: Page) => page.evaluate(() => (window as any).__git as string[][]);
const open = async (page: Page) => {
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
};
/** 열린 우클릭 메뉴를 순서대로: 항목은 글자, 구분선은 "-", 하위 메뉴 제목은 "▸ 제목" */
const menuRows = (page: Page) =>
  page.getByRole("menu").evaluate((m) => [...m.children].map((c) => (c.tagName === "HR" ? "-" : c.classList.contains("menu-group") ? "▸ " + c.textContent : c.textContent!.trim())));

test.describe("macOS 메뉴 막대", () => {
  test.use({ userAgent: MAC });
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("최상위 순서 App → File → Edit → Repository → View → Window → Help, File·Repository 항목 순서", async ({ page }) => {
    const m = await bar(page);
    expect(labels(m)).toEqual(["git403", "파일", "편집", "저장소", "보기", "창", "도움말"]);
    expect(labels(top(m, "git403"))).toEqual(["git403 정보", "-", "설정…", "-", "서비스", "-", "git403 가리기", "나머지 가리기", "모두 보기", "-", "git403 종료"]);
    expect(labels(top(m, "파일"))).toEqual([
      "저장소 열기…", "저장소 복제…", "새 저장소…", "폴더에서 저장소 찾기…", "-", "탭 닫기", "-", "터미널에서 열기", "폴더 열기",
    ]);
    expect(labels(top(m, "편집"))).toEqual(["실행 취소", "다시 실행", "-", "오려두기", "복사", "붙여넣기", "전체 선택"]);
    expect(labels(top(m, "저장소"))).toEqual([
      "Fetch", "Pull", "옵션 선택해서 Pull…", "Push", "옵션 선택해서 Push…", "-",
      "새 브랜치…", "스태시…", "스태시 팝", "스냅샷 저장 (변경 유지)", "-",
      "Pull Request 만들기…", "원격 추가…", "패치 적용…", "저장소 통계…", "-", "서브모듈 추가…", "Worktree 추가…",
    ]);
    expect(labels(top(m, "보기"))).toEqual(["새로고침", "-", "diff 크게 보기 (열기·닫기)", "-", "전체 화면"]);
    expect(labels(top(m, "창"))).toEqual(["최소화", "확대/축소", "-", "다음 탭", "이전 탭"]);
    expect(labels(top(m, "도움말"))).toEqual(["빠른 실행"]);
  });

  test("가속키: 기존 전역 단축키와 같은 키(⌘O·⌘P·⌘R·⌘⇧F/L/P/S/B·⌘W·⌘,·⌘⌥←/→·⌘⇧↩) + 새 키 ⌘N, 서로 겹치지 않는다", async ({ page }) => {
    const m = await bar(page);
    const acc = Object.fromEntries(m.flatMap((r) => (r.items ?? []).filter((i) => i.accelerator).map((i) => [`${r.label}/${i.label}`, i.accelerator!])));
    expect(acc).toEqual({
      "git403/설정…": "CmdOrCtrl+,",
      "파일/저장소 열기…": "CmdOrCtrl+O",
      "파일/저장소 복제…": "CmdOrCtrl+N",
      "파일/탭 닫기": "CmdOrCtrl+W",
      "저장소/Fetch": "CmdOrCtrl+Shift+F",
      "저장소/Pull": "CmdOrCtrl+Shift+L",
      "저장소/Push": "CmdOrCtrl+Shift+P",
      "저장소/새 브랜치…": "CmdOrCtrl+Shift+B",
      "저장소/스태시…": "CmdOrCtrl+Shift+S",
      "보기/새로고침": "CmdOrCtrl+R",
      "보기/diff 크게 보기 (열기·닫기)": "CmdOrCtrl+Shift+Enter",
      "창/다음 탭": "CmdOrCtrl+Alt+Right",
      "창/이전 탭": "CmdOrCtrl+Alt+Left",
      "도움말/빠른 실행": "CmdOrCtrl+P",
    });
    expect(new Set(Object.values(acc)).size).toBe(Object.values(acc).length);
  });

  test("저장소가 없으면 저장소 항목이 비활성, 열면 활성 (열기·복제·새 저장소·찾기는 항상 활성)", async ({ page }) => {
    let m = await bar(page);
    expect(top(m, "저장소").every((i) => i.sep || i.disabled)).toBe(true);
    expect(top(m, "파일").filter((i) => i.disabled).map((i) => i.label)).toEqual(["터미널에서 열기", "폴더 열기"]);
    expect(top(m, "보기").find((i) => i.label === "새로고침")!.disabled).toBe(true);
    for (const l of ["저장소 열기…", "저장소 복제…", "새 저장소…", "폴더에서 저장소 찾기…"]) expect(top(m, "파일").find((i) => i.label === l)!.disabled, l).toBeFalsy();
    await open(page);
    await expect.poll(async () => top(await bar(page), "저장소").some((i) => i.disabled)).toBe(false);
    m = await bar(page);
    expect(top(m, "파일").some((i) => i.disabled)).toBe(false);
    expect(top(m, "창").filter((i) => i.disabled).map((i) => i.label)).toEqual(["다음 탭", "이전 탭"]); // 탭이 하나뿐
  });

  test("메뉴 실행은 툴바·빠른 실행과 같은 경로: Fetch → fetch 작업, 새 브랜치 → 시트, 빠른 실행 → 팔레트, 복제 → 시트", async ({ page }) => {
    await open(page);
    await run(page, "저장소", "Fetch");
    await expect.poll(async () => (await gitCalls(page)).filter((c) => c[0] === "start_job").map((c) => JSON.parse(c[1]).args[0])).toContain("fetch");
    await expect(page.getByText("Fetch 완료")).toBeVisible();
    await run(page, "저장소", "새 브랜치…");
    await expect(page.getByRole("dialog", { name: "새 브랜치" })).toBeVisible();
    await page.keyboard.press("Escape");
    await run(page, "도움말", "빠른 실행");
    await expect(page.getByRole("dialog", { name: "빠른 실행" })).toBeVisible();
    await page.keyboard.press("Escape");
    await run(page, "파일", "저장소 복제…");
    await expect(page.getByRole("dialog", { name: "저장소 복제" })).toBeVisible();
  });

  test("작업 중이면 Fetch·Pull·Push 메뉴는 안내만 하고 실행하지 않는다", async ({ page }) => {
    await open(page);
    await page.evaluate(() => ((window as any).__job = { ms: 5000 }));
    await run(page, "저장소", "Pull");
    await expect(page.getByRole("button", { name: "Pull 취소" })).toBeVisible();
    const n = (await gitCalls(page)).filter((c) => c[0] === "start_job").length;
    await run(page, "저장소", "Fetch");
    await expect(page.getByText("다른 작업이 끝나면 쓸 수 있습니다")).toBeVisible();
    expect((await gitCalls(page)).filter((c) => c[0] === "start_job").length).toBe(n);
  });
});

test.describe("Windows 메뉴 막대", () => {
  test.use({ userAgent: WIN });
  test("App·Edit·Window 메뉴가 없고 설정·종료는 File 끝, 탭 이동·전체 화면은 View, 전역 단축키가 있는 항목엔 가속키가 없다", async ({ page }) => {
    await page.goto("/");
    const m = await bar(page);
    expect(labels(m)).toEqual(["파일", "저장소", "보기", "도움말"]);
    expect(labels(top(m, "파일"))).toEqual([
      "저장소 열기…", "저장소 복제…", "새 저장소…", "폴더에서 저장소 찾기…", "-", "탭 닫기", "-", "터미널에서 열기", "폴더 열기", "-", "설정…", "git403 종료",
    ]);
    expect(labels(top(m, "보기"))).toEqual(["새로고침", "-", "diff 크게 보기 (열기·닫기)", "-", "다음 탭", "이전 탭", "-", "전체 화면"]);
    const acc = m.flatMap((r) => (r.items ?? []).filter((i) => i.accelerator).map((i) => `${r.label}/${i.label}=${i.accelerator}`));
    expect(acc).toEqual(["파일/저장소 복제…=CmdOrCtrl+N"]); // 새 키만. 나머지는 keydown이 처리해 두 번 실행되지 않는다
  });
});

test.describe("우클릭 메뉴 순서", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await open(page);
    await page.evaluate(() => ((window as any).__asked = []));
  });

  test("커밋: 체크아웃 → 이 커밋 기준(브랜치·cherry-pick·머지·rebase·Reset ▸·revert) → 복사·패치·웹 → 태그", async ({ page }) => {
    await page.locator(".commits").getByText("로그 파서").click({ button: "right" });
    const rows = await menuRows(page);
    expect(rows).toEqual([
      "체크아웃: feature/graph", "체크아웃: hotfix/pull-lock", "이 커밋 체크아웃 (detached)", "-",
      "여기서 새 브랜치…", "cherry-pick", "현재 브랜치에 머지…", "현재 브랜치를 여기로 rebase", "여기 다음부터 interactive rebase…",
      "▸ 현재 브랜치를 여기로 reset",
      "현재 브랜치를 여기로 reset…", "-", "Soft: 변경을 스테이지에 유지", "Mixed: 변경을 작업 디렉터리에 유지", "Hard: 모든 변경 버리기",
      "되돌리는 커밋 만들기 (revert)", "-",
      "AI 리뷰…", "읽는 흐름 가이드", "-",
      "SHA 복사", "제목 복사", "웹에서 보기", "패치로 저장…", "여기부터 현재 브랜치 끝까지 패치로 저장…", "-",
      "여기에 태그…",
    ]);
    await page.screenshot({ path: `e2e/results/screens/menu-commit-${test.info().project.name}.png` });
  });

  test("Reset ▸ Soft·Mixed는 선택창 없이 바로, Hard는 확인창 뒤에 실행 (인자: reset --soft|--mixed|--hard <sha>)", async ({ page }) => {
    const pickReset = async (name: string) => {
      await page.locator(".commits").getByText("로그 파서").click({ button: "right" });
      await page.getByRole("menuitem", { name }).click();
    };
    await pickReset("Soft: 변경을 스테이지에 유지");
    await expect.poll(async () => (await gitCalls(page)).at(-1)).toEqual(["reset", "--soft", expect.stringMatching(/^[0-9a-f]{40}$/)]);
    await pickReset("Mixed: 변경을 작업 디렉터리에 유지");
    await expect.poll(async () => (await gitCalls(page)).at(-1)?.[1]).toBe("--mixed");
    expect(await page.evaluate(() => (window as any).__asked.length)).toBe(0); // 선택창·확인창 없음
    await page.evaluate(() => ((window as any).__askNo = true));
    const n = (await gitCalls(page)).length;
    await pickReset("Hard: 모든 변경 버리기");
    await expect.poll(() => page.evaluate(() => (window as any).__asked.length)).toBe(1); // hard는 확인
    await page.waitForTimeout(200);
    expect((await gitCalls(page)).length).toBe(n); // 아니오면 실행 안 함
    await page.evaluate(() => ((window as any).__askNo = false));
    await pickReset("Hard: 모든 변경 버리기");
    await expect.poll(async () => (await gitCalls(page)).at(-1)?.[1]).toBe("--hard");
  });

  test("스태시가 가리키는 커밋 행은 맨 위에 스태시 항목(적용·pop·삭제·이름 변경)이 붙는다", async ({ page }) => {
    await page.locator(".commits").getByText("작업 큐 추가").click({ button: "right" });
    const rows = await menuRows(page);
    expect(rows.slice(0, 5)).toEqual(["적용", "적용하고 삭제 (pop)", "삭제…", "이름 변경…", "-"]);
  });

  test("사이드바 로컬 브랜치: HEAD는 Pull·Push가 맨 위, 다른 브랜치는 없다. 그룹 순서는 동기화 → 체크아웃·합치기 → 이 커밋 기준 → PR → 이름·삭제 → 복사·숨기기", async ({ page }) => {
    await page.locator(".side").getByRole("button", { name: /^main/ }).first().click({ button: "right" });
    expect((await menuRows(page)).slice(0, 8)).toEqual(["Pull", "옵션 선택해서 Pull…", "Push", "옵션 선택해서 Push…", "추적 브랜치 설정…", "-", "체크아웃", "현재 브랜치에 머지…"]);
    await page.keyboard.press("Escape");
    await page.locator(".side").getByRole("button", { name: "graph", exact: true }).first().click({ button: "right" });
    const rows = await menuRows(page);
    expect(rows).not.toContain("Pull");
    const at = (l: string) => rows.indexOf(l);
    expect(at("추적 브랜치 설정…")).toBeLessThan(at("체크아웃"));
    expect(at("현재 브랜치를 이 브랜치 위로 rebase")).toBeLessThan(at("여기서 새 브랜치…"));
    expect(at("cherry-pick")).toBeGreaterThan(at("여기서 새 브랜치…"));
    expect(at("▸ 현재 브랜치를 여기로 reset")).toBeGreaterThan(at("cherry-pick"));
    expect(at("Pull Request 만들기…")).toBeGreaterThan(at("되돌리는 커밋 만들기 (revert)"));
    expect(at("이름 변경…")).toBeGreaterThan(at("Pull Request 만들기…"));
    expect(at("삭제…")).toBe(at("이름 변경…") + 1);
    expect(at("이름 복사")).toBeGreaterThan(at("삭제…"));
    expect(at("그래프에서 숨기기")).toBe(at("이름 복사") + 1);
  });

  test("사이드바 태그: Push → 머지·rebase → 체크아웃 → 이 커밋 기준(브랜치·cherry-pick·Reset ▸·revert) → 삭제 → 이름 복사", async ({ page }) => {
    await page.locator(".side").getByRole("button", { name: /^태그/ }).click(); // 태그 구역은 접혀 있다
    await page.locator(".side").getByRole("button", { name: /v0\.1\.0/ }).first().click({ button: "right" });
    const rows = await menuRows(page);
    expect(rows.slice(0, 12)).toEqual([
      "Push", "-", "현재 브랜치에 머지…", "현재 브랜치를 이 브랜치 위로 rebase", "-", "체크아웃 (detached)", "-",
      "여기서 새 브랜치…", "cherry-pick", "▸ 현재 브랜치를 여기로 reset", "현재 브랜치를 여기로 reset…", "-",
    ]);
    const tail = rows.slice(rows.indexOf("되돌리는 커밋 만들기 (revert)"));
    expect(tail.slice(0, 5)).toEqual(["되돌리는 커밋 만들기 (revert)", "-", "삭제…", "-", "이름 복사"]);
  });

  test("사이드바 스태시·원격 브랜치 순서", async ({ page }) => {
    await page.locator(".side").getByRole("button", { name: /WIP on main/ }).first().click({ button: "right" });
    expect(await menuRows(page)).toEqual(["적용", "적용하고 삭제 (pop)", "삭제…", "이름 변경…", "-", "이름 복사"]);
    await page.keyboard.press("Escape");
    await page.locator(".side").getByRole("button", { name: "main", exact: true }).first().click({ button: "right" });
    const rows = await menuRows(page);
    expect(rows.slice(0, 4)).toEqual(["체크아웃 (추적 브랜치 만들기)", "현재 브랜치에 머지…", "현재 브랜치를 이 브랜치 위로 rebase", "-"]);
    expect(rows.indexOf("원격에서 삭제…")).toBeGreaterThan(rows.indexOf("현재 브랜치에서 이 브랜치로 Pull Request…"));
    expect(rows.indexOf("이름 복사")).toBeGreaterThan(rows.indexOf("원격에서 삭제…"));
  });

  test("커밋 상세 파일: 히스토리·Blame → 외부 도구·열기 → 경로 복사 → 이 버전으로 되돌리기(맨 끝)", async ({ page }) => {
    await page.locator(".commits").getByText("로그 파서").click();
    await page.locator(".details").getByRole("option", { name: /lib\.rs/ }).click({ button: "right" });
    const rows = await menuRows(page);
    const at = (l: string) => rows.indexOf(l);
    expect(at("파일 히스토리")).toBeLessThan(at("Blame"));
    expect(at("Blame")).toBeLessThan(at("외부 diff 도구로 열기"));
    expect(at("경로 복사")).toBeGreaterThan(at("외부 diff 도구로 열기"));
    expect(at("이 버전으로 되돌리기…")).toBe(rows.length - 1);
    expect(rows[at("이 버전으로 되돌리기…") - 1]).toBe("-");
  });

  test("변경 파일: 스테이지·버리기·휴지통·스태시·무시 → 히스토리·Blame → 외부 도구·열기 → 경로 복사 → 파일 패치", async ({ page }) => {
    await page.getByText("로컬 변경사항").click();
    await page.getByRole("listbox", { name: "스테이지 안 됨" }).getByRole("option", { name: /Toolbar/ }).click({ button: "right" });
    const rows = await menuRows(page);
    const at = (l: string) => rows.indexOf(l);
    expect(at("스테이지")).toBeLessThan(at("변경 버리기…"));
    expect(at("휴지통으로 이동…")).toBe(at("변경 버리기…") + 1);
    expect(at("파일 히스토리")).toBeGreaterThan(at("이 파일을 LFS로 추적…"));
    expect(at("경로 복사")).toBeGreaterThan(at("외부 diff 도구로 열기"));
    expect(rows.at(-1)).toMatch(/패치/);
  });
});
