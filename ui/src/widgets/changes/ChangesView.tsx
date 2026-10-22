import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ask } from "../../shared/api/bridge";
import { t, useLocale } from "../../shared/i18n/i18n";
import { api } from "../../shared/api/api";
import { ctx, ops, type AiCall, useAiOn, useTouched } from "../../shared/model/ops";
import { contextMenu, showMenu, type MenuEntry } from "../../shared/ui/menu";
import { fileMenu, fileOpenMenu } from "../../features/inspect/fileMenu";
import { DiffView, type HunkAction } from "../../entities/diff/DiffView";
import { countRender } from "../../shared/lib/profile";
import { onPrefs, pref } from "../../shared/lib/settings";
import { useSplit } from "../../shared/ui/Splitter";
import { FileNav, neighbors, revealSelected } from "../../shared/ui/FileNav";
import { DiffFrame } from "../../shared/ui/DiffFrame";
import { inspect } from "../../features/inspect/Inspector";
import { bigView } from "../../shared/model/bigview";
import { GuidePanel, GuideTabs, useGuidePanelOpen, useGuideView, useStagedGuide } from "../../features/ai/GuidePanel";
import { AiSources } from "../../features/ai/AiSources";
import type { AiSource, Status, StatusFile } from "../../shared/api/types";

type Side = "unstaged" | "staged";
const statusChar = (f: StatusFile, side: Side) => (f.untracked ? "?" : f.conflict ? "!" : side === "staged" ? f.index : f.worktree);

/** DU·UD·DD처럼 한쪽이 삭제한 충돌 (mergetool은 이런 파일에서 대화형으로 물어본다) */
const isDeleteConflict = (f: StatusFile) => f.conflict && (f.index === "D" || f.worktree === "D");

