import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../../shared/api/api";
import { AiPanel } from "../../features/ai/AiSheets";
import { SettingsTransfer } from "./SettingsTransfer";
import { SettingsBlock, SettingsGroup, SettingsNote, SettingsQuery, SettingsRow } from "../../shared/ui/SettingsLayout";
import { Icon } from "../../shared/ui/Icon";
import type { IconName } from "../../shared/ui/icons";
import { Sheet, SheetActions, SheetHead } from "../../shared/ui/Sheet";
import { AccountsPanel } from "../../features/hosting/HostingSheets";
import { LANGS, t, useLocale, type Key } from "../../shared/i18n/i18n";
import { ctx, isMac, ops, stored } from "../../shared/model/ops";
import { ask, IS_VSCODE } from "../../shared/api/bridge";
import { checkUpdate, onUpdate, updateState } from "../../shared/lib/update";
import { countRender } from "../../shared/lib/profile";
import { addTemplate, AUTO_FETCH_MINUTES, clampLimit, GRAPH_LIMIT_RANGE, IGNORE_TEMPLATES, JIRA_RE, onPrefs, pref, setPref, PULL_KEY, pullConfig, pullMode, signingState, validEmail, type PullMode } from "../../shared/lib/settings";
import { ACCENTS, applyAccent, readAccent, type ThemeMode } from "../../shared/lib/theme";
import { cleanJiraKeys, cleanJiraUrl, jiraCfg, type IssueRule, type JiraSuggestion } from "../../shared/lib/issues";
import type { CustomCommand } from "../../shared/lib/custom";
import type { SshKey } from "../../shared/api/types";
import { isMobile } from "../../shared/lib/platform";

// 설정 창(⌘/Ctrl+,): 왼쪽 탭 목록 + 본문. 진입점은 ops.openSettings(tab).
// 계정·도구·이슈 링크는 기존 시트·ops를 그대로 쓰고, 여기서는 버튼으로 연다. 자주 바뀌는 입력 상태는 각 탭 안에만 있다.

// 왼쪽 탐색은 의미 단위 3묶음: 앱(일반·도구) / 저장소(Git·gitignore·이슈 링크) / 연결(계정·SSH·AI). 묶음마다 아이콘 색이 다르다(토큰 --nav-*)
const TABS = [
  { id: "general", label: "settings.tab.general", icon: "tuning", group: "app" },
  { id: "tools", label: "settings.tab.tools", icon: "terminal", group: "app" },
  { id: "git", label: "Git", icon: "branch", group: "repo" },
  { id: "ignore", label: "gitignore", icon: "eyeClosed", group: "repo" },
  { id: "issues", label: "settings.tab.issues", icon: "link", group: "repo" },
  { id: "accounts", label: "settings.tab.accounts", icon: "user", group: "link" },
  { id: "ssh", label: "settings.tab.ssh", icon: "key", group: "link" },
  { id: "ai", label: "AI", icon: "sparkle", group: "link" },
] as const satisfies readonly { id: string; label: string; icon: IconName; group: string }[];
const GROUPS = ["app", "repo", "link"] as const;
/** 탭 이름: 문구 키면 번역하고 아니면(Git·AI·gitignore) 그대로 */
const tabName = (label: string) => (label.startsWith("settings.") ? t(label as Key) : label);
type TabId = "general" | "git" | "accounts" | "ai" | "tools" | "ignore" | "ssh" | "issues";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const THEMES: [ThemeMode, Key][] = [["system", "settings.theme.system"], ["light", "settings.theme.light"], ["dark", "settings.theme.dark"]];

