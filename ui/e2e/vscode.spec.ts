import { expect, test, type Page } from "@playwright/test";

// 로드맵 20단계: VS Code 웹뷰 모드(bridge.ts). 페이지에 가짜 acquireVsCodeApi를 넣어 확장 쪽 프로토콜을 흉내 낸다.
// invoke는 mock 백엔드(__TAURI_INTERNALS__)로 넘겨 화면을 채우고, initial_repo는 확장처럼 워크스페이스 폴더로 답한다.
type Msg = { type: string; id: number; cmd?: string; kind?: string; url?: string; options?: any };
const posted = (page: Page) => page.evaluate(() => (window as any).__posted as Msg[]);
const cmds = async (page: Page) => (await posted(page)).filter((m) => m.type === "invoke").map((m) => m.cmd);

const start = async (page: Page, flags: Record<string, unknown> = {}, bodyClass = "vscode-dark") => {
  await page.addInitScript(([f, cls]) => {
    Object.assign(window, f);
    const w = window as any;
    w.__posted = [];
    w.__dialogReply = f.__dialogReply ?? null;
    const reply = (m: any) => window.postMessage(m, "*");
    w.acquireVsCodeApi = () => ({
      postMessage(m: any) {
        w.__posted.push(m);
        // 확장이 하는 일: 웹뷰가 준비되면(ready) 시작 때 요청된 선택을 보낸다. selected·openFile은 답이 없다
        if (m.type === "ready") return void (w.__selectOnStart && setTimeout(() => reply({ type: "select", sha: w.__selectOnStart })));
        if (m.type === "selected" || m.type === "openFile" || m.type === "simulated" || m.type === "commitClick" || m.type === "openFull") return;
        if (m.type === "invoke") {
          if (m.cmd === "boom") return void setTimeout(() => reply({ type: "result", id: m.id, err: "kaboom" }));
          if (m.cmd === "initial_repo") return void setTimeout(() => reply({ type: "result", id: m.id, ok: w.__noRepo ? null : "/work/demo" }));
          Promise.resolve(w.__TAURI_INTERNALS__.invoke(m.cmd, m.args)).then(
            (ok: unknown) => reply({ type: "result", id: m.id, ok: ok ?? null }),
            (err: unknown) => reply({ type: "result", id: m.id, err: String(err) }),
          );
        } else setTimeout(() => reply({ type: "result", id: m.id, ok: m.type === "dialog" ? w.__dialogReply : null }));
      },
    });
    document.addEventListener("DOMContentLoaded", () => document.body.classList.add(cls as string));
  }, [flags, bodyClass] as const);
  await page.goto("/");
};

test("시작 저장소를 확장에서 받아 그래프를 그린다 (initial_repo → load_graph)", async ({ page }) => {
  await start(page);
  await expect(page.getByText("Initial commit").first()).toBeVisible();
  const c = await cmds(page);
  expect(c.indexOf("initial_repo")).toBeLessThan(c.indexOf("load_graph"));
  const graph = (await posted(page)).find((m) => m.cmd === "load_graph") as any;
  expect(graph.args.repo).toBe("/work/demo");
});

test("확장이 보낸 이벤트(repo-changed)가 화면 갱신을 일으킨다", async ({ page }) => {
  await start(page);
  await expect(page.getByText("Initial commit").first()).toBeVisible();
  const before = (await cmds(page)).filter((c) => c === "load_graph").length;
  await page.evaluate(() => window.postMessage({ type: "event", event: "repo-changed", payload: { worktree: true, refs: true } }, "*"));
  await expect.poll(async () => (await cmds(page)).filter((c) => c === "load_graph").length).toBe(before + 1);
});

