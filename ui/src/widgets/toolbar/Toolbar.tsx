import { memo, useRef, useState } from "react";
import { Highlight } from "../../shared/ui/Highlight";
import { t, useLocale } from "../../shared/i18n/i18n";
import { Icon } from "../../shared/ui/Icon";
import type { IconName } from "../../shared/ui/icons";
import { showMenu, type MenuEntry } from "../../shared/ui/menu";
import { ops } from "../../shared/model/ops";
import { countRender } from "../../shared/lib/profile";
import type { ThemeMode } from "../../shared/lib/theme";
import type { Ref, Status } from "../../shared/api/types";

interface Props {
  repo: string;
  refs: Ref[];
  status: Status | null;
  busy: boolean;
  recent: string[];
  theme: ThemeMode;
  onTheme: (m: ThemeMode) => void;
  onOpen: (path?: string) => void;
  onForget: (path?: string) => void;
  onQuickLaunch: () => void;
}

/** 아이콘 위·글자 아래 툴바 버튼. menu가 있으면 오른쪽 ▾로 옵션 메뉴. */
function Tool({ icon, label, onClick, menu, badge, disabled, why }: {
  icon: IconName;
  label: string;
  onClick: () => void;
  menu?: () => MenuEntry[];
  badge?: number;
  disabled?: boolean;
  /** 비활성일 때 이유(툴팁) */
  why?: string;
}) {
  return (
    <div className="tool" title={disabled ? why : undefined}>
      <button className="tool-btn" onClick={onClick} disabled={disabled} aria-label={label}>
        <span className="tool-icon">
          <Icon name={icon} size={20} />
          {!!badge && <span className="badge-count">{badge}</span>}
        </span>
        <span className="tool-label">{label}</span>
      </button>
      {menu && (
        <button className="tool-more" aria-label={t("toolbar.options", { label })} disabled={disabled} onClick={() => showMenu(menu())}>
          <Icon name="dropdown" size={11} />
        </button>
      )}
    </div>
  );
}

/** 브랜치 선택 팝오버: 입력하면 바로 거르고 ↑↓·Enter로 체크아웃. 열림·검색어 상태는 여기만 가진다(Toolbar는 다시 그려지지 않는다). */
function BranchPicker({ refs, branch, disabled }: { refs: Ref[]; branch: string; disabled: boolean }) {
  useLocale();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const close = () => (setOpen(false), setQ(""), setIdx(0));
  const needle = q.trim().toLowerCase();
  const pick = (kind: "local" | "remote") => refs.filter((r) => r.kind === kind && !r.name.endsWith("/HEAD") && r.name.toLowerCase().includes(needle));
  const items = [...pick("local"), ...pick("remote")]; // 로컬 먼저, 원격은 아래 구역
  const nLocal = items.filter((r) => r.kind === "local").length;
  const run = (r: Ref) => (close(), r.kind === "local" ? ops.checkout(r.name) : ops.checkoutRemote(r.name));
  const move = (i: number) => {
    setIdx(i);
    listRef.current?.querySelectorAll("li[data-i]")[i]?.scrollIntoView({ block: "nearest" });
  };
  const row = (r: Ref, i: number) => (
    <li key={r.kind + r.name} data-i={i} className={(i === idx ? "active " : "") + (r.head ? "head" : "")} onMouseMove={() => i !== idx && setIdx(i)} onClick={() => run(r)}>
      <Icon name={r.head ? "current" : r.kind === "remote" ? "remote" : "branch"} size={14} />
      <span className="label"><Highlight text={r.name} q={needle ? q.trim() : ""} /></span>
    </li>
  );
  return (
    <div className="branch-pop-wrap">
      <button className="picker" onClick={() => (open ? close() : setOpen(true))} disabled={disabled} aria-haspopup="listbox" aria-expanded={open}>
        <span className="picker-label">{t("toolbar.branch")}</span>
        <span className="picker-value">{branch}<Icon name="dropdown" size={11} /></span>
      </button>
      {open && (
        <>
          <div className="branch-pop-backdrop" onMouseDown={close} />
          <div className="branch-pop" role="dialog" aria-label={t("toolbar.branchPick")}>
            <input
              autoFocus
              value={q}
              placeholder={t("toolbar.branchSearch")}
              aria-label={t("toolbar.branchSearch")}
              onChange={(e) => (setQ(e.target.value), setIdx(0))}
              onKeyDown={(e) => {
                if (e.key === "Escape") close();
                else if (e.key === "ArrowDown") (e.preventDefault(), items.length && move((idx + 1) % items.length));
                else if (e.key === "ArrowUp") (e.preventDefault(), items.length && move((idx - 1 + items.length) % items.length));
                else if (e.key === "Enter" && items[idx]) run(items[idx]);
              }}
            />
            <ul ref={listRef} role="listbox">
              {nLocal > 0 && <li className="group" role="presentation">{t("toolbar.local")}</li>}
              {items.slice(0, nLocal).map((r, i) => row(r, i))}
              {items.length > nLocal && <li className="group" role="presentation">{t("toolbar.remote")}</li>}
              {items.slice(nLocal).map((r, i) => row(r, nLocal + i))}
              {!items.length && <li className="empty" role="presentation">{t("toolbar.noBranch")}</li>}
            </ul>
            <footer><button onClick={() => (close(), ops.createBranch())}>{t("toolbar.newBranch")}</button></footer>
          </div>
        </>
      )}
    </div>
  );
}

