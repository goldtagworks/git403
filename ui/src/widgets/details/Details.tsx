import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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

/** 선택한 커밋의 정보 · 변경 파일 · diff (하단 패널). */
export const Details = memo(function Details({ repo, commit, rules }: { repo: string; commit: Commit | null; rules: IssueRule[] }) {
  countRender("Details");
  useLocale();
  const [files, setFiles] = useState<ChangedFile[]>([]);
  // null이면 기본: 본문 있는 커밋은 메시지, 아니면 첫 파일
  const [picked, setFile] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  const [infoW, infoSplit] = useSplit("details", 340, 200, 900, "x");
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
  const hasMessage = useMemo(() => {
    const m = splitMessage(body);
    return !!(m.body || m.trailers.length);
  }, [body]);
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
            <span className="sha muted">{commit.id.slice(0, 7)}</span>
            <span className="brief-who">{commit.author}</span>
          </div>
        )}
        {!gv.open && (
          <>
          <div className="info-subject selectable" title={commit.subject}>
            {subject.map((p, i) =>
              typeof p === "string" ? p : (
                <a key={i} className="issue-link" href={p.url} title={p.url} onClick={(e) => (e.preventDefault(), ops.openUrl(p.url))}>{p.text}</a>
              ),
            )}
          </div>
          <div className="profile">
            <Avatar name={commit.author} email={commit.email} size={40} />
            <div className="profile-who">
              <span className="name">{commit.author}</span>
              <span className="muted">{t("details.authored", { date: dateFmt(DATE_OPTS).format(commit.time * 1000) })}</span>
            </div>
            <span className="profile-parent muted">{t("details.parents")} <span className="sha selectable">{commit.parents.map((p) => p.slice(0, 7)).join(", ") || t("common.none")}</span></span>
          </div>
          {coAuthors.length > 0 && (
            <div className="co-authors">
              <span className="muted">{t("details.coAuthors")}</span>
              {coAuthors.map((a) => (
                <span key={a.email} title={`${a.name} <${a.email}>`}><Avatar name={a.name} email={a.email} size={20} /></span>
              ))}
            </div>
          )}
          <div className="info-sha muted">{t("details.commit")} <span className="sha selectable">{commit.id}</span></div>
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
          {hasMessage && (
            <li role="option" aria-selected={file === MSG} className={"msg-item" + (file === MSG ? " selected" : "")} onMouseDown={() => setFile(MSG)}>
              <Icon name="edit" size={14} />
              {t("details.message")}
            </li>
          )}
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
                onMouseDown={() => setFile(r.file.path)}
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
      </div>
    </div>
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
