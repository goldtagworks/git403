import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { t, useLocale } from "../../shared/i18n/i18n";
import { BigButton } from "../../shared/ui/BigButton";
import { stored, store } from "../../shared/model/ops";
import { api } from "../../shared/api/api";
import { countRender } from "../../shared/lib/profile";
import { base64Bytes, compare, fitScale, fmtKb, fmtPct, mimeOf, sampleSize, scaleBox, type Box, type Compare } from "./imagePixels";

/** 이미지 diff가 읽을 양쪽 (rev: 커밋·`<sha>^`·":"(인덱스)·null(작업 트리)). 호출 쪽이 useMemo로 참조를 안정적으로 넘긴다. `v`가 바뀌면 다시 읽는다 */
export interface ImageSrc { repo: string; before: string | null; after: string | null; v?: unknown }

type ViewMode = "side" | "slide" | "fade" | "diff";
const MODES: ViewMode[] = ["side", "slide", "fade", "diff"];
const LABEL = { side: "diff.imgSide", slide: "diff.imgSlide", fade: "diff.imgFade", diff: "diff.imgDiff" } as const;

// 마지막 비교 방식은 저장한다 (DiffView의 보기 방식과 같은 패턴)
let mode: ViewMode = ((m) => (MODES.includes(m) ? m : "side"))(stored<ViewMode>("imgDiffMode", "side"));
const subs = new Set<() => void>();
const setMode = (m: ViewMode) => {
  mode = m;
  store("imgDiffMode", m);
  subs.forEach((f) => f());
};
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));

interface Side { url: string; w: number; h: number; bytes: number; el: HTMLImageElement }
interface Loaded { key: string; a: Side | null; b: Side | null; cmp: Compare | null; err?: string }
const revoke = (...s: (Side | null)[]) => s.forEach((x) => x && URL.revokeObjectURL(x.url));

async function loadSide(repo: string, rev: string | null, path: string): Promise<Side | null> {
  const b64 = await api.fileBlob(repo, rev, path);
  if (b64 == null) return null;
  // data URL 대신 Blob URL: 큰 문자열을 DOM·이미지 캐시에 따로 쥐지 않는다 (해제는 revoke)
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeOf(path) }));
  const el = new Image();
  el.src = url;
  try {
    await el.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error(t("diff.imgBroken"));
  }
  return { url, w: el.naturalWidth || 300, h: el.naturalHeight || 150, bytes: base64Bytes(b64), el };
}

function pixels(s: Side, w: number, h: number) {
  const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = c.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = w === s.w; // 축소할 때만 보간
  ctx.drawImage(s.el, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h).data;
}

/** 큰 이미지는 축소해 비교하고 박스를 원본 좌표로 환산한다 */
function compareSides(a: Side, b: Side): Compare {
  const m = sampleSize(a.w, a.h);
  const c = compare(pixels(a, m.w, m.h), pixels(b, m.w, m.h), m.w, m.h);
  return m.approx ? { ...c, approx: true, box: c.box && scaleBox(c.box, m.w, m.h, a.w, a.h) } : c;
}

/** 바뀐 픽셀 마스크를 PNG Blob URL로 (CSS mask로 테마색을 입히고 크기는 CSS가 맞춘다) */
function maskUrl(c: Compare): Promise<string> {
  const cv = Object.assign(document.createElement("canvas"), { width: c.mw, height: c.mh });
  cv.getContext("2d")!.putImageData(new ImageData(c.mask, c.mw, c.mh), 0, 0);
  return new Promise((r, j) => cv.toBlob((b) => (b ? r(URL.createObjectURL(b)) : j(new Error("mask"))), "image/png"));
}

const pct = (v: number) => `${v * 100}%`;
const BoxOverlay = ({ box, W, H }: { box: Box; W: number; H: number }) => (
  <div className="img-box" style={{ left: pct(box.x / W), top: pct(box.y / H), width: pct(box.w / W), height: pct(box.h / H) }} />
);
const Layer = ({ s, W, H, pix, style }: { s: Side; W: number; H: number; pix: boolean; style?: React.CSSProperties }) => (
  <img className={"img-layer" + (pix ? " pix" : "")} src={s.url} alt="" draggable={false} style={{ width: pct(s.w / W), height: pct(s.h / H), ...style }} />
);

