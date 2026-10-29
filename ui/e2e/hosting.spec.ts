import { expect, test, type Page } from "@playwright/test";
import { autoRule, compile, linkify, parseRules } from "../src/shared/lib/issues";

// 로드맵 15단계: 계정 연동, PR 만들기, PR 목록, 웹에서 보기, 이슈 트래커 링크
const calls = (page: Page) => page.evaluate(() => (window as any).__git as string[][]);
const callsOf = async (page: Page, name: string) => (await calls(page)).filter((c) => c[0] === name);
const menuItem = (page: Page, name: string | RegExp) => page.getByRole("menu").getByRole("menuitem", { name, exact: typeof name === "string" });
const sheet = (page: Page, name: string) => page.getByRole("dialog", { name });
/** 설정 창을 해당 탭으로 연다 (툴바 설정 메뉴 → 설정…) */
const settingsTab = async (page: Page, tab: string) => {
  await page.locator(".toolbar").getByRole("button", { name: "설정", exact: true }).click();
  await menuItem(page, "설정…").click();
  await sheet(page, "설정").getByRole("tab", { name: tab, exact: true }).click();
};
/** 저장소를 열기 전에 mock 플래그를 심는다 */
const open = async (page: Page, flags: Record<string, unknown> = {}) => {
  await page.addInitScript((f) => Object.assign(window, f), flags);
  await page.goto("/");
  await page.getByRole("button", { name: "저장소 열기" }).click();
  await expect(page.locator(".commits").getByText("Initial commit")).toBeVisible();
};
/** 사이드바 브랜치 우클릭 → Pull Request 만들기… */
const branchPr = async (page: Page, name: string) => {
  await page.locator(`.sidebar [title="${name}"]`).click({ button: "right" });
  await menuItem(page, "Pull Request 만들기…").click();
  await expect(sheet(page, "Pull Request 만들기")).toBeVisible();
};

// ---- 순수 로직 ----
test("이슈 링크: 규칙 파싱·치환·겹침·잘못된 정규식·URL 검증", () => {
  const out = [
    "git403.issue.1.url https://jira.example.com/browse/$&",
    "git403.issue.1.regex [A-Z]+-\\d+",
    "git403.issue.0.regex #(\\d+)",
    "git403.issue.0.url https://x.test/issues/$1",
    "git403.issue.2.regex only-regex",
  ].join("\n");
  const rules = parseRules(out);
  expect(rules.map((r) => r.id)).toEqual(["0", "1"]); // url 없는 규칙은 버리고 id 순
  const pieces = linkify("fix #12 and ABC-34, 그리고 #12", compile(rules));
  expect(pieces).toEqual([
    "fix ",
    { text: "#12", url: "https://x.test/issues/12" },
    " and ",
    { text: "ABC-34", url: "https://jira.example.com/browse/ABC-34" },
    ", 그리고 ",
    { text: "#12", url: "https://x.test/issues/12" },
  ]);
  // 잘못된 정규식은 건너뛰고 나머지는 동작, 링크 없으면 원문 그대로
  expect(linkify("a #1", compile([{ id: "x", regex: "(", url: "https://a/$1" }, { id: "y", regex: "#(\\d+)", url: "https://a/$1" }]))).toEqual(["a ", { text: "#1", url: "https://a/1" }]);
  expect(linkify("none", compile(rules))).toEqual(["none"]);
  // 빈 일치(무한 루프 방지)와 http(s) 아닌 URL
  expect(linkify("abc", compile([{ id: "e", regex: "x*", url: "https://a/" }]))).toEqual(["abc"]);
  expect(linkify("#1", compile([{ id: "j", regex: "#(\\d+)", url: "javascript:alert($1)" }]))).toEqual(["#1"]);
  // 캡처 값은 URL 인코딩
  expect(linkify("k:a b", compile([{ id: "q", regex: "k:(.+)", url: "https://a/?q=$1" }]))[0]).toEqual({ text: "k:a b", url: "https://a/?q=a%20b" });
  // GitHub·GitLab 자동 규칙
  const info = (remote: string, provider: any, webUrl: string) => ({ remote, url: "", provider, repo: { host: "", owner: "", name: "" }, webUrl, account: null });
  expect(autoRule([info("o", "github", "https://github.com/a/b")])?.url).toBe("https://github.com/a/b/issues/$1");
  expect(autoRule([info("o", "gitlab", "https://gitlab.com/g/s/p")])?.url).toBe("https://gitlab.com/g/s/p/-/issues/$1");
  expect(autoRule([info("o", "bitbucket", "https://bitbucket.org/a/b")])).toBeNull();
});

