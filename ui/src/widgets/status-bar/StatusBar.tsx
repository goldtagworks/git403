import { memo, useEffect, useState } from "react";
import { listen } from "../../shared/api/bridge";
import { api } from "../../shared/api/api";
import { AiStatusItem } from "./AiStatusItem";
import { GhStatusItem } from "./GhStatusItem";
import { Icon } from "../../shared/ui/Icon";
import { countRender } from "../../shared/lib/profile";
import { t, useLocale } from "../../shared/i18n/i18n";
import type { JobEvent, Status } from "../../shared/api/types";

declare const __APP_VERSION__: string;

/**
 * 하단 상태바: 현재 브랜치·ahead/behind + 작업 진행률·취소 + 오른쪽 AI 항목(`AiStatusItem`, 자기 구독)·앱 버전.
 * 진행률 이벤트는 초당 수십 번 올 수 있어서 여기서만 구독한다 (docs/performance.md).
 */
export const StatusBar = memo(function StatusBar({
  status,
  message,
  job,
}: {
  status: Status | null;
  message: string;
  job: { id: number; name: string } | null;
}) {
  countRender("StatusBar");
  useLocale();
  const [progress, setProgress] = useState("");

  useEffect(() => {
    const un = listen<{ job: number; event: JobEvent }>("job", ({ payload: { event } }) => {
      if (event.kind !== "finished") setProgress(event.line);
    });
    return () => void un.then((f) => f());
  }, []);
  // 새 문구(작업 시작·완료)가 오면 진행률 줄을 비운다.
  useEffect(() => setProgress(""), [message]);

  return (
    <footer className="statusbar">
      {status?.branch && (
        <span className="status-branch">
          <Icon name="branch" size={13} />
          {status.branch}
          {status.upstream && (
            <span className="ab" title={t("status.upstream", { upstream: status.upstream })}>
              ↑{status.ahead} ↓{status.behind}
            </span>
          )}
        </span>
      )}
      <GhStatusItem />
      <span className="status-progress" aria-live="polite">{progress || message}</span>
      {job && <button onClick={() => api.cancelJob(job.id)}>{t("status.cancel", { name: job.name })}</button>}
      <AiStatusItem />
      <span className="status-version">{__APP_VERSION__}</span>
    </footer>
  );
});
