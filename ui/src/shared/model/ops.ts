// git 작업 모음. 툴바·우클릭 메뉴·사이드바·단축키가 모두 여기를 부른다 (docs/reuse.md).
// 상태는 App이 `ctx`에 넣어 두고, 작업은 그걸 읽기만 한다 (props로 내려보내지 않아 리렌더링이 없다).
import { prReview } from "./prreview";
import { useSyncExternalStore } from "react";
import { ask, listen, openFile } from "../api/bridge";
import { api } from "../api/api";
import { t } from "../i18n/i18n";
import { build, kindLabels, targetLabels, type CustomCommand, type CustomKind, type CustomTarget, type CustomVars } from "../lib/custom";
import { showAll, toggleHidden } from "../lib/hidden";
import { prompt, type Field } from "../ui/prompt";
import { toast, toastError, type ToastOpts } from "../lib/toast";
import type { MenuEntry } from "../ui/menu";
import { autoRule, jiraCfg, jiraEffective, jiraRule, jiraSuggest, parseRules, type IssueRule, type JiraSuggestion } from "../lib/issues";
import { GIT_SETTINGS_RE, JIRA_RE, parseConfig, pref, setPref, validEmail, type Prefs } from "../lib/settings";
import { aiProvider } from "./aiProviders";
import type { AiEffort, AiPart, AiResults, AiStatus, AiTask, Commit, HostAccount, Ref, RemoteInfo, Status } from "../api/types";
import { guide } from "./guide";

/** localStorage 읽기·쓰기 (막혀 있으면 기본값) */
export const stored = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
export const store = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
};

export interface FlowConfig { master: string; develop: string; feature: string; release: string; hotfix: string; tag: string }
export type FlowKind = "feature" | "release" | "hotfix";
const FLOW_KEYS: Record<keyof FlowConfig, string> = {
  master: "gitflow.branch.master", develop: "gitflow.branch.develop",
  feature: "gitflow.prefix.feature", release: "gitflow.prefix.release", hotfix: "gitflow.prefix.hotfix", tag: "gitflow.prefix.versiontag",
};
/** Git Flow가 쓰는 git 서브커맨드 (하나라도 없으면 Git Flow 항목을 숨긴다) */
export const FLOW_OPS = ["switch", "merge", "tag", "branch", "config"];
const FLOW_NAME: Record<FlowKind, string> = { feature: "Feature", release: "Release", hotfix: "Hotfix" };

/** Pull/Push 작업: 완료 토스트에 받은·올린 커밋 수를 붙인다 (`ctx.job` opts.track) */
export type JobTrack = "pull" | "push";

export const ctx = {
  repo: "",
  /** 열린 탭(저장소 경로) */
  tabs: [] as string[],
  /** 탭 줄에서 활성으로 보이는 탭 (여는 중이면 그 탭). ⌘⌥←/→가 연타돼도 건너뛰지 않게 App이 맞춘다 */
  activeTab: "",
  refs: [] as Ref[],
  commits: [] as Commit[],
  status: null as Status | null,
  /** Git Flow 설정 (미초기화면 null). `ops.flowLoad`가 저장소를 열 때 채운다. */
  flow: null as FlowConfig | null,
  /** 토스트(성공·정보). 문구가 "…완료/…됨"이면 성공, 아니면 정보. 종류·설명은 opts로 (toast.ts) */
  notify: (msg: string, opts?: ToastOpts) => toast(msg, opts),
  /** 오류 토스트(닫을 때까지 유지). detail이 없으면 여러 줄 메시지의 첫 줄이 제목, 나머지는 "자세히" */
  error: (msg: string, detail?: string) => toastError(msg, detail),
  /** 긴 작업(네트워크). 이름은 상태바·완료 문구에 쓴다. opts.shell을 주면 args 대신 그 셸 명령을 실행한다. opts.remote는 원격 ref가 바뀌는 작업(성공하면 PR 목록 갱신 신호). */
  job: (_name: string, _args: string[], _opts?: { repo?: string; onDone?: () => void; shell?: string; remote?: boolean; quiet?: boolean; track?: JobTrack; ghUser?: string }) => {},
  /** 저장소를 여는 중(탭 전환·로딩)인지 (App이 등록) */
  loading: () => false,
  /** LFS 상태 시트 열기 (Inspector가 등록 — ops가 Inspector를 import하면 순환이 된다) */
  showLfs: () => {},
  /** 저장소 통계 시트 열기 (Inspector가 등록) */
  showStats: () => {},
  /** 현재 저장소 다시 읽기 (서브모듈·worktree처럼 파일 감시가 못 잡는 변경 뒤) */
  reload: () => {},
  /** 설정 창 열기 (SettingsSheet가 등록 — 순환 import 방지). tab: general|git|accounts|tools|ignore|ssh|issues */
  showSettings: (_tab?: string) => {},
  /** 긴 작업(start_job)이 돌고 있는지 (App이 등록). 자동 fetch가 원격 작업 잠금을 건너뛸 때 쓴다 */
  busy: () => false,
  /** PR 시트 열기 (HostingSheets가 등록 — 순환 import 방지) */
  showPr: (_s: PrState) => {},
  /** AI 상태: 방식 감지 결과(`ops.aiLoad`)와 이 저장소에서 껐는지(git config git403.ai)·저장소 규칙을 끄는지(git403.aiConventions). 메뉴·버튼이 `ops.aiOn()`으로 본다 */
  ai: { status: null as AiStatus | null, repoOff: false, convOff: false },
  /** AI 결과 시트 열기 (AiSheets가 등록 — 순환 import 방지) */
  showAi: (_s: AiState) => {},
  /** 이슈 링크 규칙이 바뀌었을 때 App에 알린다 (App이 등록) */
  setIssues: (_rules: IssueRule[]) => {},
  /** 저장소 열기(탭 추가·활성화) */
  open: (_path: string) => {},
  /** 탭 묶음 교체 (작업공간) */
  setTabs: (_paths: string[]) => {},
  /** 폴더 스캔으로 찾은 저장소를 목록에 추가 */
  addRepos: (_paths: string[]) => {},
};

const EOL_RULE = "* text=auto eol=lf";
const eolFix = () => t("ops.eol.fix");
const eolKeep = () => t("ops.eol.keep");
const readDeclined = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem("eolDeclined") ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
const writeDeclined = (list: string[]) => {
  try {
    localStorage.setItem("eolDeclined", JSON.stringify(list));
  } catch {}
};

/** PR 시트 입력: 열 때 `ops.createPr`가 채운다 */
export interface PrInit {
  head: string;
  infos: RemoteInfo[];
  remote: string;
  base: string;
  bases: string[];
  probe: PrProbe;
  /** 저장소 PR 템플릿(없으면 ""), 본문 기본값 */
  template: string;
}
/** 원격 상태: head가 원격에 있는지, 원격보다 앞선 커밋 수, base..head 커밋 제목(오래된 순), 마지막 커밋 제목 */
export interface PrProbe { onRemote: boolean; ahead: number; log: string[]; last: string }
export type PrState = { form: PrInit } | { done: string };

/** AI 호출 하나. result는 취소·동의 거절이면 null, 오류면 reject(사용자용 문구). 끝난 뒤의 cancel은 아무 일도 안 한다 */
export interface AiCall<T> { result: Promise<T | null>; cancel: () => void }
export type AiState =
  | { kind: "review"; title: string; call: AiCall<AiResults["review"]> }
  // repo는 요청 시점의 저장소(탭을 바꿔도 거기에 쓴다), fp는 요청 때 읽은 작업 파일 지문(gather가 채움)
  | { kind: "conflict"; title: string; path: string; repo: string; fp: { v: string }; call: AiCall<AiResults["conflict"]> };

/** AI 사용 가능 여부 구독 (AI 버튼이 있는 컴포넌트만 구독한다 — 앱 전체가 다시 그려지지 않게) */
const aiListeners = new Set<() => void>();
export const aiBus = { emit: () => aiListeners.forEach((f) => f()), on: (f: () => void) => (aiListeners.add(f), () => void aiListeners.delete(f)) };
/** AI 사용 가능(방식이 있고 이 저장소에서 끄지 않음)인지 구독한다. AI 버튼이 있는 컴포넌트만 쓴다 */
export const useAiOn = () => useSyncExternalStore(aiBus.on, ops.aiOn);
const aiOn = () => !!ctx.ai.status?.active && !ctx.ai.repoOff;
/** 상태바 AI 항목이 보여 주는 값의 지문(공급자·방식·사용 가능·저장소별 끄기). 바뀔 때만 aiBus로 알려 상태바 항목만 다시 그린다 */
const aiSig = () => { const s = ctx.ai.status; return s ? `${s.provider}|${s.active ?? ""}|${s.providers.map((p) => `${p.provider}:${p.active ?? ""}`).join(",")}|${ctx.ai.repoOff ? 1 : 0}` : ""; };
/** 상태바 AI 항목 전용 구독: 선택된 공급자·방식이 바뀔 때만 (설정 화면·상태바 메뉴 어디서 바꿔도 `ops.aiLoad`를 거친다) */
export const useAiSig = () => useSyncExternalStore(aiBus.on, aiSig);

/** 첫 사용 때 한 번 동의를 받아 저장한다 (설정 > AI에서 초기화). false면 중단 */
async function aiConsent() {
  if (ctx.ai.status?.consent) return true;
  if (!(await confirm(t("ops.ai.consent", { p: aiProvider(ctx.ai.status?.provider).org }), t("ops.ai.consentTitle")))) return false;
  await api.aiSettingsSet({ consent: true });
  if (ctx.ai.status) ctx.ai.status.consent = true;
  return true;
}

let aiSeq = 0, aiRetried = false;
/** 동의 확인 → 입력 모으기(gather) → ai_run. 입력이 200KB를 넘으면 Rust가 자르지 않고 거부한다 */
function aiStart<K extends AiTask>(task: K, gather: () => Promise<AiPart[]>, opts?: { model?: string; effort?: AiEffort; repo?: string }): AiCall<AiResults[K]> {
  const token = `ai-${Date.now()}-${++aiSeq}`;
  let cancelled = false, running = false, done = false;
  const result = (async () => {
    try {
      if (!(await aiConsent()) || cancelled) return null;
      const parts = await gather();
      if (cancelled) return null;
      running = true;
      const r = await api.aiRun(task, parts, token, opts);
      return cancelled ? null : r; // 취소가 응답과 엇갈려도 결과를 반영하지 않는다
    } catch (e) {
      if (cancelled) return null;
      throw e;
    } finally {
      done = true;
    }
  })();
  return { result, cancel: () => { if (done) return; cancelled = true; if (running) api.aiCancel(token).catch(() => {}); } };
}

/** 커밋 하나의 AI 입력: 메시지 + diff (머지 커밋은 첫 부모 기준) */
const Q = ["-c", "core.quotepath=false"]; // 한글 등 경로를 `\355…`로 인용하지 않게(가이드의 파일 경로가 diff와 맞아야 한다)
async function reviewCommitParts(repo: string, sha: string): Promise<AiPart[]> {
  const diff = await api.git(repo, [...Q, "show", ...DIFF, "--diff-merges=first-parent", "--format=", "-p", sha]);
  if (!diff.trim()) throw t("ops.ai.noReview");
  return [{ label: "commit message", text: (await api.git(repo, ["log", "--no-show-signature", "-1", "--format=%B", sha]).catch(() => "")).trim() }, { label: "diff", text: diff }];
}
/** 브랜치의 AI 입력: base(원격 기본 브랜치, 없으면 main·master) 대비 커밋 제목 + diff */
async function reviewBranchParts(repo: string, branch: string): Promise<AiPart[]> {
  const rs = remotes();
  const remote = rs.includes("origin") ? "origin" : rs[0];
  const base = remote ? `${remote}/${await prBase(remote, prBases(remote))}` : ["main", "master"].find((b) => locals().includes(b));
  if (!base) throw t("ops.ai.noBase");
  if (base === branch) throw t("ops.ai.isBase", { branch });
  const diff = await api.git(repo, [...Q, "diff", ...DIFF, `${base}...${branch}`]);
  if (!diff.trim()) throw t("ops.ai.noDiff", { base });
  const log = (await api.git(repo, ["log", "--no-show-signature", "--reverse", "--format=%s", `${base}..${branch}`]).catch(() => "")).trim();
  return [{ label: "commit subjects", text: log || "(없음)" }, { label: `diff (${base}...${branch})`, text: diff }];
}
/** 문자열 지문(FNV-1a): 같은 diff인지 알아보는 용도 */
function fingerprint(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36) + text.length.toString(36);
}

const join = (dir: string, name: string) => dir.replace(/[\\/]+$/, "") + (dir.includes("\\") && !dir.includes("/") ? "\\" : "/") + name;
/** https://host/a/b.git, git@host:a/b.git → b */
export const repoName = (url: string) => url.trim().replace(/[\\/]+$/, "").replace(/\.git$/, "").split(/[\\/:]/).pop() ?? "";
const workspaces = () => stored<Record<string, string[]>>("workspaces", {});

