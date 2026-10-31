import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../../shared/api/api";
import type { Status, StatusFile } from "../../shared/api/types";
import { DiffView } from "../../entities/diff/DiffView";
import { t, useLocale } from "../../shared/i18n/i18n";
import { supports, useCaps } from "../../shared/lib/caps";
import { onPrefs, pref } from "../../shared/lib/settings";
import { countRender } from "../../shared/lib/profile";
import { ctx, ops } from "../../shared/model/ops";
import { neighbors } from "../../shared/ui/FileNav";
import { Icon } from "../../shared/ui/Icon";
import { contextMenu } from "../../shared/ui/menu";
import { isStaged, isUnstaged, statusChar, type Side } from "../changes/ChangesView";

const NONE: StatusFile[] = [];
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

interface Props {
  repo: string;
  status: Status | null;
  /** 보고 있는 파일: 있으면 diff 화면, 없으면 변경 목록 */
  file: { path: string; side?: Side } | null;
  /** 왼쪽 위 ← 를 둔다(폰은 항상, 태블릿은 diff일 때만) */
  back: boolean;
  onBack: () => void;
  onFile: (path: string, side: Side) => void;
  /** 커밋이 만들어졌다 */
  onDone: () => void;
}

/**
 * 모바일 변경 화면(작업 중 행): 스테이지 안 됨 / 스테이지됨 목록 + 파일 diff + 아래 커밋 상자.
 * 데스크탑 `ChangesView`와 같은 IPC(`worktreeDiff`·`stage`·`unstage`·`commit`)와 분류 규칙(`isUnstaged`·`isStaged`)을 쓴다.
 * 미지원(되돌리기·hunk 스테이지·외부 도구)은 만들지 않거나 op 태그로 숨긴다. status·선택 파일이 바뀔 때만 다시 그린다(메시지 입력은 CommitBox 안).
 */
export const ChangesPane = memo(function ChangesPane({ repo, status, file, back, onBack, onFile, onDone }: Props) {
  useLocale();
  useCaps();
  countRender("MobileChanges");
  const [diff, setDiff] = useState("");
  const ignoreEol = useSyncExternalStore(onPrefs, () => pref("ignoreEol"));
  const ignoreWs = useSyncExternalStore(onPrefs, () => pref("ignoreWs"));
  const unstaged = useMemo(() => status?.files.filter(isUnstaged) ?? NONE, [status]);
  const staged = useMemo(() => status?.files.filter(isStaged) ?? NONE, [status]);
  const side: Side = file?.side ?? "unstaged";
  const selFile = file ? (side === "staged" ? staged : unstaged).find((f) => f.path === file.path) ?? null : null;
  const nav = useMemo(() => neighbors((side === "staged" ? staged : unstaged).map((f) => f.path), selFile?.path ?? null), [side, selFile?.path, staged, unstaged]);
  const image = useMemo(() => (selFile?.conflict ? undefined : { repo, before: side === "staged" ? "HEAD" : ":", after: side === "staged" ? ":" : null, v: diff }), [repo, side, selFile?.conflict, diff]);

  // diff는 파일(경로·쪽)이 바뀔 때만 비운다. 다시 읽는 기준은 그 파일의 상태 글자뿐이라 다른 파일의 status 갱신에는 깜빡이지 않는다
  useEffect(() => setDiff(""), [side, selFile?.path]);
  const fp = selFile ? `${selFile.index}${selFile.worktree}${selFile.untracked}` : "";
  useEffect(() => {
    if (!selFile) return;
    let live = true;
    api.worktreeDiff(repo, selFile.path, side === "staged", selFile.untracked).then((d) => live && setDiff(d), (e) => ctx.error(String(e)));
    return () => void (live = false);
  }, [repo, side, selFile?.path, selFile?.untracked, fp, ignoreEol, ignoreWs]);
  // 보던 파일이 목록에서 사라지면(스테이지됨·되돌려짐) 목록으로 — status가 또 갱신돼도 한 번만(두 번이면 폰은 커밋 목록·저장소까지 닫힌다)
  const left = useRef(false);
  useEffect(() => {
    if (!file || selFile) return void (left.current = false);
    if (status && !left.current) ((left.current = true), onBack());
  }, [file, status, selFile]);
  // 메시지는 diff를 보고 와도 남는다(CommitBox는 diff 화면에서 언마운트). 입력마다 다시 그리지 않게 ref
  const msg = useRef("");
  // stage·unstage는 한 번에 하나(연타해도 동시에 실행하지 않는다)
  const working = useRef(false);
  const [busy, setBusy] = useState(false);

  if (file && selFile)
    return (
      <section className="m-pane" aria-label={t("graph.localChanges")}>
        <header className="m-bar">
          <button className="m-ico" aria-label={t("m.back")} onClick={onBack}><Icon name="chevronLeft" size={22} /></button>
          <span className="m-bar-title" title={selFile.path}>{baseName(selFile.path)}</span>
          <button className="m-ico" aria-label={t("diff.prevFile")} disabled={nav.prev === undefined} onClick={() => onFile(nav.prev!, side)}><Icon name="chevronLeft" size={20} /></button>
          <button className="m-ico" aria-label={t("diff.nextFile")} disabled={nav.next === undefined} onClick={() => onFile(nav.next!, side)}><Icon name="chevronRight" size={20} /></button>
        </header>
        <div className="m-diff"><DiffView diff={diff} rev={null} image={image} bigCtl={null} /></div>
      </section>
    );

  const group = (s: Side, files: StatusFile[]) => {
    const can = supports(s === "staged" ? "unstage" : "stage");
    const label = s === "staged" ? t("changes.unstage") : t("changes.stage");
    const toggle = async (paths: string[]) => {
      if (working.current) return;
      working.current = true;
      setBusy(true);
      try {
        await (s === "staged" ? api.unstage(repo, paths) : api.stage(repo, paths));
      } catch (e) {
        ctx.error(String(e));
      } finally {
        working.current = false;
        setBusy(false);
      }
    };
    return (
      <section className="m-group" aria-label={s === "staged" ? t("changes.staged") : t("changes.unstaged")}>
        <div className="m-group-head">
          <h3 className="m-files-head">{s === "staged" ? t("changes.staged") : t("changes.unstaged")} {files.length}</h3>
          {can && files.length > 0 && (
            <button className={s === "staged" ? undefined : "go"} disabled={busy} onClick={() => toggle(files.map((f) => f.path))}>{s === "staged" ? t("changes.unstageAll") : t("changes.stageAll")}</button>
          )}
        </div>
        <ul className="m-files" aria-label={s === "staged" ? t("changes.staged") : t("changes.unstaged")}>
          {files.map((f) => (
            <li key={f.path} className="m-frow">
              <button
                title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                onClick={() => onFile(f.path, s)}
                onContextMenu={contextMenu(() => [{ label, op: s === "staged" ? "unstage" : "stage", action: () => toggle([f.path]) }])}
              >
                <span className={`status s-${statusChar(f, s)}`}>{statusChar(f, s)}</span>
                <span className="m-fname">{baseName(f.path)}</span>
                <span className="m-fdir">{f.path.slice(0, Math.max(0, f.path.lastIndexOf("/")))}</span>
              </button>
              {can && <button className="m-ico m-fbtn" disabled={busy} aria-label={`${label} ${f.path}`} onClick={() => toggle([f.path])}>{s === "staged" ? "−" : "+"}</button>}
            </li>
          ))}
        </ul>
      </section>
    );
  };

  return (
    <section className="m-pane" aria-label={t("graph.localChanges")}>
      <header className="m-bar">
        {back && <button className="m-ico" aria-label={t("m.back")} onClick={onBack}><Icon name="chevronLeft" size={22} /></button>}
        <span className="m-bar-title">{t("graph.localChanges")}</span>
      </header>
      <div className="m-scroll">
        {group("unstaged", unstaged)}
        {group("staged", staged)}
      </div>
      <CommitBox repo={repo} msg={msg} canCommit={staged.length > 0} onDone={onDone} />
    </section>
  );
});

