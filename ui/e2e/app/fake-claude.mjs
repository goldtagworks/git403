// 실제 앱 E2E용 가짜 `claude`: stream-json을 내보내며 **진짜 git 명령**을 저장소(cwd)에서 실행한다 (충돌 있는 pull → 해결 → 커밋).
// 받은 인자·cwd는 FAKE_CLAUDE_LOG 파일에 JSON으로 남긴다.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
text("원격 변경을 병합합니다.");
tool("Bash", "git pull --no-rebase --no-edit", () => git("pull", "--no-rebase", "--no-edit"));
const f = join(process.cwd(), "a.txt");
tool("Read", f, () => [0, readFileSync(f, "utf8")]);
writeFileSync(f, "합친 결과\n");
tool("Edit", f, () => [0, "resolved"]);
tool("Bash", "git add a.txt", () => git("add", "a.txt"));
tool("Bash", "git commit --no-edit", () => git("commit", "--no-edit"));
text("충돌을 해결했습니다.");
out({ type: "result", subtype: "success", is_error: false, result: "충돌을 해결했습니다.", session_id: "fake-sess" });