test("bridge: 오류 응답은 reject, openUrl·ask는 확장 메시지로", async ({ page }) => {
  await start(page, { __dialogReply: true });
  await expect(page.getByText("Initial commit").first()).toBeVisible();
  const r = await page.evaluate(async () => {
    const b = await import(/* @vite-ignore */ "/src/shared/api/bridge.ts");
    const err = await b.invoke("boom").then(() => "no error", (e: unknown) => String(e));
    await b.openUrl("https://example.com/x");
    const yes = await b.ask("지울까요?", { title: "삭제", kind: "warning" });
    const update = await b.checkUpdate();
    return { err, yes, update };
  });
  expect(r).toEqual({ err: "kaboom", yes: true, update: null });
  const p = await posted(page);
  expect(p.find((m) => m.type === "openUrl")).toMatchObject({ url: "https://example.com/x" });
  expect(p.find((m) => m.type === "dialog" && m.kind === "ask")).toMatchObject({ message: "지울까요?", options: { title: "삭제" } });
});

test("저장소 열기는 확장의 폴더 선택 다이얼로그를 부른다", async ({ page }) => {
  await start(page, { __noRepo: true });
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect.poll(async () => (await posted(page)).find((m) => m.type === "dialog")).toMatchObject({ type: "dialog", kind: "open", options: { directory: true } });
});

test("업데이트 확인·재시작 UI가 없고 확인도 하지 않는다", async ({ page }) => {
  await start(page, { __update: { version: "9.9.9" } });
  await expect(page.getByText("Initial commit").first()).toBeVisible();
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByRole("dialog", { name: "설정" })).toBeVisible();
  await expect(page.getByRole("button", { name: "지금 확인" })).toHaveCount(0);
  await expect(page.getByText("새 버전")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__updateChecks ?? 0)).toBe(0);
});

test("테마는 VS Code body 클래스를 따른다 (라이트/다크/고대비)", async ({ page }) => {
  await start(page, {}, "vscode-light");
  const theme = () => page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  await expect.poll(theme).toBe("light");
  await page.evaluate(() => (document.body.className = "vscode-dark"));
  await expect.poll(theme).toBe("dark");
  await page.evaluate(() => (document.body.className = "vscode-high-contrast"));
  await expect.poll(theme).toBe("dark");
  await page.evaluate(() => (document.body.className = "vscode-high-contrast vscode-high-contrast-light"));
  await expect.poll(theme).toBe("light");
});

test("우클릭 메뉴는 네이티브 대신 DOM 메뉴", async ({ page }) => {
  await start(page);
  await page.getByText("Initial commit").first().click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
});

test("툴바 설정 메뉴 → 설정… 로 설정 창이 열린다 (DOM 메뉴 호스트가 웹뷰에도 마운트)", async ({ page }) => {
  await start(page);
  await expect(page.getByText("Initial commit").first()).toBeVisible();
  await page.getByRole("button", { name: "설정", exact: true }).click();
  await page.getByRole("menuitem", { name: "설정…" }).click();
  await expect(page.getByRole("dialog", { name: "설정" })).toBeVisible();
});

test("앱이 처리한 단축키는 VS Code(window keydown 버블)로 넘어가지 않고, 처리 안 한 키는 넘어간다", async ({ page }) => {
  // VS Code 웹뷰 preload처럼 앱보다 먼저 window에 버블 리스너를 단다
  await page.addInitScript(() => {
    (window as any).__forwarded = [];
    window.addEventListener("keydown", (e) => (window as any).__forwarded.push(`${e.metaKey ? "meta+" : ""}${e.ctrlKey ? "ctrl+" : ""}${e.shiftKey ? "shift+" : ""}${e.key}`));
  });
  await start(page);
  await expect(page.getByText("Initial commit").first()).toBeVisible();
  await page.locator("body").click();
  await page.keyboard.press("Control+p"); // 빠른 실행: 앱이 처리
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+,"); // 설정: 앱이 처리
  await expect(page.getByRole("dialog", { name: "설정" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Shift+x"); // 앱이 안 쓰는 키: VS Code로
  const f = await page.evaluate(() => (window as any).__forwarded as string[]);
  expect(f).toContain("ctrl+shift+x");
  expect(f).not.toContain("ctrl+p");
  expect(f).not.toContain("ctrl+,");
});

test("브랜치 팝업: 목록이 툴바에 잘리지 않고 클릭을 받는다", async ({ page }) => {
  await start(page);
  await expect(page.getByText("Initial commit").first()).toBeVisible();
  await page.locator(".branch-pop-wrap .picker").click();
  const li = page.locator(".branch-pop li[data-i]").first();
  await expect(li).toBeVisible();
  const hit = await li.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + 20, r.y + r.height / 2));
  });
  expect(hit).toBe(true);
});

