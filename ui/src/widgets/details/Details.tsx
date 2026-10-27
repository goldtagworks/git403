import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Sha } from "../../shared/ui/Sha";
import { t, dateFmt, useLocale } from "../../shared/i18n/i18n";
import { onPrefs, pref } from "../../shared/lib/settings";
import { countRender } from "../../shared/lib/profile";
import { api } from "../../shared/api/api";
import { compile, linkify, type Compiled, type IssueRule } from "../../shared/lib/issues";
import type { ChangedFile, Commit } from "../../shared/api/types";
import { toTree, type FileRow } from "../../shared/lib/fileTree";
import { useSplit } from "../../shared/ui/Splitter";
import { DiffView } from "../../entities/diff/DiffView";
import { inspect } from "../../features/inspect/Inspector";
import { fileMenu } from "../../features/inspect/fileMenu";
import { contextMenu } from "../../shared/ui/menu";
import { ctx, ops } from "../../shared/model/ops";
import { Avatar, requestAvatars } from "../../shared/ui/avatar";
import { applyReword, joinMessage, rewordPlan, splitSubject, startReword } from "../../features/rebase/Reword";
import { Icon } from "../../shared/ui/Icon";
import { FileNav, neighbors, revealSelected } from "../../shared/ui/FileNav";
import { IS_VSCODE } from "../../shared/api/bridge";
import { DiffFrame } from "../../shared/ui/DiffFrame";
import { bigView } from "../../shared/model/bigview";
import { GuidePanel, GuideTabs, useGuideView } from "../../features/ai/GuidePanel";

type FileView = "tree" | "list";
const savedView = (): FileView => {
  try {
    return localStorage.getItem("fileView") === "list" ? "list" : "tree";
  } catch {
    return "tree";
  }
};

const DATE_OPTS: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };

/** 선택한 커밋의 정보 · 변경 파일 · diff. right: 오른쪽 상세 열(GitKraken식 메시지 상자 + 가로 분할선 + 바로 고치기) */
export const Details = memo(function Details({ repo, commit, rules, right }: { repo: string; commit: Commit | null; rules: IssueRule[]; right?: boolean }) {
  countRender("Details");
  useLocale();
  const [files, setFiles] = useState<ChangedFile[]>([]);
  // null이면 기본: 본문 있는 커밋은 메시지, 아니면 첫 파일
  const [picked, setFile] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  const [infoW, infoSplit] = useSplit("details", 340, 200, 900, "x");
  const [msgH, msgSplit] = useSplit("detail-msg", 240, 60, 900, "y");
  // 오른쪽 열에서 메시지를 바로 고치는 중이면 [제목, 본문]
  const [edit, setEdit] = useState<[string, string] | null>(null);
  const [saving, setSaving] = useState(false);
  const [fileView, setFileView] = useState<FileView>(savedView);
  const changeView = (v: FileView) => {
    setFileView(v);
    try {
      localStorage.setItem("fileView", v);
    } catch {}
  };

  const ignoreEol = useSyncExternalStore(onPrefs, () => pref("ignoreEol"));
  const ignoreWs = useSyncExternalStore(onPrefs, () => pref("ignoreWs"));

  useEffect(() => {
    setEdit(null);
    setFiles([]);
    setFile(null);
    setDiff("");
    if (commit) api.changedFiles(repo, commit.id).then(setFiles, (e) => ctx.error(String(e))); // 실패를 "변경 파일 없음"으로 보이지 않게 알린다
  }, [repo, commit?.id]);

  useEffect(() => void (commit && requestAvatars(repo, [commit])), [repo, commit]);


  // 이슈 링크: 규칙·제목이 바뀔 때만 계산한다 (잘못된 정규식은 compile이 건너뜀)
  const compiled = useMemo(() => compile(rules), [rules]);
  const subject = useMemo(() => (commit ? linkify(commit.subject, compiled) : []), [commit?.subject, compiled]);
  // 공동 작성자: 그래프의 body는 앞부분만이라 트레일러는 따로 읽는다
  const [coAuthors, setCoAuthors] = useState<{ name: string; email: string }[]>([]);
  useEffect(() => {
    setCoAuthors([]);
    if (!commit) return;
    let live = true;
    api.coAuthors(repo, commit.id).then((list) => live && setCoAuthors(parseCoAuthors(list)), () => {});
    return () => void (live = false);
  }, [repo, commit?.id]);
  // 본문: 그래프 body는 한 줄로 합친 앞부분이라 전체 메시지를 따로 읽는다 (첫 빈 줄 뒤가 본문)
  const [body, setBody] = useState("");
  useEffect(() => {
    setBody("");
    if (!commit) return;
    let live = true;
    api.commitMessage(repo, commit.id).then((m) => live && setBody(m), () => {});
    return () => void (live = false);
  }, [repo, commit?.id]);
  // 사진은 GitHub noreply 주소만 (커밋 sha로 찾으면 커밋 작성자 사진이 나온다)
  useEffect(() => {
    const gh = coAuthors.filter((a) => a.email.endsWith("@users.noreply.github.com"));
    if (commit && gh.length) requestAvatars(repo, gh.map((a) => ({ ...commit, author: a.name, email: a.email })));
  }, [coAuthors]);
  // 커밋한 사람: 작성자와 다를 때만 보인다 (리베이스·웹 머지 등)
  const [committer, setCommitter] = useState<[string, string, number] | null>(null);
  useEffect(() => {
    setCommitter(null);
    if (!commit) return;
    let live = true;
    api.committer(repo, commit.id).then((c) => live && setCommitter(c), () => {});
    return () => void (live = false);
  }, [repo, commit?.id]);
  const otherCommitter = committer && (committer[0] !== commit?.author || committer[1] !== commit?.email) ? committer : null;
  // 본문 첫 줄 미리보기 (트레일러뿐이면 트레일러 첫 줄). 누르면 diff 자리에 메시지 전체
  const msg = useMemo(() => splitMessage(body), [body]);
  const preview = msg.body.split("\n")[0] || (msg.trailers[0] ? `${msg.trailers[0][0]}: ${msg.trailers[0][1]}` : "");
  const hasMessage = !!preview;
  const file = picked ?? (hasMessage ? MSG : files[0]?.path ?? null);
  useEffect(() => {
    if (commit && file && file !== MSG) api.fileDiff(repo, commit.id, file).then(setDiff, (e) => ctx.error(String(e)));
  }, [repo, commit?.id, file, ignoreEol, ignoreWs]);
  const rows = useMemo(() => (fileView === "tree" ? toTree(files) : files.map(asListRow)), [files, fileView]);

  const nav = useMemo(
    () => neighbors([...(hasMessage ? [MSG] : []), ...rows.flatMap((r) => (r.kind === "file" ? [r.file.path] : []))], file),
    [rows, file, hasMessage],
  );
  // 이미지 diff: 이전 = 부모, 이후 = 이 커밋 (이름 변경이면 옛 경로는 DiffView가 diff 머리에서 읽는다)
  const image = useMemo(() => (commit ? { repo, before: `${commit.id}^`, after: commit.id } : undefined), [repo, commit?.id]);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => void revealSelected(listRef.current), [file]);
  // AI 읽는 흐름 가이드(25d): 커밋별로 캐시, 단계 이동은 파일 선택 + diff 주석만 바꾼다
  const gv = useGuideView(commit ? `commit:${repo}:${commit.id}` : null);
  const startGuide = useCallback(() => ops.aiGuideCommit(repo, commit!.id), [repo, commit?.id]);

  // 크게 볼 diff가 있는지(파일 diff를 보는 중) 알린다. 닫힘 판단은 저장소·선택이 없어질 때만 App이 한다
  useEffect(() => bigView.setAvail(!!commit && !!file && file !== MSG), [!!commit, file]);
  useEffect(() => () => bigView.setAvail(false), []);
  const onInspect = useCallback((kind: "blame" | "history", path: string) => (kind === "blame" ? inspect.blame(path, commit?.id ?? null) : inspect.history(path)), [commit?.id]);

  if (!commit) return <div className="details empty">{t("details.empty")}</div>;

  return (
    <DiffFrame
      split={infoSplit}
      side={
      <div className={"info" + (gv.open ? " guide-on" : "")} style={{ width: infoW }}>
        {gv.open && (
          <div className="info-brief" title={commit.subject}>
            <span className="brief-subject">{commit.subject}</span>
            <Sha id={commit.id} className="sha muted" />
            <span className="brief-who">{commit.author}</span>
          </div>
        )}
        {!gv.open && right && (
          <>
          <div className="info-head muted">{t("details.commit")} <Sha id={commit.id} /></div>
          <div className={"msg-box" + (edit ? " editing" : "")} style={{ height: msgH }} onClick={(e) => !edit && !(e.target as HTMLElement).closest("a") && !getSelection()?.toString() && setEdit(splitSubject(body || commit.subject))}>
            {edit ? (
              <>
                <div className="msg-box-subject">
                  <input aria-label={t("reword.subject")} value={edit[0]} autoFocus onChange={(e) => setEdit([e.target.value, edit[1]])} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setEdit(null))} />
                  <span className="msg-count muted">{edit[0].length}</span>
                </div>
                <textarea aria-label={t("reword.body")} placeholder={t("reword.body")} value={edit[1]} onChange={(e) => setEdit([edit[0], e.target.value])} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setEdit(null))} />
              </>
            ) : (
              <>
                <div className="msg-box-subject selectable" title={t("reword.title")}>
                  <span>{subject.map((p, i) => (typeof p === "string" ? p : <a key={i} className="issue-link" href={p.url} title={p.url} onClick={(e) => (e.preventDefault(), ops.openUrl(p.url))}>{p.text}</a>))}</span>
                  <span className="msg-count muted">{commit.subject.length}</span>
                </div>
                {hasMessage && <div className="info-body selectable"><MessageBody body={msg.body} trailers={msg.trailers} rules={compiled} /></div>}
              </>
            )}
          </div>
          {msgSplit}
          {edit && (
            <div className="msg-actions">
              <button className="primary" disabled={saving || !edit[0].trim() || joinMessage(...edit) === joinMessage(...splitSubject(body || commit.subject))} onClick={async () => {
                const plan = rewordPlan(commit.id);
                if (!plan) return;
                setSaving(true);
                if (await applyReword(plan, joinMessage(...edit))) setEdit(null);
                setSaving(false);
              }}>{t("reword.run")}</button>
              <button onClick={() => setEdit(null)}>{t("common.cancel")}</button>
            </div>
          )}
          <div className="people">
            <div className="person profile">
              <Avatar name={commit.author} email={commit.email} size={44} />
              <div className="profile-text">
                <span className="name" title={`${commit.author} <${commit.email}>`}>{commit.author}</span>
                <span className="muted">{t("details.authored", { when: dateFmt(DATE_OPTS).format(commit.time * 1000) })}</span>
              </div>
              <span className="muted when">{t("details.parents")} {commit.parents.length ? commit.parents.map((p, i) => <Fragment key={p}>{i > 0 && ", "}<Sha id={p} className="" /></Fragment>) : t("common.none")}</span>
            </div>
            {coAuthors.map((a) => (
              <div key={a.email} className="person sub" title={`${a.name} <${a.email}>`}>
                <Avatar name={a.name} email={a.email} size={16} />
                <span className="muted">{t("details.coAuthor")}</span>
                <span className="name">{a.name}</span>
              </div>
            ))}
            {otherCommitter && (
              <div className="person sub" title={`${otherCommitter[0]} <${otherCommitter[1]}>`}>
                <Avatar name={otherCommitter[0]} email={otherCommitter[1]} size={16} />
                <span className="muted">{t("details.committedBy")}</span>
                <span className="name">{otherCommitter[0]}</span>
                <span className="muted when">{dateFmt(DATE_OPTS).format(otherCommitter[2] * 1000)}</span>
              </div>
            )}
          </div>
          </>
        )}
        {!gv.open && !right && (
          <>
          <div className={"info-msg" + (file === MSG ? " selected" : "")}>
            <div className="info-subject selectable" title={commit.subject}>
              {subject.map((p, i) =>
                typeof p === "string" ? p : (
                  <a key={i} className="issue-link" href={p.url} title={p.url} onClick={(e) => (e.preventDefault(), ops.openUrl(p.url))}>{p.text}</a>
                ),
              )}
            </div>
            <button className="info-edit" title={t("reword.title")} aria-label={t("reword.title")} onClick={() => void startReword(commit.id)}>
              <Icon name="edit" size={12} />
            </button>
            {hasMessage && (
              <button className="info-preview" title={t("details.showMessage")} onClick={() => setFile(MSG)}>
                <span>{preview}</span>
                <Icon name="openOut" size={12} />
              </button>
            )}
          </div>
          <div className="people">
            <div className="person">
              <Avatar name={commit.author} email={commit.email} size={20} />
              <span className="name" title={`${commit.author} <${commit.email}>`}>{commit.author}</span>
              <span className="muted when">{dateFmt(DATE_OPTS).format(commit.time * 1000)}</span>
            </div>
            {coAuthors.map((a) => (
              <div key={a.email} className="person sub" title={`${a.name} <${a.email}>`}>
                <Avatar name={a.name} email={a.email} size={16} />
                <span className="muted">{t("details.coAuthor")}</span>
                <span className="name">{a.name}</span>
              </div>
            ))}
            {otherCommitter && (
              <div className="person sub" title={`${otherCommitter[0]} <${otherCommitter[1]}>`}>
                <Avatar name={otherCommitter[0]} email={otherCommitter[1]} size={16} />
                <span className="muted">{t("details.committedBy")}</span>
                <span className="name">{otherCommitter[0]}</span>
                <span className="muted when">{dateFmt(DATE_OPTS).format(otherCommitter[2] * 1000)}</span>
              </div>
            )}
          </div>
          <div className="info-sha muted">
            <span>{t("details.commit")} <Sha id={commit.id} /></span>
            <span>{t("details.parents")} {commit.parents.length ? commit.parents.map((p, i) => <Fragment key={p}>{i > 0 && ", "}<Sha id={p} className="" /></Fragment>) : t("common.none")}</span>
          </div>
          </>
        )}
        <GuideTabs />
        {gv.open ? (
          <GuidePanel gkey={`commit:${repo}:${commit.id}`} start={startGuide} go={setFile} />
        ) : (
          <>
        <div className="files-head">
          <span>{t("details.changedFiles", { n: files.length })}</span>
          <div className="segmented" role="radiogroup" aria-label={t("details.fileView")}>
            {(["tree", "list"] as const).map((v) => (
              <button key={v} role="radio" aria-checked={fileView === v} onClick={() => changeView(v)}>
                {v === "tree" ? t("details.tree") : t("details.list")}
              </button>
            ))}
          </div>
        </div>
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
                onMouseDown={() => (setFile(r.file.path), bigView.picked())}
                onDoubleClick={IS_VSCODE ? () => ops.openInEditor(r.file.path, commit.id) : () => bigView.enter()}
                onContextMenu={contextMenu(() => [{ label: t("diff.big"), action: () => (setFile(r.file.path), bigView.enter(true)) }, { separator: true }, ...fileMenu(r.file.path, commit.id)])}
              >
                <span className={`status s-${r.file.status}`}>{r.file.status}</span>
                {r.name}
              </li>
            ),
          )}
        </ul>
          </>
        )}
      </div>
      }
    >
      <div className="diff-wrap">
        {file === MSG ? <MessageView message={body} rules={compiled} /> : <DiffView diff={diff} rev={commit.id} image={image} notes={gv.notes} current={gv.current} reveal={gv.reveal} onInspect={onInspect} />}
        <FileNav {...nav} go={setFile} />
      </div>
    </DiffFrame>
  );
});