function GeneralTab({ theme, onTheme }: { theme: ThemeMode; onTheme: (m: ThemeMode) => void }) {
  const [restore, setRestore] = useState(() => pref("restoreTabs"));
  const [limit, setLimit] = useState(() => String(pref("graphLimit")));
  const [auto, setAuto] = useState(() => pref("autoFetch"));
  const layout = useSyncExternalStore(onPrefs, () => pref("detailLayout")); // 탭 줄 버튼·⌘⌥B로 바뀌어도 따라간다
  const [autoUp, setAutoUp] = useState(() => pref("autoUpdate"));
  const [ignoreEol, setIgnoreEol] = useState(() => pref("ignoreEol"));
  const [accent, setAccent] = useState(readAccent);
  const up = useSyncExternalStore(onUpdate, updateState);
  const lang = useSyncExternalStore(onPrefs, () => pref("language"));
  const commitLimit = () => {
    const n = clampLimit(limit);
    setLimit(String(n));
    if (n !== pref("graphLimit")) ops.setPref("graphLimit", n);
  };
  return (
    <form className="panel-form" aria-label={t("settings.tab.general")} noValidate onSubmit={(e) => (e.preventDefault(), commitLimit())}>
      <SettingsGroup title={t("settings.group.appearance")}>
        <SettingsRow name={t("settings.theme")}>
          <select value={theme} onChange={(e) => onTheme(e.target.value as ThemeMode)}>
            {THEMES.map(([m, l]) => <option key={m} value={m}>{t(l)}</option>)}
          </select>
        </SettingsRow>
        <SettingsRow name={t("settings.language")}>
          <select aria-label={t("settings.languageLabel")} value={lang} onChange={(e) => setPref("language", e.target.value as typeof lang)}>
            <option value="system">{t("settings.language.system")}</option>
            {LANGS.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </SettingsRow>
        <SettingsRow name={t("settings.accent")}>
          <span className="accents" role="radiogroup" aria-label={t("settings.accent")}>
            {ACCENTS.map(([id, label, color]) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={accent === id}
                aria-label={t(label)}
                title={t(label)}
                className={"swatch" + (id === "system" ? " system" : "")}
                style={color ? { background: color } : undefined}
                onClick={() => (setAccent(id), applyAccent(id))}
              />
            ))}
          </span>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t("settings.group.startup")}>
        <SettingsRow name={t("settings.restoreTabs")}>
          <input type="checkbox" checked={restore} onChange={(e) => (setRestore(e.target.checked), ops.setPref("restoreTabs", e.target.checked))} />
        </SettingsRow>
        <SettingsRow name={t("settings.detailLayout")} desc={t("settings.detailLayoutHelp")}>
          <select value={layout} onChange={(e) => { ops.setPref("detailLayout", e.target.value as "right" | "bottom"); }}>
            <option value="right">{t("settings.layoutRight")}</option>
            <option value="bottom">{t("settings.layoutBottom")}</option>
          </select>
        </SettingsRow>
        <SettingsRow name={t("settings.graphLimit", { min: GRAPH_LIMIT_RANGE[0].toLocaleString(), max: GRAPH_LIMIT_RANGE[1].toLocaleString() })} desc={t("settings.graphLimitHelp")}>
          <span className="folder-field">
            <input type="number" inputMode="numeric" aria-label={t("settings.graphLimitLabel")} min={GRAPH_LIMIT_RANGE[0]} max={GRAPH_LIMIT_RANGE[1]} step={100} value={limit} onChange={(e) => setLimit(e.target.value)} />
            <button type="submit">{t("common.apply")}</button>
          </span>
        </SettingsRow>
        <SettingsRow name={t("settings.autoFetch")} desc={t("settings.autoFetchHelp")}>
          <select value={auto} onChange={(e) => { const n = Number(e.target.value); setAuto(n); ops.setPref("autoFetch", n); }}>
            {AUTO_FETCH_MINUTES.map((m) => <option key={m} value={m}>{m ? t("settings.autoEvery", { m }) : t("settings.autoOff")}</option>)}
          </select>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t("settings.group.diff")}>
        <SettingsRow name={t("settings.ignoreEol")} desc={t("settings.ignoreEolHelp")}>
          <input type="checkbox" checked={ignoreEol} onChange={(e) => (setIgnoreEol(e.target.checked), ops.setPref("ignoreEol", e.target.checked))} />
        </SettingsRow>
        <SettingsRow>
          <button type="button" disabled={!ctx.repo} onClick={() => ops.eolSuggest(ctx.repo, true)}>{t("settings.eolFix")}</button>
        </SettingsRow>
      </SettingsGroup>
      {!IS_VSCODE && !isMobile && (
        <SettingsGroup title={t("settings.group.update")}>
          <SettingsRow name={t("settings.autoUpdate")} desc={<span role="status">{up.phase === "checking" ? t("settings.checking") : up.phase === "available" ? t("settings.updateAvail", { v: up.version ?? "" }) : up.message ?? ""}</span>}>
            <span className="folder-field">
              <button type="button" disabled={up.phase === "checking" || up.phase === "downloading"} onClick={() => checkUpdate(true)}>{t("settings.checkNow")}</button>
              <input type="checkbox" aria-label={t("settings.autoUpdate")} checked={autoUp} onChange={(e) => (setAutoUp(e.target.checked), ops.setPref("autoUpdate", e.target.checked))} />
            </span>
          </SettingsRow>
        </SettingsGroup>
      )}
      <SettingsTransfer onTheme={onTheme} />
    </form>
  );
}

const COMMON = { spellCheck: false, autoComplete: "off" } as const;

