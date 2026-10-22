// 테스트용 가짜 git403-server: 같은 줄 JSON 프로토콜을 흉내 낸다.
import readline from "node:readline";

const out = (v) => process.stdout.write(JSON.stringify(v) + "\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const { id, cmd, args } = JSON.parse(line);
  if (cmd === "fail") return out({ id, err: "boom" });
  if (cmd === "crash") process.exit(3);
  if (cmd === "emit") out({ event: "job", payload: args });
  // 늦게 온 요청이 먼저 답하도록: slow는 50ms 뒤
  setTimeout(() => out({ id, ok: { cmd, args } }), cmd === "slow" ? 50 : 0);
});
rl.on("close", () => process.exit(0));
