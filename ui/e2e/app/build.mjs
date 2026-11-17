// e2e:app·e2e:native용 디버그 빌드. `VITE_E2E_APP=1`을 줘서 프런트엔드에 실제 앱 E2E 훅(우클릭 메뉴를 DOM 메뉴로 띄우는 `window.__e2eDomMenu`)을 켠다.
// 일반 `pnpm build`·릴리스 빌드에는 이 값이 없어 훅 코드가 번들에서 사라진다(docs/security.md). tauri build의 beforeBuildCommand(`pnpm --dir ui build`)가 환경 변수를 이어받는다.
import { spawnSync } from "node:child_process";
const r = spawnSync("pnpm", ["--dir", "..", "tauri", "build", "--debug", "--no-bundle"], { stdio: "inherit", shell: true, env: { ...process.env, VITE_E2E_APP: "1" } });
process.exit(r.status ?? 1);
