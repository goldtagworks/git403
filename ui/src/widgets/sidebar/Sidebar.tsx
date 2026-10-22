import type { CSSProperties } from "react";
import { memo, useEffect, useMemo, useRef, useState, useCallback } from "react";
import { t, useLocale, type Key } from "../../shared/i18n/i18n";
import { Highlight } from "../../shared/ui/Highlight";
import { countRender } from "../../shared/lib/profile";
import { Icon } from "../../shared/ui/Icon";
import type { IconName } from "../../shared/ui/icons";
import { isHiddenNode, isHiddenRef, nodePath, refPath, useHiddenNode, useHiddenRef, useViewing, useVisibleCount } from "../../shared/lib/hidden";
import { contextMenu, type MenuEntry } from "../../shared/ui/menu";
import { ops, store, stored } from "../../shared/model/ops";
import { atCommit, stashMenu } from "../../shared/model/menus";
import { pick, useActive } from "../../shared/model/selection";
import { PrSection } from "../../features/hosting/PrSection";
import type { Ref, RefKind, Submodule, Worktree } from "../../shared/api/types";

const SECTIONS: { kind: RefKind; label: Key; icon: IconName }[] = [
  { kind: "local", label: "sidebar.branches", icon: "branch" },
  { kind: "remote", label: "sidebar.remotes", icon: "remote" },
  { kind: "tag", label: "sidebar.tags", icon: "tag" },
  { kind: "stash", label: "sidebar.stashes", icon: "stash" },
];

const flowEntries = (name: string): MenuEntry[] => {
  const kind = ops.flowKind(name);
  return kind ? [{ separator: true }, { label: `Finish ${kind}…`, action: () => ops.flowFinish(name) }] : [];
};

/** 사이드바 항목 우클릭 메뉴 (ops 재사용) */
/** 호버하면 나타나는 눈 아이콘(그래프에서 보기/숨기기). 숨긴 항목은 눈 가림이 늘 보인다. */
function Eye({ off, onToggle }: { off: boolean; onToggle: () => void }) {
  return (
    <span
      className="eye"
      aria-hidden
      title={off ? t("sidebar.showInGraph") : t("sidebar.hideInGraph")}
      onClick={(e) => (e.stopPropagation(), onToggle())}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <Icon name={off ? "eyeClosed" : "eye"} size={13} />
    </span>
  );
}
/** 숨길 수 있는 ref: 현재(HEAD) 브랜치와 스태시는 제외 */
/** 트리 들여쓰기 + 조상 단계마다 세로 안내선 수(--gd). pad = 12 + depth * 16 */
const guides = (pad: number) => ({ paddingLeft: pad, "--gd": Math.max(0, (pad - 12) / 16 - 1) }) as CSSProperties;

const canHide = (r: Ref) => r.kind !== "stash" && !r.head;

const RefItem = memo(function RefItem({ repo, r, nodeKey, label, pad, leafIcon, q, onSelect }: { repo: string; r: Ref; nodeKey: string; label: string; pad: number; leafIcon: IconName; q: string; onSelect: (commit: string) => void }) {
  useLocale();
  const active = useActive(nodeKey, r.target);
  const off = useHiddenRef(repo, r);
  return (
    <button
      className={"item" + (r.head ? " head" : "") + (active ? " picked" : "") + (off ? " off" : "")}
      aria-current={active || undefined}
      style={guides(pad)}
      title={r.message ?? r.name}
      onClick={() => {
        pick(nodeKey, r.target);
        onSelect(r.target);
      }}
      onDoubleClick={() => (r.kind === "local" ? ops.checkout(r.name) : r.kind === "remote" ? ops.checkoutRemote(r.name) : r.kind === "stash" ? ops.applyStash(r.name) : null)}
      onContextMenu={contextMenu(() => refMenu(r, repo))}
    >
      {canHide(r) && <Eye off={off} onToggle={() => ops.toggleHidden(refPath(r.kind, r.name))} />}
      <span className="twisty" aria-hidden="true" />
      <Icon name={r.head ? "current" : leafIcon} />
      <span className="label"><Highlight text={label} q={q} /></span>
      {(r.ahead > 0 || r.behind > 0) && (
        <span className="state track" title={t("sidebar.track", { ahead: r.ahead, behind: r.behind })}>
          {r.behind > 0 && `↓${r.behind}`}{r.ahead > 0 && r.behind > 0 && " "}{r.ahead > 0 && `↑${r.ahead}`}
        </span>
      )}
    </button>
  );
});

