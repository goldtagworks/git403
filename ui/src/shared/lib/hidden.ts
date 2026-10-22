// 사이드바에서 숨긴 ref (저장소별, localStorage `hidden:<저장소>`). 그래프 조회·ref 라벨·사이드바 표시가 같이 쓴다.
// 항목은 ref 전체 이름(`refs/heads/x`)이고, 폴더는 글롭(`refs/remotes/origin/foo/*`)이다. 현재(HEAD) 브랜치는 숨기지 않는다.
// 숨긴 폴더 안에서 다시 보이게 한 것은 `!`를 붙인 예외(`!refs/remotes/origin/main`)로 남긴다. 가장 구체적인(긴) 항목이 이긴다.
// ops·api 어느 쪽도 import하지 않는다 (api가 읽는다).
import { useSyncExternalStore } from "react";
import type { Ref, RefKind } from "../api/types";

const PREFIX: Record<RefKind, string> = { local: "refs/heads/", remote: "refs/remotes/", tag: "refs/tags/", stash: "refs/stash/" };
/** 사이드바 노드 키(`remote/origin/foo`)와 ref 이름 → 전체 ref 경로 */
export const refPath = (kind: RefKind, name: string) => PREFIX[kind] + name;
export const nodePath = (kind: RefKind, key: string) => PREFIX[kind] + key.slice(kind.length + 1);

const cache = new Map<string, Set<string>>();
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

function entries(repo: string): Set<string> {
  let s = cache.get(repo);
  if (!s) {
    try {
      const v = JSON.parse(localStorage.getItem("hidden:" + repo) ?? "[]");
      s = new Set(Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
    } catch {
      s = new Set();
    }
    cache.set(repo, s);
  }
  return s;
}
const save = (repo: string, s: Set<string>) => {
  cache.set(repo, s);
  try {
    s.size ? localStorage.setItem("hidden:" + repo, JSON.stringify([...s])) : localStorage.removeItem("hidden:" + repo);
  } catch {}
  listeners.forEach((l) => l());
};

/** 이 경로(폴더면 폴더 자신)가 숨겨졌는지. 자신 → 가까운 조상 폴더 순으로 처음 걸리는 항목(숨김/`!` 예외)을 따른다. */
function covered(s: Set<string>, path: string, folder: boolean) {
  if (s.size === 0) return false;
  const self = folder ? path + "/*" : path;
  if (s.has(self)) return true;
  if (s.has("!" + self)) return false;
  for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
    const g = path.slice(0, i) + "/*";
    if (s.has(g)) return true;
    if (s.has("!" + g)) return false;
  }
  return false;
}
export const isHiddenRef = (repo: string, r: Ref) => r.kind !== "stash" && !r.head && covered(entries(repo), refPath(r.kind, r.name), false);
export const isHiddenNode = (repo: string, path: string, folder: boolean) => covered(entries(repo), path, folder);

/** git `--exclude`에 넘길 목록 (빈 배열이면 기존과 같은 조회) */
export const hiddenPatterns = (repo: string) => [...entries(repo)];
export const hiddenCount = (repo: string) => [...entries(repo)].filter((e) => !e.startsWith("!")).length;

/** 숨김 전부 해제 */
export const showAll = (repo: string) => entries(repo).size && save(repo, new Set());

/** 숨김↔보임. 폴더면 그 아래 개별 항목·예외를 먼저 정리한다. 숨긴 조상 폴더는 그대로 두고, 이 항목만 `!` 예외로 보이게 한다. */
export function toggleHidden(repo: string, path: string, folder: boolean) {
  const s = new Set(entries(repo));
  const hide = !covered(s, path, folder);
  const self = folder ? path + "/*" : path;
  if (folder) for (const e of [...s]) if (e.replace(/^!/, "").startsWith(path + "/")) s.delete(e);
  s.delete(self);
  s.delete("!" + self);
  // 정리한 뒤 조상 상태와 원하는 상태가 다르면 이 항목만 따로 남긴다
  if (covered(s, path, folder) !== hide) s.add(hide ? self : "!" + self);
  save(repo, s);
}

/** 컴포넌트용: 판단 결과(boolean)만 구독하므로 바뀐 항목만 다시 그려진다. */
export const useHiddenRef = (repo: string, r: Ref) => useSyncExternalStore(subscribe, () => isHiddenRef(repo, r));
export const useHiddenNode = (repo: string, path: string, folder: boolean) => useSyncExternalStore(subscribe, () => isHiddenNode(repo, path, folder));
/** 섹션 제목 개수: 숨긴 게 있으면 `보이는수/전체` */
export const useVisibleCount = (repo: string, refs: Ref[]) =>
  useSyncExternalStore(subscribe, () => {
    const shown = refs.reduce((n, r) => n + (isHiddenRef(repo, r) ? 0 : 1), 0);
    return shown < refs.length ? `${shown}/${refs.length}` : String(refs.length);
  });
/** "보는 중 70/97"용: 숨긴 ref가 있을 때만 `보이는수/전체`, 없으면 빈 문자열 (스태시 제외) */
export const useViewing = (repo: string, refs: Ref[]) =>
  useSyncExternalStore(subscribe, () => {
    const all = refs.filter((r) => r.kind !== "stash");
    const shown = all.reduce((n, r) => n + (isHiddenRef(repo, r) ? 0 : 1), 0);
    return shown < all.length ? `${shown}/${all.length}` : "";
  });
/** 숨김 항목 집합. 바뀔 때만 새 참조 (memo 의존성용) */
export const useHiddenSet = (repo: string) => useSyncExternalStore(subscribe, () => entries(repo));
