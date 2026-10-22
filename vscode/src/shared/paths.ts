// 서버·UI 위치 해석 (vscode 비의존: 단위 테스트 가능).
// 개발 후보(저장소의 target/·ui/dist)는 dev=true(확장 개발·테스트 모드)에서만 쓴다 — 설치본이 엉뚱한 상위 폴더 실행 파일을 띄우지 않게.
import * as fs from "node:fs";
import * as path from "node:path";

/** 같은 폴더들 중 가장 최근에 빌드된 것(없으면 null) */
const newest = (files: string[]) =>
  files
    .filter((f) => fs.existsSync(f))
    .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.m - a.m)[0]?.f ?? null;

/**
 * 서버 실행 파일: 사용자 설정 → (dev) ../target/{debug,release} 중 최근 빌드 → 확장 폴더 bin/<platform>-<arch>.
 * 개발·테스트 모드(dev)에서는 `pnpm package`가 남긴 낡은 bin보다 방금 빌드한 target을 우선한다.
 */
export function serverPath(ext: string, configured: string, dev: boolean): string | null {
  const exe = process.platform === "win32" ? "git403-server.exe" : "git403-server";
  if (configured && fs.existsSync(configured)) return configured;
  const built = dev ? newest([path.join(ext, "..", "target", "debug", exe), path.join(ext, "..", "target", "release", exe)]) : null;
  return built ?? [path.join(ext, "bin", `${process.platform}-${process.arch}`, exe)].find((p) => fs.existsSync(p)) ?? null;
}

/** UI 빌드 폴더: (dev) ../ui/dist(낡은 확장 폴더의 ui보다 우선) → 확장 폴더의 ui */
export function uiDir(ext: string, dev: boolean): string | null {
  const dirs = [...(dev ? [path.join(ext, "..", "ui", "dist")] : []), path.join(ext, "ui")];
  return dirs.find((d) => fs.existsSync(path.join(d, "index.html"))) ?? null;
}
