import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../../shared/api/api";
import { ask } from "../../shared/api/bridge";
import { t, useLocale } from "../../shared/i18n/i18n";
import { countRender } from "../../shared/lib/profile";
import { relTime } from "../../shared/lib/reltime";
import { aiChat, useChat, useChatOpen, type Item } from "../../shared/model/aichat";
import { Icon } from "../../shared/ui/Icon";
import { Markdown } from "../../shared/ui/Markdown";
import { showMenu } from "../../shared/ui/menu";
import { useSplit } from "../../shared/ui/Splitter";
import { toast, toastError } from "../../shared/lib/toast";
import { ctx, ops } from "../../shared/model/ops";
import { SettingsGroup, SettingsRow } from "../../shared/ui/SettingsLayout";
import type { AiBackup } from "../../shared/api/types";

// 맨 오른쪽 독립 AI 채팅 열 (detailLayout과 무관). 상태·이벤트는 shared/model/aichat.ts(외부 스토어),
// 여기는 화면만: 열림은 `useChatOpen`, 대화는 `useChat`을 구독하고 입력 글자는 `ChatInput` 안에만 둔다(타이핑이 목록을 다시 그리지 않게).

const FILE_TOOLS = ["read_file", "edit_file", "Read", "Edit", "Write", "MultiEdit", "NotebookEdit"];
/** 저장소 안 파일의 상대 경로 (밖이면 null) */
const relPath = (repo: string, p: string) => {
  const a = p.replace(/\\/g, "/"), r = repo.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  return a.startsWith(r) ? a.slice(r.length) : /^([/~]|[A-Za-z]:)/.test(a) ? null : a;
};

/** 도구 실행: 접힌 한 줄(이름 + 명령), 펼치면 출력. Read·Edit 계열은 경로를 눌러 diff 화면에서 연다 */
const ToolRow = memo(function ToolRow({ item, repo }: { item: Extract<Item, { k: "tool" }>; repo: string }) {
  const [open, setOpen] = useState(false);
  const file = FILE_TOOLS.includes(item.name) ? relPath(repo, item.command) : null;
  return (
    <div className="ai-tool">
      <div className="ai-tool-row">
        <button className="ai-tool-toggle" aria-expanded={open} aria-label={`${item.name} ${item.command}`} onClick={() => setOpen(!open)}>
          <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
          {item.name && <span className="ai-tool-name">{item.name}</span>}
          {!file && <span className="ai-tool-cmd mono" title={item.command}>{item.command}</span>}
        </button>
        {file && <button className="ai-path mono" title={item.command} onClick={() => ops.aiChatOpenFile(file)}>{file}</button>}
      </div>
      {open && <pre className={"ai-out mono selectable" + (item.error ? " err" : "")}>{item.output ?? t("aiChat.noOutput")}</pre>}
    </div>
  );
});

const Row = memo(function Row({ item, repo }: { item: Item; repo: string }) {
  switch (item.k) {
    case "user":
      return <div className="ai-user selectable">{item.text}</div>;
    case "text":
      return <Markdown text={item.text} className="ai-text" />;
    case "tool":
      return <ToolRow item={item} repo={repo} />;
    case "note":
      return <div className={"ai-note selectable" + (item.error ? " err" : "")} role={item.error ? "alert" : undefined}>{item.text}</div>;
    case "undo":
      return <UndoRow repo={repo} backup={item.backup} done={!!item.done} />;
  }
});

function UndoRow({ repo, backup, done }: { repo: string; backup: AiBackup; done: boolean }) {
  return done ? <div className="ai-note">{t("aiChat.undone")}</div> : <button className="link ai-undo" onClick={() => void aiChat.undo(repo, backup)}>{t("aiChat.undo")}</button>;
}

/** 입력란 + 추천 칩. 입력 글자는 여기 상태에만 둔다 */
const ChatInput = memo(function ChatInput({ repo, running, operation, behind }: { repo: string; running: boolean; operation: string | null; behind: boolean }) {
  countRender("AiChatInput");
  useLocale();
  const [text, setText] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => void (document.activeElement === document.body && box.current?.focus()), []);
  const send = () => {
    if (!text.trim() || running) return;
    void aiChat.send(repo, text);
    setText("");
  };
  const chips: { label: string; prompt: string }[] = [];
  if (operation) chips.push({ label: t("aiChat.chipResolve"), prompt: t("aiChat.promptResolve", { op: operation }) });
  if (behind) chips.push({ label: t("aiChat.chipPull"), prompt: t("aiChat.promptPull") });
  if (!chips.length) chips.push({ label: t("aiChat.chipStatus"), prompt: t("aiChat.promptStatus") }, { label: t("aiChat.chipLog"), prompt: t("aiChat.promptLog") });
  return (
    <div className="ai-input">
      {!text && !running && (
        <div className="ai-chips" role="group" aria-label={t("aiChat.suggest")}>
          {chips.map((c) => <button key={c.label} className="ai-chip" onClick={() => (setText(c.prompt), box.current?.focus())}>{c.label}</button>)}
        </div>
      )}
      <textarea
        ref={box}
        value={text}
        rows={Math.min(6, Math.max(2, text.split("\n").length))}
        placeholder={t("aiChat.placeholder")}
        aria-label={t("aiChat.inputLabel")}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) (e.preventDefault(), send());
        }}
      />
      <div className="ai-actions">
        {running ? <button className="stop" onClick={() => aiChat.cancel(repo)}>{t("aiChat.stop")}</button> : <button className="primary" disabled={!text.trim()} onClick={send}>{t("aiChat.send")}</button>}
      </div>
    </div>
  );
});

