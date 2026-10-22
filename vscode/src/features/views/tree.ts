// 사이드바 TreeView의 순수 로직 (vscode 비의존: 단위 테스트 가능).
// 데이터는 서버의 기존 명령(`load_refs`, `file_log`, `changed_files`, `git`)에서 온다 — docs/reuse.md "서버 프로토콜".

export type RefKind = "local" | "remote" | "tag" | "stash";
/** 서버 `load_refs`의 Ref */
export type Ref = { kind: RefKind; name: string; target: string; head: boolean; message?: string | null; ahead: number; behind: number };
/** 서버 `file_log`의 Commit 중 쓰는 필드 */
export type LogCommit = { id: string; author: string; email?: string; time: number; subject: string };

export type NodeKind = "repo" | "group" | "branch" | "remoteBranch" | "tag" | "stash" | "commit" | "message";
/** 트리 항목 설명. vscode TreeItem으로의 변환은 views.ts가 한다 */
export interface Node {
  id: string;
  kind: NodeKind;
  label: string;
  description?: string;
  tooltip?: string;
  /** codicon 이름 (ThemeIcon) */
  icon: string;
  /** 아이콘 색: 테마 색 토큰 id (예: charts.green). 없으면 기본 */
  color?: string;
  open: "none" | "collapsed" | "expanded";
  /** package.json의 `view/item/context` `viewItem`과 맞춘다 */
  context: string;
  sha?: string;
  /** 복사·체크아웃에 쓰는 ref 이름 */
  name?: string;
  children?: Node[];
  /** 커밋 항목: 비교할 파일(저장소 상대 경로) */
  path?: string;
  /** 이 항목이 속한 저장소 (views.ts가 채운다) */
  repo?: string;
}

const byName = (a: Ref, b: Ref) => a.name.localeCompare(b.name, undefined, { numeric: true });
const short = (sha: string) => sha.slice(0, 8);

/** `↑2 ↓1` (둘 다 0이면 빈 문자열) */
export function trackText(r: Pick<Ref, "ahead" | "behind">): string {
  return [r.ahead ? `↑${r.ahead}` : "", r.behind ? `↓${r.behind}` : ""].filter(Boolean).join(" ");
}

/** 원격 추적 브랜치 `origin/feature/x` → {remote:"origin", branch:"feature/x"} */
export function splitRemote(name: string): { remote: string; branch: string } {
  const i = name.indexOf("/");
  return i < 0 ? { remote: name, branch: "" } : { remote: name.slice(0, i), branch: name.slice(i + 1) };
}

/** 로컬 브랜치 목록(현재 브랜치 먼저) + 원격별 그룹(이름순) */
export function groupBranches(refs: Ref[]): { local: Ref[]; remotes: { remote: string; branches: Ref[] }[] } {
  const local = refs.filter((r) => r.kind === "local").sort((a, b) => Number(b.head) - Number(a.head) || byName(a, b));
  const map = new Map<string, Ref[]>();
  for (const r of refs.filter((x) => x.kind === "remote").sort(byName)) {
    const { remote } = splitRemote(r.name);
    (map.get(remote) ?? map.set(remote, []).get(remote)!).push(r);
  }
  return { local, remotes: [...map].sort(([a], [b]) => a.localeCompare(b)).map(([remote, branches]) => ({ remote, branches })) };
}

export interface Labels {
  local: string;
  current: string;
}

export function branchNode(r: Ref, current: string): Node {
  const t = trackText(r);
  return {
    id: `b:${r.name}`,
    kind: "branch",
    label: r.name,
    description: t || undefined,
    tooltip: `${r.name}${r.head ? ` (${current})` : ""}\n${short(r.target)}${t ? `\n${t}` : ""}`,
    icon: r.head ? "check" : "git-branch",
    color: r.head ? "charts.green" : undefined,
    open: "none",
    context: r.head ? "git403.branch.current" : "git403.branch",
    sha: r.target,
    name: r.name,
  };
}

export function remoteBranchNode(r: Ref, showRemote: boolean): Node {
  return {
    id: `r:${r.name}`,
    kind: "remoteBranch",
    label: showRemote ? r.name : splitRemote(r.name).branch,
    tooltip: `${r.name}\n${short(r.target)}`,
    icon: "git-branch",
    open: "none",
    context: "git403.remoteBranch",
    sha: r.target,
    name: r.name,
  };
}

const group = (id: string, label: string, icon: string, open: Node["open"], children: Node[], description?: string): Node => ({ id, kind: "group", label, description, icon, open, context: "git403.group", children });

