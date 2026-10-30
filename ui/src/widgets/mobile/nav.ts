import { useSyncExternalStore } from "react";
import { isMobile } from "../../shared/lib/platform";

// 모바일 스택 내비게이션. 화면 깊이를 `history.state`에 두어 Android 뒤로 버튼·제스처(popstate)가 한 단계씩 뒤로 간다.
// 깊이: 0 저장소 목록 · 1 커밋 목록 · 2 커밋 상세(폰) · 3 파일 diff. `sheet` = 브랜치 시트(서랍)가 열려 있음(같은 깊이의 기록 한 칸).
// React 상태가 아니라 외부 스토어라서, 깊이가 바뀌어도 MobileShell만 다시 그린다(그래프·사이드바는 props가 같으면 건너뜀).
interface State { d: number; n: number; s?: 1 } // n = 쌓은 기록 수(저장소 목록 = 0)
let cur: State = { d: 0, n: 0 };
const subs = new Set<() => void>();
const set = (s: State) => ((cur = s), subs.forEach((f) => f()));
const pops = new Set<(d: number) => void>();
const on = (f: () => void) => (subs.add(f), () => void subs.delete(f));

if (isMobile) {
  history.replaceState(cur, "");
  addEventListener("popstate", (e) => {
    set((e.state as State | null) ?? { d: 0, n: 0 });
    pops.forEach((f) => f(cur.d));
  });
}

export const nav = {
  get depth() {
    return cur.d;
  },
  push: (d: number) => (history.pushState((cur = { d, n: cur.n + 1 }), ""), subs.forEach((f) => f())),
  back: () => history.back(),
  /** 시트 열기·닫기: 열 때 기록을 한 칸 쌓고, 닫을 때 한 칸 되돌린다(뒤로 버튼은 시트부터 닫는다) */
  openSheet: () => !cur.s && (history.pushState((cur = { d: cur.d, n: cur.n + 1, s: 1 }), ""), subs.forEach((f) => f())),
  closeSheet: () => cur.s && history.back(),
  /** 저장소를 닫아 목록으로 돌아갈 때 쌓인 기록을 모두 걷는다 */
  reset: () => cur.n > 0 && history.go(-cur.n),
  /** popstate로 깊이가 바뀐 뒤 부른다(새 깊이) */
  onPop: (f: (d: number) => void) => (pops.add(f), () => void pops.delete(f)),
};
export const useDepth = () => useSyncExternalStore(on, () => cur.d);
export const useSheet = () => useSyncExternalStore(on, () => !!cur.s);
