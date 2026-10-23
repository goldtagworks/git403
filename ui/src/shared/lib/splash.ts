// 시작 스플래시. 앱에서는 별도 스플래시 창(public/splash.html)을 띄우고 메인 창은 숨긴 채 로드하다가,
// 첫 로드가 끝나면 메인 창을 보여 주고 스플래시 창을 닫는다. 브라우저(데모)에서는 index.html의 #splash를 페이드아웃한다.
// 시작을 늦추지 않으려고 최소 노출은 MIN_MS(페이지가 뜬 시점부터)까지만 채운다.
import { Window, getCurrentWindow } from "@tauri-apps/api/window";
import { IS_VSCODE } from "../api/bridge";

const MIN_MS = 250;
const el = document.getElementById("splash");
const app = !IS_VSCODE && "__TAURI_INTERNALS__" in window; // VS Code 확장은 창이 하나라 기존처럼 #splash를 쓴다

// 데모·E2E(VITE_MOCK)는 스크린샷이 흔들리지 않게 바로 없앤다. 스플래시 테스트만 window.__splash로 켠다.
if (import.meta.env.VITE_MOCK && !(window as any).__splash) el?.remove();
if (app) el?.remove(); // 앱에서는 메인 창이 로드가 끝난 뒤에 보이므로 창 안 스플래시가 필요 없다

let done = false;
export function hideSplash() {
  if (done) return;
  done = true;
  if (app) {
    const w = getCurrentWindow();
    void w.show().then(() => w.setFocus()).finally(() => Window.getByLabel("splash").then((s) => s?.destroy()));
    return;
  }
  if (!el) return;
  setTimeout(() => {
    el.classList.add("done");
    setTimeout(() => el.remove(), 200);
  }, Math.max(0, MIN_MS - performance.now()));
}
setTimeout(hideSplash, 3000); // 첫 로드가 오래 걸려도 화면을 가리고 있지 않는다
