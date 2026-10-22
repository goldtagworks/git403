// 이미지 diff의 순수 로직: 확장자 판별, 크기 표기, 픽셀 비교 (화면·IPC 의존 없음).

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml",
};
const ext = (path: string) => path.slice(path.lastIndexOf(".") + 1).toLowerCase();
export const mimeOf = (path: string) => MIME[ext(path)];
export const isImagePath = (path: string) => path.includes(".") && ext(path) in MIME;
export const isSvg = (path: string) => ext(path) === "svg";

/** base64 문자열이 나타내는 바이트 수 */
export const base64Bytes = (b64: string) => Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
export const fmtKb = (bytes: number) => `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
export const fmtPct = (changed: number, total: number) => {
  if (!changed) return "0%";
  const p = (changed / total) * 100;
  return p < 0.01 ? "<0.01%" : p < 1 ? `${p.toFixed(2)}%` : `${p.toFixed(1)}%`;
};

export interface Box { x: number; y: number; w: number; h: number }
export interface Compare {
  changed: number;
  total: number;
  /** 바뀐 픽셀을 모두 감싸는 사각형 (바뀐 게 없으면 null) */
  box: Box | null;
  /** 바뀐 픽셀 = 불투명 흰색, 나머지 = 투명 (RGBA) */
  mask: Uint8ClampedArray<ArrayBuffer>;
  /** 마스크 크기 (축소해서 비교했으면 원본보다 작다) */
  mw: number;
  mh: number;
  /** 축소 비교라 % ·박스가 근사값 */
  approx: boolean;
}

/** 이 픽셀 수 이하는 원본으로 정확히 비교하고, 넘으면 긴 변을 SAMPLE_SIDE로 줄여 근사한다 (메인 스레드 작업을 수 ms로) */
export const EXACT_PX = 1_000_000;
export const SAMPLE_SIDE = 1024;
export function sampleSize(w: number, h: number): { w: number; h: number; approx: boolean } {
  if (w * h <= EXACT_PX) return { w, h, approx: false };
  const k = SAMPLE_SIDE / Math.max(w, h);
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), approx: true };
}
/** 축소 좌표의 박스를 원본 좌표로 (바깥으로 반올림) */
export function scaleBox(b: Box, mw: number, mh: number, w: number, h: number): Box {
  const x = Math.floor((b.x / mw) * w), y = Math.floor((b.y / mh) * h);
  return { x, y, w: Math.min(w, Math.ceil(((b.x + b.w) / mw) * w)) - x, h: Math.min(h, Math.ceil(((b.y + b.h) / mh) * h)) - y };
}

/** 같은 크기의 두 RGBA 이미지를 픽셀 단위로 비교. 완전 투명한 픽셀끼리는 색이 달라도 같은 것으로 본다. */
export function compare(a: Uint8ClampedArray, b: Uint8ClampedArray, w: number, h: number): Compare {
  const mask = new Uint8ClampedArray(w * h * 4);
  let changed = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2] && a[i + 3] === b[i + 3]) continue;
      if (a[i + 3] === 0 && b[i + 3] === 0) continue;
      mask[i] = mask[i + 1] = mask[i + 2] = mask[i + 3] = 255;
      changed++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      y1 = y;
    }
  }
  return { changed, total: w * h, box: changed ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null, mask, mw: w, mh: h, approx: false };
}

/** 이미지(w×h)를 칸(aw×ah)에 맞추는 배율. 작은 이미지는 확대(상한 32배) */
export const fitScale = (w: number, h: number, aw: number, ah: number) => Math.max(0.01, Math.min(aw / w, ah / h, 32));
