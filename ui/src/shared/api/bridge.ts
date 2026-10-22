// 호스트(Tauri 앱 / VS Code 웹뷰) 차이는 이 파일에만 둔다. @tauri-apps 직접 import는 여기와 mock.ts, menu.tsx(네이티브 메뉴)뿐.
// VS Code 모드(`acquireVsCodeApi`가 있을 때): 확장과 postMessage로 통신한다 (프로토콜: docs/reuse.md "VS Code 확장").
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask as tauriAsk, open as tauriOpen, save as tauriSave } from "@tauri-apps/plugin-dialog";
import { openUrl as tauriOpenUrl } from "@tauri-apps/plugin-opener";
import { relaunch as tauriRelaunch } from "@tauri-apps/plugin-process";
import { check as tauriCheck } from "@tauri-apps/plugin-updater";
import { tErr } from "../i18n/i18n";

declare function acquireVsCodeApi(): { postMessage(m: unknown): void };

export const IS_VSCODE = typeof acquireVsCodeApi === "function";
/** 좁은 커밋 목록 모드: 확장이 사이드바·아래 패널 뷰의 html에 `window.__git403 = {compact: true}`를 넣어 알린다. 판단은 여기 한 곳 (모듈 상수라 렌더링에 영향 없음) */
export const COMPACT = IS_VSCODE && !!(window as unknown as { __git403?: { compact?: boolean } }).__git403?.compact;

type OpenOpts = Parameters<typeof tauriOpen>[0];
type SaveOpts = Parameters<typeof tauriSave>[0];
type AskOpts = Parameters<typeof tauriAsk>[1];

// ---- VS Code 모드: 요청·응답은 id로 짝짓고, 이벤트는 이름별 핸들러로 나눈다 ----
const vscode = IS_VSCODE ? acquireVsCodeApi() : null;
let seq = 0;
const pending = new Map<number, { ok: (v: any) => void; err: (e: string) => void }>();
const handlers = new Map<string, Set<(e: { payload: any }) => void>>();

if (IS_VSCODE) {
  window.addEventListener("message", ({ data: m }) => {
    if (m?.type === "result") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if ("err" in m) p.err(m.err);
      else p.ok(m.ok);
    } else if (m?.type === "event") handlers.get(m.event)?.forEach((h) => h({ payload: m.payload }));
    else if (m?.type === "simulate") simulate(m);
    else if (m?.type === "select" && typeof m.sha === "string") selectHandler ? selectHandler(m.sha) : (queuedSelect = m.sha);
    else if (m?.type === "openRepo" && typeof m.repo === "string") repoHandler ? repoHandler(m.repo) : (queuedRepo = m.repo);
  });
  vscode!.postMessage({ type: "ready" }); // 확장이 패널 준비 전에 보낼 메시지(select)를 이때부터 전달한다
}

/*
 * 단축키: VS Code 웹뷰 안쪽 preload는 window의 keydown(버블)을 듣고 defaultPrevented와 상관없이 워크벤치로 전달한다(⌘P·⌘, 등이 VS Code에서도 실행됨).
 * 앱이 처리한(preventDefault) 키는 그 전에 전파를 끊어야 하므로, 앱의 window keydown 리스너를 document로 옮겨(경로상 window보다 먼저) 처리했으면 stopPropagation 한다.
 * React 핸들러(루트 컨테이너)가 처리한 키는 document 맨 앞 리스너가 같은 방식으로 막는다. 처리하지 않은 키(⌘⇧P 등)는 그대로 VS Code로 간다.
 */
if (IS_VSCODE) {
  const claim = (e: Event) => e.defaultPrevented && e.stopPropagation();
  document.addEventListener("keydown", claim);
  const wrapped = new WeakMap<object, EventListener>();
  const add = window.addEventListener.bind(window) as typeof window.addEventListener;
  const remove = window.removeEventListener.bind(window) as typeof window.removeEventListener;
  const wrap = (fn: any): EventListener => {
    let w = wrapped.get(fn);
    if (!w) wrapped.set(fn, (w = (e) => (typeof fn === "function" ? fn(e) : fn.handleEvent(e), claim(e))));
    return w;
  };
  window.addEventListener = ((type: string, fn: any, o?: any) => (type === "keydown" && fn ? document.addEventListener(type, wrap(fn), o) : add(type, fn, o))) as typeof add;
  window.removeEventListener = ((type: string, fn: any, o?: any) => (type === "keydown" && fn ? document.removeEventListener(type, wrap(fn), o) : remove(type, fn, o))) as typeof remove;
}

