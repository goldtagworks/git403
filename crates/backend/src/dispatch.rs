//! IPC 명령 라우팅: 명령 이름 → 인자 파싱 → 담당 모듈 호출 → JSON. 명령 이름·인자 이름(camelCase)·반환 JSON은
//! 예전 Tauri IPC와 같다 (목록은 docs/reuse.md). 본문 로직은 여기 두지 않는다.

use std::path::PathBuf;

use gc_hosting::{Account, Provider, RemoteRepo};
use serde_json::Value;

use crate::util::{blocking, err, json, off, Args, Res};
use crate::{files, graph, open, Backend};

impl Backend {
    /// 명령 하나를 실행한다.
    pub async fn dispatch(&self, cmd: &str, args: Value) -> Res<Value> {
        let mut a = Args(args);
        let a = &mut a;
        let git = &self.git;
        match cmd {
            "set_locale" => {
                gc_i18n::set(&a.get::<String>("locale")?);
                Ok(Value::Null)
            }
            "git_version" => json(gc_core::git_version(git).await),
            "initial_repo" => json(&self.initial_repo),
            // ---- 조회 ----
            "load_graph" => {
                let (repo, limit, hidden) = (a.repo()?, a.get::<usize>("limit")?, a.get::<Option<Vec<String>>>("hidden")?.unwrap_or_default());
                json(graph::load_graph(git, &repo, limit, &hidden).await?)
            }
            "load_refs" => json(gc_core::read_refs(git, &a.repo()?).await.map_err(err)?),
            "load_submodules" => json(gc_core::read_submodules(git, &a.repo()?).await.map_err(err)?),
            "load_worktrees" => json(gc_core::read_worktrees(git, &a.repo()?).await.map_err(err)?),
            "lfs_status" => json(gc_core::lfs_status(git, &a.repo()?).await.map_err(err)?),
            "load_status" => json(gc_core::read_status(git, &a.repo()?).await.map_err(err)?),
            "changed_files" => {
                let (repo, commit) = (a.repo()?, a.get::<String>("commit")?);
                json(gc_core::changed_files(git, &repo, &commit).await.map_err(err)?)
            }
            "file_diff" => {
                let (repo, commit, path, eol) = (a.repo()?, a.get::<String>("commit")?, a.get::<String>("path")?, a.get::<bool>("ignoreEol")?);
                let ws = a.get::<Option<bool>>("ignoreWs")?.unwrap_or(false); // 없으면 꺼짐 (VS Code 확장 등 옛 호출)
                json(gc_core::file_diff(git, &repo, &commit, &path, eol, ws).await.map_err(err)?)
            }
            "file_blob" => {
                let (repo, rev, path) = (a.repo()?, a.get::<Option<String>>("rev")?, a.get::<String>("path")?);
                let bytes = gc_core::file_blob(git, &repo, rev.as_deref(), &path).await.map_err(err)?;
                json(bytes.as_deref().map(gc_core::base64))
            }
            "worktree_diff" => {
                let (repo, path, staged, untracked, eol) =
                    (a.repo()?, a.get::<String>("path")?, a.get::<bool>("staged")?, a.get::<bool>("untracked")?, a.get::<bool>("ignoreEol")?);
                let ws = a.get::<Option<bool>>("ignoreWs")?.unwrap_or(false);
                json(gc_core::worktree_diff(git, &repo, &path, staged, untracked, eol, ws).await.map_err(err)?)
            }
            "last_message" => json(gc_core::last_message(git, &a.repo()?).await.map_err(err)?),
            "commit_message" => {
                let (repo, sha) = (a.repo()?, a.get::<String>("sha")?);
                json(gc_core::commit_message(git, &repo, &sha).await.map_err(err)?)
            }
            "co_authors" => {
                let (repo, sha) = (a.repo()?, a.get::<String>("sha")?);
                json(gc_core::co_authors(git, &repo, &sha).await.map_err(err)?)
            }
            "file_log" => {
                let (repo, path) = (a.repo()?, a.get::<String>("path")?);
                json(gc_core::file_log(git, &repo, &path, 5000).await.map_err(err)?)
            }
            "search_content" => {
                let (repo, text, hidden) = (a.repo()?, a.get::<String>("text")?, a.get::<Option<Vec<String>>>("hidden")?.unwrap_or_default());
                json(gc_core::search_content(git, &repo, &text, &hidden).await.map_err(err)?)
            }
            "blame" => {
                let (repo, path, rev) = (a.repo()?, a.get::<String>("path")?, a.get::<Option<String>>("rev")?);
                json(gc_core::blame(git, &repo, &path, rev.as_deref()).await.map_err(err)?)
            }
            // 충돌 파일의 공통 조상·ours·theirs를 바이트로 읽어 UTF-8·NUL 검사(실패하면 오류)하고 작업 파일 지문을 함께 준다.
            "conflict_inputs" => {
                let (repo, path) = (a.repo()?, a.get::<String>("path")?);
                json(gc_core::conflict_blobs(git, &repo, &path).await.map_err(err)?)
            }
            // 폴더 아래 git 저장소 찾기 (깊이 4). 디스크 순회라 블로킹 스레드에서 돈다.
            "find_repos" => {
                let root: PathBuf = a.get("root")?;
                let repos = tokio::task::spawn_blocking(move || gc_core::find_repos(&root, 4)).await.map_err(|e| e.to_string())?;
                json(repos.into_iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>())
            }
            // ---- 통계 ----
            "repo_stats" => {
                let (repo, range, branch, with_lines, token) =
                    (a.repo()?, a.get::<gc_core::StatsRange>("range")?, a.get::<Option<String>>("branch")?, a.get::<bool>("withLines")?, a.get::<String>("token")?);
                json(self.stats.run(git, repo, range, branch, with_lines, token).await?)
            }
            "cancel_stats" => {
                self.stats.cancel(&a.get::<String>("token")?);
                Ok(Value::Null)
            }
            // ---- 감시 ----
            "watch_repo" => {
                let emit = self.emit.clone();
                self.watch.watch(a.repo()?, move |c| emit.emit("repo-changed", serde_json::to_value(c).unwrap_or(Value::Null))).await?;
                Ok(Value::Null)
            }
            "watch_add" => {
                let emit = self.emit.clone();
                self.watch.add(a.repo()?, move |c| emit.emit("repo-changed", serde_json::to_value(c).unwrap_or(Value::Null))).await?;
                Ok(Value::Null)
            }
            "watch_remove" => {
                self.watch.remove(&a.repo()?);
                Ok(Value::Null)
            }
            // ---- 변경·커밋 ----
            "stage" => {
                let (repo, paths) = (a.repo()?, a.get::<Vec<String>>("paths")?);
                json(gc_core::stage(git, &repo, &paths).await.map_err(err)?)
            }
            "unstage" => {
                let (repo, paths) = (a.repo()?, a.get::<Vec<String>>("paths")?);
                json(gc_core::unstage(git, &repo, &paths).await.map_err(err)?)
            }
            "discard" => {
                let (repo, tracked, untracked) = (a.repo()?, a.get::<Vec<String>>("tracked")?, a.get::<Vec<String>>("untracked")?);
                json(gc_core::discard(git, &repo, &tracked, &untracked).await.map_err(err)?)
            }
            "trash_files" => {
                let (repo, paths) = (a.repo()?, a.get::<Vec<String>>("paths")?);
                json(blocking(move || gc_core::trash_files(&repo, &paths)).await?)
            }
            "restore_file" => {
                let (repo, rev, paths) = (a.repo()?, a.get::<String>("rev")?, a.get::<Vec<String>>("paths")?);
                json(gc_core::restore_file(git, &repo, &rev, &paths).await.map_err(err)?)
            }
            // hunk(또는 그 안의 일부 줄) 단위 스테이지·언스테이지·버리기. target: "stage" | "unstage" | "discard"
            "apply_partial" => {
                let (repo, diff, hunk, lines, target) =
                    (a.repo()?, a.get::<String>("diff")?, a.get::<usize>("hunk")?, a.get::<Option<Vec<usize>>>("lines")?, a.get::<String>("target")?);
                let target = match target.as_str() {
                    "stage" => gc_core::PatchTarget::Stage,
                    "unstage" => gc_core::PatchTarget::Unstage,
                    _ => gc_core::PatchTarget::Discard,
                };
                json(gc_core::apply_partial(git, &repo, &diff, hunk, lines.as_deref(), target).await.map_err(err)?)
            }
            "commit" => {
                let (repo, message, amend) = (a.repo()?, a.get::<String>("message")?, a.get::<bool>("amend")?);
                json(gc_core::commit(git, &repo, &message, amend).await.map_err(err)?)
            }
            "rebase_interactive" => {
                let (repo, base, steps) = (a.repo()?, a.get::<String>("base")?, a.get::<Vec<gc_core::RebaseStep>>("steps")?);
                json(gc_core::rebase_interactive(git, &repo, &base, &steps).await.map_err(err)?)
            }
            // 루트 `.gitattributes`에 줄바꿈 규칙(`text`/`eol=`)이 있는지
            "eol_rule_exists" => {
                let repo = a.repo()?;
                json(off(move || Ok(gc_core::root_has_eol_rule(&repo))).await?)
            }
            // 스테이지된 파일 중 인덱스에 CRLF가 든 텍스트 파일 (`eol=crlf` 명시 파일 제외)
            "staged_crlf" => json(gc_core::staged_crlf(git, &a.repo()?).await.map_err(err)?),
            // 스테이지된 내용을 LF로 바꿔 다시 스테이지 (작업 파일은 인덱스와 같을 때만 LF로)
            "fix_crlf" => {
                let (repo, paths) = (a.repo()?, a.get::<Vec<String>>("paths")?);
                json(gc_core::fix_crlf(git, &repo, &paths).await.map_err(err)?)
            }
            // 결과만 필요한 짧은 git 명령 (checkout, branch -d, tag …). 긴 작업은 start_job.
            "git" => {
                let (repo, args) = (a.repo()?, a.get::<Vec<String>>("args")?);
                let argv: Vec<&str> = args.iter().map(String::as_str).collect();
                let out = git.output(&repo, &argv).await.map_err(err)?;
                json(String::from_utf8_lossy(&out))
            }
            // ---- 파일 ----
            "append_line" => {
                let (repo, file, line) = (a.repo()?, a.get::<String>("file")?, a.get::<String>("line")?);
                json(off(move || files::append_line(&repo, &file, &line)).await?)
            }
            // 패치 파일이 메일 형식(format-patch)인지. true면 `am`, 아니면 `apply`로 적용한다.
            "patch_is_mail" => {
                let path: PathBuf = a.get("path")?;
                json(blocking(move || gc_core::is_mailbox_patch(&path)).await?)
            }
            "remove_git_dir" => {
                let (repo, path) = (a.repo()?, a.get::<PathBuf>("path")?);
                json(off(move || files::remove_git_dir(&repo, &path)).await?)
            }
            // 저장소 안의 이미 있는 파일을 덮어쓴다 (충돌 도우미 "적용"). `expected`를 주면 그사이 작업 파일이 바뀌지 않았을 때만.
            "write_in_repo" => {
                let (repo, path, text, expected) = (a.repo()?, a.get::<String>("path")?, a.get::<String>("text")?, a.get::<Option<String>>("expected")?);
                json(blocking(move || gc_core::write_in_repo(&repo, &path, &text, expected.as_deref())).await?)
            }
            // ---- 설정 창: 홈·ignore 파일·SSH 키 (docs/reuse.md 설정 절) ----
            "home_dir" => json(gc_core::home_dir().map(|p| p.to_string_lossy().into_owned()).map_err(err)?),
            // 저장소 루트 `.gitignore` 내용 (없으면 빈 문자열)
            "ignore_read" => {
                let repo = a.repo()?;
                json(blocking(move || gc_core::read_text(&gc_core::ignore_path(&repo)?)).await?)
            }
            "ignore_write" => {
                let (repo, text) = (a.repo()?, a.get::<String>("text")?);
                json(blocking(move || gc_core::write_text(&gc_core::ignore_path(&repo)?, &text)).await?)
            }
            "global_ignore_read" => json(files::global_ignore_read(git, a.get("path")?).await?),
            "global_ignore_write" => json(files::global_ignore_write(git, a.get("path")?, a.get("text")?).await?),
            // `~/.gitignore_global`이 없으면 빈 파일로 만들고 경로를 돌려준다
            "global_ignore_ensure" => {
                json(blocking(|| gc_core::ensure_global_ignore(&gc_core::home_dir()?).map(|p| p.to_string_lossy().into_owned())).await?)
            }
            "ssh_keys" => {
                let dir = gc_core::home_dir().map_err(err)?.join(".ssh");
                json(gc_core::list_keys(&dir).await.map_err(err)?)
            }
            // `~/.ssh/<name>`에 새 ed25519 키. 같은 이름 파일이 있으면 거부.
            "ssh_generate" => {
                let (name, passphrase, comment) = (a.get::<String>("name")?, a.get::<String>("passphrase")?, a.get::<String>("comment")?);
                let dir = gc_core::home_dir().map_err(err)?.join(".ssh");
                json(gc_core::generate_key(&dir, &name, &passphrase, &comment).await.map_err(err)?)
            }
            // ---- 호스팅 계정 · PR ----
            "accounts_list" => {
                let accts = self.hosting.accounts();
                json(off(move || accts.list().map_err(|e| e.ipc())).await?)
            }
            // 토큰을 서비스에 확인한 뒤 키체인에 저장. host가 비면 기본 호스트. Bitbucket 토큰은 `사용자명:앱 비밀번호`.
            "account_add" => {
                let (provider, host, token) = (a.get::<Provider>("provider")?, a.get::<String>("host")?, a.get::<String>("token")?);
                json(self.hosting.accounts().add(provider, &host, &token).await.map_err(|e| e.ipc())?)
            }
            "account_remove" => {
                let account: Account = a.get("account")?;
                let accts = self.hosting.accounts();
                json(off(move || accts.remove(&account).map_err(|e| e.ipc())).await?)
            }
            "remote_info" => json(self.hosting.remote_info(git, &a.repo()?).await?),
            "author_avatars" => {
                let (repo, items) = (a.repo()?, a.get::<Vec<gc_hosting::AvatarQuery>>("items")?);
                json(self.hosting.author_avatars(git, &repo, items).await?)
            }
            "pr_create" => {
                let (account, repo, head, base, title, body, draft) = (
                    a.get::<Account>("account")?,
                    a.get::<RemoteRepo>("repo")?,
                    a.get::<String>("head")?,
                    a.get::<String>("base")?,
                    a.get::<String>("title")?,
                    a.get::<String>("body")?,
                    a.get::<bool>("draft")?,
                );
                let local = a.get::<Option<PathBuf>>("localRepo")?;
                let token = match self.gh_bound_token(local.as_deref(), &repo).await {
                    Some(t) => t,
                    None => self.hosting.token(&account).await?,
                };
                json(gc_hosting::create_pr(&account, &token, &repo, &head, &base, &title, &body, draft).await.map_err(|e| e.ipc())?)
            }
            "pr_list" => {
                let (account, repo) = (a.get::<Account>("account")?, a.get::<RemoteRepo>("repo")?);
                let local = a.get::<Option<PathBuf>>("localRepo")?;
                let token = match self.gh_bound_token(local.as_deref(), &repo).await {
                    Some(t) => t,
                    None => self.hosting.token(&account).await?,
                };
                json(gc_hosting::list_prs(&account, &token, &repo).await.map_err(|e| e.ipc())?)
            }
            // PR 리뷰(GitHub GraphQL). account 생략 가능(그러면 `gh auth token`)
            "pr_inbox" => {
                let (account, repo, me) = (a.get::<Option<Account>>("account")?, a.get::<RemoteRepo>("repo")?, a.get::<Option<String>>("me")?);
                // state: "open"(기본)|"closed"(닫힘·머지됨 50개)
                let closed = match a.get::<Option<String>>("state")?.as_deref() {
                    None | Some("open") => false,
                    Some("closed") => true,
                    Some(o) => return Err(format!("invalid argument `state`: {o}")),
                };
                // activity: 최근 활동(타임라인)도 받을지. 생략 = 받음. 끄면 응답이 훨씬 빠르다
                let activity = a.get::<Option<bool>>("activity")?.unwrap_or(true);
                let bound = self.gh_bound_token(a.get::<Option<PathBuf>>("localRepo")?.as_deref(), &repo).await;
                json(self.hosting.pr_inbox(account, &repo, me, closed, activity, git.path_override(), bound).await?)
            }
            "pr_detail" => {
                let (account, repo, number) = (a.get::<Option<Account>>("account")?, a.get::<RemoteRepo>("repo")?, a.get::<u64>("number")?);
                let bound = self.gh_bound_token(a.get::<Option<PathBuf>>("localRepo")?.as_deref(), &repo).await;
                json(self.hosting.pr_detail(account, &repo, number, git.path_override(), bound).await?)
            }
            // PR 리뷰 게시: event = COMMENT|APPROVE|REQUEST_CHANGES, comments[{path,line,startLine?,side?,body}] → 리뷰 URL
            "pr_review_submit" => {
                let (account, repo, number) = (a.get::<Option<Account>>("account")?, a.get::<RemoteRepo>("repo")?, a.get::<u64>("number")?);
                let (commit_id, event, body) = (a.get::<String>("commitId")?, a.get::<String>("event")?, a.get::<String>("body")?);
                let comments = a.get::<Vec<gc_hosting::ReviewComment>>("comments")?;
                let bound = self.gh_bound_token(a.get::<Option<PathBuf>>("localRepo")?.as_deref(), &repo).await;
                json(self.hosting.pr_review_submit(account, &repo, number, &commit_id, &event, &body, &comments, git.path_override(), bound).await?)
            }
            // ---- gh(GitHub CLI) 계정: 표시·전환·저장소 연결 (docs/reuse.md gh 절) ----
            "gh_accounts" => json(self.gh_accounts(a.get::<Option<String>>("host")?).await?),
            "gh_switch" => {
                let (host, user) = (a.get::<String>("host")?, a.get::<String>("user")?);
                self.gh_switch(&host, &user).await?;
                Ok(Value::Null)
            }
            "gh_repo_account" => json(self.gh_repo_account(&a.repo()?).await?),
            // user 생략·빈 값 = 연결 해제
            "gh_bind" => {
                let (repo, user) = (a.repo()?, a.get::<Option<String>>("user")?);
                self.gh_bind(&repo, user).await?;
                Ok(Value::Null)
            }
            "gh_probe" => json(self.gh_probe(&a.repo()?).await?),
            // 토큰 없이 브라우저로 PR을 만드는 페이지 / 커밋 페이지 URL
            "pr_web_url" => {
                let (provider, repo, head, base) = (a.get::<Provider>("provider")?, a.get::<RemoteRepo>("repo")?, a.get::<String>("head")?, a.get::<String>("base")?);
                json(gc_hosting::pr_web_url(provider, &repo, &head, &base))
            }
            "commit_web_url" => {
                let (provider, repo, sha) = (a.get::<Provider>("provider")?, a.get::<RemoteRepo>("repo")?, a.get::<String>("sha")?);
                json(gc_hosting::commit_web_url(provider, &repo, &sha))
            }
            // ---- 설정 내보내기·가져오기 (docs/reuse.md settings_io) ----
            "settings_export" => json(self.settings_export(a.get("ui")?).await?),
            "settings_export_file" => json(self.settings_export_file(a.get("ui")?, a.get("path")?).await?),
            "settings_read_file" => json(self.settings_read_file(a.get("path")?).await?),
            "settings_import_preview" => json(self.settings_import_preview(a.get("json")?, a.get("ui")?).await?),
            "settings_import_apply" => json(self.settings_import_apply(a.get("json")?, a.get("sections")?, a.get("ui")?).await?),
            // ---- AI ----
            // 쓸 방식이 없으면 `active`가 None이고 UI가 AI 메뉴를 숨긴다.
            "ai_status" => json(self.ai.status(git.path_override()).await?),
            "ai_settings_set" => {
                // provider 생략 = 선택된 공급자의 설정. select: true면 그 공급자를 선택
                let (provider, model, method, consent) = (a.get("provider")?, a.get("model")?, a.get("method")?, a.get("consent")?);
                let select = a.get::<Option<bool>>("select")?.unwrap_or(false);
                // conventions: 커밋·PR에 저장소 규칙을 붙일지(공급자와 무관한 전역 설정)
                let conventions = a.get("conventions")?;
                json(self.ai.set_settings(provider, model, method, consent, select, conventions).await?)
            }
            "ai_key_set" => {
                let key: String = a.get("key")?;
                let p = self.ai.key_provider(a.get("provider")?).await?;
                json(off(move || gc_ai::key_set(&gc_hosting::Keychain, p, &key).map_err(|e| e.ipc())).await?)
            }
            "ai_key_delete" => {
                let p = self.ai.key_provider(a.get("provider")?).await?;
                json(off(move || gc_ai::key_delete(&gc_hosting::Keychain, p).map_err(|e| e.ipc())).await?)
            }
            "ai_run" => {
                let (task, parts, token) = (a.get::<gc_ai::Task>("task")?, a.get::<Vec<gc_ai::Part>>("parts")?, a.get::<String>("token")?);
                // 선택: 이번 호출만 모델·노력(low|medium|high) 덮어쓰기. 생략하면 설정 그대로
                let opts = gc_ai::Opts { model: a.get("model")?, effort: a.get("effort")? };
                // 선택: repo(저장소 경로) — 있으면 커밋·PR 작업에 그 저장소의 규칙을 붙인다
                let repo = a.get::<Option<PathBuf>>("repo")?;
                self.ai.run(git, repo, task, parts, token, opts).await
            }
            "ai_cancel" => {
                self.ai.cancel(a.get("token")?);
                Ok(Value::Null)
            }
            // ---- 외부 앱 ----
            "open_in" => {
                let (repo, what, app, path) = (a.repo()?, a.get::<String>("what")?, a.get::<Option<String>>("app")?, a.get::<Option<String>>("path")?);
                open::open_in(git, repo, what, app, path).await?;
                Ok(Value::Null)
            }
            // ---- 긴 작업 ----
            "run_detached" => {
                let (repo, args, token) = (a.repo()?, a.get::<Vec<String>>("args")?, a.get::<String>("token")?);
                self.run_detached(repo, args, token)?;
                Ok(Value::Null)
            }
            "cancel_detached" => {
                self.jobs.cancel_detached(&a.get::<String>("token")?);
                Ok(Value::Null)
            }
            "start_job" => {
                let (repo, args, interactive) = (a.repo()?, a.get::<Vec<String>>("args")?, a.get::<Option<bool>>("interactive")?);
                // ghRestore: 연결된 gh 계정으로 임시 전환했다면 끝난 뒤 원래 계정으로 되돌릴지(생략 = true)
                let restore = a.get::<Option<bool>>("ghRestore")?.unwrap_or(true);
                json(self.start_job(repo, args, interactive, restore).await?)
            }
            "start_shell" => {
                let (repo, command) = (a.repo()?, a.get::<String>("command")?);
                json(self.start_shell(repo, command)?)
            }
            "cancel_job" => {
                self.jobs.cancel(a.get("job")?);
                Ok(Value::Null)
            }
            // 저장소를 열 때 부른다. 바로 돌아오고 commit-graph는 백그라운드로 만든다.
            "ensure_commit_graph" => {
                crate::jobs::spawn_commit_graph(git, a.repo()?);
                Ok(Value::Null)
            }
            "askpass_reply" => {
                let (id, answer) = (a.get::<u64>("id")?, a.get::<Option<String>>("answer")?);
                self.askpass.reply(id, answer);
                Ok(Value::Null)
            }
            _ => Err(format!("unknown command: {cmd}")),
        }
    }
}
