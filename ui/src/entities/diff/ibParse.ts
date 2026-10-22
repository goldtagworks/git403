// Interface Builder(.xib/.storyboard) 시각 diff용 순수 로직 (React 비의존). DOMParser로 XML을 읽는다.
// 한계: 오토레이아웃을 계산하지 않는다. xib에 저장된 frame만 쓴다.

export const isIbPath = (p: string) => /\.(xib|storyboard)$/i.test(p);

export interface Frame { x: number; y: number; w: number; h: number }
export interface IbView {
  id: string;
  tag: string;
  name: string;
  parent: string | null;
  /** 부모 기준 frame (없으면 null) */
  frame: Frame | null;
  /** 루트 기준 절대 frame (frame이 없으면 null) */
  abs: Frame | null;
  props: Record<string, string>;
}
export interface IbConstraint {
  id: string;
  owner: string;
  first: string;
  firstAttr: string;
  second: string | null;
  secondAttr: string | null;
  constant: string;
  multiplier: string;
  relation: string;
  priority: string;
}
export interface IbScene {
  key: string;
  name: string;
  rootId: string;
  /** 문서 순서(부모가 먼저) */
  views: Map<string, IbView>;
  constraints: Map<string, IbConstraint>;
  /** 뷰·레이아웃 가이드 id → 이름 */
  names: Map<string, string>;
}

const PROP_ATTRS = ["customClass", "userLabel", "text", "image", "hidden", "alpha", "contentMode", "placeholder", "clipsSubviews", "userInteractionEnabled", "textAlignment", "numberOfLines", "lineBreakMode"];
const COLOR_KEYS = ["textColor", "backgroundColor", "tintColor"];
const num = (v: string | null) => (v == null || v === "" || isNaN(+v) ? 0 : +v);
const hex = (v: string | null) => Math.round(num(v) * 255).toString(16).padStart(2, "0");

function colorText(c: Element) {
  const alpha = c.getAttribute("alpha");
  const a = alpha && +alpha !== 1 ? ` α${alpha}` : "";
  const name = c.getAttribute("name") ?? c.getAttribute("cocoaTouchSystemColor");
  if (name) return name + a;
  if (c.hasAttribute("white")) return `white ${c.getAttribute("white")}${a}`;
  if (c.hasAttribute("red")) return `#${hex(c.getAttribute("red"))}${hex(c.getAttribute("green"))}${hex(c.getAttribute("blue"))}${a}`;
  return "?";
}

function propsOf(el: Element) {
  const p: Record<string, string> = {};
  for (const k of PROP_ATTRS) if (el.hasAttribute(k)) p[k] = el.getAttribute(k)!;
  for (const c of Array.from(el.children)) {
    const key = c.getAttribute("key") ?? "";
    if (c.tagName === "fontDescription") p.fontDescription = `${c.getAttribute("name") ?? c.getAttribute("type") ?? c.getAttribute("family") ?? ""} ${c.getAttribute("pointSize") ?? ""}`.trim();
    else if (c.tagName === "color" && COLOR_KEYS.includes(key)) p[key] = colorText(c);
    else if (c.tagName === "string" && key === "text") p.text = c.textContent ?? "";
    else if (c.tagName === "state" && key === "normal" && c.hasAttribute("title")) p.title = c.getAttribute("title")!;
  }
  return p;
}

function frameOf(el: Element): Frame | null {
  const r = Array.from(el.children).find((c) => c.tagName === "rect" && c.getAttribute("key") === "frame");
  return r ? { x: num(r.getAttribute("x")), y: num(r.getAttribute("y")), w: num(r.getAttribute("width")), h: num(r.getAttribute("height")) } : null;
}

