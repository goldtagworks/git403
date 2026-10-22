// 설정 내보내기·가져오기의 UI 쪽 순수 로직: 내보낼 localStorage 키 허용 목록, 모으기·쓰기, 위험 명령 검사.
// 저장소별 키(hidden:<repo>, eolDeclined, jiraDismissed, jiraScope)와 일회성 상태(updateCheckedAt)는 허용 목록에 없다.

/** 전역 설정 키(정확히 일치). 저장 위치: shared/lib/settings·theme·ops·CommitGraph 등 */
export const UI_KEYS = ["theme", "accent", "language", "restoreTabs", "graphLimit", "autoFetch", "autoUpdate", "ignoreEol", "ignoreWs", "diffWrap", "diffFull", "diffWs", "ghRestore", "cols:hidden", "fileView", "bigHint", "terminalApp", "customCommands"] as const;
/** 이름이 이 접두사로 시작하는 키 (스플리터 폭 `split:*`, PR 리뷰 화면 `prr.*`) */
export const UI_PREFIXES = ["split:", "prr."] as const;

export const isUiKey = (k: string) => (UI_KEYS as readonly string[]).includes(k) || UI_PREFIXES.some((p) => k.startsWith(p));

/** 현재 localStorage에서 허용 목록 키만 모은다 (값은 저장된 문자열 그대로) */
export function collectUi(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = k && isUiKey(k) ? localStorage.getItem(k) : null;
      if (k && v !== null) out[k] = v;
    }
  } catch {}
  return out;
}

/** 가져온 값을 localStorage에 쓴다 (허용 목록 밖 키는 무시). 쓴 키를 돌려준다 */
export function writeUi(ui: Record<string, string>): string[] {
  const done: string[] = [];
  for (const [k, v] of Object.entries(ui)) {
    if (!isUiKey(k) || typeof v !== "string") continue;
    try {
      localStorage.setItem(k, v);
      done.push(k);
    } catch {}
  }
  return done;
}

/** 바뀌는 사용자 정의 명령(`customCommands` 값)에 셸 명령이 있는가 */
export function hasShellCommand(json: string | null | undefined): boolean {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) && v.some((c) => c?.kind === "shell");
  } catch {
    return false;
  }
}

/** 화면에 보일 값: 길면 자른다 */
export const shortVal = (v: string | null | undefined, max = 120) => (v == null || v === "" ? "—" : v.length > max ? v.slice(0, max) + "…" : v);