const remotes = () => [...new Set(ctx.refs.filter((r) => r.kind === "remote").map((r) => r.name.split("/")[0]))];
const locals = () => ctx.refs.filter((r) => r.kind === "local").map((r) => r.name);
const head = () => ctx.refs.find((r) => r.head)?.name ?? ctx.status?.branch ?? null;
/** 저장소의 PR 템플릿 본문(없으면 ""). GitHub 순서: .github → docs → 루트의 pull_request_template.md, 없으면 .github/PULL_REQUEST_TEMPLATE/의 첫 .md */
const prTemplate = async () => {
  const files = (await api.git(ctx.repo, ["ls-files"]).catch(() => "")).split("\n");
  const low = (f: string) => f.toLowerCase();
  const path =
    ["", "docs/", ""].map((d, i) => (i ? d : ".github/") + "pull_request_template.md").map((n) => files.find((f) => low(f) === n)).find(Boolean) ??
    files.filter((f) => low(f).startsWith(".github/pull_request_template/") && low(f).endsWith(".md")).sort()[0];
  return path ? (await api.git(ctx.repo, ["show", `:${path}`]).catch(() => "")).trimEnd() : "";
};

/**
 * 작업을 시작할 때 부르고, 돌려받은 함수를 작업이 성공하면 부른다(prefix = 다른 탭 작업이면 저장소 이름).
 * Pull은 HEAD가 얼마나 앞으로 갔는지, Push는 시작할 때의 ahead를 세어 "Pull 완료 · 커밋 3개 받음"처럼 설명을 붙인다.
 */
export function jobNote(name: string, repo: string, track: JobTrack) {
  const from = ctx.refs.find((r) => r.head)?.target;
  const ahead = ctx.status?.ahead ?? 0;
  return async (prefix: string) => {
    if (track === "push") return ctx.notify(t("ops.job.done", { prefix, name }), { kind: "success", detail: ahead > 0 ? t("ops.job.pushed", { n: ahead }) : undefined });
    const n = from ? Number((await api.git(repo, ["rev-list", "--count", `${from}..HEAD`]).catch(() => "-1")).trim()) : -1;
    if (n === 0) ctx.notify(t("ops.job.upToDate", { prefix }), { kind: "info", detail: t("ops.job.noneToPull") });
    else ctx.notify(t("ops.job.done", { prefix, name }), { kind: "success", detail: n > 0 ? t("ops.job.pulled", { n }) : undefined });
  };
}

/** 이름·URL·rev가 `-`로 시작하면 git이 옵션으로 읽는다(`--upload-pack=…` 등). 하나라도 그러면 오류를 띄우고 true. */
const dashed = (...v: unknown[]) => {
  const bad = v.find((x) => String(x ?? "").trim().startsWith("-"));
  if (bad !== undefined) ctx.error(t("ops.badArg", { arg: String(bad) }));
  return bad !== undefined;
};
/** diff 출력을 사용자 설정(색·외부 diff 도구·접두사)과 무관하게 같은 모양으로 */
const DIFF = ["--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"];
/** 머지 커밋은 cherry-pick·revert에 부모 번호가 필요하다 → `-m 1`(첫 부모 기준) */
const parentFlag = async (sha: string) => ((await api.git(ctx.repo, ["rev-list", "--parents", "-n", "1", sha]).catch(() => "")).trim().split(/\s+/).length > 2 ? ["-m", "1"] : []);

/** 짧은 git 명령 실행 + 성공 문구 / 실패 시 오류 표시 */
async function git(args: string[], done?: string, detail?: string) {
  try {
    await api.git(ctx.repo, args);
    if (done) ctx.notify(done, { detail });
    return true;
  } catch (e) {
    ctx.error(String(e));
    return false;
  }
}

/** 스태시 명령. 다른 곳에서 이미 꺼냈거나 지운 스태시면 오류 대신 안내하고 목록을 새로 읽는다. */
async function stashGit(args: string[], done: string) {
  try {
    await api.git(ctx.repo, args);
    ctx.notify(done);
  } catch (e) {
    if (/is not a valid reference|No stash entries found/.test(String(e))) ctx.notify(t("ops.stash.gone"), { kind: "info" });
    else ctx.error(String(e));
  }
  ctx.reload();
}

/** 브랜치 이동. 로컬 변경이 덮어써진다며 막히면 변경을 스태시에 넣고 이동한 뒤 다시 꺼낸다(GitKraken식).
 *  이동이 그래도 실패하면 스태시를 되돌리고, 꺼낼 때 충돌하면 스태시를 남겨 둔다. */
async function switchKeep(args: string[], detail: string) {
  try {
    await api.git(ctx.repo, args);
    return ctx.notify(t("ops.checkout.done"), { detail });
  } catch (e) {
    if (!/would be overwritten by checkout/.test(String(e))) return ctx.error(String(e));
  }
  try {
    await api.git(ctx.repo, ["stash", "push", "--include-untracked", "-m", `autostash: ${head() ?? "HEAD"} → ${args.at(-1)}`]);
  } catch (e) {
    return ctx.error(String(e));
  }
  try {
    await api.git(ctx.repo, args);
  } catch (e) {
    await api.git(ctx.repo, ["stash", "pop"]).catch(() => {});
    ctx.reload();
    return ctx.error(String(e));
  }
  try {
    await api.git(ctx.repo, ["stash", "pop"]);
    ctx.notify(t("ops.checkout.done"), { detail: `${detail} · ${t("ops.checkout.autostash")}` });
  } catch {
    ctx.notify(t("ops.checkout.stashKept"), { kind: "info", detail });
  }
  ctx.reload();
}

/** git 실행 뒤 저장소를 다시 읽는다 (서브모듈·worktree 변경은 refs 감시에 안 잡힌다) */
async function gitReload(args: string[], done?: string) {
  const ok = await git(args, done);
  ctx.reload();
  return ok;
}

const lfsInstalled = new Set<string>();
/** git-lfs가 설치돼 있을 때만 true (`git lfs version`). 아니면 안내를 띄운다. 설치된 걸 확인한 저장소는 다시 묻지 않는다. */
async function lfsReady() {
  if (lfsInstalled.has(ctx.repo)) return true;
  if (await api.git(ctx.repo, ["lfs", "version"]).then(() => true, () => false)) {
    lfsInstalled.add(ctx.repo);
    return true;
  }
  ctx.error(t("ops.noLfs"));
  return false;
}

/** git-flow(AVH)와 같은 git config 키. 종료 코드 1(설정 없음)을 포함해 조회가 실패하면 미초기화로 본다. */
async function readFlow(repo: string): Promise<FlowConfig | null> {
  const out = await api.git(repo, ["config", "--get-regexp", "^gitflow\\."]).catch(() => "");
  const m = new Map(out.split("\n").filter(Boolean).map((l) => {
    const i = l.indexOf(" ");
    return (i < 0 ? [l, ""] : [l.slice(0, i), l.slice(i + 1)]) as [string, string];
  }));
  const master = m.get(FLOW_KEYS.master), develop = m.get(FLOW_KEYS.develop);
  if (!master || !develop) return null;
  const v = (k: keyof FlowConfig, d: string) => m.get(FLOW_KEYS[k]) ?? d;
  return { master, develop, feature: v("feature", "feature/"), release: v("release", "release/"), hotfix: v("hotfix", "hotfix/"), tag: v("tag", "") };
}

/** 여러 git 명령을 순서대로 실행. 실패하면 그 자리에서 멈추고 오류를 보인다. 충돌이면 해결 바(status.operation)로 넘기고 남은 단계를 안내한다(자동 재개 없음). */
async function runSteps(steps: string[][], done: string) {
  for (let i = 0; i < steps.length; i++) {
    try {
      await api.git(ctx.repo, steps[i]);
    } catch (e) {
      const st = await api.loadStatus(ctx.repo).catch(() => null);
      const op = st?.operation;
      const where = st?.branch ? t("ops.steps.where", { branch: st.branch }) : "";
      const rest = steps.slice(i + 1).map((a) => "git " + a.join(" ")).join(" → ");
      ctx.error(
        op
          ? t("ops.steps.conflict", { cmd: steps[i].join(" "), rest: rest ? `: ${rest}` : "" })
          : t("ops.steps.fail", { cmd: steps[i].join(" "), e: String(e), rest: rest ? t("ops.steps.notRun", { rest }) : "", where }),
      );
      return false;
    }
  }
  ctx.notify(done);
  return true;
}

/** 로컬 브랜치가 같은 이름의 원격 추적 브랜치보다 뒤처져 있으면 안내 문구를 돌려준다(네트워크 없이 rev-list로). */
async function behindMsg(branch: string) {
  for (const r of ctx.refs.filter((x) => x.kind === "remote" && x.name.split("/").slice(1).join("/") === branch)) {
    const n = Number((await api.git(ctx.repo, ["rev-list", "--count", `${branch}..${r.name}`]).catch(() => "0")).trim());
    if (n > 0) return t("ops.behind", { branch, remote: r.name, n });
  }
  return null;
}
/** 시작·마무리 전 공통 검사: 작업 트리가 깨끗하고 관련 브랜치가 원격보다 뒤처지지 않았는지. 문제가 있으면 오류를 띄우고 false. */
async function flowReady(branches: string[]) {
  if (ctx.status?.files.some((f) => !f.untracked)) return ctx.error(t("ops.flow.dirty")), false;
  for (const b of branches) {
    const m = await behindMsg(b);
    if (m) return ctx.error(m), false;
  }
  return true;
}

/** git의 빈 트리 SHA (커밋 없는 저장소의 diff 기준) */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const confirm = (message: string, title: string) => ask(message, { title, kind: "warning" });

import { isMac, isMobile, isWin } from "../lib/platform";
export { isMac, isWin };
/** 파일을 파일 관리자에서 선택해 보여 주는 항목의 이름 (OS별) */
export const revealLabel = () => t(isMac ? "ops.reveal.mac" : isWin ? "ops.reveal.win" : "ops.reveal.other");
/** 터미널 앱 선택지 (OS별). 첫 항목이 기본값 */
const TERMINALS = isMac ? ["Terminal", "iTerm", "Warp", "Ghostty"] : isWin ? ["cmd", "wt", "powershell"] : ["x-terminal-emulator", "gnome-terminal", "konsole", "alacritty"];
const terminalApp = () => stored<string>("terminalApp", "") || undefined;
async function openIn(what: "terminal" | "folder" | "reveal" | "open", extra: { app?: string; path?: string } = {}) {
  try {
    await api.openIn(ctx.repo, what, extra);
  } catch (e) {
    ctx.error(String(e));
  }
}

/** 외부 diff·merge 도구로 고를 수 있는 이름 (git 내장 도구 이름) */
const TOOLS = ["opendiff", "meld", "kdiff3", "vscode", "bc", "p4merge"];
const toolConfig = async (key: string) => (await api.git(ctx.repo, ["config", "--get", key]).catch(() => "")).trim();
/** vscode는 git에 실행 방법을 알려 줘야 한다 */
const VSCODE_CMD = { diff: ["difftool.vscode.cmd", 'code --wait --diff "$LOCAL" "$REMOTE"'], merge: ["mergetool.vscode.cmd", 'code --wait "$MERGED"'] };

/**
 * 끝날 때까지 기다려야 하는 GUI 도구(difftool·mergetool)를 실행한다. start_job이 아니라 별도 경로라서
 * 도구가 열려 있는 동안에도 Fetch/Pull/Push가 막히지 않는다. 종료하면 알림, 실패하면 오류.
 */
const detachedWaiting = new Map<string, (err: string | null) => void>();
let detachedListener: Promise<unknown> | null = null;
async function detached(name: string, args: string[], after?: () => void) {
  const repo = ctx.repo, token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // 이벤트 리스너는 앱 전체에 하나만 두고 token으로 구분한다 (탭 전환·작업마다 리스너가 쌓이지 않는다)
  detachedListener ??= listen<[string, string | null]>("detached-done", ({ payload: [t, err] }) => detachedWaiting.get(t)?.(err));
  await detachedListener;
  detachedWaiting.set(token, (err) => {
    detachedWaiting.delete(token);
    if (err) ctx.error(t("ops.failed", { name, err }));
    else ctx.notify(t("ops.ended", { name }));
    if (repo === ctx.repo) after?.();
  });
  ctx.notify(t("ops.running", { name }));
  try {
    await api.runDetached(repo, args, token);
  } catch (e) {
    detachedWaiting.delete(token);
    ctx.error(String(e));
  }
}

/** diff.tool/merge.tool이 설정돼 있으면 true. 없으면 안내와 함께 설정 시트를 띄우고, 저장했을 때만 true. */
async function toolReady(kind: "diff" | "merge") {
  if (await toolConfig(`${kind}.tool`)) return true;
  return ops.toolSetup(kind, t("ops.tool.missing", { kind }));
}

/** PR 목록 새로고침 신호 (Fetch 완료·계정 변경·수동 새로고침). 구독은 사이드바 PR 섹션 하나 */
const prListeners = new Set<() => void>();
export const prBus = { emit: () => prListeners.forEach((f) => f()), on: (f: () => void) => (prListeners.add(f), () => void prListeners.delete(f)) };

/** 작업 트리 변경 알림 횟수(repo-changed). 상태가 같아도 파일 내용은 바뀌었을 수 있어 diff를 다시 읽는 신호. 구독은 ChangesView 하나 */
let touchedN = 0;
const touchListeners = new Set<() => void>();
const onTouched = (f: () => void) => (touchListeners.add(f), () => void touchListeners.delete(f));
export const touch = () => (touchedN++, touchListeners.forEach((f) => f()));
export const useTouched = () => useSyncExternalStore(onTouched, () => touchedN);

const prBases = (remote: string) => ctx.refs.filter((r) => r.kind === "remote" && r.name.startsWith(remote + "/")).map((r) => r.name.slice(remote.length + 1));
/** base 기본값: 원격 HEAD(origin/HEAD) → main → master → 첫 원격 브랜치 → main */
async function prBase(remote: string, bases: string[]) {
  const sym = (await api.git(ctx.repo, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]).catch(() => "")).trim();
  const fromHead = sym.startsWith(remote + "/") ? sym.slice(remote.length + 1) : "";
  return fromHead || ["main", "master"].find((b) => bases.includes(b)) || bases[0] || "main";
}

