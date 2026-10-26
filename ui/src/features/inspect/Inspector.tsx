import { useCallback, useEffect, useMemo, useState } from "react";
import { Sha } from "../../shared/ui/Sha";
import { Sheet, SheetBody, SheetActions, SheetHead } from "../../shared/ui/Sheet";
import { api } from "../../shared/api/api";
import { DiffView } from "../../entities/diff/DiffView";
import { dateFmt as intlDate, t, useLocale } from "../../shared/i18n/i18n";
import { ctx, ops, store, stored } from "../../shared/model/ops";
import { BigButton, type BigCtl } from "../../shared/ui/BigButton";
import { useSplit } from "../../shared/ui/Splitter";
import { contextMenu } from "../../shared/ui/menu";
import { StatsPanel } from "../../entities/stats/StatsPanel";
import type { BlameLine, Commit, Lfs } from "../../shared/api/types";

type View = { kind: "history"; path: string } | { kind: "blame"; path: string; rev: string | null } | { kind: "file"; path: string; rev: string } | { kind: "lfs" } | { kind: "stats" };

let openView: ((v: View | null) => void) | null = null;
/** 파일 히스토리 · blame · 커밋 시점 파일 내용을 여는 창 (어디서든 호출). */
export const inspect = {
  history: (path: string) => openView?.({ kind: "history", path }),
  blame: (path: string, rev: string | null = null) => openView?.({ kind: "blame", path, rev }),
  file: (path: string, rev: string) => openView?.({ kind: "file", path, rev }),
  lfs: () => openView?.({ kind: "lfs" }),
  stats: () => openView?.({ kind: "stats" }),
};

ctx.showLfs = inspect.lfs;
ctx.showStats = inspect.stats;

const dateFmt = { format: (ms: number) => intlDate({ dateStyle: "short" }).format(ms) };

