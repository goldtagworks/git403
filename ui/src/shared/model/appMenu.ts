// 앱 메뉴 막대(macOS 상단 메뉴, Windows·Linux 창 메뉴). 구조: App(mac) / File / Edit(mac) / Repository / View / Window(mac) / Help.
// 항목은 새 동작이 아니라 툴바·빠른 실행·단축키가 쓰는 ops 호출이다. 문구는 UI 사전(t)이라 언어를 바꾸면 메뉴를 다시 만든다.
// 메뉴 막대는 App 상태에 반응하는 부분이 repo 유무·탭 수뿐이라 `appMenu.set`이 그 둘이 바뀔 때만 부르고, 나머지(작업 중·스태시 없음 등)는 실행 시점에 검사한다.
//
// 단축키 규칙: macOS는 메뉴가 키를 먼저 받으므로 기존 전역 단축키(app/main.tsx)와 같은 키를 표시해도 한 번만 실행된다.
// Windows·Linux는 전역 단축키(keydown)가 이미 있는 항목에 메뉴 가속키를 달지 않는다(두 번 실행 방지). 새 키(Clone)만 모든 OS에 단다.
import { IS_VSCODE } from "../api/bridge";
import { onLocale, t } from "../i18n/i18n";
import { isMac, isMobile } from "../lib/platform";
import { nativeItems, type MenuEntry, type Roles } from "../ui/menu";
import { onCaps, visible, capsVersion } from "../lib/caps";
import { bigView } from "./bigview";
import { guide } from "./guide";
import { aiBus, ctx, ops } from "./ops";

/** 메뉴가 부르는 App 쪽 동작 (저장소 선택창·팔레트·탭 닫기는 App 상태를 쓴다) */
export interface AppMenuDeps {
  open: () => void;
  palette: () => void;
  refresh: () => void;
  close: () => void;
}
export interface AppMenuState { repo: boolean; tabs: number }

const MOD = "CmdOrCtrl";
/** 전역 단축키가 이미 있는 키: macOS에서만 가속키로 단다 */
const key = (a: string) => (isMac ? a : undefined);

/** 작업 중이면 안내만 하고 막는다 (툴바 버튼이 비활성인 조건과 같다) */
const idle = (f: () => void) => () => (ctx.busy() ? ctx.notify(t("toolbar.busy"), { kind: "info" }) : f());