function AiChat({ repo, operation, behind, width }: { repo: string; operation: string | null; behind: boolean; width: number }) {
  countRender("AiChat");
  useLocale();
  const chat = useChat(repo);
  const running = !!chat?.running;
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // 맨 아래를 보고 있으면 새 줄이 와도 따라간다
  useLayoutEffect(() => {
    const el = body.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat?.items]);

  const history = async (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    try {
      const list = await api.aiHistoryList(repo);
      showMenu(
        list.length ? list.map((h) => ({ label: h.title || h.conversation, hint: relTime(h.time / 1000), checked: h.conversation === chat?.id, action: () => void aiChat.load(repo, h.conversation) })) : [{ label: t("aiChat.noHistory"), disabled: true, action: () => {} }],
        { x: r.left, y: r.bottom + 2 },
      );
    } catch (err) {
      toastError(String(err));
    }
  };

  return (
    <aside
      className="pane ai-col"
      style={{ width }}
      aria-label={t("aiChat.title")}
      onKeyDown={(e) => {
        if (e.key === "Escape" && running) (e.stopPropagation(), aiChat.cancel(repo));
      }}
    >
      <div className="ai-head">
        <button disabled={running} onClick={() => aiChat.reset(repo)}>{t("aiChat.new")}</button>
        <button aria-haspopup="menu" disabled={running} onClick={history}>{t("aiChat.history")} <Icon name="chevronDown" size={11} /></button>
        <span className="spacer" />
        <button className="ai-close" aria-label={t("aiChat.close")} title={t("aiChat.close")} onClick={() => aiChat.setOpen(repo, false)}><Icon name="close" size={13} /></button>
      </div>
      <div className="ai-body" ref={body} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}>
        {chat?.items.length ? chat.items.map((it, i) => <Row key={i} item={it} repo={repo} />) : <p className="ai-intro">{t("aiChat.intro")}</p>}
        {running && <div className="ai-run" role="status">{t("aiChat.running")}</div>}
      </div>
      <ChatInput key={repo} repo={repo} running={running} operation={operation} behind={behind} />
    </aside>
  );
}

/** App의 작업 영역 끝(맨 오른쪽)에 한 번 둔다. 닫혀 있으면 아무것도 그리지 않는다 */
/** operation·behind는 추천 칩에 필요한 원시값만 받는다(status 객체가 새로 만들어져도 이 열이 다시 그려지지 않게) */
export const AiChatHost = memo(function AiChatHost({ repo, operation, behind }: { repo: string; operation: string | null; behind: boolean }) {
  countRender("AiChatHost");
  const open = useChatOpen(repo);
  const [w, split] = useSplit("ai-col", 380, 280, 720, "x", undefined, true);
  if (!open) return null;
  return (
    <div className="ai-wrap">
      {split}
      <AiChat repo={repo} operation={operation} behind={behind} width={w} />
    </div>
  );
});

/** 설정 > AI 탭의 "AI 채팅" 묶음: 이력 저장·보관 기간·이 저장소 이력 지우기. 상태는 이 안에만 있다 */
export function AiChatSettings() {
  useLocale();
  const [cfg, setCfg] = useState<{ save: boolean; days: string } | null>(null);
  const [err, setErr] = useState("");
  const load = () => api.aiChatSettings().then((c) => setCfg({ save: c.save, days: String(c.retentionDays) }), (e) => setErr(String(e)));
  useEffect(() => void load(), []);
  const run = async (f: () => Promise<unknown>) => {
    setErr("");
    try {
      await f();
      await load();
    } catch (e) {
      setErr(String(e));
    }
  };
  const saveDays = () => {
    const n = Number(cfg?.days);
    if (!Number.isInteger(n) || n < 1) return setErr(t("aiChat.badDays"));
    void run(() => api.aiChatSettingsSet({ retentionDays: n }));
  };
  const clear = async () => {
    if (!(await ask(t("aiChat.clearAsk"), { title: t("aiChat.clearTitle"), kind: "warning" }))) return;
    await run(() => api.aiHistoryClear(ctx.repo));
    toast(t("aiChat.cleared"), { kind: "success" });
  };
  if (!cfg) return null;
  return (
    <SettingsGroup title={t("aiChat.settingsTitle")} note={t("aiChat.settingsNote")}>
      <SettingsRow name={t("aiChat.saveHistory")}>
        <input type="checkbox" checked={cfg.save} onChange={(e) => run(() => api.aiChatSettingsSet({ save: e.target.checked }))} />
      </SettingsRow>
      <SettingsRow name={t("aiChat.retention")} desc={t("aiChat.retentionHelp")}>
        <input type="number" inputMode="numeric" min={1} step={1} value={cfg.days} onChange={(e) => setCfg({ ...cfg, days: e.target.value })} onBlur={saveDays} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), saveDays())} />
      </SettingsRow>
      <SettingsRow name={`${t("aiChat.clearHistory")}${ctx.repo ? "" : t("ai.needRepo")}`}>
        <button type="button" disabled={!ctx.repo} onClick={clear}>{t("aiChat.clearBtn")}</button>
      </SettingsRow>
      {err && <p className="warn selectable" role="alert">{err}</p>}
    </SettingsGroup>
  );
}
