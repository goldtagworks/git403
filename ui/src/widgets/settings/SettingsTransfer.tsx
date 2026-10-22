import { useState } from "react";
import { SettingsGroup, SettingsRow } from "../../shared/ui/SettingsLayout";
import { api } from "../../shared/api/api";
import { pickOpen, pickSave } from "../../shared/api/bridge";
import { t, tErr } from "../../shared/i18n/i18n";
import { ctx, ops } from "../../shared/model/ops";
import { collectUi, hasShellCommand, shortVal, writeUi } from "../../shared/lib/settingsIo";
import { notifyPrefs } from "../../shared/lib/settings";
import { applyAccent, type ThemeMode } from "../../shared/lib/theme";
import { Sheet, SheetActions, SheetBody, SheetHead } from "../../shared/ui/Sheet";
import { toastError } from "../../shared/lib/toast";
import type { SettingsApplied, SettingsPreview, SettingsSectionId } from "../../shared/api/types";

// 설정 > 일반의 "내보내기·가져오기" 버튼과 가져오기 시트. 상태는 이 컴포넌트 안에만 둔다(그래프·사이드바와 무관).

const FILTERS = [{ name: "JSON", extensions: ["json"] }];
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const THEME_IDS = ["system", "light", "dark"];

interface Loaded { json: string; preview: SettingsPreview }

export function SettingsTransfer({ onTheme }: { onTheme: (m: ThemeMode) => void }) {
  const [busy, setBusy] = useState(false);
  const [imp, setImp] = useState<Loaded | null>(null);
  const [err, setErr] = useState("");

  const exportFile = async () => {
    try {
      const path = await pickSave({ title: t("settings.export.title"), defaultPath: "git403-settings.json", filters: FILTERS });
      if (!path) return;
      setBusy(true);
      await api.settingsExportFile(collectUi(), path);
      ctx.notify(t("settings.export.done", { path }));
    } catch (e) {
      toastError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const importFile = async () => {
    setErr("");
    try {
      const path = await pickOpen({ title: t("settings.import.pick"), multiple: false, directory: false, filters: FILTERS });
      if (!path) return;
      setBusy(true);
      const { json } = await api.settingsReadFile(path);
      setImp({ json, preview: await api.settingsImportPreview(json, collectUi()) });
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SettingsGroup title={t("settings.group.backup")}>
        <SettingsRow name={`${t("settings.export.title")} · ${t("settings.import.title")}`} desc={t("settings.export.help")}>
          <span className="folder-field">
            <button type="button" disabled={busy} onClick={exportFile}>{t("settings.export")}</button>
            <button type="button" disabled={busy} onClick={importFile}>{t("settings.import")}</button>
          </span>
        </SettingsRow>
      </SettingsGroup>
      {err && <p className="warn selectable" role="alert">{err}</p>}
      {imp && <ImportSheet loaded={imp} onTheme={onTheme} onClose={() => setImp(null)} />}
    </>
  );
}

/** 적용된 UI 값을 앱 상태에 반영한다: 설정 구독자·언어, 테마, 강조색. 나머지 키는 다음에 읽을 때 적용된다 */
function reflectUi(ui: Record<string, string>, onTheme: (m: ThemeMode) => void) {
  const done = writeUi(ui);
  if (!done.length) return;
  notifyPrefs();
  if (done.includes("theme") && THEME_IDS.includes(ui.theme)) onTheme(ui.theme as ThemeMode);
  if (done.includes("accent")) applyAccent(ui.accent);
}

function ImportSheet({ loaded, onTheme, onClose }: { loaded: Loaded; onTheme: (m: ThemeMode) => void; onClose: () => void }) {
  const { json, preview } = loaded;
  const [sel, setSel] = useState<Set<SettingsSectionId>>(() => new Set(preview.sections.map((s) => s.id)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [res, setRes] = useState<SettingsApplied | null>(null);
  const [restart, setRestart] = useState(false);

  const toggle = (id: SettingsSectionId) => setSel((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  const apply = async () => {
    const ids = preview.sections.map((s) => s.id).filter((id) => sel.has(id));
    setBusy(true);
    setErr("");
    try {
      const r = await api.settingsImportApply(json, ids, collectUi());
      if (r.ui) (reflectUi(r.ui, onTheme), setRestart(true));
      if (ids.includes("ai")) ops.aiLoad(ctx.repo || undefined).catch(() => {});
      if (ids.includes("gitGlobal") && ctx.repo) ops.issueLoad(ctx.repo).then(ctx.setIssues, () => {});
      ctx.notify(t("settings.import.done", { backup: r.backup }));
      setRes(r);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet label={t("settings.import.title")} size="wide" onClose={onClose}>
      <SheetHead title={t("settings.import.title")} />
      <SheetBody>
        {!res && (
          <>
            {preview.warnings.length > 0 && (
              <div role="status" aria-label={t("settings.import.warnings")}>
                {preview.warnings.map((w, i) => <p key={i} className="warn selectable">{tErr(w.code, w.vars, w.message)}</p>)}
              </div>
            )}
            {preview.sections.length === 0 && <p className="help">{t("settings.import.none")}</p>}
            <ul className="imp-list">
              {preview.sections.map((s) => {
                const shell = s.id === "ui" && hasShellCommand(s.changes.find((c) => c.key === "customCommands")?.to);
                return (
                  <li key={s.id} className="imp-section">
                    <label className="field check">
                      <input type="checkbox" aria-label={t(`settings.io.section.${s.id}`)} checked={sel.has(s.id)} onChange={() => toggle(s.id)} />
                      <span>{t(`settings.io.section.${s.id}`)}</span>
                      <span className="hint">{t("settings.import.count", { n: s.changes.length })}</span>
                    </label>
                    {shell && <p className="warn" role="alert">{t("settings.import.shell")}</p>}
                    {s.id === "tools" && <p className="help">{t("settings.import.tools")}</p>}
                    {s.id === "accounts" && <p className="help">{t("settings.import.accounts")}</p>}
                    <details>
                      <summary>{t("settings.import.details")}</summary>
                      <ul className="imp-changes mono selectable">
                        {s.changes.map((c) => <li key={c.key}>{c.key}: {shortVal(c.from)} → {shortVal(c.to)}</li>)}
                      </ul>
                    </details>
                  </li>
                );
              })}
            </ul>
            {preview.skipped.length > 0 && (
              <p className="help" aria-label={t("settings.import.skipped")}>{t("settings.import.skipped")}: {preview.skipped.join(", ")}</p>
            )}
          </>
        )}
        {res && (
          <div role="status" className="imp-result">
            <p className="selectable">{t("settings.import.backup", { backup: res.backup })}</p>
            {restart && <p className="help">{t("settings.import.restart")}</p>}
            {res.skipped.length > 0 && <p className="help">{t("settings.import.resultSkipped", { list: res.skipped.join(", ") })}</p>}
            {res.reconnect.length > 0 && (
              <>
                <p className="warn selectable">{t("settings.import.reconnect", { list: res.reconnect.map((r) => `${r.username}@${r.host}`).join(", ") })}</p>
                <div><button type="button" onClick={() => (onClose(), ops.openSettings("accounts"))}>{t("settings.import.openAccounts")}</button></div>
              </>
            )}
          </div>
        )}
        {err && <p className="warn selectable" role="alert">{err}</p>}
      </SheetBody>
      <SheetActions cancel={res ? t("common.close") : t("common.cancel")} onCancel={onClose} primary={res ? undefined : t("settings.import.apply")} onPrimary={apply} disabled={busy || sel.size === 0} />
    </Sheet>
  );
}
