import { useSyncExternalStore } from "react";

// 선택한 커밋을 사이드바 항목에 알린다. 바뀐 항목만 다시 그리고 Sidebar 전체는 다시 그리지 않는다.
// 사이드바에서 직접 누른 항목이 그 커밋을 가리키면 그 항목만, 아니면 그 커밋을 가리키는 ref 모두 강조.
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
export function useActive(key: string, target: string) {
  return useSyncExternalStore(subscribe, () => sel.sha === target && (sel.keySha !== sel.sha || sel.key === key));
}
