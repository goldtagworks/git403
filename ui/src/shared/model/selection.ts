import { useSyncExternalStore } from "react";

// 선택한 커밋을 사이드바 항목에 알린다. 바뀐 항목만 다시 그리고 Sidebar 전체는 다시 그리지 않는다.
// 사이드바에서 직접 누른 항목이 그 커밋을 가리키면 그 항목만, 아니면 그 커밋을 가리키는 대표 ref 하나만 강조
// (HEAD → 보이는 순서상 첫 항목: 로컬·원격·태그). 여럿을 함께 칠하면 포커스가 두 개로 보인다.
let sel: { sha: string | null; key: string | null; keySha: string | null; lit: boolean } = { sha: null, key: null, keySha: null, lit: false };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
export function markSelected(sha: string | null) {
  if (sel.sha === sha) return;
  sel = { ...sel, sha };
  emit();
}
/** lit: 그래프가 그 계보만 진하게 보인다(그래프의 브랜치 배지 클릭). 사이드바 클릭은 선택만 한다 */
export function pick(key: string, sha: string, lit = false) {
  sel = { sha, key, keySha: sha, lit };
  emit();
}
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));
/** 그래프에서 누른 브랜치 배지의 커밋 (다른 커밋을 고르면 null). 그래프가 그 계보만 진하게 보인다. */
export function useFocusRef() {
  return useSyncExternalStore(subscribe, () => (sel.lit && sel.keySha && sel.sha === sel.keySha ? sel.keySha : null));
}
/** 커밋 → 대표 항목 key. 사이드바가 보이는 트리를 만들 때 정한다 */
let primary = new Map<string, string>();
export function setPrimary(next: Map<string, string>) {
  primary = next;
  emit();
}
export function useActive(key: string, target: string) {
  return useSyncExternalStore(subscribe, () => sel.sha === target && (sel.keySha === sel.sha ? sel.key === key : primary.get(target) === key));
}

// "이 파일을 diff 화면에서 열어 달라"는 요청 (AI 채팅의 Read·Edit 경로). 로컬 변경 화면(ChangesView)이나 커밋 상세(Details)가
// 그 파일을 목록에서 찾으면 고른다. 화면이 새로 마운트되는 경우를 위해 잠깐(5초) 남겨 두고, 요청마다 n이 늘어 한 번만 처리한다.
export interface FileWant { path: string; n: number; t: number }
let want: FileWant | null = null;
const wantSubs = new Set<() => void>();
export const fileWant = {
  request(path: string) {
    want = { path, n: (want?.n ?? 0) + 1, t: Date.now() };
    wantSubs.forEach((f) => f());
  },
  /** 아직 처리하지 않은 신선한 요청 (handled = 이 화면이 마지막으로 처리한 n) */
  fresh: (w: FileWant | null, handled: number) => (w && w.n !== handled && Date.now() - w.t < 5000 ? w : null),
};
const onWant = (f: () => void) => (wantSubs.add(f), () => void wantSubs.delete(f));
export const useFileWant = () => useSyncExternalStore(onWant, () => want);