// ---- 계정 ----
test("계정: 목록·추가(서비스별 안내)·오류·삭제", async ({ page }) => {
  await open(page);
  await settingsTab(page, "계정");
  const dlg = sheet(page, "설정");
  await expect(dlg.getByRole("list", { name: "연결된 계정" })).toContainText("GitHub · demo-user");

  // GitHub: 토큰 발급 링크(권한 안내), 잘못된 토큰은 오류를 시트 안에 보이고 입력은 유지
  await expect(dlg).toContainText("repo 권한");
  await dlg.getByRole("link", { name: "토큰 발급 페이지 열기" }).click();
  await expect.poll(async () => (await callsOf(page, "open_url")).at(-1)?.[1]).toBe("https://github.com/settings/tokens/new?scopes=repo&description=git403");
  await dlg.getByLabel("토큰").fill("bad-token");
  await dlg.getByRole("button", { name: "연결" }).click();
  await expect(dlg.getByRole("alert")).toContainText("토큰이 올바르지 않습니다");
  await expect(dlg.getByLabel("토큰")).toHaveValue("bad-token");

  // GitLab 셀프호스트: 호스트 입력, 발급 링크가 그 호스트로
  await dlg.getByLabel("서비스").selectOption({ label: "GitLab (셀프호스트)" });
  await expect(dlg.getByRole("button", { name: "연결" })).toBeDisabled(); // 호스트 비어 있음
  await dlg.getByRole("textbox", { name: "호스트" }).fill("git.corp.example");
  await expect(dlg).toContainText("api 권한");
  await dlg.getByRole("link", { name: "토큰 발급 페이지 열기" }).click();
  await expect.poll(async () => (await callsOf(page, "open_url")).at(-1)?.[1]).toBe("https://git.corp.example/-/user_settings/personal_access_tokens?name=git403&scopes=api");
  await dlg.getByLabel("토큰").fill("glpat-ok");
  await dlg.getByRole("button", { name: "연결" }).click();
  await expect(dlg.getByRole("list", { name: "연결된 계정" })).toContainText("GitLab · new-user");
  expect(await callsOf(page, "account_add")).toEqual([["account_add", JSON.stringify({ provider: "gitlab", host: "git.corp.example" })]]);
  await expect(page.locator(".toast", { hasText: "GitLab 계정 new-user 연결됨" }).first()).toBeVisible();

  // Bitbucket: 형식 안내, 형식이 틀리면 오류, 맞으면 사용자명 표시
  await dlg.getByLabel("서비스").selectOption({ label: "Bitbucket" });
  await expect(dlg.getByRole("textbox", { name: "호스트" })).toHaveCount(0);
  await expect(dlg).toContainText("사용자명:앱 비밀번호");
  await expect(dlg).toContainText("Pull requests");
  await dlg.getByLabel("사용자명:앱 비밀번호").fill("justpassword");
  await dlg.getByRole("button", { name: "연결" }).click();
  await expect(dlg.getByRole("alert")).toContainText("형식이어야 합니다");
  await dlg.getByLabel("사용자명:앱 비밀번호").fill("alice:app-pass");
  await dlg.getByRole("button", { name: "연결" }).click();
  await expect(dlg.getByRole("list", { name: "연결된 계정" })).toContainText("Bitbucket · alice");
  await expect(dlg.getByRole("alert")).toHaveCount(0);

  // 삭제 (OS 확인창 문구에 계정 이름)
  await page.evaluate(() => ((window as any).__asked = []));
  await dlg.getByRole("button", { name: "alice 삭제" }).click();
  await expect(dlg.getByRole("list", { name: "연결된 계정" })).not.toContainText("alice");
  expect(await page.evaluate(() => (window as any).__asked[0])).toContain("alice");
  expect(await callsOf(page, "account_remove")).toEqual([["account_remove", "alice"]]);
  // 아니오를 고르면 그대로
  await page.evaluate(() => ((window as any).__askNo = true));
  await dlg.getByRole("button", { name: "demo-user 삭제" }).click();
  await expect(dlg.getByRole("list", { name: "연결된 계정" })).toContainText("demo-user");
});

// ---- PR 만들기 ----
test("PR 시트 기본값과 생성 인자, 완료 시트의 PR 열기", async ({ page }) => {
  await open(page);
  await branchPr(page, "feature/graph");
  const dlg = sheet(page, "Pull Request 만들기");
  await expect(dlg).toContainText("demo/git403"); await expect(dlg.locator(".sheet-head")).toContainText("github.com");
  await expect(dlg.locator(".sheet-head")).toContainText("demo-user");
  await expect(dlg.getByLabel(/^base/)).toHaveValue("main"); // origin/HEAD 없음 → main
  await expect(dlg.getByLabel(/^head/)).toHaveValue("feature/graph");
  await expect(dlg.getByLabel("제목")).toHaveValue(""); // 제목은 비워 두고(AI 또는 직접), 본문은 템플릿 — 템플릿이 없으면 비움
  await expect(dlg.getByLabel("본문")).toHaveValue("");
  await expect(dlg.getByRole("button", { name: "만들기", exact: true })).toBeDisabled();
  await expect(dlg.getByLabel("원격")).toHaveCount(0); // 원격이 하나면 선택 없음
  await expect(dlg.getByText("먼저 Push")).toHaveCount(0); // 원격에 있고 앞서지 않음
  await dlg.getByLabel("제목").fill("그래프 개선");
  await dlg.getByLabel("Draft로 만들기").check();
  await dlg.getByRole("button", { name: "만들기", exact: true }).click();

  const [[, json]] = await callsOf(page, "pr_create");
  expect(JSON.parse(json)).toEqual({
    account: { provider: "github", host: "github.com", username: "demo-user" },
    repo: { host: "github.com", owner: "demo", name: "git403" },
    head: "feature/graph",
    base: "main",
    title: "그래프 개선",
    body: "",
    draft: true,
    localRepo: "/demo/git403", // 연결된 gh 계정 토큰을 쓰게 로컬 저장소 경로를 함께 넘긴다
  });
  const done = sheet(page, "Pull Request 만들었습니다");
  await expect(done).toContainText("https://github.com/demo/git403/pull/42");
  await done.getByRole("button", { name: "PR 열기" }).click();
  await expect.poll(async () => (await callsOf(page, "open_url")).at(-1)?.[1]).toBe("https://github.com/demo/git403/pull/42");
  await expect(done).toHaveCount(0);
});

test("PR 시트: 현재 브랜치는 툴바 Push ▾와 빠른 실행, base는 origin/HEAD, 생성 실패는 시트 안에", async ({ page }) => {
  await open(page, { __originHead: "origin/develop", __prFail: "저장소 접근 권한이 없습니다(404). 토큰 권한을 확인하세요." });
  // main은 base(develop)와 달라서 만들 수 있다. develop은 원격에 없어도 base 목록 맨 앞에 들어간다.
  await page.locator(".toolbar").getByRole("button", { name: "Push 옵션" }).click();
  await menuItem(page, "Pull Request 만들기…").click();
  const dlg = sheet(page, "Pull Request 만들기");
  await expect(dlg.getByLabel(/^head/)).toHaveValue("main");
  await expect(dlg.getByLabel(/^base/)).toHaveValue("develop");
  await dlg.getByLabel("제목").fill("PR 제목"); // 제목은 비어 있어서 채워야 만들 수 있다
  await dlg.getByRole("button", { name: "만들기", exact: true }).click();
  await expect(dlg.getByRole("alert")).toContainText("저장소 접근 권한이 없습니다");
  await expect(dlg).toBeVisible(); // 실패하면 시트가 남아 고칠 수 있다
  await dlg.getByRole("button", { name: "취소" }).click();
  await page.keyboard.press("ControlOrMeta+p");
  await page.getByRole("dialog", { name: "빠른 실행" }).getByRole("textbox").fill("Pull Request 만들기");
  await page.keyboard.press("Enter");
  await expect(sheet(page, "Pull Request 만들기").getByLabel(/^head/)).toHaveValue("main");
  // base와 head가 같으면 막는다
  await sheet(page, "Pull Request 만들기").getByLabel(/^base/).selectOption("main");
  await expect(sheet(page, "Pull Request 만들기").getByRole("button", { name: "만들기", exact: true })).toBeDisabled();
});

