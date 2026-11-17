import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useJjOn } from "../../shared/lib/jjview";
import { fileWant, useFileWant } from "../../shared/model/selection";
import { ask } from "../../shared/api/bridge";
import { t, useLocale } from "../../shared/i18n/i18n";
import { api } from "../../shared/api/api";
import { ctx, ops, type AiCall, useAiOn, useTouched } from "../../shared/model/ops";
import { contextMenu, showMenu, type MenuEntry } from "../../shared/ui/menu";
import { fileMenu, fileOpenMenu } from "../../features/inspect/fileMenu";
import { DiffView, type HunkAction } from "../../entities/diff/DiffView";
import { supports, useCaps } from "../../shared/lib/caps";
import { countRender } from "../../shared/lib/profile";
import { onPrefs, pref } from "../../shared/lib/settings";
import { useSplit } from "../../shared/ui/Splitter";
import { FileNav, neighbors, revealSelected } from "../../shared/ui/FileNav";
import { DiffFrame } from "../../shared/ui/DiffFrame";
import { inspect } from "../../features/inspect/Inspector";
import { bigView } from "../../shared/model/bigview";
import { GuidePanel, GuideTabs, useGuidePanelOpen, useGuideView, useStagedGuide } from "../../features/ai/GuidePanel";
import { AiSources } from "../../entities/ai/AiSources";
import type { AiSource, Status, StatusFile } from "../../shared/api/types";

export type Side = "unstaged" | "staged";
export const statusChar = (f: StatusFile, side: Side) => (f.untracked ? "?" : f.conflict ? "!" : side === "staged" ? f.index : f.worktree);

/** 스테이지 안 됨 / 스테이지됨 목록에 드는 파일 (모바일 변경 화면도 같은 규칙) */
export const isUnstaged = (f: StatusFile) => f.untracked || f.conflict || f.worktree !== ".";
export const isStaged = (f: StatusFile) => !f.untracked && !f.conflict && f.index !== ".";

const NO_FILES: StatusFile[] = [];
const NO_PATHS: ReadonlySet<string> = new Set();
const NO_PATHS_ARR: string[] = [];

/** DU·UD·DD처럼 한쪽이 삭제한 충돌 (mergetool은 이런 파일에서 대화형으로 물어본다) */
const isDeleteConflict = (f: StatusFile) => f.conflict && (f.index === "D" || f.worktree === "D");

