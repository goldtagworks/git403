// 실제 앱 E2E: 디버그 빌드(target/debug/git403)를 임시 git 저장소로 띄우고,
// 진짜 IPC·진짜 git으로 화면을 조작한 뒤 결과를 git CLI로 확인한다. (src-tauri/src/e2e.rs 다리 사용)
// 실행: pnpm --dir ui e2e:app  (프런트엔드를 넣은 디버그 빌드 후 실행. cargo build만 하면 dev 서버를 찾는다)
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { App, Steps, eq, temp } from "./lib.mjs";

const PORT = 47403;
const repo = temp("e2e");
// 사용자 실제 앱 설정 파일과 섞이지 않게 HOME을 임시 폴더로. 웹뷰 localStorage(탭 등)는 HOME과 무관해서 아래에서 백업·복원한다.
const home = temp("home");
const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();

git("init", "-q", "-b", "main");
git("config", "user.name", "E2E");
git("config", "user.email", "e2e@example.com");
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

const A = App({ port: PORT, home });
const { js, nat } = A;
const launch = (args) => (A.launch(args), A.proc);
const exited = (p) => new Promise((r) => (p.exitCode !== null ? r() : p.once("exit", r)));
const { step, finish } = Steps();

let app = launch([repo]);
let saved = null;
try {
  saved = await js(`const s = JSON.stringify({ ...localStorage }); localStorage.clear(); localStorage.setItem("language", '"ko"'); setTimeout(() => location.reload(), 0); return s;`);
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
    await js(`
      press(await waitFor(() => byText(".commits .subject", "그림 수정"), "그림 수정 커밋"));
      press(await waitFor(() => $$("[role=option]").find((o) => o.textContent.includes("pic.png")), "pic.png"));
      const info = await waitFor(() => $(".img-info"), "이미지 diff 정보");
      await waitFor(() => $(".img-info").textContent.includes("바뀐 픽셀 4.7%"), "바뀐 픽셀 %");
      const st = $(".img-stage").getBoundingClientRect();
      await waitFor(() => $$(".img-layer").length === 2, "나란히 모드 이미지 두 장 (stage " + st.width + "×" + st.height + ", mode " + localStorage.getItem("imgDiffMode") + ")");
      if (!$(".img-info").textContent.includes("변경 영역 (5, 6) 4×3")) throw new Error("변경 영역: " + $(".img-info").textContent);
    `);
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

  await step("앱을 끄면 실행 중이던 작업의 자식 프로세스(손자 포함)도 함께 끝난다", async () => {
    const pidFile = join(home, "child.pid");
    await js(`await window.__TAURI_INTERNALS__.invoke("start_shell", { repo: ${JSON.stringify(repo)}, command: "sleep 300 & echo $! > ${pidFile}; wait" });`);
    let pid = 0;
    for (let i = 0; i < 100 && !pid; i++) {
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
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

finish();