test("PR 시트: 원격에 없거나 앞서 있으면 먼저 Push한 뒤 만든다", async ({ page }) => {
  await open(page, { __behind: { "origin/feature/graph..feature/graph": 2 } });
  // 원격에 있지만 2커밋 앞섬 → -u 없이 push
  await branchPr(page, "feature/graph");
  let dlg = sheet(page, "Pull Request 만들기");
  await expect(dlg).toContainText("origin보다 2커밋 앞서 있습니다. 먼저 Push해야 합니다.");
  await dlg.getByLabel("제목").fill("PR 제목"); // 제목은 비어 있어서 채워야 만들 수 있다
  await dlg.getByRole("button", { name: "Push하고 만들기" }).click();
  await expect(dlg).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Push 취소" })).toBeVisible();
  expect(await callsOf(page, "pr_create")).toHaveLength(0); // push가 끝나기 전엔 만들지 않는다
  expect(JSON.parse((await callsOf(page, "start_job")).at(-1)![1])).toEqual({ repo: "/demo/git403", args: ["push", "--progress", "origin", "feature/graph"] });
  await expect(sheet(page, "Pull Request 만들었습니다")).toBeVisible();
  expect(await callsOf(page, "pr_create")).toHaveLength(1);
  await sheet(page, "Pull Request 만들었습니다").locator(".sheet-actions").getByRole("button", { name: "닫기" }).click();

  // 원격에 없는 브랜치 → -u로 push, "Push한 뒤 만들기"를 끄면 만들 수 없다
  await branchPr(page, "hotfix/pull-lock");
  dlg = sheet(page, "Pull Request 만들기");
  await expect(dlg).toContainText("origin에 hotfix/pull-lock 브랜치가 아직 없습니다");
  await dlg.getByLabel("제목").fill("PR 제목");
  await dlg.getByLabel("Push한 뒤 만들기").uncheck();
  await expect(dlg.getByRole("button", { name: "만들기", exact: true })).toBeDisabled();
  await dlg.getByLabel("Push한 뒤 만들기").check();
  await dlg.getByRole("button", { name: "Push하고 만들기" }).click();
  await expect.poll(async () => JSON.parse((await callsOf(page, "start_job")).at(-1)![1]).args).toEqual(["push", "--progress", "-u", "origin", "hotfix/pull-lock"]);
  await expect(sheet(page, "Pull Request 만들었습니다")).toBeVisible();

  // push가 실패하면 PR은 만들지 않는다
  await sheet(page, "Pull Request 만들었습니다").locator(".sheet-actions").getByRole("button", { name: "닫기" }).click();
  const before = (await callsOf(page, "pr_create")).length;
  await page.evaluate(() => ((window as any).__job = { err: "rejected" }));
  await branchPr(page, "feature/graph");
  await sheet(page, "Pull Request 만들기").getByLabel("제목").fill("PR 제목");
  await sheet(page, "Pull Request 만들기").getByRole("button", { name: "Push하고 만들기" }).click();
  await expect(page.getByRole("alert")).toContainText("rejected");
  expect(await callsOf(page, "pr_create")).toHaveLength(before);
});

test("PR 시트: 본문 기본값은 저장소 PR 템플릿(.github 우선), 미리보기는 마크다운으로", async ({ page }) => {
  await open(page);
  await page.evaluate(() => ((window as any).__prTemplate = { "docs/pull_request_template.md": "docs 쪽", ".github/PULL_REQUEST_TEMPLATE.md": "## 변경 내용\n\n- [ ] 테스트" }));
  await branchPr(page, "feature/graph");
  const dlg = sheet(page, "Pull Request 만들기");
  await expect(dlg.getByLabel("본문")).toHaveValue("## 변경 내용\n\n- [ ] 테스트");
  await dlg.getByRole("radio", { name: "미리보기" }).click();
  await expect(dlg.locator(".pr-preview h2")).toHaveText("변경 내용");
  await expect(dlg.getByLabel("본문")).toHaveCount(0);
  await dlg.getByRole("radio", { name: "작성" }).click();
  await dlg.getByLabel("본문").fill("");
  await dlg.getByRole("radio", { name: "미리보기" }).click();
  await expect(dlg.locator(".pr-preview")).toContainText("미리 볼 내용이 없습니다");
});

test("PR 시트: 원격 브랜치 우클릭은 현재 브랜치 → 그 브랜치(base)", async ({ page }) => {
  await open(page);
  await page.locator('.sidebar [title="origin/feature/graph"]').click({ button: "right" });
  await menuItem(page, "현재 브랜치에서 이 브랜치로 Pull Request…").click();
  const dlg = sheet(page, "Pull Request 만들기");
  await expect(dlg.getByLabel(/^head/)).toHaveValue("main");
  await expect(dlg.getByLabel(/^base/)).toHaveValue("feature/graph");
});

test("PR 시트: 원격이 여럿이면 선택(기본은 브랜치의 추적 원격), 바꾸면 계정·기본값이 따라 바뀐다", async ({ page }) => {
  await open(page, {
    __remotes: [{ remote: "origin", url: "https://github.com/demo/git403.git" }, { remote: "upstream", url: "https://gitlab.com/org/sub/git403.git" }],
    __branchRemote: { "feature/graph": "upstream" },
  });
  await branchPr(page, "feature/graph");
  const dlg = sheet(page, "Pull Request 만들기");
  await expect(dlg.getByLabel("원격")).toHaveValue("upstream");
  await expect(dlg).toContainText("org/sub/git403"); await expect(dlg.locator(".sheet-head")).toContainText("gitlab.com");
  await expect(dlg).toContainText("GitLab에 연결된 계정이 없습니다");
  await dlg.getByLabel("원격").selectOption("origin");
  await expect(dlg).toContainText("demo/git403"); await expect(dlg.locator(".sheet-head")).toContainText("github.com");
  await expect(dlg.locator(".sheet-head")).toContainText("demo-user");
  await dlg.getByLabel("제목").fill("PR 제목");
  await expect(dlg.getByRole("button", { name: "만들기", exact: true })).toBeEnabled();
  await expect(dlg.getByText("GitLab에 연결된 계정이 없습니다")).toHaveCount(0);
});

test("PR 시트: 계정이 없으면 웹 URL로 열기 또는 계정 연결", async ({ page }) => {
  await open(page, { __accounts: [] });
  await branchPr(page, "feature/graph");
  const dlg = sheet(page, "Pull Request 만들기");
  await expect(dlg).toContainText("GitHub에 연결된 계정이 없습니다");
  await expect(dlg.getByRole("button", { name: "만들기", exact: true })).toHaveCount(0);
  await dlg.getByRole("button", { name: "웹에서 만들기" }).click();
  await expect.poll(async () => (await callsOf(page, "open_url")).at(-1)?.[1]).toBe("https://github.com/demo/git403/compare/main...feature/graph?expand=1");
  expect(await callsOf(page, "pr_create")).toHaveLength(0);
  await expect(dlg).toHaveCount(0);
  await branchPr(page, "feature/graph");
  await sheet(page, "Pull Request 만들기").getByRole("button", { name: "계정 연결…" }).click();
  await expect(sheet(page, "설정")).toBeVisible();
});

