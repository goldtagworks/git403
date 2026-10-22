import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../../shared/api/api";
import { listen } from "../../shared/api/bridge";
import { DiffView, type DiffNote, type DiffReveal } from "../../entities/diff/DiffView";
import { DiffFrame } from "../../shared/ui/DiffFrame";
import { FileNav, neighbors, revealSelected } from "../../shared/ui/FileNav";
import { useSplit } from "../../shared/ui/Splitter";
import { Icon } from "../../shared/ui/Icon";
import { Markdown } from "../../shared/ui/Markdown";
import { contextMenu, showMenu } from "../../shared/ui/menu";
import { bigView } from "../../shared/model/bigview";
import { toTree } from "../../shared/lib/fileTree";
import { onPrefs, pref } from "../../shared/lib/settings";
import { countRender } from "../../shared/lib/profile";
import { intlTag, t, useLocale } from "../../shared/i18n/i18n";
import { isMac } from "../../shared/lib/platform";
import { relTime } from "../../shared/model/prreview";
import { prPopup, type PopItem } from "../../shared/model/prpopup";
import type { ChangedFile, InboxPr, JobEvent, PrDetail, PrThread, PrTimelineItem } from "../../shared/api/types";

// PR 변경 파일 탭(26b): 범위(전체 변경 | 커밋 하나) · 파일 목록 · diff를 PR 화면 안에서 본다.
// 범위·선택 파일·diff는 모두 이 컴포넌트 상태라 그래프·사이드바·툴바는 다시 그려지지 않는다. diff 표시는 DiffView·DiffFrame·FileNav·bigView 재사용.

/** 범위: null = 전체 변경(병합 기준...head), 문자열 = 그 커밋 하나 */
export type Range = string | null;

const parseStatus = (out: string): ChangedFile[] =>
  out.split("\n").filter(Boolean).map((l) => {
    const f = l.split("\t");
    return f.length > 2 ? { status: f[0][0], path: f[2], oldPath: f[1] } : { status: f[0][0], path: f[1], oldPath: null };
  });
const sumNumstat = (out: string) =>
  out.split("\n").filter(Boolean).reduce((s, l) => {
    const [a, d] = l.split("\t");
    return { add: s.add + (Number(a) || 0), del: s.del + (Number(d) || 0) };
  }, { add: 0, del: 0 });

/** git 작업을 start_job으로 돌리고 끝날 때까지 기다린다. 앱 전체 작업 표시(App 상태)는 건드리지 않고 이 화면에만 진행 줄을 보인다 */
async function runJob(repo: string, args: string[], onLine: (l: string) => void, cur: { id: number | null }) {
  const early = new Map<number, string | null>(); // start_job 응답보다 먼저 온 완료
  let finish: (e: string | null) => void = () => {};
  const done = new Promise<string | null>((ok) => (finish = ok));
  const offs = await Promise.all([
    listen<[number, string | null]>("job-done", ({ payload: [id, err] }) => (cur.id === null ? early.set(id, err) : id === cur.id && finish(err))),
    listen<{ job: number; event: JobEvent }>("job", ({ payload: { job, event } }) => job === cur.id && event.kind === "progress" && onLine(event.line)),
  ]);
  try {
    const id = await api.startJob(repo, args);
    cur.id = id;
    if (early.has(id)) finish(early.get(id)!);
    const err = await done;
    if (err) throw new Error(err.trim().split("\n").slice(-2).join("\n"));
  } finally {
    cur.id = null;
    offs.forEach((f) => f());
  }
}

// PR(저장소+head)별로 받아 둔 병합 기준 커밋. 같은 PR을 다시 열면 확인 없이 쓴다
const prepared = new Map<string, string>();

type Prep = { phase: "checking" | "fetching" | "ready" | "error"; line: string; error: string; base: string };

/** head·base 커밋이 로컬에 있는지 보고(cat-file) 없으면 `git fetch <원격> refs/pull/N/head [base 브랜치]`로 객체만 받는다(FETCH_HEAD, 로컬 ref 없음).
 *  병합 기준 커밋을 돌려주고 `repo+headSha`별로 캐시한다. 변경 파일 탭(usePrepare)과 AI 리뷰(ops.aiReviewPr)가 함께 쓴다. `alive`가 false가 되면 호출자가 결과를 버린다 */