/** 슬라이더 경계 핸들: 드래그 중에는 CSS 변수만 고친다 (React 상태 없음) */
function dragHandle(e: React.PointerEvent<HTMLDivElement>) {
  const frame = e.currentTarget.closest<HTMLElement>(".img-frame")!;
  const set = (x: number) => {
    const r = frame.getBoundingClientRect();
    frame.style.setProperty("--p", `${Math.min(100, Math.max(0, ((x - r.left) / r.width) * 100))}%`);
  };
  e.currentTarget.setPointerCapture(e.pointerId);
  set(e.clientX);
  const move = (m: PointerEvent) => set(m.clientX);
  const up = () => (window.removeEventListener("pointermove", move), window.removeEventListener("pointerup", up));
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function Stage({ a, b, cmp, view }: { a: Side | null; b: Side | null; cmp: Compare | null; view: ViewMode }) {
  const [area, setArea] = useState({ w: 0, h: 0 });
  const ro = useRef<ResizeObserver>();
  const ref = useCallback((el: HTMLElement | null) => {
    ro.current?.disconnect();
    if (!el) return;
    ro.current = new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width), h = Math.round(e.contentRect.height);
      setArea((p) => (p.w === w && p.h === h ? p : { w, h }));
    });
    ro.current.observe(el);
  }, []);
  const box = cmp ? cmp.box : null;
  const same = a && b && a.w === b.w && a.h === b.h;
  // 차이 모드의 마스크 (Blob URL, 바뀌거나 사라질 때 해제)
  const [mask, setMask] = useState<string | null>(null);
  useEffect(() => {
    if (view !== "diff" || !same || !cmp?.changed) return setMask(null);
    let live = true, url = "";
    maskUrl(cmp).then((u) => (live ? setMask((url = u)) : URL.revokeObjectURL(u)), () => {});
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
      setMask(null);
    };
  }, [view, cmp, same]);
  const W = Math.max(a?.w ?? 0, b?.w ?? 0), H = Math.max(a?.h ?? 0, b?.h ?? 0);
  // 한쪽만 있으면 나란히(없음 표시)로 보여 준다
  const v = a && b ? view : "side";
  const side = v === "side";
  const aw = side ? (area.w - 8) / 2 : area.w, ah = area.h - (side ? 22 : v === "fade" ? 30 : 0);
  const s = area.w > 0 && ah > 0 ? fitScale(W, H, aw, ah) : 0;
  const frame = (children: ReactNode, extra?: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...extra} className={"img-frame" + (extra?.className ? " " + extra.className : "")} style={{ width: Math.max(1, Math.round(W * s)), height: Math.max(1, Math.round(H * s)) }}>
      {children}
    </div>
  );
  const pix = s > 1;
  const pane = (label: string, x: Side | null) => (
    <div className="img-pane">
      <span className="img-label">{label}</span>
      {x ? frame(<><Layer s={x} W={W} H={H} pix={pix} />{box && <BoxOverlay box={box} W={W} H={H} />}</>) : <div className="img-none">{t("diff.imgNone")}</div>}
    </div>
  );

  return (
    <div className="img-stage" ref={ref}>
      {s > 0 && (
        side ? <div className="img-pair">{pane(t("diff.imgBefore"), a)}{pane(t("diff.imgAfter"), b)}</div>
        : v === "slide" ? frame(
            <>
              <Layer s={b!} W={W} H={H} pix={pix} />
              <Layer s={a!} W={W} H={H} pix={pix} style={{ clipPath: "inset(0 calc(100% - var(--p, 50%)) 0 0)" }} />
              {box && <BoxOverlay box={box} W={W} H={H} />}
              <div className="img-handle" role="separator" aria-orientation="vertical" aria-label={t("diff.imgHandle")} onPointerDown={dragHandle} />
            </>,
          )
        : v === "fade" ? (
            <div className="img-col">
              {frame(
                <>
                  <Layer s={a!} W={W} H={H} pix={pix} />
                  <Layer s={b!} W={W} H={H} pix={pix} style={{ opacity: "var(--o, 0.5)" }} />
                  {box && <BoxOverlay box={box} W={W} H={H} />}
                </>,
              )}
              <label className="img-opacity">
                {t("diff.imgBefore")}
                <input type="range" min={0} max={100} defaultValue={50} aria-label={t("diff.imgOpacity")} onInput={(e) => e.currentTarget.closest<HTMLElement>(".img-col")!.style.setProperty("--o", String(+e.currentTarget.value / 100))} />
                {t("diff.imgAfter")}
              </label>
            </div>
          )
        : same
          ? frame(
              <>
                <Layer s={b!} W={W} H={H} pix={pix} style={{ opacity: 0.25 }} />
                {mask && <div className="img-mask" style={{ maskImage: `url(${mask})`, WebkitMaskImage: `url(${mask})` }} />}
                {box && <BoxOverlay box={box} W={W} H={H} />}
              </>,
            )
          : <div className="meta bin">{t("diff.imgNoDiff")}</div>)}
    </div>
  );
}