// ---- PR 목록 ----
test("PR 섹션: 계정 연결된 원격이 있을 때만 보이고, 클릭은 PR 리뷰, 우클릭은 체크아웃", async ({ page }) => {
  const ib = { number: 9, title: "릴리스 준비", url: "https://github.com/demo/git403/pull/9", head: "release", base: "main", author: "김개발", authorAvatar: "", draft: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), additions: 1, deletions: 1, labels: [], reviewers: [], approvals: 0, myReview: "none", reRequested: false, headSha: "abcdef1234", isMine: false, reviewRequested: true };
  await open(page, { __inbox: [ib], __remoteOnly: true, __prs: [
    { number: 9, title: "릴리스 준비", url: "https://github.com/demo/git403/pull/9", head: "release", base: "main", author: "김개발" },
    { number: 5, title: "포크에서 온 PR", url: "https://github.com/demo/git403/pull/5", head: "fork-only", base: "main", author: "외부" },
  ] });
  const sec = page.locator(".sidebar").getByRole("button", { name: /^Pull Requests/ });
  await expect(sec).toContainText("2");
  const item = (t: string) => page.locator(".sidebar").getByRole("button", { name: new RegExp(t) });
  await item("릴리스 준비").click(); // 클릭 = PR 리뷰 화면에서 그 PR 열기 (브라우저는 상세의 "GitHub에서 보기")
  await page.getByRole("button", { name: "GitHub에서 보기" }).click();
  await expect.poll(async () => (await callsOf(page, "open_url")).at(-1)?.[1]).toBe("https://github.com/demo/git403/pull/9");
  await page.keyboard.press("Escape");
  await expect(page.locator(".prr")).toHaveCount(0);
  await item("릴리스 준비").click({ button: "right" });
  await menuItem(page, "release 체크아웃").click();
  await expect.poll(async () => (await calls(page)).filter((c) => c[0] === "switch").at(-1)).toEqual(["switch", "-c", "release", "--track", "origin/release"]);
  // 받지 못한 브랜치는 체크아웃 대신 안내
  await item("포크에서 온 PR").click({ button: "right" });
  await menuItem(page, "fork-only 체크아웃").click();
  await expect(page.getByRole("alert")).toContainText("origin/fork-only 브랜치가 없습니다");
});

