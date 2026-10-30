import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { IS_VSCODE } from "../api/bridge";
import { visible } from "../lib/caps";

/** OS가 동작을 아는 기본 메뉴 항목 (앱 메뉴 막대 전용: 복사·붙여넣기·숨기기·종료·최소화 등) */
export type Predefined = "Undo" | "Redo" | "Cut" | "Copy" | "Paste" | "SelectAll" | "About" | "Services" | "Hide" | "HideOthers" | "ShowAll" | "Quit" | "Minimize" | "Maximize" | "Fullscreen";

export type MenuEntry =
  /** hint = 오른쪽 muted 짧은 상태(네이티브 메뉴는 "라벨 — 힌트"), title = DOM 메뉴 툴팁,
   *  op = 이 항목이 쓰는 git 서브커맨드(코어 IPC를 부르면 그 메서드 이름). 백엔드가 지원하지 않으면 메뉴에서 빠진다 (shared/lib/caps.ts) */
  | { label: string; action: () => void; disabled?: boolean; checked?: boolean; accelerator?: string; hint?: string; title?: string; op?: string | string[] }
  | { separator: true }
  /** role = macOS 메뉴 막대에서 OS가 창 목록·도움말 검색을 붙이는 메뉴 */
  | { label: string; submenu: MenuEntry[]; disabled?: boolean; role?: "window" | "help"; op?: string | string[] }
  | { label: string; predefined: Predefined };

/** 앱 메뉴 막대를 만들 때 macOS 전용 역할 메뉴를 모아 둔다 */
export interface Roles { window?: import("@tauri-apps/api/menu").Submenu; help?: import("@tauri-apps/api/menu").Submenu }

/** MenuEntry → OS 네이티브 메뉴 항목 (우클릭·드롭다운·메뉴 막대 공용) */
export async function nativeItems(list: MenuEntry[], roles: Roles = {}): Promise<any[]> {
  const { MenuItem, CheckMenuItem, PredefinedMenuItem, Submenu } = await import("@tauri-apps/api/menu");
  const build = async (l: MenuEntry[]): Promise<any[]> =>
    Promise.all(
      l.map(async (e) => {
        if ("separator" in e) return PredefinedMenuItem.new({ item: "Separator" });
        if ("predefined" in e) return PredefinedMenuItem.new({ text: e.label, item: e.predefined === "About" ? { About: null } : e.predefined });
        if ("submenu" in e) {
          const sub = await Submenu.new({ text: e.label, enabled: !e.disabled, items: await build(e.submenu) });
          if (e.role) roles[e.role] = sub;
          return sub;
        }
        // Tauri는 action(메뉴 id)로 부른다 → 인자 없이 감싼다 (`open(path?)`이 id를 경로로 받지 않게)
        const opts = { text: e.hint ? `${e.label} — ${e.hint}` : e.label, enabled: !e.disabled, accelerator: e.accelerator, action: () => void e.action() };
        return e.checked === undefined ? MenuItem.new(opts) : CheckMenuItem.new({ ...opts, checked: e.checked });
      }),
    );
  return build(list); // 미지원 항목 거르기는 호출 측(showMenu·appMenu.apply)이 한 번 한다
}

/**
 * 드롭다운·우클릭 메뉴. 앱에서는 OS 네이티브 메뉴(docs/design.md),
 * 브라우저 데모·E2E·VS Code 웹뷰에서는 같은 항목을 DOM 메뉴로 그린다.
 */
export async function showMenu(items: MenuEntry[], at?: { x: number; y: number }) {
  items = visible(items);
  if (import.meta.env.VITE_MOCK || IS_VSCODE) return domMenu.open(items, at ?? lastPointer);
  const { Menu } = await import("@tauri-apps/api/menu");
  const menu = await Menu.new({ items: await nativeItems(items) });
  await menu.popup();
}

/** 이벤트 위치에 메뉴를 띄우는 헬퍼: onContextMenu={contextMenu(() => [...])} */
export const contextMenu = (items: () => MenuEntry[]) => (e: React.MouseEvent) => {
  e.preventDefault();
  e.stopPropagation();
  showMenu(items(), { x: e.clientX, y: e.clientY });
};

// ---- 데모·E2E용 DOM 메뉴 ----
let lastPointer = { x: 0, y: 0 };
window.addEventListener("pointerdown", (e) => (lastPointer = { x: e.clientX, y: e.clientY }), true);

const domMenu = {
  listener: null as null | ((s: { items: MenuEntry[]; at: { x: number; y: number } } | null) => void),
  open(items: MenuEntry[], at: { x: number; y: number }) {
    this.listener?.({ items, at });
  },
};

export function DomMenuHost() {
  const [state, setState] = useState<{ items: MenuEntry[]; at: { x: number; y: number } } | null>(null);
  useEffect(() => {
    domMenu.listener = setState;
    const close = () => setState(null);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  const box = useRef<HTMLDivElement>(null);
  // 화면을 넘으면 위로 당기고, 그래도 넘치면 스크롤
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !state) return;
    const max = window.innerHeight - 16;
    el.style.maxHeight = `${max}px`;
    el.style.overflowY = "auto";
    const h = Math.min(el.offsetHeight, max);
    el.style.top = `${Math.max(8, Math.min(state.at.y, window.innerHeight - 8 - h))}px`;
    el.style.left = `${Math.max(8, Math.min(state.at.x, window.innerWidth - 8 - el.offsetWidth))}px`;
  }, [state]);
  if (!state) return null;
  // 하위 메뉴는 제목 줄 + 항목으로 펼친다 (DOM 메뉴는 한 겹)
  const flat = (list: MenuEntry[]): (MenuEntry | { group: string })[] => list.flatMap((e) => ("submenu" in e ? [{ group: e.label }, ...e.submenu] : [e]));
  return (
    <div className="dom-menu-backdrop" onMouseDown={() => setState(null)}>
      <div ref={box} role="menu" className="dom-menu" style={{ left: state.at.x, top: state.at.y }} onMouseDown={(e) => e.stopPropagation()}>
        {flat(state.items).map((e, i) =>
          "separator" in e ? (
            <hr key={i} />
          ) : "group" in e ? (
            <div key={i} className="menu-group">{e.group}</div>
          ) : "action" in e ? (
            <button
              key={i}
              role="menuitem"
              disabled={e.disabled}
              title={e.title}
              onClick={() => {
                setState(null);
                e.action();
              }}
            >
              <span className="menu-label">{e.checked !== undefined && (e.checked ? "✓ " : "   ")}{e.label}</span>
              {e.hint && <span className="menu-hint">{e.hint}</span>}
            </button>
          ) : null,
        )}
      </div>
    </div>
  );
}
