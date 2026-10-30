import { memo } from "react";
import { t, useLocale } from "../../shared/i18n/i18n";
import { ops } from "../../shared/model/ops";
import { Icon } from "../../shared/ui/Icon";

/** 모바일 첫 화면: 앱 폴더(repos_root)의 저장소 목록. 비었으면 안내 + 큰 [복제] 버튼 */
export const RepoList = memo(function RepoList({ repos, pending, onOpen, onForget }: { repos: string[]; pending: string | null; onOpen: (path: string) => void; onForget: (path: string) => void }) {
  useLocale();
  return (
    <section className="m-screen">
      <header className="m-bar">
        <h1 className="m-bar-title">{t("app.repoList")}</h1>
        <button className="m-ico" aria-label={t("toolbar.settingsLabel")} onClick={() => ops.openSettings()}><Icon name="settings" size={20} /></button>
      </header>
      {repos.length ? (
        <ul className="m-repos" aria-label={t("app.repoList")}>
          {repos.map((r) => (
            <li key={r}>
              <button onClick={() => onOpen(r)} aria-busy={r === pending || undefined}>
                <span className="m-name">{r.split(/[\\/]/).pop()}</span>
                <span className="m-hint">{r}</span>
              </button>
              <button className="m-ico" aria-label={t("app.forgetOne", { path: r })} onClick={() => onForget(r)}><Icon name="dismiss" size={16} /></button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-empty">{t("m.noRepos")}</p>
      )}
      <footer className="m-foot"><button className="primary" onClick={ops.clone}>{t("app.clone")}</button></footer>
    </section>
  );
});
