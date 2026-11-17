// jj 30f 시트 3종: 작업 기록(operation log)·북마크·jj 끄기. 열기는 `ops.jjOpLog/jjBookmarks/jjDisable`(= ctx.showJj*)이고 상태는 이 파일 안에만 둔다(App은 안 그려진다).
// 규칙(docs/reuse.md "jj 보기" 30f): ① 시트를 열 때 저장소를 잡아 두고 api는 그 저장소로만 부른다 ② 저장소가 바뀌면 working이 아닌 시트는 닫는다
// ③ 재조회·check 응답에는 요청 번호(seq)를 붙여 늦게 온 응답을 버린다 ④ 불신 문자열은 `visibleText` + `<bdi>`.
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Sheet, SheetActions, SheetBody, SheetHead } from "../../shared/ui/Sheet";
import { api } from "../../shared/api/api";
import { ask, errCode, CodedError } from "../../shared/api/bridge";
import { dateFmt, t, tErr, useLocale } from "../../shared/i18n/i18n";
import { ctx, ops } from "../../shared/model/ops";
import { isRepoBusy } from "../../shared/lib/toast";
import { jjEnabled, jjOn, setJjView } from "../../shared/lib/jjview";
import { visibleText } from "../../shared/lib/safeText";
import { relTime } from "../../shared/lib/reltime";
import { countRender } from "../../shared/lib/profile";
import { contextMenu } from "../../shared/ui/menu";
import type { JjBookmark, JjDisableCheck, JjOpEntry, JjWarning } from "../../shared/api/types";

type View = { kind: "ops" | "bm" | "disable"; repo: string };
const NOOP = () => {};
const repoLabel = (repo: string) => repo.split(/[\\/]/).pop() ?? repo;
/** 같은 내용이면 이전 객체를 재사용해 memo 행이 다시 그려지지 않게 한다 */
const keep = <T,>(prev: T[], next: T[], key: (x: T) => string): T[] => {
  const m = new Map(prev.map((x) => [key(x), x]));
  return next.map((x) => {
    const p = m.get(key(x));
    return p && JSON.stringify(p) === JSON.stringify(x) ? p : x;
  });
};

/** 200ms가 넘게 걸릴 때만 "불러오는 중"을 보이는 플래그 (짧은 작업엔 깜빡임 없음) */
const useSlow = () => {
  const [slow, set] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [slow, () => (clearTimeout(timer.current), (timer.current = setTimeout(() => set(true), 200)), () => (clearTimeout(timer.current), set(false)))] as const;
};

export const JjHost = memo(function JjHost({ repo }: { repo: string }) {
  const [view, setView] = useState<View | null>(null);
  useEffect(() => {
    ctx.showJjOps = () => setView({ kind: "ops", repo: ctx.repo });
    ctx.showJjBookmarks = () => setView({ kind: "bm", repo: ctx.repo });
    ctx.showJjDisable = () => setView({ kind: "disable", repo: ctx.repo });
  }, []);
  const close = useCallback(() => setView(null), []);
  if (!view) return null;
  const p = { repo: view.repo, cur: repo, onClose: close };
  return view.kind === "ops" ? <JjOpLog {...p} /> : view.kind === "bm" ? <JjBookmarks {...p} /> : <JjDisable {...p} />;
});

interface SheetProps { repo: string; cur: string; onClose: () => void }

// ---------------------------------------------------------------- 작업 기록
const OpRow = memo(function OpRow({ e, current, onRestore }: { e: JjOpEntry; current: boolean; onRestore: (e: JjOpEntry) => void }) {
  countRender("JjOpRow");
  useLocale();
  const menu = () => [{ label: t("jjOps.restore"), disabled: current, action: () => onRestore(e) }];
  return (
    <li role="option" aria-selected={false} className="jj-op" onContextMenu={contextMenu(menu)}>
      <span className="jj-op-main">
        <span className="h-subject" title={visibleText(e.description)}>
          <bdi>{visibleText(e.description)}</bdi>
          {current && <span className="jj-cur">{t("jjOps.current")}</span>}
        </span>
        <span className="h-meta muted" title={dateFmt({ dateStyle: "short", timeStyle: "short" }).format(e.time)}>
          {relTime(e.time / 1000)} · <bdi>{visibleText(e.user ?? "—")}</bdi> · <code>{e.short}</code>
        </span>
      </span>
      <button type="button" disabled={current} title={current ? t("jjOps.alreadyHere") : undefined} onClick={() => onRestore(e)}>{t("jjOps.restore")}</button>
    </li>
  );
});

