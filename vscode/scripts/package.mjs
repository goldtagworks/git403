// VSIX 패키징: ui 빌드 + 서버 빌드 → 확장 폴더에 복사 → `vsce package --target <플랫폼>` (기본은 현재 플랫폼용 VSIX).
// 사용: node scripts/package.mjs [--debug] [--target <darwin-arm64|darwin-x64|win32-x64|linux-x64>] [--skip-build]
//  --debug       debug 서버(기본은 release)
//  --target      vsce 대상 이름. 서버는 그 플랫폼에서 빌드한다(Mac은 arm64·x64 서로 교차 빌드 가능, 그 밖은 그 러너에서)
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
// Mac끼리는 Rust 타깃만 바꿔 교차 빌드한다 (결과는 target/<triple>/<profile>)
const MAC = { "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin" };
const cross = target !== `${process.platform}-${process.arch}` ? (process.platform === "darwin" ? MAC[target] : undefined) : null;
if (cross === undefined) throw new Error(`서버를 이 플랫폼(${process.platform}-${process.arch})에서 ${target}용으로 빌드할 수 없다. 그 플랫폼 러너에서 돌려라`);
const exe = process.platform === "win32" ? "git403-server.exe" : "git403-server";
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

if (!process.argv.includes("--skip-build")) {
  run("pnpm", ["--dir", "ui", "build"], repo);
  if (cross) run("rustup", ["target", "add", cross], repo);
  run("cargo", ["build", ...(profile === "release" ? ["--release"] : []), ...(cross ? ["--target", cross] : []), "-p", "gc-backend", "--bin", "git403-server"], repo);
}

rmSync(path.join(root, "ui"), { recursive: true, force: true });
rmSync(path.join(root, "bin"), { recursive: true, force: true });
cpSync(path.join(repo, "ui", "dist"), path.join(root, "ui"), { recursive: true });
mkdirSync(path.join(root, "bin", target), { recursive: true });
const bin = path.join(root, "bin", target, exe);
cpSync(path.join(repo, "target", ...(cross ? [cross] : []), profile, exe), bin);
chmodSync(bin, 0o755);

run("node", ["scripts/build.mjs"], root);
const vsix = `git403-${target}.vsix`;
run("pnpm", ["exec", "vsce", "package", "--no-dependencies", "--allow-missing-repository", "--skip-license", "--target", target, "--out", vsix], root);
console.log(`VSIX: ${path.join(root, vsix)}`);
