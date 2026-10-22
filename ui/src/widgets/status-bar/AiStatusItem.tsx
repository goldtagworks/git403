import { memo } from "react";
import { api } from "../../shared/api/api";
import { t, useLocale } from "../../shared/i18n/i18n";
import { AI_PROVIDERS, aiProvider, providerHint } from "../../shared/model/aiProviders";
import { ctx, ops, useAiSig } from "../../shared/model/ops";
import { showMenu } from "../../shared/ui/menu";
import { countRender } from "../../shared/lib/profile";
import { StatusItem } from "../../shared/ui/StatusItem";
import type { AiProvider } from "../../shared/api/types";

/**
 * 상태바 오른쪽의 연결된 AI 표시("Claude · CLI") + 공급자 전환 메뉴.
 * `useAiSig`(공급자·방식·저장소별 끄기)만 구독해서 StatusBar·그래프·사이드바는 다시 그려지지 않는다 (docs/performance.md).
 */
export const AiStatusItem = memo(function AiStatusItem() {
  countRender("AiStatusItem");
  useLocale();
  useAiSig();
  const { status, repoOff } = ctx.ai;
  const on = !!status?.active && !repoOff;
  const label = on ? `${aiProvider(status!.provider).name} · ${status!.active === "cli" ? t("status.ai.cli") : t("ai.apiKey")}` : repoOff ? t("status.ai.offRepo") : t("status.ai.off");

  const pick = async (p: AiProvider) => {
    try {
      await api.aiSettingsSet({ provider: p, select: true });
      await ops.aiLoad(ctx.repo || undefined);
    } catch (e) {
      ctx.error(String(e));
    }
  };
  const open = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(
      [
        ...AI_PROVIDERS.map((p) => {
          const x = status?.providers.find((v) => v.provider === p.id);
          return { label: p.name, hint: x?.active ? t(x.active === "cli" ? "status.ai.cli" : "ai.apiKey") : t("ai.pv.unavailable"), title: x ? providerHint(x) : undefined, checked: status?.provider === p.id, disabled: !x?.active, action: () => void pick(p.id) };
        }),
        { separator: true as const },
        { label: t("status.ai.settings"), action: () => ops.openSettings("ai") },
      ],
      { x: r.right, y: r.top - 4 },
    );
  };
  return <StatusItem muted={!on} name={on ? t("status.ai.name") : undefined} label={label} title={t("status.ai.tip")} onClick={open} />;
});
