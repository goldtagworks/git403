import { memo, useEffect, useState } from "react";
import { EXT_VERSION, listen } from "../../shared/api/bridge";
import { api } from "../../shared/api/api";
import { AiStatusItem } from "./AiStatusItem";
import { GhStatusItem } from "./GhStatusItem";
import { Icon } from "../../shared/ui/Icon";
import { countRender } from "../../shared/lib/profile";
import { t, useLocale } from "../../shared/i18n/i18n";
import type { JobEvent, Status } from "../../shared/api/types";

declare const __APP_VERSION__: string;
// 버전을 누르면 릴리스 노트: 앱은 GitHub 릴리스, VS Code 확장은 마켓플레이스 변경 내역
const VERSION = EXT_VERSION ?? __APP_VERSION__;
const RELEASE_URL = EXT_VERSION ? "https://marketplace.visualstudio.com/items/goldtagworks.git403-vscode/changelog" : `https://github.com/goldtagworks/git403/releases/tag/v${__APP_VERSION__}`;

/**
 * 하단 상태바: 현재 브랜치·ahead/behind + 작업 진행률·취소 + 오른쪽 AI 항목(`AiStatusItem`, 자기 구독)·버전(누르면 릴리스 노트).
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
      // 끝나면 비운다: 자동 fetch처럼 문구가 안 바뀌는 작업의 마지막 줄(오류)이 탭을 옮겨도 남지 않게
      setProgress(event.kind === "finished" ? "" : event.line);
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
              <span className={status.ahead ? "up" : undefined}>↑{status.ahead}</span> <span className={status.behind ? "down" : undefined}>↓{status.behind}</span>
            </span>
          )}
        </span>
      )}
      <GhStatusItem />
      <span className="status-progress" aria-live="polite">{progress || message}</span>
      {job && <button onClick={() => api.cancelJob(job.id)}>{t("status.cancel", { name: job.name })}</button>}
      <AiStatusItem />
      <button className="status-version" title={t("status.releaseNotes")} onClick={() => api.openUrl(RELEASE_URL)}>{VERSION}</button>
    </footer>
  );
});