test("웹뷰 body는 VS Code 기본 좌우 padding 없이 화면을 채운다", async ({ page }) => {
  // VS Code는 head 맨 앞에 기본 스타일(body padding)을 넣는다
  await page.addInitScript(() => {
    const mo = new MutationObserver(() => {
      if (!document.head) return;
      mo.disconnect();
      const st = document.createElement("style");
      st.textContent = "body { padding: 0 20px; }";
      document.head.prepend(st);
    });
    mo.observe(document.documentElement, { childList: true });
  });
  await start(page);
  await expect(page.getByText("Initial commit").first()).toBeVisible();
  const m = await page.evaluate(() => {
    const cs = getComputedStyle(document.body);
    return [cs.paddingLeft, cs.paddingRight, cs.marginLeft, cs.marginRight, document.querySelector("#root")!.getBoundingClientRect().width === innerWidth];
  });
  expect(m).toEqual(["0px", "0px", "0px", "0px", true]);
});

// 로드맵 23단계: 그래프 ↔ 편집기
const sha = (n: number) => String(n).padStart(40, "0");
const sendSelect = (page: Page, s: string) => page.evaluate((x) => window.postMessage({ type: "select", sha: x }, "*"), s);
const ofType = async (page: Page, type: string) => (await posted(page)).filter((m) => m.type === type) as any[];

for (const theme of ["vscode-light", "vscode-dark"]) {
  test(`select 메시지: 읽은 범위 밖 커밋도 limit을 늘려 선택·스크롤한다 (${theme})`, async ({ page }) => {
    await start(page, { __bigGraph: 12000 }, theme);
    await expect(page.locator(".commits .row", { hasText: "커밋 0" }).first()).toBeVisible();
    await sendSelect(page, sha(9000)); // 처음 5000개 밖 → 10000으로 늘려 읽음
    const row = page.locator(".commits .row.selected", { hasText: "커밋 9000" });
    await expect(row).toBeVisible();
    const limits: number[] = await page.evaluate(() => (window as any).__graphCalls);
    expect([limits[0], limits.at(-1), Math.max(...limits)]).toEqual([5000, 10000, 10000]); // 한 번만 두 배로
    expect(await page.locator(".graph-scroll").evaluate((el) => el.scrollTop)).toBeGreaterThan(8000 * 26);
    await expect.poll(async () => (await ofType(page, "selected")).map((m) => m.sha)).toEqual([sha(9000)]);
    await page.screenshot({ path: `e2e/results/screens/vscode-select-${theme}.png` });
  });
}

test("select 메시지: 앞부분 SHA도 받고, 없는 커밋은 토스트", async ({ page }) => {
  await start(page, { __bigGraph: 100 });
  await expect(page.locator(".commits .row", { hasText: "커밋 0" }).first()).toBeVisible();
  await sendSelect(page, "0000000"); // 7자리 앞부분 — 가장 먼저 맞는 커밋
  await expect.poll(async () => (await ofType(page, "selected")).length).toBe(1);
  await sendSelect(page, "f".repeat(40));
  await expect(page.getByText(/커밋 ffffffff.*찾을 수 없습니다/)).toBeVisible();
  expect((await ofType(page, "selected")).length).toBe(1);
});