const hideEntry = (r: Ref, repo: string): MenuEntry[] =>
  canHide(r) ? [{ label: isHiddenRef(repo, r) ? t("sidebar.showInGraph2") : t("sidebar.hideInGraph"), action: () => ops.toggleHidden(refPath(r.kind, r.name)) }] : [];

/** 그룹 순서: 원격 동기화 → 체크아웃·합치기 → 이 커밋 기준 작업 → PR·AI → 이름·삭제 → 복사·숨기기 */
function refMenu(r: Ref, repo: string): MenuEntry[] {
  switch (r.kind) {
    case "local":
      return [
        // Pull·Push는 현재 브랜치 대상이라 HEAD 브랜치에서만 보인다
        ...(r.head
          ? [
              { label: t("toolbar.pull"), action: ops.pullQuick },
              { label: t("toolbar.pullOpts"), action: ops.pull },
              { label: t("toolbar.push"), action: ops.pushQuick },
              { label: t("toolbar.pushOpts"), action: ops.push },
            ]
          : []),
        { label: t("sidebar.setUpstream"), action: () => ops.setUpstream(r.name) },
        { separator: true },
        { label: t("sidebar.checkout"), action: () => ops.checkout(r.name), disabled: r.head },
        { label: t("sidebar.merge"), action: () => ops.merge(r.name), disabled: r.head },
        { label: t("sidebar.rebase"), action: () => ops.rebase(r.name), disabled: r.head },
        { separator: true },
        { label: t("sidebar.newBranch"), action: () => ops.createBranch(r.name) },
        ...atCommit(r.target).slice(1),
        { separator: true },
        { label: t("sidebar.createPr"), action: () => ops.createPr(r.name) },
        ...(ops.aiOn() ? [{ label: t("sidebar.aiReview"), action: () => ops.aiReviewBranch(r.name) }] : []),
        { separator: true },
        { label: t("sidebar.rename"), action: () => ops.renameBranch(r.name) },
        { label: t("sidebar.delete"), action: () => ops.deleteBranch(r.name), disabled: r.head },
        ...flowEntries(r.name),
        { separator: true },
        { label: t("sidebar.copyName"), action: () => ops.copy(r.name) },
        ...hideEntry(r, repo),
        ...ops.customMenu("branch", { branch: r.name }),
      ];
    case "remote":
      return [
        { label: t("sidebar.checkoutRemote"), action: () => ops.checkoutRemote(r.name) },
        { label: t("sidebar.merge"), action: () => ops.merge(r.name) },
        { label: t("sidebar.rebase"), action: () => ops.rebase(r.name) },
        { separator: true },
        { label: t("sidebar.newBranch"), action: () => ops.createBranch(r.name) },
        ...atCommit(r.target).slice(1),
        { label: `${t("ops.tag.new")}…`, action: () => ops.createTag(r.target) },
        { separator: true },
        { label: t("sidebar.prInto"), action: () => ops.createPr(undefined, r.name), disabled: !ops.head() },
        { separator: true },
        { label: t("sidebar.deleteRemote"), action: () => ops.deleteRemoteBranch(r.name) },
        { separator: true },
        { label: t("sidebar.copyName"), action: () => ops.copy(r.name) },
        ...hideEntry(r, repo),
        ...ops.customMenu("branch", { branch: r.name }),
      ];
    case "tag":
      return [
        { label: "Push", action: () => ops.pushTag(r.name) },
        { separator: true },
        { label: t("sidebar.merge"), action: () => ops.merge(r.name) },
        { label: t("sidebar.rebase"), action: () => ops.rebase(r.name) },
        { separator: true },
        { label: t("sidebar.checkoutDetached"), action: () => ops.checkoutCommit(r.target) },
        { separator: true },
        ...atCommit(r.target),
        { separator: true },
        { label: t("sidebar.delete"), action: () => ops.deleteTag(r.name) },
        { separator: true },
        { label: t("sidebar.copyName"), action: () => ops.copy(r.name) },
        ...hideEntry(r, repo),
      ];
    case "stash":
      return [...stashMenu(r), { separator: true }, { label: t("sidebar.copyName"), action: () => ops.copy(r.name) }];
  }
}

