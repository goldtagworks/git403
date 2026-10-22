// 실제 앱 E2E 공통 도우미 (run.mjs·native.mjs). 디버그 빌드를 띄우고 src-tauri/src/e2e.rs 다리로 웹뷰 JS를 실행한다.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const BIN = resolve(import.meta.dirname, "../../../target/debug/git403");
export const SHOT = join(import.meta.dirname, "../results/app-fail.png"); // 실패 화면은 e2e/results에
mkdirSync(join(import.meta.dirname, "../results"), { recursive: true });
export const temp = (name) => mkdtempSync(join(tmpdir(), `git403-${name}-`));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const gitIn = (cwd) => (...a) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

// 웹뷰 안에서 쓰는 도우미 (매 요청 앞에 붙는다)
const PRELUDE = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, what, ms = 10000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("기다림 실패: " + what); await sleep(50); } };
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const byText = (s, text) => $$(s).find((e) => e.textContent.includes(text));
const fill = (el, v) => { const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set; set.call(el, v); el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true })); };
const press = (el) => { for (const t of ["mousedown", "mouseup", "click"]) el.dispatchEvent(new MouseEvent(t, { bubbles: true, button: 0 })); };
const dbl = (el) => el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
const rightClick = (el) => { const b = el.getBoundingClientRect(); setTimeout(() => el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: b.x + 5, clientY: b.y + 5 })), 0); };
`;

/** 앱 하나: 띄우기, 웹뷰 JS 실행(js), 웹뷰 밖 동작(nat: @move·@frame·@quit) */
export function App({ port, home, env = {} }) {
  const app = {
    proc: null,
    launch(args) {
      this.proc = spawn(BIN, args, { env: { ...process.env, HOME: home, GIT403_E2E_PORT: String(port), ...env }, stdio: process.env.E2E_LOG ? "inherit" : "ignore" });
    },
    exited: () => new Promise((r) => (app.proc.exitCode !== null ? r() : app.proc.once("exit", r))),
    async js(body, raw = false) {
      for (let i = 0; ; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}`, { method: "POST", body: raw ? body : PRELUDE + body });
          const r = await res.json();
          if (!r.ok) throw new Error(r.value);
          return r.value;
        } catch (e) {
          if (!String(e).includes("fetch failed") || i > 100) throw e;
          await sleep(200); // 앱이 뜨는 중
        }
      }
    },
    nat: (cmd) => app.js(cmd, true),
    async quit() {
      await app.nat("@quit").catch(() => {}); // 종료 중이라 응답이 끊길 수 있다
      await app.exited();
    },
  };
  return app;
}

/** 단계 기록. 실패하면 화면을 찍고 다음 단계로 넘어간다 */
export function Steps() {
  const results = [];
  return {
    async step(name, fn) {
      try {
        await fn();
        results.push(["✓", name]);
      } catch (e) {
        try { execFileSync("screencapture", ["-x", SHOT]); } catch {}
        results.push(["✗", name, `${e.message ?? e} (화면: ${SHOT})`]);
      }
    },
    finish() {
      for (const r of results) console.log(r.join("  "));
      const failed = results.filter((r) => r[0] === "✗").length;
      console.log(`\n${results.length - failed} passed, ${failed} failed`);
      process.exit(failed ? 1 : 0);
    },
  };
}

export const eq = (a, b, what) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); }; // 배열도 값으로 비교
/** 조건이 참이 될 때까지 기다린다 (테스트 쪽 파일·git 상태용) */
export async function until(fn, what, ms = 10000) {
  const t = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t > ms) throw new Error("기다림 실패: " + what);
    await sleep(100);
  }
}