/** 전체 메시지 → 본문(제목 다음 문단부터)과 끝의 트레일러(`키: 값`만 있는 문단들). 공동 작성자는 사진으로 따로 보인다. */
function splitMessage(msg: string) {
  const paras = msg.split(/\n\s*\n/).slice(1);
  const trailers: [string, string][] = [];
  while (paras.length) {
    const lines = paras[paras.length - 1].trim().split("\n");
    const kv = lines.map((l) => /^([\w-]+):\s+(\S.*)$/.exec(l.trim()));
    if (!kv.every(Boolean)) break;
    paras.pop();
    trailers.unshift(...kv.filter((m) => m![1].toLowerCase() !== "co-authored-by").map((m) => [m![1], m![2]] as [string, string]));
  }
  return { body: paras.join("\n\n").trim(), trailers };
}

/** 파일 목록의 "커밋 메시지" 항목 (파일 경로와 겹치지 않는 값) */
const MSG = "\0message";

const Linked = ({ text, rules }: { text: string; rules: Compiled[] }) => (
  <>
    {linkify(text, rules).map((p, i) =>
      typeof p === "string" ? p : <a key={i} className="issue-link" href={p.url} title={p.url} onClick={(e) => (e.preventDefault(), ops.openUrl(p.url))}>{p.text}</a>,
    )}
  </>
);