/**
 * 테스트 훅(확장의 테스트 모드 명령 `git403.debugSimulate`만 보낸다): selector에 맞는(선택적으로 텍스트를 포함하는) 요소에
 * 실제 DOM 이벤트를 일으켜 UI가 평소 경로로 확장에 메시지를 보내게 한다. 요소를 찾았는지 `simulated`로 답한다.
 */
async function simulate(m: { selector?: string; text?: string; events?: string[]; after?: string }) {
  const el = [...(m.selector ? document.querySelectorAll<HTMLElement>(m.selector) : [])].find((e) => !m.text || e.textContent?.includes(m.text));
  for (const type of el ? (m.events ?? []) : []) el!.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, detail: type === "dblclick" ? 2 : 1 }));
  // after: 이벤트 뒤에 이 selector가 나타나야 found(메뉴·팝업이 실제로 열렸는지)
  let ok = !!el;
  for (let i = 0; ok && m.after && !document.querySelector(m.after) && i < 20; i++) await new Promise((r) => setTimeout(r, 50));
  if (m.after && !document.querySelector(m.after)) ok = false;
  vscode?.postMessage({ type: "simulated", found: ok });
}

// 확장 → 웹뷰 "커밋 선택": 받을 화면이 아직 없으면 하나만 쌓아 두었다가 등록 때 전달한다
let selectHandler: ((sha: string) => void) | null = null;
let queuedSelect: string | null = null;
export const onSelect = (h: (sha: string) => void) => {
  selectHandler = h;
  if (queuedSelect) {
    const s = queuedSelect;
    queuedSelect = null;
    h(s);
  }
  return () => void (selectHandler === h && (selectHandler = null));
};
// 확장 → 웹뷰 "저장소 전환": 열린 패널을 다시 만들지 않고 UI의 저장소 열기(탭) 경로로 바꾼다. 받을 화면이 없으면 하나만 쌓는다
let repoHandler: ((repo: string) => void) | null = null;
let queuedRepo: string | null = null;
export const onOpenRepo = (h: (repo: string) => void) => {
  repoHandler = h;
  if (queuedRepo) {
    const r = queuedRepo;
    queuedRepo = null;
    h(r);
  }
  return () => void (repoHandler === h && (repoHandler = null));
};
/** VS Code 확장 버전(확장이 html에 넣는다). Tauri 앱에서는 undefined */
export const EXT_VERSION = IS_VSCODE ? (window as unknown as { __git403?: { version?: string } }).__git403?.version : undefined;
/** 웹뷰 → 확장: 선택을 끝냈다고 알린다(확장이 상태·테스트에 쓴다) */
export const reportSelected = (sha: string) => vscode?.postMessage({ type: "selected", sha });
/** 웹뷰 → 확장: 파일을 VS Code 편집기로 연다(sha 있으면 그 커밋의 diff, 없으면 작업 파일 diff; line은 새 파일 기준 줄 번호(1부터)로 diff 에디터가 그 줄로 이동). Tauri 앱에서는 아무 일도 안 한다 */
export const openFile = (repo: string, path: string, sha?: string, line?: number) => vscode?.postMessage({ type: "openFile", repo, path, sha, line });

/** 커밋 상세 탭 모드: 확장이 편집기 영역의 "커밋 상세" 웹뷰 html에 `window.__git403 = {detail: true}`를 넣는다. 그래프·사이드바·툴바 없이 상세 + diff만 보인다(커밋은 `select`·`openRepo` 메시지로 정해진다) */
export const DETAIL = IS_VSCODE && !!(window as unknown as { __git403?: { detail?: boolean } }).__git403?.detail;
/** 웹뷰 → 확장(compact): 커밋 클릭 = 편집기 영역의 커밋 상세 탭(하나를 재사용)에 보이기(sha가 WORKTREE면 소스 제어 뷰) */
export const openCommit = (repo: string, sha: string) => vscode?.postMessage({ type: "commitClick", repo, sha });
/** 웹뷰 → 확장(compact): 편집기 탭에 전체 앱을 연다. sha가 있으면 그 커밋을 선택해서 */
export const openFull = (sha?: string) => vscode?.postMessage({ type: "openFull", sha });

