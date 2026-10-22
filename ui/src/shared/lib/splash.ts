// 시작 스플래시(index.html의 #splash). 첫 로드가 끝나면 짧게 페이드아웃한다.
// 시작을 늦추지 않으려고 최소 노출은 MIN_MS(페이지가 뜬 시점부터)까지만 채운다.
const MIN_MS = 250;
const el = document.getElementById("splash");

// 데모·E2E(VITE_MOCK)는 스크린샷이 흔들리지 않게 바로 없앤다. 스플래시 테스트만 window.__splash로 켠다.
if (import.meta.env.VITE_MOCK && !(window as any).__splash) el?.remove();

let done = false;
export function hideSplash() {
  if (done || !el) return;
  done = true;
  setTimeout(() => {
    el.classList.add("done");
    setTimeout(() => el.remove(), 200);
  }, Math.max(0, MIN_MS - performance.now()));
}
setTimeout(hideSplash, 3000); // 첫 로드가 오래 걸려도 화면을 가리고 있지 않는다
