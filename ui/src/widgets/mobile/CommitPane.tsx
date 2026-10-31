import { Fragment, memo, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { api } from "../../shared/api/api";
import type { ChangedFile, Commit } from "../../shared/api/types";
import { DiffView } from "../../entities/diff/DiffView";
import { fileMenu } from "../../features/inspect/fileMenu";
import { dateFmt, t, useLocale } from "../../shared/i18n/i18n";
import { compile, linkify, type IssueRule } from "../../shared/lib/issues";
import { onPrefs, pref } from "../../shared/lib/settings";
import { countRender } from "../../shared/lib/profile";
import { ctx, ops } from "../../shared/model/ops";
import { Avatar, requestAvatars } from "../../shared/ui/avatar";
import { Icon } from "../../shared/ui/Icon";
import { contextMenu } from "../../shared/ui/menu";
import { neighbors } from "../../shared/ui/FileNav";
import { Sha } from "../../shared/ui/Sha";
import { MessageBody, parseCoAuthors, splitMessage } from "../details/Details";

const DATE_OPTS: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

interface Props {
  repo: string;
  commit: Commit | null;
  rules: IssueRule[];
  /** 보고 있는 파일: 있으면 diff 화면, 없으면 커밋 상세 */
  file: string | null;
  /** 왼쪽 위 ← 를 둔다(폰은 항상, 태블릿은 diff일 때만) */
  back: boolean;
  onBack: () => void;
  onFile: (path: string) => void;
}

/**
 * 모바일 커밋 상세(제목·본문·작성자·sha·부모·변경 파일)와 파일 diff(한 줄 모드 전체 화면, ← 파일명 ‹ ›).
 * 폰은 화면 한 장, 태블릿은 오른쪽 칸. 데이터는 Details와 같은 IPC(변경 파일·메시지·공동 작성자). 선택 커밋·파일이 바뀔 때만 다시 그린다.
 */
export const CommitPane = memo(function CommitPane({ repo, commit, rules, file, back, onBack, onFile }: Props) {
  useLocale();
  countRender("MobilePane");
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [body, setBody] = useState("");
  const [coAuthors, setCoAuthors] = useState<{ name: string; email: string }[]>([]);
  const [diff, setDiff] = useState("");
  const ignoreEol = useSyncExternalStore(onPrefs, () => pref("ignoreEol"));
  const ignoreWs = useSyncExternalStore(onPrefs, () => pref("ignoreWs"));
  const id = commit?.id;

  useEffect(() => {
    setFiles([]);
    setBody("");
    setCoAuthors([]);
    if (!commit) return;
    let live = true;
    api.changedFiles(repo, commit.id).then((f) => live && setFiles(f), (e) => ctx.error(String(e)));
    api.commitMessage(repo, commit.id).then((m) => live && setBody(m), () => {});
    api.coAuthors(repo, commit.id).then((l) => live && setCoAuthors(parseCoAuthors(l)), () => {});
    requestAvatars(repo, [commit]);
    return () => void (live = false);
  }, [repo, id]);

  useEffect(() => {
    setDiff("");
    if (!id || !file) return;
    let live = true;
    api.fileDiff(repo, id, file).then((d) => live && setDiff(d), (e) => ctx.error(String(e)));
    return () => void (live = false);
  }, [repo, id, file, ignoreEol, ignoreWs]);

  const compiled = useMemo(() => compile(rules), [rules]);
  const subject = useMemo(() => (commit ? linkify(commit.subject, compiled) : []), [commit?.subject, compiled]);
  const msg = useMemo(() => splitMessage(body), [body]);
  const nav = useMemo(() => neighbors(files.map((f) => f.path), file), [files, file]);
  const image = useMemo(() => (commit ? { repo, before: `${commit.id}^`, after: commit.id } : undefined), [repo, id]);

  if (!commit) return <section className="m-pane"><div className="m-empty">{t("details.empty")}</div></section>;

  if (file)
    return (
      <section className="m-pane" aria-label={t("details.commit")}>
        <header className="m-bar">
          <button className="m-ico" aria-label={t("m.back")} onClick={onBack}><Icon name="chevronLeft" size={22} /></button>
          <span className="m-bar-title" title={file}>{baseName(file)}</span>
          <button className="m-ico" aria-label={t("diff.prevFile")} disabled={nav.prev === undefined} onClick={() => onFile(nav.prev!)}><Icon name="chevronLeft" size={20} /></button>
          <button className="m-ico" aria-label={t("diff.nextFile")} disabled={nav.next === undefined} onClick={() => onFile(nav.next!)}><Icon name="chevronRight" size={20} /></button>
        </header>
        <div className="m-diff"><DiffView diff={diff} rev={commit.id} image={image} bigCtl={null} /></div>
      </section>
    );

  return (
    <section className="m-pane" aria-label={t("details.commit")}>
      <header className="m-bar">
        {back && <button className="m-ico" aria-label={t("m.back")} onClick={onBack}><Icon name="chevronLeft" size={22} /></button>}
        <span className="m-bar-title">{t("details.commit")} <Sha id={commit.id} /></span>
      </header>
      <div className="m-scroll">
        <h2 className="m-subject selectable">
          {subject.map((p, i) => (typeof p === "string" ? p : <a key={i} className="issue-link" href={p.url} onClick={(e) => (e.preventDefault(), ops.openUrl(p.url))}>{p.text}</a>))}
        </h2>
        {(msg.body || msg.trailers.length > 0) && <div className="m-body selectable"><MessageBody body={msg.body} trailers={msg.trailers} rules={compiled} /></div>}
        <div className="m-who">
          <Avatar name={commit.author} email={commit.email} size={40} />
          <div>
            <div className="m-name">{commit.author}</div>
            <div className="muted">{dateFmt(DATE_OPTS).format(commit.time * 1000)}</div>
          </div>
        </div>
        {coAuthors.map((a) => (
          <div key={a.email} className="m-co muted">{t("details.coAuthor")} <b>{a.name}</b></div>
        ))}
        <div className="m-shas muted">
          <span>{t("details.commit")} <Sha id={commit.id} /></span>
          <span>{t("details.parents")} {commit.parents.length ? commit.parents.map((p, i) => <Fragment key={p}>{i > 0 && ", "}<Sha id={p} className="sha" /></Fragment>) : t("common.none")}</span>
        </div>
        <h3 className="m-files-head">{t("details.changedFiles", { n: files.length })}</h3>
        <ul className="m-files" aria-label={t("details.changedFilesLabel")}>
          {files.map((f) => (
            <li key={f.path}>
              <button onClick={() => onFile(f.path)} onContextMenu={contextMenu(() => fileMenu(f.path, commit.id))}>
                <span className={`status s-${f.status}`}>{f.status}</span>
                <span className="m-fname">{baseName(f.path)}</span>
                <span className="m-fdir">{f.path.slice(0, Math.max(0, f.path.lastIndexOf("/")))}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
});
