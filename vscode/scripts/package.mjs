// VSIX 패키징: ui 빌드 + 서버 빌드 → 확장 폴더에 복사 → `vsce package --target <플랫폼>` (기본은 현재 플랫폼용 VSIX).
// 사용: node scripts/package.mjs [--debug] [--target <darwin-arm64|darwin-x64|win32-x64|linux-x64>] [--skip-build]
//  --debug       debug 서버(기본은 release)
//  --target      vsce 대상 이름. 서버는 이 플랫폼에서 빌드한 것이어야 하므로 CI는 플랫폼마다 그 러너에서 돌린다
//  --skip-build  ui·서버를 이미 빌드했을 때(CI가 앞 단계에서 빌드) 다시 빌드하지 않는다
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.join(root, "..");
const profile = process.argv.includes("--debug") ? "debug" : "release";
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const target = process.argv.includes("--target") ? arg("--target") : `${process.platform}-${process.arch}`; // vsce 대상 이름과 같다 (darwin-arm64, win32-x64, linux-x64 …)
if (target !== `${process.platform}-${process.arch}`) throw new Error(`서버를 이 플랫폼(${process.platform}-${process.arch})에서만 빌드할 수 있어 --target ${target}은 만들 수 없다. 그 플랫폼 러너에서 돌려라`);
const exe = process.platform === "win32" ? "git403-server.exe" : "git403-server";
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

if (!process.argv.includes("--skip-build")) {
  run("pnpm", ["--dir", "ui", "build"], repo);
  run("cargo", ["build", ...(profile === "release" ? ["--release"] : []), "-p", "gc-backend", "--bin", "git403-server"], repo);
}

rmSync(path.join(root, "ui"), { recursive: true, force: true });
rmSync(path.join(root, "bin"), { recursive: true, force: true });
cpSync(path.join(repo, "ui", "dist"), path.join(root, "ui"), { recursive: true });
mkdirSync(path.join(root, "bin", target), { recursive: true });
const bin = path.join(root, "bin", target, exe);
cpSync(path.join(repo, "target", profile, exe), bin);
chmodSync(bin, 0o755);

run("node", ["scripts/build.mjs"], root);
const vsix = `git403-${target}.vsix`;
run("pnpm", ["exec", "vsce", "package", "--no-dependencies", "--allow-missing-repository", "--skip-license", "--target", target, "--out", vsix], root);
console.log(`VSIX: ${path.join(root, vsix)}`);
