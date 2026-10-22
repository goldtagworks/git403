import { useSyncExternalStore } from "react";
import { api } from "../api/api";

// PR 본문·코멘트(Markdown)의 커밋 sha 링크(26 후속): 클릭 동작은 PR 화면(`Detail`)이 handler로 등록하고,
// 호버 미리보기 카드 상태는 이 외부 스토어에 둔다(구독은 `ShaCard`뿐 — 호버가 그래프·사이드바·툴바·PR 화면을 다시 그리지 않는다).

export interface ShaInfo { title: string; author: string; at: string; files: number | null }
export interface ShaHandler {
  repo: string;
  /** 링크 클릭. href = 링크가 가진 http(s) 주소(GitHub가 만든 /commit/<sha> 링크), 맨 sha 글자면 null */
  click: (sha: string, href: string | null) => void;
  /** 타임라인에 이 PR 커밋 정보가 있으면(제목·작성자·시각) 바로 보여 주는 용도 */
  known: (sha: string) => Omit<ShaInfo, "files"> | null;
}
interface Card { sha: string; left: number; top: number; bottom: number; info: ShaInfo }

let handler: ShaHandler | null = null;
let card: Card | null = null;
let want: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const subs = new Set<() => void>();
const set = (c: Card | null) => ((card = c), subs.forEach((f) => f()));
const CACHE_MAX = 200;
const cache = new Map<string, Promise<ShaInfo | null>>();

/** git으로 지연 조회(로컬에 있을 때만): 제목·작성자·시각(`show -s --format`) + 파일 수(`show --numstat`, diff 본문 없음). 저장소+sha별 캐시 */
const lookup = (repo: string, sha: string) => {
  const key = `${repo}\0${sha}`;
  let p = cache.get(key);
  if (p) (cache.delete(key), cache.set(key, p)); // LRU: 쓴 항목을 맨 뒤로
  else {
    p = Promise.all([
      api.git(repo, ["show", "-s", "--format=%an%x1f%aI%x1f%s", sha]),
      api.git(repo, ["show", "--numstat", "--format=", "--diff-merges=first-parent", sha]).catch(() => null),
    ]).then(
      ([m, n]) => {
        const [author = "", at = "", title = ""] = m.trim().split("\x1f");
        return { author, at, title, files: n === null ? null : n.split("\n").filter((l) => l.trim()).length } as ShaInfo;
      },
      () => (cache.delete(key), null), // 실패는 캐시하지 않는다: 다음 호버에서 다시 묻는다
    );
    cache.set(key, p);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!); // 가장 오래 안 쓴 것부터 버린다
  }
  return p;
};

export const prSha = {
  setHandler: (h: ShaHandler | null) => void (handler = h),
  get handler() {
    return handler;
  },
  /** 호버·포커스 지연 후 카드. 정보가 없으면(PR 커밋도 아니고 로컬에도 없음) 아무것도 띄우지 않는다 */
  hover: (sha: string, el: HTMLElement) => {
    if (want === sha && card?.sha === sha) return; // 이미 이 sha 카드가 떠 있으면 다시 만들지 않는다(mousemove마다 불려도 렌더 0)
    clearTimeout(timer);
    want = sha;
    timer = setTimeout(async () => {
      const h = handler;
      if (!h || want !== sha) return;
      const r = el.getBoundingClientRect();
      const pos = { left: r.left, top: r.top, bottom: r.bottom };
      const known = h.known(sha);
      if (known) set({ sha, ...pos, info: { ...known, files: null } });
      const got = await lookup(h.repo, sha);
      if (want !== sha || handler !== h) return;
      if (got) set({ sha, ...pos, info: { ...got, ...(known ?? {}) } });
    }, 300);
  },
  leave: () => {
    clearTimeout(timer);
    want = null;
    if (card) set(null);
  },
  on: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
  get: () => card,
};

export const useShaCard = () => useSyncExternalStore(prSha.on, prSha.get);