// 열린 패널을 다른 저장소로: 확장이 패널을 다시 만들지 않고 openRepo를 보내면 UI의 저장소 열기(탭) 경로로 전환한다
test("openRepo 메시지: 기존 탭 경로로 저장소를 바꾸고 뒤따르는 select도 새 저장소에서 적용된다", async ({ page }) => {
  await start(page, { __bigGraph: 100 });
  await expect(page.locator(".commits .row", { hasText: "커밋 0" }).first()).toBeVisible();
  const loads = async () => (await posted(page)).filter((m) => m.cmd === "load_graph").map((m: any) => m.args.repo);
  expect(new Set(await loads())).toEqual(new Set(["/work/demo"]));
  const initials = async () => (await posted(page)).filter((m) => m.cmd === "initial_repo").length;
  const before = await initials();
  await page.evaluate((x) => (window.postMessage({ type: "openRepo", repo: "/work/other" }, "*"), window.postMessage({ type: "select", sha: x }, "*")), sha(5));
  await expect.poll(loads).toContain("/work/other");
  await expect(page.getByRole("tab", { name: /other/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /demo/ })).toBeVisible(); // 이전 저장소 탭은 남는다
  await expect(page.locator(".commits .row.selected", { hasText: "커밋 5" })).toBeVisible();
  expect(await initials()).toBe(before); // 패널(웹뷰)을 새로 열지 않았다
  // openRepo 직후 도착한 select는 loadAll이 동기로 세운 pendingRef 때문에 이전 저장소에 적용되지 않고, 새 저장소를 읽은 뒤에야 선택·보고된다
  const msgs = await posted(page);
  const loadOther = msgs.findIndex((m: any) => m.cmd === "load_graph" && m.args.repo === "/work/other");
  const reported = msgs.findIndex((m: any) => m.type === "selected" && m.sha === sha(5));
  expect(loadOther).toBeGreaterThan(-1);
  expect(reported).toBeGreaterThan(loadOther);
  expect(msgs.filter((m: any) => m.type === "selected" && m.sha === sha(5)).length).toBe(1);
  await expect(page.getByRole("tab", { name: /other/, selected: true })).toBeVisible();
});

test("패널이 준비되기 전에 요청된 선택은 그래프를 읽은 뒤 적용된다", async ({ page }) => {
  await start(page, { __bigGraph: 100, __selectOnStart: sha(77) });
  await expect(page.locator(".commits .row.selected", { hasText: "커밋 77" })).toBeVisible();
  expect((await ofType(page, "ready")).length).toBe(1);
});

test("파일 더블클릭·메뉴는 확장에 openFile을 보낸다", async ({ page }) => {
  await start(page);
  await expect(page.getByText("Initial commit").first()).toBeVisible();
  const file = page.getByRole("option", { name: /lib\.rs/ });
  await file.dblclick();
  await expect.poll(async () => (await ofType(page, "openFile")).length).toBe(1);
  const m = (await ofType(page, "openFile"))[0];
  expect(m).toMatchObject({ repo: "/work/demo", path: "crates/graph/src/lib.rs" });
  expect(m.sha).toHaveLength(40); // 선택한 커밋
  await file.click({ button: "right" });
  await page.getByRole("menuitem", { name: "VS Code 편집기에서 열기" }).click();
  await expect.poll(async () => (await ofType(page, "openFile")).length).toBe(2);
});

// 로드맵 24단계: diff 줄 더블클릭 → 편집기의 그 줄
const DIFF = ["diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -10,4 +20,4 @@", " keep one", "-old line", "+new line", " keep two", ""].join("\n");

test("펼친 줄 더블클릭도 새 줄 번호와 함께 openFile을 보낸다", async ({ page }) => {
  const file = Buffer.from(Array.from({ length: 40 }, (_, i) => `let v${i + 1} = ${i + 1};`).join("\n") + "\n").toString("base64");
  await page.addInitScript((b) => ((window as any).__blobs = new Proxy({}, { get: (_t, k) => (typeof k === "string" && k.endsWith(":src/a.ts") ? b : undefined) })), file);
  await start(page, { __fileDiff: DIFF });
  await expect(page.getByText("Initial commit").first()).toBeVisible();
  await page.getByRole("option", { name: /lib\.rs/ }).click();
  const diff = page.locator(".diff");
  await diff.locator(".xrow").first().getByRole("button", { name: "전부" }).click(); // 첫 hunk 앞 1~19
  await diff.locator(".dl.xl", { hasText: "let v5 =" }).dblclick();
  await expect.poll(async () => (await ofType(page, "openFile")).length).toBe(1);
  expect((await ofType(page, "openFile"))[0]).toMatchObject({ path: "src/a.ts", line: 5 });
});