function parseScene(key: string, name: string, rootEl: Element, outlets: Map<string, string>): IbScene {
  const views = new Map<string, IbView>();
  const constraints = new Map<string, IbConstraint>();
  const names = new Map<string, string>();
  // origin: 가장 가까운 frame 있는 조상의 절대 좌표(스크롤뷰면 contentOffset을 뺀 값). frame 없는 부모는 그대로 이어받는다
  const walk = (el: Element, parent: IbView | null, origin: { x: number; y: number }) => {
    const id = el.getAttribute("id") ?? `${parent?.id ?? "root"}/${views.size}`;
    const frame = frameOf(el);
    const abs = frame && (parent ? { x: origin.x + frame.x, y: origin.y + frame.y, w: frame.w, h: frame.h } : { ...frame, x: 0, y: 0 });
    const off = Array.from(el.children).find((c) => c.tagName === "point" && c.getAttribute("key") === "contentOffset");
    const next = abs ? { x: abs.x - num(off?.getAttribute("x") ?? null), y: abs.y - num(off?.getAttribute("y") ?? null) } : origin;
    const label = outlets.get(id) ?? el.getAttribute("userLabel") ?? el.getAttribute("customClass") ?? el.tagName;
    const v: IbView = { id, tag: el.tagName, name: label, parent: parent?.id ?? null, frame, abs, props: propsOf(el) };
    views.set(id, v);
    names.set(id, label);
    for (const c of Array.from(el.children)) {
      const ck = c.getAttribute("key");
      // 하위 뷰: subviews, 프로토타입 셀(tableView), cells(collectionView), key="contentView" 뷰
      if (c.tagName === "subviews" || c.tagName === "prototypes" || c.tagName === "cells") for (const s of Array.from(c.children)) walk(s, v, next);
      else if (ck === "contentView" && c.hasAttribute("id")) walk(c, v, next);
      else if (c.tagName === "viewLayoutGuide" && c.hasAttribute("id")) names.set(c.getAttribute("id")!, `${label}.${ck ?? "guide"}`);
      else if (c.tagName === "constraints") {
        for (const k of Array.from(c.children)) {
          const g = (a: string) => k.getAttribute(a);
          const cid = g("id") ?? `${id}:${g("firstItem")}.${g("firstAttribute")}-${g("secondItem")}.${g("secondAttribute")}`;
          constraints.set(cid, {
            id: cid, owner: id, first: g("firstItem") ?? id, firstAttr: g("firstAttribute") ?? "", second: g("secondItem"), secondAttr: g("secondAttribute"),
            constant: g("constant") ?? "0", multiplier: g("multiplier") ?? "1", relation: g("relation") ?? "equal", priority: g("priority") ?? "1000",
          });
        }
      }
    }
  };
  walk(rootEl, null, { x: 0, y: 0 });
  return { key, name, rootId: rootEl.getAttribute("id") ?? "root", views, constraints, names };
}

/** 문서의 scene 목록. storyboard는 scene마다, xib는 최상위 뷰마다 하나. 읽을 수 없으면 던진다 */
export function parseIb(xml: string): IbScene[] {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("xml");
  const outletsOf = (root: Element | Document) => {
    const m = new Map<string, string>();
    for (const o of Array.from(root.getElementsByTagName("outlet"))) {
      const d = o.getAttribute("destination"), p = o.getAttribute("property");
      if (d && p && !m.has(d)) m.set(d, p);
    }
    return m;
  };
  const out: IbScene[] = [];
  const scenes = Array.from(doc.getElementsByTagName("scene"));
  if (scenes.length) {
    for (const sc of scenes) {
      const objects = Array.from(sc.children).find((c) => c.tagName === "objects");
      const ctrl = objects && Array.from(objects.children).find((c) => c.tagName !== "placeholder" && Array.from(c.children).some((k) => k.getAttribute("key") === "view"));
      const root = ctrl && Array.from(ctrl.children).find((k) => k.getAttribute("key") === "view");
      if (!ctrl || !root) continue;
      const name = ctrl.getAttribute("customClass") ?? ctrl.getAttribute("userLabel") ?? ctrl.getAttribute("storyboardIdentifier") ?? ctrl.tagName;
      out.push(parseScene(sc.getAttribute("sceneID") ?? ctrl.getAttribute("id") ?? name, name, root, outletsOf(sc)));
    }
  } else {
    const objects = Array.from(doc.documentElement.children).find((c) => c.tagName === "objects");
    const outlets = outletsOf(doc);
    for (const c of Array.from(objects?.children ?? [])) {
      if (c.tagName === "placeholder" || !c.hasAttribute("id") || !frameOf(c)) continue;
      out.push(parseScene(c.getAttribute("id")!, c.getAttribute("customClass") ?? c.getAttribute("userLabel") ?? c.tagName, c, outlets));
    }
  }
  return out;
}

// ---- 비교

export type ViewKind = "add" | "del" | "mod" | "move";
export type ConKind = "add" | "del" | "mod" | "rebase";
/** 세부 한 줄: 문구는 UI가 번역한다 */
export interface Detail { k: "frame" | "parent" | "prop" | "first" | "base"; key?: string; from: string; to: string }
export interface ViewChange { kind: ViewKind; id: string; name: string; details: Detail[] }
export interface ConChange { kind: ConKind; id: string; /** 기준(첫 항목) 뷰 id */ first: string; attr: string; details: Detail[]; text: string; head: string }
export interface SceneDiff { key: string; name: string; before: IbScene | null; after: IbScene | null; views: ViewChange[]; cons: ConChange[] }