const SUB_STATE: Record<Submodule["status"], Key | ""> = { ok: "", uninitialized: "sidebar.subUninit", modified: "sidebar.subModified", conflict: "sidebar.subConflict" };

const submoduleMenu = (s: Submodule): MenuEntry[] => [
  { label: t("sidebar.open"), action: () => ops.openSubmodule(s.path), disabled: s.status === "uninitialized" },
  { label: t("sidebar.update"), action: () => ops.updateSubmodules(s.path) },
  { separator: true },
  { label: t("sidebar.remove"), action: () => ops.removeSubmodule(s.path) },
  { label: t("sidebar.copyPath"), action: () => ops.copy(s.path) },
];
const submoduleSectionMenu = (): MenuEntry[] => [
  { label: t("sidebar.updateAll"), action: () => ops.updateSubmodules() },
  { label: t("sidebar.syncUrl"), action: ops.syncSubmodules },
  { label: t("sidebar.addSubmodule"), action: ops.addSubmodule },
];

const worktreeName = (w: Worktree) => w.branch ?? (w.bare ? "(bare)" : `(detached) ${w.head.slice(0, 7)}`);
const worktreeMenu = (w: Worktree): MenuEntry[] => [
  { label: t("sidebar.open"), action: () => ops.openWorktree(w.path), disabled: w.prunable },
  { separator: true },
  w.locked ? { label: t("sidebar.unlock"), action: () => ops.unlockWorktree(w.path) } : { label: t("sidebar.lock"), action: () => ops.lockWorktree(w.path), disabled: w.main },
  { label: t("sidebar.remove"), action: () => ops.removeWorktree(w.path), disabled: w.main },
  { label: t("sidebar.copyPath"), action: () => ops.copy(w.path) },
];
const worktreeSectionMenu = (): MenuEntry[] => [
  { label: t("sidebar.addWorktree"), action: ops.addWorktree },
  { label: t("sidebar.prune"), action: ops.pruneWorktrees },
];

const remoteMenu = (name: string): MenuEntry[] => [
  { label: "Fetch", action: ops.fetch },
  { label: t("sidebar.edit"), action: () => ops.editRemote(name) },
  { label: t("sidebar.delete"), action: () => ops.removeRemote(name) },
];

/** 폴더 행: 숨김 여부만 구독해서 토글한 폴더만 다시 그려진다. */
const FolderRow = memo(function FolderRow({ repo, path, pad, open, icon, label, onToggle, menu, q }: { repo: string; path: string | null; pad: number; open: boolean; icon: IconName; label: string; q: string; onToggle: () => void; menu: () => MenuEntry[] }) {
  useLocale();
  const off = useHiddenNode(repo, path ?? "", true);
  return (
    <button className={"item folder" + (off ? " off" : "")} style={guides(pad)} aria-expanded={open} onClick={onToggle} onContextMenu={contextMenu(menu)}>
      {path && <Eye off={off} onToggle={() => ops.toggleHidden(path, true)} />}
      <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
      <Icon name={icon} />
      <span className="label"><Highlight text={label} q={q} /></span>
    </button>
  );
});
const folderMenu = (repo: string, path: string, extra: MenuEntry[]): MenuEntry[] => [
  { label: isHiddenNode(repo, path, true) ? t("sidebar.showInGraph2") : t("sidebar.hideInGraph"), action: () => ops.toggleHidden(path, true) },
  ...(extra.length ? [{ separator: true } as MenuEntry, ...extra] : []),
];