/** 변경 파일 한 행. 고른 파일·체크가 바뀔 때 바뀐 행만 다시 그린다 (active·checked 불리언과 안정적 콜백만 받는다). */
const ChangeItem = memo(function ChangeItem({ f, side, jj, active, checked, repo, onSel, run, discard, togglePick }: {
  f: StatusFile; side: Side; jj: boolean; active: boolean; checked: boolean; repo: string;
  onSel: (side: Side, path: string, big?: boolean) => void; run: (p: Promise<unknown>) => void; discard: (files: StatusFile[]) => void; togglePick: (path: string) => void;
}) {
  countRender("ChangeItem");
  useLocale(); // 우클릭 메뉴·제목 문구가 언어를 따른다
  useCaps(); // 스테이지 버튼 지원 여부
  return (
    <li
      role="option"
      aria-selected={active}
      className={active ? "selected" : ""}
      title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
      onMouseDown={() => onSel(side, f.path)}
      onDoubleClick={jj ? undefined : () => run(side === "staged" ? api.unstage(repo, [f.path]) : api.stage(repo, [f.path]))}
      onContextMenu={contextMenu(() => [
        { label: t("diff.big"), action: () => onSel(side, f.path, true) },
        { separator: true },
        // 순서: 충돌 해결 → 스테이지·버리기·스태시·무시 → 히스토리·Blame → 외부 도구·열기 → 경로·패치 복사
        ...(f.conflict && !isDeleteConflict(f) ? [{ label: t("changes.mergeTool"), op: "mergetool", action: () => ops.mergeTool(f.path) }] : []),
        ...(f.conflict && !isDeleteConflict(f) && ops.aiOn() ? [{ label: t("changes.aiConflict"), action: () => ops.aiConflict(f.path) }] : []),
        ...(f.conflict ? [{ separator: true } as MenuEntry] : []),
        ...(jj ? [] : [{ label: side === "staged" ? t("changes.unstage") : t("changes.stage"), op: side === "staged" ? "unstage" : "stage", action: () => run(side === "staged" ? api.unstage(repo, [f.path]) : api.stage(repo, [f.path])) }]),
        ...(!jj && side === "unstaged" ? [{ label: t("changes.discardMenu"), op: "discard", action: () => discard([f]) }] : []),
        { label: t("changes.trashMenu"), op: "trash_files", action: () => ops.trashFiles([f.path]), disabled: f.path.endsWith("/") }, // 폴더는 못 옮긴다
        ...(!jj && side === "unstaged" ? [{ label: t("changes.stashFile"), op: "stash", action: () => ops.stashFiles([f.path]) }] : []),
        { label: t("changes.ignore"), action: () => ops.ignore(f.path), disabled: !f.untracked },
        { label: t("changes.lfs"), op: "lfs", action: () => ops.lfsTrackFile(f.path) },
        { separator: true },
        ...(f.untracked ? fileOpenMenu(f.path, null) : fileMenu(f.path, null, side === "staged")),
        ...(f.untracked ? [] : [{ label: t("changes.savePatchFile"), op: "diff", action: () => ops.savePatchChanges(side, [f.path]) }]),
      ])}
    >
      {jj && (
        <input
          type="checkbox"
          className="jj-pick"
          aria-label={t("changes.jjPick", { path: f.path })}
          checked={checked}
          onMouseDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onChange={() => togglePick(f.path)}
        />
      )}
      <span className={`status s-${statusChar(f, jj && !isUnstaged(f) ? "staged" : side)}`}>{statusChar(f, jj && !isUnstaged(f) ? "staged" : side)}</span>
      <span className="label">{f.path}</span>
      {!jj && supports(side === "staged" ? "unstage" : "stage") && (
        <button className="row-btn" onMouseDown={(e) => e.stopPropagation()} onClick={() => run(side === "staged" ? api.unstage(repo, [f.path]) : api.stage(repo, [f.path]))}>
          {side === "staged" ? "−" : "+"}
        </button>
      )}
    </li>
  );
});