export function appMenuModel(s: AppMenuState, d: AppMenuDeps): MenuEntry[] {
  const no = !s.repo;
  const tabs = s.tabs < 2;
  const sep: MenuEntry = { separator: true };
  const settings: MenuEntry = { label: t("toolbar.settings"), action: () => ops.openSettings(), accelerator: isMac ? `${MOD}+,` : undefined };
  const tabNav: MenuEntry[] = [
    { label: t("tabs.next"), action: () => ops.tabStep(1), disabled: tabs, accelerator: key(`${MOD}+Alt+Right`) },
    { label: t("tabs.prev"), action: () => ops.tabStep(-1), disabled: tabs, accelerator: key(`${MOD}+Alt+Left`) },
  ];
  const fullscreen: MenuEntry = isMac
    ? { label: t("menu.fullscreen"), predefined: "Fullscreen" }
    : {
        label: t("menu.fullscreen"),
        action: async () => {
          const w = (await import("@tauri-apps/api/window")).getCurrentWindow();
          await w.setFullscreen(!(await w.isFullscreen()));
        },
      };

  const app: MenuEntry[] = isMac
    ? [
        {
          label: "git403",
          submenu: [
            { label: t("menu.about"), predefined: "About" },
            sep,
            settings,
            sep,
            { label: t("menu.services"), predefined: "Services" },
            sep,
            { label: t("menu.hide"), predefined: "Hide" },
            { label: t("menu.hideOthers"), predefined: "HideOthers" },
            { label: t("menu.showAll"), predefined: "ShowAll" },
            sep,
            { label: t("menu.quit"), predefined: "Quit" },
          ],
        },
      ]
    : [];

  const file: MenuEntry = {
    label: t("menu.file"),
    submenu: [
      { label: t("toolbar.openRepo"), action: d.open, accelerator: key(`${MOD}+O`) },
      { label: t("toolbar.clone"), op: "clone", action: ops.clone, accelerator: `${MOD}+N` },
      { label: t("toolbar.init"), op: "init", action: ops.init },
      { label: t("toolbar.scan"), action: ops.scan },
      sep,
      { label: t("menu.closeTab"), action: d.close, accelerator: key(`${MOD}+W`) },
      sep,
      { label: t("toolbar.openTerminal"), op: "open_in", action: ops.openTerminal, disabled: no },
      { label: t("toolbar.openFolder"), op: "open_in", action: ops.openFolder, disabled: no },
      // Windows·Linux는 앱 메뉴가 없어 설정·종료가 File 끝에 온다
      ...(isMac ? [] : [sep, settings, { label: t("menu.quit"), action: async () => (await import("@tauri-apps/api/window")).getCurrentWindow().close() } as MenuEntry]),
    ],
  };

  const edit: MenuEntry[] = isMac
    ? [
        {
          label: t("menu.edit"),
          submenu: [
            { label: t("menu.undo"), predefined: "Undo" },
            { label: t("menu.redo"), predefined: "Redo" },
            sep,
            { label: t("menu.cut"), predefined: "Cut" },
            { label: t("menu.copy"), predefined: "Copy" },
            { label: t("menu.paste"), predefined: "Paste" },
            { label: t("menu.selectAll"), predefined: "SelectAll" },
          ],
        },
      ]
    : [];

  const repo: MenuEntry = {
    label: t("menu.repo"),
    submenu: [
      { label: t("toolbar.fetch"), op: "fetch", action: idle(ops.fetch), disabled: no, accelerator: key(`${MOD}+Shift+F`) },
      { label: t("toolbar.pull"), op: "pull", action: idle(ops.pullQuick), disabled: no, accelerator: key(`${MOD}+Shift+L`) },
      { label: t("toolbar.pullOpts"), op: "pull", action: idle(ops.pull), disabled: no },
      { label: t("toolbar.push"), op: "push", action: idle(ops.pushQuick), disabled: no, accelerator: key(`${MOD}+Shift+P`) },
      { label: t("toolbar.pushOpts"), op: "push", action: idle(ops.push), disabled: no },
      sep,
      { label: t("toolbar.newBranch"), op: "branch", action: () => ops.createBranch(), disabled: no, accelerator: key(`${MOD}+Shift+B`) },
      { label: t("toolbar.stashMenu"), op: "stash", action: () => (ctx.status?.files.length ? ops.stash() : ctx.notify(t("toolbar.noChanges"), { kind: "info" })), disabled: no, accelerator: key(`${MOD}+Shift+S`) },
      { label: t("quick.c21"), op: "stash", action: () => (ctx.refs.some((r) => r.kind === "stash") ? ops.pop() : ctx.notify(t("toolbar.noStash"), { kind: "info" })), disabled: no },
      { label: t("toolbar.snapshot"), op: "stash", action: () => ops.snapshot(), disabled: no },
      sep,
      { label: t("toolbar.createPr"), action: () => ops.createPr(), disabled: no },
      { label: t("toolbar.addRemote"), op: "remote", action: ops.addRemote, disabled: no },
      { label: t("toolbar.applyPatch"), op: ["apply", "am"], action: ops.applyPatch, disabled: no },
      { label: t("toolbar.stats"), op: "repo_stats", action: ops.repoStats, disabled: no },
      sep,
      { label: t("toolbar.addSubmodule"), op: "submodule", action: ops.addSubmodule, disabled: no },
      { label: t("toolbar.addWorktree"), op: "worktree", action: ops.addWorktree, disabled: no },
    ],
  };

  const view: MenuEntry = {
    label: t("menu.view"),
    submenu: [
      { label: t("menu.refresh"), action: d.refresh, disabled: no, accelerator: key(`${MOD}+R`) },
      sep,
      { label: t("layout.toggle"), action: ops.toggleLayout, accelerator: key(`${MOD}+Alt+B`) },
      { label: t("quick.big"), action: () => (bigView.avail || bigView.open) && bigView.toggle(), disabled: no, accelerator: key(`${MOD}+Shift+Enter`) },
      ...(ops.aiOn() ? [{ label: t("quick.guide"), action: guide.toggle, disabled: no, accelerator: key(`${MOD}+Alt+I`) } as MenuEntry] : []),
      sep,
      ...(isMac ? [] : [...tabNav, sep]),
      fullscreen,
    ],
  };

  const win: MenuEntry[] = isMac
    ? [{ label: t("menu.window"), role: "window", submenu: [{ label: t("menu.minimize"), predefined: "Minimize" }, { label: t("menu.zoom"), predefined: "Maximize" }, sep, ...tabNav] }]
    : [];

  const help: MenuEntry = { label: t("menu.help"), role: "help", submenu: [{ label: t("quick.title"), action: d.palette, accelerator: key(`${MOD}+P`) }] };

  return [...app, file, ...edit, repo, view, ...win, help];
}

