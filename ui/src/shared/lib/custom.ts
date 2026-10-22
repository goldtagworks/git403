// 사용자 정의 명령의 순수 로직: 인자 나누기, 변수 치환, 셸 인용. (실행·저장은 ops.ts)
import { t } from "../i18n/i18n";

export type CustomTarget = "repo" | "commit" | "branch" | "file";
export type CustomKind = "git" | "shell";
export interface CustomCommand {
  id: string;
  name: string;
  target: CustomTarget;
  kind: CustomKind;
  /** git이면 인자 문자열(`log --oneline ${sha}`), 셸이면 명령 한 줄. 변수: ${repo} ${sha} ${branch} ${file} */
  command: string;
  confirm: boolean;
}
/** 치환 가능한 값. 대상에 없는 변수는 undefined */
export type CustomVars = { repo: string; sha?: string; branch?: string; file?: string };

export const targetLabels = (): Record<CustomTarget, string> => ({ repo: t("custom.target.repo"), commit: t("custom.target.commit"), branch: t("custom.target.branch"), file: t("custom.target.file") });
export const kindLabels = (): Record<CustomKind, string> => ({ git: t("custom.kind.git"), shell: t("custom.kind.shell") });

/** 공백으로 나누되 '…'·"…" 안은 한 덩어리로 (따옴표는 벗긴다). 치환은 나눈 뒤에 하므로 값에 공백이 있어도 인자 하나다. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "", quote = "", has = false;
  for (const ch of s) {
    if (quote) ch === quote ? (quote = "") : (cur += ch);
    else if (ch === '"' || ch === "'") (quote = ch), (has = true);
    else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** 셸에 넣을 값 인용. POSIX는 작은따옴표(`'` → `'\''`), Windows cmd는 큰따옴표 — cmd는 안전하게 인용할 수 없는 문자가 있으면 거부한다. */
export function quoteShell(v: string, windows: boolean): string {
  if (!windows) return `'${v.replace(/'/g, `'\\''`)}'`;
  if (/["%^&|<>!\r\n]/.test(v)) throw new Error(t("custom.badChar", { v }));
  return `"${v}"`;
}

const VAR = /\$\{(\w+)\}/g;
/** 템플릿의 ${변수}를 치환한다. 값이 없는 변수는 오류. `quote`를 주면 각 값을 인용한다(셸용). */
export function expand(tpl: string, vars: CustomVars, quote?: (v: string) => string): string {
  return tpl.replace(VAR, (_, name: string) => {
    const v = (vars as Record<string, string | undefined>)[name];
    if (v === undefined) throw new Error(t("custom.badVar", { name: "${" + name + "}" }));
    return quote ? quote(v) : v;
  });
}

/** 실행할 최종 형태. git: 인자 배열(인용 불필요), shell: 값이 인용된 한 줄 */
export function build(c: CustomCommand, vars: CustomVars, windows: boolean): { args?: string[]; shell?: string } {
  if (c.kind === "git") {
    const args = splitArgs(c.command);
    if (args[0] === "git") args.shift(); // `git log …`처럼 써도 된다
    return { args: args.map((a) => expand(a, vars)) };
  }
  return { shell: expand(c.command, vars, (v) => quoteShell(v, windows)) };
}