/** 앱 전용 저장소 폴더(`repos_root`). 값이 있으면 폴더 선택기가 없는 백엔드라 복제 위치·저장소 스캔 루트를 이걸로 고정한다. 데스크탑은 null(IPC도 안 부른다) */
let rootP: Promise<string | null> | undefined;
const reposRoot = () => (rootP ??= isMobile ? api.reposRoot().catch(() => null) : Promise.resolve(null));
const customList = () => (isMobile ? [] : stored<CustomCommand[]>("customCommands", [])); // 모바일은 셸·외부 프로세스가 없다

/** 저장소 작성자 두 키를 쓴다. 중간에 실패하면 이전 값으로 되돌려 이름·이메일이 섞이지 않게 한다 */
async function writeAuthor(vals: Record<"user.name" | "user.email", string | null>) {
  const prev = await ops.cfgRead("local", AUTHOR_RE);
  try {
    for (const [k, v] of Object.entries(vals)) await ops.cfgWrite("local", k, v);
  } catch (e) {
    for (const k of Object.keys(vals)) await ops.cfgWrite("local", k, prev[k] ?? null).catch(() => {});
    throw e;
  }
}
const AUTHOR_RE = "^(user\\.(name|email))$";
export const ops = {
  // ---- 원격 ----
  fetch: () => ctx.job("Fetch", ["fetch", "--all", "--prune", "--tags", "--progress"], { remote: true }),
  // pull.rebase를 안 정해 뒀으면 갈라졌을 때 조용히 머지 커밋을 만들지 않고 멈춘다(`--ff-only`). 정해 뒀으면 그 설정을 따른다.
  pullQuick: async () => {
    const set = (await api.git(ctx.repo, ["config", "--get", "pull.rebase"]).catch(() => "")).trim();
    // 추적 브랜치를 명시한다 — branch.<b>.merge가 여러 줄이면 맨 `git pull`은 "Cannot fast-forward to multiple branches"로 멈춘다.
    const up = ctx.status?.upstream, i = up?.indexOf("/") ?? -1;
    const target = up && i > 0 ? [up.slice(0, i), up.slice(i + 1)] : [];
    ctx.job("Pull", ["pull", "--progress", ...(set ? ["--autostash"] : ["--ff-only"]), ...target], { remote: true, track: "pull" });
  },
  pull: async () => {
    const r = await prompt({
      title: "Pull",
      fields: [
        { kind: "select", name: "remote", label: t("ops.f.remote"), options: remotes() },
        { kind: "text", name: "branch", label: t("ops.f.branch"), value: head() ?? "" },
        { kind: "check", name: "rebase", label: t("ops.pull.rebase") },
        { kind: "check", name: "autostash", label: t("ops.pull.autostash"), value: true },
      ],
      submit: "Pull",
    });
    if (!r || dashed(r.remote, r.branch)) return;
    const args = ["pull", "--progress", r.rebase ? "--rebase" : "--no-rebase"];
    if (r.autostash) args.push("--autostash");
    ctx.job("Pull", [...args, String(r.remote), String(r.branch)], { remote: true, track: "pull" });
  },
  pushQuick: () => {
    const st = ctx.status;
    // 추적 브랜치가 없으면 첫 원격에 같은 이름으로 올리고 추적을 건다.
    if (st && !st.upstream && st.branch) return ctx.job("Push", ["push", "--progress", "-u", remotes()[0] ?? "origin", st.branch], { remote: true, track: "push" });
    ctx.job("Push", ["push", "--progress"], { remote: true, track: "push" });
  },
  push: async () => {
    const r = await prompt({
      title: "Push",
      fields: [
        { kind: "select", name: "branch", label: t("ops.f.branch"), options: locals(), value: head() ?? undefined },
        { kind: "select", name: "remote", label: t("ops.f.remote"), options: remotes() },
        { kind: "check", name: "track", label: t("ops.push.track"), value: !ctx.status?.upstream },
        { kind: "check", name: "tags", label: t("ops.push.tags") },
        { kind: "check", name: "force", label: t("ops.push.force") },
      ],
      submit: "Push",
      danger: (v) => !!v.force,
    });
    if (!r) return;
    if (r.force && !(await confirm(t("ops.push.forceMsg"), t("ops.push.forceTitle")))) return;
    const args = ["push", "--progress"];
    if (r.track) args.push("-u");
    if (r.tags) args.push("--tags");
    // 자동 fetch가 원격 추적 ref를 계속 당겨오므로 lease만으로는 남의 커밋을 못 막는다.
    // `--force-if-includes`: 받아온 원격 끝을 로컬에 합친 적이 없으면 거부 (lease에 sha를 주면 꺼지므로 값 없이 쓴다).
    if (r.force) args.push("--force-with-lease", "--force-if-includes");
    ctx.job("Push", [...args, String(r.remote), String(r.branch)], { remote: true, track: r.branch === head() && !r.tags ? "push" : undefined });
  },
  addRemote: async () => {
    const r = await prompt({
      title: t("ops.remote.add"),
      fields: [
        { kind: "text", name: "name", label: t("ops.f.name"), value: remotes().length ? "" : "origin" },
        { kind: "text", name: "url", label: "URL", placeholder: t("ops.f.urlPh") },
      ],
      submit: t("ops.add"),
    });
    if (r && !dashed(r.name, r.url) && (await git(["remote", "add", String(r.name), String(r.url)], t("ops.remote.added", { name: String(r.name) })))) ops.fetch();
  },
  editRemote: async (name: string) => {
    const url = (await api.git(ctx.repo, ["remote", "get-url", name]).catch(() => "")).trim();
    const r = await prompt({
      title: t("ops.remote.edit", { name }),
      fields: [
        { kind: "text", name: "name", label: t("ops.f.name"), value: name },
        { kind: "text", name: "url", label: "URL", value: url },
      ],
      submit: t("common.save"),
    });
    if (!r || dashed(r.name, r.url)) return;
    if (r.url !== url) await git(["remote", "set-url", name, String(r.url)]);
    if (r.name !== name) await git(["remote", "rename", name, String(r.name)]);
    ctx.notify(t("ops.remote.saved", { name: String(r.name) }));
  },
  removeRemote: async (name: string) => {
    if (await confirm(t("ops.remote.confirmDel", { name }), t("ops.remote.delTitle")))
      git(["remote", "remove", name], t("ops.remote.deleted", { name }));
  },

  // ---- 브랜치 ----
  checkout: async (name: string) => {
    if (name === head()) return;
    switchKeep(["switch", name], t("ops.checkout.moved", { name }));
  },
  checkoutRemote: async (remoteBranch: string) => {
    const local = remoteBranch.split("/").slice(1).join("/");
    if (locals().includes(local)) return ops.checkout(local);
    switchKeep(["switch", "-c", local, "--track", remoteBranch], t("ops.checkout.tracking", { local, remote: remoteBranch }));
  },
  checkoutCommit: async (sha: string) => {
    if (await confirm(t("ops.checkout.detachMsg"), t("ops.checkout.commitTitle")))
      switchKeep(["switch", "--detach", sha], t("ops.checkout.detached", { sha: sha.slice(0, 7) }));
  },
  createBranch: async (at?: string) => {
    const r = await prompt({
      title: t("ops.branch.new"),
      message: at ? t("ops.branch.startCommit", { sha: at.slice(0, 7) }) : t("ops.branch.startHead", { name: head() ?? "HEAD" }),
      fields: [
        { kind: "text", name: "name", label: t("ops.f.name"), placeholder: t("ops.branch.namePh") },
        { kind: "check", name: "checkout", label: t("ops.branch.checkoutAfter"), value: true },
      ],
      submit: t("ops.create"),
    });
    if (!r) return;
    const name = String(r.name).trim();
    if (dashed(name, at)) return;
    git(r.checkout ? ["switch", "-c", name, ...(at ? [at] : [])] : ["branch", name, ...(at ? [at] : [])], t("ops.branch.created", { name }));
  },
  renameBranch: async (name: string) => {
    const r = await prompt({ title: t("ops.branch.rename"), fields: [{ kind: "text", name: "name", label: t("ops.f.newName"), value: name }], submit: t("ops.rename") });
    if (r && r.name !== name && !dashed(r.name)) git(["branch", "-m", name, String(r.name)], `${name} → ${r.name}`);
  },
  deleteBranch: async (name: string) => {
    // 다른 worktree가 체크아웃한 브랜치는 git이 지우지 않는다 → worktree부터 제거
    const wt = (await api.loadWorktrees(ctx.repo).catch(() => [])).find((w) => !w.main && w.branch === name);
    const r = await prompt({
      title: t("ops.branch.delete"),
      message: t("ops.branch.deleting", { name }),
      fields: [
        { kind: "check", name: "force", label: t("ops.branch.forceDel") },
        ...(wt ? [{ kind: "check", name: "wt", label: t("ops.branch.delWorktree", { path: wt.path }), value: true } as Field] : []),
      ],
      submit: t("ops.deleteBtn"),
      danger: true,
    });
    if (!r) return;
    if (wt && r.wt && !(await git(["worktree", "remove", "--", wt.path], t("ops.wt.removed")))) return;
    if (r.force) return gitReload(["branch", "-D", name], t("ops.deleted", { name }));
    try {
      await api.git(ctx.repo, ["branch", "-d", name]);
      ctx.notify(t("ops.deleted", { name }));
    } catch (e) {
      // 머지 안 된 브랜치면 강제 삭제할지 다시 묻는다
      if (!/not fully merged/.test(String(e))) ctx.error(String(e));
      else if (await confirm(t("ops.branch.unmergedMsg", { name }), t("ops.branch.delete"))) await git(["branch", "-D", name], t("ops.deleted", { name }));
    }
    ctx.reload();
  },
  deleteRemoteBranch: async (remoteBranch: string) => {
    const [remote, ...rest] = remoteBranch.split("/");
    if (await confirm(t("ops.branch.remoteDelConfirm", { name: remoteBranch }), t("ops.branch.remoteDelTitle")))
      ctx.job("Push", ["push", "--progress", remote, "--delete", `refs/heads/${rest.join("/")}`], { remote: true });
  },
  setUpstream: async (name: string) => {
    const options = ctx.refs.filter((r) => r.kind === "remote").map((r) => r.name);
    const r = await prompt({ title: t("ops.up.title"), fields: [{ kind: "select", name: "up", label: t("ops.up.remoteBranch"), options }], submit: t("ops.set") });
    if (r) git(["branch", "--set-upstream-to", String(r.up), name], t("ops.up.done", { name, up: String(r.up) }));
  },

  // ---- 태그 ----
  createTag: async (at: string) => {
    const r = await prompt({
      title: t("ops.tag.new"),
      message: t("ops.tag.commit", { sha: at.slice(0, 7) }),
      fields: [
        { kind: "text", name: "name", label: t("ops.f.name"), placeholder: "v1.0.0" },
        { kind: "text", name: "message", label: t("ops.tag.message"), placeholder: "" },
        { kind: "check", name: "push", label: t("ops.tag.pushAfter") },
      ],
      submit: t("ops.create"),
    });
    if (!r) return;
    const name = String(r.name);
    if (dashed(name, at)) return;
    const ok = await git(r.message ? ["tag", "-a", name, "-m", String(r.message), at] : ["tag", name, at], t("ops.tag.created", { name }));
    if (ok && r.push) ctx.job("Push", ["push", "--progress", remotes()[0] ?? "origin", `refs/tags/${name}`]);
  },
  deleteTag: async (name: string) => {
    const r = await prompt({
      title: t("ops.tag.delete"),
      message: t("ops.tag.deleting", { name }),
      fields: [{ kind: "check", name: "remote", label: t("ops.tag.remoteToo") }],
      submit: t("ops.deleteBtn"),
      danger: true,
    });
    if (!r) return;
    if ((await git(["tag", "-d", name], t("ops.tag.deleted", { name }))) && r.remote)
      ctx.job("Push", ["push", "--progress", remotes()[0] ?? "origin", "--delete", `refs/tags/${name}`]);
  },
  pushTag: (name: string) => ctx.job("Push", ["push", "--progress", remotes()[0] ?? "origin", `refs/tags/${name}`]),

  // ---- 통합 ----
  merge: async (ref: string) => {
    const modes = [t("ops.merge.default"), t("ops.merge.noff"), t("ops.merge.ffOnly"), "squash"];
    const r = await prompt({
      title: t("ops.merge.title", { ref, head: head() ?? "" }),
      fields: [{ kind: "select", name: "mode", label: t("ops.f.method"), options: modes }],
      submit: t("ops.merge.submit"),
    });
    if (!r) return;
    const flag = ["", "--no-ff", "--ff-only", "--squash"][modes.indexOf(String(r.mode))];
    git(["merge", ...(flag ? [flag] : []), "--no-edit", ref], t("ops.merge.done", { ref }));
  },
  rebase: async (onto: string) => {
    if (!dashed(onto) && (await confirm(t("ops.rebase.confirm", { head: head() ?? "", onto }), "Rebase"))) git(["rebase", "--autostash", onto], t("ops.rebase.done", { onto }));
  },
  cherryPick: async (sha: string) => !dashed(sha) && git(["cherry-pick", ...(await parentFlag(sha)), sha], t("ops.cherry.done", { sha: sha.slice(0, 7) })),
  revert: async (sha: string) => !dashed(sha) && git(["revert", "--no-edit", ...(await parentFlag(sha)), sha], t("ops.revert.done", { sha: sha.slice(0, 7) })),
  /** mode를 주면(메뉴의 Soft·Mixed·Hard 하위 항목) 방식 선택창 없이 바로 실행 (hard는 확인창 유지) */
  reset: async (sha: string, picked?: "--soft" | "--mixed" | "--hard") => {
    const modes = [t("ops.reset.soft"), t("ops.reset.mixed"), t("ops.reset.hard")];
    const r = picked
      ? {}
      : await prompt({
          title: t("ops.reset.title", { head: head() ?? "", sha: sha.slice(0, 7) }),
          fields: [{ kind: "select", name: "mode", label: t("ops.f.method"), options: modes, value: modes[1] }],
          submit: "Reset",
          danger: (v) => v.mode === modes[2],
        });
    if (!r || dashed(sha)) return;
    const mode = picked ?? ["--soft", "--mixed", "--hard"][modes.indexOf(String((r as { mode?: unknown }).mode))];
    if (mode === "--hard" && !(await confirm(t("ops.reset.hardConfirm"), "Hard reset"))) return;
    git(["reset", mode, sha], t("ops.reset.done", { sha: sha.slice(0, 7) }));
  },
  /** 진행 중인 merge/rebase/cherry-pick/revert/am 계속·건너뛰기·중단 */
  continueOp: (op: string) => git(op === "merge" ? ["commit", "--no-edit"] : ["-c", "core.editor=true", op, "--continue"], t("ops.continued")),
  /** 지금 멈춘 커밋 하나를 버리고 다음으로 (rebase·cherry-pick·revert·am) */
  skipOp: async (op: string) => {
    if (await confirm(t("ops.skip.confirm"), t("ops.skip.title"))) git([op, "--skip"], t("ops.skip.done"));
  },
  abortOp: async (op: string) => {
    if (await confirm(t("ops.abort.confirm", { op }), t("ops.abort.title"))) git([op, "--abort"], t("ops.abort.done", { op }));
  },

  /** 충돌 파일을 한쪽 버전으로 정하고 해결됨으로 표시 */
  resolveWith: async (path: string, side: "ours" | "theirs") => {
    if (await git(["checkout", `--${side}`, "--", path])) git(["add", "--", path], t(side === "ours" ? "ops.resolve.ours" : "ops.resolve.theirs", { path }));
  },
  markResolved: (path: string) => git(["add", "--", path], t("ops.resolved", { path })),
  /** 충돌 파일을 외부 merge 도구(git config merge.tool)로 해결. 도구가 끝나면 상태를 다시 읽는다. */
  mergeTool: async (path: string) => {
    // 한쪽이 삭제한 충돌·심볼릭 링크 충돌은 mergetool이 대화형으로 물어서 GUI에서는 멈춘다 → 미리 걸러 안내한다
    const u = (await api.git(ctx.repo, ["ls-files", "-u", "--", path]).catch(() => "")).split("\n").filter(Boolean).map((l) => l.split(/\s+/));
    const stages = new Set(u.map((x) => x[2]));
    if (u.some((x) => x[0] === "120000") || (stages.has("1") && !(stages.has("2") && stages.has("3"))))
      return ctx.error(t("ops.mergeTool.unsupported", { path }));
    if (await toolReady("merge")) detached(t("ops.tool.mergeName"), ["mergetool", "-y", "--", path], ctx.reload);
  },
  /** 작업 디렉터리 변경(스테이지됨이면 --cached)을 외부 diff 도구(git config diff.tool)로 연다. */
  difftoolChanges: async (path: string, staged: boolean) => {
    if (await toolReady("diff")) detached(t("ops.tool.diffName"), ["difftool", "-y", ...(staged ? ["--cached"] : []), "--", path]);
  },
  /** 커밋이 바꾼 파일을 첫 부모와 비교해 외부 diff 도구로 연다 (루트 커밋은 빈 트리와). */
  difftoolCommit: async (sha: string, path: string) => {
    if (!(await toolReady("diff"))) return;
    const base = ctx.commits.find((c) => c.id === sha)?.parents.length ? `${sha}^` : EMPTY_TREE;
    detached(t("ops.tool.diffName"), ["difftool", "-y", base, sha, "--", path]);
  },
  /** 도구 선택 시트 → 전역 git 설정. only를 주면 그 종류만(없으면 둘 다). 저장하면 true. */
  toolSetup: async (only?: "diff" | "merge", note?: string) => {
    if (!ctx.repo) return false;
    const kinds = only ? [only] : (["diff", "merge"] as const);
    const cur = await Promise.all(kinds.map((k) => toolConfig(`${k}.tool`)));
    const dflt = isMac ? "opendiff" : isWin ? "vscode" : "meld";
    const r = await prompt({
      title: t("ops.tool.title"),
      message: note ?? t("ops.tool.note"),
      fields: kinds.map((k, i) => {
        const options = !cur[i] || TOOLS.includes(cur[i]) ? TOOLS : [cur[i], ...TOOLS];
        return { kind: "select" as const, name: k, label: t(k === "diff" ? "ops.tool.diff" : "ops.tool.merge"), options, value: cur[i] || dflt };
      }),
      submit: t("common.save"),
    });
    if (!r) return false;
    try {
      for (const k of kinds) {
        const tool = String(r[k]);
        await api.git(ctx.repo, ["config", "--global", `${k}.tool`, tool]);
        if (tool === "vscode") await api.git(ctx.repo, ["config", "--global", ...VSCODE_CMD[k]]);
      }
      ctx.notify(t("ops.tool.saved"));
      return true;
    } catch (e) {
      ctx.error(String(e));
      return false;
    }
  },

  // ---- 열기 (터미널·폴더·파일) ----
  openTerminal: () => openIn("terminal", { app: terminalApp() }),
  openFolder: () => openIn("folder"),
  /** 파일 관리자에서 파일을 선택해 보여 준다 (macOS `open -R`, Windows `explorer /select,`, Linux는 폴더) */
  reveal: (path: string) => openIn("reveal", { path }),
  openDefault: (path: string) => openIn("open", { path }),
  /** VS Code 모드: 확장이 diff 에디터로 연다 (rev 없으면 작업 파일) */
  openInEditor: (path: string, rev: string | null, line?: number) => openFile(ctx.repo, path, rev ?? undefined, line),
  chooseTerminal: async () => {
    const cur = terminalApp() ?? TERMINALS[0];
    const r = await prompt({
      title: t("ops.term.title"),
      message: t("ops.term.note"),
      fields: [{ kind: "select", name: "app", label: t("ops.f.app"), options: TERMINALS.includes(cur) ? TERMINALS : [cur, ...TERMINALS], value: cur }],
      submit: t("common.save"),
    });
    if (r) store("terminalApp", String(r.app));
  },

  // ---- 스태시 ----
  stash: async () => {
    const r = await prompt({
      title: t("ops.stash.title"),
      fields: [
        { kind: "text", name: "message", label: t("ops.f.message"), value: t("ops.stash.default") },
        { kind: "check", name: "untracked", label: t("ops.stash.untracked"), value: true },
        { kind: "check", name: "keep", label: t("ops.stash.keep") },
      ],
      submit: t("ops.stash.title"),
    });
    if (!r) return;
    const args = ["stash", "push", "-m", String(r.message)];
    if (r.untracked) args.push("--include-untracked");
    if (r.keep) args.push("--keep-index");
    git(args, t("ops.stash.done"));
  },
  /** 변경 파일을 OS 휴지통으로 (되살릴 수 있음). 확인 후 실행, 오류는 코드 번역으로 표시 */
  trashFiles: async (paths: string[]) => {
    const names = paths.length === 1 ? paths[0] : t("changes.nFiles", { n: paths.length });
    if (!(await confirm(t("ops.trash.ask", { names }), t("ops.trash.title")))) return;
    try {
      await api.trashFiles(ctx.repo, paths);
      ctx.notify(t("ops.trash.done"));
    } catch (e) {
      ctx.error(String(e));
    }
    ctx.reload();
  },
  /** 그 커밋(rev)의 버전으로 파일을 되돌린다: 작업 트리·스테이지의 이 파일 변경을 덮어쓴다 */
  restoreFile: async (path: string, rev: string) => {
    if (!(await confirm(t("ops.restore.ask", { path, rev: rev.slice(0, 7) }), t("ops.restore.title")))) return;
    try {
      await api.restoreFile(ctx.repo, rev, [path]);
      ctx.notify(t("ops.restore.done", { path }));
    } catch (e) {
      ctx.error(String(e));
    }
    ctx.reload();
  },
  stashFiles: async (paths: string[]) => {
    const r = await prompt({ title: t("ops.stashFiles.title"), message: t("ops.files.n", { n: paths.length }), fields: [{ kind: "text", name: "message", label: t("ops.f.message"), value: t("ops.stashFiles.default") }], submit: t("ops.stash.title") });
    if (r) git(["stash", "push", "--include-untracked", "-m", String(r.message), "--", ...paths], t("ops.stash.done"));
  },
  pop: (name = "stash@{0}") => stashGit(["stash", "pop", name], t("ops.stash.popped")),
  applyStash: (name: string) => stashGit(["stash", "apply", name], t("ops.stash.applied")),
  renameStash: async (name: string, message: string | null) => {
    const r = await prompt({ title: t("ops.stash.rename"), fields: [{ kind: "text", name: "message", label: t("ops.f.message"), value: message ?? "" }], submit: t("ops.rename") });
    if (!r) return;
    // git에는 이름 변경이 없어서: 같은 커밋을 새 메시지로 다시 저장하고 원래 항목을 지운다.
    // 먼저 저장하고(실패해도 원본이 남는다) 그 뒤 한 칸 밀린 원래 항목을 지운다.
    const sha = (await api.git(ctx.repo, ["rev-parse", name]).catch((e) => (ctx.error(String(e)), ""))).trim();
    const n = /^stash@\{(\d+)\}$/.exec(name)?.[1];
    if (sha && n && (await git(["stash", "store", "-m", String(r.message), sha]))) git(["stash", "drop", `stash@{${Number(n) + 1}}`], t("ops.stash.renamed"));
  },
  dropStash: async (name: string) => {
    if (await confirm(t("ops.stash.dropConfirm", { name }), t("ops.stash.dropTitle"))) stashGit(["stash", "drop", name], t("ops.stash.dropped"));
  },

  /** 스냅샷: 작업 디렉터리는 그대로 두고 현재 변경을 스태시 목록에 남긴다 (`stash create` → `stash store`). 추적 중인 파일의 변경만 담긴다. */
  snapshot: async () => {
    try {
      const sha = (await api.git(ctx.repo, ["stash", "create"])).trim();
      if (!sha) return ctx.notify(t("ops.snap.none"));
      const d = new Date(), p2 = (n: number) => String(n).padStart(2, "0");
      const when = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
      await api.git(ctx.repo, ["stash", "store", "-m", `Snapshot: ${when}`, sha]);
      ctx.notify(t("ops.snap.saved"));
    } catch (e) {
      ctx.error(String(e));
    }
  },

  // ---- 패치 ----
  /** 커밋을 패치 파일로: format-patch를 고른 폴더에 저장. toHead면 이 커밋부터 현재 브랜치 끝(HEAD)까지(이 커밋이 HEAD의 조상일 때만). */
  savePatchCommits: async (id: string, toHead = false) => {
    let args = ["-1", id];
    if (toHead) {
      // 조상 ⇔ merge-base(id, HEAD) == id (공통 조상 없음 = 종료 1). git 실패는 "브랜치에 없음"으로 오판하지 않고 알린다
      const base = await api.git(ctx.repo, ["merge-base", id, "HEAD"], [1]).catch((e) => (ctx.error(String(e)), null));
      if (base === null) return;
      if (base.trim() !== id) return ctx.notify(t("ops.patch.notInBranch"));
      // 루트 커밋이면 `id^`가 없다(종료 1): 이때만 --root (전체 이력이 곧 id부터의 범위)
      const parent = await api.git(ctx.repo, ["rev-parse", "--verify", "-q", `${id}^`], [1]).catch((e) => (ctx.error(String(e)), null));
      if (parent === null) return;
      const hasParent = !!parent.trim();
      args = hasParent ? [`${id}^..HEAD`] : ["--root", "HEAD"];
    }
    const dir = await api.pickFolder(t("ops.patch.folder"));
    if (!dir) return;
    try {
      const files = (await api.git(ctx.repo, ["format-patch", "-o", dir, ...args])).split("\n").filter(Boolean);
      ctx.notify(t("ops.patch.savedN", { n: files.length, dir }), { kind: "success" });
    } catch (e) {
      ctx.error(String(e));
    }
  },
  /** 작업 디렉터리 변경을 .patch 파일로(diff --binary). 담을 변경이 없으면 파일을 만들지 않고 안내한다. 추적 안 하는 파일은 담기지 않는다. paths를 주면 그 파일만. */
  savePatchChanges: async (scope: "staged" | "unstaged" | "all", paths: string[] = []) => {
    // 커밋이 없는 저장소는 HEAD 대신 빈 트리 기준
    const hasHead = await api.git(ctx.repo, ["rev-parse", "--verify", "-q", "HEAD"]).then(() => true, () => false);
    const base = { staged: ["--cached"], unstaged: [], all: [hasHead ? "HEAD" : EMPTY_TREE] }[scope];
    const tail = paths.length ? ["--", ...paths] : [];
    // diff --quiet: 차이가 없으면 종료 코드 0, 있으면 1(오류로 온다)
    if (await api.git(ctx.repo, ["diff", "--quiet", ...base, ...tail]).then(() => true, () => false))
      return ctx.notify(t("ops.patch.noChanges"));
    const file = await api.pickSave(t("ops.patch.saveTitle"), `${{ staged: "staged", unstaged: "unstaged", all: "changes" }[scope]}.patch`);
    if (!file) return;
    await git(["diff", "--binary", ...DIFF, `--output=${file}`, ...base, ...tail], t("ops.patch.saved", { file }));
  },
  /** 패치 적용. 메일 형식(format-patch)은 `am --3way`, 일반 diff는 `apply --check`로 먼저 검사한 뒤 `apply`. */
  applyPatch: async () => {
    const file = await api.pickPatch();
    if (!file) return;
    if (await api.patchIsMail(file).catch(() => false)) {
      if (await git(["am", "--3way", file], t("ops.patch.appliedAm"))) return;
      // 실패 로그는 git()이 이미 띄웠다. 충돌이면 해결 바(status.operation)가 뜬다.
      const st = await api.loadStatus(ctx.repo).catch(() => null);
      if (st?.operation === "am") ctx.error(t("ops.patch.amConflict"));
      return;
    }
    const r = await prompt({
      title: t("ops.patch.apply"),
      message: file,
      fields: [
        { kind: "check", name: "index", label: t("ops.patch.index") },
        { kind: "check", name: "threeway", label: t("ops.patch.threeway") },
      ],
      submit: t("common.apply"),
    });
    if (!r) return;
    const opt = r.threeway ? ["--3way"] : r.index ? ["--index"] : [];
    try {
      await api.git(ctx.repo, ["apply", "--check", ...opt, file]);
    } catch (e) {
      return ctx.error(t("ops.patch.cantApply", { e: String(e), hint: r.threeway ? "" : t("ops.patch.hint3way") }));
    }
    await git(["apply", ...opt, file], t("ops.patch.applied"));
  },

  /** .gitignore에 경로 추가 */
  ignore: async (path: string) => {
    const r = await prompt({ title: t("ops.ignore.title"), fields: [{ kind: "text", name: "pattern", label: t("ops.ignore.pattern"), value: path }], submit: t("ops.add") });
    if (!r) return;
    await api.appendLine(ctx.repo, ".gitignore", String(r.pattern)).then(() => ctx.notify(t("ops.ignore.done", { pattern: String(r.pattern) })), (e) => ctx.error(String(e)));
  },

  // ---- 저장소 관리 ----
  clone: async () => {
    // gh에 로그인된 계정이 여럿이면 어느 계정으로 받을지 고른다(https만). 고르면 복제한 저장소에 그 계정을 연결한다
    const gh = await api.ghAccounts().catch(() => null);
    const users = gh?.installed ? gh.hosts.flatMap((h) => h.accounts.map((a) => ({ host: h.host, user: a.user }))) : [];
    const label = (a: { host: string; user: string }) => (gh!.hosts.length > 1 ? `${a.user} (${a.host})` : a.user);
    // 폴더 선택기가 없는 백엔드(Android)는 앱 전용 저장소 폴더에 고정: 위치 입력 없이 폴더 경로만 안내한다
    const root = await reposRoot();
    const r = await prompt({
      title: t("ops.clone.title"),
      message: root ?? undefined,
      fields: [
        { kind: "text", name: "url", label: "URL", placeholder: root ? "https://github.com/…" : t("ops.f.urlPh") }, // 모바일(앱 폴더 고정)은 ssh 키가 없어 https만
        ...(root ? [] : [{ kind: "folder" as const, name: "dir", label: t("ops.f.location"), value: stored("cloneDir", "") }]),
        { kind: "text", name: "name", label: t("ops.f.name") },
        ...(users.length > 1 ? [{ kind: "select" as const, name: "account", label: t("ops.clone.account"), options: [t("ops.clone.accountActive"), ...users.map(label)] }] : []),
      ],
      // 이름을 직접 고치기 전까지는 URL에서 추정
      change: (v, prev) => (v.url !== prev.url && prev.name === repoName(String(prev.url)) ? { ...v, name: repoName(String(v.url)) } : v),
      submit: t("ops.clone"),
    });
    if (!r) return;
    const dir = root ?? String(r.dir), name = String(r.name).trim(), url = String(r.url).trim();
    if (dashed(url, name)) return;
    if (!root) store("cloneDir", dir);
    const user = users.find((a) => label(a) === r.account)?.user;
    const open = () => ctx.open(join(dir, name));
    ctx.job(t("ops.clone"), ["clone", "--progress", "--", url, name], { repo: dir, ghUser: user, onDone: user ? () => void api.ghBind(join(dir, name), user).catch((e) => ctx.error(String(e))).finally(open) : open });
  },
  init: async () => {
    const r = await prompt({
      title: t("ops.init.title"),
      fields: [
        { kind: "folder", name: "dir", label: t("ops.f.location"), value: stored("cloneDir", "") },
        { kind: "text", name: "name", label: t("ops.f.name") },
      ],
      submit: t("ops.create"),
    });
    if (!r) return;
    const dir = String(r.dir), name = String(r.name).trim();
    try {
      await api.git(dir, ["init", name]);
      ctx.open(join(dir, name));
    } catch (e) {
      ctx.error(String(e));
    }
  },
  scan: async () => {
    const root = (await reposRoot()) ?? (await api.pickFolder(t("ops.scan.folder"))); // 앱 전용 저장소 폴더가 있으면(Android) 선택 없이 거기를 스캔
    if (!root) return;
    try {
      const found = await api.findRepos(root);
      ctx.addRepos(found);
      ctx.notify(t("ops.scan.found", { n: found.length }));
    } catch (e) {
      ctx.error(String(e));
    }
  },
  /** 모바일 시작 때 앱 전용 저장소 폴더의 저장소를 목록에 올린다 (알림·선택 없음) */
  scanRoot: async () => {
    const root = await reposRoot();
    if (root) ctx.addRepos(await api.findRepos(root).catch(() => []));
  },

  // ---- 탭 이동 (⌘⌥←/→·빠른 실행). 양끝에서는 멈춘다 ----
  tabStep: (dir: 1 | -1) => {
    const to = ctx.tabs[ctx.tabs.indexOf(ctx.activeTab) + dir];
    if (to) ctx.open(to);
  },

  // ---- 작업공간 (탭 묶음) ----
  workspaceNames: () => Object.keys(workspaces()),
  saveWorkspace: async () => {
    if (!ctx.tabs.length) return;
    const r = await prompt({ title: t("ops.ws.save"), message: t("ops.ws.tabs", { n: ctx.tabs.length }), fields: [{ kind: "text", name: "name", label: t("ops.f.name") }], submit: t("common.save") });
    if (!r) return;
    const name = String(r.name).trim();
    store("workspaces", { ...workspaces(), [name]: ctx.tabs });
    ctx.notify(t("ops.ws.saved", { name }));
  },
  openWorkspace: (name: string) => {
    const tabs = workspaces()[name];
    if (tabs?.length) ctx.setTabs(tabs);
  },
  deleteWorkspace: async (name: string) => {
    if (!(await confirm(t("ops.ws.delConfirm", { name }), t("ops.ws.delTitle")))) return;
    const { [name]: _, ...rest } = workspaces();
    store("workspaces", rest);
    ctx.notify(t("ops.ws.deleted", { name }));
  },

  // ---- 서브모듈 ----
  openSubmodule: (path: string) => ctx.open(join(ctx.repo, path)),
  updateSubmodules: (path?: string) =>
    ctx.job(t("ops.sub.update"), ["submodule", "update", "--init", "--recursive", ...(path ? ["--", path] : [])]),
  addSubmodule: async () => {
    const r = await prompt({
      title: t("ops.sub.add"),
      fields: [
        { kind: "text", name: "url", label: "URL", placeholder: t("ops.f.urlPh") },
        { kind: "text", name: "path", label: t("ops.f.path") },
      ],
      change: (v, prev) => (v.url !== prev.url && prev.path === repoName(String(prev.url)) ? { ...v, path: repoName(String(v.url)) } : v),
      submit: t("ops.add"),
    });
    if (r) ctx.job(t("ops.sub.add"), ["submodule", "add", "--", String(r.url).trim(), String(r.path).trim()]);
  },
  syncSubmodules: () => gitReload(["submodule", "sync", "--recursive"], t("ops.sub.synced")),
  removeSubmodule: async (path: string) => {
    if (!(await confirm(t("ops.sub.rmConfirm", { path }), t("ops.sub.rmTitle")))) return;
    // 이름은 .gitmodules의 submodule.<이름>.path 로 찾는다 (이름과 경로가 다를 수 있다). rm 뒤에는 항목이 사라지므로 먼저 읽는다.
    const list = await api.git(ctx.repo, ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"]).catch(() => "");
    const line = list.split("\n").find((l) => l.endsWith(" " + path));
    const name = line?.split(" ")[0].slice("submodule.".length, -".path".length);
    if (!(await git(["submodule", "deinit", "-f", "--", path]))) return;
    if (!(await git(["rm", "-f", "--", path]))) return void ctx.reload();
    try {
      if (name) await api.removeGitDir(ctx.repo, (await api.git(ctx.repo, ["rev-parse", "--git-path", `modules/${name}`])).trim());
      ctx.notify(t("ops.sub.removed", { path }));
    } catch (e) {
      ctx.error(String(e));
    }
    ctx.reload();
  },

  // ---- Worktree ----
  openWorktree: (path: string) => ctx.open(path),
  addWorktree: async () => {
    const r = await prompt({
      title: t("ops.wt.add"),
      message: t("ops.wt.addMsg"),
      fields: [
        { kind: "folder", name: "path", label: t("ops.f.location"), value: `${ctx.repo.replace(/[\\/]+$/, "")}-worktree` },
        { kind: "text", name: "branch", label: t("ops.f.branch"), placeholder: t("ops.wt.branchPh"), optional: true },
      ],
      submit: t("ops.add"),
    });
    if (!r) return;
    const path = String(r.path).trim(), branch = String(r.branch).trim();
    const onRemote = ctx.refs.some((x) => x.kind === "remote" && x.name.split("/").slice(1).join("/") === branch);
    const args = !branch
      ? ["worktree", "add", "--detach", "--", path]
      : locals().includes(branch) || onRemote
        ? ["worktree", "add", "--", path, branch] // 원격에만 있으면 git이 추적 브랜치로 만든다
        : ["worktree", "add", "-b", branch, "--", path];
    gitReload(args, t("ops.wt.added"));
  },
  removeWorktree: async (path: string) => {
    const r = await prompt({
      title: t("ops.wt.remove"),
      message: t("ops.wt.removeMsg", { path }),
      fields: [{ kind: "check", name: "force", label: t("ops.wt.force") }],
      submit: t("ops.remove"),
      danger: true,
    });
    if (r) gitReload(["worktree", "remove", ...(r.force ? ["--force"] : []), "--", path], t("ops.wt.removed"));
  },
  lockWorktree: (path: string) => gitReload(["worktree", "lock", "--", path], t("ops.wt.locked")),
  unlockWorktree: (path: string) => gitReload(["worktree", "unlock", "--", path], t("ops.wt.unlocked")),
  pruneWorktrees: () => gitReload(["worktree", "prune"], t("ops.wt.pruned")),

  // ---- Git LFS (설치 안 됐으면 안내만) ----
  lfsStatus: () => ctx.showLfs(),
  repoStats: () => ctx.showStats(),
  lfsPull: async () => (await lfsReady()) && ctx.job("LFS Pull", ["lfs", "pull"]),
  lfsFetch: async () => (await lfsReady()) && ctx.job("LFS Fetch", ["lfs", "fetch"]),
  /** 현재 브랜치의 추적 원격으로 올린다. 추적 브랜치가 없으면 안내만 한다. */
  lfsPush: async () => {
    if (!(await lfsReady())) return;
    const up = ctx.status?.upstream, branch = ctx.status?.branch;
    const remote = up && remotes().find((r) => up.startsWith(r + "/"));
    if (!remote || !branch) return ctx.error(t("ops.lfs.noUpstream"));
    ctx.job("LFS Push", ["lfs", "push", remote, branch]);
  },
  /** 패턴 추적 시작. .gitattributes가 바뀌므로 커밋이 필요하다는 안내를 붙인다. */
  lfsTrack: async (pattern?: string) => {
    if (!(await lfsReady())) return false;
    const r = await prompt({
      title: t("ops.lfs.track"),
      message: t("ops.lfs.trackMsg"),
      fields: [{ kind: "text", name: "pattern", label: t("ops.f.pattern"), value: pattern ?? "", placeholder: "*.psd" }],
      submit: t("ops.lfs.trackBtn"),
    });
    return !!r && git(["lfs", "track", String(r.pattern).trim()], t("ops.lfs.tracking", { pattern: String(r.pattern) }));
  },
  /** 변경 파일의 확장자(없으면 경로)를 기본 패턴으로 */
  lfsTrackFile: (path: string) => ops.lfsTrack(/\.[^./\\]+$/.test(path) ? "*" + path.slice(path.lastIndexOf(".")) : path),
  lfsUntrack: async (pattern?: string) => {
    if (!(await lfsReady())) return false;
    let p = pattern;
    if (!p) {
      const tracked = (await api.lfsStatus(ctx.repo)).tracked;
      if (!tracked.length) return void ctx.error(t("ops.lfs.noneTracked"));
      const r = await prompt({ title: t("ops.lfs.untrack"), fields: [{ kind: "select", name: "pattern", label: t("ops.f.pattern"), options: tracked }], submit: t("ops.lfs.untrackBtn"), danger: true });
      if (!r) return false;
      p = String(r.pattern);
    }
    return git(["lfs", "untrack", p], t("ops.lfs.untracked", { pattern: p }));
  },

  // ---- Git Flow (git-flow 확장 없이 기본 git 명령으로) ----
  flowLoad: async (repo: string) => {
    const c = await readFlow(repo);
    if (repo === ctx.repo) ctx.flow = c;
  },
  /** 이름이 설정된 접두사로 시작하면 그 종류 */
  flowKind: (branch: string): FlowKind | null => {
    const c = ctx.flow;
    return (c && (["feature", "release", "hotfix"] as const).find((k) => c[k] && branch.startsWith(c[k]))) || null;
  },
  /** 툴바·빠른 실행 메뉴 항목. 초기화 전에는 t("ops.flow.initMenu")만. */
  flowMenu: (): MenuEntry[] => {
    if (!ctx.flow) return [{ label: t("ops.flow.initMenu"), op: FLOW_OPS, action: ops.flowInit }];
    const cur = head(), kind = cur ? ops.flowKind(cur) : null;
    return [
      { label: t("ops.flow.startFeature"), op: FLOW_OPS, action: () => ops.flowStart("feature") },
      { label: t("ops.flow.startRelease"), op: FLOW_OPS, action: () => ops.flowStart("release") },
      { label: t("ops.flow.startHotfix"), op: FLOW_OPS, action: () => ops.flowStart("hotfix") },
      ...(kind ? [{ separator: true } as MenuEntry, { label: `Finish ${kind}: ${cur}…`, op: FLOW_OPS, action: () => ops.flowFinish(cur!) }] : []),
    ];
  },
  flowInit: async () => {
    const f = ctx.flow, names = locals();
    let v = {
      master: f?.master ?? (names.includes("main") || !names.includes("master") ? "main" : "master"),
      develop: f?.develop ?? "develop", feature: f?.feature ?? "feature/", release: f?.release ?? "release/", hotfix: f?.hotfix ?? "hotfix/", tag: f?.tag ?? "",
    };
    let note = "";
    for (;;) {
      const r = await prompt({
        title: t("ops.flow.initTitle"),
        message: note || t("ops.flow.initMsg"),
        fields: [
          { kind: "text", name: "master", label: t("ops.flow.master"), value: v.master },
          { kind: "text", name: "develop", label: t("ops.flow.develop"), value: v.develop },
          { kind: "text", name: "feature", label: t("ops.flow.pfFeature"), value: v.feature },
          { kind: "text", name: "release", label: t("ops.flow.pfRelease"), value: v.release },
          { kind: "text", name: "hotfix", label: t("ops.flow.pfHotfix"), value: v.hotfix },
          { kind: "text", name: "tag", label: t("ops.flow.pfTag"), value: v.tag, optional: true },
        ],
        submit: t("ops.flow.initBtn"),
      });
      if (!r) return;
      const c = Object.fromEntries(Object.keys(FLOW_KEYS).map((k) => [k, String(r[k]).trim()])) as unknown as FlowConfig;
      v = c;
      if (!names.includes(c.master)) {
        note = t("ops.flow.noMaster", { name: c.master });
        continue;
      }
      const steps = [
        ...(names.includes(c.develop) ? [] : [["branch", c.develop, c.master]]),
        ...(Object.keys(FLOW_KEYS) as (keyof FlowConfig)[]).map((k) => ["config", FLOW_KEYS[k], c[k]]),
      ];
      if (await runSteps(steps, t("ops.flow.initDone"))) ctx.flow = c;
      return;
    }
  },
  flowStart: async (kind: FlowKind) => {
    const c = ctx.flow;
    if (!c) return ops.flowInit();
    const base = kind === "hotfix" ? c.master : c.develop;
    const r = await prompt({
      title: t("ops.flow.startTitle", { kind: FLOW_NAME[kind] }),
      message: t("ops.flow.startMsg", { base, prefix: c[kind] }),
      fields: [{ kind: "text", name: "name", label: kind === "feature" ? t("ops.f.name") : t("ops.flow.version") }],
      submit: t("ops.flow.startBtn"),
    });
    if (!r) return;
    const name = String(r.name).trim();
    if (!name) return ctx.error(t("ops.flow.needName"));
    const branch = c[kind] + name;
    if (!(await flowReady([base]))) return;
    runSteps([["switch", "-c", branch, base]], t("ops.flow.started", { branch }));
  },
  /** feature: develop에 머지 / release·hotfix: 운영 브랜치에 머지 → 태그 → develop에 머지. 충돌 나면 거기서 멈춘다. */
  flowFinish: async (branch: string) => {
    const c = ctx.flow, kind = ops.flowKind(branch);
    if (!c || !kind) return ctx.error(t("ops.flow.notFlow"));
    const version = branch.slice(c[kind].length), tag = c.tag + version;
    if (!version) return ctx.error(t("ops.flow.noVersion"));
    // hotfix는 열려 있는 release 브랜치가 있으면 develop 대신 거기에 머지한다(git-flow AVH와 같다).
    const rel = kind === "hotfix" ? locals().filter((n) => n.startsWith(c.release) && n !== branch).sort()[0] : undefined;
    const back = rel ?? c.develop;
    const to = kind === "feature" ? [c.develop] : [c.master, back];
    // 아무 단계도 실행하기 전에 확인한다
    if (kind !== "feature" && (await api.git(ctx.repo, ["rev-parse", "-q", "--verify", `refs/tags/${tag}`]).then(() => true, () => false)))
      return ctx.error(t("ops.flow.tagExists", { tag }));
    if (!(await flowReady([branch, ...to]))) return;
    const fields: Field[] = kind === "feature" ? [] : [{ kind: "text", name: "message", label: t("ops.flow.tagMsg"), value: `${FLOW_NAME[kind]} ${version}` }];
    const r = await prompt({
      title: t("ops.flow.finishTitle", { kind: FLOW_NAME[kind] }),
      message: kind === "feature" ? t("ops.flow.finishFeature", { branch, develop: c.develop }) : t("ops.flow.finishOther", { branch, master: c.master, tag, back }),
      fields: [...fields, { kind: "check", name: "del", label: t("ops.flow.delAfter"), value: true }],
      submit: t("ops.flow.finishBtn"),
    });
    if (!r) return;
    const merge = (t: string) => [["switch", t], ["merge", "--no-ff", "--no-edit", branch]];
    runSteps(
      [
        ...(kind === "feature" ? merge(c.develop) : [...merge(c.master), ["tag", "-a", "-m", String(r.message), tag], ...merge(back)]),
        ...(r.del ? [["branch", "-d", branch]] : []),
      ],
      t("ops.flow.finished", { branch }),
    );
  },

  // ---- 사용자 정의 명령 (localStorage `customCommands`, 모든 저장소 공통) ----
  /** 우클릭 메뉴에 붙일 항목: 이 대상용 명령이 있을 때만 구분선 + 항목들. vals는 그 대상의 변수 값. */
  customMenu: (target: CustomTarget, vals: Omit<CustomVars, "repo"> = {}): MenuEntry[] => {
    const list = customList().filter((c) => c.target === target);
    return list.length ? [{ separator: true }, ...list.map((c) => ({ label: c.name, action: () => ops.runCustom(c, vals) }))] : [];
  },
  /** 빠른 실행 항목: 저장소 대상 + 현재 브랜치·HEAD 커밋 기준 명령 (파일 대상은 파일 우클릭에서만) */
  customQuick: () => {
    const sha = ctx.refs.find((r) => r.head)?.target, branch = head() ?? undefined;
    const hint = { repo: t("ops.custom.hint"), commit: t("ops.custom.hintCommit"), branch: t("ops.custom.hintBranch"), file: "" };
    return customList()
      .filter((c) => c.target !== "file" && (c.target !== "commit" || sha) && (c.target !== "branch" || branch))
      .map((c) => ({ label: t("ops.custom.run", { name: c.name }), hint: hint[c.target], run: () => ops.runCustom(c, c.target === "commit" ? { sha } : c.target === "branch" ? { branch } : {}) }));
  },
  /** 변수를 치환해 실행. git은 start_job, 셸은 start_shell(값을 셸 인용). 확인을 켠 명령은 최종 명령을 보여 주고 묻는다. */
  runCustom: async (c: CustomCommand, vals: Omit<CustomVars, "repo"> = {}) => {
    const vars: CustomVars = { repo: ctx.repo, sha: vals.sha, file: vals.file, branch: vals.branch ?? head() ?? undefined };
    let b;
    try {
      b = build(c, vars, isWin);
    } catch (e) {
      return ctx.error(`${c.name}: ${e instanceof Error ? e.message : e}`);
    }
    if (b.args && !b.args.length) return ctx.error(t("ops.custom.emptyArgs", { name: c.name }));
    const shown = b.shell ?? "git " + b.args!.join(" ");
    if (c.confirm && !(await confirm(t("ops.custom.confirm", { name: c.name, shown }), t("ops.custom.title")))) return;
    if (b.shell) ctx.job(c.name, [], { shell: b.shell });
    else ctx.job(c.name, b.args!);
  },
  /** 관리 시트: 목록에서 고르면 편집(저장·삭제), '새 명령 추가'로 추가. 목록에서 취소하면 닫힌다. */
  manageCustom: async () => {
    const NEW = t("ops.custom.new");
    for (;;) {
      const list = customList();
      const TL = targetLabels(), KL = kindLabels();
      const label = (c: CustomCommand) => `${c.name} (${TL[c.target]})`;
      const pick = await prompt({
        title: t("ops.custom.title"),
        message: t("ops.custom.manageMsg"),
        fields: [{ kind: "select", name: "pick", label: t("ops.custom.command"), options: [NEW, ...list.map(label)] }],
        submit: t("ops.edit"),
      });
      if (!pick) return;
      const cur = list.find((c) => label(c) === pick.pick);
      const inv = <T extends string>(m: Record<T, string>, v: unknown) => (Object.keys(m) as T[]).find((k) => m[k] === v)!;
      const r = await prompt({
        title: cur ? t("ops.custom.edit") : t("ops.custom.newTitle"),
        message: t("ops.custom.quoteMsg"),
        fields: [
          { kind: "text", name: "name", label: t("ops.f.name"), value: cur?.name },
          { kind: "select", name: "target", label: t("ops.custom.target"), options: Object.values(TL), value: TL[cur?.target ?? "repo"] },
          { kind: "select", name: "kind", label: t("ops.custom.kind"), options: Object.values(KL), value: KL[cur?.kind ?? "git"] },
          { kind: "text", name: "command", label: t("ops.custom.command"), value: cur?.command, placeholder: "log --oneline ${sha}" },
          { kind: "check", name: "confirm", label: t("ops.custom.confirmBefore"), value: cur?.confirm ?? false },
          ...(cur ? [{ kind: "check" as const, name: "del", label: t("ops.custom.delThis") }] : []),
        ],
        submit: t("common.save"),
      });
      if (!r) continue;
      if (cur && r.del) {
        store("customCommands", list.filter((c) => c !== cur));
        ctx.notify(t("ops.custom.deleted", { name: cur.name }));
        continue;
      }
      const next: CustomCommand = {
        id: cur?.id ?? `${Date.now()}`,
        name: String(r.name).trim(),
        target: inv(TL, r.target) as CustomTarget,
        kind: inv(KL, r.kind) as CustomKind,
        command: String(r.command).trim(),
        confirm: !!r.confirm,
      };
      if (list.some((c) => c !== cur && c.name === next.name && c.target === next.target)) {
        ctx.error(t("ops.custom.dup", { name: next.name }));
        continue;
      }
      store("customCommands", cur ? list.map((c) => (c === cur ? next : c)) : [...list, next]);
      ctx.notify(t("ops.custom.saved", { name: next.name }));
    }
  },

  // ---- 호스팅: 계정·PR·웹 링크·이슈 링크 (gc-hosting, docs/reuse.md) ----
  openUrl: async (url: string) => {
    try {
      await api.openUrl(url);
    } catch (e) {
      ctx.error(t("ops.openUrlFail", { e: String(e) }));
    }
  },
  /** PR 리뷰 화면 열기 (number가 있으면 그 PR 선택). 사이드바 PR 항목·빠른 실행이 쓴다 */
  prReview: (number?: number) => prReview.show(number),
  manageAccounts: () => ops.openSettings("accounts"),
  /** http:// 셀프호스트(localhost·127.0.0.1 제외)는 토큰이 평문으로 전송되므로 확인을 받는다. 그 밖에는 true */
  confirmInsecure: async (host: string) => {
    const m = /^http:\/\/([^/:]+|\[[^\]]+\])/i.exec(host.trim());
    if (!m || ["localhost", "127.0.0.1", "[::1]"].includes(m[1].toLowerCase())) return true;
    return confirm(t("ops.insecure", { host: host.trim() }), t("ops.insecureTitle"));
  },
  removeAccount: async (a: HostAccount) => {
    if (!(await confirm(t("ops.acct.confirm", { user: a.username, host: a.host }), t("ops.acct.delTitle")))) return false;
    try {
      await api.accountRemove(a);
      prBus.emit();
      return true;
    } catch (e) {
      ctx.error(String(e));
      return false;
    }
  },
  /** 커밋을 원격 호스트 웹에서 연다. 원격이 여럿이면 현재 브랜치의 추적 원격(없으면 origin) 우선 */
  openCommitWeb: async (sha: string) => {
    const infos = await api.remoteInfo(ctx.repo).catch((e) => (ctx.error(String(e)), null));
    if (!infos) return; // 조회 실패는 "원격 없음"이 아니라 그 원인을 알린다
    const want = ctx.status?.upstream?.split("/")[0] ?? "origin";
    const i = infos.find((x) => x.provider && x.remote === want) ?? infos.find((x) => x.provider);
    if (!i?.provider) return ctx.error(t("ops.web.none"));
    ops.openUrl(await api.commitWebUrl(i.provider, i.repo, sha).catch((e) => (ctx.error(String(e)), "")) || "");
  },
  /** PR 시트에 넣을 초기값을 모은다. 브랜치를 안 주면 현재 브랜치. into(`원격/브랜치`)를 주면 그 브랜치가 base. 연결할 수 있는 원격이 없으면 안내만 */
  createPr: async (branch?: string, into?: string) => {
    const head = branch ?? ops.head();
    if (!head) return ctx.error(t("ops.pr.pickBranch"));
    const all = await api.remoteInfo(ctx.repo).catch((e) => (ctx.error(String(e)), null));
    if (!all) return; // 조회 실패는 "원격 없음"이 아니라 그 원인을 알린다
    const infos = all.filter((i) => i.provider);
    if (!infos.length) return ctx.error(t("ops.pr.noRemote"));
    const to = into ? infos.find((i) => into.startsWith(`${i.remote}/`))?.remote : undefined;
    // 기본 원격: base로 고른 원격 → 브랜치의 추적(upstream) 원격 → origin → 첫 원격
    const up = to ?? (head === ctx.status?.branch ? ctx.status?.upstream?.split("/")[0] : (await api.git(ctx.repo, ["config", "--get", `branch.${head}.remote`]).catch(() => "")).trim());
    const remote = (infos.find((i) => i.remote === up) ?? infos.find((i) => i.remote === "origin") ?? infos[0]).remote;
    const bases = prBases(remote);
    const base = to ? into!.slice(to.length + 1) : await prBase(remote, bases);
    const [probe, template] = await Promise.all([ops.prProbe(head, remote, base), prTemplate()]);
    ctx.showPr({ form: { head, infos, remote, base, bases: bases.includes(base) ? bases : [base, ...bases], probe, template } });
  },
  prBases: (remote: string) => prBases(remote),
  prHeads: (remote: string) => {
    const local = ctx.refs.filter((r) => r.kind === "local").map((r) => r.name);
    const pre = `${remote}/`;
    const rem = ctx.refs.filter((r) => r.kind === "remote" && r.name.startsWith(pre) && r.name !== `${pre}HEAD`).map((r) => r.name.slice(pre.length));
    return [...new Set([...local, ...rem])];
  },
  prBase: (remote: string, bases: string[]) => prBase(remote, bases),
  head: () => head(),
  prProbe: async (head: string, remote: string, base: string): Promise<PrProbe> => {
    const onRemote = ctx.refs.some((r) => r.kind === "remote" && r.name === `${remote}/${head}`);
    const out = (args: string[]) => api.git(ctx.repo, args).catch(() => "");
    // 로컬 브랜치가 없으면(원격 브랜치에서 만들 때) 원격 브랜치를 기준으로 읽는다
    const ref = ctx.refs.some((r) => r.kind === "local" && r.name === head) ? head : `${remote}/${head}`;
    const ahead = onRemote && ref === head ? Number((await out(["rev-list", "--count", `${remote}/${head}..${head}`])).trim()) || 0 : 0;
    const log = (await out(["log", "--no-show-signature", "--reverse", "--format=%s", `${remote}/${base}..${ref}`])).split("\n").filter(Boolean);
    const last = log.at(-1) ?? (await out(["log", "-1", "--format=%s", ref])).trim();
    return { onRemote, ahead, log, last };
  },
  /** PR 생성. 성공하면 완료 시트를 띄운다(PR URL 열기 버튼). 실패는 던진다 */
  prSubmit: async (v: { account: HostAccount; info: RemoteInfo; head: string; base: string; title: string; body: string; draft: boolean }) => {
    const url = await api.prCreate(v.account, v.info.repo, v.head, v.base, v.title, v.body, v.draft, ctx.repo || undefined);
    ctx.notify(t("ops.pr.created"));
    ctx.showPr({ done: url });
    prBus.emit();
    return url;
  },
  /** 브랜치가 원격에 없거나 앞서 있으면 먼저 push하고, 성공하면 만든다 (기존 push 작업 재사용) */
  pushThenPr: (remote: string, head: string, track: boolean, create: () => Promise<unknown>) =>
    ctx.job("Push", ["push", "--progress", ...(track ? ["-u"] : []), remote, head], {
      remote: true,
      onDone: () => void create().catch((e) => ctx.error(t("ops.pr.createFail", { e }))),
    }),
  /** PR의 head 브랜치를 체크아웃한다 (원격 추적 브랜치 생성). 아직 받지 못한 브랜치(포크 등)면 안내 */
  checkoutPr: (remote: string, branch: string) => {
    const name = `${remote}/${branch}`;
    if (!ctx.refs.some((r) => r.kind === "remote" && r.name === name))
      return ctx.error(t("ops.pr.noBranch", { name }));
    return ops.checkoutRemote(name);
  },
  /** PR 목록 다시 읽기 요청 (사이드바 섹션이 구독) */
  prRefresh: () => prBus.emit(),
  /** 이슈 링크 규칙: 저장소 git config + GitHub·GitLab 원격이면 `#123` 자동 규칙(맨 뒤) */
  issueLoad: async (repo: string): Promise<IssueRule[]> => {
    const user = parseRules(await api.git(repo, ["config", "--get-regexp", "^git403\\.issue\\."]).catch(() => ""));
    const read = async (scope: "--global" | "--local") => jiraCfg(parseConfig(await api.git(repo, ["config", scope, "--get-regexp", JIRA_RE]).catch(() => "")));
    const jira = jiraRule(jiraEffective(await read("--global"), await read("--local"))); // SettingsSheet와 같은 기준(전역 + 저장소 덮어쓰기)
    const auto = autoRule(await api.remoteInfo(repo).catch(() => []));
    return [...user, ...(jira ? [jira] : []), ...(auto ? [auto] : [])];
  },
  /** Jira 추천(설정 > 이슈 링크 탭을 열 때): 커밋 로그 500개·CLAUDE.md·AGENTS.md·README.md(앞 20KB)·브랜치 이름에서 주소·키 후보를 찾는다. 새 IPC 없음, 저장은 하지 않는다 */
  jiraSuggest: async (repo: string): Promise<JiraSuggestion | null> => {
    const [log, ...docs] = await Promise.all([
      api.git(repo, ["log", "--no-show-signature", "-n", "500", "--format=%B"]).catch(() => ""),
      ...["CLAUDE.md", "AGENTS.md", "README.md"].map((f) => api.git(repo, ["show", `HEAD:${f}`]).then((x) => x.slice(0, 20000), () => "")),
    ]);
    return jiraSuggest(log, docs, ctx.refs.filter((r) => r.kind === "local" || r.kind === "remote").map((r) => r.name));
  },
  /** 추천을 무시한 저장소(localStorage) */
  jiraDismissed: (repo: string, set?: boolean) => {
    let list: string[] = [];
    try {
      const v = JSON.parse(localStorage.getItem("jiraDismissed") ?? "[]");
      if (Array.isArray(v)) list = v;
    } catch {}
    if (set === undefined) return list.includes(repo);
    try {
      localStorage.setItem("jiraDismissed", JSON.stringify(set ? [...new Set([...list, repo])] : list.filter((x) => x !== repo)));
    } catch {}
    return set;
  },
  /** 관리 시트: 규칙 목록에서 고르면 편집·삭제, '새 규칙 추가'. 저장은 현재 저장소의 로컬 git config */
  manageIssues: async () => {
    const NEW = t("ops.issue.new");
    for (;;) {
      const list = (await ops.issueLoad(ctx.repo)).filter((r) => r.id !== "auto" && r.id !== "jira");
      const label = (r: IssueRule) => `${r.regex} → ${r.url}`;
      const pick = await prompt({
        title: t("ops.issue.title"),
        message: t("ops.issue.manageMsg"),
        fields: [{ kind: "select", name: "pick", label: t("ops.issue.rule"), options: [NEW, ...list.map(label)] }],
        submit: t("ops.edit"),
      });
      if (!pick) return;
      const cur = list.find((r) => label(r) === pick.pick);
      const r = await prompt({
        title: cur ? t("ops.issue.edit") : t("ops.issue.newTitle"),
        message: t("ops.issue.editMsg"),
        fields: [
          { kind: "text", name: "regex", label: t("ops.issue.regex"), value: cur?.regex, placeholder: "#(\\d+)" },
          { kind: "text", name: "url", label: t("ops.issue.urlTpl"), value: cur?.url, placeholder: "https://github.com/org/repo/issues/$1" },
          ...(cur ? [{ kind: "check" as const, name: "del", label: t("ops.issue.delThis") }] : []),
        ],
        submit: t("common.save"),
      });
      if (!r) continue;
      const set = (k: string, v: string) => api.git(ctx.repo, ["config", "--local", `git403.issue.${cur?.id ?? id}.${k}`, v]);
      const id = String(Math.max(-1, ...list.map((x) => Number(x.id) || 0)) + 1);
      try {
        if (cur && r.del) {
          for (const k of ["regex", "url"]) await api.git(ctx.repo, ["config", "--local", "--unset", `git403.issue.${cur.id}.${k}`], [5]);
          ctx.notify(t("ops.issue.deleted"));
        } else {
          const regex = String(r.regex).trim(), url = String(r.url).trim();
          try {
            new RegExp(regex);
          } catch (e) {
            ctx.error(t("ops.issue.badRegex", { e: e instanceof Error ? e.message : String(e) }));
            continue;
          }
          if (!/^https?:\/\//i.test(url)) {
            ctx.error(t("ops.issue.badUrl"));
            continue;
          }
          await set("regex", regex);
          await set("url", url);
          ctx.notify(t("ops.issue.saved"));
        }
      } catch (e) {
        ctx.error(String(e));
      }
      ctx.setIssues(await ops.issueLoad(ctx.repo));
    }
  },

  /** 저장소를 열 때 한 번: .gitattributes에 줄바꿈 규칙이 없고 거절 기록이 없으면 LF 통일 규칙 추가를 제안한다. force = 설정에서 다시 받기 */
  eolSuggest: async (repo: string, force = false) => {
    const declined = readDeclined();
    if (!force && declined.includes(repo)) return;
    if (await api.eolRuleExists(repo).catch(() => true)) return void (force && ctx.notify(t("ops.eol.exists")));
    if (repo !== ctx.repo) return; // 그사이 다른 탭으로 바뀜
    const r = await prompt({
      title: t("ops.eol.title"),
      message: t("ops.eol.msg", { rule: EOL_RULE }),
      fields: [],
      submit: t("ops.add"),
    });
    if (!r) return writeDeclined([...declined.filter((d) => d !== repo), repo]);
    writeDeclined(declined.filter((d) => d !== repo));
    await api.appendLine(repo, ".gitattributes", EOL_RULE).then(() => ctx.notify(t("ops.eol.added"), { kind: "success", detail: t("ops.eol.addedDetail") }), (e) => ctx.error(String(e)));
  },
  /** 커밋 직전 검사: 스테이지된 파일에 CRLF가 있으면 LF 변환 여부를 묻는다. false = 커밋 취소 */
  eolCommitCheck: async (repo: string): Promise<boolean> => {
    const files = await api.stagedCrlf(repo).catch(() => []);
    if (!files.length) return true;
    const r = await prompt({
      title: t("ops.eol.checkTitle"),
      message: t("ops.eol.checkMsg", { n: files.length, list: files.slice(0, 3).join(", "), more: files.length > 3 ? " …" : "" }),
      fields: [{ kind: "select", name: "how", label: t("ops.eol.how"), options: [eolFix(), eolKeep()] }],
      submit: t("ops.commit"),
    });
    if (!r) return false;
    if (r.how === eolFix()) await api.fixCrlf(repo, files);
    return true;
  },

  // ---- AI (docs/ai-auth.md) ----
  aiOn,
  /** 방식 감지(`claude --version`·키 유무)와 저장소별 끄기를 읽는다. 저장소를 열 때·설정이 바뀔 때 부른다 */
  aiLoad: async (repo?: string) => {
    // 설정을 못 읽으면(null) 저장소별 끄기 값을 그대로 둔다 — "설정 없음"으로 보면 꺼 둔 AI가 켜진다
    const [status, cfg] = await Promise.all([api.aiStatus().catch(() => null), repo ? ops.cfgRead("local", "^git403\\.ai(conventions)?$").catch(() => null) : Promise.resolve({} as Record<string, string>)]);
    if (repo && repo !== ctx.repo) return; // 그사이 다른 탭으로 바뀜
    const falsy = (k: string) => ["false", "0", "no", "off"].includes((cfg?.[k] ?? "").toLowerCase());
    const was = aiSig();
    ctx.ai.status = status;
    if (repo && cfg) [ctx.ai.repoOff, ctx.ai.convOff] = [falsy("git403.ai"), falsy("git403.aiconventions")];
    if (was !== aiSig()) aiBus.emit();
    // 앱을 막 켠 직후엔 로그인 셸 PATH가 아직 없어 CLI를 못 찾을 수 있고, 조회 자체가 실패할 수도 있다 → 한 번만 늦게 다시 본다
    if ((!status || !status.cli) && !aiRetried) {
      aiRetried = true;
      setTimeout(() => ops.aiLoad(repo && ctx.repo), 3000);
    }
    return status;
  },
  /** 변경 화면 커밋 상자: 스테이지된 diff + 최근 커밋 제목(언어·문체를 따르게) → 제목·본문 */
  aiCommit: () => {
    const repo = ctx.repo;
    return aiStart("commit", async () => {
      const diff = await api.git(repo, ["diff", "--cached", ...DIFF]);
      if (!diff.trim()) throw t("ops.ai.noStaged");
      const recent = (await api.git(repo, ["log", "--no-show-signature", "-n", "10", "--format=%s"]).catch(() => "")).trim();
      return [{ label: "recent commits", text: recent || "(없음)" }, { label: "staged diff", text: diff }];
    }, { repo }); // repo를 넘겨야 Rust가 저장소 규칙을 붙인다
  },
  /** 커밋 하나 리뷰 (머지 커밋은 첫 부모 기준) → 결과 시트 */
  aiReviewCommit: (sha: string, subject = "") => {
    const repo = ctx.repo;
    ctx.showAi({
      kind: "review",
      title: t("ops.ai.reviewTitle", { sha: sha.slice(0, 7), subject }).trim(),
      call: aiStart("review", () => reviewCommitParts(repo, sha)),
    });
  },
  /** 브랜치를 base(원격 기본 브랜치, 없으면 main·master) 대비로 리뷰 → 결과 시트 */
  aiReviewBranch: (branch: string) => {
    const repo = ctx.repo;
    ctx.showAi({
      kind: "review",
      title: t("ops.ai.reviewBranch", { branch }),
      call: aiStart("review", () => reviewBranchParts(repo, branch)),
    });
  },
  /** PR AI 리뷰(26c): 입력 = PR 제목·본문 + 커밋 메시지 + diff(병합 기준..head). `prepare`는 head·base를 로컬에 갖추고(없으면 fetch) 병합 기준 커밋을 돌려준다(PrFiles `ensurePrepared`) */
  aiReviewPr: (repo: string, pr: { title: string; body: string; head: string }, prepare: () => Promise<string>, opts: { model?: string; effort?: AiEffort }) =>
    aiStart("prreview", async () => {
      const mb = await prepare();
      const diff = await api.git(repo, [...Q, "diff", ...DIFF, "-M", mb, pr.head]);
      if (!diff.trim()) throw t("prr.ai.noDiff");
      const log = (await api.git(repo, ["log", "--no-show-signature", "--reverse", "--format=commit %h%n%B", `${mb}..${pr.head}`]).catch(() => "")).trim();
      return [{ label: "pull request", text: `# ${pr.title}\n\n${pr.body || "(no description)"}` }, { label: "commit messages", text: log || "(none)" }, { label: "diff (merge-base..head)", text: diff }];
    }, opts),
  /** PR AI 리뷰 — 새 커밋만(26d): 입력 = PR 제목·본문 + 새 커밋 메시지(old..head) + 범위 diff(old..head) + "이전 리뷰" 요약(이미 지적한 것은 반복하지 말고 고쳐졌는지 판단하게 하는 지시는 part 라벨로 전한다 — Rust 프롬프트는 그대로).
   *  `prepare`는 head를 로컬에 갖춘다(없으면 fetch)·리뷰한 커밋(old)이 없거나 조상이 아니면 throw */
  aiReviewPrNew: (repo: string, pr: { title: string; body: string; head: string }, old: { sha: string; prev: string }, prepare: () => Promise<string>, opts: { model?: string; effort?: AiEffort }) =>
    aiStart("prreview", async () => {
      if (!/^[0-9a-f]{7,40}$/.test(old.sha)) throw t("prr.ai.inc.badSha"); // 옵션·리비전 식 주입 방지
      await prepare();
      const diff = await api.git(repo, [...Q, "diff", ...DIFF, "-M", old.sha, pr.head]);
      if (!diff.trim()) throw t("prr.ai.inc.noDiff");
      const log = (await api.git(repo, ["log", "--no-show-signature", "--reverse", "--format=commit %h%n%B", `${old.sha}..${pr.head}`]).catch(() => "")).trim();
      return [
        { label: "pull request", text: `# ${pr.title}\n\n${pr.body || "(no description)"}` },
        { label: "commit messages (new commits only, since the previous review)", text: log || "(none)" },
        { label: "previous review (already raised on earlier commits; do not repeat these unless the problem is still unresolved in the new diff, and say if the new commits fixed them)", text: old.prev },
        { label: "diff (previous-review head..head, new commits only)", text: diff },
      ];
    }, opts),
  /** 읽는 흐름 가이드(25d): 리뷰와 같은 입력(커밋 diff). 결과는 가이드 패널(`shared/model/guide.ts`)이 받는다 */
  aiGuideCommit: (repo: string, sha: string) => aiStart("guide", () => reviewCommitParts(repo, sha)),
  /** 변경 화면 가이드: 스테이지된 diff는 만들 때 읽는다 */
  aiGuideStaged: (repo: string) =>
    aiStart("guide", async () => {
      const diff = await api.git(repo, [...Q, "diff", "--cached", ...DIFF]);
      if (!diff.trim()) throw t("ops.ai.noStaged");
      return [{ label: "staged diff", text: diff }];
    }),
  /** 변경 화면 가이드의 대상 키: 스테이지된 파일 목록 + 각 파일의 index 해시(`diff --cached --raw`, 쓰기 없는 조회) 원문. 같은 내용이면 같은 키 (읽을 게 없으면 null) */
  guideStagedKey: async (repo: string) => {
    const raw = (await api.git(repo, [...Q, "diff", "--cached", "--raw", "--no-abbrev"]).catch(() => "")).trim();
    if (!raw) return null;
    return `changes:${repo}:${raw}`; // 해시 대신 원문(파일 목록+index 해시)을 그대로 키로: 충돌 없음
  },
  /** 커밋 우클릭 "읽는 흐름 가이드": 이 커밋을 대상으로 바로 만들고(이미 있으면 그대로) 패널을 연다 */
  guideCommit: (sha: string) => {
    const repo = ctx.repo, key = `commit:${repo}:${sha}`;
    if (!guide.has(key)) guide.start(key, ops.aiGuideCommit(repo, sha));
    guide.setOpen(true);
  },
  /** 빠른 실행: 패널을 열고 지금 보는 대상(선택한 커밋·변경 화면)이 정해지면 만든다 */
  guideStart: () => guide.want(),
  /** 충돌 파일의 공통 조상·ours·theirs(`:1:`·`:2:`·`:3:` 단계, Rust가 바이트로 읽어 UTF-8·NUL 검사 — 아니면 시작 전 거부) → 설명 + 병합안 미리보기 시트 (적용은 시트의 버튼) */
  aiConflict: (path: string) => {
    const repo = ctx.repo, fp = { v: "" };
    ctx.showAi({
      kind: "conflict",
      title: t("ops.ai.conflictTitle", { path }),
      path,
      repo,
      fp,
      call: aiStart("conflict", async () => {
        const b = await api.conflictInputs(repo, path);
        fp.v = b.fingerprint;
        return [{ label: "file", text: path }, { label: "base (공통 조상, :1)", text: b.base ?? "(없음)" }, { label: "ours (:2)", text: b.ours }, { label: "theirs (:3)", text: b.theirs }];
      }),
    });
  },
  /** 병합안을 요청 시점 저장소의 작업 폴더 파일에 쓴다. 아직 충돌 상태(`ls-files -u`)이고 요청 뒤 파일이 안 바뀌었을 때만(Rust가 지문 비교), OS 확인 뒤에. 스테이지는 사용자가 확인한 뒤 직접 */
  aiApplyConflict: async (repo: string, path: string, merged: string, fp: string) => {
    try {
      if (!(await api.git(repo, ["ls-files", "-u", "--", path]).catch(() => "")).trim()) throw t("ops.ai.notConflict", { path });
      if (!(await confirm(t("ops.ai.overwrite", { path }), t("ops.ai.applyTitle")))) return false;
      await api.writeInRepo(repo, path, merged, fp);
      ctx.notify(t("ops.ai.wrote", { path }), { kind: "success" });
      return true;
    } catch (e) {
      ctx.error(String(e));
      return false;
    }
  },
  /** PR 시트: 커밋 제목 목록 + diff --stat + diff → 제목·본문 (head가 remote/base 대비) */
  aiPr: (head: string, remote: string, base: string) => {
    const repo = ctx.repo;
    return aiStart("pr", async () => {
      const range = `${remote}/${base}`;
      const out = (args: string[]) => api.git(repo, args);
      const [log, stat, diff] = await Promise.all([
        out(["log", "--no-show-signature", "--reverse", "--format=%s", `${range}..${head}`]),
        out(["diff", "--stat", "--no-color", `${range}...${head}`]),
        out(["diff", ...DIFF, `${range}...${head}`]),
      ]);
      if (!diff.trim()) throw t("ops.ai.prNoDiff", { range });
      return [{ label: "commit subjects", text: log.trim() || "(없음)" }, { label: "diff --stat", text: stat }, { label: "diff", text: diff }];
    }, { repo });
  },

  // ---- 설정 (설정 창: SettingsSheet.tsx, docs/reuse.md) ----
  openSettings: (tab?: string) => ctx.showSettings(tab),
  /** 커밋 상세 위치 전환 (오른쪽 ↔ 아래). 탭 줄 버튼·⌘⌥B·보기 메뉴·빠른 실행 */
  toggleLayout: () => setPref("detailLayout", pref("detailLayout") === "right" ? "bottom" : "right"),
  /** git config 값 읽기. scope = global | local | all(우선순위 적용). 저장소가 없으면 홈 폴더에서 실행하므로 global은 항상 된다. 키는 소문자 */
  cfgRead: async (scope: "global" | "local" | "all", re: string = GIT_SETTINGS_RE) => {
    const cwd = ctx.repo || (await api.homeDir());
    const flag = scope === "all" ? [] : [`--${scope}`];
    // 맞는 키가 없으면 git이 1로 끝난다(정상). 그 밖의 실패(락·설정 파일 오류)는 "설정 없음"으로 숨기지 않고 던진다
    return parseConfig(await api.git(cwd, ["config", ...flag, "--get-regexp", re], [1]));
  },
  /** git config 쓰기. value가 null이면 키를 지운다(없는 키 삭제 = 종료 5는 오류로 보지 않음, 그 밖의 실패는 던진다) */
  cfgWrite: async (scope: "global" | "local", key: string, value: string | null) => {
    const cwd = ctx.repo || (await api.homeDir());
    if (value === null) await api.git(cwd, ["config", `--${scope}`, "--unset", key], [5]);
    else await api.git(cwd, ["config", `--${scope}`, key, value]);
  },
  /** 이 저장소의 커밋 작성자: 저장소(--local) 값이 하나라도 있으면 저장소 값 우선(빈 쪽은 전역), 없으면 전역. 값 없음(종료 1)이 아닌 읽기 실패는 던진다 */
  authorRead: async () => {
    const [l, g] = await Promise.all([ops.cfgRead("local", AUTHOR_RE), ops.cfgRead("global", AUTHOR_RE)]) as Record<string, string>[];
    const local = !!(l["user.name"] || l["user.email"]);
    return { name: l["user.name"] ?? g["user.name"] ?? "", email: l["user.email"] ?? g["user.email"] ?? "", local };
  },
  /** 이 저장소 작성자 설정(이름·이메일 → `config --local`). 성공하면 새 값, 취소·검증 실패면 null */
  authorSet: async () => {
    const cur = await ops.authorRead();
    const r = await prompt({
      title: t("ops.author.title"),
      message: t("ops.author.msg"),
      fields: [
        { kind: "text", name: "name", label: t("ops.author.name"), value: cur.name },
        { kind: "text", name: "email", label: t("ops.author.email"), value: cur.email },
      ],
      submit: t("ops.author.submit"),
    });
    if (!r) return;
    const name = String(r.name ?? "").trim(), email = String(r.email ?? "").trim();
    if (!name || !validEmail(email)) return void ctx.error(t("ops.author.bad"));
    await writeAuthor({ "user.name": name, "user.email": email });
  },
  /** 저장소 작성자 해제(전역 값 사용). 없는 키 삭제(종료 5)는 무시 */
  authorUnset: () => writeAuthor({ "user.name": null, "user.email": null }),
  /** UI 설정 저장. 그래프 커밋 상한이 바뀌면 현재 저장소를 다시 읽는다 */
  setPref: <K extends keyof Prefs>(key: K, value: Prefs[K]) => {
    setPref(key, value);
    if (key === "graphLimit") ctx.reload();
  },
  /** 자동 fetch 한 번: 활성 탭만. 다른 작업·저장소 로딩 중이거나 시트가 열려 있으면 건너뜀. 인증 창 없이(quiet) 돌고 실패는 상태바에만 */
  autoFetch: () => {
    if (!ctx.repo || ctx.busy() || ctx.loading() || document.querySelector(".sheet-backdrop")) return;
    ctx.job(t("ops.autoFetch"), ["fetch", "--all", "--prune", "--tags", "--progress"], { quiet: true });
  },

  // ---- 그래프 표시 ----
  /** 사이드바 ref(또는 폴더)를 그래프에서 숨기기/보이기. path는 전체 ref 경로(`refs/heads/x`). 저장소별로 저장하고 그래프를 다시 읽는다 */
  toggleHidden: (path: string, folder = false) => {
    toggleHidden(ctx.repo, path, folder);
    ctx.reload();
  },

  /** 숨긴 ref 전부 보이기 (사이드바 "모두 보기") */
  showAllHidden: () => {
    showAll(ctx.repo);
    ctx.reload();
  },

  // ---- 기타 ----
  copy: (text: string) => navigator.clipboard.writeText(text).then(() => ctx.notify(t("ops.copied"))),
};