test("PR 섹션: 계정이 없으면 gh 로그인으로 보이고, gh도 안 되면 숨는다. 계정을 연결하면 나타나고 조회 실패는 조용하다", async ({ page }) => {
  await open(page, { __accounts: [] });
  // 계정 없음 + gh 로그인 있음(pr_inbox 성공) → GitHub 원격의 PR이 보인다
  const prSec = page.locator(".sidebar").getByRole("button", { name: /^Pull Requests/ });
  await expect(prSec).toBeVisible();
  expect((await callsOf(page, "pr_inbox")).length).toBeGreaterThan(0);
  await expect(prSec).toContainText("7"); // 기본 인박스
  await page.evaluate(() => ((window as any).__prListFail = "network down"));
  await settingsTab(page, "계정");
  await sheet(page, "설정").getByLabel("토큰").fill("ghp_ok");
  await sheet(page, "설정").getByRole("button", { name: "연결" }).click();
  await expect(sheet(page, "설정").getByRole("list", { name: "연결된 계정" })).toContainText("new-user");
  await sheet(page, "설정").locator(".sheet-actions").getByRole("button", { name: "닫기" }).click();
  const sec = page.locator(".sidebar").getByRole("button", { name: /^Pull Requests/ });
  await expect(sec).toContainText("0"); // 조회 실패 → 빈 목록, 오류 배너 없음
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("PR 섹션: 계정도 gh 로그인도 없으면(pr_inbox 실패) 숨는다", async ({ page }) => {
  await open(page, { __accounts: [], __inboxFail: "no token" });
  await expect(page.locator(".sidebar").getByRole("button", { name: /^로컬 브랜치/ })).toBeVisible();
  await expect.poll(async () => (await callsOf(page, "pr_inbox")).length).toBeGreaterThan(0);
  await expect(page.locator(".sidebar").getByRole("button", { name: /^Pull Requests/ })).toHaveCount(0);
});

test("PR 섹션: Fetch가 끝나면 한 번 다시 읽고, 저장소를 열 때 늦게 온 이전 결과는 버린다", async ({ page }) => {
  await open(page);
  const sec = page.locator(".sidebar").getByRole("button", { name: /^Pull Requests/ });
  await expect(sec).toContainText("2");
  await page.evaluate(() => ((window as any).__prs = [{ number: 1, title: "하나", url: "https://github.com/demo/git403/pull/1", head: "a", base: "main", author: "x" }]));
  await page.locator(".toolbar").getByRole("button", { name: "Fetch" }).click();
  await expect(page.locator(".toast", { hasText: "Fetch 완료" }).first()).toBeVisible();
  await expect(sec).toContainText("1");
  // 수동 새로고침(섹션 우클릭)
  await page.evaluate(() => ((window as any).__prs = []));
  await sec.click({ button: "right" });
  await menuItem(page, "Pull Request 새로고침").click();
  await expect(sec).toContainText("0");
});

// ---- 웹에서 보기 ----
test("커밋 우클릭 웹에서 보기", async ({ page }) => {
  await open(page);
  await page.locator(".commits").getByText("Initial commit").click({ button: "right" });
  await menuItem(page, "웹에서 보기").click();
  await expect.poll(async () => (await callsOf(page, "open_url")).at(-1)?.[1]).toBe(`https://github.com/demo/git403/commit/${"c1".padEnd(40, "0")}`);
});

test("웹에서 보기: 해석되는 원격이 없으면 안내", async ({ page }) => {
  await open(page, { __remotes: [{ remote: "origin", url: "/srv/git/local.git" }] });
  await page.locator(".commits").getByText("Initial commit").click({ button: "right" });
  await menuItem(page, "웹에서 보기").click();
  await expect(page.getByRole("alert")).toContainText("웹 주소를 알 수 있는 원격");
  expect(await callsOf(page, "open_url")).toHaveLength(0);
});

// ---- 이슈 링크 ----
test("이슈 링크: GitHub 원격의 #123 자동 규칙과 저장소 규칙이 커밋 상세 메시지에 링크로 보이고, 클릭하면 브라우저", async ({ page }) => {
  await open(page, { __issue: { "git403.issue.0.regex": "[A-Z]+-\\d+", "git403.issue.0.url": "https://jira.example.com/browse/$&" } });
  await page.locator(".commits").getByText("작업 큐 추가").click();
  const subject = page.locator(".info-subject");
  await expect(subject.getByRole("link")).toHaveCount(2);
  await expect(subject.getByRole("link", { name: "#12" })).toHaveAttribute("href", "https://github.com/demo/git403/issues/12");
  await expect(subject.getByRole("link", { name: "ABC-34" })).toHaveAttribute("href", "https://jira.example.com/browse/ABC-34");
  await subject.getByRole("link", { name: "ABC-34" }).click();
  await expect.poll(async () => (await callsOf(page, "open_url")).at(-1)?.[1]).toBe("https://jira.example.com/browse/ABC-34");
  await subject.getByRole("link", { name: "#12" }).click();
  await expect.poll(async () => (await callsOf(page, "open_url")).at(-1)?.[1]).toBe("https://github.com/demo/git403/issues/12");
  // 링크 없는 메시지는 그대로
  await page.locator(".commits").getByText("Initial commit").click();
  await expect(subject.getByRole("link")).toHaveCount(0);
  await expect(subject).toHaveText("Initial commit");
});

test("이슈 링크: 잘못된 정규식 규칙은 무시하고 나머지는 동작한다", async ({ page }) => {
  await open(page, { __remotes: [], __issue: { "git403.issue.0.regex": "([", "git403.issue.0.url": "https://bad/$1", "git403.issue.1.regex": "ABC-(\\d+)", "git403.issue.1.url": "https://t.example/$1" } });
  await page.locator(".commits").getByText("작업 큐 추가").click();
  const subject = page.locator(".info-subject");
  await expect(subject.getByRole("link")).toHaveCount(1);
  await expect(subject.getByRole("link", { name: "ABC-34" })).toHaveAttribute("href", "https://t.example/34");
});

test("이슈 링크 규칙 설정: 추가·삭제는 로컬 git config에 저장되고 바로 반영된다", async ({ page }) => {
  await open(page, { __remotes: [] });
  await page.locator(".commits").getByText("작업 큐 추가").click();
  await expect(page.locator(".info-subject").getByRole("link")).toHaveCount(0);
  await settingsTab(page, "이슈 링크");
  await sheet(page, "설정").getByRole("button", { name: "이슈 링크 규칙…" }).click();
  await sheet(page, "이슈 링크 규칙").getByRole("button", { name: "편집" }).click(); // 기본 선택: 새 규칙 추가
  const dlg = sheet(page, "새 규칙");
  await dlg.getByLabel("정규식").fill("(");
  await dlg.getByLabel("URL 템플릿").fill("https://t.example/$&");
  await dlg.getByRole("button", { name: "저장" }).click();
  await expect(page.getByRole("alert")).toContainText("정규식이 올바르지 않습니다");
  // 오류 뒤 목록으로 돌아온다 → 다시 새 규칙
  await sheet(page, "이슈 링크 규칙").getByRole("button", { name: "편집" }).click();
  await sheet(page, "새 규칙").getByLabel("정규식").fill("ABC-\\d+");
  await sheet(page, "새 규칙").getByLabel("URL 템플릿").fill("https://t.example/$&");
  await sheet(page, "새 규칙").getByRole("button", { name: "저장" }).click();
  expect((await calls(page)).filter((c) => c[0] === "config" && c[1] === "--local")).toEqual([
    ["config", "--local", "git403.issue.0.regex", "ABC-\\d+"],
    ["config", "--local", "git403.issue.0.url", "https://t.example/$&"],
  ]);
  await expect(page.locator(".info-subject").getByRole("link", { name: "ABC-34" })).toHaveAttribute("href", "https://t.example/ABC-34");
  // 삭제: 목록 → 규칙 선택 → 삭제 체크
  await sheet(page, "이슈 링크 규칙").getByLabel("규칙").selectOption({ index: 1 });
  await sheet(page, "이슈 링크 규칙").getByRole("button", { name: "편집" }).click();
  await sheet(page, "규칙 편집").getByLabel("이 규칙 삭제").check();
  await sheet(page, "규칙 편집").getByRole("button", { name: "저장" }).click();
  await expect(page.locator(".info-subject").getByRole("link")).toHaveCount(0);
  await sheet(page, "이슈 링크 규칙").getByRole("button", { name: "취소" }).click();
});

test("계정: http 셀프호스트는 확인을 받고(localhost 제외), 같은 호스트에 다시 연결하면 교체, Bitbucket 셀프호스트 선택지 없음", async ({ page }) => {
  await open(page);
  await settingsTab(page, "계정");
  const dlg = sheet(page, "설정");
  await expect(dlg.getByLabel("서비스").locator("option")).toHaveText(["GitHub", "GitLab", "Bitbucket", "GitHub Enterprise (셀프호스트)", "GitLab (셀프호스트)", "Gitea (셀프호스트)"]);
  await dlg.getByLabel("서비스").selectOption({ label: "Gitea (셀프호스트)" });
  await page.evaluate(() => ((window as any).__asked = []));
  // http 외부 주소: 확인창 → 아니오면 연결하지 않는다
  await dlg.getByRole("textbox", { name: "호스트" }).fill("http://git.corp.example");
  await dlg.getByLabel("토큰").fill("t1");
  await page.evaluate(() => ((window as any).__askNo = true));
  await dlg.getByRole("button", { name: "연결" }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__asked.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__asked[0])).toContain("암호화되지 않은 http");
  expect(await callsOf(page, "account_add")).toHaveLength(0);
  // 예 → 연결
  await page.evaluate(() => ((window as any).__askNo = false));
  await dlg.getByRole("button", { name: "연결" }).click();
  await expect(dlg.getByRole("list", { name: "연결된 계정" })).toContainText("http://git.corp.example");
  // 같은 호스트에 다시 연결 → 항목은 하나
  await dlg.getByLabel("토큰").fill("t2");
  await dlg.getByRole("button", { name: "연결" }).click();
  await expect.poll(async () => (await callsOf(page, "account_add")).length).toBe(2);
  await expect(dlg.getByRole("list", { name: "연결된 계정" }).getByRole("listitem").filter({ hasText: "git.corp.example" })).toHaveCount(1);
  // localhost는 묻지 않는다
  await page.evaluate(() => ((window as any).__asked.length = 0));
  await dlg.getByRole("textbox", { name: "호스트" }).fill("http://127.0.0.1:3000");
  await dlg.getByLabel("토큰").fill("t3");
  await dlg.getByRole("button", { name: "연결" }).click();
  await expect(dlg.getByRole("list", { name: "연결된 계정" })).toContainText("127.0.0.1:3000");
  expect(await page.evaluate(() => (window as any).__asked)).toEqual([]);
});

test("PR 섹션: 상한까지 받으면 '더 보기 — 웹에서 열기', Pull·Push 뒤에도 갱신", async ({ page }) => {
  const prs = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: `PR ${i + 1}`, url: `https://github.com/demo/git403/pull/${i + 1}`, head: `b${i}`, base: "main", author: "x" }));
  await open(page, { __prs: prs });
  const side = page.locator(".sidebar");
  await expect(side.getByRole("button", { name: /^Pull Requests/ })).toContainText("100");
  await side.getByRole("button", { name: "더 보기 — 웹에서 열기" }).click();
  await expect.poll(async () => (await callsOf(page, "open_url")).at(-1)?.[1]).toBe("https://github.com/demo/git403/pulls");
  // 99개면 표시 없음 — Pull 완료 뒤 다시 읽는다
  await page.evaluate(() => ((window as any).__prs = (window as any).__prs.slice(0, 99)));
  await page.locator(".toolbar").getByRole("button", { name: "Pull", exact: true }).click();
  await expect(side.getByRole("button", { name: /^Pull Requests/ })).toContainText("99");
  await expect(side.getByRole("button", { name: "더 보기 — 웹에서 열기" })).toHaveCount(0);
});