/** Branches 뷰: "Local" 그룹 + 원격별 그룹(접힘) */
export function branchesTree(refs: Ref[], l: Labels): Node[] {
  const { local, remotes } = groupBranches(refs);
  const out: Node[] = [];
  if (local.length) out.push(group("g:local", l.local, "repo", "expanded", local.map((r) => branchNode(r, l.current))));
  for (const { remote, branches } of remotes) out.push(group(`g:${remote}`, remote, "cloud", "collapsed", branches.map((r) => remoteBranchNode(r, false)), String(branches.length)));
  return out;
}

/**
 * 표시용 원격 URL에서 자격 증명을 가린다: 스킴 URL은 마지막 `@` 앞(`?`·`#` 앞까지)의 userinfo를 전부 제거(토큰에 `/`·`@`가 있어도),
 * scp 형식 `user:token@host:path`는 `user@host:path`, 쿼리·조각의 token·private_token·access_token 등 값은 `***`
 */
export function maskUrl(u: string): string {
  let out = u;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(out);
  if (scheme) {
    const head = out.slice(scheme[0].length).search(/[?#]/);
    const end = head < 0 ? out.length : scheme[0].length + head;
    const at = out.lastIndexOf("@", end);
    if (at >= scheme[0].length) out = scheme[0] + out.slice(at + 1);
  } else out = out.replace(/^([^@/:\s]+):[^/]*@/, "$1@");
  return out.replace(/([?&;#]\w*(?:token|password|passwd|secret|auth|apikey|api_key|key|sig|signature)\w*=)[^&#;]*/gi, "$1***");
}

/** `git remote -v` 출력 → 원격 이름 → fetch URL. 자격 증명은 `maskUrl`로 가린다 */
export function parseRemotes(out: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of out.split("\n")) {
    const x = /^(\S+)\t(.+?) \((fetch|push)\)$/.exec(line.trim().replace(/\s+/, "\t"));
    if (x && (x[3] === "fetch" || !m.has(x[1]))) m.set(x[1], maskUrl(x[2]));
  }
  return m;
}

/** Remotes 뷰: 원격(설명은 URL, 없으면 브랜치 수) → 브랜치. 브랜치를 아직 못 가져온 원격도 URL이 있으면 보인다 */
export function remotesTree(refs: Ref[], urls: ReadonlyMap<string, string> = new Map()): Node[] {
  const g = groupBranches(refs).remotes;
  const names = [...new Set([...g.map((x) => x.remote), ...urls.keys()])].sort((a, b) => a.localeCompare(b));
  return names.map((remote) => {
    const branches = g.find((x) => x.remote === remote)?.branches ?? [];
    const url = urls.get(remote);
    const n = group(`rm:${remote}`, remote, "cloud", branches.length ? "collapsed" : "none", branches.map((r) => remoteBranchNode(r, false)), url ?? String(branches.length));
    return url ? { ...n, tooltip: `${remote}\n${url}` } : n;
  });
}

export function tagsTree(refs: Ref[]): Node[] {
  return refs
    .filter((r) => r.kind === "tag")
    .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
    .map((r) => ({ id: `t:${r.name}`, kind: "tag" as const, label: r.name, description: short(r.target), tooltip: `${r.name}\n${r.target}`, icon: "tag", open: "none" as const, context: "git403.tag", sha: r.target, name: r.name }));
}

/** `On main: msg` / `WIP on main: abc1234 subject` → {branch, text} (모르는 형식이면 원문) */
export function parseStashMessage(msg: string): { branch: string | null; text: string } {
  const m = /^(?:WIP on|On) ([^:]+): ([\s\S]*)$/.exec(msg.trim());
  return m ? { branch: m[1], text: m[2] } : { branch: null, text: msg.trim() };
}

/** 스태시 이름 `stash@{3}` → 번호(아니면 null) */
export const stashIndex = (name: string) => /^stash@\{(\d+)\}$/.exec(name)?.[1] ?? null;

export function stashesTree(refs: Ref[]): Node[] {
  return refs
    .filter((r) => r.kind === "stash")
    .map((r) => {
      const { branch, text } = parseStashMessage(r.message ?? "");
      return { id: `s:${r.name}`, kind: "stash" as const, label: text || r.name, description: [r.name, branch].filter(Boolean).join(" · "), tooltip: `${r.name}\n${r.message ?? ""}`, icon: "archive", open: "none" as const, context: "git403.stash", sha: r.target, name: r.name };
    });
}

/** 스태시 작업의 git 인자. 번호가 아닌 이름은 거부한다 */
export function stashArgs(op: "apply" | "pop" | "drop", name: string): string[] | null {
  return stashIndex(name) === null ? null : ["stash", op, name];
}

/** 체크아웃 인자: 로컬은 `switch`, 원격 추적 브랜치는 `switch --track` */
export function checkoutArgs(kind: "branch" | "remoteBranch", name: string): string[] {
  return kind === "remoteBranch" ? ["switch", "--track", name] : ["switch", name];
}

export type Relative = (ts: number) => string;

/** File History / Line History 항목 (커밋 하나 = 항목 하나) */
export function commitNode(c: LogCommit, path: string, rel: Relative, idPrefix: string): Node {
  return {
    id: `${idPrefix}:${c.id}`,
    kind: "commit",
    label: c.subject || short(c.id),
    description: `${short(c.id)} · ${c.author} · ${rel(c.time)}`,
    tooltip: `${c.subject}\n${short(c.id)} ${c.author}${c.email ? ` <${c.email}>` : ""}`,
    icon: "git-commit",
    open: "none",
    context: "git403.commit",
    sha: c.id,
    path,
  };
}

/** `git log -L` 호출 인자 (`-s`로 diff 본문은 빼고 커밋 머리만 받는다) */
export const LINE_LOG_FORMAT = "%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s";
export function lineLogArgs(rel: string, start: number, end: number): string[] {
  return ["log", `-L${start},${end}:${rel}`, `--format=${LINE_LOG_FORMAT}`, "-s"];
}

/** `git log -L ... --format=LINE_LOG_FORMAT -s` 출력 → 커밋 목록 (깨진 레코드는 건너뜀) */
export function parseLineLog(out: string): LogCommit[] {
  const res: LogCommit[] = [];
  for (const rec of out.split("\x1e")) {
    const f = rec.trim().split("\x1f");
    if (f.length < 6 || !/^[0-9a-f]{7,64}$/.test(f[0])) continue;
    res.push({ id: f[0], author: f[2], email: f[3], time: Number(f[4]) || 0, subject: f.slice(5).join("\x1f").trim() });
  }
  return res;
}

/** 선택 → 1부터 센 줄 범위. 여러 줄 선택이 다음 줄 첫 칸에서 끝나면 그 줄은 뺀다 */
export function lineRange(sel: { start: { line: number; character: number }; end: { line: number; character: number } }): { start: number; end: number } {
  // vscode Selection의 start·end는 방향과 무관하게 start <= end
  const end = sel.end.line > sel.start.line && sel.end.character === 0 ? sel.end.line - 1 : sel.end.line;
  return { start: sel.start.line + 1, end: end + 1 };
}

// ---- git403: 스킴 (`git show <ref>:<path>` 내용) ----

export const CONTENT_SCHEME = "git403";
export interface ContentRef {
  repo: string;
  /** 커밋 또는 `<sha>^`. 빈 문자열이면 빈 문서(파일이 없던 쪽) */
  ref: string;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

/** URI 조각: path는 편집기가 언어·제목을 고르도록 파일 경로 그대로, query에 저장소·ref */
export function contentUriParts(c: ContentRef, rel: string): { scheme: string; path: string; query: string } {
  return { scheme: CONTENT_SCHEME, path: "/" + rel, query: b64(JSON.stringify({ repo: c.repo, ref: c.ref })) };
}

export function parseContentUri(u: { path: string; query: string }): { repo: string; ref: string; rel: string } | null {
  try {
    const q = JSON.parse(Buffer.from(u.query, "base64url").toString("utf8"));
    if (typeof q?.repo !== "string" || typeof q?.ref !== "string") return null;
    return { repo: q.repo, ref: q.ref, rel: u.path.replace(/^\//, "") };
  } catch {
    return null;
  }
}

/** `git show` 인자. ref가 `-`로 시작하면 옵션으로 읽히므로 거부한다 */
export function showArgs(ref: string, rel: string): string[] | null {
  return !ref || ref.startsWith("-") ? null : ["show", `${ref}:${rel}`];
}

/** 커밋 전/후 비교에서 왼쪽(이전) 경로: 이름이 바뀌었으면 옛 경로 */
export function beforePath(files: { status: string; path: string; oldPath?: string | null }[], path: string): { rel: string; added: boolean } {
  const f = files.find((x) => x.path === path);
  return { rel: f?.oldPath ?? path, added: f?.status === "A" };
}

/** 웹뷰가 보낸 파일 경로: 저장소 안 상대 경로만(절대 경로·`..` 거부). 통과하면 슬래시 경로 */
export function safeRel(p: unknown): string | null {
  if (typeof p !== "string" || !p || p.includes("\0")) return null;
  const q = p.replace(/\\/g, "/");
  return q.startsWith("/") || /^[a-zA-Z]:/.test(q) || q.split("/").includes("..") ? null : q;
}

/** 저장소가 둘 이상일 때 최상위 저장소 노드. 하위 id는 저장소별로 겹치지 않게 접두사를 붙인다 */
export function repoNode(repo: string, label: string, children: Node[], description?: string): Node {
  const pre = (n: Node): Node => ({ ...n, id: `${repo}|${n.id}`, children: n.children?.map(pre) });
  return { id: `repo:${repo}`, kind: "repo", label, description, tooltip: repo, icon: "repo", open: "expanded", context: "git403.repo", repo, children: children.map(pre) };
}
