// esbuild 번들: out/extension.js (확장), out/test.js·out/test-multi.js·out/test-shots.js (@vscode/test-electron 스위트: 단일 저장소·멀티루트·화면 확인)
import { build } from "esbuild";

const common = { bundle: true, platform: "node", format: "cjs", target: "node20", external: ["vscode"], sourcemap: false, logLevel: "info" };
await build({ ...common, entryPoints: ["src/extension.ts"], outfile: "out/extension.js", minify: true });
await build({ ...common, entryPoints: ["test/suite.ts"], outfile: "out/test.js" });
await build({ ...common, entryPoints: ["test/multi.ts"], outfile: "out/test-multi.js" });
await build({ ...common, entryPoints: ["test/shots.ts"], outfile: "out/test-shots.js" });
