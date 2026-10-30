import { memo, useCallback, useEffect, useState } from "react";
import { t, useLocale } from "../../shared/i18n/i18n";
import type { Commit, GraphView, Ref, Status } from "../../shared/api/types";
import type { IssueRule } from "../../shared/lib/issues";
import { useTablet } from "../../shared/lib/platform";
import { countRender } from "../../shared/lib/profile";
import { ops } from "../../shared/model/ops";
import { Icon } from "../../shared/ui/Icon";
import { showMenu, type MenuEntry } from "../../shared/ui/menu";
import { CommitGraph } from "../commit-graph/CommitGraph";
import { Sidebar } from "../sidebar/Sidebar";
import { CommitPane } from "./CommitPane";
import { nav, useDepth, useSheet } from "./nav";
import { RepoList } from "./RepoList";

const NO_SUB: never[] = [];
const DEPTH = { list: 1, detail: 2, diff: 3 };

interface Props {
  repo: string;
  view: GraphView | null;
  refs: Ref[];
  status: Status | null;
  selected: string | null;
  commit: Commit | null;
  rules: IssueRule[];
  theme: string;
  repos: string[];
  pending: string | null;
  onPick: (id: string | null) => void;
  onMore: () => void;
  onOpenRepo: (path: string) => void;
  onClose: () => void;
  onForget: (path?: string) => void;
}

/**
 * 모바일 전용 셸(좁은 화면에 많은 걸 보여주지 않는다). 탭·워크스페이스·열 머리글·상태바·사이드바 없음.
 * 폰(폭 < 600): 한 화면에 한 가지 — 저장소 목록 → 커밋 목록 → 커밋 상세 → diff, 위에 쌓인 화면이 아래를 덮는다.
 * 태블릿(폭 ≥ 600): 왼쪽 커밋 목록 + 오른쪽 커밋 상세 → 파일을 누르면 같은 칸이 diff(← 로 복귀), 상단바 ☰ 서랍.
 * 뒤로 가기는 nav.ts(history). 데스크탑 셸은 마운트되지 않는다.
 */
export const MobileShell = memo(function MobileShell(p: Props) {
  useLocale();
  countRender("MobileShell");
  const tablet = useTablet();
  const depth = useDepth();
  const panel = useSheet();
  const { view, onClose } = p;
  // 파일 선택은 커밋 id와 함께 기억해서 다른 커밋을 고르면 저절로 풀린다
  const [picked, setPicked] = useState<{ id: string; path: string } | null>(null);
  const file = depth >= DEPTH.diff && picked?.id === p.selected ? picked.path : null;

  // 저장소가 열리면 기록 한 칸(커밋 목록), 닫히면 걷는다. 뒤로 가서 깊이 0이 되면 저장소를 닫는다
  const open = !!view;
  useEffect(() => void (open ? nav.depth === 0 && nav.push(DEPTH.list) : nav.reset()), [open]);
  useEffect(() => nav.onPop((d) => d === 0 && onClose()), [onClose]);

  const onFile = useCallback((path: string) => {
    setPicked({ id: p.selected!, path });
    if (nav.depth < DEPTH.diff) nav.push(DEPTH.diff);
  }, [p.selected]);
  // 목록 행을 누르면: 폰은 상세 화면, 태블릿은 오른쪽 칸이 그 커밋으로(diff를 보고 있었으면 상세로)
  const onOpen = useCallback(() => {
    if (nav.depth >= DEPTH.diff) nav.back();
    if (nav.depth === DEPTH.list && !tablet) nav.push(DEPTH.detail);
  }, [tablet]);
  const select = useCallback((id: string) => (p.onPick(id), nav.closeSheet()), [p.onPick]);

  if (!view) return <div className="m-root"><RepoList repos={p.repos} pending={p.pending} onOpen={p.onOpenRepo} onForget={p.onForget} /></div>;

  const name = p.repo.split(/[\\/]/).pop() || t("toolbar.repoFallback");
  const branch = p.status?.branch ?? (p.refs.length ? "(detached)" : "");
  const repoMenu = (): MenuEntry[] => [
    ...p.repos.filter((r) => r !== p.repo).map((r) => ({ label: r.split(/[\\/]/).pop()!, action: () => p.onOpenRepo(r) })),
    ...(p.repos.length > 1 ? [{ separator: true } as MenuEntry] : []),
    { label: t("app.repoList"), action: () => nav.back() },
  ];
  const moreMenu = (): MenuEntry[] => [
    { label: t("toolbar.fetch"), op: "fetch", action: ops.fetch },
    { label: t("toolbar.pull"), op: "pull", action: ops.pullQuick },
    { label: t("toolbar.push"), op: "push", action: ops.pushQuick },
    { separator: true },
    { label: t("toolbar.branch"), op: "branch", action: () => ops.createBranch() },
    { label: t("toolbar.clone"), op: "clone", action: ops.clone },
    { label: t("toolbar.settings"), action: () => ops.openSettings() },
  ];

  const bar = (
    <header className="m-bar">
      {tablet
        ? <button className="m-ico" aria-label={t("sidebar.toggle")} aria-expanded={panel} onClick={nav.openSheet}><Icon name="branch" size={20} /></button>
        : <button className="m-ico" aria-label={t("m.back")} onClick={nav.back}><Icon name="chevronLeft" size={22} /></button>}
      <button className="m-title" onClick={() => showMenu(repoMenu())}><span>{name}</span><Icon name="dropdown" size={11} /></button>
      <button className="m-branch" aria-label={t("toolbar.branchPick")} aria-haspopup="dialog" aria-expanded={panel} onClick={nav.openSheet}><span>{branch}</span><Icon name="dropdown" size={11} /></button>
      <span className="m-spacer" />
      <button className="m-ico" aria-label={t("m.more")} onClick={() => showMenu(moreMenu())}><Icon name="more" size={20} /></button>
      {tablet && <button className="m-ico" aria-label={t("toolbar.settingsLabel")} onClick={() => ops.openSettings()}><Icon name="settings" size={20} /></button>}
    </header>
  );
  const list = (
    <div className="m-list">
      <CommitGraph view={view} refs={p.refs} theme={p.theme} selected={p.selected} onSelect={p.onPick} onMore={p.onMore} localCount={0} onOpen={onOpen} />
    </div>
  );
  const pane = (
    <CommitPane repo={p.repo} commit={p.commit} rules={p.rules} file={file} back={!tablet || !!file} onBack={nav.back} onFile={onFile} />
  );

  return (
    <div className={"m-root" + (tablet ? " tablet" : "")}>
      {tablet ? (
        <>
          {bar}
          <div className="m-cols">{list}<div className="m-detail-col">{pane}</div></div>
        </>
      ) : (
        <>
          <section className="m-screen" {...(depth >= DEPTH.detail ? { inert: "" } : {})}>{bar}{list}</section>
          {depth >= DEPTH.detail && <div className="m-screen over">{pane}</div>}
        </>
      )}
      {panel && (
        <div className="m-panel-backdrop" onMouseDown={nav.closeSheet}>
          <aside className={"m-panel" + (tablet ? " drawer" : " bottom")} role="dialog" aria-label={t("toolbar.branchPick")} onMouseDown={(e) => e.stopPropagation()}>
            <Sidebar repo={p.repo} refs={p.refs} submodules={NO_SUB} worktrees={NO_SUB} onSelect={select} lite />
          </aside>
        </div>
      )}
    </div>
  );
});