/** 커밋 메시지를 diff 자리(넓은 영역)에 문서처럼: 머리말·목록을 구분하고 트레일러는 아래 표로. */
function MessageView({ message, rules }: { message: string; rules: Compiled[] }) {
  const { body, trailers } = useMemo(() => splitMessage(message), [message]);
  return (
    <div className="msg-view selectable">
      <div className="diff-file">{t("details.message")}</div>
      <div className="msg-doc">
        <h3><Linked text={message.split("\n")[0]} rules={rules} /></h3>
        <MessageBody body={body} trailers={trailers} rules={rules} />
      </div>
    </div>
  );
}

/** 본문(머리말·목록 구분) + 트레일러 표. 메시지 화면과 오른쪽 상세 열(.info-body)이 같이 쓴다 */
function MessageBody({ body, trailers, rules }: { body: string; trailers: [string, string][]; rules: Compiled[] }) {
  return (
    <>
      {body.split("\n").map((l, i) => (
        <div key={i} className={/^\s*[-*•]\s/.test(l) ? "li" : /^\S.*:$/.test(l.trim()) ? "head" : undefined}>
          {l.trim() ? <Linked text={l.replace(/^\s*[-*•]\s/, "")} rules={rules} /> : "\u00a0"}
        </div>
      ))}
      {trailers.length > 0 && (
        <dl className="msg-trailers">
          {trailers.map(([k, v], i) => (
            <Fragment key={i}><dt>{k}</dt><dd><Linked text={v} rules={rules} /></dd></Fragment>
          ))}
        </dl>
      )}
    </>
  );
}

const asListRow = (f: ChangedFile): FileRow => ({ kind: "file", name: f.path, depth: 0, file: f });

/** `이름 <이메일>` 줄들 → 이메일 기준 중복 제거 */
function parseCoAuthors(lines: string[]): { name: string; email: string }[] {
  const seen = new Map<string, { name: string; email: string }>();
  for (const l of lines) {
    const m = /^(.*?)\s*<([^>]+)>/.exec(l);
    if (m) seen.set(m[2].toLowerCase(), { name: m[1] || m[2], email: m[2] });
  }
  return [...seen.values()];
}