function GitTab() {
  type Vals = { gName: string; gEmail: string; lName: string; lEmail: string; branch: string; pull: PullMode };
  const [init, setInit] = useState<Vals | null>(null);
  const [v, setV] = useState<Vals | null>(null);
  const [sign, setSign] = useState<ReturnType<typeof signingState> | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const hasRepo = !!ctx.repo;
  const load = useCallback(async () => {
    const [g, l, all] = await Promise.all([ops.cfgRead("global"), hasRepo ? ops.cfgRead("local") : Promise.resolve({} as Record<string, string>), ops.cfgRead("all")]);
    const vals: Vals = {
      gName: g["user.name"] ?? "", gEmail: g["user.email"] ?? "", lName: l["user.name"] ?? "", lEmail: l["user.email"] ?? "",
      branch: g["init.defaultbranch"] ?? "", pull: pullMode(g["pull.rebase"], g["pull.ff"]),
    };
    setInit(vals);
    setV(vals);
    setSign(signingState(all));
  }, [hasRepo]);
  useEffect(() => void load().catch((e) => setErr(errText(e))), [load]);
  if (!v || !init) return err ? <p className="warn selectable" role="alert">{err}</p> : <p className="help">{t("settings.reading")}</p>;

  const set = (k: keyof Vals, x: string) => setV({ ...v, [k]: x } as Vals);
  const dirty = (Object.keys(v) as (keyof Vals)[]).some((k) => v[k] !== init[k]);
  const save = async () => {
    const bad = [[t("settings.scopeGlobal"), v.gEmail], [t("settings.scopeRepo"), v.lEmail]].filter(([, e]) => e.trim() && !validEmail(e.trim()));
    if (bad.length) return setErr(t("settings.badEmail", { who: bad.map(([n]) => n).join("·") }));
    setErr("");
    setBusy(true);
    const str = (x: string) => x.trim() || null;
    try {
      if (v.gName !== init.gName) await ops.cfgWrite("global", "user.name", str(v.gName));
      if (v.gEmail !== init.gEmail) await ops.cfgWrite("global", "user.email", str(v.gEmail));
      if (hasRepo && v.lName !== init.lName) await ops.cfgWrite("local", "user.name", str(v.lName));
      if (hasRepo && v.lEmail !== init.lEmail) await ops.cfgWrite("local", "user.email", str(v.lEmail));
      if (v.branch !== init.branch) await ops.cfgWrite("global", "init.defaultBranch", str(v.branch));
      if (v.pull !== init.pull) {
        const [rebase, ff] = pullConfig(v.pull);
        await ops.cfgWrite("global", "pull.rebase", rebase);
        await ops.cfgWrite("global", "pull.ff", ff);
      }
      ctx.notify(t("settings.saved"));
      await load();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="panel-form" aria-label="Git" noValidate onSubmit={(e) => (e.preventDefault(), !busy && save())}>
      <SettingsGroup title={t("settings.userGlobal")}>
        <SettingsRow name={t("settings.name")}><input {...COMMON} aria-label={t("settings.gName")} value={v.gName} onChange={(e) => set("gName", e.target.value)} /></SettingsRow>
        <SettingsRow name={t("settings.email")}><input {...COMMON} type="email" aria-label={t("settings.gEmail")} value={v.gEmail} onChange={(e) => set("gEmail", e.target.value)} /></SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t("settings.overrideRepo")}>
        {hasRepo ? (
          <>
            <SettingsRow name={t("settings.name")}><input {...COMMON} aria-label={t("settings.rName")} value={v.lName} placeholder={v.gName} onChange={(e) => set("lName", e.target.value)} /></SettingsRow>
            <SettingsRow name={t("settings.email")} desc={t("settings.overrideHelp")}><input {...COMMON} type="email" aria-label={t("settings.rEmail")} value={v.lEmail} placeholder={v.gEmail} onChange={(e) => set("lEmail", e.target.value)} /></SettingsRow>
          </>
        ) : (
          <SettingsNote>{t("settings.overrideNoRepo")}</SettingsNote>
        )}
      </SettingsGroup>
      <SettingsGroup title={t("settings.defaults")}>
        <SettingsRow name={t("settings.defaultBranch")}><input {...COMMON} aria-label={t("settings.defaultBranchLabel")} value={v.branch} placeholder="master" onChange={(e) => set("branch", e.target.value)} /></SettingsRow>
        <SettingsRow name={t("settings.pullBehavior")}>
          <select aria-label={t("settings.pullBehavior")} value={v.pull} onChange={(e) => set("pull", e.target.value)}>
            {(Object.keys(PULL_KEY) as PullMode[]).map((m) => <option key={m} value={m}>{t(PULL_KEY[m])}</option>)}
          </select>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t("settings.signing")}>
        <SettingsNote aria-label={t("settings.signingState")}>
          {sign?.on ? t("settings.signOn", { format: sign.format, key: sign.key ? t("settings.signKey", { key: sign.key }) : "" }) : t("settings.signOff")}{t("settings.signHelp")}
        </SettingsNote>
      </SettingsGroup>
      {err && <p className="warn selectable" role="alert">{err}</p>}
      <div className="sheet-actions"><button type="submit" className="primary" disabled={!dirty || busy}>{t("common.save")}</button></div>
    </form>
  );
}