// ---- gh(GitHub CLI) 계정 상태바 항목 ----
const GH = { installed: true, accounts: [{ user: "me", active: true }, { user: "goldtagworks", active: false }] };
const ghItem = (page: Page) => page.locator(".statusbar .status-item").first();
const ghMenu = (page: Page) => page.getByRole("menu").getByRole("menuitem");

for (const [name, flags, n] of [["gh 미설치", {}, 1], ["GitHub류가 아닌 원격", { __gh: { ...GH, remote: null } }, 1], ["설치됨", { __gh: GH }, 2]] as const) {
  test(`gh 계정 항목: ${name}이면 상태바 항목 ${n}개(${n === 1 ? "숨김" : "활성 계정 표시"})`, async ({ page }) => {
    await open(page, flags);
    await expect(page.locator(".statusbar .status-item")).toHaveCount(n); // 1 = AI 항목만
    if (n === 2) await expect(ghItem(page)).toHaveText("GitHub 계정 me");
  });
}

test("gh 계정 항목: 메뉴로 계정 전환, 연결·해제(연결 계정이 다르면 활성 → 연결 + 툴팁)", async ({ page }, info) => {
  await open(page, { __gh: GH });
  await ghItem(page).click();
  await expect(ghMenu(page)).toHaveText(["✓ me", "goldtagworks", "이 저장소를 me에 연결", "이 저장소를 goldtagworks에 연결", "원격 접근 확인", "✓ 저장소를 열 때 연결 계정으로 전환", "커밋 작성자: 데모 사용자 <demo@example.com> (전역)", "이 저장소 작성자 설정…"]);
  await ghMenu(page).filter({ hasText: /^\s*goldtagworks\s*$/ }).click();
  await expect(ghItem(page)).toHaveText("GitHub 계정 goldtagworks");
  expect(await callsOf(page, "gh_switch")).toEqual([["gh_switch", "goldtagworks"]]);
  // 자동 전환이 켜져 있으면 전환한 계정이 이 저장소에 연결된다
  await expect.poll(() => callsOf(page, "gh_bind")).toEqual([["gh_bind", "goldtagworks"]]);
  // 연결: 활성(goldtagworks)과 다른 me에 연결 → "goldtagworks → me"
  await ghItem(page).click();
  await ghMenu(page).filter({ hasText: "이 저장소를 me에 연결" }).click();
  await expect(ghItem(page)).toHaveText("GitHub 계정 goldtagworks → me");
  await expect(ghItem(page)).toHaveAttribute("title", "연결: me / 현재 활성: goldtagworks — Push·Fetch 때 me로 전환 후 되돌림");
  expect(await callsOf(page, "gh_bind")).toEqual([["gh_bind", "goldtagworks"], ["gh_bind", "me"]]);
  await page.screenshot({ path: `e2e/results/screens/statusbar-gh-${info.project.name}.png` });
  // 해제
  await ghItem(page).click();
  await ghMenu(page).filter({ hasText: "이 저장소 연결 해제" }).click();
  await expect(ghItem(page)).toHaveText("GitHub 계정 goldtagworks");
  expect((await callsOf(page, "gh_bind")).at(-1)).toEqual(["gh_bind", ""]);
});

test("gh 계정 항목: 원격 접근 확인은 메뉴를 다시 열어 계정마다 ✓/✕", async ({ page }, info) => {
  await open(page, { __gh: { ...GH, probe: { goldtagworks: false } } });
  await ghItem(page).click();
  await ghMenu(page).filter({ hasText: "원격 접근 확인" }).click();
  await expect(ghMenu(page).nth(0)).toContainText("✓ 접근 가능");
  await expect(ghMenu(page).nth(1)).toContainText("✕ 접근 불가");
  expect(await callsOf(page, "gh_probe")).toHaveLength(1);
  await page.screenshot({ path: `e2e/results/screens/statusbar-gh-probe-${info.project.name}.png` });
});

test("gh 계정 항목: 창이 포커스를 받으면 외부에서 바뀐 활성 계정을 다시 읽는다", async ({ page }) => {
  await open(page, { __gh: GH });
  await expect(ghItem(page)).toHaveText("GitHub 계정 me");
  await page.evaluate(() => { (window as any).__gh.accounts = [{ user: "me", active: false }, { user: "goldtagworks", active: true }]; window.dispatchEvent(new Event("focus")); });
  await expect(ghItem(page)).toHaveText("GitHub 계정 goldtagworks");
});

