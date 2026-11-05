import { useSyncExternalStore } from "react";
import { api } from "../api/api";
import { ask, COMPACT, DETAIL, errCode, listen, notifyOs, CodedError } from "../api/bridge";
import { t, tErr } from "../i18n/i18n";
import { isMobile } from "../lib/platform";
import { toast, toastError } from "../lib/toast";
import { aiProvider } from "./aiProviders";
import type { AiBackup, AiChatEntry, AiChatEvent, AiRisk } from "../api/types";

// AI 채팅(맨 오른쪽 독립 열) 상태. React 밖의 외부 스토어: 이벤트(text·tool…)가 계속 와도 구독한 화면(`features/ai/AiChat.tsx`)만 다시 그리고
// 그래프·사이드바·상세·툴바·상태바는 건드리지 않는다. 구독은 종류별 — 대화(저장소별)·실행 중 여부(상태바)·열림(저장소별).
// 백엔드: ai_chat_start 등 (docs/reuse.md "AI 채팅 IPC"), 호출 진입점은 ops.ts(`aiChatToggle`·`aiChatAsk`).

export type Item =
  | { k: "user"; text: string }
  | { k: "text"; text: string }
  | { k: "tool"; id: string; name: string; command: string; output?: string; error?: boolean }
  | { k: "note"; text: string; error?: boolean }
  /** 이번 차례 끝의 "이 작업 되돌리기" 한 줄. done = 되돌린 뒤 */
  | { k: "undo"; backup: AiBackup; done?: boolean };
/** confirmed: 이 대화는 위험 확인(공개·다수 협업자·판정 불가)을 마쳤다 — 이어 가기 차례는 다시 묻지 않는다 (백엔드도 같은 규칙으로 다시 검사) */
export interface Chat { id: string; repo: string; sessionId: string | null; items: Item[]; running: boolean; confirmed: boolean }

/** 데스크탑 전용 (모바일·VS Code 좁은 뷰·커밋 상세 탭에는 열이 없다) */
export const available = !isMobile && !COMPACT && !DETAIL;

const chats = new Map<string, Chat>();
const subs = new Set<() => void>();
const runSubs = new Set<() => void>();
const openSubs = new Set<() => void>();
const sub = (set: Set<() => void>) => (f: () => void) => (set.add(f), () => void set.delete(f));
const emit = (set: Set<() => void>) => set.forEach((f) => f());

let anyRunning = false;
/** 실행 중 여부가 바뀔 때만 상태바 항목을 깨운다 */
const syncRunning = () => {
  const now = [...chats.values()].some((c) => c.running);
  if (now === anyRunning) return;
  anyRunning = now;
  emit(runSubs);
};
const put = (c: Chat) => {
  chats.set(c.repo, c);
  emit(subs);
  syncRunning();
};

const KEY = "aiChatOpen";
const readOpen = (): Record<string, boolean> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
};
let opened = readOpen();
const isOpen = (repo: string) => available && !!repo && !!opened[repo];

const newId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const blank = (repo: string): Chat => ({ id: newId(), repo, sessionId: null, items: [], running: false, confirmed: false });
const find = (id: string) => [...chats.values()].find((c) => c.id === id);

let hooks = { reload: () => {}, open: (_repo: string) => {} };
/** "Name: command" 이력 요약 → 도구 줄 */
const toolOf = (s: string): Item => {
  const i = s.indexOf(": ");
  return { k: "tool", id: "", name: i > 0 ? s.slice(0, i) : "", command: i > 0 ? s.slice(i + 2) : s };
};

/** 한 차례가 끝났을 때: 되돌리기 줄, 그래프·상태 새로고침, 앱이 백그라운드면 OS 알림 */
function finish(c: Chat, backup: AiBackup | null, ok: boolean, body: string) {
  put({ ...c, running: false, items: backup ? [...c.items, { k: "undo", backup }] : c.items });
  hooks.reload();
  if (!document.hasFocus() || document.visibilityState === "hidden") void notifyOs(t(ok ? "aiChat.notifyDone" : "aiChat.notifyFail", { repo: c.repo.split(/[\\/]/).pop() ?? "" }), body.slice(0, 120));
}