// ---- 설치: 상태·언어·AI 사용 가능 여부가 바뀌면 다시 만든다 (한 틱에 모아서) ----
let deps: AppMenuDeps | null = null;
let state: AppMenuState = { repo: false, tabs: 0 };
let timer = 0;
let seq = 0;
let current: Awaited<ReturnType<typeof import("@tauri-apps/api/menu").Menu.new>> | null = null;
const sig = () => JSON.stringify(state) + t("menu.file") + ops.aiOn() + capsVersion();
let last = "";

/* macOS는 창을 닫아도 숨기기만 한다. 그 상태에서 메뉴(설정·열기 등)를 고르면 숨은 창 안에서 열려 반응이 없어 보이므로
   먼저 창을 보이고 실행한다. 탭 닫기(⌘W)만은 창을 다시 띄우지 않는다. */
function withShow(items: MenuEntry[], skip: () => void): MenuEntry[] {
  return items.map((e) => {
    if ("submenu" in e) return { ...e, submenu: withShow(e.submenu, skip) };
    if (!("action" in e) || e.action === skip) return e;
    const run = e.action;
    return {
      ...e,
      action: async () => {
        const w = (await import("@tauri-apps/api/window")).getCurrentWindow();
        if (!(await w.isVisible())) await w.show();
        await w.setFocus();
        run();
      },
    };
  });
}

async function apply() {
  if (!deps || isMobile) return; // 모바일에는 메뉴 막대가 없다(menu 플러그인 권한도 없음): JS 메뉴 API를 부르지 않는다
  const my = ++seq;
  const model = visible(appMenuModel(state, deps));
  if (import.meta.env.VITE_MOCK) return void ((window as any).__appMenuModel = model);
  if (IS_VSCODE || !(window as any).__TAURI_INTERNALS__) return;
  const { Menu } = await import("@tauri-apps/api/menu");
  const roles: Roles = {};
  const menu = await Menu.new({ items: await nativeItems(withShow(model, deps.close), roles) });
  if (my !== seq) return void menu.close(); // 그사이 더 새 요청이 있었다
  await menu.setAsAppMenu();
  await roles.window?.setAsWindowsMenuForNSApp();
  await roles.help?.setAsHelpMenuForNSApp();
  const old = current;
  current = menu;
  old?.close().catch(() => {});
}

const schedule = () => {
  if (sig() === last) return;
  last = sig();
  clearTimeout(timer);
  timer = window.setTimeout(() => void apply().catch((e) => console.error("메뉴 막대", e)), 0);
};

export const appMenu = {
  /** App이 시작할 때 한 번: 메뉴가 부를 동작을 넘기고 언어·AI 변경을 구독한다. 해제 함수를 돌려준다 */
  start(d: AppMenuDeps) {
    deps = d;
    last = "";
    schedule();
    const un = [onLocale(schedule), aiBus.on(schedule), onCaps(schedule)];
    return () => {
      un.forEach((f) => f());
      deps = null;
    };
  },
  /** 저장소 유무·탭 수가 바뀔 때 */
  set(s: AppMenuState) {
    state = s;
    schedule();
  },
};

// 목업 E2E: 메뉴 막대 구조를 읽고 항목을 실행해 본다 (실제 앱은 OS 메뉴라 DOM에 없다)
if (import.meta.env.VITE_MOCK) {
  type Row = { label: string; accelerator?: string; disabled?: boolean; predefined?: string; sep?: true; items?: Row[] };
  const plain = (l: MenuEntry[]): Row[] =>
    l.map((e) => ("separator" in e ? { label: "", sep: true } : "submenu" in e ? { label: e.label, items: plain(e.submenu) } : "predefined" in e ? { label: e.label, predefined: e.predefined } : { label: e.label, accelerator: e.accelerator, disabled: e.disabled }));
  const find = (l: MenuEntry[], path: string[]): MenuEntry | undefined => {
    const e = l.find((x) => !("separator" in x) && x.label === path[0]);
    return path.length === 1 || !e || !("submenu" in e) ? e : find(e.submenu, path.slice(1));
  };
  (window as any).__appMenu = {
    model: () => plain((window as any).__appMenuModel ?? []),
    run: (...path: string[]) => {
      const e = find((window as any).__appMenuModel ?? [], path);
      if (!e || !("action" in e) || e.disabled) throw new Error("실행할 수 없는 메뉴: " + path.join(" > "));
      void e.action(); // 작업이 끝나길 기다리지 않는다
    },
  };
}
