// src-tauri/src/lib.rs, crates/*의 Serialize 타입과 1:1로 맞춘다.

export interface Commit {
  id: string;
  parents: string[];
  author: string;
  email: string;
  time: number;
  subject: string;
  /** 본문 앞부분(한 줄로 합침). 검색·설명 열 보조 표시 */
  body: string;
}

export interface Edge {
  from: number;
  to: number;
  color: number;
}

export interface Row {
  lane: number;
  color: number;
  edges: Edge[];
}

export interface GraphView {
  commits: Commit[];
  layout: { rows: Row[]; max_lanes: number };
}

export type JobEvent =
  | { kind: "stdout"; line: string }
  | { kind: "progress"; line: string }
  | { kind: "finished"; code: number | null };

export type RefKind = "local" | "remote" | "tag" | "stash";

export interface Ref {
  kind: RefKind;
  name: string;
  target: string;
  head: boolean;
  message: string | null;
  /** 로컬 브랜치의 upstream 대비 push할·pull할 커밋 수 */
  ahead: number;
  behind: number;
}

export interface ChangedFile {
  status: string;
  path: string;
  oldPath: string | null;
}

export interface StatusFile {
  path: string;
  oldPath: string | null;
  index: string;
  worktree: string;
  untracked: boolean;
  conflict: boolean;
}

export interface Status {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: StatusFile[];
  /** 진행 중인 작업: merge | rebase | cherry-pick | revert | am */
  operation: string | null;
}

export interface RepoChange {
  worktree: boolean;
  refs: boolean;
}

/** 커밋 목록에서 "로컬 변경사항" 행을 고른 상태 */
export const WORKTREE = "WORKTREE";

export interface BlameLine {
  sha: string;
  author: string;
  time: number;
  summary: string;
  text: string;
}

export type SubmoduleStatus = "ok" | "uninitialized" | "modified" | "conflict";

export interface Submodule {
  path: string;
  /** 최상위 .gitmodules에 없는 중첩 서브모듈은 null */
  url: string | null;
  commit: string;
  status: SubmoduleStatus;
}

export interface Worktree {
  path: string;
  head: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  /** 메인 작업 폴더 (목록의 첫 항목) */
  main: boolean;
}

export interface LfsFile {
  path: string;
  oid: string;
  /** false면 포인터만 있음 */
  downloaded: boolean;
}

export interface Lfs {
  installed: boolean;
  tracked: string[];
  files: LfsFile[];
}

export type StatsRange = "all" | "year" | "90d" | "30d";
export interface AuthorStat { name: string; email: string; commits: number; added: number; deleted: number; first: number; last: number }
export interface Stats {
  /** false면 added·deleted는 0 (계산 안 함) */
  withLines: boolean;
  summary: { commits: number; authors: number; first: number | null; last: number | null; branches: number; remoteBranches: number; tags: number; files: number; sizeKb: number };
  authors: AuthorStat[];
  /** 오래된 주부터. start는 그 주 월요일(YYYY-MM-DD) */
  weeks: { start: string; commits: number }[];
  /** [요일 월=0..일=6][시 0..23] */
  heatmap: number[][];
  extensions: { ext: string; count: number }[];
}

export type HostProvider = "github" | "gitlab" | "bitbucket" | "gitea";

/** 연결된 호스팅 계정 (토큰은 OS 키체인에만 있음). host는 `github.com` 또는 셀프호스트 주소 */
export interface HostAccount {
  provider: HostProvider;
  host: string;
  username: string;
}

/** 원격 URL에서 뽑은 저장소. GitLab 하위 그룹은 owner에 슬래시 포함 */
export interface RemoteRepo {
  host: string;
  owner: string;
  name: string;
}

export interface RemoteInfo {
  remote: string;
  url: string;
  provider: HostProvider | null;
  repo: RemoteRepo;
  webUrl: string;
  account: HostAccount | null;
}

export interface Pr {
  number: number;
  title: string;
  url: string;
  head: string;
  base: string;
  author: string;
}

/** PR 리뷰 인박스 항목 (Rust gc-hosting `pr_inbox`) */
export interface InboxPr {
  number: number; title: string; url: string; head: string; base: string; author: string; authorAvatar: string; draft: boolean;
  createdAt: string; updatedAt: string; additions: number; deletions: number; labels: string[]; reviewers: string[]; approvals: number;
  myReview: "none" | "approved" | "commented" | "changes_requested"; reRequested: boolean; headSha: string; isMine: boolean; reviewRequested: boolean;
  state?: "OPEN" | "CLOSED" | "MERGED"; closedAt?: string | null; mergedAt?: string | null;
}
export interface PrTimelineItem { kind: "commit" | "review" | "comment"; author: string; avatar?: string; at: string; sha?: string | null; state?: string | null; body?: string | null }
export interface PrThread { path: string; line: number | null; resolved: boolean; comments: { author: string; avatar?: string; body: string; at: string }[] }
export interface PrDetail {
  body: string; mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"; ci: "SUCCESS" | "FAILURE" | "PENDING" | null; approvals: number; requiredApprovals: number | null;
  unresolvedThreads: number; files: number; additions: number; deletions: number; baseSha: string; headSha: string; timeline: PrTimelineItem[]; reviewThreads: PrThread[];
}

/** ~/.ssh의 공개키 (Rust ssh.rs). 비공개키 내용은 오지 않는다 */
export interface SshKey {
  name: string;
  kind: string;
  bits: number;
  fingerprint: string;
  comment: string;
  public: string;
  hasPrivate: boolean;
}