/** "보는 중 70/97 · 모두 보기": 숨긴 ref가 있을 때만. 숨김 상태만 구독해 이 줄만 다시 그려진다. */
const ViewBar = memo(function ViewBar({ repo, refs }: { repo: string; refs: Ref[] }) {
  useLocale();
  const v = useViewing(repo, refs);
  if (!v) return null;
  return (
    <div className="side-view">
      <span>{t("sidebar.viewing", { v })}</span>
      <button onClick={ops.showAllHidden}>{t("sidebar.showAll")}</button>
    </div>
  );
});

const Count = memo(function Count({ repo, refs }: { repo: string; refs: Ref[] }) {
  return <span className="count">{useVisibleCount(repo, refs)}</span>;
});

interface Node {
  key: string;
  label: string;
  children: Node[];
  ref?: Ref;
}

/** `fix/a`, `origin/main`처럼 `/`로 나뉜 이름을 폴더 트리로 묶는다. */
function buildTree(refs: Ref[], kind: RefKind): Node[] {
  const root: Node = { key: kind, label: "", children: [] };
  for (const r of refs) {
    const parts = kind === "stash" ? [r.message ?? r.name] : r.name.split("/");
    let node = root;
    parts.forEach((p, i) => {
      const key = node.key + "/" + p;
      let child = node.children.find((c) => c.key === key && !c.ref);
      if (i === parts.length - 1) node.children.push({ key, label: p, children: [], ref: r });
      else {
        if (!child) node.children.push((child = { key, label: p, children: [] }));
        node = child;
      }
    });
  }
  return root.children;
}

