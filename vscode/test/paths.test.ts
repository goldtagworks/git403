// 서버·UI 위치 해석 단위 테스트 (vscode 불필요): `pnpm test:unit`
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { serverPath, uiDir } from "../src/shared/paths.ts";

const exe = process.platform === "win32" ? "git403-server.exe" : "git403-server";
const touch = (p: string, ageSec = 0) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "x");
  const t = new Date(Date.now() - ageSec * 1000);
  fs.utimesSync(p, t, t);
};

test("개발·테스트 모드는 낡은 확장 폴더 bin·ui보다 ../target·../ui/dist를 우선한다", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git403-paths-"));
  const ext = path.join(root, "vscode");
  touch(path.join(ext, "bin", `${process.platform}-${process.arch}`, exe));
  touch(path.join(ext, "ui", "index.html"));
  touch(path.join(root, "ui", "dist", "index.html"));
  touch(path.join(root, "target", "debug", exe), 100);
  touch(path.join(root, "target", "release", exe), 10); // 더 최근
  assert.equal(serverPath(ext, "", true), path.join(root, "target", "release", exe), "target 중 최근 빌드");
  assert.equal(uiDir(ext, true), path.join(root, "ui", "dist"));
  // 설치본(production): 개발 후보를 보지 않는다
  assert.equal(serverPath(ext, "", false), path.join(ext, "bin", `${process.platform}-${process.arch}`, exe));
  assert.equal(uiDir(ext, false), path.join(ext, "ui"));
  // 사용자 설정이 있으면 최우선, 없는 경로면 무시
  const mine = path.join(root, "mine", exe);
  touch(mine);
  assert.equal(serverPath(ext, mine, true), mine);
  assert.equal(serverPath(ext, path.join(root, "nope"), false), path.join(ext, "bin", `${process.platform}-${process.arch}`, exe));
});

test("target·ui/dist가 없으면 개발 모드도 확장 폴더로 돌아간다", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git403-paths-"));
  const ext = path.join(root, "vscode");
  touch(path.join(ext, "ui", "index.html"));
  assert.equal(uiDir(ext, true), path.join(ext, "ui"));
  assert.equal(serverPath(ext, "", true), null);
});