/** 이 차례의 백업 (시작 응답이 오기 전에 이벤트가 먼저 와도 잃지 않게 별도로 쥔다) */
const backups = new Map<string, AiBackup | null>();

function onEvent(conversation: string, ev: AiChatEvent) {
  const c = find(conversation);
  if (!c) return;
  const last = c.items[c.items.length - 1];
  const turn = c.items.slice(c.items.map((i) => i.k).lastIndexOf("user") + 1);
  switch (ev.kind) {
    case "text":
      return put({ ...c, items: last?.k === "text" ? [...c.items.slice(0, -1), { k: "text", text: last.text + ev.text }] : [...c.items, { k: "text", text: ev.text }] });
    case "tool":
      return put({ ...c, items: [...c.items, { k: "tool", id: ev.id, name: ev.name, command: ev.command }] });
    case "toolResult":
      return put({ ...c, items: c.items.map((i) => (i.k === "tool" && i.id === ev.id ? { ...i, output: ev.output, error: ev.isError } : i)) });
    case "done": {
      // 도구 호출만 있고 텍스트가 없었으면(답이 result에만 있는 경우) result를 보인다. 오류 결과는 항상 오류 줄로
      const extra: Item[] = ev.result && (ev.isError || !turn.some((i) => i.k === "text")) ? [ev.isError ? { k: "note", text: ev.result, error: true } : { k: "text", text: ev.result }] : [];
      const b = backups.get(c.id) ?? null;
      backups.delete(c.id);
      return finish({ ...c, sessionId: ev.sessionId ?? c.sessionId, items: [...c.items, ...extra] }, b, !ev.isError, ev.result);
    }
    case "error": {
      const text = ev.code ? tErr(ev.code, undefined, ev.message) : ev.message;
      const b = backups.get(c.id) ?? null;
      backups.delete(c.id);
      return finish({ ...c, items: [...c.items, { k: "note", text, error: true }] }, b, false, text);
    }
    case "note":
      toastError(tErr(ev.code, undefined, ev.message));
      return;
    case "cancelled": {
      const b = backups.get(c.id) ?? null;
      backups.delete(c.id);
      return finish({ ...c, items: [...c.items, { k: "note", text: t("aiChat.cancelled") }] }, b, false, t("aiChat.cancelled"));
    }
  }
}

/** Anthropic 동의를 받아 저장한다. 거절하면 false */
async function consent() {
  if (!(await ask(t("ops.ai.consent", { p: aiProvider("anthropic").org }), { title: t("ops.ai.consentTitle"), kind: "warning" }))) return false;
  await api.aiSettingsSet({ provider: "anthropic", consent: true });
  return true;
}

/** 공개·다수 협업자·판정 불가 저장소는 대화 첫 실행 전에 OS 확인창으로 묻는다(거절하면 false). 로컬 전용·본인만 쓰는 private은 묻지 않는다 */
async function confirmRisk(repo: string, risk: AiRisk) {
  const exec = risk.config ?? [];
  if (risk.level === "none" && !exec.length) return true;
  const key = risk.level === "public" ? "aiChat.confirmPublic" : risk.level === "shared" ? "aiChat.confirmShared" : "aiChat.confirmUnknown";
  const name = repo.split(/[\\/]/).filter(Boolean).pop() ?? repo;
  // 이유 문단: 공개·협업자·판정 불가(레벨) + 저장소 로컬 git 설정의 실행형 키(훅·ext-diff·textconv는 앱이 끄지만 filter·driver 등은 못 끈다)
  const reasons = [...(risk.level === "none" ? [] : [t(key, { repo: name, n: risk.collaborators ?? 0 })]), ...(exec.length ? [t("aiChat.confirmExec", { keys: exec.slice(0, 6).join(", ") + (exec.length > 6 ? ", …" : "") })] : [])];
  return ask(`${reasons.join("\n\n")}\n\n${t("aiChat.confirmScope")}`, { title: t("aiChat.confirmTitle"), kind: "warning" });
}

