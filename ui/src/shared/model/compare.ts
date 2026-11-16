import { useSyncExternalStore } from "react";
import type { Commit } from "../api/types";
import type { PickRef } from "./selection";

// 브랜치 비교 화면 상태 (외부 스토어). 열림 여부(App)·비교 대상(CompareLists)·고른 커밋(CompareDetails)을 각자 필요한 값만 구독해
// 커밋을 고를 때 App·그래프·사이드바가 다시 그려지지 않는다. 데이터는 CompareLists가 `compare_refs`로 읽는다.
/** a·b는 compare_refs에 넘기는 전체 ref 이름, an·bn은 화면에 보이는 짧은 이름. id는 열 때마다 새로(같은 쌍을 다시 열어도) 바뀌어 목록이 새로 마운트되고, rev는 같은 대상을 다시 읽을 때만 바뀐다 */
interface Cur { id: number; a: string; b: string; an: string; bn: string; rev: number }
let seq = 0;
let cur: Cur | null = null;
let commit: Commit | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

export const compare = {
  open(a: PickRef, b: PickRef) {
    cur = { id: ++seq, a: a.full, b: b.full, an: a.name, bn: b.name, rev: 0 };
    commit = null;
    emit();
  },
  close() {
    if (!cur) return;
    cur = null;
    commit = null;
    emit();
  },
  /** 같은 대상을 다시 읽는다 (cherry-pick 뒤) */
  reload() {
    if (!cur) return;
    cur = { ...cur, rev: cur.rev + 1 };
    emit();
  },
  /** 상세에 보일 커밋 */
  setCommit(c: Commit | null) {
    if (commit === c) return;
    commit = c;
    emit();
  },
};
export const useCompare = () => useSyncExternalStore(subscribe, () => cur);
export const useCompareOpen = () => useSyncExternalStore(subscribe, () => !!cur);
export const useCompareCommit = () => useSyncExternalStore(subscribe, () => commit);