/** 텍스트 파일 편집기 + 템플릿 추가. 저장 전까지는 화면에서만 바뀐다 */
function IgnoreEditor({ title, load, save }: { title: string; load: () => Promise<string>; save: (t: string) => Promise<void> }) {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [tpl, setTpl] = useState(Object.keys(IGNORE_TEMPLATES)[0]);
  const [err, setErr] = useState("");
  useEffect(() => void load().then((t) => (setText(t), setSaved(t)), (e) => setErr(errText(e))), [load]);
  if (text === null) return err ? <p className="warn selectable" role="alert">{err}</p> : <p className="help">{t("settings.reading")}</p>;
  return (
    <div className="ignore-editor">
      <textarea aria-label={title} className="mono" rows={9} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} />
      <div className="ignore-bar">
        <select aria-label={t("settings.templateLabel", { title })} value={tpl} onChange={(e) => setTpl(e.target.value)}>
          {Object.keys(IGNORE_TEMPLATES).map((n) => <option key={n}>{n}</option>)}
        </select>
        <button type="button" onClick={() => { const r = addTemplate(text, tpl); setText(r.text); if (!r.added) ctx.notify(t("settings.templateExists", { name: tpl })); }}>{t("settings.addTemplate")}</button>
        <span className="spacer" />
        <button type="button" className="primary" disabled={text === saved} onClick={async () => {
          try {
            await save(text);
            setSaved(text);
            setErr("");
            ctx.notify(t("settings.savedTitle", { title }));
          } catch (e) {
            setErr(errText(e));
          }
        }}>{t("common.save")}</button>
      </div>
      {err && <p className="warn selectable" role="alert">{err}</p>}
    </div>
  );
}

function IgnoreTab() {
  const repo = ctx.repo;
  const [path, setPath] = useState<string | null>(null);
  const [err, setErr] = useState("");
  // 못 읽으면 path는 null(만들기 버튼 없음) + 오류 — ""로 두면 기존 core.excludesFile을 덮어쓰는 버튼이 뜬다
  useEffect(() => void ops.cfgRead("global").then((g) => setPath(g["core.excludesfile"] ?? ""), (e) => setErr(errText(e))), []);
  const loadRepo = useCallback(() => api.ignoreRead(repo), [repo]);
  const saveRepo = useCallback((t: string) => api.ignoreWrite(repo, t), [repo]);
  const loadGlobal = useCallback(() => api.globalIgnoreRead(path!), [path]);
  const saveGlobal = useCallback((t: string) => api.globalIgnoreWrite(path!, t), [path]);
  const create = async () => {
    try {
      const p = await api.globalIgnoreEnsure();
      await ops.cfgWrite("global", "core.excludesFile", p);
      setPath(p);
      setErr("");
    } catch (e) {
      setErr(errText(e));
    }
  };
  return (
    <div className="panel-form">
      <SettingsGroup title={t("settings.repoIgnore")}>
        <SettingsBlock>
          {repo ? <IgnoreEditor title=".gitignore" load={loadRepo} save={saveRepo} /> : <p className="help">{t("settings.openToEdit")}</p>}
        </SettingsBlock>
      </SettingsGroup>
      <SettingsGroup title={t("settings.globalIgnore")}>
        {path === null ? null : path ? (
          <>
            <SettingsNote className="selectable">core.excludesFile = {path}</SettingsNote>
            <SettingsBlock><IgnoreEditor key={path} title={t("settings.globalIgnoreTitle")} load={loadGlobal} save={saveGlobal} /></SettingsBlock>
          </>
        ) : (
          <>
            <SettingsNote>{t("settings.noGlobalIgnore")}</SettingsNote>
            <SettingsRow><button type="button" onClick={create}>{t("settings.createGlobal")}</button></SettingsRow>
          </>
        )}
      </SettingsGroup>
      {err && <p className="warn selectable" role="alert">{err}</p>}
    </div>
  );
}