test("diff 줄 더블클릭은 새 파일 기준 줄 번호와 함께 openFile을 보낸다", async ({ page }) => {
  await start(page, { __fileDiff: DIFF });
  await expect(page.getByText("Initial commit").first()).toBeVisible();
  await page.getByRole("option", { name: /lib\.rs/ }).click();
  const diff = page.locator(".diff");
  await diff.locator(".dl.add", { hasText: "new line" }).dblclick();
  await expect.poll(async () => (await ofType(page, "openFile")).length).toBe(1);
  let m = (await ofType(page, "openFile"))[0];
  expect(m).toMatchObject({ repo: "/work/demo", path: "src/a.ts", line: 21 });
  expect(m.sha).toHaveLength(40);
  await diff.locator(".dl", { hasText: "keep two" }).dblclick(); // 문맥 줄
  await expect.poll(async () => (await ofType(page, "openFile")).length).toBe(2);
  expect((await ofType(page, "openFile"))[1]).toMatchObject({ line: 22 });
  await diff.locator(".dl.del").dblclick(); // 삭제 줄은 이어지는 새 줄(21)
  await expect.poll(async () => (await ofType(page, "openFile")).length).toBe(3);
  m = (await ofType(page, "openFile"))[2];
  expect(m.line).toBe(21);
  // 머리줄(hunk 제목)은 줄이 아니라 무시
  await diff.locator(".hunk-title").dblclick();
  await page.waitForTimeout(200);
  expect((await ofType(page, "openFile")).length).toBe(3);
});

test("변경 화면의 diff 줄 더블클릭은 sha 없이(작업 파일) 줄 번호를 보낸다", async ({ page }) => {
  await start(page, { __fileDiff: DIFF });
  await page.getByText("로컬 변경사항").click();
  await page.getByRole("listbox", { name: "스테이지 안 됨" }).getByRole("option").first().click();
  await page.locator(".diff .dl.add", { hasText: "new line" }).dblclick();
  await expect.poll(async () => (await ofType(page, "openFile")).length).toBeGreaterThan(0);
  const m = (await ofType(page, "openFile")).at(-1);
  expect(m.line).toBe(21);
  expect(m.sha).toBeUndefined();
});

for (const theme of ["vscode-light", "vscode-dark"]) {
  test(`테스트 훅 simulate: 웹뷰가 실제 DOM 이벤트로 평소 경로의 openFile을 보낸다 (${theme})`, async ({ page }) => {
    await start(page, { __fileDiff: DIFF }, theme);
    await expect(page.getByText("Initial commit").first()).toBeVisible();
    const sim = (selector: string, text: string, events: string[]) => page.evaluate((m) => window.postMessage({ type: "simulate", ...m }, "*"), { selector, text, events });
    await sim(".files li[role=option]", "lib.rs", ["mousedown", "dblclick"]);
    await expect.poll(async () => (await ofType(page, "openFile")).length).toBe(1);
    await expect.poll(async () => (await ofType(page, "simulated")).map((x) => x.found)).toEqual([true]);
    await sim(".diff .dl.add", "new line", ["dblclick"]);
    await expect.poll(async () => (await ofType(page, "openFile")).length).toBe(2);
    expect((await ofType(page, "openFile"))[1]).toMatchObject({ path: "src/a.ts", line: 21 });
    await sim(".nothing", "", ["dblclick"]);
    await expect.poll(async () => (await ofType(page, "simulated")).map((x) => x.found)).toEqual([true, true, false]);
    await page.screenshot({ path: `e2e/results/screens/vscode-diff-line-${theme}.png` });
  });
}

