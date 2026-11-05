import { memo } from "react";
import { t, useLocale } from "../../shared/i18n/i18n";
import { aiChat, useChatHidden } from "../../shared/model/aichat";
import { countRender } from "../../shared/lib/profile";
import { StatusItem } from "../../shared/ui/StatusItem";

/**
 * AI 채팅이 일하는 중인데 열이 닫혀 있으면 "AI 작업 중…" (누르면 열린다). `useChatHidden`(불리언)만 구독해서
 * 채팅 이벤트가 쏟아져도 상태바·그래프·사이드바는 다시 그려지지 않는다 (docs/performance.md).
 */
export const AiChatStatusItem = memo(function AiChatStatusItem() {
  countRender("AiChatStatusItem");
  useLocale();
  return useChatHidden() ? <StatusItem label={t("aiChat.statusRunning")} title={t("aiChat.statusTip")} onClick={aiChat.focus} /> : null;
});
