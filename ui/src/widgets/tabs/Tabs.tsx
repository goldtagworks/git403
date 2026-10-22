import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../../shared/ui/Icon";
import { t as tr, useLocale } from "../../shared/i18n/i18n";
import { showMenu, type MenuEntry } from "../../shared/ui/menu";
import { ops } from "../../shared/model/ops";
import { countRender } from "../../shared/lib/profile";
import { isMac } from "../../shared/lib/platform";

const base = (p: string) => p.split(/[\\/]/).pop() || p;
const dir = (p: string) => p.slice(0, Math.max(0, p.length - base(p).length)).replace(/[\\/]+$/, "");
const KEYS = isMac ? "⌘⌥←/→" : "Ctrl+Alt+←/→";

/** 열린 저장소 탭. 끝의 메뉴로 작업공간(탭 묶음) 저장·전환. */
export const Tabs = memo(function Tabs({ tabs, active, onOpen, onClose }: {
  tabs: string[];
  active: string;
  onOpen: (path: string) => void;
  onClose: (path: string) => void;
}) {
  countRender("Tabs");
  useLocale();
  const root = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const allBtn = useRef<HTMLButtonElement>(null);
  const [over, setOver] = useState(false); // 최소 폭으로도 안 들어가 스크롤되는 중 (바뀔 때만 setState)
  const overRef = useRef(false);
  const btnW = useRef(0);

  /** 양끝 페이드: 숨은 탭이 있는 쪽만 켠다. 스크롤마다 불리므로 DOM 속성만 만진다(React 상태 아님) */
  const fades = useCallback(() => {
    const el = scroll.current, v = view.current;
    if (!el || !v) return;
    const l = el.scrollLeft > 1, r = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    if (v.hasAttribute("data-l") !== l) v.toggleAttribute("data-l", l);
    if (v.hasAttribute("data-r") !== r) v.toggleAttribute("data-r", r);
  }, []);

  /** 넘침 판단. "탭 n개" 버튼이 폭을 차지해도 판정이 흔들리지 않게 버튼이 보일 땐 그 폭만큼 더해서 비교한다 */
  const measure = useCallback(() => {
    const el = scroll.current, first = el?.firstElementChild;
    if (!el || !root.current) return;
    if (allBtn.current) btnW.current = allBtn.current.offsetWidth + (parseFloat(getComputedStyle(root.current).columnGap) || 0);
    const n = el.childElementCount;
    const cs = first ? getComputedStyle(first) : null;
    const need = cs ? n * (parseFloat(cs.minWidth) || 0) + (n - 1) * (parseFloat(getComputedStyle(el).columnGap) || 0) : 0;
    const o = n > 0 && need > el.clientWidth + (overRef.current ? btnW.current : 0) + 0.5;
    if (o !== overRef.current) setOver((overRef.current = o));
    fades();
  }, [fades]);

  // 넘침 감지는 ResizeObserver로만(창·탭 폭·탭 개수 변화). 마우스 휠의 세로 스크롤은 가로로 바꾼다
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const c of el.children) ro.observe(c);
    const wheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("scroll", fades, { passive: true });
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", fades);
      el.removeEventListener("wheel", wheel);
    };
  }, [tabs, measure, fades]);

  // 활성 탭(열기·전환·⌘⌥←/→)이 항상 보이게. smooth 없이 바로
  useLayoutEffect(() => {
    const el = scroll.current && ([...scroll.current.children] as HTMLElement[]).find((c) => c.dataset.path === active);
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
    fades();
  }, [active, tabs.length, over, fades]);

  const workspaceMenu = (): MenuEntry[] => {
    const names = ops.workspaceNames();
    return [
      { label: tr("tabs.saveWs"), action: ops.saveWorkspace, disabled: !tabs.length },
      ...(names.length ? [{ separator: true } as const] : []),
      ...names.map((n) => ({ label: tr("tabs.ws", { name: n }), action: () => ops.openWorkspace(n) })),
      ...(names.length ? [{ label: tr("tabs.wsDelete"), submenu: names.map((n) => ({ label: tr("tabs.wsDeleteOne", { name: n }), action: () => ops.deleteWorkspace(n) })) }] : []),
    ];
  };

  const allMenu = () =>
    showMenu(tabs.map((p) => ({ label: dir(p) ? `${base(p)} — ${dir(p)}` : base(p), checked: p === active, action: () => p !== active && onOpen(p) })));

  return (
    <div ref={root} className="tabs" role="tablist" aria-label={tr("tabs.open")}>
      <div ref={view} className="tabs-view">
        <div ref={scroll} className="tabs-scroll">
          {tabs.map((t) => (
            <div key={t} data-path={t} className={"tab" + (t === active ? " active" : "")} title={t}>
              <button role="tab" aria-selected={t === active} onClick={() => t !== active && onOpen(t)}>
                {base(t)}
              </button>
              <button className="tab-close" title={tr("tabs.close", { name: base(t) })} aria-label={tr("tabs.close", { name: base(t) })} onClick={() => onClose(t)}>
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>
      {over && (
        <button ref={allBtn} className="tab-menu" title={tr("tabs.listTip", { n: tabs.length, keys: KEYS })} aria-label={tr("tabs.list", { n: tabs.length })} onClick={allMenu}>
          {tr("tabs.list", { n: tabs.length })}<Icon name="dropdown" size={11} />
        </button>
      )}
      <button className="tab-menu" aria-label={tr("tabs.wsLabel")} onClick={() => showMenu(workspaceMenu())}>
        {tr("tabs.wsLabel")}<Icon name="dropdown" size={11} />
      </button>
    </div>
  );
});