// compact 모드(사이드바·아래 패널 뷰): 확장이 html에 넣는 window.__git403 = {compact: true}
const compact = { __git403: { compact: true } };
// 실제 VS Code 뷰처럼: 웹뷰 기본 스타일(body 좌우 padding 20px)이 head 맨 앞에 들어온다
const vscodeBodyStyle = (page: Page) =>
  page.addInitScript(() => {
    const mo = new MutationObserver(() => {
      if (!document.head) return;
      mo.disconnect();
      const st = document.createElement("style");
      st.textContent = "body { padding: 0 20px; }";
      document.head.prepend(st);
    });
    mo.observe(document.documentElement, { childList: true });
  });
const renders = (page: Page) => page.evaluate(() => ({ ...(window as any).__renders }) as Record<string, number>);

for (const theme of ["vscode-light", "vscode-dark"]) {
  test(`compact: 툴바·사이드바·상세 없이 검색칸 + 두 줄 행, 300px 폭에서도 깨지지 않는다 (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 340, height: 700 });
    await vscodeBodyStyle(page);
    await start(page, compact, theme);
    const row = page.locator(".commits .row:not(.local-row)", { hasText: "Initial commit" }).first();
    await expect(row).toBeVisible();
    // 뷰 가장자리까지 꽉 찬다: 좌우·아래 여백 없음, 행마다 레인 색 띠 없음
    const edge = await page.evaluate(() => {
      const r = document.querySelector(".commits")!.getBoundingClientRect();
      const bar = [...document.querySelectorAll<HTMLElement>(".row > .c-main")].some((e) => getComputedStyle(e).boxShadow !== "none");
      return { l: r.left, r: r.right === innerWidth, b: Math.round(document.querySelector(".graph-scroll")!.getBoundingClientRect().bottom), h: innerHeight, bar };
    });
    expect(edge).toEqual({ l: 0, r: true, b: 700, h: 700, bar: false });
    for (const sel of [".toolbar", ".pane.side", ".details", ".status-bar", ".commits-head", ".tabs"]) await expect(page.locator(sel)).toHaveCount(0 + (sel === ".commits-head" ? 1 : 0));
    await expect(page.locator(".commits-head")).toBeHidden();
    // 위: 검색칸 + 전체 화면 버튼 하나뿐
    await expect(page.locator(".search-bar input").first()).toBeVisible();
    await expect(page.locator(".search-bar button:visible")).toHaveCount(1);
    // 행: 1줄 메시지, 2줄 SHA · 상대 시간 · 작성자
    await expect(row.locator(".c-l1 .subject")).toHaveText("Initial commit");
    await expect(row.locator(".c-l2")).toHaveText(/^[0-9a-f]{7} · .+ · .+/);
    const l1 = await row.locator(".c-l1").boundingBox();
    const l2 = await row.locator(".c-l2").boundingBox();
    expect(l2!.y).toBeGreaterThan(l1!.y + l1!.height - 1);
    // 좁은 폭: 가로 넘침 없음, 행이 화면 안
    const over = await page.evaluate(() => [document.documentElement.scrollWidth <= innerWidth, [...document.querySelectorAll(".row")].every((r) => r.getBoundingClientRect().right <= innerWidth + 1)]);
    expect(over).toEqual([true, true]);
    await expect(page.getByRole("button", { name: "전체 화면으로 열기" })).toHaveAttribute("title", "전체 화면으로 열기");
    await page.screenshot({ path: `e2e/results/screens/vscode-compact-${theme}.png` });
  });
}

test("compact: 행 클릭은 확장에 commitClick, 로컬 변경사항은 WORKTREE, 전체 화면 버튼은 openFull", async ({ page }) => {
  await page.setViewportSize({ width: 300, height: 700 });
  await start(page, compact);
  const row = page.locator(".commits .row:not(.local-row)", { hasText: "Initial commit" }).first();
  await row.click();
  await expect.poll(async () => (await ofType(page, "commitClick")).length).toBe(1);
  expect((await ofType(page, "commitClick"))[0]).toMatchObject({ repo: "/work/demo" });
  expect((await ofType(page, "commitClick"))[0].sha).toHaveLength(40);
  await expect(page.locator(".local-row")).toBeVisible();
  await page.locator(".local-row").click();
  await expect.poll(async () => (await ofType(page, "commitClick")).at(-1)?.sha).toBe("WORKTREE");
  // 우클릭은 열지 않고 메뉴만
  const n = (await ofType(page, "commitClick")).length;
  await row.click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  expect((await ofType(page, "commitClick")).length).toBe(n);
  await page.keyboard.press("Escape");
  // 커밋 선택 상태에서 전체 화면으로
  await row.click();
  await page.getByRole("button", { name: "전체 화면으로 열기" }).click();
  await expect.poll(async () => (await ofType(page, "openFull")).length).toBe(1);
  expect((await ofType(page, "openFull"))[0].sha).toHaveLength(40);
});

for (const theme of ["vscode-light", "vscode-dark"]) {
  test(`compact: 마우스 오버 툴팁(작성자·날짜·파일 수·+/-·메시지)이 뜨고, 호버는 그래프·행을 다시 그리지 않는다 (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 300, height: 700 });
    await start(page, compact, theme);
    const row = page.locator(".commits .row:not(.local-row)", { hasText: "Initial commit" }).first();
    await expect(row).toBeVisible();
    await row.hover();
    const tip = page.getByRole("tooltip");
    await expect(tip).toBeVisible();
    await expect(tip).toContainText(/변경 파일 \d+개/);
    await expect(tip.locator(".add")).toHaveText(/^\+\d+$/);
    await expect(tip.locator(".del")).toHaveText(/^−\d+$/);
    await expect(tip).toContainText("Initial commit");
    const box = await tip.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(300);
    await page.screenshot({ path: `e2e/results/screens/vscode-compact-tip-${theme}.png` });
    // 같은 행 안에서 움직여도, 다른 행으로 옮겨 카드가 바뀌어도 CommitGraph·CommitRow는 렌더 0
    const before = await renders(page);
    await row.hover({ position: { x: 60, y: 10 } });
    await page.locator(".commits .row:not(.local-row)").nth(1).hover();
    await expect(tip).toBeVisible();
    await page.mouse.move(150, 690);
    await expect(tip).toBeHidden();
    const after = await renders(page);
    expect({ g: after.CommitGraph, r: after.CommitRow }).toEqual({ g: before.CommitGraph, r: before.CommitRow });
  });
}

