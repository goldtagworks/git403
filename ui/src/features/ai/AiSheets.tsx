import { SettingsGroup, SettingsNote, SettingsRow } from "../../shared/ui/SettingsLayout";
import { useEffect, useRef, useState } from "react";
import { api } from "../../shared/api/api";
import { t, useLocale, type Key } from "../../shared/i18n/i18n";
import { ctx, ops, useAiOn, type AiState } from "../../shared/model/ops";
import { Sheet, SheetActions, SheetBody, SheetHead } from "../../shared/ui/Sheet";
import { AI_PROVIDERS, aiProvider, providerHint } from "../../shared/model/aiProviders";
import type { AiFinding, AiMethod, AiProvider, AiStatus, ProviderStatus } from "../../shared/api/types";

// AI 결과 시트(리뷰·충돌 도우미)와 설정 창 'AI' 탭. 호출·입력 모으기는 ops.ts(aiCommit·aiReview…·aiConflict·aiPr).

const SEVERITY: Record<AiFinding["severity"], Key> = { high: "ai.sev.high", medium: "ai.sev.medium", low: "ai.sev.low", info: "ai.sev.info" };
const ORDER = ["high", "medium", "low", "info"];

function Findings({ list }: { list: AiFinding[] }) {
  if (!list.length) return <p>{t("ai.noFindings")}</p>;
  const sorted = [...list].sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));
  return (
    <ul className="ai-findings selectable" aria-label={t("ai.findingsLabel")}>
      {sorted.map((f, i) => (
        <li key={i}>
          <span className={`ai-sev ${f.severity}`}>{t(SEVERITY[f.severity])}</span>
          <span className="mono ai-loc">{f.file}{f.line > 0 ? `:${f.line}` : ""}</span>
          <span className="ai-msg">{f.message}</span>
        </li>
      ))}
    </ul>
  );
}

type Outcome = { ok: unknown } | { err: string };

function AiSheet({ s, onClose }: { s: AiState; onClose: () => void }) {
  useLocale();
  const [out, setOut] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    (s.call.result as Promise<unknown>).then(
      (r) => (r === null ? onClose() : live && setOut({ ok: r })), // null = 동의 거절·취소
      (e) => live && setOut({ err: String(e) }),
    );
    // 취소는 닫을 때(AiHost.close) 한다. 여기서 하면 StrictMode의 가짜 unmount가 요청을 취소해 버린다
    return () => void (live = false);
  }, [s]);

  const ok = out && "ok" in out ? out.ok : null;
  const apply = async (s: Extract<AiState, { kind: "conflict" }>, merged: string) => {
    setBusy(true);
    if (await ops.aiApplyConflict(s.repo, s.path, merged, s.fp.v)) onClose();
    else setBusy(false);
  };

  return (
    <Sheet label={s.title} size="wide" onClose={onClose}>
      <SheetHead title={s.title} />
      <SheetBody>
        {!out && <p role="status">{t("ai.analyzing")}</p>}
        {out && "err" in out && <p className="warn selectable" role="alert">{out.err}</p>}
        {s.kind === "review" && ok !== null && <Findings list={(ok as { findings: AiFinding[] }).findings} />}
        {s.kind === "conflict" && ok !== null && (
          <>
            <p className="selectable ai-explain">{(ok as { explanation: string }).explanation}</p>
            <pre className="ai-merged selectable mono" aria-label={t("ai.mergedLabel")} tabIndex={0}>{(ok as { merged: string }).merged}</pre>
            <p className="help">{t("ai.applyHelp")}</p>
          </>
        )}
        {ok !== null && <p className="help">{t("ai.mayBeWrong")}</p>}
      </SheetBody>
      <SheetActions
        cancel={out ? t("common.close") : t("common.cancel")}
        onCancel={onClose}
        primary={s.kind === "conflict" && ok !== null ? t("common.apply") : undefined}
        onPrimary={() => apply(s as Extract<AiState, { kind: "conflict" }>, (ok as { merged: string }).merged)}
        disabled={busy}
      />
    </Sheet>
  );
}

/** AI 결과 시트 자리. App 맨 아래에 한 번만 둔다 (자기 상태만 바뀌므로 다른 화면은 다시 그려지지 않는다) */
export function AiHost() {
  const [s, setS] = useState<AiState | null>(null);
  const cur = useRef<AiState | null>(null);
  useEffect(() => {
    // 새 시트가 열리면 이전 요청은 취소한다
    ctx.showAi = (n) => {
      cur.current?.call.cancel();
      setS((cur.current = n));
    };
  }, []);
  // 시트를 닫으면 요청(·CLI 프로세스)을 취소한다 (이미 끝났으면 아무 일도 안 한다)
  const close = () => {
    cur.current?.call.cancel();
    setS((cur.current = null));
  };
  return s && <AiSheet s={s} onClose={close} />;
}

const METHODS: [AiMethod, Key][] = [["auto", "ai.m.auto"], ["cli", "ai.m.cli"], ["key", "ai.m.key"]];

