// 자동 업데이트 상태와 동작. 상태는 모듈에 두고 useSyncExternalStore로 읽는다 (App을 다시 그리지 않으려고).
// 확인 실패는 수동 확인일 때만 보여주고 자동 확인에서는 조용히 넘어간다.
import { api } from "../api/api";
import { t } from "../i18n/i18n";
import { pref } from "./settings";

export interface UpdateState {
  phase: "idle" | "checking" | "available" | "downloading" | "ready";
  version?: string;
  /** 다운로드 진행률 0–100. 전체 크기를 모르면 -1 */
  percent?: number;
  /** 수동 확인 결과 한 줄 (최신 버전·실패) */
  message?: string;
}

type Found = NonNullable<Awaited<ReturnType<typeof api.checkUpdate>>>;
let state: UpdateState = { phase: "idle" };
let found: Found | null = null;
const listeners = new Set<() => void>();
const set = (s: UpdateState) => {
  state = s;
  listeners.forEach((f) => f());
};
export const onUpdate = (f: () => void) => (listeners.add(f), () => void listeners.delete(f));
export const updateState = () => state;

const CHECKED_KEY = "updateCheckedAt";
const DAY = 24 * 60 * 60 * 1000;
const lastChecked = () => {
  try {
    return Number(localStorage.getItem(CHECKED_KEY)) || 0;
  } catch {
    return 0;
  }
};
/** 자동 확인을 할 때가 됐는가: 켜져 있고 마지막 성공 확인이 하루 넘었음 */
export const autoCheckDue = (now: number, last: number, enabled: boolean) => enabled && now - last >= DAY;

export async function checkUpdate(manual: boolean) {
  if (state.phase === "checking" || state.phase === "downloading" || state.phase === "ready") return;
  const prev = state;
  set({ phase: "checking" });
  try {
    const u = await api.checkUpdate();
    try {
      localStorage.setItem(CHECKED_KEY, String(Date.now()));
    } catch {}
    if (u) {
      found = u;
      set({ phase: "available", version: u.version });
    } else set(manual ? { phase: "idle", message: t("update.latest") } : { phase: "idle" });
  } catch (e) {
    set(manual ? { phase: "idle", message: t("update.checkFail", { e: e instanceof Error ? e.message : String(e) }) } : prev.phase === "available" ? prev : { phase: "idle" });
  }
}

/** 하루에 한 번만. 앱 시작 직후와 이후 매시간 불린다 */
export const autoCheck = () => autoCheckDue(Date.now(), lastChecked(), pref("autoUpdate")) && checkUpdate(false);

/** 다운로드(진행률) → 설치 → 재시작. 실패하면 다시 누를 수 있게 available로 돌아가고 사유를 남긴다 */
export async function installUpdate() {
  if (!found || state.phase !== "available") return;
  const { version } = state;
  let total = 0;
  let got = 0;
  set({ phase: "downloading", version, percent: -1 });
  try {
    await found.download((e) => {
      if (e.event === "Started") total = e.data.contentLength ?? 0;
      else if (e.event === "Progress") {
        got += e.data.chunkLength;
        set({ phase: "downloading", version, percent: total ? Math.min(100, Math.round((got / total) * 100)) : -1 });
      }
    });
    set({ phase: "ready", version });
    await found.install();
    await api.relaunch();
  } catch (e) {
    set({ phase: "available", version, message: t("update.fail", { e: e instanceof Error ? e.message : String(e) }) });
  }
}