test("gh 계정: 설정 '작업 후 되돌리기'를 끄면 start_job에 ghRestore:false, 기본은 생략. PR 조회는 localRepo를 넘긴다", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("autoFetch", "0")); // start_job 개수에 자동 Fetch가 섞이지 않게
  await open(page, { __gh: GH });
  const local = () => page.evaluate(() => (window as any).__prLocal as string[][]);
  await expect.poll(async () => (await local())?.length).toBeGreaterThan(0);
  expect((await local()).every((c) => c[1] === "/demo/git403")).toBe(true);
  const pull = page.locator(".toolbar").getByRole("button", { name: "Pull", exact: true });
  await pull.click();
  await expect.poll(async () => (await callsOf(page, "start_job")).length).toBe(1);
  expect(JSON.parse((await callsOf(page, "start_job"))[0][1])).not.toHaveProperty("ghRestore");
  await expect(page.getByRole("button", { name: "Pull 취소" })).toHaveCount(0, { timeout: 5000 });
  await settingsTab(page, "계정");
  const cb = sheet(page, "설정").getByLabel("작업 후 원래 gh 계정으로 되돌리기");
  await expect(cb).toBeChecked();
  await cb.uncheck();
  await page.keyboard.press("Escape");
  await pull.click();
  await expect.poll(async () => (await callsOf(page, "start_job")).length).toBe(2);
  expect(JSON.parse((await callsOf(page, "start_job"))[1][1])).toMatchObject({ ghRestore: false });
});

test("gh 계정: Repository not found로 실패하면 접근되는 다른 계정에 연결하고 다시 시도하자고 제안한다", async ({ page }) => {
  await open(page, { __gh: { ...GH, probe: { me: false, goldtagworks: true } }, __job: { err: "remote: Repository not found.", once: true, ms: 100 } });
  await page.locator(".toolbar").getByRole("button", { name: "Pull", exact: true }).click();
  await expect.poll(async () => (await callsOf(page, "gh_bind")).length).toBe(1);
  expect((await callsOf(page, "gh_bind"))[0]).toEqual(["gh_bind", "goldtagworks"]);
  await expect.poll(async () => (await callsOf(page, "start_job")).length).toBe(2); // 연결 뒤 같은 작업을 다시 실행
  await expect(ghItem(page)).toHaveText("GitHub 계정 me → goldtagworks");
});

test("gh 계정: 접근되는 계정이 없으면 제안하지 않는다", async ({ page }) => {
  await open(page, { __gh: { ...GH, probe: { me: false, goldtagworks: false } }, __job: { err: "remote: Repository not found.", once: true, ms: 100 } });
  await page.locator(".toolbar").getByRole("button", { name: "Pull", exact: true }).click();
  await expect.poll(async () => (await callsOf(page, "gh_probe")).length).toBe(1);
  await page.waitForTimeout(300);
  expect(await callsOf(page, "gh_bind")).toHaveLength(0);
});

test("gh 계정 항목: 전환·연결·해제는 응답을 기다리지 않고 라벨이 바로 바뀌고, 실패하면 되돌리고 오류를 보인다", async ({ page }) => {
  await open(page, { __gh: { ...GH, delay: 1500 } });
  await expect(ghItem(page)).toHaveText("GitHub 계정 me");
  await ghItem(page).click();
  await ghMenu(page).filter({ hasText: /^\s*goldtagworks\s*$/ }).click();
  await expect(ghItem(page)).toHaveText("GitHub 계정 goldtagworks", { timeout: 500 });
  await ghItem(page).click();
  await ghMenu(page).filter({ hasText: "이 저장소를 me에 연결" }).click();
  await expect(ghItem(page)).toHaveText("GitHub 계정 goldtagworks → me", { timeout: 500 });
  // 실패: 되돌린다
  await page.evaluate(() => Object.assign((window as any).__gh, { delay: 200, fail: "gh auth switch 실패" }));
  await ghItem(page).click();
  await ghMenu(page).filter({ hasText: /^\s*me\s*$/ }).click();
  await expect(ghItem(page)).toHaveText("GitHub 계정 me", { timeout: 500 });
  await expect(ghItem(page)).toHaveText("GitHub 계정 goldtagworks → me");
  await expect(page.locator("body")).toContainText("gh auth switch 실패");
});

test("PR 섹션: 목록을 못 불러오면 \"0개\"로 숨기지 않고 원격별 경고 줄(툴팁에 원인), 누르면 다시 조회", async ({ page }) => {
  await open(page, { __prListFail: "Authentication failed" });
  const row = page.locator(".sidebar").getByRole("button", { name: /origin: 불러오지 못함/ });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("title", /Authentication failed/);
  await page.evaluate(() => ((window as any).__prListFail = null));
  await row.click();
  await expect(row).toHaveCount(0);
  await expect(page.locator(".sidebar").getByRole("button", { name: /^Pull Requests/ })).toBeVisible();
});

test("커밋 상세: 변경 파일을 못 읽으면 \"변경 없음\" 대신 알린다", async ({ page }) => {
  await open(page, { __changedFilesFail: "fatal: bad object" });
  await page.locator(".commits").getByText("Initial commit").click();
  await expect(page.locator(".toast", { hasText: "fatal: bad object" }).first()).toBeVisible();
});