// ---- gh(GitHub CLI) 계정 (crates/backend/src/gh.rs) ----
export interface GhAccounts { installed: boolean; hosts: { host: string; accounts: { user: string; active: boolean }[] }[] }
/** bound = 이 저장소에 연결한 계정(git config), active = 지금 gh 활성 계정, remote = "owner/name"(GitHub류가 아니면 null) */
export interface GhRepoAccount { host: string; bound: string | null; active: string | null; remote: string | null }
export interface GhProbe { user: string; ok: boolean }

// ---- AI (crates/ai, docs/ai-auth.md) ----
export type AiTask = "commit" | "review" | "conflict" | "pr" | "guide" | "prreview";
export type AiEffort = "low" | "medium" | "high";
/** 모델에 보내는 입력 조각. Rust가 `### 라벨`로 이어 붙이고 합계 200KB를 넘으면 자르지 않고 거부한다 */
export interface AiPart { label: string; text: string }
export type AiMethod = "auto" | "cli" | "key";
export type AiProvider = "anthropic" | "openai" | "google" | "xai";
/** 공급자 하나의 상태. 키 값은 오지 않는다(`key`는 저장 여부만) */
export interface ProviderStatus {
  provider: AiProvider;
  cli: boolean;
  cliVersion: string | null;
  key: boolean;
  method: AiMethod;
  active: "cli" | "key" | null;
  model: string;
  consent: boolean;
}
/** 최상위 = 선택된 공급자의 상태(active가 null이면 AI 메뉴를 숨긴다). providers = 4곳 전부(anthropic·openai·google·xai 순) */
export interface AiStatus extends ProviderStatus {
  providers: ProviderStatus[];
  /** 커밋·PR에 저장소 규칙(CLAUDE.md·AGENTS.md·스킬·템플릿)을 붙일지(전역). 저장소별 끄기는 git config git403.aiConventions false */
  conventions: boolean;
}
/** 저장소 규칙 출처(Commit·Pr 결과에만). path는 저장소 상대 경로 또는 `git log -n 20`·`HEAD` 같은 표시용 문자열 */
export type AiSourceKind = "skill" | "plugin" | "agents" | "claude" | "gemini" | "contributing" | "copilot" | "template" | "commitlint" | "history" | "branch";
export interface AiSource {
  kind: AiSourceKind; path: string; truncated: boolean;
  /** 스킬을 문서가 지정했는지(referenced)·이름으로 찾았는지(matched) */
  via?: "referenced" | "matched";
  /** 지정한 문서:줄 ("CLAUDE.md:168", 전역은 "~/.claude/CLAUDE.md:N") */
  from?: string;
  /** 지정됐는데 못 찾음 (path = 지정된 이름) */
  missing?: boolean;
  /** commit.template이 저장소·홈 밖이라 읽지 않음 (path = "commit.template (<값>)") */
  skipped?: boolean;
}
export interface AiFinding { file: string; line: number; severity: "high" | "medium" | "low" | "info"; message: string }
export interface AiGuideStep { title: string; file: string; startLine: number; endLine: number; detail: string }
export interface AiGuide {
  overview: string;
  decision: { title: string; why: string; alternatives: string[] } | null;
  /** 읽는 순서(1단계부터). file은 입력 diff의 경로, 줄은 새 파일 기준(Rust가 걸러내고 정규화) */
  steps: AiGuideStep[];
  focus: { file: string; line: number; note: string }[];
  apis: { name: string; summary: string; file?: string; line?: number }[];
  checks: string[];
}
/** PR AI 리뷰(26c). 줄은 새 파일 기준, body는 PR에 게시할 문구, evidence는 게시하지 않는 근거 */
export interface AiPrComment { file: string; line: number; endLine: number | null; level: "must" | "should" | "info"; title: string; body: string; evidence: string }
export interface AiPrReview {
  verdict: "approve" | "comment" | "request_changes"; summary: string; praise: string[]; comments: AiPrComment[];
  meta: { model: string; inputTokens: number | null; outputTokens: number | null; elapsedMs: number };
}
/** `pr_review_submit`의 줄 코멘트. 범위면 startLine..line, side는 새 파일(RIGHT) */
export interface PrReviewComment { path: string; line: number; startLine?: number | null; side?: "RIGHT"; body: string }
export interface AiResults {
  commit: { subject: string; body: string; sources?: AiSource[] };
  review: { findings: AiFinding[] };
  conflict: { explanation: string; merged: string };
  pr: { title: string; body: string; sources?: AiSource[] };
  guide: AiGuide;
  prreview: AiPrReview;
}
/** 충돌 파일 단계별 내용(Rust가 UTF-8·NUL 검사). fingerprint는 읽을 때 작업 파일의 지문 */
export interface ConflictBlobs { base: string | null; ours: string; theirs: string; fingerprint: string }

// ---- 설정 내보내기·가져오기 (crates/backend/src/settings_io.rs) ----
export type SettingsSectionId = "ui" | "ai" | "accounts" | "gitGlobal" | "tools";
export interface SettingsChange { key: string; from?: string | null; to: string }
export interface SettingsPreview {
  version: number;
  sections: { id: SettingsSectionId; changes: SettingsChange[] }[];
  skipped: string[];
  warnings: { code: string; vars: Record<string, string>; message: string }[];
}
export interface SettingsApplied {
  applied: unknown;
  /** 적용 전 설정을 저장한 백업 파일 경로 */
  backup: string;
  ui?: Record<string, string>;
  reconnect: { provider: string; host: string; username: string }[];
  skipped: string[];
}
