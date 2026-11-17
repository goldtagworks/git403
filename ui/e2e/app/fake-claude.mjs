// 실제 앱 E2E용 가짜 `claude`: stream-json을 내보내며 **진짜 git 명령**을 저장소(cwd)에서 실행한다 (충돌 있는 pull → 해결 → 커밋).
// 받은 인자·cwd는 FAKE_CLAUDE_LOG 파일에 JSON으로 남긴다.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 앱의 설치 감지(`claude --version`, 빈 임시 폴더에서 수시로 실행)에는 버전만 답한다 — 아래 대본을 돌리면 로그 파일을 덮어쓰고 엉뚱한 곳에서 git을 실행한다
if (process.argv[2] === "--version") {
  console.log("0.0.0 (fake)");
  process.exit(0);
}
const out = (o) => console.log(JSON.stringify(o));
if (process.env.FAKE_CLAUDE_LOG) writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
const git = (...a) => {
  try {
    return [0, execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })];
  } catch (e) {
    return [e.status ?? 1, `${e.stdout ?? ""}${e.stderr ?? ""}`];
  }
};
let n = 0;
const text = (t) => out({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
const tool = (name, command, run) => {
  const id = `tu${++n}`;
  out({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input: name === "Bash" ? { command } : { file_path: command } }] } });
  const [code, output] = run();
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: output, is_error: code !== 0 }] } });
};

out({ type: "system", subtype: "init", session_id: "fake-sess" });
// 시험이 `<로그>.hold`를 만들어 두면 저장소를 건드리지 않고 그 파일이 지워질 때까지 차례를 붙잡아 둔다(AI 차례 중 쓰기 거절 시험)
const holdFile = process.env.FAKE_CLAUDE_LOG ? `${process.env.FAKE_CLAUDE_LOG}.hold` : "";
if (holdFile && existsSync(holdFile)) {
  text("대기 중입니다.");
  for (let i = 0; i < 600 && existsSync(holdFile); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  text("끝났습니다.");
  out({ type: "result", subtype: "success", is_error: false, result: "끝났습니다.", session_id: "fake-sess" });
  process.exit(0);
}
text("원격 변경을 병합합니다.");
// 시험이 `<로그>.pull`에 원격 경로를 두면 그 경로로 직접 pull한다(AI 차례는 로컬 경로 원격을 거절하므로 원격 설정 없이 실행한다)
const pullFile = process.env.FAKE_CLAUDE_LOG ? `${process.env.FAKE_CLAUDE_LOG}.pull` : "";
const pullUrl = pullFile && existsSync(pullFile) ? readFileSync(pullFile, "utf8").trim() : null;
tool("Bash", `git pull --no-rebase --no-edit${pullUrl ? " " + pullUrl + " main" : ""}`, () => git("pull", "--no-rebase", "--no-edit", ...(pullUrl ? [pullUrl, "main"] : [])));
const f = join(process.cwd(), "a.txt");
tool("Read", f, () => [0, readFileSync(f, "utf8")]);
writeFileSync(f, "합친 결과\n");
tool("Edit", f, () => [0, "resolved"]);
tool("Bash", "git add a.txt", () => git("add", "a.txt"));
tool("Bash", "git commit --no-edit", () => git("commit", "--no-edit"));
text("충돌을 해결했습니다.");
out({ type: "result", subtype: "success", is_error: false, result: "충돌을 해결했습니다.", session_id: "fake-sess" });
