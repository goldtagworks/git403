import { useSyncExternalStore } from "react";
import { api } from "../api/api";
import type { Commit } from "../api/types";

// compact 커밋 목록의 호버 툴팁(작성자·날짜·변경 파일 수·+/-·전체 메시지). 상태는 이 외부 스토어에 두고 구독은 `CommitTip`뿐이라
// 호버가 그래프·행을 다시 그리지 않는다 (docs/performance.md). 데이터는 기존 조회(`commit_message`, `git show --numstat`)를 저장소+sha별로 캐시.

export interface TipInfo { message: string; files: number | null; add: number; del: number }
export interface Tip { c: Commit; left: number; width: number; top: number; bottom: number; info: TipInfo }

let card: Tip | null = null;
let want: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const subs = new Set<() => void>();
const set = (c: Tip | null) => ((card = c), subs.forEach((f) => f()));
const CACHE_MAX = 200;
const cache = new Map<string, Promise<TipInfo>>();

const lookup = (repo: string, c: Commit) => {
  const key = `${repo}\0${c.id}`;
  let p = cache.get(key);
  if (p) (cache.delete(key), cache.set(key, p));
  else {
    p = Promise.all([
      api.commitMessage(repo, c.id).catch(() => c.subject),
      api.git(repo, ["show", "--numstat", "-M", "--format=", "--diff-merges=first-parent", c.id]).catch(() => null),
    ]).then(([message, n]) => {
      const lines = n === null ? null : n.split("\n").filter((l) => l.trim());
      let add = 0, del = 0;
      for (const l of lines ?? []) {
        const [a, d] = l.split("\t");
        add += parseInt(a) || 0; // 바이너리는 "-"
        del += parseInt(d) || 0;
      }
      return { message: message.trim(), files: lines ? lines.length : null, add, del };
    });
    cache.set(key, p);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  }
  return p;
};

export const tip = {
  /** 호버 지연 후 카드. 같은 커밋 카드가 이미 떠 있으면 아무것도 안 한다 */
  hover: (repo: string, c: Commit, el: HTMLElement) => {
    if (want === c.id) return;
    clearTimeout(timer);
    want = c.id;
    timer = setTimeout(async () => {
      if (want !== c.id) return;
      const r = el.getBoundingClientRect();
      const pos = { left: r.left, width: r.width, top: r.top, bottom: r.bottom };
      const info = await lookup(repo, c);
      if (want === c.id) set({ c, ...pos, info });
    }, 350);
  },
  /** 스크롤: 떠 있는 카드만 걷는다 (대기 중인 호버 타이머는 건드리지 않는다 — 열기 직후 자동 스크롤이 호버를 지우지 않게) */
  scrolled: () => {
    if (!card) return;
    want = null;
    set(null);
  },
  leave: () => {
    clearTimeout(timer);
    want = null;
    if (card) set(null);
  },
  on: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
  get: () => card,
};

export const useTip = () => useSyncExternalStore(tip.on, tip.get);
