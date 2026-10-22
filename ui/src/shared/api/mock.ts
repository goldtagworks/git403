// 브라우저 데모·E2E용 가짜 백엔드. `pnpm dev:mock`일 때만 번들에 들어간다.
// 실제 IPC 계약(src-tauri/src/lib.rs, docs/reuse.md)과 같은 모양의 데이터를 돌려준다.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { toast } from "../lib/toast";
import { t as tr } from "../i18n/i18n";
import type { AiProvider, AiResults, AiSource, AiStatus, ProviderStatus, AiTask, ChangedFile, Commit, GraphView, HostAccount, InboxPr, PrDetail, HostProvider, Lfs, Pr, Ref, RemoteInfo, RemoteRepo, SshKey, Stats, Status, StatusFile, Submodule, Worktree } from "./types";

// E2E: window.__fileDiff(문자열)가 있으면 file_diff·worktree_diff가 항상 그 diff를 돌려준다
// E2E: 토스트를 직접 띄운다 (window.__toast(title, {kind, detail}))
(window as any).__toast = toast;

// main 위에 feature 브랜치 두 개가 갈라졌다 합쳐지는 기록.
const spec: [string, string[], string][] = [
  ["m3", ["c5", "f3"], "Merge branch 'feature/graph'"],
  ["f3", ["f2"], "그래프 곡선 렌더링"],
  ["c5", ["m2"], "README 정리"],
  ["f2", ["f1"], "레인 색상 팔레트"],
  ["m2", ["c4", "h2"], "Merge branch 'hotfix/pull-lock'"],
  ["h2", ["h1"], "pull 중 UI 멈춤 수정"],
  ["c4", ["c3"], "작업 큐 추가 (#12, ABC-34)"],
  ["h1", ["c3"], "진행률 이벤트 분리"],
  ["f1", ["c3"], "그래프 레이아웃 초안"],
  ["c3", ["c2"], "로그 파서"],
  ["c2", ["c1"], "git 실행기"],
  ["c1", [], "Initial commit"],
];

// 본문 검색·설명 열 표시용 (Rust log의 body: 한 줄로 합친 앞부분)
const bodies: Record<string, string> = { c3: "라인 단위로 파싱하고 NUL 구분자를 쓴다", f1: "레인 할당은 후속 작업에서 다듬는다 sidebar-body-hit" };
const commits: Commit[] = spec.map(([id, parents, subject], i) => ({
  id: id.padEnd(40, "0"),
  parents: parents.map((p) => p.padEnd(40, "0")),
  author: ["김개발", "이리뷰", "박머지"][i % 3],
  email: ["dev@demo.dev", "review@demo.dev", "merge@demo.dev"][i % 3],
  time: 1_760_000_000 - i * 3600,
  subject,
  body: bodies[id] ?? "",
}));

// crates/graph의 layout()으로 계산한 실제 결과 [lane, color, [[from, to, color]...]].
const rows: [number, number, number[][]][] = [[0,0,[[0,0,0],[0,1,1]]],[1,1,[[1,1,1],[0,0,0]]],[0,0,[[0,0,0],[1,1,1]]],[1,1,[[1,1,1],[0,0,0]]],[0,0,[[0,0,0],[0,2,2],[1,1,1]]],[2,2,[[2,2,2],[0,0,0],[1,1,1]]],[0,0,[[0,0,0],[1,1,1],[2,2,2]]],[2,2,[[2,0,2],[1,1,1]]],[1,1,[[1,0,1]]],[0,0,[[0,0,0]]],[0,0,[[0,0,0]]],[0,0,[]]];
const view: GraphView = {
  commits,
  layout: {
    max_lanes: 3,
    rows: rows.map(([lane, color, edges]) => ({ lane, color, edges: edges.map(([from, to, c]) => ({ from, to, color: c })) })),
  },
};

const avatarSvg = (c: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="${c}"/></svg>`)}`;
const sha = (id: string) => id.padEnd(40, "0");
const refs: Ref[] = [
  { kind: "local", name: "main", target: sha("m3"), head: true, message: null, ahead: 0, behind: 6 },
  { kind: "local", name: "feature/graph", target: sha("f3"), head: false, message: null, ahead: 0, behind: 0 },
  { kind: "local", name: "hotfix/pull-lock", target: sha("h2"), head: false, message: null, ahead: 0, behind: 0 },
  { kind: "remote", name: "origin/main", target: sha("c5"), head: false, message: null, ahead: 0, behind: 0 },
  { kind: "remote", name: "origin/feature/graph", target: sha("f3"), head: false, message: null, ahead: 0, behind: 0 },
  { kind: "tag", name: "v0.1.0", target: sha("c3"), head: false, message: null, ahead: 0, behind: 0 },
  { kind: "stash", name: "stash@{0}", target: sha("c4"), head: false, message: "WIP on main: 툴바 배치 실험", ahead: 0, behind: 0 },
];
// 숨긴 ref(`--exclude`)를 뺀 그래프: HEAD와 숨기지 않은 ref에서 닿는 커밋만 남긴다 (git log --all --exclude와 같은 규칙).
const refFull = (r: Ref) => ({ local: "refs/heads/", remote: "refs/remotes/", tag: "refs/tags/", stash: "refs/stash/" })[r.kind] + r.name;
// E2E: window.__spike = true 면 wip/spike 브랜치(커밋 "스파이크 실험")가 생긴다. 이 브랜치로만 닿는 커밋이라 숨기면 그래프에서 빠진다.
const spike: Commit = { id: sha("s1"), parents: [sha("m3")], author: "김개발", email: "dev@demo.dev", time: 1_760_000_000 + 3600, subject: "스파이크 실험", body: "" };
const spikeRef: Ref = { kind: "local", name: "wip/spike", target: sha("s1"), head: false, message: null, ahead: 0, behind: 0 };
const multiRef: Ref = { kind: "tag", name: "v0.2.0-rc", target: sha("m3"), head: false, message: null, ahead: 0, behind: 0 };
const allRefs = () => [...refs, ...((window as any).__spike ? [spikeRef] : []), ...((window as any).__multiRef ? [multiRef] : [])];
const baseView = (): GraphView =>
  (window as any).__spike ? { commits: [spike, ...commits], layout: { ...view.layout, rows: [{ lane: 1, color: 3, edges: [{ from: 1, to: 0, color: 3 }] }, ...view.layout.rows] } } : view;
const graphWithout = (hidden: string[]): GraphView => {
  const base = baseView();
  if (!hidden.length) return base;
  // hidden.ts와 같은 규칙: 자신 → 가까운 조상 폴더 순으로 처음 걸리는 항목(숨김/`!` 예외)을 따른다
  const set = new Set(hidden);
  const gone = (r: Ref) => {
    if (r.head) return false;
    const p = refFull(r);
    if (set.has(p)) return true;
    if (set.has("!" + p)) return false;
    for (let i = p.lastIndexOf("/"); i > 0; i = p.lastIndexOf("/", i - 1)) {
      if (set.has(p.slice(0, i) + "/*")) return true;
      if (set.has("!" + p.slice(0, i) + "/*")) return false;
    }
    return false;
  };
  const byId = new Map(base.commits.map((c) => [c.id, c]));
  const keep = new Set<string>();
  const walk = (id: string) => {
    const c = byId.get(id);
    if (!c || keep.has(id)) return;
    keep.add(id);
    c.parents.forEach(walk);
  };
  allRefs().filter((r) => !gone(r)).forEach((r) => walk(r.target));
  const idx = base.commits.map((c, i) => (keep.has(c.id) ? i : -1)).filter((i) => i >= 0);
  return { commits: idx.map((i) => base.commits[i]), layout: { ...base.layout, rows: idx.map((i) => base.layout.rows[i]) } };
};
const submodules: Submodule[] = [
  { path: "vendor/libgit", url: "https://example.com/libgit.git", commit: sha("a1"), status: "ok" },
  { path: "vendor/theme", url: "https://example.com/theme.git", commit: sha("b2"), status: "modified" },
  { path: "docs/site", url: "https://example.com/site.git", commit: sha("c3"), status: "uninitialized" },
];
const worktrees: Worktree[] = [
  { path: "/demo/git403", head: sha("m3"), branch: "main", bare: false, detached: false, locked: false, prunable: false, main: true },
  { path: "/demo/git403-hotfix", head: sha("h2"), branch: "hotfix/pull-lock", bare: false, detached: false, locked: false, prunable: false, main: false },
];
const lfs: Lfs = {
  installed: true,
  tracked: ["*.psd", "assets/*.bin"],
  files: [
    { path: "assets/logo.psd", oid: "4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393", downloaded: true },
    { path: "assets/model.bin", oid: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", downloaded: false },
  ],
};
// 저장소 통계: 기간이 짧을수록 커밋이 적다. 줄 수는 withLines일 때만 채운다 (실제 repo_stats와 같은 계약).
const statsFor = (range: string, withLines: boolean): Stats => {
  const k = { all: 1, year: 0.6, "90d": 0.3, "30d": 0.1 }[range] ?? 1;
  const authors = [["김개발", 120], ["이리뷰", 60], ["박머지", 20]].map(([name, c], i) => ({
    name: name as string, email: `u${i}@demo.dev`, commits: Math.round((c as number) * k), added: withLines ? Math.round((c as number) * k) * 40 : 0, deleted: withLines ? Math.round((c as number) * k) * 12 : 0, first: 1_700_000_000, last: 1_760_000_000 - i * 86400,
  }));
  const weeks = Array.from({ length: Math.round(52 * k) + 1 }, (_, i) => ({ start: `2025-${String((i % 12) + 1).padStart(2, "0")}-01`, commits: (i * 7) % 11 }));
  return {
    withLines,
    summary: { commits: authors.reduce((n, a) => n + a.commits, 0), authors: 3, first: 1_700_000_000, last: 1_760_000_000, branches: 3, remoteBranches: 2, tags: 1, files: 214, sizeKb: 2048 },
    authors, weeks,
    heatmap: Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => (d < 5 && h >= 9 && h <= 18 ? ((d + h) % 5) + 1 : 0))),
    extensions: ["rs", "tsx", "ts", "css", "md", "json", "toml", "", "yml", "svg", "lock"].map((ext, i) => ({ ext, count: 80 - i * 6 })),
  };
};
const files: ChangedFile[] = [
  { status: "M", path: "crates/graph/src/lib.rs", oldPath: null },
  { status: "A", path: "ui/src/CommitGraph.tsx", oldPath: null },
  { status: "D", path: "ui/src/old.css", oldPath: null },
];
const diff = (path: string) => `diff --git a/${path} b/${path}
index 3f2a1b0..9c4d2e1 100644
--- a/${path}
+++ b/${path}
@@ -12,7 +12,9 @@ pub fn layout(nodes: &[Node]) -> Layout {
     let mut lanes = Vec::new();
-    let color = 0;
+    // 레인마다 색을 다르게 준다.
+    let mut next_color = 0;
+    let mut fresh = || { next_color += 1; next_color };
     for node in nodes {
         let lane = place(&mut lanes, node);
@@ -40,6 +42,7 @@ impl Layout {
     fn finish(&self) -> Vec<u32> {
-        let ids = self.trackLogIds.clone();
+        let ids = self.trackEventLogIds.clone();
+        // 이벤트 로그도 함께 모은다.
         ids
     }
 }
`;