export const Toolbar = memo(function Toolbar(p: Props) {
  countRender("Toolbar");
  useLocale();
  const name = p.repo.split(/[\\/]/).pop() || t("toolbar.repoFallback");
  const branch = p.status?.branch ?? (p.refs.length ? "(detached)" : "");
  const stashes = p.refs.filter((r) => r.kind === "stash").length;
  const none = !p.repo;

  const repoMenu = (): MenuEntry[] => [
    { label: t("toolbar.openRepo"), action: () => p.onOpen(), accelerator: "CmdOrCtrl+O" },
    { label: t("toolbar.clone"), action: ops.clone },
    { label: t("toolbar.init"), action: ops.init },
    { label: t("toolbar.scan"), action: ops.scan },
    ...(none
      ? []
      : [
          { separator: true } as MenuEntry,
          { label: t("toolbar.addSubmodule"), action: ops.addSubmodule },
          { label: t("toolbar.addWorktree"), action: ops.addWorktree },
          { label: t("toolbar.applyPatch"), action: ops.applyPatch },
          { label: t("toolbar.stats"), action: ops.repoStats },
          { label: "Git Flow", submenu: ops.flowMenu() } as MenuEntry,
          {
            label: "LFS",
            submenu: [
              { label: t("toolbar.lfsStatus"), action: ops.lfsStatus },
              { label: "LFS Pull", action: ops.lfsPull, disabled: p.busy },
              { label: "LFS Fetch", action: ops.lfsFetch, disabled: p.busy },
              { label: "LFS Push", action: ops.lfsPush, disabled: p.busy },
              { separator: true },
              { label: t("toolbar.lfsTrack"), action: () => ops.lfsTrack() },
              { label: t("toolbar.lfsUntrack"), action: () => ops.lfsUntrack() },
            ],
          } as MenuEntry,
        ]),
    { separator: true },
    ...p.recent.filter((r) => r !== p.repo).map((r) => ({ label: r.split(/[\\/]/).pop() + "  —  " + r, action: () => p.onOpen(r) })),
    ...(p.recent.length ? [{ separator: true } as const, { label: t("toolbar.clearRecent"), action: () => p.onForget() }] : []),
  ];
  const needRepo = t("toolbar.needRepo");
  const busyWhy = t("toolbar.busy");
  return (
    <header className="toolbar" data-tauri-drag-region>
      <button className="picker" onClick={() => showMenu(repoMenu())}>
        <span className="picker-label">{t("toolbar.repo")}</span>
        <span className="picker-value">{name}<Icon name="dropdown" size={11} /></span>
      </button>
      <Icon name="chevronRight" size={14} />
      <BranchPicker refs={p.refs} branch={branch} disabled={none} />

      <div className="spacer" data-tauri-drag-region />

      <Tool icon="fetch" label={t("toolbar.fetch")} onClick={ops.fetch} disabled={none || p.busy} why={none ? needRepo : busyWhy} />
      <Tool icon="pull" label={t("toolbar.pull")} onClick={ops.pullQuick} menu={() => [{ label: t("toolbar.pullOpts"), action: ops.pull }]} badge={p.status?.behind} disabled={none || p.busy} why={none ? needRepo : busyWhy} />
      <Tool icon="push" label={t("toolbar.push")} onClick={ops.pushQuick} menu={() => [{ label: t("toolbar.pushOpts"), action: ops.push }, { separator: true }, { label: t("toolbar.createPr"), action: () => ops.createPr(), disabled: !p.status?.branch }]} badge={p.status?.ahead} disabled={none || p.busy} why={none ? needRepo : busyWhy} />
      <div className="tool-sep" />
      <Tool icon="newBranch" label={t("toolbar.branch")} onClick={() => ops.createBranch()} disabled={none} why={needRepo} />
      <Tool icon="stashPush" label={t("toolbar.stash")} onClick={ops.stash} menu={() => [{ label: t("toolbar.stashMenu"), action: ops.stash }, { label: t("toolbar.snapshot"), action: ops.snapshot }]} disabled={none || !p.status?.files.length} why={none ? needRepo : t("toolbar.noChanges")} />
      <Tool icon="stashPop" label={t("toolbar.pop")} onClick={() => ops.pop()} badge={stashes} disabled={none || !stashes} why={none ? needRepo : t("toolbar.noStash")} />
      <div className="tool-sep" />
      <Tool icon="launch" label={t("toolbar.quick")} onClick={p.onQuickLaunch} />
      <Tool
        icon="terminal"
        label={t("toolbar.openMenu")}
        onClick={ops.openTerminal}
        menu={() => [
          { label: t("toolbar.openTerminal"), action: ops.openTerminal },
          { label: t("toolbar.openFolder"), action: ops.openFolder },
          ...ops.customMenu("repo"),
        ]}
        disabled={none}
      />
      <Tool
        icon="settings"
        label={t("toolbar.settingsLabel")}
        onClick={() =>
          showMenu([
            { label: t("toolbar.settings"), action: () => ops.openSettings(), accelerator: "CmdOrCtrl+," },
            { separator: true },
            { label: t("toolbar.theme"), submenu: (["system", "light", "dark"] as const).map((m) => ({ label: t(({ system: "toolbar.themeSystem", light: "toolbar.themeLight", dark: "toolbar.themeDark" } as const)[m]), checked: p.theme === m, action: () => p.onTheme(m) })) },
            { separator: true },
            { label: t("toolbar.addRemote"), action: ops.addRemote, disabled: none },
          ])
        }
      />
    </header>
  );
});
