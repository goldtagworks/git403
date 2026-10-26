import { useEffect, useState } from "react";
import { Sha } from "../../shared/ui/Sha";
import { Sheet, SheetActions, SheetBody, SheetHead } from "../../shared/ui/Sheet";
import { ctx } from "../../shared/model/ops";
import { api } from "../../shared/api/api";
import { t, useLocale } from "../../shared/i18n/i18n";
import type { Commit } from "../../shared/api/types";

const ACTIONS = { pick: "rebase.pick", reword: "rebase.reword", squash: "rebase.squash", fixup: "rebase.fixup", drop: "rebase.drop" } as const;
type Action = keyof typeof ACTIONS;
interface Step {
  commit: Commit;
  action: Action;
  message: string;
}

/**
 * interactive rebase 편집 시트. `commits`는 base 다음부터 HEAD까지, 오래된 것이 먼저.
 * 순서 바꾸기·메시지 수정·합치기·삭제를 고른 뒤 한 번에 실행한다.
 */
export function RebaseSheet({ base, commits, onClose }: { base: Commit; commits: Commit[]; onClose: () => void }) {
  useLocale();
  const [steps, setSteps] = useState<Step[]>(commits.map((c) => ({ commit: c, action: "pick", message: c.subject })));
  const [busy, setBusy] = useState(false);
  const set = (i: number, patch: Partial<Step>) => setSteps((s) => s.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const swap = (i: number, j: number) =>
    setSteps((s) => {
      if (j < 0 || j >= s.length) return s;
      const n = [...s];
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
  // 첫 커밋은 합칠 대상이 없다.
  const invalid = steps[0] && (steps[0].action === "squash" || steps[0].action === "fixup");

  const run = async () => {
    setBusy(true);
    try {
      await api.rebaseInteractive(
        ctx.repo,
        base.id,
        steps.map((s) => ({ action: s.action, sha: s.commit.id, message: s.action === "reword" ? s.message : undefined })),
      );
      ctx.notify(t("rebase.done"));
      onClose();
    } catch (e) {
      ctx.error(String(e));
      onClose();
    }
  };

  return (
    <Sheet label={t("rebase.title")} size="wide" onClose={onClose}>
      <SheetHead title={t("rebase.title")} />
      <SheetBody>
        <p>{t("rebase.intro", { base: base.id.slice(0, 7), n: steps.length })}</p>
        <ol className="rebase-list">
          {steps.map((s, i) => (
            <li key={s.commit.id} className={"rebase-" + s.action}>
              <span className="move">
                <button aria-label={t("rebase.up")} onClick={() => swap(i, i - 1)} disabled={i === 0}>↑</button>
                <button aria-label={t("rebase.down")} onClick={() => swap(i, i + 1)} disabled={i === steps.length - 1}>↓</button>
              </span>
              <select aria-label={t("rebase.action", { subject: s.commit.subject })} value={s.action} onChange={(e) => set(i, { action: e.target.value as Action })}>
                {Object.entries(ACTIONS).map(([k, v]) => (
                  <option key={k} value={k}>{t(v)}</option>
                ))}
              </select>
              <Sha id={s.commit.id} />
              {s.action === "reword" ? (
                <input aria-label={t("rebase.newMsg")} value={s.message} onChange={(e) => set(i, { message: e.target.value })} />
              ) : (
                <span className="subject">{s.commit.subject}</span>
              )}
            </li>
          ))}
        </ol>
        {invalid && <p className="warn">{t("rebase.invalid")}</p>}
      </SheetBody>
      <SheetActions onCancel={onClose} primary={t("rebase.run")} onPrimary={run} disabled={busy || !!invalid} reason={invalid ? t("rebase.invalid") : undefined} />
    </Sheet>
  );
}

let openSheet: ((s: { base: Commit; commits: Commit[] }) => void) | null = null;

/** HEAD에서 첫 부모를 따라 `base`까지 내려가 rebase 대상 커밋을 모은다. */
export function startInteractiveRebase(baseId: string) {
  const byId = new Map(ctx.commits.map((c) => [c.id, c]));
  const headId = ctx.refs.find((r) => r.head)?.target;
  const chain: Commit[] = [];
  for (let c = headId ? byId.get(headId) : undefined; c && c.id !== baseId; c = byId.get(c.parents[0])) chain.push(c);
  const base = byId.get(baseId);
  if (!base || !chain.length || chain.length === ctx.commits.length) return ctx.error(t("rebase.pickAncestor"));
  if (chain.some((c) => c.parents.length > 1)) return ctx.error(t("rebase.hasMerge"));
  openSheet?.({ base, commits: chain.reverse() });
}

export function RebaseHost() {
  const [state, setState] = useState<{ base: Commit; commits: Commit[] } | null>(null);
  useEffect(() => void (openSheet = setState), []);
  return state ? <RebaseSheet {...state} onClose={() => setState(null)} /> : null;
}
