import { deflateSync } from "node:zlib";
import type { Page } from "@playwright/test";

// 이미지 diff E2E용 작은 PNG를 코드로 만든다 (RGBA, 필터 없음).
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc(body), 4 + body.length);
  return out;
};

export type Rgba = [number, number, number, number];
/** w×h PNG의 base64. px(x, y)가 각 픽셀의 RGBA */
export function png(w: number, h: number, px: (x: number, y: number) => Rgba): string {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) Buffer.from(px(x, y)).copy(raw, y * (w * 4 + 1) + 1 + x * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

const RED: Rgba = [200, 50, 50, 255], BLUE: Rgba = [50, 50, 200, 255];
/** 16×16 빨간 그림 */
export const BEFORE = png(16, 16, () => RED);
/** 같은 그림에서 (5, 6)부터 4×3만 파랗게: 바뀐 픽셀 12/256 = 4.7% */
export const AFTER = png(16, 16, (x, y) => (x >= 5 && x < 9 && y >= 6 && y < 9 ? BLUE : RED));
/** 크기가 다른 그림 (20×16) */
export const WIDER = png(20, 16, () => RED);

/** 이미지 파일 하나의 binary diff (git이 내는 모양) */
export const binaryDiff = (path: string, state?: "new" | "deleted") =>
  `diff --git a/${path} b/${path}\n${state ? `${state} file mode 100644\n` : ""}index 3f2a1b0..9c4d2e1 100644\nBinary files ${state === "new" ? "/dev/null" : "a/" + path} and ${state === "deleted" ? "/dev/null" : "b/" + path} differ\n`;

/** 페이지가 뜨기 전에 mock에 심는다: 변경 파일 목록·diff·blob (blobs는 "rev:path" → base64) */
export const seed = (page: Page, o: { path?: string; diff?: string; state?: "new" | "deleted"; blobs: Record<string, string>; commitFiles?: boolean; status?: { path: string; index: string; worktree: string; untracked?: boolean }[] }) => {
  return page.addInitScript(...args(o));
};
type Seed = Parameters<typeof seed>[1];
const plant = ([diff, blobs, files, st]: [string, Record<string, string>, object[] | null, object[] | null]) => {
  const w = window as any;
  w.__fileDiff = diff;
  w.__blobs = blobs;
  if (files) w.__changedFiles = files;
  if (st) w.__statusExtra = st.map((f: object) => ({ oldPath: null, untracked: false, conflict: false, ...f }));
};
const args = (o: Seed) => {
  const path = o.path ?? "img/a.png";
  return [plant, [o.diff ?? binaryDiff(path, o.state), o.blobs, o.commitFiles === false ? null : [{ status: o.state === "new" ? "A" : o.state === "deleted" ? "D" : "M", path, oldPath: null }], o.status ?? null]] as const;
};
export const sha = (id: string) => id.padEnd(40, "0");

/** 이미 떠 있는 페이지에 같은 값을 바로 심는다 */
export const seedNow = (page: Page, o: Seed) => { const [f, a] = args(o); return page.evaluate(f, a); };
