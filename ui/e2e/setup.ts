import { rmSync } from "node:fs";

// 실행마다 화면 캡처 폴더를 비운다: 이름이 바뀌었거나 없어진 테스트의 옛 캡처가 남지 않게.
// 캡처 이름 규칙은 `e2e/results/screens/<화면>-<light|dark>.png` 하나 (VS Code 테마는 vscode-light|vscode-dark).
export default function setup() {
  rmSync("e2e/results/screens", { recursive: true, force: true });
}