function JjOpLog({ repo, cur, onClose }: SheetProps) {
  countRender("JjOpLog");
  useLocale();
  const [list, setList] = useState<JjOpEntry[]>([]);
  const [more, setMore] = useState(false);
  const limit = useRef(50);
  const seq = useRef(0); // 재조회와 "더 보기"가 같은 카운터를 쓴다: 마지막 요청의 응답만 반영
  const restoring = useRef(false);
  const [slow, startSlow] = useSlow();
  const close = useCallback(() => (seq.current++, onClose()), [onClose]);
  const load = useCallback(
    async (lim: number) => {
      const s = ++seq.current;
      const stop = startSlow();
      try {
        const l = await api.jjOpLog(repo, lim);
        if (s !== seq.current) return;
        setList((prev) => keep(prev, l, (x) => x.id));
        limit.current = lim;
        setMore(l.length >= lim && lim < 1000);
      } catch (e) {
        if (s !== seq.current) return;
        ctx.error(e);
        if (errCode(e) === "jj.notEnabled") onClose();
      } finally {
        if (s === seq.current) stop();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repo, onClose],
  );
  useEffect(() => void load(50), [load]);
  useEffect(() => () => void seq.current++, []);
  useEffect(() => {
    if (cur !== repo && !restoring.current) close();
  }, [cur, repo, close]);
  const restore = useCallback(
    async (e: JjOpEntry) => {
      restoring.current = true;
      try {
        await ops.jjOpRestore(e);
      } finally {
        restoring.current = false;
      }
      if (repo !== ctx.repo) return onClose(); // 복원 중 다른 저장소로 옮겼다: 시트는 닫는다(결과는 잡아 둔 저장소에만 적용됨)
      void load(limit.current);
    },
    [repo, load, onClose],
  );
  return (
    <Sheet label={t("jjOps.title")} size="wide" closeOnBackdrop onClose={close}>
      <SheetHead title={t("jjOps.title")} />
      <SheetBody>
        <ul className="files jj-list" role="listbox" aria-label={t("jjOps.title")}>
          {list.map((e, i) => <OpRow key={e.id} e={e} current={i === 0} onRestore={restore} />)}
        </ul>
        {slow && <p className="muted jj-note">{t("common.loading")}</p>}
        {more && <button type="button" className="jj-more" onClick={() => void load(limit.current === 50 ? 200 : 1000)}>{t("jjOps.more")}</button>}
      </SheetBody>
      <SheetActions cancel={t("common.close")} />
    </Sheet>
  );
}

// ---------------------------------------------------------------- 북마크
const BmRow = memo(function BmRow({ b, onDelete, onTrack, onSelect }: { b: JjBookmark; onDelete: (n: string) => void; onTrack: (n: string, r: string) => void; onSelect: (sha: string) => void }) {
  useLocale();
  const conflict = b.targets.length > 1;
  const shas = conflict ? b.targets : b.target ? [b.target] : [];
  const menu = () => [
    ...(b.local ? [{ label: t("jjBm.delete"), action: () => onDelete(b.name) }] : []),
    ...b.remotes.filter((r) => !r.tracked).map((r) => ({ label: t("jjBm.trackRemote", { remote: visibleText(r.remote) }), action: () => onTrack(b.name, r.remote) })),
  ];
  return (
    <li role="option" aria-selected={false} className={"jj-bm" + (b.local ? "" : " off")} onContextMenu={contextMenu(menu)}>
      <span className="jj-bm-main">
        <span className="h-subject">
          <bdi>{visibleText(b.name)}</bdi>
          {conflict && <span className="jj-conflict">{t("jjBm.conflict")}</span>}
          {!b.local && <span className="jj-cur">{t("jjBm.remoteOnly")}</span>}
        </span>
        <span className="h-meta muted">
          {!shas.length && <span className="jj-sha">—</span>}
          {shas.map((s) => <button key={s} type="button" className="jj-sha" onClick={() => onSelect(s)}>{s.slice(0, 7)}</button>)}
          {b.remotes.map((r) => (
            <span key={r.remote} className="jj-chip" title={r.sha?.slice(0, 7)}>
              <bdi>{visibleText(r.remote)}</bdi>{r.tracked ? " ✓" : ""}
              {!r.tracked && <button type="button" onClick={() => onTrack(b.name, r.remote)}>{t("jjBm.track")}</button>}
            </span>
          ))}
        </span>
        {conflict && <span className="h-meta muted">{t("jjBm.conflictHint")}</span>}
      </span>
      {b.local && <button type="button" onClick={() => onDelete(b.name)}>{t("jjBm.delete")}</button>}
    </li>
  );
});

function JjBookmarks({ repo, cur, onClose }: SheetProps) {
  countRender("JjBookmarks");
  useLocale();
  const [list, setList] = useState<JjBookmark[] | null>(null);
  const seq = useRef(0);
  const [slow, startSlow] = useSlow();
  const close = useCallback(() => (seq.current++, onClose()), [onClose]);
  const load = useCallback(async () => {
    const s = ++seq.current;
    const stop = startSlow();
    try {
      const l = await api.jjBookmarks(repo);
      if (s === seq.current) setList((prev) => keep(prev ?? [], l, (x) => x.name));
    } catch (e) {
      if (s !== seq.current) return;
      ctx.error(e);
      if (errCode(e) === "jj.notEnabled") onClose();
    } finally {
      if (s === seq.current) stop();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, onClose]);
  useEffect(() => void load(), [load]);
  useEffect(() => () => void seq.current++, []);
  useEffect(() => {
    if (cur !== repo) close();
  }, [cur, repo, close]);
  const after = useCallback(async (p: Promise<boolean>) => ((await p), repo === ctx.repo && void load()), [repo, load]);
  const del = useCallback((n: string) => after(ops.jjBookmarkDelete(n)), [after]);
  const track = useCallback((n: string, r: string) => after(ops.jjBookmarkTrack(n, r)), [after]);
  const select = useCallback((sha: string) => (ctx.select(sha), close()), [close]);
  return (
    <Sheet label={t("jjBm.title")} size="wide" closeOnBackdrop onClose={close}>
      <SheetHead title={t("jjBm.title")} />
      <SheetBody>
        <p className="muted jj-note">{t("jjBm.intro")}</p>
        <ul className="files jj-list" role="listbox" aria-label={t("jjBm.title")}>
          {list?.map((b) => <BmRow key={b.name} b={b} onDelete={del} onTrack={track} onSelect={select} />)}
        </ul>
        {slow && !list && <p className="muted jj-note">{t("common.loading")}</p>}
        {list?.length === 0 && <p className="muted">{t("jjBm.empty")}</p>}
      </SheetBody>
      <SheetActions cancel={t("common.close")} />
    </Sheet>
  );
}

// ---------------------------------------------------------------- jj 끄기
type Phase = "choose" | "checking" | "confirm" | "asking" | "working" | "done";
const ORPHAN_MAX = 200;
const firstLine = (s: string) => s.split("\n")[0].trim();

function JjDisable({ repo, cur, onClose }: SheetProps) {
  countRender("JjDisable");
  useLocale();
  const [phase, setPhase] = useState<Phase>("choose");
  const phaseRef = useRef<Phase>("choose");
  const go = (p: Phase) => ((phaseRef.current = p), setPhase(p));
  const [check, setCheck] = useState<JjDisableCheck | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [warns, setWarns] = useState<JjWarning[]>([]);
  const seq = useRef(0);
  const alive = useRef(true);
  const here = () => repo === ctx.repo;
  const busy = phase === "asking" || phase === "working";
  const close = () => (seq.current++, onClose());
  useEffect(() => {
    alive.current = true; // StrictMode가 효과를 두 번 돌려도 마지막 마운트 기준
    return () => {
      alive.current = false; // asking 중 언마운트(저장소 전환·닫기): 확인창 응답이 와도 호출하지 않는다
      seq.current++;
    };
  }, []);
  useEffect(() => {
    if (cur !== repo && phaseRef.current !== "working") (seq.current++, onClose());
  }, [cur, repo, onClose]);
  const pre = () => (here() ? "" : `${repoLabel(repo)}: `);

  /** jj가 꺼진 뒤 정리: 저장된 git 보기 설정을 지우고(다시 켜면 기본 jj 보기) 상태를 다시 읽고 그래프를 다시 그린다 */
  const gone = async () => {
    setJjView(repo, "jj");
    await ops.jjLoad(repo);
    if (here()) await ctx.reload();
  };
  const startCheck = async () => {
    const s = ++seq.current;
    setErr(null);
    setNote(null);
    go("checking");
    try {
      const c = await api.jjDisableCheck(repo);
      if (s !== seq.current) return;
      setCheck(c);
      go("confirm");
    } catch (e) {
      if (s !== seq.current) return;
      const code = errCode(e);
      if (code === "jj.notEnabled" || code === "jj.notRepo") {
        ctx.error(e);
        await gone();
        return onClose();
      }
      setErr(String(e)); // 판단 불가(jj.disableUnknown 등): 삭제 진행 안 함
      go("choose");
    }
  };
  /** disableChanged·otherWorkspaces: 이전 opId로 다시 시도하지 않고 check를 다시 불러 확인창을 다시 보인다 */
  const recheck = async () => {
    if (!here()) return onClose();
    const s = ++seq.current;
    try {
      const c = await api.jjDisableCheck(repo);
      if (s !== seq.current) return;
      setCheck(c);
      setNote(t("jjDis.changedNote"));
      go("confirm");
    } catch (e) {
      if (s !== seq.current) return;
      ctx.error(e);
      go("choose");
    }
  };
  const fail = async (e: unknown) => {
    const code = errCode(e);
    if (code === "jj.disableChanged" || code === "jj.otherWorkspaces") return recheck();
    ctx.error(isRepoBusy(e) ? e : pre() + String(e));
    if (code === "jj.disablePartial") {
      await ops.jjLoad(repo);
      if (jjEnabled(repo)) {
        if (!here()) return onClose();
        void ctx.reload();
        setNote(t("ops.jj.disableRetry"));
        return go("choose");
      }
      await gone(); // 이미 꺼짐: 남은 찌꺼기는 무해하다고 알리고 닫는다
      const detail = e instanceof CodedError ? visibleText(e.vars.detail ?? "") : "";
      ctx.notify(pre() + t("ops.jj.disablePartialGone"), { kind: "info", ...(detail ? { detail } : {}) });
      return onClose();
    }
    if (code === "jj.notEnabled" || code === "jj.notRepo") {
      await gone();
      return onClose();
    }
    if (!here()) return onClose();
    go("choose");
  };
  const run = async () => {
    if (phaseRef.current !== "confirm" || !check || check.otherWorkspaces > 0) return;
    const opId = check.opId; // 가장 최근 check의 값만 쓴다
    go("asking");
    const ok = await ask(t("ops.jj.disableAskFinal", { count: check.orphans.length }), { title: t("ops.jj.disableAskTitle"), kind: "warning" });
    if (!alive.current || (phaseRef.current as Phase) !== "asking" || !here()) return; // 확인창이 떠 있는 사이 저장소를 옮겼다: 호출하지 않는다
    if (!ok) return go("confirm");
    go("working");
    try {
      const ws = await api.jjDisable(repo, opId);
      ctx.notify(pre() + t("ops.jj.disabled"), { kind: "success" });
      for (const w of ws) ctx.notify(pre() + t("ops.jj.disabledWarn"), { kind: "warning", detail: tErr(w.code, w.vars, w.message) });
      await gone();
      if (ws.length && here()) (setWarns(ws), go("done"));
      else onClose();
    } catch (e) {
      await fail(e);
    }
  };
  const viewOnly = () => {
    setJjView(repo, "git");
    void ctx.reload();
    close();
  };
  const alreadyGit = !jjOn(repo); // 이미 git 보기(또는 꺼짐)
  const otherWs = (check?.otherWorkspaces ?? 0) > 0;
  const kept = check?.orphans.length ?? 0;
  return (
    <Sheet label={t("jjDis.title")} size="wide" onClose={busy ? NOOP : close} onEscape={busy ? NOOP : close}>
      <SheetHead title={t("jjDis.title")} onClose={busy ? NOOP : close} />
      <SheetBody>
        {(phase === "choose" || phase === "checking") && (
          <>
            <p>{t("jjDis.intro")}</p>
            <p className="muted">{alreadyGit ? t("jjDis.alreadyGit") : t("jjDis.viewOnlyDesc")}</p>
            <p className="muted">{t("jjDis.deleteDesc")}</p>
            {note && <p className="jj-note" role="status">{note}</p>}
            {err && <p className="jj-err" role="alert">{err}</p>}
          </>
        )}
        {(phase === "confirm" || phase === "asking" || phase === "working") && check && (
          <>
            <p className="jj-warn">{t("jjDis.warn")}</p>
            <p>{kept ? t("jjDis.kept", { count: kept }) : t("jjDis.keptNone")}</p>
            {check.workingCopyDescribed && <p className="muted">{t("jjDis.wcDescribed")}</p>}
            {check.workingCopyMerge && <p className="muted">{t("jjDis.wcMerge")}</p>}
            {kept > 0 && (
              <ul className="files jj-list jj-orphans" aria-label={t("jjDis.orphans")}>
                {check.orphans.slice(0, ORPHAN_MAX).map((o) => (
                  <li key={o.sha}>
                    <code><bdi>{visibleText(o.changeId.slice(0, 12))}</bdi></code>
                    <span className="h-subject"><bdi>{visibleText(firstLine(o.description) || t("jjDis.noDesc"))}</bdi></span>
                    <code className="muted">{o.sha.slice(0, 7)}</code>
                  </li>
                ))}
                {kept > ORPHAN_MAX && <li className="muted">{t("jjDis.orphansMore", { n: kept - ORPHAN_MAX })}</li>}
              </ul>
            )}
            {otherWs && <p className="jj-err" role="alert">{tErr("jj.otherWorkspaces", { count: check.otherWorkspaces }, "")} {t("jjDis.otherWsHelp")}</p>}
            {note && <p className="jj-note" role="status">{note}</p>}
          </>
        )}
        {phase === "done" && (
          <>
            <p>{t("ops.jj.disabled")}</p>
            {warns.map((w, i) => <p key={i} className="selectable jj-note">{tErr(w.code, w.vars, w.message)}</p>)}
          </>
        )}
      </SheetBody>
      {(phase === "choose" || phase === "checking") && (
        <div className="sheet-actions">
          <button type="button" onClick={close}>{t("common.cancel")}</button>
          <button type="button" className="stop" disabled={phase === "checking"} onClick={() => void startCheck()}>{t("jjDis.deleteBtn")}</button>
          <button type="button" className="primary" disabled={alreadyGit || phase === "checking"} onClick={viewOnly}>{t("jjDis.viewOnlyBtn")}</button>
        </div>
      )}
      {(phase === "confirm" || phase === "asking" || phase === "working") && (
        <SheetActions
          cancel={t("common.cancel")}
          onCancel={busy ? NOOP : close}
          aside={<button type="button" disabled={busy} onClick={() => (seq.current++, go("choose"))}>{t("jjDis.back")}</button>}
          primary={t("jjDis.delete")}
          onPrimary={() => void run()}
          danger
          disabled={phase !== "confirm" || otherWs}
          reason={otherWs ? t("jjDis.otherWsHelp") : undefined}
        />
      )}
      {phase === "done" && <SheetActions cancel={t("common.close")} />}
    </Sheet>
  );
}