/** 아래 커밋 상자: 여러 줄 메시지 + 커밋. 입력 상태는 여기만 가진다. 작성자가 없으면 시도 전에 설정 안내 */
const CommitBox = memo(function CommitBox({ repo, msg: kept, canCommit, onDone }: { repo: string; msg: { current: string }; canCommit: boolean; onDone: () => void }) {
  useLocale();
  countRender("MobileCommitBox");
  const [msg, setMsg] = useState(kept.current);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false); // state는 같은 프레임의 두 번째 탭을 못 막는다
  const [noAuthor, setNoAuthor] = useState(false);
  const reason = !canCommit ? t("m.needStaged") : !msg.trim() ? t("m.needMsg") : "";

  const submit = async () => {
    if (reason || sending.current) return;
    sending.current = true;
    setBusy(true);
    try {
      const a = await ops.authorRead();
      if (!a.name.trim() || !a.email.trim()) return setNoAuthor(true);
      setNoAuthor(false);
      await api.commit(repo, msg.trim(), false);
      ctx.notify(t("changes.committed"), { kind: "success", detail: msg.trim().split("\n")[0] });
      setMsg("");
      kept.current = "";
      onDone();
    } catch (e) {
      ctx.error(String(e));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  const edit = (v: string) => (kept.current = v, setMsg(v));
  // 안내가 떠 있는 동안, 설정에서 작성자를 저장하고 돌아오면(입력란을 누르거나 앱으로 돌아오면) 다시 확인해 지운다
  const recheck = () => void (noAuthor && ops.authorRead().then((a) => a.name.trim() && a.email.trim() && setNoAuthor(false), () => {}));
  useEffect(() => {
    if (!noAuthor) return;
    addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => (removeEventListener("focus", recheck), document.removeEventListener("visibilitychange", recheck));
  }, [noAuthor]);

  return (
    <form className="m-commit" onSubmit={(e) => (e.preventDefault(), submit())}>
      {noAuthor && (
        <div className="m-notice" role="alert">
          <span>{t("m.noAuthor")}</span>
          <button type="button" onClick={() => ops.openSettings("git")}>{t("m.openSettings")}</button>
        </div>
      )}
      <textarea value={msg} onFocus={recheck} onChange={(e) => (edit(e.target.value), recheck())} placeholder={t("m.commitMsg")} aria-label={t("m.commitMsg")} rows={3} />
      <div className="m-commit-row">
        <span className="m-reason muted" role="status">{reason}</span>
        <button type="submit" className="primary" disabled={!!reason || busy}>{t("changes.commitBtn")}</button>
      </div>
    </form>
  );
});