// 낮은 아래 패널(150~250px)·넓은 폭, 뷰가 숨겨졌다 다시 보일 때도 최신 커밋부터 높이만큼 채운다
// (예전: `.main > .pane`의 max-height: calc(100% - 140px)가 compact 목록을 120px로 눌러 한 행만 보였다)
const listState = (page: Page) =>
  page.evaluate(() => {
    const sc = document.querySelector<HTMLElement>(".graph-scroll")!;
    const s = sc.getBoundingClientRect();
    const local = document.querySelector(".local-row")!.getBoundingClientRect();
    const rows = [...document.querySelectorAll<HTMLElement>(".graph-scroll .row")].map((r) => ({ r: r.getBoundingClientRect(), t: r.querySelector(".subject")?.textContent ?? "" }));
    const vis = rows.filter((x) => x.r.top >= s.top - 1 && x.r.bottom <= s.bottom + 1);
    const cv = document.querySelector<HTMLCanvasElement>(".graph-canvas")!;
    const g = cv.getContext("2d")!;
    // 보이는 행마다 캔버스에 노드·선이 그려졌는지(알파가 있는 픽셀)
    const dpr = cv.width / cv.getBoundingClientRect().width;
    const drawn = vis.map((x) => {
      const y = Math.round((x.r.top - s.top) * dpr), h = Math.round(x.r.height * dpr);
      return g.getImageData(0, y, cv.width, h).data.some((v, i) => i % 4 === 3 && v > 0);
    });
    return { top: sc.scrollTop, belowLocal: rows[0].r.top >= local.bottom - 1, first: rows[0].t, vis: vis.length, drawn, canvasH: Math.round(cv.getBoundingClientRect().height), scrollH: Math.round(s.height), fits: s.height > 0 };
  });