export async function ensurePrepared(repo: string, remote: string, pr: InboxPr, d: PrDetail, hooks: { /** false가 되면(화면이 사라짐·다시 시작) 받기 전에 그만둔다 */ alive?: () => boolean; onFetch?: () => void; onLine?: (l: string) => void; job?: { id: number | null } } = {}): Promise<string> {
  const key = `${repo}\0${d.headSha}`;
  const cached = prepared.get(key);
  if (cached) return cached;
  const has = (sha: string) => api.git(repo, ["cat-file", "-e", `${sha}^{commit}`]).then(() => true, () => false);
  const [h, b] = await Promise.all([has(d.headSha), has(d.baseSha)]);
  if (hooks.alive && !hooks.alive()) throw new Error("cancelled");
  if (!h || !b) {
    hooks.onFetch?.();
    // "--" 뒤에 원격: 이름이 "-"로 시작해도 옵션이 되지 않는다. base에 ":"가 있으면(src:dst refspec) 받지 않는다
    const args = ["fetch", "--no-tags", "--progress", "--", remote, `refs/pull/${pr.number}/head`, ...(b || pr.base.includes(":") ? [] : [`refs/heads/${pr.base}`])];
    await runJob(repo, args, hooks.onLine ?? (() => {}), hooks.job ?? { id: null });
  }
  const mb = (await api.git(repo, ["merge-base", d.baseSha, d.headSha]).catch(() => "")).trim() || d.baseSha;
  prepared.set(key, mb);
  return mb;
}

const fileDiffs = new Map<string, Promise<string>>();
/** 한 파일의 병합 기준..head diff(AI 코멘트 카드의 코드 조각용). 같은 파일은 한 번만 읽는다. 준비가 안 됐거나 읽기에 실패하면 reject(실패는 캐시하지 않는다) */
export function prFileDiff(repo: string, headSha: string, path: string): Promise<string> {
  const base = prepared.get(`${repo}\0${headSha}`);
  if (!base) return Promise.reject(new Error("not prepared"));
  const k = `${repo}\0${headSha}\0${path}`;
  let p = fileDiffs.get(k);
  if (!p) {
    p = api.git(repo, ["diff", "--no-ext-diff", "-U5", base, headSha, "--", path]);
    fileDiffs.set(k, p);
    p.catch(() => fileDiffs.delete(k));
  }
  return p;
}

/** 변경 파일 탭의 준비 상태(확인 → 받기 → 준비 끝) */
function usePrepare(repo: string, remote: string, pr: InboxPr, d: PrDetail) {
  const [p, setP] = useState<Prep>({ phase: "checking", line: "", error: "", base: d.baseSha });
  const seq = useRef(0);
  const job = useRef<{ id: number | null }>({ id: null });
  const key = `${repo}\0${d.headSha}`;
  const run = useCallback(async () => {
    const mine = ++seq.current;
    const alive = () => mine === seq.current;
    const cached = prepared.get(key);
    if (cached) return setP({ phase: "ready", line: "", error: "", base: cached });
    setP({ phase: "checking", line: "", error: "", base: d.baseSha });
    try {
      const mb = await ensurePrepared(repo, remote, pr, d, {
        alive,
        onFetch: () => alive() && setP({ phase: "fetching", line: "", error: "", base: d.baseSha }),
        onLine: (line) => alive() && setP((s) => (s.phase === "fetching" ? { ...s, line } : s)),
        job: job.current,
      });
      if (alive()) setP({ phase: "ready", line: "", error: "", base: mb });
    } catch (e) {
      if (alive()) setP({ phase: "error", line: "", error: String(e instanceof Error ? e.message : e), base: d.baseSha });
    }
  }, [repo, remote, pr.number, pr.base, d.headSha, d.baseSha, key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    run();
    return () => {
      seq.current++;
      if (job.current.id !== null) api.cancelJob(job.current.id).catch(() => {});
    };
  }, [run]);
  return [p, run] as const;
}

type Loaded = { key: string; files: ChangedFile[]; add: number; del: number } | { key: string; error: string };