/** 로컬 변경사항: 스테이지 안 됨 / 스테이지됨 목록 + diff + 커밋 (하단 패널). */
export const ChangesView = memo(function ChangesView({
  repo,
  status,
  onError,
}: {
  repo: string;
  status: Status;
  onError: (e: string) => void;
}) {
  countRender("ChangesView");
  const touched = useTouched();
  const loc = useLocale();
  const [infoW, infoSplit] = useSplit("changes", 440, 220, 900, "x");
  const [sel, setSel] = useState<{ side: Side; path: string } | null>(null);
  // 읽어 온 diff와 "어떤 무시 옵션으로 만든 diff인지": 옵션을 끈 직후 새 diff가 오기 전의 옛 diff로 hunk를 스테이지하지 못하게
  const [dstate, setD] = useState({ text: "", eol: false, ws: false });
  const diff = dstate.text;
  const stale = dstate.eol || dstate.ws;
  const ignoreEol = useSyncExternalStore(onPrefs, () => pref("ignoreEol"));
  const ignoreWs = useSyncExternalStore(onPrefs, () => pref("ignoreWs"));

  const unstaged = useMemo(() => status.files.filter((f) => f.untracked || f.conflict || f.worktree !== "."), [status]);
  const staged = useMemo(() => status.files.filter((f) => !f.untracked && !f.conflict && f.index !== "."), [status]);
  const selFile = (sel?.side === "staged" ? staged : unstaged).find((f) => f.path === sel?.path) ?? null;

  // 현재 보는 목록 안에서만 이동 (끝에서 다른 목록으로 넘어가지 않는다)
  const nav = useMemo(() => neighbors((sel?.side === "staged" ? staged : unstaged).map((f) => f.path), selFile?.path ?? null), [sel?.side, selFile?.path, staged, unstaged]);
  // 이미지 diff: 스테이지 안 됨 = 인덱스 ↔ 작업 트리, 스테이지됨 = HEAD ↔ 인덱스.
  // 다시 읽는 기준은 diff 텍스트(바이너리 diff의 `index 옛해시..새해시`가 내용 지문): status가 새로 읽혀도 내용이 같으면 재조회하지 않는다. 충돌 파일은 제외
  const image = useMemo(() => (selFile?.conflict ? undefined : { repo, before: sel?.side === "staged" ? "HEAD" : ":", after: sel?.side === "staged" ? ":" : null, v: diff }), [repo, sel?.side, selFile?.conflict, diff]);
  const goFile = useCallback((path: string) => setSel((s) => s && { side: s.side, path }), []);
  // AI 읽는 흐름 가이드(25d): 스테이지된 트리 sha가 대상 키. 가이드의 파일은 스테이지됨 목록에서 연다
  const goStaged = useCallback((path: string) => setSel({ side: "staged", path }), []);
  const aiOpen = useGuidePanelOpen();
  const guideKey = useStagedGuide(repo, touched, aiOpen, staged.length > 0);
  const gv = useGuideView(guideKey ?? null);
  const startGuide = useCallback(() => ops.aiGuideStaged(repo), [repo]);
  const infoRef = useRef<HTMLDivElement>(null);
  useEffect(() => void revealSelected(infoRef.current), [sel]);

  // 목록이 바뀌어 선택한 파일이 사라지면 첫 파일을 고른다.
  useEffect(() => {
    if (!selFile) {
      const f = unstaged[0] ?? staged[0];
      setSel(f ? { side: unstaged[0] ? "unstaged" : "staged", path: f.path } : null);
    }
  }, [selFile, unstaged, staged]);

  useEffect(() => {
    if (!selFile || !sel) return setD({ text: "", eol: false, ws: false });
    api.worktreeDiff(repo, selFile.path, sel.side === "staged", selFile.untracked).then((text) => setD({ text, eol: ignoreEol, ws: ignoreWs }), (e) => onError(String(e)));
  }, [repo, sel?.side, selFile?.path, selFile?.untracked, status, touched, ignoreEol, ignoreWs]);

  useEffect(() => bigView.setAvail(!!selFile), [!!selFile]);
  useEffect(() => () => bigView.setAvail(false), []);
  const run = useCallback((p: Promise<unknown>) => void p.catch((e) => onError(String(e))), [onError]);

  const discard = async (files: StatusFile[]) => {
    const names = files.length === 1 ? files[0].path : t("changes.nFiles", { n: files.length });
    if (!(await ask(t("changes.discardAsk", { names }), { title: t("changes.discardTitle"), kind: "warning" }))) return;
    run(api.discard(repo, files.filter((f) => !f.untracked).map((f) => f.path), files.filter((f) => f.untracked).map((f) => f.path)));
  };

  const diffRef = useRef(diff); // 버튼은 누를 때의 diff를 쓴다 (diff가 바뀔 때마다 버튼 목록을 새로 만들지 않게)
  diffRef.current = diff;
  const hunkActions: HunkAction[] | undefined = useMemo(() => {
    if (!selFile || selFile.untracked || ignoreEol || ignoreWs || stale) return undefined; // 줄 끝 CR·공백 무시 diff는 실제 파일과 달라 패치로 적용할 수 없다
    const partial = (target: "stage" | "unstage" | "discard") => (hunk: number, lines: number[] | null) =>
      run(api.applyPartial(repo, diffRef.current, hunk, lines, target));
    return sel?.side === "staged"
      ? [{ label: t("changes.unstage"), run: partial("unstage") }]
      : [
          { label: t("changes.stage"), run: partial("stage") },
          {
            label: t("changes.discardBtn"),
            danger: true,
            run: async (h, l) => {
              if (await ask(t("changes.discardSelAsk"), { title: t("changes.discardTitle"), kind: "warning" })) partial("discard")(h, l);
            },
          },
        ];
  }, [!selFile, selFile?.untracked, sel?.side, repo, ignoreEol, ignoreWs, stale, loc]);
  // Blame·히스토리는 추적 중인 파일만 (새 파일·충돌 파일은 숨김)
  const onInspect = useMemo(() => (!selFile || selFile.untracked || selFile.conflict ? undefined : (kind: "blame" | "history", path: string) => (kind === "blame" ? inspect.blame(path, null) : inspect.history(path))), [!selFile, selFile?.untracked, selFile?.conflict]);

  const list = (side: Side, files: StatusFile[]) => (
    <section className="change-list">
      <div className="files-head">
        <span>{side === "staged" ? t("changes.staged") : t("changes.unstaged")} {files.length}</span>
        {files.length > 0 && (
          <span className="head-actions">
            {side === "unstaged" && <button className="secondary" onClick={() => ops.snapshot()} title={t("changes.snapshotTip")}>{t("changes.snapshot")}</button>}
            <button className="secondary" onClick={() => ops.savePatchChanges(side === "staged" ? "staged" : "unstaged")}>{t("changes.savePatch")}</button>
            {side === "unstaged" && <button className="secondary" onClick={() => discard(files)}>{t("changes.discardAll")}</button>}
            {/* 좁을 때만 보인다: 위 보조 버튼들을 메뉴로 */}
            <button
              className="more"
              aria-label={t("changes.more")}
              onClick={() =>
                showMenu([
                  ...(side === "unstaged" ? [{ label: t("changes.snapshot"), action: () => ops.snapshot() }] : []),
                  { label: t("changes.savePatch"), action: () => ops.savePatchChanges(side === "staged" ? "staged" : "unstaged") },
                  ...(side === "unstaged" ? [{ label: t("changes.discardAll"), action: () => discard(files) }] : []),
                ])
              }
            >
              ⋯
            </button>
            <button onClick={() => run(side === "staged" ? api.unstage(repo, files.map((f) => f.path)) : api.stage(repo, files.map((f) => f.path)))}>
              {side === "staged" ? t("changes.unstageAll") : t("changes.stageAll")}
            </button>
          </span>
        )}
      </div>
      <ul className="files" role="listbox" aria-label={side === "staged" ? t("changes.staged") : t("changes.unstaged")}>
        {files.map((f) => {
          const active = sel?.side === side && sel.path === f.path;
          return (
            <li
              key={f.path}
              role="option"
              aria-selected={active}
              className={active ? "selected" : ""}
              title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
              onMouseDown={() => setSel({ side, path: f.path })}
              onDoubleClick={() => run(side === "staged" ? api.unstage(repo, [f.path]) : api.stage(repo, [f.path]))}
              onContextMenu={contextMenu(() => [
                { label: t("diff.big"), action: () => (setSel({ side, path: f.path }), bigView.enter(true)) },
                { separator: true },
                // 순서: 충돌 해결 → 스테이지·버리기·스태시·무시 → 히스토리·Blame → 외부 도구·열기 → 경로·패치 복사
                ...(f.conflict && !isDeleteConflict(f) ? [{ label: t("changes.mergeTool"), action: () => ops.mergeTool(f.path) }] : []),
                ...(f.conflict && !isDeleteConflict(f) && ops.aiOn() ? [{ label: t("changes.aiConflict"), action: () => ops.aiConflict(f.path) }] : []),
                ...(f.conflict ? [{ separator: true } as MenuEntry] : []),
                { label: side === "staged" ? t("changes.unstage") : t("changes.stage"), action: () => run(side === "staged" ? api.unstage(repo, [f.path]) : api.stage(repo, [f.path])) },
                ...(side === "unstaged" ? [{ label: t("changes.discardMenu"), action: () => discard([f]) }] : []),
                { label: t("changes.trashMenu"), action: () => ops.trashFiles([f.path]), disabled: f.path.endsWith("/") }, // 폴더는 못 옮긴다
                ...(side === "unstaged" ? [{ label: t("changes.stashFile"), action: () => ops.stashFiles([f.path]) }] : []),
                { label: t("changes.ignore"), action: () => ops.ignore(f.path), disabled: !f.untracked },
                { label: t("changes.lfs"), action: () => ops.lfsTrackFile(f.path) },
                { separator: true },
                ...(f.untracked ? fileOpenMenu(f.path, null) : fileMenu(f.path, null, side === "staged")),
                ...(f.untracked ? [] : [{ label: t("changes.savePatchFile"), action: () => ops.savePatchChanges(side, [f.path]) }]),
              ])}
            >
              <span className={`status s-${statusChar(f, side)}`}>{statusChar(f, side)}</span>
              <span className="label">{f.path}</span>
              <button className="row-btn" onMouseDown={(e) => e.stopPropagation()} onClick={() => run(side === "staged" ? api.unstage(repo, [f.path]) : api.stage(repo, [f.path]))}>
                {side === "staged" ? "−" : "+"}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );

  return (
    <DiffFrame
      split={infoSplit}
      side={
      <div ref={infoRef} className={"info changes" + (gv.open ? " guide-on" : "")} style={{ width: infoW }}>
        <GuideTabs />
        {gv.open ? (
          <GuidePanel gkey={guideKey ?? null} start={guideKey ? startGuide : null} go={goStaged} hint={guideKey === null ? t("guide.noStaged") : undefined} />
        ) : (
          <>
            {list("unstaged", unstaged)}
            {list("staged", staged)}
          </>
        )}
        <CommitBox repo={repo} canCommit={staged.length > 0} onError={onError} />
      </div>
      }
    >
      <div className="diff-pane">
        {selFile?.conflict && (
          <div className="conflict-bar" role="toolbar" aria-label={t("changes.resolve")}>
            <span>
              {isDeleteConflict(selFile)
                ? t("changes.deleteConflict")
                : t("changes.conflict")}
            </span>
            <button onClick={() => ops.resolveWith(selFile.path, "ours")}>{t("changes.useOurs")}</button>
            <button onClick={() => ops.resolveWith(selFile.path, "theirs")}>{t("changes.useTheirs")}</button>
            {!isDeleteConflict(selFile) && <button onClick={() => ops.mergeTool(selFile.path)}>{t("changes.externalMerge")}</button>}
            <button className="primary" onClick={() => ops.markResolved(selFile.path)}>{t("changes.markResolved")}</button>
          </div>
        )}
        {ignoreEol && selFile && !selFile.conflict && !selFile.untracked && <div className="conflict-bar" role="status">{t("changes.eolNote")}</div>}
        {ignoreWs && selFile && !selFile.conflict && !selFile.untracked && <div className="conflict-bar" role="status">{t("changes.wsNote")}</div>}
        {selFile ? <DiffView diff={diff} rev={null} image={image} actions={selFile.conflict ? undefined : hunkActions} notes={sel?.side === "staged" ? gv.notes : undefined} current={gv.current} reveal={gv.reveal} onInspect={onInspect} /> : <div className="diff empty-diff">{t("changes.noFiles")}</div>}
        <FileNav {...nav} go={goFile} />
      </div>
    </DiffFrame>
  );
});

const CommitBox = memo(function CommitBox({ repo, canCommit, onError }: { repo: string; canCommit: boolean; onError: (e: string) => void }) {
  useLocale();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const aiOn = useAiOn();
  const ai = useRef<AiCall<{ subject: string; body: string }> | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [sources, setSources] = useState<AiSource[]>([]); // 마지막 AI 결과가 따른 저장소 규칙
  useEffect(() => () => ai.current?.cancel(), []); // 화면을 떠나면 요청 취소

  /** 스테이지된 diff로 제목·본문 초안을 채운다 (사용자가 고친다). 작성 중에 다시 누르면 취소 */
  const aiWrite = async () => {
    if (ai.current) return ai.current.cancel();
    const call = (ai.current = ops.aiCommit());
    setAiBusy(true);
    setSources([]);
    try {
      const r = await call.result;
      if (r) {
        setSubject(r.subject.trim());
        setBody(r.body.trim());
        setSources(r.sources ?? []);
      }
    } catch (e) {
      onError(String(e));
    } finally {
      ai.current = null;
      setAiBusy(false);
    }
  };

  const toggleAmend = async (on: boolean) => {
    setAmend(on);
    if (on && !subject && !body) {
      const [s, ...rest] = (await api.lastMessage(repo)).split("\n");
      setSubject(s);
      setBody(rest.join("\n").trim());
    }
  };

  const ok = subject.trim() !== "" && (canCommit || amend) && !busy;
  const submit = async () => {
    if (!ok) return;
    setBusy(true);
    try {
      if (!(await ops.eolCommitCheck(repo))) return;
      await api.commit(repo, body.trim() ? `${subject.trim()}\n\n${body.trim()}` : subject.trim(), amend);
      ctx.notify(amend ? t("changes.amended") : t("changes.committed"), { kind: "success", detail: subject.trim() });
      setSubject("");
      setBody("");
      setSources([]);
      setAmend(false);
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="commit-box"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === "Enter" && submit()} /* ⌘⇧↩는 크게 보기 단축키 */
    >
      <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t("changes.subject")} aria-label={t("changes.subject")} />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder={t("changes.bodyPh")} aria-label={t("changes.bodyLabel")} rows={3} />
      <div className="commit-actions">
        <label>
          <input type="checkbox" checked={amend} onChange={(e) => toggleAmend(e.target.checked)} /> {t("changes.amend")}
        </label>
        <span className="commit-btns">
        {aiOn && (
          <button type="button" disabled={!canCommit && !aiBusy} title={canCommit ? t("changes.aiTip") : t("changes.aiNone")} onClick={aiWrite}>
            {aiBusy ? t("changes.aiBusy") : t("changes.aiWrite")}
          </button>
        )}
        <button type="submit" className="primary" disabled={!ok}>{amend ? t("changes.amendBtn") : t("changes.commitBtn")}</button>
        </span>
      </div>
      <AiSources sources={sources} />
    </form>
  );
});