function SshTab() {
  const [keys, setKeys] = useState<SshKey[] | null>(null);
  const [name, setName] = useState("");
  const [comment, setComment] = useState("");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const list = await api.sshKeys().catch((e) => (setErr(errText(e)), [] as SshKey[]));
    setKeys(list);
    return list;
  }, []);
  useEffect(() => {
    refresh().then((list) => {
      const taken = new Set(list.map((k) => k.name));
      let n = "id_ed25519", i = 2;
      while (taken.has(`${n}.pub`)) n = `id_ed25519_${i++}`;
      setName(n);
    });
    ops.cfgRead("all", "^user\\.email$").then((c) => setComment((x) => x || (c["user.email"] ?? "")), () => {}); // 주석 기본값 추천일 뿐
  }, [refresh]);
  const generate = async () => {
    if (pass !== pass2) return setErr(t("settings.passMismatch"));
    setErr("");
    setBusy(true);
    try {
      const k = await api.sshGenerate(name.trim(), pass, comment.trim());
      setPass("");
      setPass2("");
      setMade(k.name.replace(/\.pub$/, ""));
      ctx.notify(t("settings.keyCreated", { name: k.name }));
      await refresh();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const addCmd = (n: string) => (isMac ? `ssh-add --apple-use-keychain ~/.ssh/${n}` : `ssh-add ~/.ssh/${n}`);
  return (
    <div className="panel-form">
      <SettingsGroup title={t("settings.sshKeysTitle")} note={t("settings.sshHelp")}>
        <ul className="accounts keys" aria-label={t("settings.sshKeysLabel")}>
          {keys?.map((k) => (
            <li key={k.name}>
              <span className="key-main">
                <span className="label">{k.name} <span className="hint">{k.kind}{k.bits ? ` ${k.bits}` : ""}{k.hasPrivate ? "" : t("settings.noPrivate")}</span></span>
                <span className="hint selectable mono">{k.fingerprint}{k.comment ? ` · ${k.comment}` : ""}</span>
              </span>
              <button type="button" aria-label={t("settings.copyKeyLabel", { name: k.name })} onClick={() => ops.copy(k.public).catch((e) => ctx.error(t("settings.copyFail", { err: errText(e) })))}>{t("settings.copyKey")}</button>
            </li>
          ))}
          {keys?.length === 0 && <li className="hint">{t("settings.noKeys")}</li>}
        </ul>
      </SettingsGroup>
      <form className="panel-form" aria-label={t("settings.newKeyLabel")} onSubmit={(e) => (e.preventDefault(), name.trim() && !busy && generate())}>
        <SettingsGroup title={t("settings.newKey")} note={t("settings.noOverwrite")}>
          <SettingsRow name={t("settings.keyFile")}><input {...COMMON} aria-label={t("settings.keyFileLabel")} value={name} onChange={(e) => setName(e.target.value)} /></SettingsRow>
          <SettingsRow name={t("settings.keyComment")}><input {...COMMON} aria-label={t("settings.keyCommentLabel")} value={comment} placeholder="name@example.com" onChange={(e) => setComment(e.target.value)} /></SettingsRow>
          <SettingsRow name={t("settings.keyPass")}><input type="password" aria-label={t("settings.keyPassLabel")} value={pass} onChange={(e) => setPass(e.target.value)} /></SettingsRow>
          <SettingsRow name={t("settings.keyPass2")}><input type="password" aria-label={t("settings.keyPass2Label")} value={pass2} onChange={(e) => setPass2(e.target.value)} /></SettingsRow>
        </SettingsGroup>
        {err && <p className="warn selectable" role="alert">{err}</p>}
        {made && (
          <p className="help selectable" role="status">
            {t("settings.addAgent")}<code>{addCmd(made)}</code>
          </p>
        )}
        <div className="sheet-actions"><button type="submit" className="primary" disabled={!name.trim() || busy}>{busy ? t("settings.creating") : t("settings.createKey")}</button></div>
      </form>
    </div>
  );
}

function ToolRow({ label, value, action, onClick, disabled }: { label: string; value: string; action: string; onClick: () => void; disabled?: boolean }) {
  return (
    <SettingsRow name={label} desc={<span className="selectable">{value}</span>}>
      <button type="button" onClick={onClick} disabled={disabled}>{action}</button>
    </SettingsRow>
  );
}

function ToolsTab({ refocus }: { refocus: () => void }) {
  const [rev, setRev] = useState(0); // 시트에서 돌아오면 현재 값을 다시 읽는다
  const [tools, setTools] = useState<Record<string, string>>({});
  useEffect(() => void ops.cfgRead("all", "^(diff|merge)\\.tool$").then(setTools, (e) => ctx.error(errText(e))), [rev]);
  const run = (f: () => Promise<unknown>) => async () => (await f(), setRev((n) => n + 1), refocus());
  const none = !ctx.repo;
  const custom = stored<CustomCommand[]>("customCommands", []).length;
  return (
    <div className="panel-form">
      <SettingsGroup note={none ? t("settings.toolsNeedRepo") : undefined}>
      <ToolRow label={t("settings.terminal")} value={stored("terminalApp", "") || t("settings.terminalDefault")} action={t("settings.terminalBtn")} onClick={run(ops.chooseTerminal)} />
      <ToolRow label={t("settings.diffTool")} value={`diff: ${tools["diff.tool"] ?? t("settings.toolUnset")} · merge: ${tools["merge.tool"] ?? t("settings.toolUnset")}`} action={t("settings.diffToolBtn")} onClick={run(() => ops.toolSetup())} disabled={none} />
      <ToolRow label={t("settings.custom")} value={t("settings.customCount", { n: custom })} action={t("settings.customBtn")} onClick={run(ops.manageCustom)} />
      </SettingsGroup>
    </div>
  );
}

type JiraScope = "repo" | "global";
const readScope = (): JiraScope => {
  try {
    return localStorage.getItem("jiraScope") === "global" ? "global" : "repo";
  } catch {
    return "repo";
  }
};
/** Jira 묶음: 저장 범위를 고른다 — 이 저장소만(`git config --local`, 기본) / 모든 저장소(`--global`, ~/.gitconfig). 마지막 선택은 localStorage. 입력 상태는 이 안에만 둔다 */
function JiraGroup({ refocus, onChange }: { refocus: () => void; onChange: () => void }) {
  const repo = ctx.repo;
  type Vals = { g: { url: string; keys: string }; l: { url: string; keys: string }; off: boolean };
  const [init, setInit] = useState<Vals | null>(null);
  const [scope, setScopeState] = useState<JiraScope>(() => (repo ? readScope() : "global"));
  const [v, setV] = useState({ url: "", keys: "", off: false });
  const [err, setErr] = useState("");
  const [sug, setSug] = useState<JiraSuggestion | null>(null);
  const seq = useRef(0);
  const own = (vals: Vals, sc: JiraScope) => (sc === "global" ? vals.g : vals.l);
  const load = useCallback(async (sc: JiraScope) => {
    const [g, l] = await Promise.all([ops.cfgRead("global", JIRA_RE), repo ? ops.cfgRead("local", JIRA_RE) : Promise.resolve({} as Record<string, string>)]);
    const [gc, lc] = [jiraCfg(g), jiraCfg(l)];
    const vals: Vals = { g: { url: gc.url ?? "", keys: gc.keys ?? "" }, l: { url: lc.url ?? "", keys: lc.keys ?? "" }, off: !!lc.off };
    setInit(vals);
    setV({ ...own(vals, sc), off: vals.off });
    return vals;
  }, [repo]);
  useEffect(() => {
    // 탭을 열 때 한 번: Jira가 아직 없고(끄지도 않았고) 무시한 적 없는 저장소에서만 조용히 추천을 찾는다
    const my = ++seq.current;
    setSug(null);
    load(scope).then(async (vals) => {
      if (!repo || vals.off || vals.g.url || vals.l.url || ops.jiraDismissed(repo)) return;
      const s = await ops.jiraSuggest(repo).catch(() => null);
      if (s && my === seq.current && repo === ctx.repo) setSug(s);
    }, (e) => setErr(errText(e))); // 못 읽었으면 "Jira 없음"으로 추천하지 않는다
  }, [load, repo]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!init) return err ? <p className="warn selectable" role="alert">{err}</p> : null;
  const setScope = (sc: JiraScope) => {
    setScopeState(sc);
    try {
      localStorage.setItem("jiraScope", sc);
    } catch {}
    setV({ ...own(init, sc), off: v.off });
    setErr("");
  };
  const set = (k: "url" | "keys" | "off", x: string | boolean) => setV({ ...v, [k]: x });
  const cur = own(init, scope);
  const dirty = v.url !== cur.url || v.keys !== cur.keys || (!!repo && v.off !== init.off);
  const write = async (url: string, keys: string, off: boolean, sc: JiraScope) => {
    const [u, k] = [cleanJiraUrl(url), cleanJiraKeys(keys)];
    if (u === null) return setErr(t("settings.jiraBadUrl"));
    if (k === null) return setErr(t("settings.jiraBadKeys"));
    setErr("");
    try {
      const cs = sc === "repo" ? "local" : "global";
      await ops.cfgWrite(cs, "git403.jira.url", u || null);
      await ops.cfgWrite(cs, "git403.jira.keys", k || null);
      if (repo) await ops.cfgWrite("local", "git403.jira.off", off ? "true" : null);
      ctx.notify(t("settings.saved"));
      setV({ url: u, keys: k, off });
      await load(sc);
      onChange();
    } catch (e) {
      setErr(errText(e));
    }
  };
  const apply = async () => {
    if (!sug) return;
    // 추천은 저장 범위 선택(기본 이 저장소)을 따른다. 주소를 못 찾았으면 키만 입력란에 채워 둔다
    if (!sug.url) return setV({ ...v, keys: sug.keys.join(",") });
    setSug(null);
    await write(sug.url, sug.keys.join(","), false, scope);
  };
  const dismiss = () => (ops.jiraDismissed(repo, true), setSug(null), refocus());
  const delGlobal = async () => {
    if (!(await ask(t("settings.jiraDelGlobalAsk"), { title: "Jira", kind: "warning" }))) return;
    try {
      await ops.cfgWrite("global", "git403.jira.url", null);
      await ops.cfgWrite("global", "git403.jira.keys", null);
      const vals = await load(scope);
      setV({ ...own(vals, scope), off: vals.off });
      onChange();
    } catch (e) {
      setErr(errText(e));
    }
  };
  const origin = init.off ? t("settings.jiraFromOff") : init.l.url ? (init.g.url ? t("settings.jiraFromOverride") : t("settings.jiraFromRepo")) : init.g.url ? t("settings.jiraFromGlobal") : t("settings.jiraFromNone");
  const field = (label: string, k: "url" | "keys", ph: string) => (
    <SettingsRow name={label}><input {...COMMON} aria-label={label} value={v[k]} placeholder={ph} onChange={(e) => set(k, e.target.value)} /></SettingsRow>
  );
  return (
    <form className="panel-form jira" aria-label="Jira" noValidate onSubmit={(e) => (e.preventDefault(), write(v.url, v.keys, v.off, scope))}>
      {sug && (
        <p className="jira-suggest" role="status">
          <span>{sug.url ? t("settings.jiraSuggest", { url: sug.url, keys: sug.keys.join(", ") || t("settings.jiraAnyKey") }) : t("settings.jiraKeysOnly", { key: `${sug.keys[0]}-123` })}</span>
          <button type="button" onClick={apply}>{sug.url ? t("settings.jiraApply") : t("settings.jiraFill")}</button>
          <button type="button" onClick={dismiss}>{t("settings.jiraIgnore")}</button>
        </p>
      )}
      <SettingsGroup title="Jira" note={t("settings.jiraHelp")}>
        <SettingsNote aria-label={t("settings.jiraFrom")}>{origin}</SettingsNote>
        {field(t("settings.jiraUrl"), "url", scope === "repo" ? init.g.url || "https://" : "https://")}
        {field(t("settings.jiraKeys"), "keys", scope === "repo" ? init.g.keys || "KEY1, KEY2" : "KEY1, KEY2")}
      </SettingsGroup>
      {repo ? (
        <SettingsGroup title={t("settings.jiraScope")}>
          <ul className="accounts providers" role="radiogroup" aria-label={t("settings.jiraScope")}>
            {(["repo", "global"] as const).map((sc) => (
              <li key={sc}>
                <label>
                  <input type="radio" name="jira-scope" checked={scope === sc} onChange={() => setScope(sc)} />
                  <span className="label">{t(sc === "repo" ? "settings.jiraScopeRepo" : "settings.jiraScopeGlobal")}</span>
                  <span className="hint">{t(sc === "repo" ? "settings.jiraScopeRepoHint" : "settings.jiraScopeGlobalHint")}</span>
                </label>
              </li>
            ))}
          </ul>
          <SettingsRow name={t("settings.jiraOff")}><input type="checkbox" checked={v.off} onChange={(e) => set("off", e.target.checked)} /></SettingsRow>
        </SettingsGroup>
      ) : (
        <SettingsGroup><SettingsNote>{t("settings.jiraNeedRepo")}</SettingsNote></SettingsGroup>
      )}
      {err && <p className="warn selectable" role="alert">{err}</p>}
      <div className="jira-actions">
        <button type="submit" disabled={!dirty}>{t("common.save")}</button>
        {(init.g.url || init.g.keys) && <button type="button" onClick={delGlobal}>{t("settings.jiraDelGlobal")}</button>}
      </div>
    </form>
  );
}

function IssuesTab({ refocus }: { refocus: () => void }) {
  const [rules, setRules] = useState<IssueRule[] | null>(null);
  const none = !ctx.repo;
  const refresh = useCallback(async () => {
    if (none) return;
    const r = await ops.issueLoad(ctx.repo).catch(() => []);
    setRules(r);
    return r;
  }, [none]);
  useEffect(() => void refresh(), [refresh]);
  return (
    <div className="panel-form">
      <JiraGroup refocus={refocus} onChange={() => refresh().then((r) => r && ctx.setIssues(r))} />
      {none ? (
        <SettingsGroup><SettingsNote>{t("settings.issuesNeedRepo")}</SettingsNote></SettingsGroup>
      ) : (
        <SettingsGroup title={t("settings.issuesList")} note={t("settings.issuesHelp")}>
          <ul className="accounts" aria-label={t("settings.issuesList")}>
            {rules?.map((r) => (
              <li key={r.id}>
                <span className="label mono">{r.regex}</span>
                <span className="hint">{r.id === "auto" ? t("settings.auto") : r.url}</span>
              </li>
            ))}
            {rules?.length === 0 && <li className="hint">{t("settings.noRules")}</li>}
          </ul>
          <SettingsRow><button type="button" onClick={async () => (await ops.manageIssues(), refresh(), refocus())}>{t("settings.rulesBtn")}</button></SettingsRow>
        </SettingsGroup>
      )}
    </div>
  );
}

export const SettingsHost = memo(function SettingsHost({ theme, onTheme }: { theme: ThemeMode; onTheme: (m: ThemeMode) => void }) {
  countRender("Settings");
  useLocale();
  const [tab, setTab] = useState<TabId | null>(null);
  const [query, setQuery] = useState("");
  const last = useRef<TabId>("general");
  const dialog = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ctx.showSettings = (t) => (setQuery(""), setTab((TABS.find((x) => x.id === t)?.id as TabId | undefined) ?? last.current));
  }, []);
  useEffect(() => void (tab && (last.current = tab)), [tab]);
  const ref = useCallback((el: HTMLElement | null) => void (dialog.current = el as HTMLDivElement | null), []);
  const refocus = useCallback(() => dialog.current?.focus(), []);
  if (!tab) return null;
  const close = () => setTab(null);
  const move = (d: number) => setTab(TABS[(TABS.findIndex((x) => x.id === tab) + d + TABS.length) % TABS.length].id as TabId);
  const searching = query.trim() !== "";
  const body = (id: TabId) => (
    <>
      {id === "general" && <GeneralTab theme={theme} onTheme={onTheme} />}
      {id === "git" && <GitTab />}
      {id === "accounts" && <AccountsPanel />}
      {id === "ai" && <AiPanel />}
      {id === "tools" && <ToolsTab refocus={refocus} />}
      {id === "ignore" && <IgnoreTab />}
      {id === "ssh" && <SshTab />}
      {id === "issues" && <IssuesTab refocus={refocus} />}
    </>
  );

  return (
    <Sheet label={t("settings.dialog")} size="settings" onClose={close} dialogRef={ref}>
      <SheetHead title={t("settings.dialog")} icon="settings" onClose={close} className="settings-bar" />
      <div className="settings-body">
        <nav className="settings-nav">
          <div className="settings-search">
            <Icon name="search" size={14} />
            <input type="search" aria-label={t("settings.search")} placeholder={t("settings.search")} autoComplete="off" spellCheck={false} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && query && (e.stopPropagation(), setQuery(""))} />
          </div>
          <div
            role="tablist"
            aria-orientation="vertical"
            aria-label={t("settings.tabsLabel")}
            className="settings-tabs"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                move(e.key === "ArrowDown" ? 1 : -1);
                requestAnimationFrame(() => document.querySelector<HTMLElement>('.settings-tabs [aria-selected="true"]')?.focus());
              }
            }}
          >
            {GROUPS.map((g) => (
              <div key={g} className="nav-group" data-group={g}>
                {TABS.filter((x) => x.group === g).map((x) => (
                  <button key={x.id} role="tab" id={`stab-${x.id}`} aria-selected={!searching && x.id === tab} aria-controls="settings-panel" tabIndex={x.id === tab ? 0 : -1} onClick={() => (setQuery(""), setTab(x.id as TabId))}>
                    <Icon name={x.icon} size={16} />
                    <span>{tabName(x.label)}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </nav>
          <div className={"settings-panel" + (searching ? " searching" : "")} role="tabpanel" id="settings-panel" aria-labelledby={`stab-${tab}`}>
            {searching ? (
              <SettingsQuery.Provider value={query}>
                {TABS.map((x) => (
                  <section key={x.id} className="ssec">
                    <h2 className="settings-title">{tabName(x.label)}</h2>
                    {body(x.id as TabId)}
                  </section>
                ))}
                <p className="settings-empty">{t("settings.noMatch")}</p>
              </SettingsQuery.Provider>
            ) : (
              <>
                <h2 className="settings-title">{tabName(TABS.find((x) => x.id === tab)?.label ?? "")}</h2>
                {body(tab)}
              </>
            )}
          </div>
      </div>
      <SheetActions cancel={t("common.close")} />
    </Sheet>
  );
});

/** 자동 fetch 타이머. 화면은 없고, 간격 설정이 바뀔 때만 다시 그려진다 */
/** 자동 fetch: 켜져 있으면 저장소를 열거나 탭을 바꿀 때 한 번(그래프를 다 읽은 뒤), 이후 간격마다 */
export function AutoFetch({ repo }: { repo: string }) {
  const minutes = useSyncExternalStore(onPrefs, () => pref("autoFetch"));
  useEffect(() => {
    if (!pref("autoFetch") || !repo) return; // 간격 설정을 바꿀 때는 돌지 않게 repo에만 반응한다
    const id = setTimeout(ops.autoFetch, 1500);
    return () => clearTimeout(id);
  }, [repo]);
  useEffect(() => {
    if (!minutes) return;
    const id = setInterval(ops.autoFetch, minutes * 60_000);
    return () => clearInterval(id);
  }, [minutes]);
  return null;
}