export function InspectorHost({ onSelectCommit }: { onSelectCommit: (id: string) => void }) {
  useLocale();
  const [view, setView] = useState<View | null>(null);
  useEffect(() => void (openView = setView), []);
  // 크게 보기(파일 히스토리·Blame·파일 보기 시트): 시트가 창 거의 전체로 커진다. 상태는 저장. 앱 전체 크게 보기(bigView)와 별개
  const [big, setBigState] = useState(() => stored("inspectBig", false));
  const setBig = useCallback((v: boolean) => (setBigState(v), store("inspectBig", v)), []);
  const ctl = useMemo<BigCtl>(() => ({ big, restore: true, toggle: () => setBig(!big) }), [big, setBig]);
  const canBig = view?.kind === "history" || view?.kind === "blame" || view?.kind === "file";
  useEffect(() => {
    if (!canBig) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key === "Enter" && !(e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]")) (e.preventDefault(), ctl.toggle());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canBig, ctl]);
  if (!view) return null;
  const title = { history: t("inspector.history"), blame: "Blame", file: t("inspector.file"), lfs: "Git LFS", stats: t("inspector.stats") }[view.kind];
  return (
    <Sheet label={title} size="inspector" big={big && canBig} closeOnBackdrop onClose={() => setView(null)} onEscape={() => (big && canBig ? setBig(false) : setView(null))}>
      <SheetHead title={title} tools={canBig && <BigButton ctl={ctl} />} onClose={() => setView(null)}>
        {"path" in view && <span className="muted">{view.path}{"rev" in view && view.rev ? ` @ ${view.rev.slice(0, 7)}` : ""}</span>}
      </SheetHead>
      <SheetBody>
        {view.kind === "history" && <History path={view.path} onSelect={(id) => (onSelectCommit(id), setView(null))} />}
        {view.kind === "blame" && <Blame path={view.path} rev={view.rev} onSelect={(id) => (onSelectCommit(id), setView(null))} />}
        {view.kind === "file" && <FileContent path={view.path} rev={view.rev} />}
        {view.kind === "lfs" && <LfsPanel />}
        {view.kind === "stats" && <StatsPanel />}
      </SheetBody>
      <SheetActions cancel={t("common.close")} />
    </Sheet>
  );
}

function History({ path, onSelect }: { path: string; onSelect: (id: string) => void }) {
  const [listW, listSplit] = useSplit("history", 340, 200, 700, "x"); // 커밋 목록 폭 (저장)
  const [commits, setCommits] = useState<Commit[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  useEffect(() => {
    api.fileLog(ctx.repo, path).then((c) => (setCommits(c), setSel(c[0]?.id ?? null)), (e) => ctx.error(String(e)));
  }, [path]);
  useEffect(() => {
    if (sel) api.fileDiff(ctx.repo, sel, path).then(setDiff, (e) => (setDiff(""), ctx.error(String(e)))); // 빈 diff("변경 없음")로만 두지 않는다
  }, [sel, path]);
  return (
    <div className="inspector-body hist">
      <ul className="files" role="listbox" aria-label={t("inspector.historyLabel")} style={{ width: listW }}>
        {commits.map((c) => (
          <li key={c.id} role="option" aria-selected={c.id === sel} className={c.id === sel ? "selected" : ""} onMouseDown={() => setSel(c.id)} onDoubleClick={() => onSelect(c.id)} onContextMenu={contextMenu(() => [{ label: t("details.restoreVersion"), action: () => ops.restoreFile(path, c.id) }])}>
            <span className="h-subject" title={c.subject}>{c.subject}</span>
            <span className="h-meta muted"><Sha id={c.id} /> · {c.author} · {dateFmt.format(c.time * 1000)}</span>
          </li>
        ))}
      </ul>
      {listSplit}
      <DiffView diff={diff} bigCtl={null} />
    </div>
  );
}

function Blame({ path, rev, onSelect }: { path: string; rev: string | null; onSelect: (id: string) => void }) {
  const [lines, setLines] = useState<BlameLine[]>([]);
  useEffect(() => {
    api.blame(ctx.repo, path, rev).then(setLines, (e) => ctx.error(String(e)));
  }, [path, rev]);
  // 같은 커밋이 이어지는 줄은 정보를 한 번만 보여 준다.
  return (
    <pre className="diff blame selectable">
      {lines.map((l, i) => (
        <div key={i} className="blame-line">
          <span className="blame-info" title={l.summary} onDoubleClick={() => onSelect(l.sha)}>
            {i === 0 || lines[i - 1].sha !== l.sha ? `${l.sha.slice(0, 7)} ${l.author.slice(0, 10).padEnd(10)} ${dateFmt.format(l.time * 1000)}` : ""}
          </span>
          <span className="blame-no">{i + 1}</span>
          <span>{l.text || " "}</span>
        </div>
      ))}
    </pre>
  );
}

function FileContent({ path, rev }: { path: string; rev: string }) {
  const [text, setText] = useState("");
  useEffect(() => {
    api.git(ctx.repo, ["show", `${rev}:${path}`]).then(setText, (e) => setText(String(e)));
  }, [path, rev]);
  const lines = useMemo(() => text.split("\n"), [text]);
  return (
    <pre className="diff selectable">
      {lines.map((l, i) => (
        <div key={i}>
          <span className="blame-no">{i + 1}</span>
          {l || " "}
        </div>
      ))}
    </pre>
  );
}

/** LFS 추적 패턴과 LFS 파일 목록. 설치 안 됐으면 안내만 보인다. */
function LfsPanel() {
  const [lfs, setLfs] = useState<Lfs | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    api.lfsStatus(ctx.repo).then(setLfs, (e) => ctx.error(String(e)));
  }, [tick]);
  if (!lfs) return <div className="inspector-body" />;
  if (!lfs.installed)
    return (
      <p className="lfs-note">
        {t("inspector.noLfsPre")}<code>git lfs install</code>{t("inspector.noLfsPost")}
      </p>
    );
  const after = (p: Promise<unknown>) => p.then(() => setTick((t) => t + 1));
  return (
    <div className="inspector-body lfs">
      <div className="lfs-col">
        <div className="files-head">
          <span>{t("inspector.tracked", { n: lfs.tracked.length })}</span>
          <button onClick={() => after(ops.lfsTrack())}>{t("inspector.add")}</button>
        </div>
        <ul className="files" aria-label={t("inspector.trackedLabel")}>
          {lfs.tracked.map((p) => (
            <li key={p}>
              <span className="label">{p}</span>
              <button aria-label={t("inspector.untrackLabel", { p })} onClick={() => after(ops.lfsUntrack(p))}>{t("inspector.untrack")}</button>
            </li>
          ))}
          {!lfs.tracked.length && <li className="muted">{t("inspector.noTracked")}</li>}
        </ul>
      </div>
      <div className="lfs-col">
        <div className="files-head">
          <span>{t("inspector.lfsFiles", { n: lfs.files.length })}</span>
        </div>
        <ul className="files" aria-label={t("inspector.lfsFilesLabel")}>
          {lfs.files.map((f) => (
            <li key={f.path} title={f.oid}>
              <span className="sha">{f.oid.slice(0, 8)}</span>
              <span className="label">{f.path}</span>
              <span className="muted">{t(f.downloaded ? "inspector.downloaded" : "inspector.pointer")}</span>
            </li>
          ))}
          {!lfs.files.length && <li className="muted">{t("inspector.noLfsFiles")}</li>}
        </ul>
      </div>
    </div>
  );
}