export const fmtFrame = (f: Frame | null) => (f ? `(${f.x}, ${f.y}) ${f.w}×${f.h}` : "-");
const REL: Record<string, string> = { equal: "=", lessThanOrEqual: "≤", greaterThanOrEqual: "≥" };
const ref = (s: IbScene, id: string | null, attr: string | null) => (id ? `${s.names.get(id) ?? id}${attr ? "." + attr : ""}` : "-");
const head = (s: IbScene, c: IbConstraint) => ref(s, c.first, c.firstAttr);
/** 제약 한 줄: `a.leading = b.leading × 2 + 8 @750` */
export function conText(s: IbScene, c: IbConstraint) {
  const rhs = c.second ? ref(s, c.second, c.secondAttr) + (+c.multiplier !== 1 ? ` × ${c.multiplier}` : "") + (+c.constant ? ` ${+c.constant < 0 ? "−" : "+"} ${Math.abs(+c.constant)}` : "") : c.constant;
  return `${head(s, c)} ${REL[c.relation] ?? c.relation} ${rhs}${c.priority !== "1000" ? ` @${c.priority}` : ""}`;
}

function diffScene(b: IbScene | null, a: IbScene | null): SceneDiff {
  const views: ViewChange[] = [], cons: ConChange[] = [];
  const bv = b?.views ?? new Map<string, IbView>(), av = a?.views ?? new Map<string, IbView>();
  for (const [id, v] of av) {
    const o = bv.get(id);
    if (!o) { views.push({ kind: "add", id, name: v.name, details: [] }); continue; }
    const details: Detail[] = [];
    let moved = false;
    const same = (p: Frame | null, q: Frame | null) => (p && q ? p.x === q.x && p.y === q.y && p.w === q.w && p.h === q.h : p === q);
    if (!same(o.frame, v.frame)) (moved = true, details.push({ k: "frame", from: fmtFrame(o.frame), to: fmtFrame(v.frame) }));
    if (o.parent !== v.parent) (moved = true, details.push({ k: "parent", from: o.parent ? (b!.names.get(o.parent) ?? o.parent) : "-", to: v.parent ? (a!.names.get(v.parent) ?? v.parent) : "-" }));
    let prop = false;
    for (const k of new Set([...Object.keys(o.props), ...Object.keys(v.props)])) {
      if (o.props[k] !== v.props[k]) (prop = true, details.push({ k: "prop", key: k, from: o.props[k] ?? "-", to: v.props[k] ?? "-" }));
    }
    if (prop || moved) views.push({ kind: prop ? "mod" : "move", id, name: v.name, details });
  }
  for (const [id, v] of bv) if (!av.has(id)) views.push({ kind: "del", id, name: v.name, details: [] });

  const bc = b?.constraints ?? new Map<string, IbConstraint>(), ac = a?.constraints ?? new Map<string, IbConstraint>();
  for (const [id, c] of ac) {
    const o = bc.get(id);
    if (!o) { cons.push({ kind: "add", id, first: c.first, attr: c.firstAttr, details: [], text: conText(a!, c), head: head(a!, c) }); continue; }
    const details: Detail[] = [];
    let rebase = false;
    const f0 = ref(b!, o.first, o.firstAttr), f1 = ref(a!, c.first, c.firstAttr);
    if (f0 !== f1) (rebase = true, details.push({ k: "first", from: f0, to: f1 }));
    const s0 = ref(b!, o.second, o.secondAttr), s1 = ref(a!, c.second, c.secondAttr);
    if (s0 !== s1) (rebase = true, details.push({ k: "base", from: s0, to: s1 }));
    let mod = false;
    for (const k of ["constant", "multiplier", "relation", "priority"] as const) if (o[k] !== c[k]) (mod = true, details.push({ k: "prop", key: k, from: o[k], to: c[k] }));
    if (rebase || mod) cons.push({ kind: rebase ? "rebase" : "mod", id, first: c.first, attr: c.firstAttr, details, text: conText(a!, c), head: head(a!, c) });
  }
  for (const [id, c] of bc) if (!ac.has(id)) cons.push({ kind: "del", id, first: c.first, attr: c.firstAttr, details: [], text: conText(b!, c), head: head(b!, c) });
  return { key: (a ?? b)!.key, name: (a ?? b)!.name, before: b, after: a, views, cons };
}

/** 이전·이후 문서 → 변경이 있는 scene들 (id 기준 매칭) */
export function diffIb(before: IbScene[], after: IbScene[]): SceneDiff[] {
  const bm = new Map(before.map((s) => [s.key, s]));
  const am = new Map(after.map((s) => [s.key, s]));
  const keys = [...am.keys(), ...[...bm.keys()].filter((k) => !am.has(k))];
  return keys.map((k) => diffScene(bm.get(k) ?? null, am.get(k) ?? null)).filter((d) => d.views.length || d.cons.length);
}

/** 루트 크기: 루트 frame, 없으면 자식 frame 합집합, 그래도 없으면 기본 */
export function rootSize(s: IbScene): { w: number; h: number } {
  const r = s.views.get(s.rootId)?.frame;
  if (r && r.w > 0 && r.h > 0) return { w: r.w, h: r.h };
  let w = 0, h = 0;
  for (const v of s.views.values()) if (v.abs) (w = Math.max(w, v.abs.x + v.abs.w), h = Math.max(h, v.abs.y + v.abs.h));
  return w && h ? { w, h } : { w: 320, h: 480 };
}
