import { SettingsGroup, SettingsRow } from "../../shared/ui/SettingsLayout";
import { useEffect, useRef, useState } from "react";
import { pref } from "../../shared/lib/settings";
import { Sheet, SheetActions, SheetBody, SheetHead } from "../../shared/ui/Sheet";
import { t, useLocale, type Key } from "../../shared/i18n/i18n";
import { api } from "../../shared/api/api";
import { ctx, ops, prBus, type AiCall, type PrInit, type PrProbe, type PrState, useAiOn } from "../../shared/model/ops";
import { AiSources } from "../ai/AiSources";
import { Markdown } from "../../shared/ui/Markdown";
import type { AiSource, HostAccount, HostProvider } from "../../shared/api/types";

// 계정 패널(설정 창의 '계정' 탭, ops.manageAccounts()가 연다)과 Pull Request 시트(ops.createPr(), ctx.showPr로 연결).

const NAME: Record<HostProvider, string> = { github: "GitHub", gitlab: "GitLab", bitbucket: "Bitbucket", gitea: "Gitea" };
const DEFAULT_HOST: Record<HostProvider, string> = { github: "github.com", gitlab: "gitlab.com", bitbucket: "bitbucket.org", gitea: "gitea.com" };

/** 계정 추가에서 고르는 서비스. selfHost면 호스트 주소를 입력받는다 */
const SERVICES: { label: string | Key; provider: HostProvider; selfHost: boolean }[] = [
  { label: "GitHub", provider: "github", selfHost: false },
  { label: "GitLab", provider: "gitlab", selfHost: false },
  { label: "Bitbucket", provider: "bitbucket", selfHost: false },
  { label: "hosting.svc.ghe", provider: "github", selfHost: true },
  { label: "hosting.svc.gl", provider: "gitlab", selfHost: true },
  { label: "hosting.svc.gitea", provider: "gitea", selfHost: true },
];

