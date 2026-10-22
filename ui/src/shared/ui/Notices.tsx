import { memo, useEffect, useState, useSyncExternalStore } from "react";
import { api } from "../api/api";
import { t, useLocale } from "../i18n/i18n";
import { IS_VSCODE } from "../api/bridge";
import { autoCheck, installUpdate, onUpdate, updateState } from "../lib/update";

/** 앱이 쓰는 인자(`--diff-merges`, `rev-parse --path-format` 등)가 요구하는 최소 git */
const MIN_GIT = [2, 31];
/** `2.30.1`, `2.45.1.windows.1` → 최소 버전보다 낮은가 */
export const gitTooOld = (v: string) => {
  const [a, b] = v.split(".").map(Number);
  return a < MIN_GIT[0] || (a === MIN_GIT[0] && b < MIN_GIT[1]);
};

/** git 미설치·구버전 안내·업데이트 알림 배너. 상태가 App 밖에 있어 이 컴포넌트만 다시 그려진다 */
export const Notices = memo(function Notices() {
  useLocale();
  const [noGit, setNoGit] = useState(false);
  const [oldGit, setOldGit] = useState<string | null>(null);
  /** git은 있는데 실행이 실패함(Xcode 라이선스 미동의 등): git이 낸 원문 */
  const [gitErr, setGitErr] = useState<string | null>(null);
  const u = useSyncExternalStore(onUpdate, updateState);

  useEffect(() => void api.gitVersion().then((v) => (v === null ? setNoGit(true) : gitTooOld(v) && setOldGit(v)), (e) => setGitErr(String(e))), []);
  // 시작 직후 한 번, 이후 매시간 "하루 지났는가"만 확인한다
  useEffect(() => {
    if (IS_VSCODE) return;
    const t = setTimeout(autoCheck, import.meta.env.VITE_MOCK ? 0 : 5000);
    const id = setInterval(autoCheck, 60 * 60 * 1000);
    return () => (clearTimeout(t), clearInterval(id));
  }, []);

  return (
    <>
      {noGit && (
        <div className="banner error" role="alert">
          <span>{t("notice.noGit")}</span>
          <button onClick={() => api.openUrl("https://git-scm.com/downloads")}>{t("notice.installGuide")}</button>
          <button onClick={() => setNoGit(false)}>{t("common.close")}</button>
        </div>
      )}
      {gitErr && (
        <div className="banner error selectable" role="alert">
          <span>{gitErr}</span>
          <button onClick={() => setGitErr(null)}>{t("common.close")}</button>
        </div>
      )}
      {oldGit && (
        <div className="banner error" role="alert">
          <span>{t("notice.oldGit", { version: oldGit })}</span>
          <button onClick={() => api.openUrl("https://git-scm.com/downloads")}>{t("notice.installGuide")}</button>
          <button onClick={() => setOldGit(null)}>{t("common.close")}</button>
        </div>
      )}
      {(u.phase === "available" || u.phase === "downloading" || u.phase === "ready") && (
        <div className="banner op" role="status">
          <span>
            {u.phase === "available" && t("notice.available", { version: u.version ?? "" })}
            {u.phase === "downloading" && `${t("notice.downloading", { version: u.version ?? "" })} ${u.percent! >= 0 ? `${u.percent}%` : ""}`}
            {u.phase === "ready" && t("notice.installing", { version: u.version ?? "" })}
            {u.phase === "available" && u.message && ` (${u.message})`}
          </span>
          {u.phase === "downloading" && u.percent! >= 0 && <progress aria-label={t("notice.downloadLabel")} max={100} value={u.percent} />}
          {u.phase === "available" && <button onClick={installUpdate}>{t("notice.updateRestart")}</button>}
        </div>
      )}
    </>
  );
});
