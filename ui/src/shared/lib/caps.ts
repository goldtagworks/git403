// 백엔드 지원 여부 (IPC `capabilities`). 지원 안 되는 작업은 메뉴·툴바·빠른 실행에서 숨긴다 (docs/reuse.md).
// 판정은 여기 한 곳: 항목에 `op`(git 서브커맨드 예 "push", 또는 코어 메서드 이름)를 달면 `supports(op)`가 가른다.
// 데스크탑(all:true)은 아무것도 구독·필터하지 않는다 — 값이 안 바뀌므로 리렌더도 없다.
import { useSyncExternalStore } from "react";
import { api } from "../api/api";
import type { MenuEntry } from "../ui/menu";

let all = true;
let names = new Set<string>();
let ver = 0;
const listeners = new Set<() => void>();
const on = (f: () => void) => (listeners.add(f), () => void listeners.delete(f));

/** 시작 때 한 번. 실패하면 전부 지원으로 둔다 */
export async function loadCaps() {
  const c = await api.capabilities().catch(() => null);
  if (!c || c.all) return;
  all = false;
  names = new Set(c.ops);
  ver++;
  listeners.forEach((f) => f());
}

/** op가 없으면(git 작업이 아닌 항목) 항상 true */
/** 배열이면 전부 지원해야 true (Git Flow처럼 여러 서브커맨드를 쓰는 작업) */
export const supports = (op?: string | string[]) => !op || all || (typeof op === "string" ? names.has(op) : op.every((o) => names.has(o)));
/** 지원 여부가 바뀔 때만 다시 그리게 하는 구독 (바뀌는 건 시작 직후 한 번) */
export const useCaps = () => useSyncExternalStore(on, () => ver);
export const capsVersion = () => ver;
export const onCaps = on;

/** 지원 안 되는 항목을 뺀다. 비게 된 하위 메뉴와 겹친·끝의 구분선도 정리. all이면 그대로 돌려준다 */
export function visible(list: MenuEntry[]): MenuEntry[] {
  if (all) return list;
  const out: MenuEntry[] = [];
  for (const e of list) {
    if ("op" in e && !supports(e.op)) continue;
    if ("submenu" in e) {
      const sub = visible(e.submenu);
      if (!sub.length) continue;
      out.push({ ...e, submenu: sub });
    } else if ("separator" in e) {
      if (!out.length || "separator" in out[out.length - 1]) continue;
      out.push(e);
    } else out.push(e);
  }
  while (out.length && "separator" in out[out.length - 1]) out.pop();
  return out;
}