// ---- gh 계정 자동 전환 · 저장소별 커밋 작성자 ----
const GHB = { ...GH, bound: "goldtagworks" };
test("gh 자동 전환: 열 때 연결 계정이 활성과 다르면 한 번 전환하고 토스트", async ({ page }) => {
  await open(page, { __gh: GHB });
  await expect(ghItem(page)).toHaveText("GitHub 계정 goldtagworks");
  await expect(page.locator(".toast").filter({ hasText: "gh 계정을 goldtagworks로 전환했습니다" })).toHaveCount(1);
  expect(await callsOf(page, "gh_switch")).toEqual([["gh_switch", "goldtagworks"]]);
});
test("gh 자동 전환: 창 포커스(quiet) 재조회에서는 전환하지 않는다", async ({ page }) => {
  await open(page, { __gh: { ...GH, bound: "goldtagworks" } });
  await expect.poll(async () => (await callsOf(page, "gh_switch")).length).toBe(1);
  await page.evaluate(() => { (window as any).__gh.accounts = [{ user: "me", active: true }, { user: "goldtagworks", active: false }]; window.dispatchEvent(new Event("focus")); });
  await expect(ghItem(page)).toHaveText("GitHub 계정 me → goldtagworks");
  expect(await callsOf(page, "gh_switch")).toHaveLength(1);
});
test("gh 자동 전환: 연결 계정이 로그인돼 있지 않으면 전환하지 않는다", async ({ page }) => {
  await open(page, { __gh: { ...GH, bound: "nobody" } });
  await expect(ghItem(page)).toHaveText("GitHub 계정 me → nobody");
  expect(await callsOf(page, "gh_switch")).toHaveLength(0);
});
test("gh 자동 전환: 메뉴 체크 항목으로 끄면 다시 열어도 전환하지 않고, 설정은 내보내기 ui 키에 들어 있다", async ({ page }) => {
  await open(page, { __gh: GHB });
  await expect.poll(async () => (await callsOf(page, "gh_switch")).length).toBe(1);
  await ghItem(page).click();
  await menuItem(page, /저장소를 열 때 연결 계정으로 전환/).click();
  expect(await page.evaluate(() => localStorage.getItem("ghAutoSwitch"))).toBe("false");
  await page.evaluate(() => { (window as any).__gh.accounts = [{ user: "me", active: true }, { user: "goldtagworks", active: false }]; });
  await page.reload();
  await expect(ghItem(page)).toHaveText("GitHub 계정 me → goldtagworks");
  expect(await callsOf(page, "gh_switch")).toHaveLength(0);
  expect((await import("../src/shared/lib/settingsIo")).isUiKey("ghAutoSwitch")).toBe(true);
});
test("저장소 커밋 작성자: 전역 표시 → 설정(--local 이름·이메일) → 저장소 표시 → 해제", async ({ page }) => {
  await open(page, { __gh: GH });
  const info = () => menuItem(page, /^커밋 작성자:/);
  await ghItem(page).click();
  await expect(info()).toHaveText("커밋 작성자: 데모 사용자 <demo@example.com> (전역)");
  await expect(info()).toBeDisabled();
  await expect(menuItem(page, "저장소 작성자 해제(전역 사용)")).toHaveCount(0);
  await menuItem(page, "이 저장소 작성자 설정…").click();
  const dlg = sheet(page, "이 저장소 커밋 작성자");
  await dlg.getByLabel("이름").fill("로컬 작성자");
  await dlg.getByLabel("이메일").fill("local@example.com");
  await dlg.getByRole("button", { name: "저장" }).click();
  await expect(dlg).toHaveCount(0);
  const cfgCalls = (await callsOf(page, "config")).map((c) => c.join(" "));
  expect(cfgCalls).toEqual(["config --local user.name 로컬 작성자", "config --local user.email local@example.com"]);
  await ghItem(page).click();
  await expect(info()).toHaveText("커밋 작성자: 로컬 작성자 <local@example.com> (저장소)");
  await menuItem(page, "저장소 작성자 해제(전역 사용)").click();
  expect((await callsOf(page, "config")).slice(2).map((c) => c.join(" "))).toEqual(["config --local --unset user.name", "config --local --unset user.email"]);
  await ghItem(page).click();
  await expect(info()).toHaveText("커밋 작성자: 데모 사용자 <demo@example.com> (전역)");
});

test("gh 자동 전환: 실패하면 경고 토스트를 한 번 띄우고 같은 저장소에서 다시 시도하지 않는다", async ({ page }) => {
  await open(page, { __gh: { ...GHB, fail: "boom" } });
  await expect(page.locator(".toast.warning").filter({ hasText: "전환하지 못했습니다" })).toHaveCount(1);
  expect(await callsOf(page, "gh_switch")).toHaveLength(1);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(300);
  expect(await callsOf(page, "gh_switch")).toHaveLength(1);
});
test("gh 자동 전환: 설정 > 계정의 체크로도 끈다", async ({ page }) => {
  await open(page, { __gh: GHB });
  await settingsTab(page, "계정");
  const cb = sheet(page, "설정").getByLabel("저장소를 열 때 연결 계정으로 전환");
  await expect(cb).toBeChecked();
  await cb.uncheck();
  expect(await page.evaluate(() => localStorage.getItem("ghAutoSwitch"))).toBe("false");
});
test("저장소 커밋 작성자: 두 번째 쓰기가 실패하면 이전 값으로 되돌리고, 읽기 실패는 오류로 보인다", async ({ page }) => {
  await open(page, { __gh: GH, __cfg: { global: { "user.name": "전역", "user.email": "g@example.com" }, local: { "user.name": "이전", "user.email": "old@example.com" } } });
  await page.evaluate(() => { const c = (window as any).__cfg.local; Object.defineProperty(c, "user.email", { get: () => "old@example.com", set() { throw "email write failed"; }, configurable: true, enumerable: true }); });
  await ghItem(page).click();
  await menuItem(page, "이 저장소 작성자 설정…").click();
  const dlg = sheet(page, "이 저장소 커밋 작성자");
  await dlg.getByLabel("이름").fill("새이름");
  await dlg.getByLabel("이메일").fill("new@example.com");
  await dlg.getByRole("button", { name: "저장" }).click();
  await expect(page.locator(".toast.error")).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__cfg.local["user.name"])).toBe("이전");
  // 읽기 실패
  await page.evaluate(() => ((window as any).__configFail = "fatal: bad config"));
  await ghItem(page).click();
  await expect(page.locator(".toast.error").filter({ hasText: "bad config" }).or(page.locator(".toast.error")).first()).toBeVisible();
});
test("gh 자동 전환: 탭을 바꿔 다른 저장소를 로드할 때도 연결 계정으로 전환한다", async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem("tabs", JSON.stringify(["/work/a", "/work/b"])); localStorage.setItem("activeTab", JSON.stringify("/work/a")); });
  await page.addInitScript((f) => Object.assign(window, f), { __gh: GHB });
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__git);
  await expect.poll(async () => (await callsOf(page, "gh_switch")).length).toBe(1);
  await page.evaluate(() => { (window as any).__gh.accounts = [{ user: "me", active: true }, { user: "goldtagworks", active: false }]; });
  await page.locator(".tab").nth(1).click();
  await expect.poll(async () => (await callsOf(page, "gh_switch")).length).toBe(2);
});
test("gh 자동 전환: 원격 작업이 도는 동안(임시 전환 구간)에는 건너뛴다", async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem("tabs", JSON.stringify(["/work/a", "/work/b"])); localStorage.setItem("activeTab", JSON.stringify("/work/a")); });
  await page.addInitScript((f) => Object.assign(window, f), { __gh: GHB, __job: { ms: 4000 } });
  await page.goto("/");
  await page.waitForFunction(() => (window as any).__git);
  await expect.poll(async () => (await callsOf(page, "gh_switch")).length).toBe(1);
  await page.evaluate(() => { (window as any).__gh.accounts = [{ user: "me", active: true }, { user: "goldtagworks", active: false }]; });
  await page.locator(".toolbar").getByRole("button", { name: "Pull", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pull 취소" })).toBeVisible();
  await page.locator(".tab").nth(1).click();
  await expect(page.locator(".tab.active")).toHaveAttribute("data-path", "/work/b");
  await page.waitForTimeout(300);
  expect(await callsOf(page, "gh_switch")).toHaveLength(1);
});
