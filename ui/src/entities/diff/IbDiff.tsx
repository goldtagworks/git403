import { memo, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { t, useLocale } from "../../shared/i18n/i18n";
import { BigButton } from "../../shared/ui/BigButton";
import { stored, store } from "../../shared/model/ops";
import { api } from "../../shared/api/api";
import { countRender } from "../../shared/lib/profile";
import type { ImageSrc } from "./ImageDiff";
import { diffIb, parseIb, rootSize, type ConChange, type Detail, type IbScene, type SceneDiff, type ViewChange } from "./ibParse";

// 뷰어 / Raw 선택은 저장하고, 쓰는 DiffView들이 같이 따른다 (보기 방식 저장과 같은 패턴)
export type IbMode = "viewer" | "raw";
let mode: IbMode = stored<IbMode>("ibView", "viewer") === "raw" ? "raw" : "viewer";
const subs = new Set<() => void>();
const setMode = (m: IbMode) => {
  mode = m;
  store("ibView", m);
  subs.forEach((f) => f());
};
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
export const useIbMode = () => useSyncExternalStore(subscribe, () => mode);

export const IbToggle = memo(function IbToggle() {
  useLocale();
  const m = useIbMode();
  return (
    <div className="segmented" role="radiogroup" aria-label={t("diff.ibView")}>
      {(["viewer", "raw"] as const).map((x) => (
        <button key={x} role="radio" aria-checked={m === x} onClick={() => setMode(x)}>{x === "viewer" ? t("diff.ibViewer") : t("diff.ibRaw")}</button>
      ))}
    </div>
  );
});

const KIND_KEY = { add: "diff.ibAdd", del: "diff.ibDel", mod: "diff.ibMod", move: "diff.ibMove", rebase: "diff.ibRebase" } as const;
const KIND_CLS = { add: "ok", del: "del", mod: "mod", move: "move", rebase: "move" } as const;

interface Item { key: string; kind: keyof typeof KIND_KEY; title: string; details: string[]; views: string[]; con?: { id: string; attr: string } }

function detail(d: Detail, head = "") {
  const lead = d.k === "frame" ? t("diff.ibFrame") + " " : d.k === "parent" ? t("diff.ibParent") + " " : d.k === "first" ? t("diff.ibFirst") + ": " : d.k === "base" ? `${head} ${t("diff.ibBase")}: ` : `${d.key}: `;
  return `${lead}${d.from} → ${d.to}`;
}
const viewItem = (v: ViewChange): Item => ({
  key: "v:" + v.id, kind: v.kind, views: [v.id],
  title: `${t(v.kind === "add" ? "diff.ibViewAdd" : v.kind === "del" ? "diff.ibViewDel" : v.kind === "mod" ? "diff.ibViewMod" : "diff.ibViewMove")} · ${v.name}`,
  details: v.details.map((d) => detail(d)),
});
const conItem = (c: ConChange, sd: SceneDiff): Item => {
  const s = (c.kind === "del" ? sd.before : sd.after) as IbScene;
  const ids = [c.first, s.constraints.get(c.id)!.second].filter((x): x is string => !!x);
  return {
    key: "c:" + c.id, kind: c.kind, views: ids, con: { id: c.first, attr: c.attr },
    title: `${t(c.kind === "add" ? "diff.ibConAdd" : c.kind === "del" ? "diff.ibConDel" : c.kind === "mod" ? "diff.ibConMod" : "diff.ibConRebase")} · ${c.kind === "add" || c.kind === "del" ? c.text : c.head}`,
    details: c.details.map((d) => detail(d, c.head)),
  };
};

const pct = (v: number) => `${v * 100}%`;
type Rect = { x: number; y: number; w: number; h: number };
const boxStyle = (r: Rect, W: number, H: number) => ({ left: pct(r.x / W), top: pct(r.y / H), width: pct(r.w / W), height: pct(r.h / H) });
/** 제약 기준 아이템의 해당 가장자리 한 줄 */
function edgeStyle(r: Rect, attr: string, W: number, H: number): React.CSSProperties {
  const v = (x: number) => ({ left: pct(x / W), top: pct(r.y / H), height: pct(r.h / H), width: 0, borderLeftWidth: 3 });
  const h = (y: number) => ({ left: pct(r.x / W), top: pct(y / H), width: pct(r.w / W), height: 0, borderTopWidth: 3 });
  if (attr === "leading" || attr === "left" || attr === "leadingMargin") return v(r.x);
  if (attr === "trailing" || attr === "right" || attr === "trailingMargin" || attr === "height") return v(r.x + r.w);
  if (attr === "centerX") return v(r.x + r.w / 2);
  if (attr === "top" || attr === "topMargin") return h(r.y);
  if (attr === "centerY") return h(r.y + r.h / 2);
  return h(r.y + r.h); // bottom, width 등
}

const MAX_BOXES = 3000;
/** 뷰 박스들: 장면·변경 표시가 같으면 다시 그리지 않는다 (강조는 위 겹침층이 따로 그린다) */
const Boxes = memo(function Boxes({ scene, kinds, conOnly, W, H }: { scene: IbScene; kinds: Map<string, Item["kind"]>; conOnly: Set<string>; W: number; H: number }) {
  const out: ReactNode[] = [], chips: ReactNode[] = [];
  for (const v of scene.views.values()) {
    if (!v.abs || v.id === scene.rootId) continue;
    const k = kinds.get(v.id);
    const st = boxStyle(v.abs, W, H);
    out.push(<div key={v.id} data-v={v.id} className={"ib-v" + (k ? " ib-k-" + KIND_CLS[k] : conOnly.has(v.id) ? " ib-conly" : "")} style={st} />);
    // 이름 칩은 변경된 뷰만, 박스 위쪽 바깥에 (폭에 묶이지 않음)
    if (k) chips.push(<span key={v.id} className={"ib-chip ib-k-" + KIND_CLS[k]} style={{ left: st.left, top: st.top }}>{v.name}</span>);
    if (out.length >= MAX_BOXES) break;
  }
  return <><div className="ib-clip">{out}</div><div className="ib-chips">{chips}</div></>;
});

function Canvas({ label, scene, kinds, conOnly, hl }: { label: string; scene: IbScene | null; kinds: Map<string, Item["kind"]>; conOnly: Set<string>; hl: Item | null }) {
  if (!scene) return <div className="ib-col"><span className="img-label">{label}</span><div className="img-none">{t("diff.imgNone")}</div></div>;
  const { w: W, h: H } = rootSize(scene);
  const hv = hl?.views.map((id) => scene.views.get(id)).filter((v) => v?.abs && v.id !== scene.rootId);
  const edge = hl?.con && scene.views.get(hl.con.id)?.abs;
  return (
    <div className="ib-col">
      <span className="img-label">{label}</span>
      <div className="ib-canvas" data-scene={scene.key} style={{ "--ar": W / H } as React.CSSProperties}>
        <Boxes scene={scene} kinds={kinds} conOnly={conOnly} W={W} H={H} />
        <div className="ib-clip">
          {hv?.map((v) => <div key={v!.id} className="ib-hl" style={boxStyle(v!.abs!, W, H)} />)}
          {edge && hl?.con && <div className="ib-edge" style={edgeStyle(edge, hl.con.attr, W, H)} />}
        </div>
        <div className="ib-chips">{hv?.map((v) => { const st = boxStyle(v!.abs!, W, H); return <span key={v!.id} className="ib-chip ib-hot" style={{ left: st.left, top: st.top }}>{v!.name}</span>; })}</div>
      </div>
    </div>
  );
}

const Row = memo(function Row({ item, active }: { item: Item; active: boolean }) {
  return (
    <li role="option" aria-selected={active} data-k={item.key} className={"ib-item" + (active ? " active" : "")}>
      <div className="ib-title"><span className={"ib-tag ib-k-" + KIND_CLS[item.kind]}>{t(KIND_KEY[item.kind])}</span>{item.title}</div>
      {item.details.map((d, i) => <div key={i} className="ib-detail selectable">{d}</div>)}
    </li>
  );
});

/** 한 scene의 요약·범례·이전/이후 캔버스·변경 목록. 호버·선택 상태는 여기만 가진다 (바깥을 다시 그리지 않는다) */
const ScenePane = memo(function ScenePane({ sd }: { sd: SceneDiff }) {
  countRender("IbScenePane");
  const loc = useLocale();
  const [hover, setHover] = useState<string | null>(null);
  const [pin, setPin] = useState<string | null>(null);
  const items = useMemo(() => [...sd.views.map(viewItem), ...sd.cons.map((c) => conItem(c, sd))], [sd, loc]);
  const { bk, ak, conOnly } = useMemo(() => {
    const bk = new Map<string, Item["kind"]>(), ak = new Map<string, Item["kind"]>();
    for (const v of sd.views) (v.kind !== "add" && bk.set(v.id, v.kind), v.kind !== "del" && ak.set(v.id, v.kind));
    const co = new Set<string>();
    for (const c of sd.cons) {
      for (const s of [sd.before?.constraints.get(c.id), sd.after?.constraints.get(c.id)]) {
        for (const id of s ? [s.owner, s.first, s.second] : []) if (id && !bk.has(id) && !ak.has(id)) co.add(id);
      }
    }
    return { bk, ak, conOnly: co };
  }, [sd]);
  const act = hover ?? pin;
  const hl = items.find((i) => i.key === act) ?? null;
  const key = (e: React.MouseEvent) => (e.target as HTMLElement).closest<HTMLElement>("[data-k]")?.dataset.k ?? null;

  return (
    <>
      <div className="ib-summary">{t("diff.ibSummary", { name: sd.name, v: sd.views.length, c: sd.cons.length })}</div>
      <div className="ib-legend" aria-label={t("diff.ibLegend")}>
        {(["add", "del", "mod", "move"] as const).map((k) => <span key={k} className={"ib-k-" + KIND_CLS[k]}><i />{t(KIND_KEY[k])}</span>)}
        <span className="ib-conly"><i />{t("diff.ibCon")}</span>
        <span className="ib-note">{t("diff.ibNote")}</span>
      </div>
      <div className="ib-canvases">
        <Canvas label={t("diff.imgBefore")} scene={sd.before} kinds={bk} conOnly={conOnly} hl={hl} />
        <Canvas label={t("diff.imgAfter")} scene={sd.after} kinds={ak} conOnly={conOnly} hl={hl} />
      </div>
      <div className="files-head"><span>{t("diff.ibList")} {items.length}</span></div>
      <ul className="ib-list" role="listbox" aria-label={t("diff.ibList")} onMouseOver={(e) => setHover(key(e))} onMouseLeave={() => setHover(null)} onClick={(e) => { const k = key(e); setPin((p) => (p === k ? null : k)); }}>
        {items.map((i) => <Row key={i.key} item={i} active={i.key === act} />)}
      </ul>
    </>
  );
});

interface Loaded { key: string; a: string | null; b: string | null; err?: string }
const text = async (repo: string, rev: string | null, path: string) => {
  const b64 = await api.fileBlob(repo, rev, path);
  if (b64 == null) return null;
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

/**
 * xib/storyboard 시각 diff: 이전/이후 파일을 읽어 뷰 트리·제약을 id로 비교하고, 저장된 frame으로 그린 캔버스와 변경 목록을 보인다.
 * 파싱·비교는 useMemo(렌더 밖에서 한 번), 오토레이아웃은 계산하지 않는다.
 */
export const IbDiff = memo(function IbDiff({ image, path, oldPath, head, extra }: { image: ImageSrc; path: string; oldPath?: string; head: ReactNode; extra?: ReactNode }) {
  countRender("IbDiff");
  useLocale();
  const key = `${image.repo}|${image.before}|${image.after}|${path}|${oldPath ?? ""}`;
  const [data, setData] = useState<Loaded | null>(null);
  const [scene, setScene] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([text(image.repo, image.before, oldPath ?? path), text(image.repo, image.after, path)]).then(
      ([a, b]) => live && setData({ key, a, b }),
      (e) => live && setData({ key, a: null, b: null, err: String(e instanceof Error ? e.message : e).replace(/^Error: /, "") }),
    );
    return () => void (live = false);
  }, [key, image.v]);
  const d = data?.key === key ? data : null;
  const res = useMemo(() => {
    if (!d || d.err) return null;
    try {
      return { scenes: diffIb(d.a ? parseIb(d.a) : [], d.b ? parseIb(d.b) : []) };
    } catch {
      return { scenes: [] as SceneDiff[], broken: true };
    }
  }, [d]);
  const sd = res?.scenes.find((s) => s.key === scene) ?? res?.scenes[0];

  return (
    <div className="diff ib-diff">
      <div className="diff-file">
        {head}
        {extra}
        <BigButton />
      </div>
      {d?.err ? <div className="meta bin">{d.err}</div> : res && (
        res.broken ? <div className="meta bin">{t("diff.ibBroken")}</div>
        : !sd ? <div className="meta bin">{t("diff.ibNoChange")}</div>
        : (
          <div className="ib-body">
            {res.scenes.length > 1 && (
              <label className="ib-scene">
                {t("diff.ibScene")}
                <select value={sd.key} aria-label={t("diff.ibScene")} onChange={(e) => setScene(e.target.value)}>
                  {res.scenes.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
                </select>
              </label>
            )}
            <ScenePane key={sd.key} sd={sd} />
          </div>
        )
      )}
    </div>
  );
});