export const aiChat = {
  available,
  /** 시작 때 한 번(App): 이벤트 구독 + 끝났을 때 부를 동작 */
  init(h: { reload: () => void; open: (repo: string) => void }) {
    hooks = h;
    const un = listen<{ conversation: string; event: AiChatEvent }>("ai-chat", ({ payload }) => onEvent(payload.conversation, payload.event));
    return () => void un.then((f) => f());
  },
  chat: (repo: string) => chats.get(repo),
  isOpen,
  setOpen(repo: string, v: boolean) {
    if (!available || !repo || !!opened[repo] === v) return;
    opened = { ...opened, [repo]: v };
    if (!v) delete opened[repo];
    try {
      localStorage.setItem(KEY, JSON.stringify(opened));
    } catch {}
    emit(openSubs);
  },
  toggle: (repo: string) => aiChat.setOpen(repo, !isOpen(repo)),
  /** 새 대화 (실행 중이면 무시) */
  reset(repo: string) {
    if (chats.get(repo)?.running) return;
    put(blank(repo));
  },
  /** 입력 한 차례를 보낸다. 동의가 없으면 한 번 묻고 이어서 보낸다 */
  async send(repo: string, input: string) {
    const text = input.trim();
    const cur = chats.get(repo) ?? blank(repo);
    if (!text || cur.running) return;
    const start = { ...cur, running: true, items: [...cur.items, { k: "user", text } as Item] };
    put(start);
    let confirmed = cur.confirmed;
    const run = () => api.aiChatStart(repo, start.id, text, start.sessionId, confirmed);
    const drop = (items: Item[]) => put({ ...chats.get(repo)!, running: false, items });
    try {
      // 대화 첫 실행: 위험 판정(조회 실패 = 판정 불가 = 확인). 거절하면 입력 줄만 거두고 실행하지 않는다
      if (!confirmed) {
        const risk = await api.aiChatRisk(repo).catch((): AiRisk => ({ level: "unknown" }));
        // 확인으로도 허용할 수 없는 저장소 설정: 묻지 않고 막는다(사유를 보여 준다)
        if (risk.refuse?.length) return drop([...cur.items, { k: "note", text: tErr("aiChat.configRefused", { reasons: risk.refuse.join("; ") }, risk.refuse.join("; ")), error: true }]);
        if (!(await confirmRisk(repo, risk))) return drop(cur.items);
        confirmed = true;
      }
      let b: AiBackup | null;
      try {
        b = await run();
      } catch (e) {
        if (errCode(e) !== "ai.consentRequired") throw e;
        if (!(await consent())) return drop(cur.items); // 동의 거절: 입력 줄만 거둔다
        b = await run();
      }
      if (b) backups.set(start.id, b);
      put({ ...chats.get(repo)!, confirmed: true });
    } catch (e) {
      backups.delete(start.id);
      drop([...chats.get(repo)!.items, { k: "note", text: String(e), error: true }]);
    }
  },
  cancel(repo: string) {
    const c = chats.get(repo);
    if (c?.running) api.aiChatCancel(c.id).catch(() => {});
  },
  /** 열고 새 대화로 이 입력을 보낸다 (실패 토스트의 "AI에게 맡기기") */
  ask(repo: string, input: string) {
    if (!available || !repo) return;
    if (chats.get(repo)?.running) return toast(t("aiChat.busyNow"), { kind: "info" });
    aiChat.setOpen(repo, true);
    aiChat.reset(repo);
    void aiChat.send(repo, input);
  },
  /** 이력의 대화를 이어 갈 수 있게 불러온다 (마지막 sessionId로 이어 가기) */
  async load(repo: string, conversation: string) {
    if (chats.get(repo)?.running) return;
    try {
      const entries = await api.aiHistoryRead(repo, conversation);
      const items = entries.flatMap((e: AiChatEntry): Item[] => [
        { k: "user", text: e.input },
        ...e.commands.map(toolOf),
        ...(e.answer ? [{ k: "text", text: e.answer } as Item] : []),
        ...(e.status === "error" ? [{ k: "note", text: t("aiChat.failedTurn"), error: true } as Item] : e.status === "cancelled" ? [{ k: "note", text: t("aiChat.cancelled") } as Item] : []),
        ...(e.backup ? [{ k: "undo", backup: e.backup } as Item] : []),
      ]);
      put({ id: conversation, repo, sessionId: [...entries].reverse().find((e) => e.sessionId)?.sessionId ?? null, items, running: false, confirmed: false });
    } catch (e) {
      toastError(String(e));
    }
  },
  /** 이 차례의 작업을 되돌린다 (OS 확인창 → 진행 중인 git 작업이 있으면 중단 여부를 한 번 더 묻는다) */
  async undo(repo: string, backup: AiBackup) {
    if (!(await ask(t("aiChat.undoAsk"), { title: t("aiChat.undoTitle"), kind: "warning" }))) return;
    // 되돌리기 전에 더 되돌릴지 묻는다: 백업 때의 다른 로컬 브랜치(AI가 옮기거나 지웠을 수 있다), 커밋 안 한 변경의 스냅숏(그 파일은 스냅숏 내용으로 덮어쓴다)
    const more = {
      branches: (backup.heads ?? 0) > 1 && (await ask(t("aiChat.undoBranchesAsk"), { title: t("aiChat.undoTitle"), kind: "warning" })),
      wip: !!backup.wip && (await ask(t("aiChat.undoWipAsk"), { title: t("aiChat.undoTitle"), kind: "warning" })),
    };
    const run = (abort: boolean) => api.aiBackupRestore(repo, backup.id, backup.branch, abort, { ...more, digest: backup.digest });
    try {
      try {
        await run(false);
      } catch (e) {
        if (errCode(e) !== "aiBackup.operationInProgress") throw e;
        if (!(await ask(t("aiChat.undoAbortAsk", { op: (e as CodedError).vars.op ?? "" }), { title: t("aiChat.undoTitle"), kind: "warning" }))) return;
        await run(true);
      }
    } catch (e) {
      return toastError(String(e));
    }
    const c = chats.get(repo);
    if (c) put({ ...c, items: c.items.map((i) => (i.k === "undo" && i.backup.id === backup.id ? { ...i, done: true } : i)) });
    toast(t("aiChat.undone"), { kind: "success" });
    hooks.reload();
  },
  /** 상태바 "AI 작업 중…": 실행 중인 대화의 저장소를 열고 열을 연다 */
  focus() {
    const c = [...chats.values()].find((x) => x.running);
    if (!c) return;
    hooks.open(c.repo);
    aiChat.setOpen(c.repo, true);
  },
};

/** 이 저장소의 대화 (없으면 undefined) */
export const useChat = (repo: string) => useSyncExternalStore(sub(subs), () => chats.get(repo));
/** 어떤 대화든 실행 중인지 — 상태바 항목만 구독한다 */
export const useChatRunning = () => useSyncExternalStore(sub(runSubs), () => anyRunning);
export const useChatOpen = (repo: string) => useSyncExternalStore(sub(openSubs), () => isOpen(repo));
/** 실행 중인데 그 저장소의 열이 닫혀 있는 대화가 있는지 — 상태바 "AI 작업 중…"만 구독한다 */
const hidden = () => [...chats.values()].some((c) => c.running && !isOpen(c.repo));
const subHidden = (f: () => void) => {
  const a = sub(runSubs)(f), b = sub(openSubs)(f);
  return () => (a(), b());
};
export const useChatHidden = () => useSyncExternalStore(subHidden, hidden);