const request = <T>(msg: Record<string, unknown>) =>
  new Promise<T>((ok, err) => {
    const id = ++seq;
    pending.set(id, { ok, err: (e) => err(e) });
    vscode!.postMessage({ ...msg, id });
  });

/**
 * IPC 오류 한 곳 번역: Rust가 코드 오류를 `{"code","vars","message"}` JSON 문자열로 주면 `err.<code>`로 번역한 메시지의 `CodedError`로 바꾼다
 * (사전에 키가 없으면 영어 message). `String(e)`·`e.message`는 번역문, 판별은 `e.code`. 코드 없는 오류(git stderr 등)는 원문 그대로 둔다.
 */
export class CodedError extends Error {
  constructor(message: string, readonly code: string, readonly vars: Record<string, string>) {
    super(message);
  }
  toString() {
    return this.message;
  }
}
export const errCode = (e: unknown) => (e instanceof CodedError ? e.code : undefined);
const toError = (e: unknown) => {
  if (typeof e !== "string" || e[0] !== "{") return e;
  try {
    const j = JSON.parse(e) as { code?: unknown; vars?: Record<string, string>; message?: unknown };
    if (typeof j.code !== "string") return e;
    return new CodedError(tErr(j.code, j.vars, String(j.message ?? j.code)), j.code, j.vars ?? {});
  } catch {
    return e;
  }
};
export const invoke = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  (vscode ? request<T>({ type: "invoke", cmd, args }) : tauriInvoke<T>(cmd, args)).catch((e) => Promise.reject(toError(e)));

// 작업 완료 이벤트(`job-done`·`detached-done`: [id, err])의 err도 코드 JSON일 수 있다 — 같은 번역을 거친다(코드 없으면 원문)
const ERR_EVENTS = new Set(["job-done", "detached-done"]);
const evErr = (e: unknown) => (typeof e === "string" ? String(toError(e)) : e);
export const listen = <T>(event: string, handler0: (e: { payload: T }) => void): Promise<() => void> => {
  const handler = ERR_EVENTS.has(event) ? ({ payload }: { payload: T }) => handler0({ payload: (Array.isArray(payload) ? [payload[0], evErr(payload[1])] : payload) as T }) : handler0;
  if (!vscode) return tauriListen<T>(event, handler);
  let set = handlers.get(event);
  if (!set) handlers.set(event, (set = new Set()));
  set.add(handler as any);
  return Promise.resolve(() => void set!.delete(handler as any));
};

export const pickOpen = (options: OpenOpts) => (vscode ? request<string | null>({ type: "dialog", kind: "open", options }) : (tauriOpen(options) as Promise<string | null>));
export const pickSave = (options: SaveOpts) => (vscode ? request<string | null>({ type: "dialog", kind: "save", options }) : (tauriSave(options) as Promise<string | null>));
export const ask = (message: string, options: AskOpts) => (vscode ? request<boolean>({ type: "dialog", kind: "ask", message, options }) : tauriAsk(message, options));
export const openUrl = (url: string) => (vscode ? request<void>({ type: "openUrl", url }) : tauriOpenUrl(url));
/** VS Code 확장은 마켓플레이스가 업데이트하므로 항상 null(새 버전 없음), 재시작은 하지 않는다 */
export const checkUpdate = () => (vscode ? Promise.resolve(null) : tauriCheck());
/** 창 숨기기(macOS ⌘W·빨간 버튼: 앱은 Dock에 남는다). VS Code에는 창이 없다 */
export const hideWindow = () => (vscode ? Promise.resolve() : getCurrentWindow().hide());
export const relaunch = () => (vscode ? Promise.resolve() : tauriRelaunch());

/** VS Code 웹뷰에서 앱 창이 없다. 있을 때만(Tauri) 창 API를 쓴다 */
export const setWindowTheme = async (theme: "light" | "dark" | null) => {
  if (vscode) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setTheme(theme);
};
