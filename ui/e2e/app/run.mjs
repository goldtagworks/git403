// 실제 앱 E2E: 디버그 빌드(target/debug/git403)를 임시 git 저장소로 띄우고,
// 진짜 IPC·진짜 git으로 화면을 조작한 뒤 결과를 git CLI로 확인한다. (src-tauri/src/e2e.rs 다리 사용)
// 실행: pnpm --dir ui e2e:app  (프런트엔드를 넣은 디버그 빌드 후 실행. cargo build만 하면 dev 서버를 찾는다)
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import { join, basename } from "node:path";
import { App, Steps, eq, temp, until } from "./lib.mjs";

const PORT = 47403;
const repo = temp("e2e");
// 사용자 실제 앱 설정 파일과 섞이지 않게 HOME을 임시 폴더로. 웹뷰 localStorage(탭 등)는 HOME과 무관해서 아래에서 백업·복원한다.
const home = temp("home");
const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();

git("init", "-q", "-b", "main");
git("config", "user.name", "E2E");
git("config", "user.email", "e2e@example.com");
git("config", "core.autocrlf", "false"); // Git for Windows 시스템 기본값(true)이면 CRLF 확인·내용 비교가 달라진다
writeFileSync(join(repo, "a.txt"), "1\n");
git("add", ".");
git("commit", "-qm", "첫 커밋");
writeFileSync(join(repo, "a.txt"), "1\n2\n");
git("commit", "-qam", "두 번째 커밋");
git("branch", "feature/x");
git("checkout", "-q", "-b", "side/only");
git("commit", "-q", "--allow-empty", "-m", "숨길 브랜치만의 커밋");
git("checkout", "-q", "main");
writeFileSync(join(repo, "new.txt"), "새 파일\n");

// AI 채팅 시나리오용 가짜 claude(fake-claude.mjs): 앱이 로그인 셸 PATH를 앞에 붙이므로(shellenv) 임시 HOME의 셸 rc에도 PATH를 넣어 진짜 claude보다 먼저 잡히게 한다
const fakeBin = join(home, "fakebin");
const fakeLog = join(home, "fake-claude.json");
if (process.platform !== "win32") {
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dirname, "fake-claude.mjs")}" "$@"\n`);
  chmodSync(join(fakeBin, "claude"), 0o755);
  for (const rc of [".zshenv", ".zprofile", ".zshrc", ".bash_profile", ".profile"]) writeFileSync(join(home, rc), `export PATH="${fakeBin}:$PATH"\n`);
}
const A = App({ port: PORT, home, env: process.platform === "win32" ? {} : { PATH: `${fakeBin}:${process.env.PATH}`, FAKE_CLAUDE_LOG: fakeLog } });
const { js, nat } = A;
const launch = (args) => (A.launch(args), A.proc);
const exited = (p) => new Promise((r) => (p.exitCode !== null ? r() : p.once("exit", r)));
const { step, finish } = Steps();