/** 로컬 변경사항: 스테이지 안 됨 / 스테이지됨 목록 + diff + 커밋 (하단 패널). */
export const ChangesView = memo(function ChangesView({
  repo,
  status,
  onError,
}: {
  repo: string;
  status: Status;
  onError: (e: unknown) => void;
}) {
  countRender("ChangesView");
  const touched = useTouched();
  const loc = useLocale();
  useCaps();
  const [infoW, infoSplit] = useSplit("changes", 440, 220, 900, "x");
  // 파일 목록 ↔ 커밋 입력 경계: 입력 상자 높이(바닥에 붙고, 목록이 나머지를 채운다)
  const [boxH, boxSplit] = useSplit("commit-box", 190, 130, 600, "y", undefined, true);
  const [sel, setSel] = useState<{ side: Side; path: string } | null>(null);
  // 읽어 온 diff와 "어떤 무시 옵션으로 만든 diff인지": 옵션을 끈 직후 새 diff가 오기 전의 옛 diff로 hunk를 스테이지하지 못하게
  const [dstate, setD] = useState({ text: "", eol: false, ws: false });
  const diff = dstate.text;
  const stale = dstate.eol || dstate.ws;
  const ignoreEol = useSyncExternalStore(onPrefs, () => pref("ignoreEol"));
  const ignoreWs = useSyncExternalStore(onPrefs, () => pref("ignoreWs"));

  // jj 보기(30e): 스테이징이 없다. `@`의 변경 전부를 한 목록으로 (스테이지만 된 파일의 diff는 index 기준으로 읽는다)
  const jj = useJjOn(repo);
  const [picked, setPicked] = useState<ReadonlySet<string>>(NO_PATHS); // jj 보기에서 체크한 파일(합치기·나누기 대상)
  const unstaged = useMemo(() => (jj ? status.files : status.files.filter(isUnstaged)), [status, jj]);
  const staged = useMemo(() => (jj ? NO_FILES : status.files.filter(isStaged)), [status, jj]);
  const selFile = (sel?.side === "staged" ? staged : unstaged).find((f) => f.path === sel?.path) ?? null;

  // 현재 보는 목록 안에서만 이동 (끝에서 다른 목록으로 넘어가지 않는다)
  const nav = useMemo(() => neighbors((sel?.side === "staged" ? staged : unstaged).map((f) => f.path), selFile?.path ?? null), [sel?.side, selFile?.path, staged, unstaged]);
  // 이미지 diff: 스테이지 안 됨 = 인덱스 ↔ 작업 트리, 스테이지됨 = HEAD ↔ 인덱스.
  // 다시 읽는 기준은 diff 텍스트(바이너리 diff의 `index 옛해시..새해시`가 내용 지문): status가 새로 읽혀도 내용이 같으면 재조회하지 않는다. 충돌 파일은 제외
  const diffStaged = sel?.side === "staged" || (jj && !!selFile && !isUnstaged(selFile));
  const image = useMemo(() => (selFile?.conflict ? undefined : { repo, before: diffStaged ? "HEAD" : ":", after: diffStaged ? ":" : null, v: diff }), [repo, diffStaged, selFile?.conflict, diff]);
  const goFile = useCallback((path: string) => setSel((s) => s && { side: s.side, path }), []);
  // AI 읽는 흐름 가이드(25d): 스테이지된 트리 sha가 대상 키. 가이드의 파일은 스테이지됨 목록에서 연다
  const goStaged = useCallback((path: string) => setSel({ side: "staged", path }), []);
  const aiOpen = useGuidePanelOpen();
  const guideKey = useStagedGuide(repo, touched, aiOpen, staged.length > 0);
  const gv = useGuideView(guideKey ?? null);
  const startGuide = useCallback(() => ops.aiGuideStaged(repo), [repo]);
  const infoRef = useRef<HTMLDivElement>(null);
  useEffect(() => void revealSelected(infoRef.current), [sel]);
  // AI 채팅이 알려 준 파일 열기 (ops.aiChatOpenFile): 변경 목록에 있으면 고른다
  const fw = useFileWant();
  const fwDone = useRef(0);
  useEffect(() => {
    const w = fileWant.fresh(fw, fwDone.current);
    const f = w && status.files.find((x) => x.path === w.path);
    if (!w || !f) return;
    fwDone.current = w.n;
    setSel({ side: isUnstaged(f) ? "unstaged" : "staged", path: f.path });
    bigView.picked();
  }, [fw, status]);

  // 목록이 바뀌어 선택한 파일이 사라지면 첫 파일을 고른다. 남은 파일이 없으면(되돌려 변경이 없어짐) 크게 보기를 닫는다 — 덮을 diff가 없어 빈 화면이 된다.
  useEffect(() => {
    if (!selFile) {
      const f = unstaged[0] ?? staged[0];
      setSel(f ? { side: unstaged[0] ? "unstaged" : "staged", path: f.path } : null);
      if (!f) bigView.exit();
    }
  }, [selFile, unstaged, staged]);

  useEffect(() => {
    if (!selFile || !sel) return setD({ text: "", eol: false, ws: false });
    let live = true; // 파일을 바꾼 뒤 늦게 온 이전 응답이 덮어쓰지 않게
    api.worktreeDiff(repo, selFile.path, diffStaged, selFile.untracked).then((text) => live && setD({ text, eol: ignoreEol, ws: ignoreWs }), (e) => live && onError(e));
    return () => void (live = false);
  }, [repo, sel?.side, diffStaged, selFile?.path, selFile?.untracked, status, touched, ignoreEol, ignoreWs]);

  useEffect(() => bigView.setAvail(!!selFile), [!!selFile]);
  useEffect(() => () => bigView.setAvail(false), []);
  const run = useCallback((p: Promise<unknown>) => void p.catch((e) => onError(e)), [onError]);

  const discard = useCallback(async (files: StatusFile[]) => {
    const names = files.length === 1 ? files[0].path : t("changes.nFiles", { n: files.length });
    if (!(await ask(t("changes.discardAsk", { names }), { title: t("changes.discardTitle"), kind: "warning" }))) return;
    run(api.discard(repo, files.filter((f) => !f.untracked).map((f) => f.path), files.filter((f) => f.untracked).map((f) => f.path)));
  }, [repo, run]);
  const selectFile = useCallback((side: Side, path: string, big?: boolean) => (setSel({ side, path }), big ? bigView.enter(true) : bigView.picked()), []);

  const diffRef = useRef(diff); // 버튼은 누를 때의 diff를 쓴다 (diff가 바뀔 때마다 버튼 목록을 새로 만들지 않게)
  diffRef.current = diff;
  const hunkActions: HunkAction[] | undefined = useMemo(() => {
    if (jj || !selFile || selFile.untracked || ignoreEol || ignoreWs || stale) return undefined; // jj 보기는 스테이지·버리기 hunk 버튼이 없다. 줄 끝 CR·공백 무시 diff는 실제 파일과 달라 패치로 적용할 수 없다
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
  }, [jj, !selFile, selFile?.untracked, sel?.side, repo, ignoreEol, ignoreWs, stale, loc]);
  // Blame·히스토리는 추적 중인 파일만 (새 파일·충돌 파일은 숨김)
  const onInspect = useMemo(() => (!selFile || selFile.untracked || selFile.conflict ? undefined : (kind: "blame" | "history", path: string) => (kind === "blame" ? inspect.blame(path, null) : inspect.history(path))), [!selFile, selFile?.untracked, selFile?.conflict]);

  const togglePick = useCallback((path: string) => setPicked((p) => { const n = new Set(p); n.has(path) ? n.delete(path) : n.add(path); return n; }), []);
  // 합치기·나누기 대상: 지금 목록에 있는 체크 파일. 이름 바꾸기(R)만 옛 경로도 같이(복사 C는 제외), 폴더 `dir/`는 끝 `/`를 뗀다(백엔드는 디렉터리 접두를 받고 `/`는 badPath)
  const pickedPaths = useMemo(() => (jj ? unstaged.filter((f) => picked.has(f.path)).flatMap((f) => [f.path, ...(f.oldPath && (f.index === "R" || f.worktree === "R") ? [f.oldPath] : [])]).map((x) => x.replace(/\/+$/, "")) : NO_PATHS_ARR), [jj, unstaged, picked]);
  useEffect(() => setPicked(NO_PATHS), [jj, repo]); // 보기·저장소가 바뀌면 체크를 비운다 (선택 파일은 아래 효과가 첫 파일로 맞춘다)
  const clearPicked = useCallback(() => setPicked(NO_PATHS), []);

  const list = (side: Side, files: StatusFile[]) => (
    <section className="change-list">
      <div className="files-head">
        <span>{jj ? t("changes.jjHead") : side === "staged" ? t("changes.staged") : t("changes.unstaged")} {files.length}</span>
        {files.length > 0 && (
          <span className="head-actions">
            {!jj && side === "unstaged" && <button className="secondary" onClick={() => ops.snapshot()} title={t("changes.snapshotTip")}>{t("changes.snapshot")}</button>}
            <button className="secondary" onClick={() => ops.savePatchChanges(side === "staged" ? "staged" : "unstaged")}>{t("changes.savePatch")}</button>
            {!jj && side === "unstaged" && supports("discard") && <button className="secondary stop" onClick={() => discard(files)}>{t("changes.discardAll")}</button>}
            {/* 좁을 때만 보인다: 위 보조 버튼들을 메뉴로 */}
            <button
              className="more"
              aria-label={t("changes.more")}
              onClick={() =>
                showMenu([
                  ...(!jj && side === "unstaged" ? [{ label: t("changes.snapshot"), op: "stash", action: () => ops.snapshot() }] : []),
                  { label: t("changes.savePatch"), op: "diff", action: () => ops.savePatchChanges(side === "staged" ? "staged" : "unstaged") },
                  ...(!jj && side === "unstaged" ? [{ label: t("changes.discardAll"), op: "discard", action: () => discard(files) }] : []),
                ])
              }
            >
              ⋯
            </button>
            {!jj && supports(side === "staged" ? "unstage" : "stage") && <button className={side === "staged" ? undefined : "go"} onClick={() => run(side === "staged" ? api.unstage(repo, files.map((f) => f.path)) : api.stage(repo, files.map((f) => f.path)))}>
              {side === "staged" ? t("changes.unstageAll") : t("changes.stageAll")}
            </button>}
          </span>
        )}
      </div>
      <ul className="files" role="listbox" aria-label={jj ? t("changes.jjHead") : side === "staged" ? t("changes.staged") : t("changes.unstaged")}>
        {files.map((f) => (
          <ChangeItem key={f.path} f={f} side={side} jj={jj} active={sel?.side === side && sel.path === f.path} checked={picked.has(f.path)} repo={repo} onSel={selectFile} run={run} discard={discard} togglePick={togglePick} />
        ))}
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
            {!jj && list("staged", staged)}
          </>
        )}
        {boxSplit}
        {jj ? <JjBox paths={pickedPaths} height={boxH} onDone={clearPicked} /> : <CommitBox repo={repo} canCommit={staged.length > 0} onError={onError} height={boxH} />}
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

const CommitBox = memo(function CommitBox({ repo, canCommit, onError, height }: { repo: string; canCommit: boolean; onError: (e: unknown) => void; height: number }) {
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
      onError(e);
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
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="commit-box"
      style={{ height }}
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

/** jj 보기(30e)의 커밋 상자 자리: `@`에 설명 달기·새 변경, 체크한 파일을 부모로 합치기·별도 변경으로 나누기 (모두 ops.jj*) */
const JjBox = memo(function JjBox({ paths, height, onDone }: { paths: string[]; height: number; onDone: () => void }) {
  useLocale();
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<boolean>) => {
    setBusy(true);
    try {
      if (await f()) onDone();
    } finally {
      setBusy(false);
    }
  };
  const none = paths.length === 0 || busy;
  return (
    <div className="commit-box jj-box" style={{ height: Math.min(height, 130) }}>
      <p className="muted">{t("changes.jjHint")}</p>
      <div className="commit-actions">
        <span className="commit-btns">
          <button type="button" disabled={none} onClick={() => run(() => ops.jjSquash(undefined, paths))}>{t("changes.jjSquash")}</button>
          <button type="button" disabled={none} onClick={() => run(() => ops.jjSplit(paths))}>{t("changes.jjSplit")}</button>
        </span>
      </div>
      <div className="commit-actions">
        <span className="commit-btns">
          <button type="button" disabled={busy} onClick={() => run(() => ops.jjNewWorking())}>{t("changes.jjNew")}</button>
          <button type="button" className="primary" disabled={busy} onClick={() => run(() => ops.jjDescribe())}>{t("changes.jjDescribe")}</button>
        </span>
      </div>
    </div>
  );
});
