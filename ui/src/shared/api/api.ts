// IPC 호출은 이 파일로만 한다. 명령 목록: docs/reuse.md
import { checkUpdate, invoke, openUrl, pickOpen as open, pickSave as save, relaunch } from "./bridge";
import { t } from "../i18n/i18n";
import type { Locale } from "../i18n/i18n";
import { hiddenPatterns } from "../lib/hidden";
import { graphLimit, pref } from "../lib/settings";
import type { GhAccounts, GhProbe, GhRepoAccount, AiProvider, AiEffort, PrReviewComment, ConflictBlobs, AiMethod, AiPart, AiResults, AiStatus, AiTask, BlameLine, ChangedFile, Commit, GraphView, HostAccount, InboxPr, PrDetail, HostProvider, Lfs, Pr, Ref, RemoteInfo, RemoteRepo, SshKey, Stats, StatsRange, Status, Submodule, SettingsApplied, SettingsPreview, SettingsSectionId, Worktree } from "./types";

/** PR 계열 호출에 로컬 저장소 경로(연결된 gh 계정 토큰을 쓰게) */
const lr = (localRepo?: string) => (localRepo ? { localRepo } : {});
export const api = {
  /** Rust가 만드는 문구(오류·메뉴 등)의 언어. 시작 시와 언어가 바뀔 때 부른다 */
  setLocale: (locale: Locale) => invoke<void>("set_locale", { locale }),
  /** 설치된 git 버전. 못 찾으면 null (앱은 git을 번들하지 않는다) */
  gitVersion: () => invoke<string | null>("git_version"),
  /** 업데이트 확인(plugin-updater). 새 버전이 없으면 null */
  checkUpdate: () => checkUpdate(),
  relaunch: () => relaunch(),
  initialRepo: () => invoke<string | null>("initial_repo"),
  pickRepo: () => open({ directory: true, title: t("api.openRepo") }) as Promise<string | null>,
  pickFolder: (title: string) => open({ directory: true, title }) as Promise<string | null>,
  /** OS 저장 대화상자. 취소하면 null */
  pickSave: (title: string, defaultPath: string) => save({ title, defaultPath, filters: [{ name: t("api.patch"), extensions: ["patch", "diff"] }] }) as Promise<string | null>,
  pickPatch: () => open({ title: t("api.pickPatch"), filters: [{ name: t("api.patch"), extensions: ["patch", "diff", "mbox"] }, { name: t("api.allFiles"), extensions: ["*"] }] }) as Promise<string | null>,
  /** 메일 형식(format-patch) 패치면 true → am, 아니면 apply */
  patchIsMail: (path: string) => invoke<boolean>("patch_is_mail", { path }),
  /** 폴더 아래 git 저장소 경로 (정렬) */
  findRepos: (root: string) => invoke<string[]>("find_repos", { root }),
  /** `limit` = 읽을 커밋 수(없으면 첫 페이지). 상한 설정을 넘지 않는다 */
  loadGraph: (repo: string, limit?: number) => invoke<GraphView>("load_graph", { repo, limit: graphLimit(limit), hidden: hiddenPatterns(repo) }),
  /** commit-graph 파일이 없거나 오래됐으면 백그라운드로 만든다 (바로 반환, 실패는 Rust가 로그만) */
  ensureCommitGraph: (repo: string) => invoke<void>("ensure_commit_graph", { repo }),
  /** 작성자 프로필 사진 url (이메일당 한 건, 없으면 null). 캐시는 백엔드 */
  authorAvatars: (repo: string, items: { sha: string; email: string }[]) => invoke<{ email: string; url: string | null; retry?: boolean }[]>("author_avatars", { repo, items }),
  loadRefs: (repo: string) => invoke<Ref[]>("load_refs", { repo }),
  changedFiles: (repo: string, commit: string) => invoke<ChangedFile[]>("changed_files", { repo, commit }),
  fileBlob: (repo: string, rev: string | null, path: string) => invoke<string | null>("file_blob", { repo, rev, path }),
  fileDiff: (repo: string, commit: string, path: string) => invoke<string>("file_diff", { repo, commit, path, ignoreEol: pref("ignoreEol"), ignoreWs: pref("ignoreWs") }),
  loadSubmodules: (repo: string) => invoke<Submodule[]>("load_submodules", { repo }),
  loadWorktrees: (repo: string) => invoke<Worktree[]>("load_worktrees", { repo }),
  lfsStatus: (repo: string) => invoke<Lfs>("lfs_status", { repo }),
  /** 저장소 통계. 집계는 Rust. withLines는 느려서 켤 때만 */
  repoStats: (repo: string, range: StatsRange, branch: string | null, withLines: boolean, token: string) => invoke<Stats>("repo_stats", { repo, range, branch, withLines, token }),
  /** 진행 중인 통계 계산 취소 (repoStats에 준 token). 같은 저장소의 새 요청도 이전 것을 자동 취소한다 */
  cancelStats: (token: string) => invoke<void>("cancel_stats", { token }),
  loadStatus: (repo: string) => invoke<Status>("load_status", { repo }),
  worktreeDiff: (repo: string, path: string, staged: boolean, untracked: boolean) =>
    invoke<string>("worktree_diff", { repo, path, staged, untracked, ignoreEol: pref("ignoreEol"), ignoreWs: pref("ignoreWs") }),
  watchRepo: (repo: string) => invoke<void>("watch_repo", { repo }),
  stage: (repo: string, paths: string[]) => invoke<void>("stage", { repo, paths }),
  unstage: (repo: string, paths: string[]) => invoke<void>("unstage", { repo, paths }),
  /** OS 휴지통으로 (디렉터리·.git·저장소 밖은 거부, 하나라도 걸리면 아무것도 옮기지 않는다) */
  trashFiles: (repo: string, paths: string[]) => invoke<null>("trash_files", { repo, paths }),
  /** rev 커밋의 그 파일 내용으로 작업 트리·스테이지를 되돌린다 (rev에 없으면 거부) */
  restoreFile: (repo: string, rev: string, paths: string[]) => invoke<null>("restore_file", { repo, rev, paths }),
  discard: (repo: string, tracked: string[], untracked: string[]) => invoke<void>("discard", { repo, tracked, untracked }),
  applyPartial: (repo: string, diff: string, hunk: number, lines: number[] | null, target: "stage" | "unstage" | "discard") =>
    invoke<void>("apply_partial", { repo, diff, hunk, lines, target }),
  commit: (repo: string, message: string, amend: boolean) => invoke<void>("commit", { repo, message, amend }),
  /** 루트 .gitattributes에 줄바꿈 규칙(text/eol=)이 있는지 */
  eolRuleExists: (repo: string) => invoke<boolean>("eol_rule_exists", { repo }),
  /** 스테이지된 파일 중 CRLF가 든 텍스트 파일 (eol=crlf 명시 파일 제외) */
  stagedCrlf: (repo: string) => invoke<string[]>("staged_crlf", { repo }),
  /** 스테이지된 내용을 LF로 바꿔 다시 스테이지 */
  fixCrlf: (repo: string, paths: string[]) => invoke<void>("fix_crlf", { repo, paths }),
  lastMessage: (repo: string) => invoke<string>("last_message", { repo }),
  commitMessage: (repo: string, sha: string) => invoke<string>("commit_message", { repo, sha }),
  coAuthors: (repo: string, sha: string) => invoke<string[]>("co_authors", { repo, sha }),
  /** 커밋한 사람 [이름, 이메일, 시각(초)] */
  committer: (repo: string, sha: string) => invoke<[string, string, number]>("committer", { repo, sha }),
  /** 결과만 필요한 짧은 git 명령. 긴 작업(네트워크)은 startJob. */
  /** ok: 실패로 보지 않을 종료 코드(예: config --get 키 없음 = [1]) */
  git: (repo: string, args: string[], ok?: number[]) => invoke<string>("git", ok ? { repo, args, ok } : { repo, args }),
  /** terminal(app: 터미널 앱 이름) | folder | reveal(파일을 탐색기에서 선택) | open(기본 앱). reveal·open의 path는 저장소 기준 상대 경로 */
  openIn: (repo: string, what: "terminal" | "folder" | "reveal" | "open", extra: { app?: string; path?: string } = {}) =>
    invoke<void>("open_in", { repo, what, app: extra.app ?? null, path: extra.path ?? null }),
  /** 끝날 때까지 오래 걸리는 GUI 도구(difftool·mergetool). 바로 돌아오고 끝나면 이벤트 `detached-done [token, err?]` */
  runDetached: (repo: string, args: string[], token: string) => invoke<void>("run_detached", { repo, args, token }),
  cancelDetached: (token: string) => invoke<void>("cancel_detached", { token }),
  /** 셸 명령 작업(`sh -c` / `cmd /C`). 이벤트·취소는 startJob과 같다 */
  startShell: (repo: string, command: string) => invoke<number>("start_shell", { repo, command }),
  askpassReply: (id: number, answer: string | null) => invoke<void>("askpass_reply", { id, answer }),
  rebaseInteractive: (repo: string, base: string, steps: { action: string; sha: string; message?: string }[]) =>
    invoke<void>("rebase_interactive", { repo, base, steps }),
  fileLog: (repo: string, path: string) => invoke<Commit[]>("file_log", { repo, path }),
  searchContent: (repo: string, text: string) => invoke<string[]>("search_content", { repo, text, hidden: hiddenPatterns(repo) }),
  blame: (repo: string, path: string, rev: string | null) => invoke<BlameLine[]>("blame", { repo, path, rev }),
  /** 저장소 안의 텍스트 파일 끝에 한 줄 덧붙인다 (.gitignore 등) */
  /** 서브모듈 제거 뒤 .git/modules/<이름> 삭제 */
  removeGitDir: (repo: string, path: string) => invoke<void>("remove_git_dir", { repo, path }),
  appendLine: (repo: string, file: string, line: string) => invoke<void>("append_line", { repo, file, line }),
  /** 사용자 홈 폴더 (저장소 없이 `git config --global`을 실행할 때의 작업 폴더) */
  homeDir: () => invoke<string>("home_dir"),
  /** 저장소 루트 .gitignore 읽기(없으면 "")·쓰기 */
  ignoreRead: (repo: string) => invoke<string>("ignore_read", { repo }),
  ignoreWrite: (repo: string, text: string) => invoke<void>("ignore_write", { repo, text }),
  /** 전역 excludesfile 읽기·쓰기. 경로는 홈 아래 ignore 파일만(`~/` 가능) */
  globalIgnoreRead: (path: string) => invoke<string>("global_ignore_read", { path }),
  globalIgnoreWrite: (path: string, text: string) => invoke<void>("global_ignore_write", { path, text }),
  /** ~/.gitignore_global이 없으면 만들고 경로를 돌려준다 */
  globalIgnoreEnsure: () => invoke<string>("global_ignore_ensure"),
  /** ~/.ssh의 공개키 목록 (이름·유형·지문·공개키 한 줄) */
  sshKeys: () => invoke<SshKey[]>("ssh_keys"),
  /** ~/.ssh/<name>에 ed25519 키 생성. 같은 이름 파일이 있으면 거부 */
  sshGenerate: (name: string, passphrase: string, comment: string) => invoke<SshKey>("ssh_generate", { name, passphrase, comment }),
  /** 기본 브라우저로 URL 열기 (plugin-opener) */
  openUrl: (url: string) => openUrl(url),
  accountsList: () => invoke<HostAccount[]>("accounts_list"),
  /** 토큰을 확인한 뒤 키체인에 저장. host 빈 값 = 서비스 기본. Bitbucket 토큰은 "사용자명:앱 비밀번호" */
  accountAdd: (provider: HostProvider, host: string, token: string) => invoke<HostAccount>("account_add", { provider, host, token }),
  accountRemove: (account: HostAccount) => invoke<void>("account_remove", { account }),
  /** 원격 URL을 해석한 결과(해석 가능한 원격만) + 매칭 계정 */
  remoteInfo: (repo: string) => invoke<RemoteInfo[]>("remote_info", { repo }),
  prCreate: (account: HostAccount, repo: RemoteRepo, head: string, base: string, title: string, body: string, draft: boolean, localRepo?: string) =>
    invoke<string>("pr_create", { account, repo, head, base, title, body, draft, ...lr(localRepo) }),
  prList: (account: HostAccount, repo: RemoteRepo, localRepo?: string) => invoke<Pr[]>("pr_list", { account, repo, ...lr(localRepo) }),
  /** PR 리뷰 인박스. account 생략(null) = repo.host의 GitHub를 gh 로그인 토큰으로 조회. 토큰 없음·GitHub 아님은 오류 */
  /** state "closed" = 닫힘·머지됨 최근 50개. activity = 최근 활동(타임라인)도 받기 — 응답이 많이 느려져 화면에 쓸 때만 켠다 */
  prInbox: (account: HostAccount | null, repo: RemoteRepo, me: string | null, state: "open" | "closed" = "open", activity = false, localRepo?: string) => invoke<InboxPr[]>("pr_inbox", { account, repo, me, state, activity, ...lr(localRepo) }),
  prDetail: (account: HostAccount | null, repo: RemoteRepo, number: number, localRepo?: string) => invoke<PrDetail>("pr_detail", { account, repo, number, ...lr(localRepo) }),
  /** PR 리뷰 게시(본문 + 줄 코멘트). commitId = 리뷰한 head sha. 줄이 diff 밖이면 422가 GitHub 메시지로 온다. 리뷰 URL을 돌려준다 */
  prReviewSubmit: (account: HostAccount | null, repo: RemoteRepo, number: number, commitId: string, event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES", body: string, comments: PrReviewComment[], localRepo?: string) =>
    invoke<string>("pr_review_submit", { account, repo, number, commitId, event, body, comments, ...lr(localRepo) }),
  prWebUrl: (provider: HostProvider, repo: RemoteRepo, head: string, base: string) => invoke<string>("pr_web_url", { provider, repo, head, base }),
  commitWebUrl: (provider: HostProvider, repo: RemoteRepo, sha: string) => invoke<string>("commit_web_url", { provider, repo, sha }),
  /** AI 방식 감지 결과·설정. 키 값은 돌아오지 않는다 */
  aiStatus: () => invoke<AiStatus>("ai_status"),
  /** 준 것만 바꾼다 (모델 빈 값 = 기본값). provider 생략 = 선택된 공급자, select:true면 그 공급자를 선택 */
  aiSettingsSet: (s: { provider?: AiProvider; model?: string; method?: AiMethod; consent?: boolean; select?: boolean; conventions?: boolean }) =>
    invoke<void>("ai_settings_set", { provider: s.provider ?? null, model: s.model ?? null, method: s.method ?? null, consent: s.consent ?? null, select: s.select ?? null, conventions: s.conventions ?? null }),
  /** API 키는 OS 키체인에만 저장된다. provider 생략 = 선택된 공급자 */
  aiKeySet: (key: string, provider?: AiProvider) => invoke<void>("ai_key_set", { key, provider: provider ?? null }),
  aiKeyDelete: (provider?: AiProvider) => invoke<void>("ai_key_delete", { provider: provider ?? null }),
  /** repo를 주면 Commit·Pr 작업에 저장소 규칙이 붙고 결과에 sources가 온다(설정·저장소에서 껐으면 []). 동의 전·200KB 초과는 거부. token으로 aiCancel 가능(취소하면 오류 "취소했습니다") */
  aiRun: <T extends AiTask>(task: T, parts: AiPart[], token: string, opts?: { model?: string; effort?: AiEffort; repo?: string }) =>
    invoke<AiResults[T]>("ai_run", { task, parts, token, ...(opts?.model ? { model: opts.model } : {}), ...(opts?.effort ? { effort: opts.effort } : {}), ...(opts?.repo ? { repo: opts.repo } : {}) }),
  aiCancel: (token: string) => invoke<void>("ai_cancel", { token }),
  /** 설정 내보내기·가져오기. ui = 내보낼/현재 localStorage 값(허용 목록만, 값 문자열 그대로). 토큰·키체인 값은 Rust가 다루지 않는다 */
  settingsExportFile: (ui: Record<string, string>, path: string) => invoke<null>("settings_export_file", { ui, path }),
  settingsReadFile: (path: string) => invoke<{ json: string }>("settings_read_file", { path }),
  settingsImportPreview: (json: string, ui?: Record<string, string>) => invoke<SettingsPreview>("settings_import_preview", { json, ui: ui ?? null }),
  settingsImportApply: (json: string, sections: SettingsSectionId[], ui?: Record<string, string>) => invoke<SettingsApplied>("settings_import_apply", { json, sections, ui: ui ?? null }),
  /** 충돌 파일의 :1:·:2:·:3: 내용(비UTF-8·NUL이면 오류)과 작업 파일 지문 */
  conflictInputs: (repo: string, path: string) => invoke<ConflictBlobs>("conflict_inputs", { repo, path }),
  /** 저장소 안의 이미 있는 파일 덮어쓰기 (충돌 도우미 적용). expected(지문)를 주면 그사이 파일이 바뀌었을 때 거부 */
  writeInRepo: (repo: string, path: string, text: string, expected: string | null = null) => invoke<void>("write_in_repo", { repo, path, text, expected }),
  /** quiet = 백그라운드 작업(자동 fetch): 인증 입력 창을 띄우지 않고 ssh는 BatchMode */
  /** ghUser: clone에 쓸 gh 계정(https URL만). pref ghRestore가 꺼져 있을 때만 ghRestore:false를 보낸다(생략 = Rust 기본 true) */
  startJob: (repo: string, args: string[], quiet = false, ghUser?: string) => invoke<number>("start_job", { repo, args, ...(quiet ? { interactive: false } : {}), ...(ghUser ? { ghUser } : {}), ...(pref("ghRestore") ? {} : { ghRestore: false }) }),
  /** gh(GitHub CLI) 계정: 목록·전환, 저장소 연결(bind, user 생략 = 해제), 연결 계정 접근 확인(probe) */
  ghAccounts: (host?: string) => invoke<GhAccounts>("gh_accounts", { host: host ?? null }),
  ghSwitch: (host: string, user: string) => invoke<void>("gh_switch", { host, user }),
  ghRepoAccount: (repo: string) => invoke<GhRepoAccount>("gh_repo_account", { repo }),
  ghBind: (repo: string, user?: string) => invoke<void>("gh_bind", { repo, ...(user ? { user } : {}) }),
  ghProbe: (repo: string) => invoke<GhProbe[]>("gh_probe", { repo }),
  cancelJob: (job: number) => invoke<void>("cancel_job", { job }),
};
