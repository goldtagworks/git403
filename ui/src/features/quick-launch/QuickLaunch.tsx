import { isMac } from "../../shared/lib/platform";
import { useEffect, useMemo, useRef, useState } from "react";
import { t, useLocale } from "../../shared/i18n/i18n";
import { bigView } from "../../shared/model/bigview";
import { ctx, ops } from "../../shared/model/ops";
import { Sheet } from "../../shared/ui/Sheet";

interface Command {
  label: string;
  hint?: string;
  run: () => void;
}

/** 빠른 실행(명령 팔레트): 작업·브랜치 체크아웃·최근 저장소를 이름으로 찾아 실행. */
export function QuickLaunch({ recent, onOpen, onClose }: { recent: string[]; onOpen: (p: string) => void; onClose: () => void }) {
  const lang = useLocale();
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const commands = useMemo<Command[]>(() => {
    const branches = ctx.refs.filter((r) => r.kind === "local" && !r.head).map((r) => ({ label: t("quick.checkout", { name: r.name }), hint: t("quick.branch"), run: () => ops.checkout(r.name) }));
    const remotes = ctx.refs.filter((r) => r.kind === "remote").map((r) => ({ label: t("quick.checkout", { name: r.name }), hint: t("quick.remoteBranch"), run: () => ops.checkoutRemote(r.name) }));
    const repos = recent.filter((r) => r !== ctx.repo).map((r) => ({ label: t("quick.open", { name: r.split(/[\\/]/).pop()! }), hint: r, run: () => onOpen(r) }));
    const workspaces = ops.workspaceNames().map((n) => ({ label: t("quick.workspace", { name: n }), hint: t("quick.workspaceHint"), run: () => ops.openWorkspace(n) }));
    const repoOps = [
      { label: t("quick.c0"), run: ops.clone },
      { label: t("quick.c1"), run: ops.init },
      { label: t("quick.c2"), run: ops.scan },
      { label: t("quick.c3"), hint: t("quick.h0"), run: ops.saveWorkspace },
      { label: t("quick.c4"), hint: t("quick.h1"), run: () => ops.openSettings() },
      { label: t("quick.c5"), run: () => ops.openSettings("ssh") },
      { label: t("quick.c6"), run: ops.chooseTerminal },
      { label: t("quick.c7"), run: ops.manageCustom },
      { label: t("quick.c8"), hint: "GitHub·GitLab·Bitbucket·Gitea", run: ops.manageAccounts },
      ...workspaces,
    ];
    if (!ctx.repo) return [...repoOps, ...repos];
    return [
      ...(ctx.tabs.length > 1 ? [{ label: t("tabs.next"), hint: isMac ? "⌘⌥→" : "Ctrl+Alt+→", run: () => ops.tabStep(1) }, { label: t("tabs.prev"), hint: isMac ? "⌘⌥←" : "Ctrl+Alt+←", run: () => ops.tabStep(-1) }] : []),
      ...(bigView.avail || bigView.open ? [{ label: t("quick.big"), run: bigView.toggle }] : []), // 보여 줄 diff가 없으면 항목을 숨긴다
      { label: "Fetch", run: ops.fetch },
      { label: "Pull", run: ops.pullQuick },
      { label: "Pull…", hint: t("quick.h3"), run: ops.pull },
      { label: "Push", run: ops.pushQuick },
      { label: "Push…", hint: t("quick.h3"), run: ops.push },
      { label: t("prr.title"), run: () => ops.prReview() },
      { label: t("quick.c9"), hint: t("quick.h4"), run: () => ops.createPr() },
      { label: t("quick.c10"), run: ops.prRefresh },
      { label: t("quick.c11"), run: ops.manageIssues },
      ...(ops.aiOn() && ops.head() ? [{ label: t("quick.c12"), run: () => ops.aiReviewBranch(ops.head()!) }] : []),
      ...(ops.aiOn() ? [{ label: t("quick.guide"), run: ops.guideStart }] : []),
      { label: t("quick.c13"), hint: t("quick.h5"), run: () => ops.openSettings("ai") },
      { label: t("quick.c14"), run: () => ops.createBranch() },
      { label: t("quick.c15"), run: ops.stash },
      { label: t("quick.c16"), hint: t("quick.h6"), run: ops.snapshot },
      { label: t("quick.c17"), hint: "apply · am", run: ops.applyPatch },
      { label: t("quick.c18"), run: () => ops.savePatchChanges("unstaged") },
      { label: t("quick.c19"), run: () => ops.savePatchChanges("staged") },
      { label: t("quick.c20"), run: () => ops.savePatchChanges("all") },
      { label: t("quick.c21"), run: () => ops.pop() },
      { label: t("quick.c22"), run: ops.openTerminal },
      { label: t("quick.c23"), run: ops.openFolder },
      { label: t("quick.c24"), run: () => ops.toolSetup() },
      ...ops.customQuick(),
      { label: t("quick.c25"), run: ops.addRemote },
      { label: t("quick.c26"), hint: "submodule update --init --recursive", run: () => ops.updateSubmodules() },
      { label: t("quick.c27"), run: ops.addSubmodule },
      { label: t("quick.c28"), run: ops.syncSubmodules },
      { label: t("quick.c29"), run: ops.addWorktree },
      { label: t("quick.c30"), run: ops.pruneWorktrees },
      { label: t("quick.c31"), hint: t("quick.h9"), run: ops.repoStats },
      { label: t("quick.c32"), run: ops.lfsStatus },
      { label: "LFS Pull", run: ops.lfsPull },
      { label: "LFS Fetch", run: ops.lfsFetch },
      { label: "LFS Push", run: ops.lfsPush },
      { label: t("quick.c33"), run: () => ops.lfsTrack() },
      { label: t("quick.c34"), run: () => ops.lfsUntrack() },
      ...ops.flowMenu().flatMap((e) => ("action" in e ? [{ label: `Git Flow: ${e.label}`, run: e.action }] : [])),
      ...branches,
      ...remotes,
      ...repos,
      ...repoOps,
    ];
  }, [recent, onOpen, lang]);

  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = commands.filter((c) => words.every((w) => (c.label + " " + (c.hint ?? "")).toLowerCase().includes(w))).slice(0, 50);
  const run = (c?: Command) => {
    if (!c) return;
    onClose();
    c.run();
  };

  return (
    <Sheet label={t("quick.title")} size="palette" top closeOnBackdrop onClose={onClose}>
        <input
          ref={input}
          value={q}
          placeholder={t("quick.placeholder")}
          aria-label={t("quick.search")}
          onChange={(e) => {
            setQ(e.target.value);
            setI(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setI((x) => Math.min(x + 1, shown.length - 1));
            else if (e.key === "ArrowUp") setI((x) => Math.max(x - 1, 0));
            else if (e.key === "Enter") run(shown[i]);
            else return;
            e.preventDefault();
          }}
        />
        <ul role="listbox">
          {shown.map((c, k) => (
            <li key={c.label + k} role="option" aria-selected={k === i} className={k === i ? "selected" : ""} onMouseEnter={() => setI(k)} onClick={() => run(c)}>
              <span>{c.label}</span>
              {c.hint && <span className="hint">{c.hint}</span>}
            </li>
          ))}
          {!shown.length && <li className="hint">{t("quick.none")}</li>}
        </ul>
    </Sheet>
  );
}