let app = launch([repo]);
let saved = null;
try {
  saved = await js(`const s = JSON.stringify({ ...localStorage }); localStorage.clear(); localStorage.setItem("language", '"ko"'); localStorage.setItem("detailLayout", '"bottom"'); setTimeout(() => location.reload(), 0); return s;`);
  await new Promise((r) => setTimeout(r, 1000));
  await step("저장소를 열면 툴바에 이름, 그래프에 실제 커밋이 보인다", async () => {
    const name = basename(repo);
    await js(`await waitFor(() => $(".toolbar .picker")?.textContent.includes(${JSON.stringify(name)}), "툴바 저장소 이름");`);
    const subjects = await js(`await waitFor(() => byText(".commits *", "두 번째 커밋"), "커밋 목록"); return $(".commits").textContent;`);
    for (const s of ["첫 커밋", "두 번째 커밋"]) if (!subjects.includes(s)) throw new Error(`그래프에 '${s}' 없음`);
  });

  await step("줄바꿈: 저장소를 열 때는 묻지 않고 → CRLF 파일 커밋 시 확인 → LF로 바꿔 커밋", async () => {
    const dlg = (name) => `$$('[role=dialog]').find((d) => d.getAttribute("aria-label") === ${JSON.stringify(name)})`;
    await new Promise((r) => setTimeout(r, 500));
    await js(`if (${dlg("줄바꿈을 LF로 통일할까요?")}) throw new Error("열 때 줄바꿈 제안 시트가 떴다");`);
    eq(existsSync(join(repo, ".gitattributes")), false, "열기만 해서는 .gitattributes를 만들지 않음");
    writeFileSync(join(repo, "crlf.txt"), "one\r\ntwo\r\n");
    git("add", "crlf.txt");
    await js(`
      await waitFor(() => byText(".commits *", "로컬 변경사항"), "로컬 변경사항 행");
      press(byText(".commits *", "로컬 변경사항"));
      fill(await waitFor(() => $('input[aria-label="커밋 제목"]'), "커밋 제목"), "CRLF 파일");
      press(await waitFor(() => $$("button").find((b) => b.textContent === "커밋" && !b.disabled), "커밋 버튼"));
      const d = await waitFor(() => ${dlg("CRLF 줄바꿈 확인")}, "CRLF 확인 시트");
      if (!d.textContent.includes("1개")) throw new Error("파일 수 문구: " + d.textContent);
      press([...d.querySelectorAll("button")].find((b) => b.textContent === "커밋"));
    `);
    for (let i = 0; i < 100 && git("log", "-1", "--format=%s") !== "CRLF 파일"; i++) await new Promise((r) => setTimeout(r, 100));
    eq(git("log", "-1", "--format=%s"), "CRLF 파일", "커밋됨");
    eq(git("show", "HEAD:crlf.txt"), "one\ntwo", "커밋된 내용은 LF");
    eq(readFileSync(join(repo, "crlf.txt"), "utf8"), "one\ntwo\n", "작업 파일도 LF");
  });

  await step("저장소를 열면 백그라운드로 commit-graph가 생기고 저장소 설정은 그대로다", async () => {
    const info = join(repo, ".git", "objects", "info");
    const has = () => existsSync(join(info, "commit-graph")) || existsSync(join(info, "commit-graphs", "commit-graph-chain"));
    for (let i = 0; i < 50 && !has(); i++) await new Promise((r) => setTimeout(r, 100));
    eq(has(), true, "commit-graph 파일");
    git("commit-graph", "verify");
    let cfg = "";
    try { cfg = git("config", "--local", "--get-regexp", "commitgraph"); } catch {} // 없으면 종료 코드 1
    eq(cfg, "", "저장소 설정에 commit-graph 관련 항목 없음");
  });

  await step("사이드바에 실제 브랜치(main, feature/x)가 보인다", async () => {
    await js(`await waitFor(() => document.querySelector(".sidebar")?.textContent.includes("feature") && document.querySelector('.row-refs .badge[title*="feature/x"]'), "feature/x 브랜치");`);
  });

  await step("사이드바에서 브랜치를 숨기면 실제 git --exclude로 그 커밋이 그래프에서 빠지고, 보이면 돌아온다", async () => {
    const eyeOf = `$$(".sidebar .item").find((e) => e.querySelector(".label")?.textContent === "only" && e.querySelector(".eye")).querySelector(".eye")`;
    await js(`
      await waitFor(() => byText(".commits .subject", "숨길 브랜치만의 커밋"), "숨길 커밋");
      press(${eyeOf});
      await waitFor(() => !byText(".commits .subject", "숨길 브랜치만의 커밋"), "커밋이 그래프에서 빠짐");
      await waitFor(() => byText(".commits .subject", "두 번째 커밋"), "나머지 커밋은 그대로");
      await waitFor(() => $(".sidebar .section-title .count")?.textContent === "2/3", "개수 2/3");
      press(${eyeOf});
      await waitFor(() => byText(".commits .subject", "숨길 브랜치만의 커밋"), "다시 보임");
    `);
  });

  await step("작성자 사진: 원격 없는 저장소는 실제 IPC가 null을 주고 이니셜로 보이며, 스플래시는 사라진다", async () => {
    await js(`await waitFor(() => $(".graph-scroll .author .avatar"), "작성자 아바타");`);
    const r = await js(`return { splash: !!$("#splash"), initials: $(".graph-scroll .author .avatar").textContent };`);
    eq(r.splash, false, "스플래시 제거");
    eq(r.initials, "E", "이니셜");
  });

  await step("로컬 변경사항: 새 파일 스테이지 → 커밋 → 실제 저장소에 커밋된다", async () => {
    await js(`
      press(await waitFor(() => byText(".commits .subject", "로컬 변경사항"), "로컬 변경사항 행"));
      const unstaged = await waitFor(() => $('[role=listbox][aria-label="스테이지 안 됨"]'), "스테이지 안 됨 목록");
      dbl(await waitFor(() => $$("[role=option]", unstaged).find((o) => o.textContent.includes("new.txt")), "new.txt"));
      await waitFor(() => $$('[role=listbox][aria-label="스테이지됨"] [role=option]').some((o) => o.textContent.includes("new.txt")), "스테이지됨에 new.txt");
      fill($('[aria-label="커밋 제목"]'), "실제 앱 E2E 커밋");
      const btn = await waitFor(() => $$("button").find((b) => b.textContent.trim() === "커밋" && !b.disabled), "커밋 버튼 활성");
      press(btn);
      await waitFor(() => byText(".commits *", "실제 앱 E2E 커밋"), "그래프에 새 커밋");
      await waitFor(() => byText(".toast[role=status] *", "커밋 완료") && byText(".toast *", "실제 앱 E2E 커밋"), "커밋 완료 토스트");
    `);
    eq(git("log", "-1", "--format=%s"), "실제 앱 E2E 커밋", "HEAD 제목");
    eq(git("show", "--name-only", "--format=", "HEAD"), "new.txt", "커밋된 파일");
    eq(git("status", "--porcelain"), "", "작업 디렉터리");
  });

  await step("앱 밖에서 git으로 바꾸면 화면이 따라온다 (파일 감시)", async () => {
    git("commit", "-q", "--allow-empty", "-m", "바깥에서 만든 커밋");
    await js(`await waitFor(() => byText(".commits *", "바깥에서 만든 커밋"), "감시로 새로 고침");`);
  });

  await step("이미지 diff: PNG 두 버전을 커밋하면 커밋 상세에서 이전/이후 비교와 바뀐 픽셀 %가 뜬다 (진짜 file_blob)", async () => {
    // 16×16 빨강 → 같은 그림에 (5,6) 4×3만 파랑 (ui/e2e/png.ts와 같은 그림)
    const RED = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGM4YWT0nxLMMGrAqAGjBgwXAwBLmSsfjRJy6gAAAABJRU5ErkJggg==";
    const BLUE = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAI0lEQVR4nGM4YWT0nxLMMGoAjQwwMjqBgoegAQMfiKMGkIYBPYkrH/RHu08AAAAASUVORK5CYII=";
    writeFileSync(join(repo, "pic.png"), Buffer.from(RED, "base64"));
    git("add", "pic.png");
    git("commit", "-qm", "그림 추가");
    writeFileSync(join(repo, "pic.png"), Buffer.from(BLUE, "base64"));
    git("commit", "-qam", "그림 수정");
    // 웹뷰 안의 waitFor는 창이 가려지면 타이머가 느려져 멈춘 듯 보이므로, 파일 감시가 새 커밋을 그리는 걸 웹뷰 밖에서 먼저 기다린다
    await until(() => js(`return !!byText(".commits .subject", "그림 수정")`), "그래프에 그림 수정 커밋", 30000);
    await js(`press(byText(".commits .subject", "그림 수정")); return 1`);
    await until(() => js(`return !!$$("[role=option]").find((o) => o.textContent.includes("pic.png"))`), "pic.png 파일 줄", 30000);
    await js(`press($$("[role=option]").find((o) => o.textContent.includes("pic.png"))); return 1`);
    const info = () => js(`return $(".img-info")?.textContent ?? ""`);
    await until(async () => (await info()).includes("바뀐 픽셀 4.7%"), "바뀐 픽셀 %", 30000).catch(async (e) => { throw new Error(`${e.message}: ${await info()}`); });
    await until(() => js(`return $$(".img-layer").length === 2`), "나란히 모드 이미지 두 장", 30000);
    if (!(await info()).includes("변경 영역 (5, 6) 4×3")) throw new Error("변경 영역: " + (await info()));
    git("reset", "-q", "--hard", "HEAD~2"); // 뒤 단계가 HEAD를 "바깥에서 만든 커밋"으로 가정한다
  });

  await step("xib 시각 diff: xib 두 버전을 커밋하면 커밋 상세에서 뷰어(요약·변경 목록)가 뜨고 Raw로 텍스트 diff를 본다 (진짜 file_blob)", async () => {
    const xib = (y, size) => `<?xml version="1.0" encoding="UTF-8"?>
<document type="com.apple.InterfaceBuilder3.CocoaTouch.XIB" version="3.0">
  <objects>
    <placeholder placeholderIdentifier="IBFilesOwner" id="-1"><connections><outlet property="titleLabel" destination="lbl-1" id="o1"/></connections></placeholder>
    <view id="root-1" customClass="CellView"><rect key="frame" x="0" y="0" width="320" height="64"/>
      <subviews><label id="lbl-1" text="Title"><rect key="frame" x="120" y="${y}" width="173" height="20"/><fontDescription key="fontDescription" type="boldSystem" pointSize="${size}"/></label></subviews>
    </view>
  </objects>
</document>
`;
    writeFileSync(join(repo, "Cell.xib"), xib(28, 16));
    git("add", "Cell.xib");
    git("commit", "-qm", "xib 추가");
    writeFileSync(join(repo, "Cell.xib"), xib(24, 17));
    git("commit", "-qam", "xib 수정");
    await js(`
      press(await waitFor(() => byText(".commits .subject", "xib 수정"), "xib 수정 커밋"));
      press(await waitFor(() => $$("[role=option]").find((o) => o.textContent.includes("Cell.xib")), "Cell.xib"));
      await waitFor(() => $(".ib-summary")?.textContent === "CellView · 뷰 변경 1건 · 제약 변경 0건", "요약: " + $(".ib-summary")?.textContent);
      const row = await waitFor(() => $$(".ib-item").find((o) => o.textContent.includes("뷰 수정 · titleLabel")), "변경 목록 항목");
      for (const w of ["위치·크기 (120, 28) 173×20 → (120, 24) 173×20", "fontDescription: boldSystem 16 → boldSystem 17"]) if (!row.textContent.includes(w)) throw new Error("세부: " + row.textContent);
      press(byText(".ib-diff button", "Raw"));
      await waitFor(() => $$(".diff .add").some((l) => l.textContent.includes("pointSize")), "Raw 텍스트 diff");
      press(byText(".diff button", "뷰어"));
      await waitFor(() => $(".ib-summary"), "다시 뷰어");
    `);
    git("reset", "-q", "--hard", "HEAD~2"); // 뒤 단계가 HEAD를 "바깥에서 만든 커밋"으로 가정한다
  });

  await step("긴 줄 diff(한 줄 모드)는 가로 스크롤로 줄 끝까지 보이고, 줄바꿈을 켜면 넘침 없이 줄바꿈된다 (실제 웹뷰)", async () => {
    const line = (tag) => `render(<Foo a={1} b="hello world" />, { wrapper: Wrapper, ...opts }); `.repeat(14) + tag;
    writeFileSync(join(repo, "long.test.tsx"), line("A") + "\n");
    git("add", "long.test.tsx");
    git("commit", "-qm", "긴 줄 추가");
    writeFileSync(join(repo, "long.test.tsx"), line("END") + "\n");
    git("commit", "-qam", "긴 줄 수정");
    await js(`
      press(await waitFor(() => byText(".commits .subject", "긴 줄 수정"), "긴 줄 수정 커밋"));
      press(await waitFor(() => $$("[role=option]").find((o) => o.textContent.includes("long.test.tsx")), "long.test.tsx"));
      const row = await waitFor(() => $(".dl.add"), "추가 줄");
      const pre = $("pre.diff");
      await waitFor(() => pre.scrollWidth > pre.clientWidth + 100, "가로 스크롤 폭: " + pre.scrollWidth + "/" + pre.clientWidth);
      pre.scrollLeft = 99999;
      const code = row.querySelector(".code").getBoundingClientRect();
      if (Math.abs(code.right - pre.getBoundingClientRect().right) > 2) throw new Error("줄 끝이 안 보임: " + code.right + " vs " + pre.getBoundingClientRect().right);
      localStorage.setItem("diffWrap", "true");
      window.dispatchEvent(new Event("storage"));
    `);
    git("reset", "-q", "--hard", "HEAD~2");
    await js(`localStorage.removeItem("diffWrap");`);
  });

  await step("diff 크게 보기: 파일 더블클릭으로 diff가 그래프 자리를 덮고(오른쪽 열 유지), Esc·X로 닫으면 원래대로 돌아온다 (실제 IPC)", async () => {
    await js(`
      press(await waitFor(() => byText(".commits .subject", "두 번째 커밋"), "두 번째 커밋"));
      const opt = await waitFor(() => $$("[role=option]").find((o) => o.textContent.includes("a.txt")), "a.txt");
      press(opt);
      await waitFor(() => $(".diff .add"), "diff");
      const graph0 = $(".pane.graph").getBoundingClientRect().height;
      dbl(opt);
      await waitFor(() => document.documentElement.hasAttribute("data-big"), "크게 보기 진입");
      const main = $(".main").getBoundingClientRect(), wrap = $(".diff-wrap").getBoundingClientRect(), info = $(".details > .info").getBoundingClientRect();
      if (getComputedStyle($(".pane.graph")).visibility !== "hidden") throw new Error("그래프가 숨겨지지 않음");
      if (wrap.height < main.height - 2) throw new Error("diff가 그래프 자리를 덮지 않음: " + wrap.height + " < " + main.height);
      if (info.x < wrap.right - 2 || info.height < main.height - 2) throw new Error("오른쪽 열이 세로 전체가 아님");
      if (!$(".diff .add")) throw new Error("덮은 diff 없음");
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await waitFor(() => !document.documentElement.hasAttribute("data-big"), "Esc로 닫기");
      if (Math.abs($(".pane.graph").getBoundingClientRect().height - graph0) > 1) throw new Error("그래프 크기가 복원되지 않음");
      press($(".diff-file button[aria-label='크게 보기']"));
      await waitFor(() => document.documentElement.hasAttribute("data-big"), "버튼으로 진입");
      press($(".diff-file button[aria-label^='크게 보기 닫기']"));
      await waitFor(() => !document.documentElement.hasAttribute("data-big"), "X로 닫기");
    `);
  });

  await step("탭을 끌어 순서를 바꾸면 저장되고, 끈 뒤 클릭으로 탭이 바뀌지 않는다 (실제 웹뷰 포인터 이벤트)", async () => {
    const other = temp("e2e-tab2");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: other });
    const tabs = JSON.stringify([repo, other]);
    await js(`localStorage.setItem("tabs", ${JSON.stringify(tabs)}); localStorage.setItem("activeTab", ${JSON.stringify(JSON.stringify(repo))}); setTimeout(() => location.reload(), 0);`);
    await new Promise((r) => setTimeout(r, 1000));
    try {
      await js(`
        await waitFor(() => $$(".tab").length === 2 && $(".tab.active")?.dataset.path === ${JSON.stringify(repo)}, "탭 2개");
        const [a, b] = $$(".tab").map((e) => e.getBoundingClientRect());
        const el = $$(".tab")[0], y = a.top + a.height / 2;
        const ev = (t, x, tgt) => tgt.dispatchEvent(new PointerEvent(t, { bubbles: true, button: 0, clientX: x, clientY: y, pointerId: 1, isPrimary: true }));
        ev("pointerdown", a.left + a.width / 2, el.firstElementChild);
        for (let i = 1; i <= 10; i++) { ev("pointermove", a.left + a.width / 2 + ((b.right - a.left - a.width / 2) * i) / 10, window); await new Promise((r) => setTimeout(r, 16)); }
        ev("pointerup", b.right, window);
        el.firstElementChild.click();
        await waitFor(() => $$(".tab")[1]?.dataset.path === ${JSON.stringify(repo)}, "순서 바뀜");
        if (JSON.parse(localStorage.getItem("tabs"))[1] !== ${JSON.stringify(repo)}) throw new Error("저장 안 됨: " + localStorage.getItem("tabs"));
        if ($(".tab.active").dataset.path !== ${JSON.stringify(repo)}) throw new Error("드래그 뒤 클릭으로 탭이 바뀜");
        if (el.style.transform) throw new Error("transform 남음: " + el.style.transform);
      `);
    } finally {
      await js(`localStorage.setItem("tabs", ${JSON.stringify(JSON.stringify([repo]))}); setTimeout(() => location.reload(), 0);`);
      await new Promise((r) => setTimeout(r, 1000));
      rmSync(other, { recursive: true, force: true });
    }
  });

  await step("Fetch: 원격에서 옮겨진 태그는 덮어쓰지 않고 안내만, 나머지(새 브랜치)는 받고 실패로 띄우지 않는다 (진짜 git fetch --tags)", async () => {
    const bare = temp("e2e-bare");
    execFileSync("git", ["clone", "-q", "--bare", repo, bare]);
    const old = git("rev-parse", "HEAD~1");
    git("tag", "moved");
    execFileSync("git", ["tag", "moved", old], { cwd: bare });
    execFileSync("git", ["branch", "remote-only", old], { cwd: bare });
    git("remote", "add", "origin", bare);
    try {
      const local = git("rev-parse", "moved");
      await js(`
        press(await waitFor(() => $$(".toolbar button").find((b) => b.textContent.trim() === "Fetch"), "Fetch 버튼"));
        await waitFor(() => byText(".toast *", "로컬 태그 moved가 원격과 달라 그대로 두었습니다"), "태그 안내 토스트", 20000);
        if (byText(".toast *", "Fetch 실패")) throw new Error("실패 토스트가 떴다");
      `);
      eq(git("rev-parse", "moved"), local, "로컬 태그는 그대로");
      eq(git("rev-parse", "origin/remote-only"), old, "새 원격 브랜치는 받음");
    } finally {
      git("remote", "remove", "origin");
      git("tag", "-d", "moved");
      rmSync(bare, { recursive: true, force: true });
    }
  });

  await step("커밋 메시지 수정: 오래된 커밋은 이후 커밋을 그대로 다시 쌓고, HEAD는 스테이지를 건드리지 않고 amend (진짜 git)", async () => {
    const orig = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "r.txt"), "r\n");
    git("add", "r.txt");
    git("commit", "-qm", "reword 대상");
    git("commit", "-q", "--allow-empty", "-m", "reword 다음");
    const tree = git("rev-parse", "HEAD^{tree}");
    const reword = (subject, body) => `
      press(await waitFor(() => byText(".commits .subject", ${JSON.stringify(subject)}), "커밋 행"));
      press(await waitFor(() => $('.info-edit'), "메시지 수정 버튼"));
      const sheet = await waitFor(() => $('[role=dialog][aria-label="커밋 메시지 수정"]'), "시트");
      await waitFor(() => $('input[aria-label="제목"]', sheet)?.value === ${JSON.stringify(subject)}, "기존 제목");
      fill($('input[aria-label="제목"]', sheet), ${JSON.stringify(subject + " 수정")});
      fill($('textarea[aria-label="본문(선택)"]', sheet), ${JSON.stringify(body)});
      press($$("button", sheet).find((b) => b.textContent === "메시지 수정"));
      await waitFor(() => byText(".toast *", "커밋 메시지를 수정했습니다"), "완료 토스트", 20000);
      await waitFor(() => byText(".commits .subject", ${JSON.stringify(subject + " 수정")}), "그래프 갱신");
    `;
    try {
      await js(reword("reword 대상", "본문 첫 줄\n둘째 줄"));
      eq(git("log", "-1", "--format=%B", "HEAD~1"), "reword 대상 수정\n\n본문 첫 줄\n둘째 줄", "오래된 커밋 메시지");
      eq(git("log", "-1", "--format=%s", "HEAD"), "reword 다음", "이후 커밋 유지");
      eq(git("rev-parse", "HEAD~2"), orig, "부모 그대로");
      eq(git("rev-parse", "HEAD^{tree}"), tree, "내용 그대로");
      writeFileSync(join(repo, "s.txt"), "staged\n");
      git("add", "s.txt");
      await js(reword("reword 다음", ""));
      eq(git("log", "-1", "--format=%B", "HEAD"), "reword 다음 수정", "HEAD 메시지");
      eq(git("rev-parse", "HEAD^{tree}"), tree, "스테이지는 커밋에 안 들어감");
      eq(git("diff", "--cached", "--name-only"), "s.txt", "스테이지 유지");
    } finally {
      git("reset", "-q", "--hard", orig);
      rmSync(join(repo, "s.txt"), { force: true });
    }
  });

  await step("체크아웃이 로컬 변경 때문에 막히면 스태시에 넣고 이동한 뒤 다시 적용한다 (진짜 git switch·stash)", async () => {
    const orig = git("rev-parse", "HEAD");
    const lines = (a, z) => ["1", "2", "3", "4", "5", "6", "7", "8"].map((l, i) => (i === 0 ? a : i === 7 ? z : l)).join("\n") + "\n";
    writeFileSync(join(repo, "as.txt"), lines("1", "8"));
    git("add", "as.txt");
    git("commit", "-qm", "autostash 기준");
    git("branch", "auto/x");
    git("checkout", "-q", "auto/x");
    writeFileSync(join(repo, "as.txt"), lines("첫 줄 브랜치", "8"));
    git("commit", "-qam", "autostash 브랜치 쪽");
    git("checkout", "-q", "main");
    writeFileSync(join(repo, "as.txt"), lines("1", "끝 줄 로컬"));
    try {
      await js(`
        const badge = await waitFor(() => $('.row-refs .badge[title*="auto/x"]'), "auto/x 배지");
        badge.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        await waitFor(() => byText(".toast *", "로컬 변경을 스태시에 넣었다가 다시 적용했습니다"), "자동 스태시 토스트", 20000);
      `);
      eq(git("branch", "--show-current"), "auto/x", "브랜치 이동");
      eq(readFileSync(join(repo, "as.txt"), "utf8"), lines("첫 줄 브랜치", "끝 줄 로컬"), "로컬 변경이 브랜치 위에 다시 적용됨");
      eq(git("stash", "list"), "", "스태시는 비움");
    } finally {
      git("checkout", "-q", "-f", "main");
      git("reset", "-q", "--hard", orig);
      git("branch", "-D", "auto/x");
    }
  });

  await step("스태시 팝이 충돌하면 충돌 안내(스태시 유지), 미해결 상태로 다시 팝하면 '충돌 먼저 해결' 안내 (진짜 git stash pop)", async () => {
    const orig = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "sc.txt"), "a\n");
    git("add", "sc.txt");
    git("commit", "-qm", "스태시 충돌 기준");
    writeFileSync(join(repo, "sc.txt"), "스태시 쪽\n");
    git("stash", "push", "-q", "-m", "충돌 스태시");
    writeFileSync(join(repo, "sc.txt"), "커밋 쪽\n");
    git("commit", "-qam", "스태시 충돌 커밋 쪽");
    await js(`setTimeout(() => location.reload(), 0);`); // 밖에서 만든 스태시를 새로 읽게
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const pop = `press(await waitFor(() => $$('.toolbar button[aria-label="팝"]').find((b) => !b.disabled), "팝 버튼"));`;
      await js(`
        ${pop}
        await waitFor(() => byText(".toast *", "스태시를 적용했지만 충돌이 생겼습니다"), "충돌 안내 토스트", 20000);
        if (byText(".toast *", "git exited")) throw new Error("원시 git 오류가 보임");
      `);
      eq(git("diff", "--name-only", "--diff-filter=U"), "sc.txt", "충돌 상태");
      eq(git("stash", "list", "--format=%s"), "On main: 충돌 스태시", "충돌 시 스태시는 남음");
      await js(`
        ${pop}
        await waitFor(() => byText(".toast *", "해결하지 않은 충돌이 있어 스태시를 적용할 수 없습니다"), "미해결 안내 토스트", 20000);
      `);
    } finally {
      git("reset", "-q", "--hard", orig);
      git("stash", "clear");
    }
  });

  if (process.platform !== "win32") await step("AI 채팅: 충돌 난 pull 실패 → 'AI에게 맡기기' → (가짜 claude가 진짜 git으로 병합·해결) → 이력 → 되돌리기 (진짜 IPC)", async () => {
    const orig = git("rev-parse", "HEAD");
    const bare = temp("e2e-ai-bare");
    const other = temp("e2e-ai-other");
    const gitAt = (cwd) => (...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
    try {
      execFileSync("git", ["clone", "-q", "--bare", repo, bare]);
      execFileSync("git", ["clone", "-q", bare, other]);
      const o = gitAt(other);
      o("config", "user.name", "Other");
      o("config", "user.email", "o@example.com");
      o("config", "core.autocrlf", "false");
      writeFileSync(join(other, "a.txt"), "원격 쪽\n");
      o("commit", "-qam", "원격에서 a.txt 수정");
      o("push", "-q", "origin", "HEAD:main");
      git("remote", "add", "origin", bare);
      git("fetch", "-q", "origin");
      git("branch", "--set-upstream-to=origin/main", "main");
      writeFileSync(join(repo, "a.txt"), "내 쪽\n");
      git("commit", "-qam", "내 쪽에서 a.txt 수정");
      const mine = git("rev-parse", "HEAD");
      // 동의는 미리 저장해 둔다 (OS 확인창은 E2E에서 누를 수 없다)
      await js(`await window.__TAURI_INTERNALS__.invoke("ai_settings_set", { provider: "anthropic", consent: true });`);
      await js(`localStorage.setItem("aiChatOpen", "{}"); setTimeout(() => location.reload(), 0);`);
      await new Promise((r) => setTimeout(r, 1000));
      await js(`await waitFor(() => $(".status-branch .ab"), "상태(추적 브랜치)", 20000);`); // 상태가 읽혀야 Pull이 추적 브랜치를 명시한다
      await js(`press(await waitFor(() => $$('.toolbar button[aria-label="Pull"]').find((b) => !b.disabled), "Pull 버튼", 20000));`);
      await js(`await waitFor(() => $$(".toast").find((t) => t.textContent.includes("Pull 실패")), "Pull 실패 토스트: " + $$(".toast").map((t) => t.textContent).join("|"), 9000);`);
      // 같은 컴퓨터의 경로 원격은 AI 차례에서 거절되므로(대상 저장소 설정 실행 위험) 원격 설정을 지우고, 가짜 claude가 그 경로로 직접 pull하게 한다
      git("remote", "remove", "origin");
      writeFileSync(fakeLog + ".pull", bare);
      await js(`
        const toast = $$(".toast").find((t) => t.textContent.includes("Pull 실패"));
        const b = $$("button", toast).find((b) => b.textContent === "AI에게 맡기기");
        if (!b) throw new Error("AI에게 맡기기 버튼 없음: " + toast.textContent);
        press(b);
      `);
      await js(`await waitFor(() => $('aside[aria-label="AI 채팅"]'), "AI 열");`);
      // 웹뷰 밖에서 폴링한다 (창이 가려지면 웹뷰 타이머가 느려져 안쪽 waitFor가 길어진다)
      const aside = () => js(`return $('aside[aria-label="AI 채팅"]')?.innerText ?? ""`);
      await until(async () => (await aside()).includes("충돌을 해결했습니다."), "AI 답: " + (await aside()), 30000).catch(async (e) => { throw new Error(`${e.message} — fake 실행됨: ${existsSync(fakeLog)} — ${await aside()}`); });
      await js(`
        await waitFor(() => byText('aside[aria-label="AI 채팅"] button', "이 작업 되돌리기"), "되돌리기 줄");
        if (!$$('aside[aria-label="AI 채팅"] .ai-tool-cmd').some((e) => e.textContent === "git commit --no-edit")) throw new Error("도구 줄 없음");
      `);
      const log = JSON.parse(readFileSync(fakeLog, "utf8"));
      eq(log.cwd.includes(basename(repo)), true, "저장소 폴더에서 실행");
      const prompt = log.argv.join(" ");
      if (!prompt.includes("git pull") || !prompt.includes("fast-forward")) throw new Error("오류 내용을 담은 입력이 아님: " + prompt.slice(0, 300));
      await until(() => git("log", "-1", "--format=%P").split(" ").length === 2, "병합 커밋(부모 둘)").catch((e) => {
        throw new Error(`${e.message} — ${git("log", "--oneline", "--graph", "--all", "-8").replace(/\n/g, " / ")} — status: ${git("status", "-sb").replace(/\n/g, " / ")}`); // 흔들림 진단용
      });
      eq(readFileSync(join(repo, "a.txt"), "utf8"), "합친 결과\n", "충돌이 해결된 내용");
      eq(git("status", "--porcelain").includes("a.txt"), false, "a.txt 정리됨");
      // 이력에 남고, 그 백업으로 되돌리면 병합 전(내 커밋)으로 돌아간다
      const hist = await js(`const l = await window.__TAURI_INTERNALS__.invoke("ai_history_list", { repo: ${JSON.stringify(repo)} }); const e = await window.__TAURI_INTERNALS__.invoke("ai_history_read", { repo: ${JSON.stringify(repo)}, conversation: l[0].conversation }); return { n: l.length, turns: l[0].turns, status: e[0].status, backup: e[0].backup, sid: e[0].sessionId };`);
      eq([hist.n, hist.turns, hist.status, hist.sid], [1, 1, "done", "fake-sess"], "이력");
      await js(`await window.__TAURI_INTERNALS__.invoke("ai_backup_restore", { repo: ${JSON.stringify(repo)}, id: ${JSON.stringify(hist.backup.id)}, branch: ${JSON.stringify(hist.backup.branch)} });`);
      eq(git("rev-parse", "HEAD"), mine, "되돌린 뒤 HEAD");
      eq(git("rev-parse", "main"), mine, "되돌린 뒤 main");
    } finally {
      git("reset", "-q", "--hard", orig);
      try { git("remote", "remove", "origin"); } catch {}
      await js(`localStorage.setItem("aiChatOpen", "{}"); setTimeout(() => location.reload(), 0);`).catch(() => {});
      await new Promise((r) => setTimeout(r, 1000));
      for (const d of [bare, other]) rmSync(d, { recursive: true, force: true });
    }
  });

  if (process.platform !== "win32") await step("AI 채팅 위험 확인(진짜 IPC): 원격 없음은 확인 없음, 로컬 경로 원격은 거절, 호스팅 원격은 백엔드가 확인 없는 시작을 거절한다(확인 후 진행은 위 AI 채팅 단계와 같은 경로)", async () => {
    const inv = (cmd, args) => js(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)});`);
    const start = (conversation, extra = {}) => js(`try { await window.__TAURI_INTERNALS__.invoke("ai_chat_start", ${JSON.stringify({ repo, conversation, input: "상태", ...extra })}); return "ok"; } catch (e) { return String(e); }`);
    eq((await inv("ai_chat_risk", { repo })).level, "none", "원격 없음 = 로컬 전용");
    git("remote", "add", "origin", join(repo, "..", "no-such-bare.git")); // 같은 컴퓨터의 경로 원격: 로컬 전용이 아니라 거절(대상 저장소 설정이 push·fetch 때 실행될 수 있다)
    try {
      const local = await inv("ai_chat_risk", { repo });
      if (!(local.refuse ?? []).some((r) => r.includes("local path"))) throw new Error("로컬 경로 원격이 거절되지 않음: " + JSON.stringify(local));
      const refusedLocal = await start("risk-0", { confirmed: true });
      if (!refusedLocal.includes("aiChat.configRefused")) throw new Error("확인(confirmed)으로도 거절돼야 함: " + refusedLocal);
      git("remote", "set-url", "origin", "https://gitlab.com/o/r.git"); // GitHub가 아니라 판정 불가 = 위험
      eq((await inv("ai_chat_risk", { repo })).level, "unknown", "판정 불가");
      const refs = () => git("for-each-ref", "refs/git403/ai-backup").split("\n").filter(Boolean).length;
      const before = refs();
      const refused = await start("risk-1");
      if (!refused.includes("aiChat.confirmRequired")) throw new Error("확인 없는 시작이 거절되지 않음: " + refused);
      eq(refs(), before, "거절된 시작은 백업을 만들지 않는다");
    } finally {
      try { git("remote", "remove", "origin"); } catch {}
    }
  });

  await step("상세 오른쪽 배치(기본값): 그래프 | 상세 열, 파일을 누르면 진짜 diff가 그래프 자리에 열리고 Esc로 돌아온다", async () => {
    await js(`localStorage.removeItem("detailLayout"); setTimeout(() => location.reload(), 0);`);
    await new Promise((r) => setTimeout(r, 1000));
    try {
      await js(`
        await waitFor(() => $(".detail-col"), "오른쪽 상세 열");
        press(await waitFor(() => byText(".commits .subject", "두 번째 커밋"), "커밋"));
        const opt = await waitFor(() => $$(".detail-col [role=option]").find((o) => o.textContent.includes("a.txt")), "a.txt");
        opt.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
        await waitFor(() => document.documentElement.hasAttribute("data-big") && $(".detail-col .diff .add"), "그래프 자리 diff");
        if (getComputedStyle($(".main > .pane.graph")).visibility !== "hidden") throw new Error("그래프가 가려지지 않음");
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await waitFor(() => !document.documentElement.hasAttribute("data-big") && getComputedStyle($(".main > .pane.graph")).visibility === "visible", "그래프로 돌아옴");
      `);
    } finally {
      await js(`localStorage.setItem("detailLayout", '"bottom"'); setTimeout(() => location.reload(), 0);`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  });

  await step("창 위치·크기를 종료 때 저장하고 다시 실행하면 되살린다", async () => {
    await nat("@move 140 120 1010 690");
    await new Promise((r) => setTimeout(r, 300));
    const before = await nat("@frame");
    await nat("@quit");
    await exited(app);
    app = launch([repo]);
    await js(`await waitFor(() => $(".toolbar"), "툴바");`);
    const after = await nat("@frame");
    if (after.some((v, i) => Math.abs(v - before[i]) > 2)) throw new Error(`창 ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  });

  await step("시작 화면: 저장소 목록에서 하나 지우기 · 모두 지우기 (저장소 폴더는 그대로)", async () => {
    await nat("@quit");
    await exited(app);
    app = launch([]); // 실행 인자 없이 → 시작 화면 (탭 복원은 끈다)
    const other = "/nonexistent/other-repo";
    await js(`localStorage.setItem("recent", JSON.stringify([${JSON.stringify(repo)}, "${other}"])); localStorage.setItem("tabs", "[]"); localStorage.removeItem("activeTab"); localStorage.setItem("restoreTabs", "false"); setTimeout(() => location.reload(), 0);`);
    await new Promise((r) => setTimeout(r, 1000));
    await js(`
      await waitFor(() => $$('[aria-label="저장소 목록"] li').length === 2, "목록 2개");
      press(await waitFor(() => $('[aria-label="목록에서 지우기: ${other}"]'), "지우기 버튼"));
      await waitFor(() => $$('[aria-label="저장소 목록"] li').length === 1, "하나 지워짐");
      if (JSON.parse(localStorage.getItem("recent")).includes("${other}")) throw new Error("저장 안 됨");
      press(byText("button", "목록 모두 지우기"));
      await waitFor(() => !$('[aria-label="저장소 목록"]'), "목록 사라짐");
      if (localStorage.getItem("recent") !== "[]") throw new Error("recent: " + localStorage.getItem("recent"));
    `);
    eq(git("log", "-1", "--format=%s"), "바깥에서 만든 커밋", "저장소는 그대로");
  });

  await step("설정 > 강조색: 고르면 바로 바뀌고 다시 실행해도 유지된다", async () => {
    const accent = `getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()`;
    await js(`
      document.dispatchEvent(new KeyboardEvent("keydown", { key: ",", metaKey: true, bubbles: true }));
      press(await waitFor(() => $('[role=radiogroup][aria-label="강조색"] [aria-label="초록"]'), "초록 견본"));
      await waitFor(() => ${accent} === "#2f9a5f", "강조색 적용");
    `);
    await nat("@quit");
    await exited(app);
    app = launch([]);
    eq(await js(`await waitFor(() => $(".toolbar"), "툴바"); return ${accent};`), "#2f9a5f", "다시 실행 후 강조색");
  });

  await step("브랜치 비교(진짜 compare_refs): 전체 ref 이름이면 같은 이름 태그가 있어도 브랜치끼리 비교하고 진짜 git log a..b·b..a와 같다, 옵션처럼 보이는 이름은 거절", async () => {
    git("checkout", "-q", "-b", "cmp-a", "main");
    git("commit", "-q", "--allow-empty", "-m", "비교 a1");
    git("commit", "-q", "--allow-empty", "-m", "비교 a2");
    git("checkout", "-q", "-b", "cmp-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "비교 b1");
    git("checkout", "-q", "main");
    git("tag", "cmp-b", "main"); // 짧은 이름 cmp-b는 태그로 풀린다 (git은 태그를 먼저 본다)
    const inv = (a, b) => js(`try { return await window.__TAURI_INTERNALS__.invoke("compare_refs", { repo: ${JSON.stringify(repo)}, a: ${JSON.stringify(a)}, b: ${JSON.stringify(b)} }); } catch (e) { return { error: String(e) }; }`);
    const ids = (r, side) => r[side].map((c) => c.id);
    const log = (range) => git("log", "--topo-order", "--format=%H", range, "--").split("\n").filter(Boolean);
    const r = await inv("refs/heads/cmp-a", "refs/heads/cmp-b");
    eq(ids(r, "onlyA"), log("refs/heads/cmp-b..refs/heads/cmp-a"), "onlyA = log b..a");
    eq(ids(r, "onlyB"), log("refs/heads/cmp-a..refs/heads/cmp-b"), "onlyB = log a..b");
    eq([r.onlyA.length, r.onlyB.length], [2, 1], "개수");
    const short = await inv("cmp-a", "cmp-b"); // 짧은 이름은 태그(main)와 비교돼 onlyB가 비는 것이 옛 오동작
    eq(short.onlyB?.length, 0, "짧은 이름은 태그로 풀림 (그래서 전체 이름을 쓴다)");
    const bad = await inv("--output=/tmp/x", "refs/heads/cmp-b");
    if (!bad.error) throw new Error("옵션처럼 보이는 ref를 거절하지 않음");
    git("tag", "-d", "cmp-b");
    git("branch", "-q", "-D", "cmp-a", "cmp-b");
  });

  // ---- jj 30f: 실제 UI 경로(빠른 실행 팔레트·우클릭 메뉴·prompt·시트·OS ask)로 진행한다. IPC 직접 호출은 준비·검증(상태 읽기, 밖에서 jj가 바뀐 상황)에만 쓴다.
  // 네이티브 메뉴는 JS로 못 누르므로 `window.__e2eDomMenu = true`로 우클릭 메뉴를 DOM 메뉴로 띄운다(menu.tsx). OS 확인창은 `window.__e2eAsk`(bridge.ts `ask`의 E2E 훅, VITE_E2E_APP 빌드 전용; `__TAURI_INTERNALS__.invoke`는 덮어쓸 수 없다)로 문구를 모으고 승인한다(window.__asked).
  const jjInv = (cmd, args = {}) => js(`try { return { ok: await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify({ repo, ...args })}) }; } catch (e) { return { err: String(e) }; }`);
  const jjOk = async (cmd, args) => { const r = await jjInv(cmd, args); if (r.err) throw new Error(`${cmd}: ${r.err}`); return r.ok; };
  const hookAsk = () => js(`window.__e2eDomMenu = true; if (!window.__e2eAsk) { window.__asked = []; window.__e2eAsk = (message) => (window.__asked.push(message), !window.__askNo); }`);
  const dlgJs = (name) => `$$('[role=dialog]').find((d) => d.getAttribute("aria-label") === ${JSON.stringify(name)})`;
  // Esc는 열린 시트(role=dialog)에서 올라가야 React의 시트 핸들러가 받는다(document에 보내면 시트가 안 닫힌다)
  const esc = () => js(`($('[role=dialog]') ?? document).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));`);
  const quick = (label) => js(`
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "p", metaKey: true, ctrlKey: true, bubbles: true }));
    const input = await waitFor(() => $('[role=dialog] input'), "빠른 실행 입력");
    fill(input, ${JSON.stringify(label)});
    press(await waitFor(() => $$('[role=dialog] [role=option]').find((o) => o.textContent.includes(${JSON.stringify(label)}) && o.textContent.includes("jj")), "팔레트 항목 ${label}"));
  `);
  /** 커밋 행 우클릭 → DOM 메뉴 항목 누르기 */
  const rowMenu = (subject, item) => js(`
    rightClick(await waitFor(() => $$(".commits .row").find((r) => r.textContent.includes(${JSON.stringify(subject)})), "커밋 행 ${subject}"));
    press(await waitFor(() => $$('[role=menuitem]').find((m) => m.textContent.trim().startsWith(${JSON.stringify(item)})), "메뉴 ${item}"));
  `);
  /** "북마크 만들기" prompt에 이름을 넣고 만든다 */
  const bookmarkPrompt = (name) => js(`
    const d = await waitFor(() => ${dlgJs("북마크 만들기")}, "북마크 prompt");
    fill($("input", d), ${JSON.stringify(name)});
    press($$("button", d).find((b) => b.textContent.trim() === "만들기"));
  `);
  const jjMarks = () => js(`return $$(".jj-mark").length;`);
  const asked = () => js(`return window.__asked ?? [];`);
  const opLog = async () => jjOk("jj_op_log", { limit: 200 });
  const toastHas = (text) => js(`return $$(".toast").some((t) => t.textContent.includes(${JSON.stringify(text)}));`);
  // git()은 출력을 trim해 첫 줄의 앞 공백(" M a.txt")이 사라지므로 직접 실행한다
  const porcelainPaths = () => execFileSync("git", ["status", "--porcelain=v1", "-uall"], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, "")).sort();
  const rev = (ref) => { try { return git("rev-parse", "--verify", "-q", ref); } catch { return ""; } };
  const bare = temp("bare");
  /** 각 jj 단계의 독립 준비: 저장소가 열린 앱(앞 단계가 앱을 다시 띄웠거나 저장소 없이 시작했을 수 있다)·ask 가로채기·(withJj면) jj 켜짐+jj 보기. 이미 되어 있으면 아무것도 안 한다 */
  const prep = async (withJj) => {
    if (!(await js(`return !!$(".commits .row");`).catch(() => false))) {
      await nat("@quit").catch(() => {});
      await exited(app);
      app = launch([repo]);
      await js(`await waitFor(() => $$(".commits .row").length, "커밋 목록", 20000);`);
    }
    await hookAsk();
    if (!withJj) return;
    const on = await jjInv("jj_status");
    if (on.err) {
      await jjOk("jj_enable");
      await js(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "r", metaKey: true, ctrlKey: true, bubbles: true }));`);
    }
    await until(async () => (await jjMarks()) > 0, "jj 보기 표시");
  };

  await step("jj 30f: 빠른 실행으로 jj를 켜면(ask 승인) jj 보기가 되고, 앱 변경 목록이 새 파일을 보인 뒤 ctx.status 경로 집합이 git status와 같다 (새 파일은 ? 또는 A)", async () => {
    await prep(false);
    if (!(await jjInv("jj_status")).err) throw new Error("준비: jj가 이미 켜져 있음");
    await quick("jj 모드 켜기");
    await until(async () => (await jjMarks()) > 0, "jj 보기 표시");
    writeFileSync(join(repo, "a.txt"), "1\n2\n3\n");
    writeFileSync(join(repo, "new.txt"), "새 파일\n");
    const n = porcelainPaths().length;
    // 앱의 변경 목록(DOM)에 새 파일이 보일 때까지: "로컬 변경사항" 행의 개수가 변경 파일 수가 된다
    await js(`await waitFor(() => { const m = $(".local-row")?.textContent.match(/(\\d+)/); return m && Number(m[1]) >= ${n}; }, "로컬 변경사항 개수 ${n}");`);
    const st = await jjOk("load_status");
    eq(st.files.map((f) => f.path).sort(), porcelainPaths(), "앱 status 경로 집합 = git status");
    for (const f of st.files.filter((f) => f.path === "new.txt")) if (!f.untracked && !["?", "A"].includes(f.worktree) && !["?", "A"].includes(f.index)) throw new Error(`새 파일 상태가 ?/A가 아님: ${JSON.stringify(f)}`);
  });

  await step("jj 30f: ⌘⌥Z 한 번 → 확인창(N개 파일) 승인 → snapshot만 취소돼 파일이 되돌아가고 undo operation은 하나만 생긴다, 작업 기록에서 snapshot 시점으로 복구", async () => {
    await prep(true);
    const before = (await opLog()).length;
    await js(`window.__asked = []; document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", metaKey: true, ctrlKey: true, altKey: true, bubbles: true }));`);
    await until(async () => (await asked()).length >= 1, "되돌리기 확인창");
    if (!/변경 \d+개 파일/.test((await asked())[0]) || !(await asked())[0].includes("snapshot working copy")) throw new Error("확인창 문구: " + (await asked())[0]);
    await until(() => readFileSync(join(repo, "a.txt"), "utf8") === "1\n2\n", "a.txt가 되돌아감");
    const log = await opLog();
    eq(log.filter((e) => e.description.startsWith("undo")).length, 1, "undo operation은 한 개");
    if (log.length - before > 2) throw new Error(`키 한 번에 operation이 ${log.length - before}개 늘었다`);
    await js(`window.__asked = [];`);
    await quick("작업 기록");
    await js(`
      const d = await waitFor(() => ${dlgJs("작업 기록")}, "작업 기록 시트");
      const row = await waitFor(() => $$("li", d).find((l) => l.textContent.includes("snapshot working copy")), "snapshot 행");
      press($$("button", row).find((b) => b.textContent.includes("이 시점으로")));
    `);
    await until(() => readFileSync(join(repo, "a.txt"), "utf8") === "1\n2\n3\n", "snapshot 시점으로 복구");
    await esc();
  });

  await step("jj 30f: 우클릭 → prompt로 북마크 만들기, 뒤로 옮기기는 '그래도 옮기기' ask → allowBackwards 재시도, operation 복원 뒤 git rev-parse로 ref가 되돌아가고, 시트에서 삭제하면 git 브랜치도 사라진다", async () => {
    await prep(true);
    // 앞 단계가 커밋을 더 쌓았을 수 있으니 main 끝이 아니라 제목으로 커밋을 찾는다("첫 커밋"은 "두 번째 커밋"의 조상이라 그쪽으로 옮기면 뒤로 옮기기)
    const byTitle = (title) => git("log", "-1", "--format=%H", "--fixed-strings", `--grep=${title}`, "main");
    const head = byTitle("두 번째 커밋");
    const older = byTitle("첫 커밋");
    await rowMenu("두 번째 커밋", "북마크 만들기");
    await bookmarkPrompt("e2e-bm");
    await until(() => rev("refs/heads/e2e-bm") === head, "북마크 = git 브랜치 ref").catch(async (e) => {
      throw new Error(`${e.message} — ref=${rev("refs/heads/e2e-bm").slice(0, 8)} head=${head.slice(0, 8)} asked=${JSON.stringify(await asked())} dialogs=${await js(`return $$("[role=dialog]").map((d) => d.getAttribute("aria-label")).join("|");`)} toasts=${await js(`return $$(".toast").map((t) => t.textContent).join("|");`)} menus=${await js(`return $$("[role=menuitem]").length;`)}`);
    });
    // git ref는 operation을 커밋하기 전에 내보내므로(export → 커밋) ref가 보여도 op log엔 아직 없을 수 있다: op가 보일 때까지 기다린 뒤 그 id를 잡는다
    const opBefore = (await until(async () => { const o = (await opLog())[0]; return o.description.includes("e2e-bm") && o; }, "북마크 만들기 operation")).id;
    // 뒤로 옮기기: 거절 → ask → allowBackwards
    await js(`window.__asked = [];`);
    await rowMenu("첫 커밋", "북마크 만들기");
    await bookmarkPrompt("e2e-bm");
    await until(async () => (await asked()).some((m) => m.includes("뒤쪽이나 다른 가지")), "'그래도 옮기기' 확인창");
    await until(() => rev("refs/heads/e2e-bm") === older, "allowBackwards로 옮김");
    await until(async () => (await opLog())[0].description.includes("point bookmark"), "옮기기 operation");
    // 작업 기록에서 옮기기 전 시점으로 복원 → ref가 되돌아간다
    await js(`window.__asked = [];`);
    await quick("작업 기록");
    const idx = (await opLog()).findIndex((e) => e.id === opBefore);
    await js(`
      const d = await waitFor(() => ${dlgJs("작업 기록")}, "작업 기록 시트");
      const rows = await waitFor(() => { const r = $$('[role=option]', d); return r.length > ${idx} && r; }, "행");
      press($$("button", rows[${idx}]).find((b) => b.textContent.includes("이 시점으로")));
    `);
    await until(() => rev("refs/heads/e2e-bm") === head, "복원 뒤 브랜치 ref가 되돌아감").catch(async (e) => {
      const log = (await opLog()).slice(0, 8).map((o) => `${o.id.slice(0, 8)} ${o.description.slice(0, 40)}`);
      throw new Error(`${e.message} — idx=${idx} head=${head.slice(0, 8)} older=${older.slice(0, 8)} ref=${rev("refs/heads/e2e-bm").slice(0, 8)} opBefore=${opBefore.slice(0, 8)} log=${JSON.stringify(log)} asked=${JSON.stringify(await asked())} toasts=${await js(`return $$(".toast").map((t) => t.textContent).join("|");`)}`);
    });
    await esc();
    // 북마크 시트에서 삭제
    await js(`window.__asked = [];`);
    await quick("북마크");
    await js(`
      const d = await waitFor(() => ${dlgJs("북마크")}, "북마크 시트");
      const row = await waitFor(() => $$("li", d).find((l) => l.textContent.includes("e2e-bm")), "e2e-bm 행");
      press($$("button", row).find((b) => b.textContent.includes("삭제")));
    `);
    await until(() => !rev("refs/heads/e2e-bm"), "북마크 삭제 뒤 git 브랜치 없음");
    await esc();
  });

  await step("jj 30f: untracked 원격 북마크 '추적' → 로컬 생성, Cf 이름 원격 브랜치는 보이는 표기로 표시되고 추적이 jj CLI 안내로 거절되며 op log는 그대로", async () => {
    await prep(true);
    execFileSync("git", ["init", "-q", "--bare", bare]);
    git("remote", "add", "origin", bare);
    git("push", "-q", "origin", "main", "main:refs/heads/rb");
    const head = git("rev-parse", "main");
    execFileSync("git", ["update-ref", "refs/heads/fix‮fdp", head], { cwd: bare });
    git("fetch", "-q", "origin");
    await jjOk("jj_describe", { sha: (await jjOk("jj_status")).workingCopy, message: "e2e import trigger" }); // 준비: 쓰기 작업 = git ref 가져오기
    const bms = await jjOk("jj_bookmarks");
    // (1) 일반 원격 북마크 추적
    if (!bms.some((b) => b.name === "rb")) throw new Error("원격 북마크 rb가 안 보임");
    await quick("북마크");
    await js(`
      const d = await waitFor(() => ${dlgJs("북마크")}, "북마크 시트");
      const row = await waitFor(() => $$("li", d).find((l) => l.textContent.trim().startsWith("rb")), "rb 행");
      const b = $$("button", row).find((x) => x.textContent.trim() === "추적");
      if (!b) throw new Error("rb는 이미 추적 중이라 '추적' 버튼이 없음");
      press(b);
    `);
    await until(() => rev("refs/heads/rb") === head, "추적 → 로컬 북마크(git 브랜치) 생성");
    // (2) Cf 이름: jj가 가져온 경우에만
    const evil = (await jjOk("jj_bookmarks")).find((b) => b.name.includes("‮"));
    if (!evil) { console.warn("(jj가 Cf 이름을 가져오지 않음: 표시·거절 단언 생략)"); await esc(); return; }
    await js(`await waitFor(() => ${dlgJs("북마크")}?.textContent.includes("⟦U+202E⟧"), "Cf가 보이는 표기로 표시");`);
    if (await js(`return ${dlgJs("북마크")}.textContent.includes("‮");`)) throw new Error("원문 Cf 문자가 그대로 렌더됨");
    await until(async () => (await opLog())[0].description.includes("rb"), "rb 추적 operation"); // ref가 보여도 operation 커밋은 조금 뒤일 수 있다
    const logN = (await opLog()).length;
    await js(`
      const d = ${dlgJs("북마크")};
      const row = $$("li", d).find((l) => l.textContent.includes("⟦U+202E⟧"));
      press($$("button", row).find((x) => x.textContent.trim() === "추적"));
    `);
    await until(() => toastHas("jj CLI"), "badNameCli 안내 토스트");
    eq((await opLog()).length, logN, "거절됐으니 op log 불변");
    await esc();
  });

  await step("jj 30f: abandon 확인창에 그 커밋의 북마크 이름이 나오고, 승인하면 git 브랜치도 사라진다", async () => {
    await prep(true);
    if (!rev("refs/heads/side/only")) throw new Error("준비: side/only 브랜치 없음");
    await js(`window.__asked = [];`);
    await rowMenu("숨길 브랜치만의 커밋", "버리기");
    await until(async () => (await asked()).some((m) => m.includes("side/only") && m.includes("삭제됩니다")), "북마크 이름이 든 abandon 확인창");
    await until(() => !git("branch", "--list", "side/only"), "abandon 뒤 git 브랜치 삭제");
  });

  await step("jj 30f: jj 끄기 시트 — 보기만 끄기(.jj 유지) → 삭제 확인(보존 목록·고지) → 확인 뒤 jj가 바뀌면 다시 확인 → 삭제 후 .jj·refs/jj 없음·보존 ref·HEAD 브랜치, 다시 켜면 jj 보기가 기본", async () => {
    await prep(true);
    // (a) 보기만 끄기
    await quick("jj 끄기");
    await js(`
      const d = await waitFor(() => ${dlgJs("jj 끄기")}, "jj 끄기 시트");
      press($$("button", d).find((b) => b.textContent.trim() === "보기만 끄기"));
    `);
    await until(async () => (await jjMarks()) === 0, "git 보기로 전환");
    if (!existsSync(join(repo, ".jj"))) throw new Error("보기만 끄기가 .jj를 지움");
    // (b) 삭제: orphan 하나(설명 있는 변경)를 만들고 확인 화면까지
    await jjOk("jj_describe", { sha: (await jjOk("jj_status")).workingCopy, message: "e2e orphan 변경" });
    await js(`window.__asked = [];`);
    await quick("jj 끄기");
    await js(`
      const d = await waitFor(() => ${dlgJs("jj 끄기")}, "jj 끄기 시트");
      press($$("button", d).find((b) => b.textContent.includes("jj 삭제…")));
      await waitFor(() => $$("button", ${dlgJs("jj 끄기")}).find((b) => b.textContent.trim() === "jj 삭제"), "삭제 확인 화면");
    `);
    const text = await js(`return ${dlgJs("jj 끄기")}.textContent;`);
    for (const need of ["작업 기록(operation log)", "refs/git403/jj-orphans/"]) if (!text.includes(need)) throw new Error(`확인 화면에 '${need}' 없음`);
    // 확인 뒤 jj 상태가 밖에서 바뀌면(jj.disableChanged) 목록을 다시 불러온다
    await jjOk("jj_describe", { sha: (await jjOk("jj_status")).workingCopy, message: "e2e orphan 변경 (밖에서 다시 수정)" });
    await js(`press($$("button", ${dlgJs("jj 끄기")}).find((b) => b.textContent.trim() === "jj 삭제"));`);
    await js(`await waitFor(() => ${dlgJs("jj 끄기")}?.textContent.includes("저장소가 바뀌어 목록을 다시 불러왔습니다"), "disableChanged 안내");`);
    if ((await asked()).length !== 1) throw new Error("첫 시도의 확인창은 1번");
    await js(`press($$("button", ${dlgJs("jj 끄기")}).find((b) => b.textContent.trim() === "jj 삭제"));`);
    await until(() => !existsSync(join(repo, ".jj")), ".jj 삭제");
    eq(git("for-each-ref", "refs/jj/").split("\n").filter(Boolean), [], "refs/jj 없음");
    if (!git("for-each-ref", "refs/git403/jj-orphans/").split("\n").filter(Boolean).length) throw new Error("보존 ref 없음");
    git("symbolic-ref", "-q", "HEAD"); // HEAD가 브랜치에 붙어 있다(없으면 예외)
    if (git("status", "--porcelain").includes(".jj")) throw new Error("git status에 .jj가 보임");
    if ((await asked()).length !== 2) throw new Error("두 번째 승인까지 확인창은 2번");
    await esc(); // 결과 화면 닫기
    // 다시 켜면 jj 보기가 기본(저장돼 있던 git 보기 설정이 지워졌다)
    await quick("jj 모드 켜기");
    await until(async () => (await jjMarks()) > 0, "다시 켠 뒤 기본은 jj 보기");
    eq(await js(`return localStorage.getItem("jj:view:" + ${JSON.stringify(repo)});`), null, "저장된 git 보기 설정 없음");
    rmSync(bare, { recursive: true, force: true });
  });

  await step("앱을 끄면 실행 중이던 작업의 자식 프로세스(손자 포함)도 함께 끝난다", async () => {
    const pidFile = join(home, "child.pid");
    // Windows의 start_shell은 cmd /C라 손자 프로세스를 PowerShell로 띄운다 (cmd가 감싸므로 큰따옴표 없이)
    const command = process.platform === "win32"
      ? `powershell -NoProfile -Command $p = Start-Process -PassThru -NoNewWindow ping -ArgumentList '-n','300','127.0.0.1'; [IO.File]::WriteAllText('${pidFile}', $p.Id); $p.WaitForExit()`
      : `sleep 300 & echo $! > ${pidFile}; wait`;
    await js(`await window.__TAURI_INTERNALS__.invoke("start_shell", { repo: ${JSON.stringify(repo)}, command: ${JSON.stringify(command)} });`);
    let pid = 0;
    for (let i = 0; i < 200 && !pid; i++) {
      pid = Number(existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : 0);
      if (!pid) await new Promise((r) => setTimeout(r, 50));
    }
    if (!pid) throw new Error("자식 pid를 못 얻음");
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    if (!alive()) throw new Error("자식이 처음부터 죽어 있음");
    await nat("@quit").catch(() => {}); // 종료 중이라 응답이 끊길 수 있다
    await exited(app);
    for (let i = 0; i < 100 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
    if (alive()) { process.kill(pid, "SIGKILL"); throw new Error(`앱 종료 뒤에도 자식 ${pid}가 살아 있음`); }
    app = launch([]); // 아래 정리(localStorage 복원)용
  });
} finally {
  if (saved) await js(`localStorage.clear(); for (const [k, v] of Object.entries(${saved})) localStorage.setItem(k, v);`).catch(() => {});
  app.kill();
  await exited(app);
  // Windows는 앱이 끝난 뒤에도 자식 git·백신 검사로 폴더 잠금이 몇 초 남는다. 정리 실패가 결과를 가리지 않게 경고만
  for (const dir of [repo, home]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    } catch (e) {
      console.warn(`임시 폴더 정리 실패(무시): ${dir} — ${e.code}`);
    }
  }
}

finish();