export function PrFiles({ repo, remote, pr, d, range, setRange, active, onBack, backLabel, menuReq = 0, reveal }: { repo: string; remote: string; pr: InboxPr; d: PrDetail; range: Range; setRange: (r: Range) => void; /** 보이는 탭인지(숨겨져 있어도 마운트는 유지) */ active: boolean; /** 타임라인·안내줄에서 넘어왔을 때만: 대화로 돌아가기 */ onBack?: () => void; /** 돌아가기 버튼 글자(기본 "대화로") */ backLabel?: string; /** 이 파일의 이 줄로 가라는 요청(AI 리뷰 "코드에서 보기"). seq가 바뀔 때마다 */ reveal?: DiffReveal; /** 올라가면 커밋별 메뉴를 연다(안내줄에서 범위를 못 정했을 때) */ menuReq?: number }) {
  countRender("PrFiles");
  useLocale();
  const [prep, retry] = usePrepare(repo, remote, pr, d);
  const ready = prep.phase === "ready";
  const base = prep.base;
  const [data, setData] = useState<Loaded | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ key: string; text: string } | null>(null);
  const [fileView, setFileView] = useState<"tree" | "list">(() => {
    try {
      return localStorage.getItem("fileView") === "list" ? "list" : "tree";
    } catch {
      return "tree";
    }
  });
  const [infoW, infoSplit] = useSplit("prfiles", 300, 200, 700, "x");
  const ignoreEol = useSyncExternalStore(onPrefs, () => pref("ignoreEol"));
  const ignoreWs = useSyncExternalStore(onPrefs, () => pref("ignoreWs"));

  // 범위가 바뀌면 파일 목록을 다시 읽는다 (늦은 응답은 seq로 폐기)
  const listSeq = useRef(0);
  const listKey = `${range ?? "all"}@${base}`;
  const loadList = useCallback(() => {
    if (!ready) return;
    const mine = ++listSeq.current;
    setData(null);
    setPicked(null);
    const q = ["-c", "core.quotepath=false"];
    const [names, nums] = range
      ? [api.changedFiles(repo, range), api.git(repo, [...q, "show", "--format=", "--numstat", "--diff-merges=first-parent", "-M", range])]
      : [api.git(repo, [...q, "diff", "--name-status", "-M", base, d.headSha]).then(parseStatus), api.git(repo, [...q, "diff", "--numstat", "-M", base, d.headSha])];
    Promise.all([names, nums]).then(
      ([files, n]) => mine === listSeq.current && setData({ key: listKey, files, ...(({ add, del }) => ({ add, del }))(sumNumstat(n)) }),
      (e) => mine === listSeq.current && setData({ key: listKey, error: String(e) }),
    );
  }, [ready, repo, range, base, d.headSha, listKey]);
  useEffect(() => {
    loadList();
    return () => void listSeq.current++;
  }, [loadList]);

  const files = data && "files" in data && data.key === listKey ? data.files : null;
  const wanted = reveal && files?.some((f) => f.path === reveal.file) ? reveal.file : null; // 목록이 다시 읽혀 picked가 비어도 요청 파일을 먼저 본다
  const file = picked ?? wanted ?? files?.[0]?.path ?? null;
  useEffect(() => void (reveal && setPicked(reveal.file)), [reveal?.seq]); // eslint-disable-line react-hooks/exhaustive-deps
  const cur = files?.find((f) => f.path === file) ?? null;

  const diffSeq = useRef(0);
  const diffKey = `${listKey}:${file}:${ignoreEol}:${ignoreWs}`;
  useEffect(() => {
    if (!files || !file) return;
    const mine = ++diffSeq.current;
    const q = range
      ? api.fileDiff(repo, range, file)
      : api.git(repo, ["diff", "--no-ext-diff", ...(ignoreEol ? ["--ignore-cr-at-eol"] : []), ...(ignoreWs ? ["-w"] : []), base, d.headSha, "--", ...(cur?.oldPath ? [cur.oldPath] : []), file]);
    q.then(
      (text) => mine === diffSeq.current && setDiff({ key: diffKey, text }),
      () => mine === diffSeq.current && setDiff({ key: diffKey, text: "" }),
    );
    return () => void diffSeq.current++;
  }, [files, file, diffKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 리뷰 스레드: 전체 변경 범위에서만 줄 아래 카드로 (커밋 범위에선 줄이 안 맞을 수 있다). 참조는 d가 같으면 그대로
  const notes = useMemo<DiffNote[]>(
    () => (range ? [] : d.reviewThreads.filter((th) => th.line != null).map((th) => ({ file: th.path, line: th.line!, kind: "thread" as const, text: th.comments[0]?.body ?? "", node: <ThreadCard th={th} /> }))),
    [d.reviewThreads, range],
  );
  const threadCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const th of d.reviewThreads) m.set(th.path, (m.get(th.path) ?? 0) + 1);
    return m;
  }, [d.reviewThreads]);

  const rows = useMemo(() => (files ? (fileView === "tree" ? toTree(files) : files.map((f) => ({ kind: "file" as const, name: f.path, depth: 0, file: f }))) : []), [files, fileView]);
  const nav = useMemo(() => neighbors(rows.flatMap((r) => (r.kind === "file" ? [r.file.path] : [])), file), [rows, file]);
  const image = useMemo(() => (file ? { repo, before: range ? `${range}^` : base, after: range ?? d.headSha } : undefined), [repo, range, base, d.headSha, file]);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => void revealSelected(listRef.current), [file]);
  const hasDiff = !!file && diff?.key === diffKey;
  useEffect(() => {
    if (!active) bigView.exit(); // 숨겨지면 크게 보기도 끝낸다
    bigView.setAvail(active && hasDiff);
  }, [hasDiff, active]);
  useEffect(() => () => (bigView.setAvail(false), bigView.exit()), []);

  const commits = useMemo(() => {
    const seen = new Set<string>();
    return d.timeline.filter((it) => it.kind === "commit" && it.sha && !seen.has(it.sha) && !!seen.add(it.sha)).sort((a, b) => a.at.localeCompare(b.at));
  }, [d.timeline]);
  const changeView = (v: "tree" | "list") => {
    setFileView(v);
    try {
      localStorage.setItem("fileView", v);
    } catch {}
  };

  const idx = range ? commits.findIndex((c) => c.sha === range) : -1;
  const cur_c = idx >= 0 ? commits[idx] : null;
  const title1 = (c: PrTimelineItem) => (c.body ?? "").split("\n")[0] || c.sha!.slice(0, 7);
  // 커밋별: 버튼 아래에 커밋 목록 메뉴(제목 · 짧은 sha · 상대 시각). 고른 커밋에 체크
  const scopeBtn = useRef<HTMLButtonElement>(null);
  const pickCommit = (e: React.MouseEvent<HTMLElement>) => openPicker(e.currentTarget);
  const openPicker = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    showMenu(commits.map((c) => ({ label: `${title1(c)} · ${c.sha!.slice(0, 7)} · ${relTime(c.at, intlTag())}`, checked: c.sha === range, action: () => setRange(c.sha!) })), { x: r.left, y: r.bottom + 2 });
  };

  const menuShown = useRef(0);
  useEffect(() => {
    if (!menuReq || menuReq === menuShown.current || !active || !commits.length || !scopeBtn.current) return;
    menuShown.current = menuReq;
    openPicker(scopeBtn.current);
  }, [menuReq, active, commits]); // eslint-disable-line react-hooks/exhaustive-deps

  const body = () => {
    if (prep.phase === "checking") return <p className="prr-note">{t("prr.files.checking")}</p>;
    if (prep.phase === "fetching")
      return (
        <p className="prr-note" role="status">
          {t("prr.files.fetching")}
          {prep.line && <span className="hint">{prep.line}</span>}
        </p>
      );
    if (prep.phase === "error")
      return (
        <div className="prr-note" role="alert">
          <p>{t("prr.files.fetchFail")}</p>
          <p className="hint selectable">{prep.error}</p>
          <button onClick={retry}>{t("prr.retry")}</button>
        </div>
      );
    if (!data) return <p className="prr-note">{t("prr.files.loading")}</p>;
    if ("error" in data)
      return (
        <div className="prr-note" role="alert">
          <p className="selectable">{data.error}</p>
          <button onClick={loadList}>{t("prr.retry")}</button>
        </div>
      );
    return null;
  };
  const status = body();

  return (
    <div className="prr-files">
      <div className="prr-files-bar">
        {onBack && (
          <button className="prr-back" onClick={onBack} title={`${backLabel ?? t("prr.files.back")} (${isMac ? "⌘[" : "Ctrl+["})`}>
            {backLabel ?? t("prr.files.back")}
          </button>
        )}
        <div className="segmented prr-scope" role="radiogroup" aria-label={t("prr.files.range")}>
          <button role="radio" aria-checked={range === null} onClick={() => setRange(null)}>{t("prr.files.all")}</button>
          <button ref={scopeBtn} role="radio" aria-checked={range !== null} disabled={!commits.length} title={t("prr.files.pickCommit")} onClick={pickCommit}>
            <span className="prr-scope-name">{range ? (cur_c ? title1(cur_c) : range.slice(0, 7)) : t("prr.files.byCommit")}</span>
            <Icon name="dropdown" size={10} />
          </button>
        </div>
        {range && (
          <span className="prr-step">
            <button className="prr-icon" disabled={idx <= 0} title={t("prr.files.prev")} aria-label={t("prr.files.prev")} onClick={() => setRange(commits[idx - 1].sha!)}><Icon name="chevronLeft" size={14} /></button>
            <button className="prr-icon" disabled={idx < 0 || idx >= commits.length - 1} title={t("prr.files.next")} aria-label={t("prr.files.next")} onClick={() => setRange(commits[idx + 1].sha!)}><Icon name="chevronRight" size={14} /></button>
            {idx >= 0 && <span className="hint">{idx + 1}/{commits.length}</span>}
          </span>
        )}
        {range && d.reviewThreads.length > 0 && <span className="hint">{t("prr.files.commitHide")}</span>}
        {range && data && "files" in data && data.key === listKey && <span className="hint prr-files-sum">{t("prr.files.sum", { n: data.files.length, a: data.add, d: data.del })}</span>}
      </div>
      {status ? (
        status
      ) : (
        <DiffFrame
          split={infoSplit}
          side={
            <div className="info prr-fileside" style={{ width: infoW }}>
              <div className="files-head">
                <div className="segmented" role="radiogroup" aria-label={t("details.fileView")}>
                  {(["tree", "list"] as const).map((v) => (
                    <button key={v} role="radio" aria-checked={fileView === v} onClick={() => changeView(v)}>
                      {v === "tree" ? t("details.tree") : t("details.list")}
                    </button>
                  ))}
                </div>
              </div>
              {files && !files.length && <p className="prr-note">{t("prr.files.empty")}</p>}
              <ul ref={listRef} className="files" role="listbox" aria-label={t("details.changedFilesLabel")}>
                {rows.map((r, i) =>
                  r.kind === "dir" ? (
                    <li key={"d" + i} className="dir" style={{ paddingLeft: 4 + r.depth * 14 }}>
                      <span className="status">▾</span>
                      {r.name}
                    </li>
                  ) : (
                    <li
                      key={r.file.path}
                      role="option"
                      aria-selected={r.file.path === file}
                      className={r.file.path === file ? "selected" : ""}
                      style={{ paddingLeft: 4 + r.depth * 14 }}
                      title={r.file.path}
                      onMouseDown={() => setPicked(r.file.path)}
                      onDoubleClick={() => bigView.enter()}
                      onContextMenu={contextMenu(() => [{ label: t("diff.big"), action: () => (setPicked(r.file.path), bigView.enter(true)) }])}
                    >
                      <span className={`status s-${r.file.status}`}>{r.file.status}</span>
                      <span className="label">{r.name}</span>
                      {!range && threadCount.has(r.file.path) && (
                        <span className="prr-tcount" title={t("prr.files.threads", { n: threadCount.get(r.file.path)! })}>
                          {threadCount.get(r.file.path)}
                        </span>
                      )}
                    </li>
                  ),
                )}
              </ul>
            </div>
          }
        >
          <div className="diff-wrap">
            {hasDiff ? <DiffView diff={diff!.text} rev={range ?? d.headSha} image={image} notes={notes} reveal={reveal} /> : <div className="prr-empty">{file ? t("prr.files.loading") : files ? "" : t("prr.files.pick")}</div>}
            {active && <FileNav {...nav} go={setPicked} />}
          </div>
        </DiffFrame>
      )}
    </div>
  );
}