/** 설정 창 'AI' 탭. 입력 상태는 이 안에만 있다. API 키는 저장 후 화면에 다시 나오지 않는다("설정됨"만) */
export function AiPanel() {
  useLocale();
  const [st, setSt] = useState<AiStatus | null>(null);
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [off, setOff] = useState(false);
  const [convOff, setConvOff] = useState(false);
  const [err, setErr] = useState("");
  const hasRepo = !!ctx.repo;

  const load = async () => {
    const s = await ops.aiLoad(ctx.repo || undefined);
    if (!s) return setErr(t("ai.loadFail"));
    setSt(s);
    setModel(s.model);
    setOff(ctx.ai.repoOff);
    setConvOff(ctx.ai.convOff);
  };
  useEffect(() => void load(), []);
  const run = async (f: () => Promise<unknown>) => {
    setErr("");
    try {
      await f();
      await load();
    } catch (e) {
      setErr(String(e));
    }
  };
  const saveKey = () => key.trim() && run(async () => (await api.aiKeySet(key.trim()), setKey("")));
  const saveModel = () => model.trim() !== st?.model && run(() => api.aiSettingsSet({ model }));
  const setRepoOff = (v: boolean) => run(async () => (await ops.cfgWrite("local", "git403.ai", v ? "false" : null)));
  const setRepoConvOff = (v: boolean) => run(async () => (await ops.cfgWrite("local", "git403.aiConventions", v ? "false" : null)));
  // 공급자를 바꾸면 그 공급자의 모델·입력 중이던 키 칸을 비우고 다시 읽는다
  const pick = (p: AiProvider) => p !== st?.provider && run(async () => (await api.aiSettingsSet({ provider: p, select: true }), setKey("")));

  if (!st) return <p className="help" role="status">{t("ai.checking")}</p>;
  const pv = aiProvider(st.provider);
  const using = st.active === "cli" ? pv.cli : st.active === "key" ? t("ai.apiKey") : t("ai.none");
  return (
    <form className="panel-form" aria-label="AI" noValidate onSubmit={(e) => e.preventDefault()}>
      <SettingsGroup title={t("ai.providerLabel")}>
        <ul className="accounts providers" role="radiogroup" aria-label={t("ai.providerLabel")}>
          {AI_PROVIDERS.map((p) => {
            const x = st.providers.find((v) => v.provider === p.id);
            return (
              <li key={p.id}>
                <label>
                  <input type="radio" name="ai-provider" checked={st.provider === p.id} onChange={() => pick(p.id)} />
                  <span className="label">{p.name}</span>
                  <span className="hint">{x ? providerHint(x) : ""}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </SettingsGroup>
      <SettingsGroup
        title={t("ai.methodLabel")}
        note={<>{t("ai.cliHelpPre")}<span className="mono">{pv.login}</span>{t("ai.cliHelpPost", { cli: pv.cli })}</>}
      >
        <ul className="accounts" aria-label={t("ai.methodLabel")}>
          <li><span className="label">{pv.cli}</span><span className="hint">{st.cli ? t("ai.detected", { v: st.cliVersion ?? "" }) : t("ai.notFound", { cmd: pv.login.split(" ")[0] })}</span></li>
          <li><span className="label">{t("ai.apiKey")}</span><span className="hint">{t(st.key ? "ai.keySet" : "ai.keyNone")}</span></li>
          <li><span className="label">{t("ai.using")}</span><span className="hint">{using}</span></li>
        </ul>
        {!st.cli && <SettingsNote role="note">{t("ai.cliInstall", { cli: pv.cli, cmd: pv.login })}</SettingsNote>}
        {st.provider === "xai" && st.active === "cli" && <SettingsNote className="warn" role="note">{t("ai.grokCliWarn")}</SettingsNote>}
      </SettingsGroup>
      <SettingsGroup title={t("ai.apiKey")}>
        <SettingsRow name={t("ai.method")}>
          <select value={st.method} onChange={(e) => run(() => api.aiSettingsSet({ method: e.target.value as AiMethod }))}>
            {METHODS.map(([m, l]) => <option key={m} value={m}>{t(l)}</option>)}
          </select>
        </SettingsRow>
        <SettingsRow name={t("ai.apiKey")}>
          <span className="folder-field">
            <input type="password" aria-label={t("ai.apiKey")} autoComplete="off" spellCheck={false} value={key} placeholder={st.key ? t("ai.keyPlaceholderSet") : pv.keyHint} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), saveKey())} />
            <button type="button" disabled={!key.trim()} onClick={saveKey}>{t("common.save")}</button>
            <button type="button" disabled={!st.key} onClick={() => run(() => api.aiKeyDelete())}>{t("common.delete")}</button>
          </span>
        </SettingsRow>
        <SettingsRow name={t("ai.model")}>
          <input aria-label={t("ai.modelLabel")} spellCheck={false} autoComplete="off" value={model} onChange={(e) => setModel(e.target.value)} onBlur={saveModel} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), saveModel())} />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t("ai.consent", { v: t(st.consent ? "ai.consentYes" : "ai.consentNo") })}>
        <SettingsRow name={`${t("ai.repoOff")}${hasRepo ? "" : t("ai.needRepo")}`} desc={t("ai.repoOffHelp")}>
          <input type="checkbox" checked={off} disabled={!hasRepo} onChange={(e) => setRepoOff(e.target.checked)} />
        </SettingsRow>
        <SettingsRow name={t("ai.conv")}>
          <input type="checkbox" checked={st.conventions} onChange={(e) => run(() => api.aiSettingsSet({ conventions: e.target.checked }))} />
        </SettingsRow>
        <SettingsRow name={`${t("ai.convRepoOff")}${hasRepo ? "" : t("ai.needRepo")}`} desc={t("ai.convHelp")}>
          <input type="checkbox" checked={convOff} disabled={!hasRepo} onChange={(e) => setRepoConvOff(e.target.checked)} />
        </SettingsRow>
        <SettingsRow>
          <button type="button" disabled={!st.consent} onClick={() => run(() => api.aiSettingsSet({ consent: false }))}>{t("ai.consentReset")}</button>
        </SettingsRow>
      </SettingsGroup>
      {err && <p className="warn selectable" role="alert">{err}</p>}
    </form>
  );
}