const Info = ({ a, b, cmp }: { a: Side | null; b: Side | null; cmp: Compare | null }) => {
  const dims = (label: string, s: Side | null) => s && <span>{label} {t("diff.imgDims", { w: s.w, h: s.h, size: fmtKb(s.bytes) })}</span>;
  return (
    <div className="img-info">
      {dims(t("diff.imgBefore"), a)}
      {dims(t("diff.imgAfter"), b)}
      {a && b && (a.w !== b.w || a.h !== b.h) ? <span>{t("diff.imgResized")}</span>
        : cmp && (cmp.changed ? (
            <>
              <span>{t("diff.imgChanged", { pct: (cmp.approx ? "≈" : "") + fmtPct(cmp.changed, cmp.total) })}</span>
              <span>{(cmp.approx ? "≈" : "") + t("diff.imgRegion", { x: cmp.box!.x, y: cmp.box!.y, w: cmp.box!.w, h: cmp.box!.h })}</span>
            </>
          ) : <span>{t("diff.imgSame")}</span>)}
    </div>
  );
};

/**
 * 이미지 diff: 나란히·슬라이더·겹쳐 보기·차이 네 가지 비교, 머리줄에 크기·용량·바뀐 픽셀 %·변경 영역.
 * 픽셀 비교는 효과(useEffect)에서 한 번 계산하고 렌더 중에는 하지 않는다.
 */
export const ImageDiff = memo(function ImageDiff({ image, path, oldPath, head, extra }: { image: ImageSrc; path: string; oldPath?: string; head: ReactNode; extra?: ReactNode }) {
  countRender("ImageDiff");
  useLocale();
  const view = useSyncExternalStore(subscribe, () => mode);
  const key = `${image.repo}|${image.before}|${image.after}|${path}|${oldPath ?? ""}`;
  const [data, setData] = useState<Loaded | null>(null);
  // 교체·언마운트 때 이전 Blob URL을 해제한다
  useEffect(() => () => void (data && revoke(data.a, data.b)), [data]);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [a, b] = await Promise.all([loadSide(image.repo, image.before, oldPath ?? path), loadSide(image.repo, image.after, path)]);
        let cmp: Loaded["cmp"] = null;
        if (a && b && a.w === b.w && a.h === b.h) cmp = compareSides(a, b);
        if (live) setData({ key, a, b, cmp });
        else revoke(a, b);
      } catch (e) {
        if (live) setData({ key, a: null, b: null, cmp: null, err: String(e instanceof Error ? e.message : e).replace(/^Error: /, "") });
      }
    })();
    return () => void (live = false);
  }, [key, image.v]);
  const d = data?.key === key ? data : null;

  return (
    <div className="diff img-diff">
      <div className="diff-file">
        {head}
        {extra}
        <div className="segmented" role="radiogroup" aria-label={t("diff.imgMode")}>
          {MODES.map((m) => (
            <button key={m} role="radio" aria-checked={view === m} onClick={() => setMode(m)}>{t(LABEL[m])}</button>
          ))}
        </div>
        <BigButton />
      </div>
      {d?.err ? <div className="meta bin">{d.err}</div> : d && (
        <>
          <Info a={d.a} b={d.b} cmp={d.cmp} />
          <Stage a={d.a} b={d.b} cmp={d.cmp} view={view} />
        </>
      )}
    </div>
  );
});