const longBody = (s: string) => s.length > 180 || s.split("\n").length > 3; // 카드 안 3줄 미리보기를 넘길 만한 코멘트

/** 리뷰 스레드 카드(diff 줄 아래, 줄 맥락이 중요해 인라인 유지). 해결됨은 접힌 한 줄(흐리게). 긴 코멘트는 3줄 미리보기 + "전체 보기"로 팝업(스레드의 코멘트를 이전/다음으로) */
function ThreadCard({ th }: { th: PrThread }) {
  useLocale();
  const [open, setOpen] = useState(!th.resolved);
  const key = `th:${th.path}:${th.line}`;
  const items = (): PopItem[] => th.comments.map((c, i) => ({ author: c.author, avatar: c.avatar, kind: t("prr.comment"), at: c.at, body: c.body, where: `${th.path}:${th.line ?? ""}`, ref: longBody(c.body) ? `${key}:${i}` : undefined }));
  return (
    <div className={`prr-thread${th.resolved ? " resolved" : ""}`}>
      {th.resolved && (
        <button className="prr-fold-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
          <strong>{t("prr.files.resolved")}</strong>
          <span className="hint">{th.comments[0]?.author} · {t("prr.files.comments", { n: th.comments.length })}</span>
        </button>
      )}
      {open &&
        th.comments.map((c, i) => {
          const long = longBody(c.body);
          return (
            <div key={i} className="prr-tc">
              <div><strong>{c.author}</strong> <time className="hint" dateTime={c.at}>{relTime(c.at, intlTag())}</time></div>
              <Markdown text={c.body} className={long ? "md-clamp" : undefined} lines={3} />
              {long && <button className="prr-more" data-pop={`${key}:${i}`} aria-haspopup="dialog" onClick={() => prPopup.open(items(), i)}>{t("prr.pop.full")}</button>}
            </div>
          );
        })}
    </div>
  );
}
