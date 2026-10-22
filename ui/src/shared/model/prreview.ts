import { useSyncExternalStore } from "react";

// PR 리뷰 화면(26): 그래프·사이드바 자리를 덮는 목록|상세 화면의 열림·선택 상태. bigview.ts처럼 외부 스토어라
// 열기·PR 선택이 App·그래프·사이드바·툴바를 다시 그리지 않는다. 구독은 `PrReviewHost`뿐 (docs/reuse.md).

type S = { open: boolean; selected: number | null };
let s: S = { open: false, selected: null };
const subs = new Set<() => void>();
const set = (n: S) => {
  if (n.open === s.open && n.selected === s.selected) return;
  s = n;
  subs.forEach((f) => f());
};

export const prReview = {
  get open() {
    return s.open;
  },
  /** 화면을 열고(이미 열려 있으면 유지) number가 있으면 그 PR을 고른다 */
  show: (number?: number) => set({ open: true, selected: number ?? s.selected }),
  select: (number: number | null) => set({ ...s, selected: number }),
  close: () => set({ open: false, selected: null }),
  on: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
  get: () => s,
};

export const usePrReview = () => useSyncExternalStore(prReview.on, prReview.get);

/** 상대 시간 ("5시간 전"). 현재 언어 Intl 사용 */
export const relTime = (iso: string, tag: string, now = Date.now()) => {
  const sec = Math.round((new Date(iso).getTime() - now) / 1000);
  const f = new Intl.RelativeTimeFormat(tag, { numeric: "auto", style: "narrow" });
  const abs = Math.abs(sec);
  if (abs < 60) return f.format(sec, "second");
  if (abs < 3600) return f.format(Math.round(sec / 60), "minute");
  if (abs < 86400) return f.format(Math.round(sec / 3600), "hour");
  return f.format(Math.round(sec / 86400), "day");
};

/** 내 마지막 리뷰(timeline에서 author==me인 review) 뒤 첫 커밋 sha. me를 모르거나 내 리뷰·그 뒤 커밋이 없으면 null (정확히 정할 수 없다) */
export function firstCommitAfterMyReview(tl: { kind: string; author: string; at: string; sha?: string | null }[], me: string | null): string | null {
  if (!me) return null;
  const mine = tl.filter((it) => it.kind === "review" && it.author.toLowerCase() === me.toLowerCase()).map((it) => it.at).sort().pop();
  if (!mine) return null;
  return tl.filter((it) => it.kind === "commit" && it.sha && it.at > mine).sort((a, b) => a.at.localeCompare(b.at))[0]?.sha ?? null;
}

/** 내가 올린 PR의 리뷰어 진행도: 승인 수 / (승인 + 아직 기다리는 요청 리뷰어). reviewers는 대기 중인 요청만 온다 */
export const reviewProgress = (p: { approvals: number; reviewers: string[] }) => ({ done: p.approvals, total: p.approvals + p.reviewers.length, pending: p.reviewers.length });

/** 타임라인에서 sha(앞부분이 같으면 같은 것) 뒤에 올라온 커밋 수(오래된 순 기준). 타임라인에 그 커밋이 없거나 뒤에 커밋이 없으면 null */
export function commitsAfter(tl: { kind: string; at: string; sha?: string | null }[] | undefined, sha: string): number | null {
  if (!tl || !sha) return null;
  const cs = tl.filter((it) => it.kind === "commit" && it.sha).sort((a, b) => a.at.localeCompare(b.at));
  const i = cs.findIndex((it) => it.sha!.startsWith(sha) || sha.startsWith(it.sha!));
  const n = i < 0 ? 0 : cs.length - 1 - i;
  return n > 0 ? n : null;
}
