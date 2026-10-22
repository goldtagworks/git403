import { useMemo, useSyncExternalStore } from "react";
import type { AiGuide } from "../api/types";

// 읽는 흐름 가이드(25d)의 세션 캐시와 보기 상태. 대상(커밋 sha / 변경 화면 스테이지 diff 지문)별로 따로 보관하고,
// 구독은 종류별(열림·대기)·대상 키별로 나뉘어, 단계 이동은 그 대상을 보는 화면만 깨우고 그래프·사이드바·툴바·다른 대상은 건드리지 않는다.
// 호출(`ops.aiGuide*`)은 ops.ts, 화면은 features/ai/GuidePanel.tsx.

export type GuideEntry = { status: "loading"; cancel: () => void } | { status: "done"; guide: AiGuide } | { status: "error"; error: string };
/** diff를 이 줄로 스크롤하라는 요청. seq가 바뀔 때마다 다시 스크롤한다 */
export interface GuideReveal { file: string; line: number; seq: number }
/** 한 대상의 상태: 가이드 만들기 결과 + 현재 단계(1부터) + 마지막 스크롤 요청 */
export interface GuideRec { entry?: GuideEntry; n: number; reveal?: GuideReveal }

const recs = new Map<string, GuideRec>();
const openSubs = new Set<() => void>();
const pendingSubs = new Set<() => void>();
const recSubs = new Map<string, Set<() => void>>();
const sub = (set: Set<() => void>) => (f: () => void) => (set.add(f), () => void set.delete(f));
const subRec = (key: string | null) => (f: () => void) => {
  if (!key) return () => {};
  const set = recSubs.get(key) ?? recSubs.set(key, new Set()).get(key)!;
  set.add(f);
  return () => void set.delete(f);
};
const emit = (set: Set<() => void>) => set.forEach((f) => f());
const set = (key: string, patch: Partial<GuideRec>) => {
  recs.set(key, { n: 1, ...recs.get(key), ...patch });
  recSubs.get(key)?.forEach((f) => f());
};

let open = false;
let pending = false;
let seq = 0;

export const guide = {
  /** 가이드 패널(읽는 흐름 탭) 열림 여부 — 대상과 상관없이 하나 */
  setOpen(v: boolean) {
    if (open === v) return;
    open = v;
    const hadPending = pending;
    if (!v) pending = false;
    emit(openSubs);
    if (hadPending && !pending) emit(pendingSubs);
  },
  toggle() {
    guide.setOpen(!open);
  },
  /** 대상이 정해지지 않은 요청(빠른 실행): 패널을 열고, 패널이 지금 보는 대상이 정해지는 첫 순간에 한 번 받아 간다. 닫으면 사라진다 */
  want() {
    pending = true;
    const wasOpen = open;
    open = true;
    if (!wasOpen) emit(openSubs);
    emit(pendingSubs);
  },
  /** 대기 중인 "다음 확정 대상" 요청을 받는다 (있었으면 true, 비운다) */
  take() {
    if (!pending) return false;
    pending = false;
    emit(pendingSubs);
    return true;
  },
  /** 이 대상에 이미 가이드(만드는 중·완료)가 있는지 */
  has(key: string) {
    const s = recs.get(key)?.entry?.status;
    return s === "loading" || s === "done";
  },
  /** 만들기 시작. result가 null이면(취소·동의 거절) 처음 상태로 돌아간다. 같은 키의 이전 요청은 취소 */
  start(key: string, call: { result: Promise<AiGuide | null>; cancel: () => void }) {
    const prev = recs.get(key)?.entry;
    if (prev?.status === "loading") prev.cancel();
    const entry: GuideEntry = { status: "loading", cancel: call.cancel };
    set(key, { entry, n: 1, reveal: undefined });
    const cur = () => recs.get(key)?.entry === entry;
    call.result.then(
      (g) => cur() && set(key, { entry: g ? { status: "done", guide: g } : undefined }),
      (e) => cur() && set(key, { entry: { status: "error", error: String(e) } }),
    );
  },
  cancel(key: string) {
    const e = recs.get(key)?.entry;
    if (e?.status !== "loading") return;
    e.cancel();
    set(key, { entry: undefined });
  },
  /** n단계로 이동하고 그 줄로 스크롤하게 한다 */
  step(key: string, n: number, file: string, line: number) {
    set(key, { n, reveal: { file, line, seq: ++seq } });
  },
  /** 현재 단계는 그대로 두고 diff만 이 줄로 */
  reveal(key: string, file: string, line: number) {
    set(key, { reveal: { file, line, seq: ++seq } });
  },
};

const subOpen = sub(openSubs);
const subPending = sub(pendingSubs);
export const useGuideOpen = () => useSyncExternalStore(subOpen, () => open);
export const useGuideRec = (key: string | null) => useSyncExternalStore(useMemo(() => subRec(key), [key]), () => (key ? recs.get(key) : undefined));
export const useGuidePending = () => useSyncExternalStore(subPending, () => pending);
