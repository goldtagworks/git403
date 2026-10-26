import { t } from "../i18n/i18n";
import { ops } from "../model/ops";

/** 커밋 해시 표시. 클릭하면 전체 해시를 클립보드에 복사한다. */
export function Sha({ id, len = 7, className = "sha", tag: Tag = "span" }: { id: string; len?: number; className?: string; tag?: "span" | "code" }) {
  return <Tag className={`${className} copyable`.trim()} title={t("graph.copySha")} onClick={() => ops.copy(id)}>{id.slice(0, len)}</Tag>;
}