export const Sidebar = memo(function Sidebar({ repo, refs, submodules, worktrees, onSelect }: { repo: string; refs: Ref[]; submodules: Submodule[]; worktrees: Worktree[]; onSelect: (commit: string) => void }) {
  countRender("Sidebar");
  useLocale();
  // 접은 섹션·폴더는 저장해 다음 실행에도 접힌 채로 (기본은 태그만 접힘)
  const [closed, setClosed] = useState<Set<string>>(() => new Set(stored<string[]>("sideClosed", ["tag"])));
  // 필터: 입력 상태는 Sidebar 안에만 둔다 (그래프·상세는 다시 그려지지 않는다)
  const [q, setQ] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === "KeyF") {
        e.preventDefault();
        filterRef.current?.focus();
        filterRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const needle = q.trim().toLowerCase();
  const toggle = (k: string) =>
    setClosed((s) => {
      const n = new Set(s);
      n.has(k) ? n.delete(k) : n.add(k);
      store("sideClosed", [...n]);
      return n;
    });

  const renderNodes = (nodes: Node[], depth: number, kind: RefKind, leafIcon: IconName) =>
    nodes.map((n) => {
      const pad = { paddingLeft: 12 + depth * 16 };
      if (n.ref) {
        return <RefItem key={n.key} repo={repo} r={n.ref} nodeKey={n.key} label={n.label} pad={pad.paddingLeft} leafIcon={leafIcon} q={needle} onSelect={onSelect} />;
      }
      const open = !!needle || !closed.has(n.key); // 필터 중에는 일치 항목이 있는 폴더를 모두 펼친다
      // 원격의 첫 단계(origin 등)는 서버, 그 아래는 폴더.
      const folderIcon: IconName = kind === "remote" && depth === 1 ? "server" : open ? "openFolder" : "folder";
      const path = kind === "stash" ? null : nodePath(kind, n.key);
      const server = kind === "remote" && depth === 1;
      return (
        <div key={n.key}>
          <FolderRow
            repo={repo}
            path={path}
            pad={pad.paddingLeft}
            open={open}
            icon={folderIcon}
            label={n.label}
            q={needle}
            onToggle={() => toggle(n.key)}
            menu={() => (path ? folderMenu(repo, path, server ? remoteMenu(n.label) : []) : [])}
          />
          {open && renderNodes(n.children, depth + 1, kind, leafIcon)}
        </div>
      );
    });

  const byKind = useMemo(() => SECTIONS.map(({ kind }) => refs.filter((r) => r.kind === kind)), [refs]);
  const shownKind = useMemo(
    () => (needle ? byKind.map((rs, i) => rs.filter((r) => (SECTIONS[i].kind === "stash" ? r.message ?? r.name : r.name).toLowerCase().includes(needle))) : byKind),
    [byKind, needle],
  );
  const trees = useMemo(() => SECTIONS.map(({ kind }, i) => buildTree(shownKind[i], kind)), [shownKind]);
  const none = !!needle && shownKind.every((rs) => rs.length === 0);

  return (
    <nav className="sidebar">
      <label className="side-filter">
        <Icon name="search" size={13} />
        <input
          ref={filterRef}
          value={q}
          placeholder={t("sidebar.filter", { key: /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘⌥F" : "Ctrl+Alt+F" })}
          aria-label={t("sidebar.filterLabel")}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && (q ? setQ("") : e.currentTarget.blur())}
        />
        {q && <button className="clear" aria-label={t("sidebar.clearFilter")} onClick={() => (setQ(""), filterRef.current?.focus())}><Icon name="dismiss" size={12} /></button>}
      </label>
      <ViewBar repo={repo} refs={refs} />
      {none && <div className="side-empty">{t("sidebar.noMatch")}</div>}
      {SECTIONS.map(({ kind, label, icon }, i) => {
        const tree = trees[i];
        const open = !!needle || !closed.has(kind);
        if (needle && shownKind[i].length === 0) return null;
        return (
          <section key={kind}>
            <button
              className="section-title"
              aria-expanded={open}
              onClick={() => toggle(kind)}
              onContextMenu={kind === "remote" ? contextMenu(() => [{ label: t("sidebar.addRemote"), action: ops.addRemote }]) : undefined}
            >
              <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
              {t(label)}
              <Count repo={repo} refs={byKind[i]} />
            </button>
            {open && <div className="section-body">{renderNodes(tree, 1, kind, icon)}</div>}
          </section>
        );
      })}
      <PrSection repo={repo} />
      {submodules.length > 0 && (
        <section>
          <button className="section-title" aria-expanded={!closed.has("submodule")} onClick={() => toggle("submodule")} onContextMenu={contextMenu(submoduleSectionMenu)}>
            <Icon name={closed.has("submodule") ? "chevronRight" : "chevronDown"} size={12} />
            {t("sidebar.submodules")}
            <span className="count">{submodules.length}</span>
          </button>
          {!closed.has("submodule") &&
            submodules.map((s) => (
              <button
                key={s.path}
                className="item"
                style={{ paddingLeft: 12 }}
                title={`${s.path}\n${s.url ?? ""}\n${s.commit.slice(0, 7)}`}
                onDoubleClick={() => s.status !== "uninitialized" && ops.openSubmodule(s.path)}
                onContextMenu={contextMenu(() => submoduleMenu(s))}
              >
                <Icon name="submodule" />
                <span className="label">{s.path}</span>
                {s.status !== "ok" && <span className={"state" + (s.status === "conflict" ? " warn" : "")}>{SUB_STATE[s.status] && t(SUB_STATE[s.status] as Key)}</span>}
              </button>
            ))}
        </section>
      )}
      {worktrees.length > 1 && (
        <section>
          <button className="section-title" aria-expanded={!closed.has("worktree")} onClick={() => toggle("worktree")} onContextMenu={contextMenu(worktreeSectionMenu)}>
            <Icon name={closed.has("worktree") ? "chevronRight" : "chevronDown"} size={12} />
            Worktree
            <span className="count">{worktrees.length}</span>
          </button>
          {!closed.has("worktree") &&
            worktrees.map((w) => (
              <button
                key={w.path}
                className={"item" + (w.main ? " head" : "")}
                style={{ paddingLeft: 12 }}
                title={w.path}
                onDoubleClick={() => !w.prunable && ops.openWorktree(w.path)}
                onContextMenu={contextMenu(() => worktreeMenu(w))}
              >
                <Icon name="worktree" />
                <span className="label">{worktreeName(w)}</span>
                {w.locked && <Icon name="lock" size={12} />}
                {w.prunable && <span className="state">{t("sidebar.missing")}</span>}
              </button>
            ))}
        </section>
      )}
    </nav>
  );
});
