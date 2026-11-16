import { t, useLocale } from "../../shared/i18n/i18n";
import { sourceLabel } from "../../shared/model/aiProviders";
import type { AiSource } from "../../shared/api/types";

const detail = (s: AiSource) => (s.from ? `${s.path} ← ${s.from}` : s.path);

/** AI 결과(커밋 메시지·PR 설명) 아래의 "규칙: commit-message 스킬 (CLAUDE.md:168 지정) · AGENTS.md …" 한 줄. 눌러서(또는 올려서) 경로·지정 위치 목록을 본다. 지정됐는데 못 찾은 스킬은 경고색. 비어 있으면 아무것도 그리지 않는다 */
export function AiSources({ sources }: { sources: AiSource[] | undefined }) {
  useLocale();
  if (!sources?.length) return null;
  return (
    <details className="ai-sources">
      <summary title={sources.map(detail).join("\n")}>
        {t("ai.src.line", { list: "" })}
        {sources.map((s, i) => <span key={i} className={s.missing ? "src-missing" : s.skipped ? "src-skipped" : undefined}>{i ? " · " : ""}{sourceLabel(s)}</span>)}
      </summary>
      <ul className="selectable mono" aria-label={t("ai.src.label")}>
        {sources.map((s, i) => <li key={i}>{detail(s)}{s.truncated ? ` ${t("ai.src.partial", { x: "" }).trim()}` : ""}</li>)}
      </ul>
    </details>
  );
}
