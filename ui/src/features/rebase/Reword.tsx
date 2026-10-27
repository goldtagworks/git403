import { useEffect, useState } from "react";
import { Sheet, SheetActions, SheetBody, SheetHead } from "../../shared/ui/Sheet";
import { ctx } from "../../shared/model/ops";
import { api } from "../../shared/api/api";
import { ask } from "../../shared/api/bridge";
import { t, useLocale } from "../../shared/i18n/i18n";
import type { Commit } from "../../shared/api/types";

interface State { commit: Commit; chain: Commit[]; subject: string; body: string }
let openSheet: ((s: State) => void) | null = null;

/**
 * 커밋 메시지 수정. HEAD면 `commit --amend --only`(스테이지는 그대로), 더 오래된 커밋이면
 * 그 커밋부터 HEAD까지 그대로 다시 쌓으며 메시지만 바꾸는 interactive rebase(`rebase_interactive`의 reword).
 * 현재 브랜치(첫 부모 계보)의 커밋만, 사이에 머지 커밋이 있으면 막는다.
 */
export async function startReword(sha: string) {
  if (ctx.status?.operation) return ctx.error(t("reword.busy"));
  const byId = new Map(ctx.commits.map((c) => [c.id, c]));
  const headId = ctx.refs.find((r) => r.head)?.target;
  const chain: Commit[] = [];
  let c = headId ? byId.get(headId) : undefined;
  for (; c && c.id !== sha; c = byId.get(c.parents[0])) chain.push(c);
  if (!c) return ctx.error(t("reword.notOnHead"));
  chain.push(c);
  if (chain.some((x) => x.parents.length > 1)) return ctx.error(t("reword.hasMerge"));
  if (chain.length > 1 && !c.parents.length) return ctx.error(t("reword.root"));
  const msg = await api.commitMessage(ctx.repo, sha).catch(() => c!.subject);
  const [subject, ...rest] = msg.replace(/\s+$/, "").split("\n");
  openSheet?.({ commit: c, chain: chain.reverse(), subject, body: rest.join("\n").replace(/^\n+/, "") });
}

function RewordSheet({ commit, chain, subject: s0, body: b0, onClose }: State & { onClose: () => void }) {
  useLocale();
  const [subject, setSubject] = useState(s0);
  const [body, setBody] = useState(b0);
  const [busy, setBusy] = useState(false);
  const message = subject.trim() + (body.trim() ? "\n\n" + body.trim() : "") + "\n";
  const same = subject.trim() === s0.trim() && body.trim() === b0.trim();

  const run = async () => {
    setBusy(true);
    try {
      const repo = ctx.repo;
      const pushed = (await api.git(repo, ["branch", "-r", "--contains", commit.id]).catch(() => "")).trim();
      if (pushed && !(await ask(t("reword.pushed", { refs: pushed.split("\n").map((l) => l.trim()).join(", ") }), { title: t("reword.title"), kind: "warning" }))) return setBusy(false);
      if (chain.length === 1) await api.git(repo, ["commit", "--amend", "--only", "--allow-empty", "-m", message]);
      else await api.rebaseInteractive(repo, commit.parents[0], chain.map((c) => ({ action: c.id === commit.id ? "reword" : "pick", sha: c.id, message: c.id === commit.id ? message : undefined })));
      ctx.notify(t("reword.done"), { kind: "success" });
    } catch (e) {
      ctx.error(t("reword.fail"), String(e));
    }
    onClose();
  };

  return (
    <Sheet label={t("reword.title")} onClose={onClose}>
      <SheetHead title={t("reword.title")} />
      <SheetBody>
        {chain.length > 1 && <p className="muted">{t("reword.rebaseNote", { n: chain.length - 1 })}</p>}
        <div className="field">
          <input aria-label={t("reword.subject")} placeholder={t("reword.subject")} value={subject} autoFocus onChange={(e) => setSubject(e.target.value)} />
        </div>
        <div className="field">
          <textarea rows={10} aria-label={t("reword.body")} placeholder={t("reword.body")} value={body} onChange={(e) => setBody(e.target.value)} />
        </div>
      </SheetBody>
      <SheetActions onCancel={onClose} primary={t("reword.run")} onPrimary={run} disabled={busy || !subject.trim() || same} />
    </Sheet>
  );
}

export function RewordHost() {
  const [state, setState] = useState<State | null>(null);
  useEffect(() => void (openSheet = setState), []);
  return state ? <RewordSheet key={state.commit.id} {...state} onClose={() => setState(null)} /> : null;
}