for (const [w, h] of [[2000, 200], [2000, 150], [340, 250], [340, 200]]) {
  test(`compact: 낮은 뷰(${w}x${h})에서도 최신 커밋부터 높이만큼 채우고, 숨겼다 다시 보여도 같다`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await start(page, compact);
    await expect(page.locator(".graph-scroll .row").first()).toBeVisible();
    const check = async (when: string) => {
      await expect.poll(() => listState(page).then((s) => s.vis), { message: when }).toBeGreaterThanOrEqual(Math.max(1, Math.floor((h - 100) / 44)));
      // 캔버스는 ResizeObserver 뒤 그려지므로 잠시 기다린다
      await expect.poll(() => listState(page).then((x) => x.drawn.every(Boolean) && Math.abs(x.canvasH - x.scrollH) <= 1), { message: when + ": 캔버스" }).toBe(true);
      expect(await listState(page), when).toMatchObject({ top: 0, belowLocal: true, first: "Merge branch 'feature/graph'" });
    };
    await check("처음");
    // 뷰가 숨겨진 사이(display none) 크기가 바뀌고 다시 보인다
    await page.evaluate(() => (document.getElementById("root")!.style.display = "none"));
    await page.setViewportSize({ width: w, height: h + 120 });
    await page.evaluate(() => (document.getElementById("root")!.style.display = ""));
    await page.setViewportSize({ width: w, height: h });
    await check("다시 보임");
    await page.setViewportSize({ width: w, height: h + 300 });
    await expect.poll(() => listState(page).then((s) => s.vis)).toBeGreaterThan(Math.floor((h - 100) / 44));
    await page.setViewportSize({ width: w, height: h });
    await check("크기 변경 뒤");
  });
}

// 커밋 상세 탭(편집기 영역): 확장이 html에 window.__git403 = {detail: true}를 넣고 select 메시지로 커밋을 정한다. 그래프·사이드바·툴바 없이 상세 + diff만
for (const theme of ["vscode-light", "vscode-dark"]) {
  test(`detail 모드: 상세 + 파일 목록 + diff만 보이고, select로 같은 화면의 커밋만 바뀐다 (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 650 });
    await vscodeBodyStyle(page);
    await start(page, { __git403: { detail: true }, __fileDiff: DIFF }, theme);
    await expect(page.locator(".details")).toBeVisible();
    for (const sel of [".toolbar", ".pane.side", ".commits", ".status-bar", ".tabs"]) await expect(page.locator(sel)).toHaveCount(0);
    await expect(page.locator(".details.empty")).toBeVisible(); // select 전에는 아무 커밋도 고르지 않는다(HEAD로 대신하지 않음)
    const initial = "c100000000000000000000000000000000000000";
    await sendSelect(page, initial);
    await expect(page.locator(".info-subject")).toHaveText("Initial commit");
    await expect(page.locator(".info-sha")).toContainText(initial.slice(0, 7));
    await page.getByRole("option", { name: /lib\.rs/ }).click();
    await expect(page.locator(".diff .dl.add", { hasText: "new line" })).toBeVisible();
    await page.screenshot({ path: `e2e/results/screens/vscode-detail-${theme}.png` });
    // 다른 커밋을 보내면 같은 화면(마운트 유지)에서 내용만 바뀐다
    await sendSelect(page, "m300000000000000000000000000000000000000");
    await expect(page.locator(".info-subject")).toContainText("Merge branch");
    expect((await ofType(page, "ready")).length).toBe(1);
  });
}