const base = (host: string) => (/^https?:\/\//i.test(host) ? host : `https://${host}`).replace(/\/+$/, "");

/** 서비스별 토큰 발급 페이지와 필요한 권한 */
function tokenHelp(provider: HostProvider, host: string): { url: string; text: string } {
  const b = base(host || DEFAULT_HOST[provider]);
  switch (provider) {
    case "github":
      return { url: `${b}/settings/tokens/new?scopes=repo&description=git403`, text: t("hosting.help.github") };
    case "gitlab":
      return { url: `${b}/-/user_settings/personal_access_tokens?name=git403&scopes=api`, text: t("hosting.help.gitlab") };
    case "bitbucket":
      return { url: "https://bitbucket.org/account/settings/app-passwords/new", text: t("hosting.help.bitbucket") };
    case "gitea":
      return { url: `${b}/user/settings/applications`, text: t("hosting.help.gitea") };
  }
}

/** 설정 창 '계정' 탭 본문 */
export function AccountsPanel() {
  useLocale();
  const [list, setList] = useState<HostAccount[] | null>(null);
  const [svc, setSvc] = useState(0);
  const [host, setHost] = useState("");
  const [token, setToken] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [restore, setRestore] = useState(pref("ghRestore"));
  const [autoSw, setAutoSw] = useState(pref("ghAutoSwitch"));
  const refresh = () => api.accountsList().then(setList, (e) => ctx.error(String(e)));
  useEffect(() => void refresh(), []);

  const s = SERVICES[svc];
  const help = tokenHelp(s.provider, s.selfHost ? host.trim() : "");
  const ready = token.trim() && (!s.selfHost || host.trim());
  const add = async () => {
    if (s.selfHost && !(await ops.confirmInsecure(host))) return;
    setBusy(true);
    setErr("");
    try {
      const a = await api.accountAdd(s.provider, s.selfHost ? host.trim() : "", token.trim());
      setToken("");
      ctx.notify(t("hosting.connected", { name: NAME[a.provider], user: a.username }), { kind: "success" });
      prBus.emit();
      await refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <form className="panel-form" aria-label={t("hosting.accountsLabel")} onSubmit={(e) => (e.preventDefault(), ready && !busy && add())}>
        <SettingsGroup title={t("hosting.listLabel")} note={t("hosting.intro")}>
          <ul className="accounts" aria-label={t("hosting.listLabel")}>
            {list?.map((a) => (
              <li key={`${a.provider}:${a.host}:${a.username}`}>
                <span className="label">{NAME[a.provider]} · {a.username}</span>
                <span className="hint">{a.host}</span>
                <button type="button" aria-label={t("hosting.removeLabel", { user: a.username })} onClick={async () => (await ops.removeAccount(a)) && refresh()}>{t("hosting.remove")}</button>
              </li>
            ))}
            {list?.length === 0 && <li className="hint">{t("hosting.noAccounts")}</li>}
          </ul>
        </SettingsGroup>
        <SettingsGroup
          title={t("hosting.connect")}
          note={<>{help.text}{" "}<a href={help.url} className="issue-link" onClick={(e) => (e.preventDefault(), ops.openUrl(help.url))}>{t("hosting.openTokenPage")}</a></>}
        >
          <SettingsRow name={t("hosting.service")}>
            <select value={svc} onChange={(e) => setSvc(Number(e.target.value))}>
              {SERVICES.map((x, i) => <option key={x.label} value={i}>{x.label.startsWith("hosting.") ? t(x.label as Key) : x.label}</option>)}
            </select>
          </SettingsRow>
          {s.selfHost && (
            <SettingsRow name={t("hosting.host")}>
              <input value={host} placeholder={t("hosting.hostPlaceholder")} spellCheck={false} onChange={(e) => setHost(e.target.value)} />
            </SettingsRow>
          )}
          <SettingsRow name={s.provider === "bitbucket" ? t("hosting.tokenBb") : t("hosting.token")}>
            <input type="password" value={token} spellCheck={false} placeholder={s.provider === "bitbucket" ? t("hosting.tokenBb") : ""} onChange={(e) => setToken(e.target.value)} />
          </SettingsRow>
        </SettingsGroup>
        {err && <p className="warn selectable" role="alert">{err}</p>}
        <div className="sheet-actions">
          <button type="submit" className="primary" disabled={!ready || busy}>{busy ? t("hosting.verifying") : t("hosting.connect")}</button>
        </div>
        <SettingsGroup>
          <SettingsRow name={t("settings.ghRestore")}>
            <input type="checkbox" checked={restore} onChange={(e) => (setRestore(e.target.checked), ops.setPref("ghRestore", e.target.checked))} />
          </SettingsRow>
          <SettingsRow name={t("gh.autoSwitch")}>
            <input type="checkbox" checked={autoSw} onChange={(e) => (setAutoSw(e.target.checked), ops.setPref("ghAutoSwitch", e.target.checked))} />
          </SettingsRow>
        </SettingsGroup>
      </form>
    </>
  );
}

function PrSheet({ init, onClose }: { init: PrInit; onClose: () => void }) {
  useLocale();
  const [remote, setRemote] = useState(init.remote);
  const [bases, setBases] = useState(init.bases);
  const [baseName, setBaseName] = useState(init.base);
  const [probe, setProbe] = useState<PrProbe>(init.probe);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState(init.template);
  const [preview, setPreview] = useState(false);
  const bodyH = useRef(0); // 미리보기를 입력칸과 같은 높이로(사용자가 늘린 높이 포함)
  const [draft, setDraft] = useState(false);
  const [pushFirst, setPushFirst] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const seq = useRef(0);
  const aiOn = useAiOn();
  const aiCall = useRef<AiCall<{ title: string; body: string }> | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [sources, setSources] = useState<AiSource[]>([]); // 마지막 AI 결과가 따른 저장소 규칙
  useEffect(() => () => aiCall.current?.cancel(), []); // 시트를 닫으면 요청 취소

  const info = init.infos.find((i) => i.remote === remote)!;
  const [head, setHead] = useState(init.head);
  // head 후보: 로컬 브랜치 + 이 원격의 브랜치(로컬에 없는 것)
  const heads = [...new Set([init.head, ...ops.prHeads(remote)])];

  /** head·원격·base가 바뀌면 원격 상태(Push 필요 여부)를 다시 읽는다 */
  const reprobe = async (r: string, b: string, h = head) => {
    const mine = ++seq.current;
    const p = await ops.prProbe(h, r, b);
    if (mine !== seq.current) return;
    setProbe(p);
  };
  const changeRemote = async (r: string) => {
    setRemote(r);
    const list = ops.prBases(r);
    const b = await ops.prBase(r, list);
    setBases(list.includes(b) ? list : [b, ...list]);
    setBaseName(b);
    reprobe(r, b);
  };
  const changeHead = (h: string) => {
    setHead(h);
    reprobe(remote, baseName, h);
  };
  const changeBase = (b: string) => {
    setBaseName(b);
    reprobe(remote, b);
  };

  /** 커밋 목록·diff로 제목·본문 초안을 채운다 (고칠 수 있음). 작성 중에 다시 누르면 취소 */
  const aiWrite = async () => {
    if (aiCall.current) return aiCall.current.cancel();
    const call = (aiCall.current = ops.aiPr(head, remote, baseName));
    setAiBusy(true);
    setErr("");
    setSources([]);
    try {
      const r = await call.result;
      if (r) {
        setTitle(r.title.trim());
        setBody(r.body.trim());
        setSources(r.sources ?? []);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      aiCall.current = null;
      setAiBusy(false);
    }
  };

  const needPush = !probe.onRemote || probe.ahead > 0;
  const same = head === baseName;
  const account = info.account;
  const create = () => ops.prSubmit({ account: account!, info, head, base: baseName, title: title.trim(), body, draft });
  const submit = async () => {
    if (!account) return;
    setBusy(true);
    setErr("");
    try {
      if (needPush && pushFirst) {
        onClose();
        ops.pushThenPr(remote, head, !probe.onRemote, create);
        return;
      }
      await create();
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  };
  const web = async () => {
    try {
      ops.openUrl(await api.prWebUrl(info.provider!, info.repo, head, baseName));
      onClose();
    } catch (e) {
      setErr(String(e));
    }
  };
  const blocked = same || !title.trim() || (!probe.onRemote && !pushFirst);

  return (
    <Sheet label={t("hosting.prTitle")} size="wide" className="pr-sheet" onClose={onClose} onSubmit={(e) => (e.preventDefault(), !blocked && !busy && submit())}>
      <SheetHead title={t("hosting.prTitle")} tools={<span className="hint">{info.repo.host}{account ? ` · ${account.username}` : ""}</span>} />
      <SheetBody>
        <div className="pr-flow">
          <fieldset className="pr-side">
            <legend>{t("hosting.from")}</legend>
            <p className="pr-repo">{info.repo.owner}/{info.repo.name}</p>
            <select aria-label={t("hosting.head")} value={head} onChange={(e) => changeHead(e.target.value)}>
              {heads.map((h) => <option key={h}>{h}</option>)}
            </select>
          </fieldset>
          <span className="pr-arrow" aria-hidden="true">→</span>
          <fieldset className="pr-side">
            <legend>{t("hosting.to")}</legend>
            {init.infos.length > 1 ? (
              <select aria-label={t("hosting.remote")} value={remote} onChange={(e) => changeRemote(e.target.value)}>
                {init.infos.map((i) => <option key={i.remote} value={i.remote}>{i.repo.owner}/{i.repo.name} ({i.remote})</option>)}
              </select>
            ) : (
              <p className="pr-repo">{info.repo.owner}/{info.repo.name}</p>
            )}
            <select aria-label={t("hosting.base")} value={baseName} onChange={(e) => changeBase(e.target.value)}>
              {bases.map((b) => <option key={b}>{b}</option>)}
            </select>
          </fieldset>
        </div>
        <div className="field">
          <div className="pr-label-row">
            <span>{t("hosting.title")}</span>
            {aiOn && <button type="button" className="pr-ai" disabled={same && !aiBusy} onClick={aiWrite}>{aiBusy ? t("hosting.aiWriting") : t("hosting.aiWrite")}</button>}
          </div>
          <input className="pr-title" aria-label={t("hosting.title")} placeholder={t("hosting.title")} value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <div className="pr-label-row">
            <span>{t("hosting.body")}</span>
            <div className="segmented" role="radiogroup" aria-label={t("hosting.preview")}>
              <button type="button" role="radio" aria-checked={!preview} onClick={() => setPreview(false)}>{t("hosting.write")}</button>
              <button type="button" role="radio" aria-checked={preview} onClick={() => ((bodyH.current = (document.activeElement?.closest("form")?.querySelector("textarea")?.offsetHeight ?? bodyH.current)), setPreview(true))}>{t("hosting.preview")}</button>
            </div>
          </div>
          {preview ? (
            <div className="pr-preview selectable" style={bodyH.current ? { height: bodyH.current } : undefined}>{body.trim() ? <Markdown text={body} /> : <p className="hint">{t("hosting.previewEmpty")}</p>}</div>
          ) : (
            <textarea rows={10} aria-label={t("hosting.body")} placeholder={t("hosting.body")} value={body} onChange={(e) => setBody(e.target.value)} />
          )}
        </div>
        {aiOn && <AiSources sources={sources} />}
        <label className="field check">
          <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
          {t("hosting.draft")}
        </label>
        {same && <p className="warn">{t("hosting.same")}</p>}
        {needPush && <p className="warn">{probe.onRemote ? t("hosting.ahead", { n: probe.ahead, remote }) : t("hosting.noBranch", { remote, head })}{t("hosting.mustPush")}</p>}
        {needPush && (
          <label className="field check">
            <input type="checkbox" checked={pushFirst} onChange={(e) => setPushFirst(e.target.checked)} />
            {t("hosting.pushThen")}
          </label>
        )}
        {!account && (
          <p className="warn">
            {info.provider ? t("hosting.noAccount", { name: NAME[info.provider] }) : t("hosting.unknownHost")}
          </p>
        )}
        {err && <p className="warn selectable" role="alert">{err}</p>}
      </SheetBody>
      {account ? (
        <SheetActions
          aside={info.provider && !same ? <a href="#" className="issue-link" onClick={(e) => (e.preventDefault(), web())}>{t("hosting.createWeb")}</a> : undefined}
          onCancel={onClose}
          primary={needPush && pushFirst ? t("hosting.pushCreate") : t("hosting.create")}
          disabled={blocked || busy}
          reason={!title.trim() ? t("sheet.needFields") : undefined}
        />
      ) : (
        <SheetActions
          aside={<button type="button" onClick={() => (onClose(), ops.manageAccounts())}>{t("hosting.connectAccount")}</button>}
          onCancel={onClose}
          primary={t("hosting.createWeb")}
          onPrimary={web}
          disabled={!info.provider || same}
        />
      )}
    </Sheet>
  );
}

function DoneSheet({ url, onClose }: { url: string; onClose: () => void }) {
  useLocale();
  return (
    <Sheet label={t("hosting.doneLabel")} onClose={onClose}>
      <SheetHead title={t("hosting.doneTitle")} />
      <SheetBody><p className="selectable">{url}</p></SheetBody>
      <SheetActions cancel={t("common.close")} onCancel={onClose} primary={t("hosting.openPr")} onPrimary={() => (ops.openUrl(url), onClose())} autoFocus />
    </Sheet>
  );
}

/** 계정·PR 시트 자리. App 맨 아래에 한 번만 둔다 (자기 상태만 바뀌므로 다른 화면은 다시 그려지지 않는다) */
export function HostingHost() {
  const [pr, setPr] = useState<PrState | null>(null);
  useEffect(() => {
    ctx.showPr = setPr;
  }, []);
  return (
    <>
      {pr && ("form" in pr ? <PrSheet init={pr.form} onClose={() => setPr(null)} /> : <DoneSheet url={pr.done} onClose={() => setPr(null)} />)}
    </>
  );
}
