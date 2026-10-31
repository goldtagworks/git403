import { useSyncExternalStore } from "react";
import { t } from "../i18n/i18n";

export type ToastKind = "success" | "info" | "warning" | "error";
export interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
  /** 토스트 안의 버튼(누르면 run을 실행하고 닫는다) */
  action?: ToastAction;
  /** 같은 알림이 연속으로 온 횟수 */
  n: number;
  /** 같은 알림이 다시 올 때마다 늘어난다 (자동 사라짐 타이머를 다시 시작하는 신호) */
  rev: number;
}
export interface ToastAction { label: string; run: () => void }
export interface ToastOpts { kind?: ToastKind; detail?: string; action?: ToastAction }

export const MAX_TOASTS = 4;
/** 성공·정보·경고가 저절로 사라지기까지 (오류는 닫을 때까지 유지) */
export const AUTO_MS = 4000;

// 토스트 스토어: React 밖에 두고 Toasts 컴포넌트만 구독한다. 알림이 떠도 App과 큰 화면은 다시 그려지지 않는다.
let items: ToastItem[] = [];
let seq = 0;
const subs = new Set<() => void>();
const set = (next: ToastItem[]) => ((items = next), subs.forEach((f) => f()));
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));

/** 문구 끝이 언어별 성공 꼴(ko "…완료/…됨", en "…ed/…done")이면 성공, 아니면 정보. 패턴은 locales의 toast.successRe */
const inferKind = (title: string): ToastKind => (new RegExp(t("toast.successRe"), "i").test(title) ? "success" : "info");

/** 토스트를 띄운다. 직전 것과 종류·문구가 같으면 새로 쌓지 않고 합친다. */
export function toast(title: string, opts: ToastOpts = {}) {
  const kind = opts.kind ?? inferKind(title);
  let detail = opts.detail?.trim() || undefined;
  if (kind === "error" && !detail) {
    // 여러 줄 오류(git 출력)는 첫 줄이 제목, 나머지는 "자세히"
    const [first, ...rest] = title.trim().split("\n");
    title = first;
    detail = rest.join("\n").trim() || undefined;
  }
  const last = items.at(-1);
  if (last && last.kind === kind && last.title === title && last.detail === detail) {
    set([...items.slice(0, -1), { ...last, n: last.n + 1, rev: last.rev + 1 }]);
  } else {
    set([...items, { id: ++seq, kind, title, detail, action: opts.action, n: 1, rev: 0 }].slice(-MAX_TOASTS));
  }
}
/** 오류 토스트. detail이 없으면 여러 줄 메시지의 첫 줄이 제목이 된다. */
export const toastError = (title: string, detail?: string) => toast(title, { kind: "error", detail });

export const dismissToast = (id: number) => set(items.filter((t) => t.id !== id));
export const useToasts = () => useSyncExternalStore(subscribe, () => items);
