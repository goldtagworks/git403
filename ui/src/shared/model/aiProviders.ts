import { t } from "../i18n/i18n";
import type { AiProvider, AiSource, ProviderStatus } from "../api/types";

/** AI 공급자 표시 정보 (순서 = ai_status().providers 순서). org는 전송 동의 문구용 회사 이름 */
export const AI_PROVIDERS: { id: AiProvider; name: string; org: string; cli: string; login: string; keyHint: string }[] = [
  { id: "anthropic", name: "Claude", org: "Anthropic", cli: "Claude Code CLI", login: "claude", keyHint: "sk-ant-…" },
  { id: "openai", name: "Codex · GPT", org: "OpenAI", cli: "Codex CLI", login: "codex login", keyHint: "sk-…" },
  { id: "google", name: "Gemini", org: "Google", cli: "Gemini CLI", login: "gemini", keyHint: "AIza…" },
  { id: "xai", name: "Grok", org: "xAI", cli: "Grok CLI", login: "grok login", keyHint: "xai-…" },
];
export const aiProvider = (id: AiProvider | undefined) => AI_PROVIDERS.find((p) => p.id === id) ?? AI_PROVIDERS[0];

/** 공급자 한 줄 상태 문구: 감지된 것(CLI·키) + 지금 쓰는 방식, 쓸 수 없으면 "사용 불가" (설정 > AI와 상태바 메뉴가 같이 쓴다) */
export const providerHint = (x: ProviderStatus) =>
  [x.cli && t("ai.pv.cli", { v: x.cliVersion ?? "" }), x.key && t("ai.pv.key"), x.active ? t(x.active === "cli" ? "ai.pv.usingCli" : "ai.pv.usingKey") : t("ai.pv.unavailable")].filter(Boolean).join(" · ");

/** 저장소 규칙 출처 한 줄 표기: 스킬은 폴더 이름, 문서는 파일 이름, 이력·브랜치는 풀어쓴다 ("(일부)" = 잘림) */
export function sourceLabel(s: AiSource): string {
  const parts = s.path.split("/");
  const x =
    s.kind === "skill" || s.kind === "plugin" ? t("ai.src.skill", { name: parts[parts.length - 2] ?? parts[0] })
    : s.kind === "history" ? t("ai.src.history")
    : s.kind === "branch" ? t("ai.src.branch")
    : s.path.startsWith("commit.template") ? t("ai.src.commitTpl")
    : parts[parts.length - 1];
  if (s.skipped) return t("ai.src.skipped");
  if (s.missing) return t("ai.src.missing", { name: s.path });
  const y = s.via === "referenced" && s.from ? t("ai.src.ref", { x, from: s.from }) : s.via === "matched" ? t("ai.src.matched", { x }) : x;
  return s.truncated ? t("ai.src.partial", { x: y }) : y;
}