// 작업 디렉터리 상태: stage/unstage/commit 호출에 따라 바뀐다.
const file = (path: string, index: string, worktree: string, untracked = false): StatusFile => ({ path, oldPath: null, index, worktree, untracked, conflict: false });
let status: Status = {
  branch: "main",
  upstream: "origin/main",
  ahead: 1,
  behind: 2,
  operation: null,
  files: [file("ui/src/Toolbar.tsx", ".", "M"), file("crates/core/src/status.rs", "A", "."), file("notes.md", ".", "?", true)],
};
const move = (paths: string[], staged: boolean) => {
  status = {
    ...status,
    files: status.files.map((f) =>
      !paths.includes(f.path) ? f : staged ? { ...f, index: f.untracked ? "A" : f.worktree, worktree: ".", untracked: false } : { ...f, index: ".", worktree: f.index === "A" ? "?" : f.index, untracked: f.index === "A" },
    ),
  };
  emit("repo-changed", { worktree: true, refs: false });
};
// 크게 보기 첫 사용 안내는 E2E가 `window.__showHint`로 켤 때만 보인다 (다른 화면 테스트·스크린샷을 가리지 않게)
try { if (!(window as any).__showHint) localStorage.setItem("bigHint", "1"); } catch {}
/** E2E가 확인할 수 있게 실행된 git 명령을 남긴다. */
const gitCalls: string[][] = ((window as any).__git = []);
/** 줄 끝 CR 무시 diff 요청은 ["diff_eol"], 공백 무시는 ["diff_ws"]로 남긴다 */
const eolSeen = (a: unknown) => ((a as { ignoreEol?: boolean }).ignoreEol && gitCalls.push(["diff_eol"]), (a as { ignoreWs?: boolean }).ignoreWs && gitCalls.push(["diff_ws"]));
/** E2E가 백엔드 이벤트(askpass, repo-changed …)를 흉내 낼 때 쓴다. */
(window as any).__emit = emit;


