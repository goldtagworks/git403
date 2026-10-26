// 설정 창의 순수 로직: UI 설정(localStorage), git 설정 키·변환, 이메일 검증, .gitignore 템플릿.
// ops·api 어느 쪽도 import하지 않는다 (api가 prefs를 읽는다).

import type { Key } from "../i18n/locales/en";

// ---- UI 설정 (localStorage, 앱 전체 공통) ----
export interface Prefs {
  /** 시작 시 마지막 탭 복원 */
  restoreTabs: boolean;
  /** 그래프에 읽는 최대 커밋 수(상한). 처음엔 한 페이지만 읽고 스크롤하면 이 값까지 더 읽는다 */
  graphLimit: number;
  /** 자동 fetch 간격(분). 0 = 끔 */
  autoFetch: number;
  /** 하루 한 번 백그라운드 업데이트 확인 */
  autoUpdate: boolean;
  /** diff에서 줄 끝 CR 차이 무시(`--ignore-cr-at-eol`). 켜면 hunk·줄 스테이지는 막힌다 */
  ignoreEol: boolean;
  /** diff에서 모든 공백 차이 무시(`-w`). ignoreEol과 같이 켜면 hunk·줄 스테이지는 막힌다 (diff 도구줄 토글) */
  ignoreWs: boolean;
  /** diff 긴 줄 줄바꿈 (diff 도구줄 토글) */
  diffWrap: boolean;
  /** diff를 파일 전체(숨은 줄을 모두 펼침)로 보기 (diff 도구줄 "Diff / 파일 전체") */
  diffFull: boolean;
  /** diff에서 공백(·)·탭(→)·줄 끝(¶) 표시 */
  diffWs: boolean;
  /** 연결한 gh 계정으로 임시 전환한 작업(Push·Fetch 등)이 끝나면 원래 계정으로 되돌림 */
  ghRestore: boolean;
  /** 표시 언어. system이면 OS 언어를 따른다 (i18n.ts) */
  language: Locale | "system";
}
/** 지원 언어 목록의 원본 (i18n.ts의 DICTS·LANGS, Rust `gc_i18n::SUPPORTED_LOCALES`와 같아야 한다) */
export const LOCALES = ["en", "ko", "zh-CN", "zh-TW", "vi", "ja", "tl", "km", "uz", "lo", "ru", "th", "mn", "ne", "de", "fr", "es", "pt-BR", "it", "pl", "tr", "uk", "nl"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_PREFS: Prefs = { restoreTabs: true, graphLimit: 20000, autoFetch: 5, autoUpdate: true, ignoreEol: false, ignoreWs: false, diffWrap: false, diffFull: false, diffWs: false, ghRestore: true, language: "system" };
/** 그래프를 처음 읽는 커밋 수(한 페이지). 아래로 스크롤하면 두 배씩 더 읽는다(상한 `graphLimit`까지). */
export const GRAPH_PAGE = 5000;
export const GRAPH_LIMIT_RANGE = [100, 200000] as const;
export const AUTO_FETCH_MINUTES = [0, 5, 10, 30] as const;

const norm: { [K in keyof Prefs]: (v: unknown) => Prefs[K] } = {
  restoreTabs: (v) => (typeof v === "boolean" ? v : DEFAULT_PREFS.restoreTabs),
  graphLimit: (v) => clampLimit(v),
  autoUpdate: (v) => (typeof v === "boolean" ? v : DEFAULT_PREFS.autoUpdate),
  language: (v) => ((LOCALES as readonly unknown[]).includes(v) ? (v as Locale) : "system"),
  ignoreEol: (v) => (typeof v === "boolean" ? v : DEFAULT_PREFS.ignoreEol),
  ignoreWs: (v) => (typeof v === "boolean" ? v : DEFAULT_PREFS.ignoreWs),
  ghRestore: (v) => (typeof v === "boolean" ? v : DEFAULT_PREFS.ghRestore),
  diffWrap: (v) => (typeof v === "boolean" ? v : DEFAULT_PREFS.diffWrap),
  diffFull: (v) => (typeof v === "boolean" ? v : DEFAULT_PREFS.diffFull),
  diffWs: (v) => (typeof v === "boolean" ? v : DEFAULT_PREFS.diffWs),
  autoFetch: (v) => ((AUTO_FETCH_MINUTES as readonly unknown[]).includes(v) ? (v as number) : DEFAULT_PREFS.autoFetch),
};
/** 정수로 바꿔 허용 범위로 맞춘다. 숫자가 아니면 기본값 */
export const clampLimit = (v: unknown) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(GRAPH_LIMIT_RANGE[1], Math.max(GRAPH_LIMIT_RANGE[0], n)) : DEFAULT_PREFS.graphLimit;
};

