import { useEffect, useState } from "react";
import { Sheet, SheetActions, SheetBody, SheetHead } from "../../shared/ui/Sheet";
import { ctx } from "../../shared/model/ops";
import { isRepoBusy } from "../../shared/lib/toast";
import { api } from "../../shared/api/api";
import { ask } from "../../shared/api/bridge";
import { t, useLocale } from "../../shared/i18n/i18n";
import type { Commit } from "../../shared/api/types";

/** resolve가 있으면 git 대신 입력한 메시지만 돌려준다(jj 설명 편집, `ctx.editMessage`) */
interface State { commit: Commit; chain: Commit[]; subject: string; body: string; title?: string; resolve?: (message: string | null) => void }
let openSheet: ((s: State) => void) | null = null;
let pending: ((message: string | null) => void) | null = null; // 열린 jj 설명 시트의 결과 대기

/**
 * 커밋 메시지 수정. HEAD면 `commit --amend --only`(스테이지는 그대로), 더 오래된 커밋이면
 * 그 커밋부터 HEAD까지 그대로 다시 쌓으며 메시지만 바꾸는 interactive rebase(`rebase_interactive`의 reword).
 * 현재 브랜치(첫 부모 계보)의 커밋만, 사이에 머지 커밋이 있으면 막는다.
 */
export interface RewordPlan { commit: Commit; chain: Commit[] }

/** 수정할 수 있는지 보고 대상 구간(그 커밋 ~ HEAD, 오래된 것부터)을 돌려준다. 안 되면 오류를 띄우고 null */
export function rewordPlan(sha: string): RewordPlan | null {
  if (ctx.status?.operation) return ctx.error(t("reword.busy")), null;
  const byId = new Map(ctx.commits.map((c) => [c.id, c]));
  const headId = ctx.refs.find((r) => r.head)?.target;
  const chain: Commit[] = [];
  let c = headId ? byId.get(headId) : undefined;
  for (; c && c.id !== sha; c = byId.get(c.parents[0])) chain.push(c);
  if (!c) return ctx.error(t("reword.notOnHead")), null;
  chain.push(c);
  if (chain.some((x) => x.parents.length > 1)) return ctx.error(t("reword.hasMerge")), null;
  if (chain.length > 1 && !c.parents.length) return ctx.error(t("reword.root")), null;
  return { commit: c, chain: chain.reverse() };
}

/** 메시지를 바꾼다. 원격에 있으면 확인. 성공하면 true (취소·실패는 false, 실패 토스트는 여기서) */
export async function applyReword({ commit, chain }: RewordPlan, message: string): Promise<boolean> {
  try {
    const repo = ctx.repo;
    const pushed = (await api.git(repo, ["branch", "-r", "--contains", commit.id]).catch(() => "")).trim();
    if (pushed && !(await ask(t("reword.pushed", { refs: pushed.split("\n").map((l) => l.trim()).join(", ") }), { title: t("reword.title"), kind: "warning" }))) return false;
    if (chain.length === 1) await api.git(repo, ["commit", "--amend", "--only", "--allow-empty", "-m", message]);
    else await api.rebaseInteractive(repo, commit.parents[0], chain.map((c) => ({ action: c.id === commit.id ? "reword" : "pick", sha: c.id, message: c.id === commit.id ? message : undefined })));
    ctx.notify(t("reword.done"), { kind: "success" });
    return true;
  } catch (e) {
    isRepoBusy(e) ? ctx.error(e) : ctx.error(t("reword.fail"), String(e));
    return false;
  }
}

/** 제목·본문 → git 메시지 (본문이 비면 제목만) */
export const joinMessage = (subject: string, body: string) => subject.trim() + (body.trim() ? "\n\n" + body.trim() : "") + "\n";
/** 전체 메시지 → [제목, 본문] */
export const splitSubject = (msg: string): [string, string] => {
  const [subject, ...rest] = msg.replace(/\s+$/, "").split("\n");
  return [subject, rest.join("\n").replace(/^\n+/, "")];
};

/** 커밋 메시지 수정 시트를 연다 (그래프 우클릭·아래 배치의 연필) */
export async function startReword(sha: string) {
  const plan = rewordPlan(sha);
  if (!plan) return;
  const msg = await api.commitMessage(ctx.repo, sha).catch(() => plan.commit.subject);
  const [subject, body] = splitSubject(msg);
  openSheet?.({ ...plan, subject, body });
}

function RewordSheet({ commit, chain, subject: s0, body: b0, title, resolve, onClose }: State & { onClose: () => void }) {
  useLocale();
  const [subject, setSubject] = useState(s0);
  const [body, setBody] = useState(b0);
  const [busy, setBusy] = useState(false);
  const same = !resolve && subject.trim() === s0.trim() && body.trim() === b0.trim(); // jj 설명은 같아도 저장할 수 있다 (빈 변경 설명 등)

  const run = async () => {
    setBusy(true);
    if (resolve) resolve(joinMessage(subject, body));
    else await applyReword({ commit, chain }, joinMessage(subject, body));
    setBusy(false);
    onClose();
  };

  return (
    <Sheet label={title ?? t("reword.title")} onClose={onClose}>
      <SheetHead title={title ?? t("reword.title")} />
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
  useEffect(() => {
    openSheet = setState;
    // jj 설명 편집용: 그 커밋의 현재 메시지로 채워 열고, 닫으면(취소 포함) 결과를 돌려준다
    ctx.editMessage = async (sha, title) => {
      pending?.(null); // 열려 있던 시트의 대기는 취소로 끝낸다
      pending = null;
      let msg: string;
      try {
        msg = await api.commitMessage(ctx.repo, sha);
      } catch (e) {
        ctx.error(e); // 읽지 못한 채 열면 빈 메시지로 설명이 지워질 수 있다
        return null;
      }
      const [subject, body] = splitSubject(msg);
      const commit = ctx.commits.find((c) => c.id === sha) ?? ({ id: sha, parents: [], author: "", email: "", time: 0, subject, body } as Commit);
      return new Promise<string | null>((resolve) => {
        pending = resolve;
        setState({ commit, chain: [commit], subject, body, title, resolve });
      });
    };
  }, []);
  return state ? <RewordSheet key={state.commit.id} {...state} onClose={() => (state.resolve?.(null), setState(null))} /> : null;
}
