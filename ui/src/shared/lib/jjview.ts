// jj 보기(30d): 저장소별로 jj 상태(`jj_status` 결과)와 git/jj 보기 선택을 들고 있는 외부 스토어.
// - 켜짐 여부는 `.jj` 존재(= `jj_status` 성공)이고 `ops.jjLoad`가 채운다. 보기 선택은 localStorage `jj:view:<저장소>`(`git`일 때만 저장, 없으면 jj).
// - 행은 자기 커밋의 값(문자열 하나)만 구독한다(`useJjRow`): 상태가 바뀌어도 바뀐 행만 다시 그리고 그래프·사이드바·상세는 건드리지 않는다.
// - ops·api 어느 쪽도 import하지 않는다 (api가 `jjScope`를 읽는다).
import { useSyncExternalStore } from "react";
import type { JjStatus } from "../api/types";

const status = new Map<string, JjStatus | null>();
const views = new Map<string, "git" | "jj">();
const subs = new Set<() => void>();
const subscribe = (l: () => void) => (subs.add(l), () => void subs.delete(l));
const emit = () => subs.forEach((l) => l());

const KEY = "jj:view:";
const viewOf = (repo: string): "git" | "jj" => {
  let v = views.get(repo);
  if (!v) {
    try {
      v = localStorage.getItem(KEY + repo) === "git" ? "git" : "jj";
    } catch {
      v = "jj";
    }
    views.set(repo, v);
  }
  return v;
};

/** jj가 켜져 있고(.jj) 보기도 jj인가 */
export const jjOn = (repo: string) => !!status.get(repo) && viewOf(repo) === "jj";
export const jjEnabled = (repo: string) => !!status.get(repo);

/** `jj_status` 결과(null = 꺼져 있음)를 반영한다. 내용이 같으면 참조·구독자를 그대로 둔다. */
export function setJjStatus(repo: string, s: JjStatus | null) {
  const prev = status.get(repo) ?? null;
  if (prev === s || (prev && s && JSON.stringify(prev) === JSON.stringify(s))) return;
  status.set(repo, s);
  emit();
}

export function setJjView(repo: string, v: "git" | "jj") {
  if (viewOf(repo) === v) return;
  views.set(repo, v);
  try {
    v === "git" ? localStorage.setItem(KEY + repo, "git") : localStorage.removeItem(KEY + repo);
  } catch {}
  emit();
}

/** `load_graph`·`search_content`의 `hidden`에 덧붙일 jj 표지 (백엔드 `jj_scope`가 해석): jj 보기가 아니면 없음(= git 보기, `refs/jj/`는 빠짐), jj 보기면 `+jj:<@ SHA>`(`@`가 없으면 `+jj`) */
export const jjScope = (repo: string): string[] => {
  if (!jjOn(repo)) return [];
  const wc = status.get(repo)?.workingCopy;
  return [wc ? `+jj:${wc}` : "+jj"];
};

/** 이 커밋 행의 jj 표시: `<changeId 짧은 형태>|<@ 여부 0/1>|<충돌 여부 0/1>|<changeId 전체>`. jj 보기가 아니거나 모르는 커밋이면 빈 문자열(원시값이라 바뀐 행만 다시 그린다). */
const rowKey = (repo: string, id: string) => {
  if (!jjOn(repo)) return "";
  const s = status.get(repo)!;
  const c = s.changeIds[id];
  return c ? `${c.short}|${s.workingCopy === id ? 1 : 0}|${s.conflicted.includes(id) ? 1 : 0}|${c.full}` : "";
};
export const useJjRow = (repo: string, id: string) => useSyncExternalStore(subscribe, () => rowKey(repo, id));