/** 이번에 읽을 커밋 수: 원하는 개수(기본 한 페이지)를 상한 설정으로 자른다 */
export const graphLimit = (want?: number) => Math.min(pref("graphLimit"), want ?? GRAPH_PAGE);

export const pref = <K extends keyof Prefs>(key: K): Prefs[K] => {
  try {
    const v = localStorage.getItem(key);
    return norm[key](v === null ? undefined : JSON.parse(v));
  } catch {
    return DEFAULT_PREFS[key];
  }
};
const listeners = new Set<() => void>();
/** 설정이 바뀔 때 알림 (useSyncExternalStore용) */
export const onPrefs = (f: () => void) => (listeners.add(f), () => void listeners.delete(f));
/** localStorage를 직접 바꾼 뒤(설정 가져오기) 구독자에게 알린다 */
export const notifyPrefs = () => listeners.forEach((f) => f());
export const setPref = <K extends keyof Prefs>(key: K, value: Prefs[K]) => {
  try {
    localStorage.setItem(key, JSON.stringify(norm[key](value)));
  } catch {}
  listeners.forEach((f) => f());
};

// ---- git 설정 ----
/** 설정 창이 읽는 키 (git이 소문자로 돌려주는 형태) */
export const GIT_SETTINGS_RE = "^(user\\.(name|email|signingkey)|init\\.defaultbranch|pull\\.(rebase|ff)|commit\\.gpgsign|gpg\\.format|core\\.excludesfile)$";

/** `config --get-regexp` 출력(`키 값` 줄들) → 키별 마지막 값 */
export const parseConfig = (out: string): Record<string, string> => {
  const m: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const i = line.indexOf(" ");
    if (i > 0) m[line.slice(0, i)] = line.slice(i + 1);
  }
  return m;
};

export type PullMode = "default" | "merge" | "rebase" | "ff-only";
/** 모드 이름의 문구 키 (설정 창이 `t(PULL_KEY[m])`로 쓴다) */
export const PULL_KEY: Record<PullMode, Key> = { default: "settings.pull.default", merge: "settings.pull.merge", rebase: "settings.pull.rebase", "ff-only": "settings.pull.ffOnly" };
/** pull.rebase / pull.ff 값 → 모드 */
export const pullMode = (rebase?: string, ff?: string): PullMode =>
  rebase === "true" ? "rebase" : ff === "only" ? "ff-only" : rebase === "false" || ff === "false" ? "merge" : "default";
/** 모드 → [pull.rebase, pull.ff] (null = 설정 삭제) */
export const pullConfig = (m: PullMode): [string | null, string | null] =>
  ({ default: [null, null], merge: ["false", null], rebase: ["true", null], "ff-only": ["false", "only"] } as const)[m] as [string | null, string | null];

/** 이메일 형식 (빈 값은 호출 측이 '삭제'로 처리). 공백 없이 `이름@도메인.최상위` */
export const validEmail = (s: string) => /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(s);

export const signingState = (c: Record<string, string>) => ({
  on: c["commit.gpgsign"] === "true",
  format: c["gpg.format"] || "openpgp",
  key: c["user.signingkey"] ?? "",
});

// ---- .gitignore 템플릿 (자체 작성, 외부 다운로드 없음) ----
export const IGNORE_TEMPLATES: Record<string, string> = {
  Node: "node_modules/\nnpm-debug.log*\nyarn-error.log*\npnpm-debug.log*\ndist/\nbuild/\ncoverage/\n.env\n.env.local\n.eslintcache\n*.tsbuildinfo",
  Rust: "target/\n**/*.rs.bk\n*.pdb",
  Python: "__pycache__/\n*.py[cod]\n.venv/\nvenv/\n*.egg-info/\n.pytest_cache/\n.mypy_cache/\ndist/\nbuild/\n.env",
  macOS: ".DS_Store\n.AppleDouble\n.LSOverride\n._*\n.Spotlight-V100\n.Trashes",
  Windows: "Thumbs.db\nehthumbs.db\nDesktop.ini\n$RECYCLE.BIN/\n*.lnk",
  JetBrains: ".idea/\n*.iml\n*.iws\nout/",
  VSCode: ".vscode/*\n!.vscode/settings.json\n!.vscode/tasks.json\n!.vscode/launch.json\n!.vscode/extensions.json\n*.code-workspace",
};

/** 템플릿을 `# 이름` 머리글과 함께 끝에 붙인다. 이미 같은 머리글이 있으면 그대로 */
export function addTemplate(text: string, name: string): { text: string; added: boolean } {
  const head = `# ${name}`;
  if (text.split("\n").some((l) => l.trim() === head)) return { text, added: false };
  const sep = text === "" ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return { text: `${text}${sep}${head}\n${IGNORE_TEMPLATES[name]}\n`, added: true };
}

/** Jira 설정 키(git config git403.jira.url|keys|off) 조회용 정규식 */
export const JIRA_RE = "^git403\\.jira\\.";