// ---- 호스팅 계정·PR (docs/reuse.md 호스팅 절) ----
// E2E: window.__accounts(계정 목록, 기본 github.com demo-user 하나), window.__remotes([{remote, url}], 기본 origin → github.com/demo/git403),
//      window.__prFail(PR 생성 오류 문구), window.__prListFail, window.__slowPrs(ms), window.__prs(PR 목록)
const DEFAULT_HOST: Record<HostProvider, string> = { github: "github.com", gitlab: "gitlab.com", bitbucket: "bitbucket.org", gitea: "gitea.com" };
const accountList = (): HostAccount[] => ((window as any).__accounts ??= [{ provider: "github", host: "github.com", username: "demo-user" }]);
const hostOf = (host: string) => host.replace(/^https?:\/\//, "");
const providerOf = (host: string): HostProvider | null => {
  const h = hostOf(host);
  return h === "github.com" ? "github" : h === "gitlab.com" ? "gitlab" : h === "bitbucket.org" ? "bitbucket" : accountList().find((a) => hostOf(a.host) === h)?.provider ?? null;
};
const remoteInfos = (): RemoteInfo[] =>
  ((window as any).__remotes ?? [{ remote: "origin", url: "https://github.com/demo/git403.git" }]).flatMap(({ remote, url }: { remote: string; url: string }) => {
    const m = /^https?:\/\/([^/]+)\/(.+?)\/([^/]+?)(?:\.git)?$/.exec(url);
    if (!m) return [];
    const provider = providerOf(m[1]);
    const repo: RemoteRepo = { host: m[1], owner: m[2], name: m[3] };
    const account = accountList().find((a) => a.provider === provider && hostOf(a.host) === hostOf(m[1])) ?? null;
    return [{ remote, url, provider, repo, webUrl: `https://${m[1]}/${m[2]}/${m[3]}`, account }];
  });
const webBase = (r: RemoteRepo) => `https://${hostOf(r.host)}/${r.owner}/${r.name}`;
const defaultPrs: Pr[] = [
  { number: 7, title: "그래프 곡선 개선", url: "https://github.com/demo/git403/pull/7", head: "feature/graph", base: "main", author: "이리뷰" },
  { number: 5, title: "pull 중 UI 멈춤 수정", url: "https://github.com/demo/git403/pull/5", head: "hotfix/pull-lock", base: "main", author: "박머지" },
];

// PR 리뷰(26): window.__inbox(InboxPr[]), __inboxClosed(state closed일 때), __prDetail({번호: Partial<PrDetail>}), __inboxFail(오류 문구), __detailFail, __slowInbox(ms), __slowDetail(ms). gitCalls에 pr_inbox·pr_detail 기록
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const inbox = (n: number, o: Partial<InboxPr>): InboxPr => ({ number: n, title: "", url: `https://github.com/demo/git403/pull/${n}`, head: `feature/p${n}`, base: "main", author: "이리뷰", authorAvatar: "", draft: false, createdAt: ago(5), updatedAt: ago(1), additions: 10, deletions: 2, labels: [], reviewers: [], approvals: 0, myReview: "none", reRequested: false, headSha: `a${n}b2c3d4e5f6`, isMine: false, reviewRequested: false, ...o });
const defaultInbox: InboxPr[] = [
  inbox(131, { title: "설정 화면 다크 모드 색 맞추기", author: "Alex", head: "fix/settings-dark", additions: 48, deletions: 21, labels: ["bug"], reRequested: true, reviewRequested: true, myReview: "changes_requested", updatedAt: ago(0.3) }),
  inbox(128, { title: "로그인 화면 정리", author: "Jamie", head: "feature/login-cleanup", additions: 98, deletions: 18, labels: ["feature"], reviewRequested: true, approvals: 1, createdAt: ago(5) }),
  inbox(129, { title: "알림 권한 안내 문구 수정", author: "demo-user", head: "docs/notify", additions: 6, deletions: 3, isMine: true, approvals: 1, reviewers: ["Alex"], createdAt: ago(30) }),
  inbox(126, { title: "네트워크 재시도 정책 정리", author: "Sam", additions: 212, deletions: 160, createdAt: ago(48), draft: true }),
  inbox(7, { title: "그래프 곡선 개선", head: "feature/graph", createdAt: ago(60) }),
  inbox(5, { title: "pull 중 UI 멈춤 수정", author: "박머지", head: "hotfix/pull-lock", createdAt: ago(80) }),
  inbox(42, { title: "이미지 캐시 크기 제한", author: "Riley", additions: 87, deletions: 12, labels: ["perf", "cache"], myReview: "approved", approvals: 2, createdAt: ago(11) }),
];
const defaultDetail = (n: number): PrDetail => ({
  body: "다크 모드에서 설정 화면의 셀 배경과 글자 색이 시스템 색과 달라 보이던 것을 색 토큰으로 맞췄습니다.\n\n- 셀 배경\n- 구분선",
  mergeable: "MERGEABLE", ci: "SUCCESS", approvals: n === 128 ? 1 : 0, requiredApprovals: 2, unresolvedThreads: n === 128 ? 1 : 0, files: 4, additions: 48, deletions: 21, baseSha: "base123456789", headSha: `a${n}b2c3d4e5f6`,
  timeline: [
    { kind: "commit", author: "Alex", at: ago(26), sha: "930b8b1aa", body: "다크 모드 색 토큰 정리" },
    { kind: "review", author: "you", at: ago(23), state: "CHANGES_REQUESTED", body: "구분선 색도 다크 모드에서 한 번 봐 주세요. 지금은 흰 줄처럼 보여요." },
    { kind: "commit", author: "Alex", at: ago(0.4), sha: `a${n}b2c3d4e5f6`, body: "구분선 색 다크 모드 대응" },
    { kind: "comment", author: "Alex", at: ago(0.3), body: "구분선 색까지 맞췄습니다. 다시 봐 주세요." },
  ],
  reviewThreads: [],
});

// ---- 설정 창 (docs/reuse.md 설정 절) ----
// E2E: window.__cfg = {global, local}(git config 값, 키는 소문자. 기본 전역 user.name·user.email), window.__files = {repo, "/home/demo/...": 텍스트}(ignore 파일),
//      window.__ssh = SshKey[](기본 id_ed25519·id_rsa). config 쓰기·ignore 저장·키 생성은 __git에 기록한다.
const CFG_KEYS = /^(user\.(name|email|signingkey)|init\.defaultbranch|pull\.(rebase|ff)|commit\.gpgsign|gpg\.format|core\.excludesfile)$/i;
const cfg = (): Record<"global" | "local", Record<string, string>> => ((window as any).__cfg ??= { global: { "user.name": "데모 사용자", "user.email": "demo@example.com" }, local: {} });
const sshKeys = (): SshKey[] =>
  ((window as any).__ssh ??= [
    { name: "id_ed25519.pub", kind: "ED25519", bits: 256, fingerprint: "SHA256:Zk3qA9mP1xV0c7sT2uWyH4dEoJrL8nBfG5iQ6aXvC1M", comment: "demo@example.com", public: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemoKeyDemoKeyDemoKeyDemoKeyDemoKeyDemoKey demo@example.com", hasPrivate: true },
    { name: "id_rsa.pub", kind: "RSA", bits: 3072, fingerprint: "SHA256:Qw8eR2tY5uI9oP1aS3dF6gH0jK4lZ7xC2vB5nM8qWeR", comment: "old-laptop", public: "ssh-rsa AAAAB3NzaC1yc2EAAAADemoRsaKey old-laptop", hasPrivate: true },
  ]);
const ignoreFiles = (): Record<string, string> => ((window as any).__files ??= { repo: "node_modules/\n" });
const underHome = (p: string) => (p.startsWith("~/") || p.startsWith("/home/demo/")) && !p.includes("..");

// ---- AI (docs/ai-auth.md) ----
// E2E: window.__ai = Partial<AiStatus>(기본: CLI 2.1.0 감지·키 없음·동의 전, 모델 claude-opus-5-5). `active`는 method·cli·key에서 계산한다.
//      window.__aiFail(ai_run 오류 문구), window.__aiSlow(ms, 이 동안 ai_cancel로 취소 가능), window.__aiResult(작업별 응답 덮어쓰기).
//      window.__aiConv(저장소 규칙 따르기, 기본 true), window.__aiSources(Commit·Pr 결과의 sources 덮어쓰기, 기본 3개; [] = 없음). repo를 넘기고 전역·저장소(git403.aiConventions)에서 안 껐을 때만 붙는다.
//      ai_run·ai_cancel·ai_key_*·ai_settings_set은 __git에 기록한다 (ai_run은 [ai_run, JSON{task, parts}]). 입력 합계가 200KB를 넘으면 Rust처럼 거부한다.
type AiSt = Omit<ProviderStatus, "active" | "provider">;
const AI_DEFAULT: Record<AiProvider, AiSt> = {
  anthropic: { cli: true, cliVersion: "2.1.0 (Claude Code)", key: false, method: "auto", model: "claude-opus-5-5", consent: false },
  openai: { cli: false, cliVersion: null, key: false, method: "auto", model: "gpt-5", consent: false },
  google: { cli: false, cliVersion: null, key: false, method: "auto", model: "gemini-2.5-pro", consent: false },
  xai: { cli: false, cliVersion: null, key: false, method: "auto", model: "grok-4", consent: false },
};
const AI_PROVIDERS: AiProvider[] = ["anthropic", "openai", "google", "xai"];
// window.__ai의 최상위 필드 = Anthropic 상태(기존 테스트 호환), __ai.provider = 선택된 공급자, __ai.providers = 나머지 공급자 덮어쓰기
const aiState = (p: AiProvider = "anthropic") => {
  const w = window as any;
  w.__ai = { ...AI_DEFAULT.anthropic, provider: "anthropic", ...w.__ai }; // 테스트가 일부만 준 값에 기본값을 채워 넣고(멱등) 같은 객체를 계속 쓴다
  if (p === "anthropic") return w.__ai as AiSt;
  return ((w.__ai.providers ??= {})[p] = { ...AI_DEFAULT[p], ...w.__ai.providers[p] }) as AiSt;
};
const aiSelected = (): AiProvider => (window as any).__ai?.provider ?? "anthropic";
const aiActive = (s: AiSt): AiStatus["active"] => (s.method === "auto" ? (s.cli ? "cli" : s.key ? "key" : null) : s.method === "cli" ? (s.cli ? "cli" : null) : s.key ? "key" : null);
const aiStatus = (): AiStatus => {
  const providers = AI_PROVIDERS.map((provider): ProviderStatus => {
    const { provider: _p, providers: _ps, ...s } = aiState(provider) as AiSt & { provider?: unknown; providers?: unknown };
    return { provider, ...s, active: aiActive(s) };
  });
  return { ...providers.find((x) => x.provider === aiSelected())!, providers, conventions: (window as any).__aiConv ?? true };
};
const AI_SOURCES: AiSource[] = [{ kind: "skill", path: ".claude/skills/commit-message/SKILL.md", truncated: false }, { kind: "agents", path: "AGENTS.md", truncated: false }, { kind: "history", path: "git log -n 20", truncated: false }];
const aiPending = new Map<string, (e: string) => void>();
const AI_RESULTS: AiResults = {
  commit: { subject: "feat: AI 커밋 메시지 추가", body: "스테이지된 변경을 요약합니다." },
  review: { findings: [{ file: "crates/graph/src/lib.rs", line: 14, severity: "high", message: "next_color가 오버플로할 수 있습니다." }, { file: "ui/src/CommitGraph.tsx", line: 3, severity: "info", message: "주석을 보강하세요." }] },
  conflict: { explanation: "ours는 제목을, theirs는 본문을 바꿨습니다. 둘 다 살렸습니다.", merged: "합쳐진 제목\n합쳐진 본문\n" },
  pr: { title: "AI가 쓴 PR 제목", body: "## 요약\n- 변경 사항 설명" },
  prreview: {
    verdict: "request_changes",
    summary: "레인 색 할당을 바꾸고 화면에서 쓰도록 연결한 변경입니다. 색 인덱스 오버플로 한 곳만 머지 전에 고치면 됩니다.",
    praise: ["색 할당 로직을 한 함수로 모아 읽기 쉬워졌습니다", "이벤트 로그 id 수집을 분리했습니다"],
    comments: [
      { file: "crates/graph/src/lib.rs", line: 16, endLine: null, level: "info", title: "이름을 더 구체적으로", body: "`node` 대신 `commit_node`처럼 쓰면 읽기 쉽습니다.", evidence: "같은 파일의 다른 곳은 commit_ 접두사를 씁니다." },
      { file: "crates/graph/src/lib.rs", line: 14, endLine: null, level: "must", title: "머지 전에 고쳐야 함", body: "`next_color`가 `u32` 한계를 넘으면 오버플로합니다. `wrapping_add`나 팔레트 길이로 나눈 나머지를 쓰세요.", evidence: "레인이 40억 개를 넘는 경우는 드물지만, debug 빌드에서는 패닉이 납니다." },
      { file: "ui/src/CommitGraph.tsx", line: 43, endLine: 44, level: "should", title: "고치면 좋음", body: "이벤트 로그 id 수집이 `finish` 안에 섞여 있습니다. 별도 함수로 빼면 테스트하기 쉽습니다.", evidence: "finish가 두 가지 일을 합니다." },
    ],
    meta: { model: "claude-opus-5-5", inputTokens: 12400, outputTokens: 1830, elapsedMs: 74000 },
  },
  guide: {
    overview: "그래프 색 할당을 안전하게 바꾸고 화면에서 쓰도록 연결합니다. 먼저 코어 로직을 보고 UI 사용부를 확인하세요.",
    decision: { title: "색 인덱스를 모듈러로 순환", why: "오버플로를 피하면서 레인 색을 안정적으로 유지합니다.", alternatives: ["u32 포화 덧셈", "색 팔레트 확장"] },
    steps: [
      { title: "색 할당 로직", file: "crates/graph/src/lib.rs", startLine: 13, endLine: 15, detail: "변경의 핵심입니다. next_color가 어떻게 순환하는지 먼저 봅니다." },
      { title: "화면 사용부", file: "ui/src/CommitGraph.tsx", startLine: 12, endLine: 14, detail: "바뀐 색 값을 그리는 쪽입니다. 팔레트 길이를 가정하는지 확인하세요." },
      { title: "끝맺음 정리", file: "crates/graph/src/lib.rs", startLine: 43, endLine: 44, detail: "이벤트 로그 id를 함께 모으는 부분입니다." },
    ],
    focus: [{ file: "crates/graph/src/lib.rs", line: 14, note: "오버플로 가능 지점" }],
    apis: [{ name: "next_color", summary: "다음 레인 색 인덱스를 돌려줍니다.", file: "crates/graph/src/lib.rs", line: 14 }, { name: "layout", summary: "노드 목록으로 레인을 배치합니다." }],
    checks: ["팔레트 길이가 바뀌어도 순환이 맞는지", "기존 레이아웃 테스트가 통과하는지"],
  },
};

const settingsPreview = {
  version: 1,
  sections: [
    { id: "ui", changes: [{ key: "theme", from: "light", to: "dark" }, { key: "graphLimit", from: "20000", to: "3000" }, { key: "customCommands", from: "[]", to: '[{"id":"c1","name":"빌드","target":"repo","kind":"shell","command":"make","confirm":true}]' }] },
    { id: "ai", changes: [{ key: "provider", from: "anthropic", to: "openai" }] },
    { id: "accounts", changes: [{ key: "github.com/octo", to: "연결 정보" }] },
    { id: "gitGlobal", changes: [{ key: "git403.issue.x", to: "#(\\d+)" }] },
    { id: "tools", changes: [{ key: "diff.tool", from: "", to: "vimdiff" }] },
  ],
  skipped: ["hidden:/demo/other"],
  warnings: [{ code: "settings.io.newerVersion", vars: { version: "2" }, message: "This file is from a newer version of git403 (format 2); only known items are read" }],
};
let jobs = 0;
mockWindows("main"); // getCurrentWindow()(창 숨기기)가 쓰는 창 정보
mockIPC(
  (cmd, args) => {
    if (cmd === "initial_repo") return null;
    // 저장소 열기는 데모 저장소, 그 밖의 폴더 선택(복제 위치·스캔)은 /demo
    // E2E: window.__saveCancel = true 면 저장·패치 선택 대화상자를 취소한 것으로 본다. window.__patchFile = 선택될 패치 경로
    // 설정 내보내기·가져오기 대화상자. E2E: window.__dialog = { save: 경로|null, open: 경로|null } (null = 취소)
    if (cmd === "plugin:dialog|save" && (window as any).__dialog && "save" in (window as any).__dialog) return (window as any).__dialog.save;
    if (cmd === "plugin:dialog|open" && (args as any)?.options?.title === tr("settings.import.pick")) return (window as any).__dialog && "open" in (window as any).__dialog ? (window as any).__dialog.open : "/demo/git403-settings.json";
    if (cmd === "plugin:dialog|save") return (window as any).__saveCancel ? null : (args as any)?.options?.defaultPath ? `/demo/${(args as any).options.defaultPath}` : "/demo/out.patch";
    if (cmd === "plugin:dialog|open") {
      const t = (args as any)?.options?.title;
      if (t === tr("api.pickPatch")) return (window as any).__saveCancel ? null : ((window as any).__patchFile ?? "/demo/fix.patch");
      if (t === tr("ops.patch.folder") && (window as any).__saveCancel) return null;
      return t === tr("api.openRepo") ? "/demo/git403" : "/demo";
    }
    if (cmd === "patch_is_mail") return /\.mbox$|\/0001-/.test((args as { path: string }).path);
    // /demo 아래 저장소는 모두 같은 가짜 기록을 보여 준다 (복제·init 결과도 열 수 있게)
    if (cmd === "find_repos") return ["api-server", "design-system", "git403"].map((n) => `${(args as { root: string }).root}/${n}`);
    // E2E가 느린 저장소를 흉내 낼 때: window.__slow = [경로]
    // E2E가 열 수 없는 저장소를 흉내 낼 때: window.__broken = [경로]
    // E2E: window.__avatarCalls = 요청한 이메일 배열들. dev·review만 사진(data: URL), merge는 null
    if (cmd === "author_avatars") {
      const items = (args as { items: { email: string }[] }).items;
      ((window as any).__avatarCalls ??= []).push(items.map((i) => i.email));
      // __avatarDelay(ms)로 응답을 늦추고, __avatarUrls({email: url})로 응답을 덮어쓴다 (깨진 이미지 테스트)
      const w = window as any;
      // __avatarRetry: 이 이메일들은 일시적 실패(retry)로 답하고 목록에서 뺀다 → 다음 요청엔 사진
      const retry: string[] = w.__avatarRetry ?? [];
      const res = items.map(({ email }) => retry.includes(email)
        ? (w.__avatarRetry = retry.filter((e) => e !== email), { email, url: null, retry: true })
        : { email, url: w.__avatarUrls?.[email] ?? (email === "merge@demo.dev" ? null : avatarSvg(email === "dev@demo.dev" ? "#c2577f" : "#3c9c78")) });
      return w.__avatarDelay ? new Promise((r) => setTimeout(() => r(res), w.__avatarDelay)) : res;
    }
    if (cmd === "load_graph" && (window as any).__broken?.includes((args as { repo: string }).repo)) throw "not a git repository";
    if (cmd === "load_graph") (window as any).__graphLimit = (args as { limit: number }).limit; // E2E: 마지막 load_graph의 상한
    if (cmd === "load_graph") (window as any).__graphLoads = ((window as any).__graphLoads ?? 0) + 1; // E2E: load_graph 호출 횟수
    // E2E: window.__bigGraph = N 이면 일직선 N개 커밋. 요청한 limit만큼만 돌려준다 (__graphCalls에 limit 기록)
    if (cmd === "load_graph" && (window as any).__bigGraph) {
      const w = window as any;
      const limit = (args as { limit: number }).limit;
      (w.__graphCalls ??= []).push(limit);
      const n = Math.min(w.__bigGraph, limit);
      const cs: Commit[] = Array.from({ length: n }, (_, i) => ({ id: String(i).padStart(40, "0"), parents: i + 1 < w.__bigGraph ? [String(i + 1).padStart(40, "0")] : [], author: "김개발", email: "dev@demo.dev", time: 1_760_000_000 - i * 60, subject: `커밋 ${i}`, body: "" }));
      return { commits: cs, layout: { max_lanes: 1, rows: cs.map((c) => ({ lane: 0, color: 0, edges: c.parents.length ? [{ from: 0, to: 0, color: 0 }] : [] })) } };
    }
    if (cmd === "ensure_commit_graph") return void (((window as any).__cgCalls ??= []) as string[]).push((args as { repo: string }).repo);
    if (cmd === "load_graph") {
      const v = graphWithout((args as { hidden?: string[] }).hidden ?? []);
      return (window as any).__slow?.includes((args as { repo: string }).repo) ? new Promise((r) => setTimeout(() => r(v), 500)) : v;
    }
    // E2E: window.__remoteOnly = true 면 로컬에 없는 원격 브랜치 origin/release가 생긴다
    if (cmd === "load_refs") return (window as any).__remoteOnly ? [...allRefs(), { kind: "remote", name: "origin/release", target: sha("c5"), head: false, message: null, ahead: 0, behind: 0 }] : allRefs();
    // 서브모듈 조회가 느려도 그래프는 먼저 떠야 한다: window.__slowModules = ms
    if (cmd === "load_submodules") {
      const ms = (window as any).__slowModules;
      return new Promise((r) => setTimeout(() => r((window as any).__noModules ? [] : submodules), ms ?? 0));
    }
    if (cmd === "load_worktrees") return (window as any).__noModules ? [worktrees[0]] : worktrees;
    // E2E가 LFS 미설치를 흉내 낼 때: window.__noLfs = true
    if (cmd === "lfs_status") return (window as any).__noLfs ? { installed: false, tracked: [], files: [] } : lfs;
    // E2E: window.__slowStats = ms 면 통계 응답이 늦다. 호출 인자는 __git에 ["repo_stats", JSON]으로 남는다.
    if (cmd === "cancel_stats") return void gitCalls.push(["cancel_stats", (args as { token: string }).token]);
    if (cmd === "repo_stats") {
      const a = args as { range: string; withLines: boolean };
      gitCalls.push(["repo_stats", JSON.stringify(args)]);
      return new Promise((r) => setTimeout(() => r(statsFor(a.range, a.withLines)), (window as any).__slowStats ?? 0));
    }
    // E2E: window.__changedFiles(ChangedFile[])가 있으면 커밋 변경 파일 목록을 그걸로 바꾼다 (이미지 diff 등)
    if (cmd === "changed_files") return (window as any).__changedFiles ?? files;
    // 파일 바이트: window.__blobs = {"rev:path": base64} (rev는 null이면 "WORKTREE"). 없으면 null
    if (cmd === "file_blob") {
      const { rev, path } = args as { rev: string | null; path: string };
      gitCalls.push(["file_blob", `${rev ?? "WORKTREE"}:${path}`]);
      return (window as any).__blobs?.[`${rev ?? "WORKTREE"}:${path}`] ?? null;
    }
    if (cmd === "file_diff") return (eolSeen(args), (window as any).__fileDiff ?? diff((args as { path: string }).path));
    if (cmd === "set_locale") return void gitCalls.push(["set_locale", (args as { locale: string }).locale]);
    if (cmd === "cancel_job") return void gitCalls.push(["cancel_job", String((args as { job: number }).job)]);
    // E2E: window.__noUpstream = true 면 추적 브랜치가 없는 상태
    // window.__clean = true 면 변경 파일이 없는 깨끗한 작업 트리
    if (cmd === "load_status") {
      // window.__conflict = true 면 충돌 파일 conflict.txt이 하나 있다 ("DU"처럼 문자열이면 그 XY 코드)
      const st = (window as any).__clean ? { ...status, files: [] } : (window as any).__conflict ? { ...status, files: [...status.files, { path: "conflict.txt", oldPath: null, index: typeof (window as any).__conflict === "string" ? (window as any).__conflict[0] : "U", worktree: typeof (window as any).__conflict === "string" ? (window as any).__conflict[1] : "U", untracked: false, conflict: true }] } : status;
      // window.__statusExtra(StatusFile[])는 목록 끝에 덧붙인다
      const ex = (window as any).__statusExtra;
      const st2 = ex ? { ...st, files: [...st.files, ...ex] } : st;
      return (window as any).__noUpstream ? { ...st2, upstream: null } : st2;
    }
    if (cmd === "watch_repo") return null;
    // 열기: 실행 기록만 남긴다 [open_in, what, app|null, path|null]
    if (cmd === "open_in") {
      const a = args as { what: string; app: string | null; path: string | null };
      gitCalls.push(["open_in", a.what, String(a.app), String(a.path)]);
      return null;
    }
    // 외부 diff·merge 도구: 끝날 때까지 기다리는 GUI 프로세스 흉내. window.__detached = { ms, err }
    if (cmd === "run_detached") {
      const { args: a, token } = args as { args: string[]; token: string };
      gitCalls.push(["run_detached", ...a]);
      const o = (window as any).__detached ?? {};
      setTimeout(() => emit("detached-done", [token, o.errCode ? JSON.stringify(o.errCode) : o.err ?? null]), o.ms ?? 300);
      return null;
    }
    // 설정 내보내기·가져오기. E2E: window.__settingsPreview(SettingsPreview 덮어쓰기), __settingsApplied(SettingsApplied 덮어쓰기), __settingsFail = { read|preview|apply: 오류 문구 }
    if (cmd === "settings_export_file") return void gitCalls.push(["settings_export_file", JSON.stringify(args)]);
    if (cmd === "settings_read_file") {
      const f = (window as any).__settingsFail?.read;
      if (f) throw f;
      return { json: JSON.stringify({ format: "git403-settings", version: 1 }) };
    }
    if (cmd === "settings_import_preview") {
      const f = (window as any).__settingsFail?.preview;
      if (f) throw f;
      gitCalls.push(["settings_import_preview", JSON.stringify(args)]);
      return (window as any).__settingsPreview ?? settingsPreview;
    }
    if (cmd === "settings_import_apply") {
      const f = (window as any).__settingsFail?.apply;
      if (f) throw f;
      gitCalls.push(["settings_import_apply", JSON.stringify(args)]);
      const ids = (args as { sections: string[] }).sections;
      return (window as any).__settingsApplied ?? { applied: ids, backup: "/demo/backup/git403-settings-before.json", ui: ids.includes("ui") ? { theme: "dark", graphLimit: "3000", "split:side": "300" } : undefined, reconnect: ids.includes("accounts") ? [{ provider: "github", host: "github.com", username: "octo" }] : [], skipped: [] };
    }
    if (cmd === "plugin:dialog|ask" || cmd === "plugin:dialog|confirm") return true;
    // plugin-dialog 2.x의 ask()는 message 명령 + "Yes". E2E: window.__asked = [] 면 묻는 문구를 모으고, window.__askNo = true 면 "아니오"
    if (cmd === "plugin:dialog|message") {
      (window as any).__asked?.push((args as { message: string }).message);
      const ans = (window as any).__askNo ? "No" : "Yes";
      return (window as any).__slowAsk ? new Promise((r) => setTimeout(() => r(ans), (window as any).__slowAsk)) : ans; // E2E: __slowAsk(ms) = 확인창이 떠 있는 시간
    }
    if (cmd === "worktree_diff") {
      const out = (eolSeen(args), (window as any).__fileDiff ?? diff((args as { path: string }).path));
      return (window as any).__diffDelay ? new Promise((r) => setTimeout(() => r(out), (window as any).__diffDelay)) : out; // E2E: window.__diffDelay(ms)가 있으면 worktree_diff 응답을 늦춘다
    }
    if (cmd === "stage") return move((args as { paths: string[] }).paths, true);
    if (cmd === "unstage") return move((args as { paths: string[] }).paths, false);
    if (cmd === "trash_files" || cmd === "restore_file") {
      gitCalls.push([cmd, JSON.stringify(args)]);
      const f = (window as any).__fileOpFail; // E2E: 오류 코드 JSON 문자열이면 그대로 던진다
      if (f) throw f;
      return null;
    }
    if (cmd === "discard" || cmd === "apply_partial") {
      gitCalls.push([cmd, JSON.stringify(args)]);
      return null;
    }
    if (cmd === "askpass_reply") {
      gitCalls.push(["askpass_reply", JSON.stringify(args)]);
      return null;
    }
    if (cmd === "file_log") return commits.slice(0, 4);
    if (cmd === "search_content") return [sha("h1"), sha("f1")];
    if (cmd === "blame")
      return ["fn layout() {", "    let lanes = Vec::new();", "}"].map((text, i) => ({ sha: commits[i].id, author: commits[i].author, time: commits[i].time, summary: commits[i].subject, text }));
    if (cmd === "remove_git_dir") {
      gitCalls.push(["remove_git_dir", (args as { path: string }).path]);
      return null;
    }
    // 줄바꿈 처리. E2E: window.__eolRule = false(기본 true) 면 .gitattributes 규칙이 없는 저장소, window.__crlf = ["a.txt"] 면 CRLF가 든 스테이지 파일
    if (cmd === "eol_rule_exists") return (window as any).__eolRule ?? true;
    if (cmd === "staged_crlf") return (window as any).__crlf ?? [];
    if (cmd === "fix_crlf") {
      gitCalls.push(["fix_crlf", JSON.stringify(args)]);
      return void ((window as any).__crlf = []);
    }
    if (cmd === "append_line") {
      gitCalls.push(["append_line", JSON.stringify(args)]);
      return null;
    }
    if (cmd === "commit_message") {
      const c = view.commits.find((x) => x.id === (args as any).sha);
      if (!c) return "";
      if (c.subject === "로그 파서") return `${c.subject}\n\nWhat:\n${Array.from({ length: 8 }, (_, i) => `- ${i + 1}번째 변경 ABC-${i}`).join("\n")}\n\nResolves: ABC-34\n\nAI-Use: yes\nCo-authored-by: 옥토 <1+octo@users.noreply.github.com>`;
      return c.body ? `${c.subject}\n\n${c.body}` : c.subject;
    }
    if (cmd === "co_authors") return (args as any).sha === view.commits[1].id ? ["Claude <noreply@anthropic.com>", "옥토 <1+octo@users.noreply.github.com>"] : [];
    if (cmd === "last_message") return "그래프 곡선 렌더링\n\n본문";
    if (cmd === "commit") {
      gitCalls.push(["commit", (args as { message: string }).message]);
      status = { ...status, files: status.files.filter((f) => f.index === "." || f.worktree !== "."), ahead: status.ahead + 1 };
      status = { ...status, files: status.files.map((f) => ({ ...f, index: "." })) };
      emit("repo-changed", { worktree: true, refs: false });
      return null;
    }
    if (cmd === "home_dir") return "/home/demo";
    if (cmd === "ignore_read") return ignoreFiles().repo ?? "";
    if (cmd === "ignore_write") {
      gitCalls.push(["ignore_write", (args as { text: string }).text]);
      return void (ignoreFiles().repo = (args as { text: string }).text);
    }
    if (cmd === "global_ignore_read" || cmd === "global_ignore_write") {
      const { path, text } = args as { path: string; text?: string };
      if (!underHome(path)) throw `홈 폴더 밖 경로입니다: ${path}`;
      if (cmd === "global_ignore_read") return ignoreFiles()[path] ?? "";
      gitCalls.push(["global_ignore_write", path, text!]);
      return void (ignoreFiles()[path] = text!);
    }
    if (cmd === "global_ignore_ensure") {
      gitCalls.push(["global_ignore_ensure"]);
      return "/home/demo/.gitignore_global";
    }
    if (cmd === "ssh_keys") return sshKeys();
    if (cmd === "ssh_generate") {
      const { name, passphrase, comment } = args as { name: string; passphrase: string; comment: string };
      if (sshKeys().some((k) => k.name === `${name}.pub` || k.name === name)) throw `${name} 키 파일이 이미 있습니다. 다른 이름을 쓰세요.`;
      gitCalls.push(["ssh_generate", JSON.stringify({ name, passphrase, comment })]);
      const key: SshKey = { name: `${name}.pub`, kind: "ED25519", bits: 256, fingerprint: "SHA256:NewKeyFingerprint0123456789abcdefghijklmnopqr", comment, public: `ssh-ed25519 AAAANewKey ${comment}`, hasPrivate: true };
      (window as any).__ssh = [...sshKeys(), key];
      return key;
    }
    // E2E: window.__noGit = true 면 git 미설치. window.__update = {version}이면 새 버전이 있는 것(없으면 최신), window.__updateFail = 확인 오류 문구,
    //      window.__downloadFail = 다운로드 오류 문구, window.__updateChecks = 확인 횟수. 설치·재시작은 __git에 [update_install]·[relaunch]로 기록한다.
    if (cmd === "git_version") return (window as any).__noGit ? null : ((window as any).__gitVersion ?? "2.45.1");
    if (cmd === "plugin:updater|check") {
      const w = window as any;
      w.__updateChecks = (w.__updateChecks ?? 0) + 1;
      if (w.__updateFail) throw w.__updateFail;
      return w.__update ? { rid: 7, currentVersion: "0.1.0", version: w.__update.version, date: null, body: null, rawJson: {} } : null;
    }
    if (cmd === "plugin:updater|download") {
      const w = window as any;
      const ch = (args as any).onEvent;
      ch.onmessage({ event: "Started", data: { contentLength: 100 } });
      ch.onmessage({ event: "Progress", data: { chunkLength: 40 } });
      return new Promise((res, rej) =>
        setTimeout(() => {
          if (w.__downloadFail) return rej(w.__downloadFail);
          ch.onmessage({ event: "Finished" });
          res(8);
        }, 300),
      );
    }
    if (cmd === "plugin:updater|install") return void gitCalls.push(["update_install"]);
    if (cmd === "plugin:process|restart") return void gitCalls.push(["relaunch"]);
    if (cmd === "plugin:window|hide") return void gitCalls.push(["window_hide"]);
    if (cmd === "plugin:resources|close") return null;
    if (cmd === "ai_status") {
      return aiStatus();
    }
    if (cmd === "ai_settings_set") {
      const a = args as { provider: AiProvider | null; model: string | null; method: AiStatus["method"] | null; consent: boolean | null; select: boolean | null; conventions: boolean | null };
      gitCalls.push(["ai_settings_set", JSON.stringify(a)]);
      const p = a.provider ?? aiSelected();
      const s = aiState(p);
      if (a.model !== null) s.model = a.model.trim() || AI_DEFAULT[p].model;
      if (a.method !== null) s.method = a.method;
      if (a.consent !== null) s.consent = a.consent;
      if (a.conventions !== null) (window as any).__aiConv = a.conventions;
      if (a.select) aiState(), ((window as any).__ai.provider = p);
      return null;
    }
    if (cmd === "ai_key_set") {
      const a = args as { key: string; provider: AiProvider | null };
      gitCalls.push(["ai_key_set", a.key, ...(a.provider ? [a.provider] : [])]);
      aiState(a.provider ?? aiSelected()).key = true;
      return null;
    }
    if (cmd === "ai_key_delete") {
      const a = args as { provider: AiProvider | null };
      gitCalls.push(["ai_key_delete", ...(a.provider ? [a.provider] : [])]);
      aiState(a.provider ?? aiSelected()).key = false;
      return null;
    }
    if (cmd === "ai_cancel") {
      const t = (args as { token: string }).token;
      gitCalls.push(["ai_cancel", t]);
      aiPending.get(t)?.('{"code":"ai.cancelled","vars":{},"message":"Cancelled"}');
      return null;
    }
    if (cmd === "ai_run") {
      const { task, parts, token } = args as { task: AiTask; parts: { label: string; text: string }[]; token: string };
      const w = window as any;
      const { model, effort, repo } = args as { model?: string; effort?: string; repo?: string };
      gitCalls.push(["ai_run", JSON.stringify({ task, parts, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(repo ? { repo } : {}) })]);
      if (!aiState().consent) throw "AI 사용 동의가 필요합니다";
      const size = parts.reduce((n, p) => n + new TextEncoder().encode(p.text).length, 0);
      if (size > 200_000) throw `선택한 내용이 너무 큽니다(${Math.floor(size / 1000)}KB, 상한 200KB). 자르지 않고 중단했습니다. 파일을 골라서(스테이지·범위를 줄여) 다시 시도하세요`;
      return new Promise((resolve, reject) => {
        aiPending.set(token, reject);
        setTimeout(() => {
          aiPending.delete(token);
          if (w.__aiFail) reject(w.__aiFail);
          else {
            // __aiResult[task]: 값 / 배열(호출 순서대로, 모자라면 마지막) / 함수(parts → 값, page.evaluate로만 줄 수 있다)
            const v = w.__aiResult?.[task];
            const n = ((w.__aiN ??= {})[task] = (w.__aiN[task] ?? 0) + 1);
            const r = (Array.isArray(v) ? v[Math.min(n, v.length) - 1] : typeof v === "function" ? v(parts, n) : v) ?? AI_RESULTS[task]; // 배열의 null = 기본 결과
            const repoOff = Object.entries((w.__issue ??= {}) as Record<string, string>).some(([k, x]) => k.toLowerCase() === "git403.aiconventions" && x.toLowerCase() === "false");
            resolve(task === "commit" || task === "pr" ? { ...r, sources: repo && (w.__aiConv ?? true) && !repoOff ? (w.__aiSources ?? AI_SOURCES) : [] } : r);
          }
        }, w.__aiSlow ?? 0);
      });
    }
    // 충돌 입력: window.__stage = {"1"|"2"|"3": 텍스트}, __stageBad = "UTF-8"|"NUL"(Rust의 거부 오류 흉내), __fp(작업 파일 지문, 기본 fp1)
    if (cmd === "conflict_inputs") {
      const w = window as any;
      gitCalls.push(["conflict_inputs", JSON.stringify(args)]);
      if (w.__stageBad) throw `${(args as { path: string }).path}: ours 내용이 ${w.__stageBad === "NUL" ? "NUL이 있어 바이너리로 보입니다" : "UTF-8이 아닙니다"}`;
      const st = w.__stage ?? {};
      return { base: st["1"] ?? null, ours: st["2"] ?? "내용 2\n", theirs: st["3"] ?? "내용 3\n", fingerprint: w.__fp ?? "fp1" };
    }
    if (cmd === "write_in_repo") {
      gitCalls.push(["write_in_repo", JSON.stringify(args)]);
      const exp = (args as { expected: string | null }).expected;
      if (exp !== null && exp !== ((window as any).__fp ?? "fp1")) throw "AI 요청 뒤에 작업 파일이 바뀌었습니다. 덮어쓰지 않았습니다. 다시 요청하세요";
      if ((args as { path: string }).path.includes("..")) throw "저장소 밖 경로입니다";
      return null;
    }
    if (cmd === "accounts_list") return accountList();
    if (cmd === "account_add") {
      const { provider, host, token } = args as { provider: HostProvider; host: string; token: string };
      if (/bad/i.test(token)) throw "토큰이 올바르지 않습니다(401). 토큰과 권한을 확인하세요.";
      if (provider === "bitbucket" && !token.includes(":")) throw "Bitbucket 토큰은 '사용자명:앱 비밀번호' 형식이어야 합니다.";
      const account: HostAccount = { provider, host: host.trim() || DEFAULT_HOST[provider], username: provider === "bitbucket" ? token.split(":")[0] : "new-user" };
      const list = accountList().filter((a) => !(a.provider === provider && a.host === account.host));
      (window as any).__accounts = [...list, account];
      gitCalls.push(["account_add", JSON.stringify({ provider, host: host.trim() })]);
      return account;
    }
    if (cmd === "account_remove") {
      const { account } = args as { account: HostAccount };
      (window as any).__accounts = accountList().filter((a) => !(a.provider === account.provider && a.host === account.host && a.username === account.username));
      gitCalls.push(["account_remove", account.username]);
      return null;
    }
    if (cmd === "remote_info") return remoteInfos();
    // gh(GitHub CLI) 계정: window.__gh = { installed, accounts: [{user, active}], bound, remote, probe: {user: 접근 가능 여부} } (기본: 미설치 = 상태바 항목 숨김).
    //   gh_switch·gh_bind는 __gh를 바꾸고 gitCalls에 기록. pr_* 호출의 localRepo는 window.__prLocal = [[cmd, localRepo]]로 기록(gitCalls를 어지럽히지 않게).
    if (cmd.startsWith("gh_")) {
      const g = ((window as any).__gh ??= {});
      const accounts: { user: string; active: boolean }[] = g.accounts ?? [];
      if (cmd === "gh_accounts") return { installed: !!g.installed, hosts: g.installed ? [{ host: "github.com", accounts }] : [] };
      // g.delay(ms) = gh_switch·gh_bind 지연, g.fail(문구) = 실패 (낙관적 갱신·되돌림 검증용)
      const slow = <T,>(f: () => T) => new Promise<T>((res, rej) => setTimeout(() => (g.fail ? rej(g.fail) : res(f())), g.delay ?? 0));
      if (cmd === "gh_switch") {
        const { user } = args as { host: string; user: string };
        gitCalls.push(["gh_switch", user]);
        return slow(() => ((g.accounts = accounts.map((a) => ({ ...a, active: a.user === user }))), null));
      }
      if (cmd === "gh_repo_account") return { host: "github.com", bound: g.bound ?? null, active: accounts.find((a) => a.active)?.user ?? null, remote: g.remote === undefined ? "demo/git403" : g.remote };
      if (cmd === "gh_bind") {
        const { user } = args as { user?: string };
        gitCalls.push(["gh_bind", user ?? ""]);
        return slow(() => ((g.bound = user ?? null), null));
      }
      if (cmd === "gh_probe") {
        gitCalls.push(["gh_probe"]);
        return accounts.map((a) => ({ user: a.user, ok: g.probe?.[a.user] ?? true }));
      }
    }
    if (/^pr_(list|inbox|detail|create|review_submit)$/.test(cmd)) ((window as any).__prLocal ??= []).push([cmd, (args as { localRepo?: string }).localRepo ?? ""]);
    if (cmd === "pr_list") {
      const w = window as any;
      return new Promise((resolve, reject) => setTimeout(() => (w.__prListFail ? reject(w.__prListFail) : resolve(w.__prs ?? defaultPrs)), w.__slowPrs ?? 0));
    }
    if (cmd === "pr_inbox" || cmd === "pr_detail") {
      const w = window as any;
      gitCalls.push([cmd, JSON.stringify(args)]);
      const ms = (cmd === "pr_inbox" ? w.__slowInbox : w.__slowDetail) ?? 0;
      const fail = cmd === "pr_inbox" ? w.__inboxFail : w.__detailFail;
      const n = (args as { number?: number }).number ?? 0;
      return new Promise((resolve, reject) => setTimeout(() => (fail ? reject(fail) : resolve(cmd === "pr_inbox" ? ((args as { state?: string }).state === "closed" ? w.__inboxClosed ?? [] : w.__inbox ?? defaultInbox) : { ...defaultDetail(n), ...(w.__prDetail?.[n] ?? {}) })), ms));
    }
    // PR 리뷰 게시(26c): 호출 인자를 기록. window.__submitFail(오류 문구), __submit422(true면 GitHub 422 문구 — 첫 줄 코멘트 위치 포함), 성공하면 리뷰 URL
    if (cmd === "pr_review_submit") {
      const w = window as any;
      const a = args as { number: number; comments: { path: string; line: number }[] };
      gitCalls.push(["pr_review_submit", JSON.stringify(args)]);
      return new Promise((resolve, reject) =>
        setTimeout(() => {
          if (w.__submitFail) reject(w.__submitFail);
          else if (w.__submit422) reject(`422 Unprocessable Entity: Pull request review thread line must be part of the diff (${w.__submit422 === true ? `${a.comments.at(-1)?.path}:${a.comments.at(-1)?.line}` : w.__submit422})`);
          else resolve(`https://github.com/demo/git403/pull/${a.number}#pullrequestreview-9001`);
        }, w.__slowSubmit ?? 0),
      );
    }
    if (cmd === "pr_create") {
      gitCalls.push(["pr_create", JSON.stringify(args)]);
      if ((window as any).__prFail) throw (window as any).__prFail;
      return `${webBase((args as { repo: RemoteRepo }).repo)}/pull/42`;
    }
    if (cmd === "pr_web_url") {
      const { repo, head, base } = args as { repo: RemoteRepo; head: string; base: string };
      return `${webBase(repo)}/compare/${base}...${head}?expand=1`;
    }
    if (cmd === "commit_web_url") return `${webBase((args as { repo: RemoteRepo }).repo)}/commit/${(args as { sha: string }).sha}`;
    // 브라우저 열기 (plugin-opener): E2E가 확인할 수 있게 기록만 남긴다
    if (cmd === "plugin:opener|open_url") {
      gitCalls.push(["open_url", (args as { url: string }).url]);
      return null;
    }
    if (cmd === "git") {
      let a = (args as { args: string[] }).args;
      while (a[0] === "-c" && a[1] === "core.quotepath=false") (gitCalls.push(["quotepath", a[2]]), (a = a.slice(2))); // AI 입력 조회의 앞 옵션은 무시하고 ["quotepath", 명령]으로 기록
      // PR 변경 파일(26b): window.__missing = true 면 PR head가 로컬에 없다(cat-file 실패, `fetch … refs/pull/` 작업이 성공하면 생김).
      // __prFiles(ChangedFile[], 기본 변경 3파일), __prRangeDiff(전체 변경 범위의 파일 diff, 기본 샘플). 범위 diff는 ["pr_range_diff", 경로], cat-file·merge-base는 그대로 기록
      if (a[0] === "cat-file") {
        gitCalls.push(a);
        if ((window as any).__missing || (window as any).__missingShas?.some((x: string) => a[2]?.startsWith(x))) throw "fatal: Not a valid object name"; // __missingShas: 이 sha들만 로컬에 없음(강제 푸시)
        return "";
      }
      if (a[0] === "diff" && a.includes("--name-status") && a.includes("-M"))
        return ((window as any).__prFiles ?? files).map((f: ChangedFile) => (f.oldPath ? `R90\t${f.oldPath}\t${f.path}` : `${f.status}\t${f.path}`)).join("\n") + "\n";
      if (a.includes("--numstat") && a.includes("-M")) return (((a[0] === "show" ? (window as any).__changedFiles : (window as any).__prFiles) ?? files) as ChangedFile[]).map((f: ChangedFile, i: number) => `${i + 3}\t${i + 1}\t${f.path}`).join("\n") + "\n";
      // 새 커밋만 리뷰(26d): 이전 head→새 head. 줄 이동·바뀜 분석(-U0, __prIncDiff[경로] = -U0 diff, 기본 변경 없음)은 ["pr_inc_diff", 경로]로, 개수·AI 입력은 __aiIncDiff(범위 diff, 기본 샘플)
      if (a[0] === "diff" && a.includes("-U0")) {
        gitCalls.push(["pr_inc_diff", a.slice(a.indexOf("--") + 1).join(" ")]); // 이름 변경이면 "옛 새"
        if ((window as any).__incDiffFail) throw "fatal: bad revision";
        return (window as any).__prIncDiff?.[a.at(-1)!] ?? "";
      }
      // 26d: <리뷰한 sha>..<head>만 여기서(PR 만들기 시트의 remote/branch..branch 등은 아래 기존 분기로)
      if (a[0] === "rev-list" && a.includes("--count") && /^[0-9a-f]{7,40}\.\.[^/]+$/.test(a.at(-1)!)) return `${(window as any).__incCount ?? 2}\n`;
      if (a[0] === "diff" && a.includes("--no-color") && a.includes("-M") && a.at(-2) !== "base123456789" && (window as any).__aiIncDiff !== undefined) return (window as any).__aiIncDiff;
      if (a[0] === "diff" && a.includes("--no-ext-diff") && !a.includes("--no-color") && !a.includes("--cached")) {
        gitCalls.push(["pr_range_diff", a.at(-1)!]);
        if ((window as any).__prDiffFail) throw "fatal: bad object"; // E2E: AI 코멘트 코드 조각용 diff 조회 실패
        return (window as any).__prRangeDiff ?? diff(a.at(-1)!);
      }
      // PR 화면의 커밋 sha 링크(조회성, 기록 안 함): window.__localShas = 로컬에 있는 전체 sha 목록(앞부분 일치, 기본 없음),
      // window.__shaInfo = {sha(앞부분): {author, at, subject, files}} (호버 카드용 show -s·--numstat 응답, 없으면 오류)
      if (a[0] === "rev-parse" && a.includes("--verify") && a.at(-1)!.endsWith("^{commit}")) {
        const q = a.at(-1)!.slice(0, -9);
        const hit = ((window as any).__localShas ?? []).find((x: string) => x.startsWith(q));
        if (!hit) throw "fatal: Needed a single revision";
        return hit + "\n";
      }
      if (a[0] === "show" && (a.includes("-s") || a.includes("--numstat")) && /^[0-9a-f]{7,40}$/.test(a.at(-1)!)) {
        const info = Object.entries((window as any).__shaInfo ?? {}).find(([k]) => a.at(-1)!.startsWith(k) || k.startsWith(a.at(-1)!))?.[1] as { author: string; at: string; subject: string; files: number } | undefined;
        if (!info) throw "fatal: bad object";
        if (a.includes("--numstat")) return Array.from({ length: info.files }, (_, i) => `1\t0\tf${i}.ts`).join("\n") + "\n";
        return `${info.author}\x1f${info.at}\x1f${info.subject}\n`;
      }
      // Jira 설정(git403.jira.url|keys|off): 전역 = window.__jiraG, 저장소 = window.__issue(같은 키). 읽기는 기록 안 함, 쓰기·삭제는 기록
      // 추천 입력: window.__jiraLog(log -n 500 --format=%B 응답, 기본 ""), window.__jiraDocs = {"CLAUDE.md": 텍스트}(없는 파일은 오류)
      {
        const jg: Record<string, string> = ((window as any).__jiraG ??= {});
        const jl: Record<string, string> = ((window as any).__issue ??= {});
        const jira = (o: Record<string, string>) => Object.entries(o).filter(([k]) => /^git403\.jira\./i.test(k)).map(([k, v]) => [k.toLowerCase(), v] as const);
        if (a[0] === "config" && a.at(-1) === "^git403\\.jira\\.") {
          const lines = (a[1] === "--global" ? jira(jg) : a[1] === "--local" ? jira(jl) : [...jira(jg), ...jira(jl)]).map(([k, v]) => `${k} ${v}`);
          if (!lines.length) throw "git config 종료 코드 1";
          return lines.join("\n") + "\n";
        }
        if (a[0] === "config" && a[1] === "--global" && /^(--unset|git403\.jira\.)/i.test(a[2])) {
          gitCalls.push(a);
          if (a[2] === "--unset") delete jg[a[3].toLowerCase()];
          else jg[a[2].toLowerCase()] = a[3];
          return "";
        }
        if (a[0] === "log" && a.includes("--format=%B") && a.includes("500")) return (window as any).__jiraLog ?? "";
        if (a[0] === "show" && /^HEAD:(CLAUDE|AGENTS|README)\.md$/.test(a[1] ?? "")) {
          const d = (window as any).__jiraDocs?.[a[1].slice(5)];
          if (d === undefined) throw "fatal: path does not exist in HEAD";
          return d;
        }
      }
      // 설정 창의 git config: 읽기(--get-regexp)는 기록 안 함, 쓰기·삭제(--global|--local)는 기록
      if (a[0] === "config" && a.includes("--get-regexp") && /^\^(\(user|user\\\.email|\(diff)/.test(a.at(-1)!)) {
        const re = new RegExp(a.at(-1)!, "i");
        const scope = a[1] === "--global" ? "global" : a[1] === "--local" ? "local" : "all";
        const tools: Record<string, string> = ((window as any).__tools ??= { "diff.tool": "meld", "merge.tool": "meld" });
        const merged = scope === "all" ? { ...cfg().global, ...cfg().local, ...tools } : cfg()[scope];
        const lines = Object.entries(merged).filter(([k]) => re.test(k)).map(([k, v]) => `${k} ${v}`);
        if (!lines.length) throw "git config 종료 코드 1";
        return lines.join("\n") + "\n";
      }
      if (a[0] === "config" && (a[1] === "--global" || a[1] === "--local") && CFG_KEYS.test(a[2] === "--unset" ? a[3] : a[2])) {
        gitCalls.push(a);
        const store = cfg()[a[1] === "--global" ? "global" : "local"];
        if (a[2] === "--unset") {
          if (!(a[3].toLowerCase() in store)) throw "git config 종료 코드 5";
          delete store[a[3].toLowerCase()];
        } else store[a[2].toLowerCase()] = a[3];
        return "";
      }
      // 조회성 명령은 기록에 남기지 않고 값을 돌려준다
      if (a[0] === "lfs" && a[1] === "version") {
        if ((window as any).__noLfs) throw "git: 'lfs' is not a git command";
        return "git-lfs/3.5.1";
      }
      // 외부 도구 설정: window.__tools = {"diff.tool": 이름} (기본 meld, {}면 미설정). --global 저장은 기록한다.
      const tools: Record<string, string> = ((window as any).__tools ??= { "diff.tool": "meld", "merge.tool": "meld" });
      if (a[0] === "config" && a[1] === "--get" && /\.tool$/.test(a[2])) {
        if (!tools[a[2]]) throw "git config 종료 코드 1";
        return tools[a[2]] + "\n";
      }
      if (a[0] === "config" && a[1] === "--global") {
        gitCalls.push(a);
        tools[a[2]] = a[3];
        return "";
      }
      if (a[0] === "config" && a[2] === ".gitmodules") return submodules.map((s) => `submodule.${s.path.split("/").pop()}-mod.path ${s.path}`).join("\n") + "\n";
      // Git Flow 사전 검사용 조회: window.__behind = {"a..b": 개수}, window.__tags = [태그]
      // mergetool 사전 검사: `ls-files -u` 단계 목록. window.__lsU = "줄\n줄" 로 바꿀 수 있다 (기본: 1·2·3단계 일반 파일)
      if (a[0] === "ls-files" && a[1] === "-u")
        return (window as any).__lsU ?? ["1", "2", "3"].map((n) => `100644 abc${n} ${n}\t${a[3]}`).join("\n") + "\n";
      if (a[0] === "rev-list") return `${(window as any).__behind?.[a[2]] ?? 0}\n`;
      if (a[0] === "rev-parse" && a[1] === "-q") {
        if ((window as any).__tags?.includes(a[3].replace("refs/tags/", ""))) return "abc\n";
        throw "exit 1";
      }
      if (a[0] === "rev-parse" && a[1] === "--git-path") return `.git/${a[2]}\n`;
      // 저장소별 AI 끄기(git403.ai): window.__issue["git403.ai"]를 읽는다 (--local 쓰기·삭제는 아래 이슈 규칙 분기가 같은 저장소에 기록)
      // (git403.aiConventions도 같이 읽는다: 키는 git처럼 소문자로 돌려준다)
      if (a[0] === "config" && a[1] === "--local" && a[2] === "--get-regexp" && a[3] === "^git403\\.ai(conventions)?$") {
        const hit = Object.entries(((window as any).__issue ??= {}) as Record<string, string>).filter(([k]) => /^git403\.ai(conventions)?$/i.test(k));
        if (!hit.length) throw "git config 종료 코드 1";
        return hit.map(([k, v]) => `${k.toLowerCase()} ${v}`).join("\n") + "\n";
      }
      // 이슈 링크 규칙(git config git403.issue.<n>.regex|url): window.__issue = {키: 값}. --local 저장·삭제는 기록한다.
      const issue: Record<string, string> = ((window as any).__issue ??= {});
      if (a[0] === "config" && a[1] === "--get-regexp" && a[2].startsWith("^git403")) {
        if (!Object.keys(issue).length) throw "git config 종료 코드 1";
        return Object.entries(issue).map(([k, v]) => `${k} ${v}`).join("\n") + "\n";
      }
      if (a[0] === "config" && a[1] === "--local" && a[2]?.startsWith("git403.")) {
        gitCalls.push(a);
        if (a[3] === undefined) delete issue[a[2]];
        else issue[a[2]] = a[3];
        return "";
      }
      if (a[0] === "config" && a[1] === "--local" && a[2] === "--unset") {
        gitCalls.push(a);
        delete issue[a[3]];
        return "";
      }
      // PR 시트 조회 (기록 안 함): origin/HEAD, 브랜치의 원격, base..head 커밋 제목. window.__originHead="origin/develop", __branchRemote={브랜치: 원격}, __prLog="제목\n제목"
      if (a[0] === "symbolic-ref") {
        const h = (window as any).__originHead;
        if (!h) throw "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref";
        return `${h}\n`;
      }
      if (a[0] === "config" && a[1] === "--get" && a[2]?.startsWith("branch.")) {
        const r = (window as any).__branchRemote?.[a[2].slice(7, -7)];
        if (!r) throw "git config 종료 코드 1";
        return `${r}\n`;
      }
      // PR 템플릿: window.__prTemplate={경로: 내용}
      if (a[0] === "ls-files" && a.length === 1) return Object.keys((window as any).__prTemplate ?? {}).join("\n");
      if (a[0] === "show" && a[1]?.startsWith(":")) return (window as any).__prTemplate?.[a[1].slice(1)] ?? "";
      if (a[0] === "log" && a.includes("--format=%s"))
        return a.includes("-1") ? "그래프 곡선 렌더링\n" : (window as any).__prLog ?? "레인 색상 팔레트\n그래프 곡선 렌더링\n";
      // Git Flow 설정 저장소: window.__flow = {키: 값}. 비어 있으면 실제 git처럼 종료 코드 1 오류.
      const flow: Record<string, string> = ((window as any).__flow ??= {});
      if (a[0] === "config" && a[1] === "--get-regexp") {
        if (!Object.keys(flow).length) throw "git config 종료 코드 1";
        return Object.entries(flow).map(([k, v]) => `${k} ${v}`).join("\n") + "\n";
      }
      // AI 입력 조회 (기록 안 함). window.__stagedDiff(스테이지된 diff, 기본 짧은 diff), __aiDiff(커밋·브랜치·PR diff)
      // 스테이지 지문(가이드 대상 키): 스테이지된 diff 내용이 바뀌면 index 해시가 바뀐다. 호출은 __git에 안 남지만 window.__rawCalls로 센다
      if (a[0] === "diff" && a.includes("--raw")) return (((window as any).__rawCalls = ((window as any).__rawCalls ?? 0) + 1), `:100644 100644 ${"0".repeat(40)} ${[...String((window as any).__stagedDiff ?? "default")].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padEnd(40, "0")} M\tui/src/Toolbar.tsx\n`);
      if (a[0] === "diff" && a[1] === "--cached") return (window as any).__stagedDiff ?? diff("ui/src/Toolbar.tsx");
      if (a[0] === "diff" && a.includes("--stat")) return " ui/src/Toolbar.tsx | 2 +-\n 1 file changed\n";
      if (a[0] === "diff" && a.includes("--no-color") && !a.includes("--binary") || a[0] === "show" && a[1] === "--no-color") return (window as any).__aiDiff ?? diff("crates/graph/src/lib.rs");
      if (a[0] === "log" && a.includes("--reverse") && a.includes("--format=commit %h%n%B")) return "commit 930b8b1\n다크 모드 색 토큰 정리\n\ncommit a131b2c\n구분선 색 다크 모드 대응\n";
      if (a[0] === "log" && a.includes("--format=%B")) return "그래프 곡선 렌더링\n\n본문\n";
      // 패치 저장 사전 검사 (기록 안 함). window.__noDiff = true 면 변경 없음, window.__noHead = true 면 커밋 없는 저장소
      if (a[0] === "diff" && a[1] === "--quiet") {
        if ((window as any).__noDiff) return "";
        throw "exit 1";
      }
      if (a[0] === "rev-parse" && a[1] === "--verify") {
        if ((window as any).__noHead && a[3] === "HEAD") throw "exit 1";
        if ((window as any).__rootCommit && a[3]?.endsWith("^")) throw "exit 1";
        return "abc\n";
      }
      if (a[0] === "merge-base") {
        gitCalls.push(a);
        if ((window as any).__notAncestor) throw "exit 1";
        return "";
      }
      // 스냅샷: stash create는 새 커밋 SHA를 돌려준다 (변경이 없으면 빈 출력)
      if (a[0] === "stash" && a[1] === "create") {
        gitCalls.push(a);
        return (window as any).__clean ? "" : "5nap5h0t\n";
      }
      gitCalls.push(a);
      if (a[0] === "format-patch") return `${a[2]}/0001-patch.patch\n`;
      if (a[0] === "config" && a[1]?.startsWith("gitflow.")) flow[a[1]] = a[2];
      // E2E: window.__gitFail = {prefix: "merge", conflict: true} 면 그 명령에서 실패(충돌이면 status.operation 설정)
      const fail = (window as any).__gitFail;
      if (fail && a.join(" ").startsWith(fail.prefix)) {
        if (fail.conflict) status = { ...status, operation: fail.op ?? "merge" };
        throw fail.conflict ? "CONFLICT (content): Merge conflict" : "fatal: failed";
      }
      return "";
    }
    if (cmd === "start_job" || cmd === "start_shell") {
      const job = ++jobs;
      gitCalls.push(cmd === "start_job" ? ["start_job", JSON.stringify(args)] : ["start_shell", (args as { command: string }).command]);
      // E2E 조작: window.__job = { early: 응답 전에 완료 이벤트, err: 실패 메시지, ms: 걸리는 시간 }
      const o = (window as any).__job ?? {};
      if (o.once) delete (window as any).__job; // once: 이번 한 번만 이 설정(실패 뒤 재시도 테스트)
      const fetched = () => !o.err && (args as { args?: string[] }).args?.[0] === "fetch" && ((window as any).__missing = false); // PR head를 받으면 로컬에 생긴다
      if (o.early) return fetched(), emit("job-done", [job, o.errCode ? JSON.stringify(o.errCode) : o.err ?? null]).then(() => new Promise((r) => setTimeout(() => r(job), 50)));
      // 실제 git처럼 진행률을 여러 번 보낸 뒤 완료한다.
      [10, 45, 80, 100].forEach((pct, k) =>
        setTimeout(() => emit("job", { job, event: { kind: "progress", line: `Receiving objects: ${pct}%` } }), 150 * (k + 1)),
      );
      setTimeout(() => (fetched(), emit("job-done", [job, o.errCode ? JSON.stringify(o.errCode) : o.err ?? null])), o.ms ?? 800);
      return job;
    }
    throw new Error(`mock에 없는 명령: ${cmd}`);
  },
  { shouldMockEvents: true },
);
