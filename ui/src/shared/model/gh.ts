import { useSyncExternalStore } from "react";
import { api } from "../api/api";
import { ask } from "../api/bridge";
import { t } from "../i18n/i18n";

/** 상태바 gh 계정 항목이 보여 주는 값. null = 숨김(gh 미설치·저장소 없음·원격이 GitHub류가 아님) */
export interface GhState { repo: string; host: string; accounts: { user: string; active: boolean }[]; bound: string | null; active: string | null; remote: string }

// 외부 스토어: 값이 실제로 바뀔 때만 알려서 상태바 항목만 다시 그린다 (docs/performance.md)
let state: GhState | null = null;
const subs = new Set<() => void>();
let seq = 0, inflight = false;
const same = (a: GhState | null, b: GhState | null) => JSON.stringify(a) === JSON.stringify(b);
const set = (n: GhState | null) => same(state, n) || ((state = n), subs.forEach((f) => f()));

export const gh = {
  get: () => state,
  on: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
  /** 저장소의 gh 계정 상태를 다시 읽는다 (저장소 열기·탭 전환·전환/연결 직후·원격 작업 끝·창 포커스). 겹치면 최신 것만 반영하고, quiet(포커스)는 이미 읽는 중이면 건너뛴다 */
  refresh: async (repo: string | undefined, quiet = false) => {
    if (!repo) return set(null);
    if (quiet && inflight) return;
    const mine = ++seq;
    inflight = true;
    try {
      // 두 조회는 서로 독립이라 병렬로 (기본 호스트와 저장소 호스트가 다르면 그때만 다시)
      const [ra, first] = await Promise.all([api.ghRepoAccount(repo), api.ghAccounts()]);
      const acc = ra.remote && first.installed && !first.hosts.some((h) => h.host === ra.host) && ra.host !== "github.com" ? await api.ghAccounts(ra.host) : ra.remote ? first : null;
      if (mine !== seq) return;
      const accounts = acc?.installed ? acc.hosts.find((h) => h.host === ra.host)?.accounts ?? [] : [];
      set(ra.remote && acc?.installed ? { repo, host: ra.host, accounts, bound: ra.bound, active: ra.active, remote: ra.remote } : null);
    } catch {
      if (mine === seq) set(null);
    } finally {
      if (mine === seq) inflight = false;
    }
  },
  /** 낙관적 전환: 라벨을 바로 바꾸고 gh_switch가 실패하면 되돌린 뒤 오류를 던진다. 성공하면 다시 읽어 맞춘다 */
  switchTo: async (host: string, user: string) => {
    const prev = state;
    seq++; // 진행 중이던 옛 조회가 낙관적 값을 덮지 않게
    if (prev) set({ ...prev, active: user, accounts: prev.accounts.map((a) => ({ ...a, active: a.user === user })) });
    try {
      await api.ghSwitch(host, user);
    } catch (e) {
      if (prev) set(prev);
      throw e;
    }
    await gh.refresh(prev?.repo);
  },
  /** 낙관적 연결/해제(user 없음 = 해제) */
  bindTo: async (repo: string, user?: string) => {
    const prev = state;
    seq++; // 진행 중이던 옛 조회가 낙관적 값을 덮지 않게
    if (prev) set({ ...prev, bound: user ?? null });
    try {
      await api.ghBind(repo, user);
    } catch (e) {
      if (prev) set(prev);
      throw e;
    }
    await gh.refresh(repo);
  },
};
/** gh 계정 항목 전용 구독 */
export const useGh = () => useSyncExternalStore(gh.on, gh.get);

/**
 * push·fetch가 "Repository not found"로 실패했을 때: 접근되는 다른 gh 계정이 있으면 그 계정에 연결하고 다시 시도할지 묻는다.
 * (조용히 끝나는 것이 기본이라, 접근 가능한 계정이 없거나 gh가 없으면 아무것도 묻지 않는다)
 */
export async function suggestOtherAccount(repo: string, retry: () => void) {
  try {
    const [ra, probe] = await Promise.all([api.ghRepoAccount(repo), api.ghProbe(repo)]);
    if (!ra.remote) return;
    const cur = ra.bound ?? ra.active;
    const other = probe.find((p) => p.ok && p.user !== cur);
    if (!other || probe.some((p) => p.ok && p.user === cur)) return;
    if (!(await ask(t("gh.retryAsk", { user: other.user }), { title: t("gh.retryTitle"), kind: "warning" }))) return;
    await api.ghBind(repo, other.user);
    await gh.refresh(repo);
    retry();
  } catch {}
}
