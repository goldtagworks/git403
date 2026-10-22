// Relay·webviewHtml 단위 테스트 (vscode 불필요): `pnpm test:unit`
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { webviewHtml } from "../src/shared/html.ts";
import { serverPath, uiDir } from "../src/shared/paths.ts";
import { Relay, type ServerEvent } from "../src/services/relay.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fake = (events: ServerEvent[] = []) => new Relay({ command: process.execPath, args: [path.join(here, "fake-server.mjs")], onEvent: (e) => events.push(e) });

test("요청·응답을 id로 짝짓고 err는 reject, 순서가 뒤바뀌어도 맞는다", async () => {
  const r = fake();
  const [slow, fast] = await Promise.all([r.request("slow", { n: 1 }), r.request("echo", { n: 2 })]);
  assert.deepEqual(slow, { cmd: "slow", args: { n: 1 } });
  assert.deepEqual(fast, { cmd: "echo", args: { n: 2 } });
  await assert.rejects(r.request("fail"), /boom/);
  await r.dispose();
});

test("이벤트는 onEvent로 간다", async () => {
  const events: ServerEvent[] = [];
  const r = fake(events);
  await r.request("emit", { a: 1 });
  assert.deepEqual(events, [{ event: "job", payload: { a: 1 } }]);
  await r.dispose();
});

test("서버가 죽으면 대기 요청이 reject되고 다음 요청에서 다시 뜬다", async () => {
  const r = fake();
  await assert.rejects(r.request("crash"), /exited/);
  assert.equal(r.running, false);
  assert.deepEqual(await r.request("echo", 1), { cmd: "echo", args: 1 });
  await r.dispose();
});

test("dispose는 stdin을 닫아 서버를 끝낸다", async () => {
  const r = fake();
  await r.request("echo");
  await r.dispose();
  assert.equal(r.running, false);
  await assert.rejects(r.request("echo")); // 정리된 뒤에는 다시 뜨지 않는다
});

test("웹뷰 HTML: 상대 경로 치환, nonce, CSP", () => {
  const html = `<html><head><script>x()</script><script type="module" src="./assets/a.js"></script><link href="./assets/a.css"><img src="./icon.png"></head></html>`;
  const out = webviewHtml(html, { toUri: (r) => `vsc://${r}`, cspSource: "vsc:", nonce: "N" });
  assert.match(out, /src="vsc:\/\/assets\/a\.js"/);
  assert.match(out, /href="vsc:\/\/assets\/a\.css"/);
  assert.match(out, /src="vsc:\/\/icon\.png"/);
  assert.equal((out.match(/<script nonce="N"/g) ?? []).length, 2);
  assert.match(out, /Content-Security-Policy[^>]*script-src 'nonce-N' vsc:/);
  assert.match(out, /default-src 'none'/);
});

test("웹뷰 HTML: compact는 모드 스크립트를 CSP 뒤에 nonce와 함께 넣고, 아니면 넣지 않는다", () => {
  const html = `<html><head><script type="module" src="./a.js"></script></head></html>`;
  const base = { toUri: (r: string) => r, cspSource: "vsc:", nonce: "N" };
  const on = webviewHtml(html, { ...base, compact: true });
  assert.match(on, /<script nonce="N">window\.__git403 = \{ compact: true \};<\/script>/);
  assert.ok(on.indexOf("__git403") < on.indexOf('src="a.js"'), "UI 스크립트보다 먼저");
  assert.doesNotMatch(webviewHtml(html, base), /__git403/);
  assert.match(webviewHtml(html, { ...base, compact: true, lang: "ko" }), /window\.__git403 = \{ compact: true, lang: "ko" \};/);
  assert.match(webviewHtml(html, { ...base, detail: true }), /window\.__git403 = \{ detail: true \};/);
  assert.match(webviewHtml(html, { ...base, version: "1.2.3" }), /window\.__git403 = \{ version: "1\.2\.3" \};/);
});

// 진짜 서버가 빌드돼 있으면 프로토콜 왕복까지 (cargo build -p gc-backend --bin git403-server)
const real = path.join(here, "..", "..", "target", "debug", process.platform === "win32" ? "git403-server.exe" : "git403-server");
test("실제 git403-server: load_graph", { skip: !existsSync(real) }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "g403-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir });
  git("init", "-q");
  writeFileSync(path.join(dir, "a.txt"), "a");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  const r = new Relay({ command: real, args: ["--config-dir", mkdtempSync(path.join(tmpdir(), "g403c-"))], onEvent: () => {} });
  assert.equal(await r.request("initial_repo"), null);
  const g = (await r.request("load_graph", { repo: dir, limit: 10, hidden: [] })) as { commits: { subject: string }[] };
  assert.equal(g.commits[0].subject, "first");
  await assert.rejects(r.request("nope"), /unknown command/);
  await r.dispose();
});

test("경로 해석: 개발 후보(../target, ../ui/dist)는 dev에서만", () => {
  const root = mkdtempSync(path.join(tmpdir(), "g403-ext-"));
  const ext = path.join(root, "vscode");
  const exe = process.platform === "win32" ? "git403-server.exe" : "git403-server";
  mkdirSync(path.join(ext, "x"), { recursive: true });
  mkdirSync(path.join(root, "target", "debug"), { recursive: true });
  writeFileSync(path.join(root, "target", "debug", exe), "");
  mkdirSync(path.join(root, "ui", "dist"), { recursive: true });
  writeFileSync(path.join(root, "ui", "dist", "index.html"), "");
  assert.equal(serverPath(ext, "", false), null);
  assert.equal(serverPath(ext, "", true), path.join(ext, "..", "target", "debug", exe));
  assert.equal(uiDir(ext, false), null);
  assert.equal(uiDir(ext, true), path.join(ext, "..", "ui", "dist"));
  // 설정 값이 있으면(존재할 때) 우선
  assert.equal(serverPath(ext, path.join(ext, "x"), false), path.join(ext, "x"));
  // 설치본은 확장 폴더 것을, 개발·테스트 모드는 방금 빌드한 ../target을 우선한다(낡은 bin·ui 방지)
  const bundled = path.join(ext, "bin", `${process.platform}-${process.arch}`);
  mkdirSync(bundled, { recursive: true });
  writeFileSync(path.join(bundled, exe), "");
  assert.equal(serverPath(ext, "", false), path.join(bundled, exe));
  assert.equal(serverPath(ext, "", true), path.join(ext, "..", "target", "debug", exe));
});
