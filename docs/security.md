# 보안 규칙

보안 문제는 기능 문제보다 우선한다. 이 문서의 규칙을 어기는 변경은 다른 테스트가 통과해도 완료가 아니다.

## 원칙

- **허용 목록만 쓴다.** 외부 프로세스·AI 도구에 줄 권한은 "안전한 것만 허용"으로 정한다. "위험한 것만 막는" 금지 목록은 보조 수단일 뿐 단독으로 쓰지 않는다(옵션 조합·별칭·전역 옵션으로 우회된다).
- **저장소는 신뢰하지 않는다.** 클론한 저장소의 설정(`.claude/`, `.git/config`, 훅, `.gitattributes` 필터 등)이 앱이나 AI 도구의 권한을 넓히면 안 된다.
- **강제는 백엔드에서.** 사용자 확인·권한 판정은 UI만 믿지 않고 백엔드(IPC)에서 다시 검사한다. 확인 없이 들어온 요청은 코드 있는 오류로 거절한다.
- **판정 불가 = 위험.** 공개 여부·권한을 알 수 없으면 안전한 쪽(확인 요구·거절)으로 간다.
- **비밀은 남기지 않는다.** 이력·로그·오류 토스트·AI 입력에 들어가는 텍스트는 저장 전에 `settings_io::redact`로 가린다(토큰, URL `user:pass@`, `Authorization: Bearer`, `password=` 류, 개인키 블록).

## AI 채팅 (`crates/ai/src/chat.rs`, `crates/core/src/{ai_tool,ai_config,ai_backup}.rs`, `crates/backend/src/{mcp,ai_chat,ai_risk}.rs`)

실제 인자·허용 표는 `docs/reuse.md` "AI 채팅" 절. 규칙의 원본은 코드(`ai_tool.rs`의 옵션 표, `ai_config.rs`의 설정 허용 목록)이고, 문서와 다르면 버그다. **위협 모델**: 저장소는 공격자가 만들었을 수 있다(클론한 `.git` 설정·서브모듈·`.claude`·훅·심볼릭 링크·`.gitattributes`). AI는 그 안에서 프롬프트 주입을 당할 수 있다.

### 0. 다층 방어 (한 층이 뚫려도 다음 층이 막는다)
| 층 | 코드 | 역할 | 이 층이 막지 못하는 것 |
|---|---|---|---|
| 1 도구 제한 | `chat::args`·MCP 서버 | AI에게 셸·내장 도구 없음, `git`·`read_file`·`edit_file`만 | 도구 자체의 허용 범위 안의 오용 |
| 2 인자 검증 | `ai_tool::validate`·`resolve`·`write_protected` | 허용한 하위 명령·옵션·인자만(줄임말·묶음·값 방식까지 git과 대조), 경로는 저장소 안·심볼릭 링크 없음, 쓰기 금지 목록 | git이 설정·저장소 내용으로 프로그램을 실행하는 길(textconv·filter·훅…) |
| 3 저장소 설정 판정 | `ai_config::check` + 지문 매 호출 대조 | 저장소 쪽 git 설정(상위·서브모듈·include·worktree)을 하위 키 허용 목록으로 판정, 위험한 구조(밖을 가리키는 worktree·commondir·로컬 경로 원격 등)는 거절, 목록 밖은 사용자 확인 | 판정 목록에 없는 새 경로·판정 시점과 실행 시점 사이의 변화(지문이 대부분 잡는다) |
| 4 실행 전후 비교 | `mcp::run_guarded`·`preflight` | 작업 트리를 바꾸는 명령이 보호 경로(CI·에디터·훅·에이전트 설정)를 바꾸면 효과를 되돌림 | 보호 경로 밖 파일을 통한 지연 실행(빌드 스크립트 등 — 사용자가 diff로 본다) |
| 5 **OS 샌드박스** | `sandbox.rs` | **위 층이 전부 뚫려도**: git 프로세스와 자식은 저장소·전용 임시 폴더 밖에 쓸 수 없고, 홈·임의 경로를 읽을 수 없고, 셸을 실행할 수 없고(LFS 저장소의 **네트워크 없는** 단계만 예외), 원격 명령이 아니면 네트워크가 없다 | 저장소 **안**의 파일을 덮어쓰는 것(백업·되돌리기가 맡는다), 원격 명령 중 허용한 호스트 포트로의 통신 |
| 6 백업·되돌리기 | `ai_backup` | 작업 전 HEAD·브랜치·작업 트리(+ignored) 스냅숏, 지문 무결성 | — |
| 7 사용자 확인 | `ai_risk`·UI | 공개·협업자·판정 불가·설정 검토·**샌드박스 없음**은 대화 첫 실행 전 확인(백엔드가 강제) | 사용자가 승낙한 위험 |

**샌드박스 플랫폼별**(`sandbox::Mode::detect`, 앱이 정해 MCP 서버에 `GIT403_SANDBOX`로 전달 — 서버는 없거나 알 수 없는 값이면, 또는 약속한 방식이 이 컴퓨터에서 안 돌면 **git을 실행하지 않는다(fail-closed)**):
- **macOS — `sandbox-exec`(Seatbelt), `deny default`**. 쓰기: 저장소(작업 트리+.git)·서버 전용 임시 폴더(`$TMPDIR/git403-mcp-<pid>`, 0700)·`/dev/null`. 읽기: 저장소·임시·시스템(`/usr`·`/System`·`/Library`·`/private/etc`·`/dev`…)·git 설치 경로(`<exec-path>/../..`)·Homebrew·사용자 git 설정(`~/.gitconfig`·`~/.config/git`·`~/.ssh/config`·`known_hosts*`) — **홈 전체 읽기 없음**. 실행: git **실제 바이너리**(`/usr/bin/git`은 xcrun 셔임이라 `<exec-path>/../../bin/git`로 직접)·`exec-path` 도우미·ssh·git-lfs·앱 askpass 실행 파일·전역 설정의 절대 경로 credential helper — **`/bin/sh` 등 셸은 막는다**(필터·textconv·alias·`!` helper·셸 훅 불가). 원격 명령(fetch·pull·push)에만 네트워크(tcp 443·22·DNS, ssh-agent 소켓, askpass 로컬 포트)와 ssh 키(`~/.ssh/id_*`)·키체인(`~/Library/Keychains`)·`known_hosts` 쓰기를 연다 — 이 단계에는 **셸이 없어** 키를 읽을 수 있는 것은 git·ssh·credential helper뿐이다. 호스트 이름 단위 제한은 Seatbelt가 지원하지 않아(포트 단위만) 확인된 원격 호스트로만 제한하지는 못한다 — 대신 네트워크는 원격 명령에만, 그 명령의 원격 이름은 검증기가 설정된 이름만 허용한다.
- **셸이 막혀서 달라진 것**: ① 편집기는 `GIT_EDITOR=:`(`true`도 셸로 실행되어 막힘). ② `!` credential helper(예: `!gh auth git-credential`)와 `core.sshCommand`/`GIT_SSH_COMMAND`는 셸이 필요해 샌드박스 안에서 동작하지 않는다 — https 인증은 앱 askpass 창, ssh는 ssh-agent·키 파일을 쓴다. ③ **LFS**: 표준 git-lfs 필터(`filter.lfs.process`)가 셸(`sh -c`)로 실행된다. 셸을 여는 조건은 **저장소가 실제로 LFS를 쓸 때만**(추적되는 `.gitattributes`·`.git/info/attributes`에 `filter=lfs`가 있고 표준 필터 정의가 유효) — 전역 설정에 `git lfs install`만 돼 있는 사용자는 해당하지 않는다. 열리는 곳은 **네트워크 없는 단계(add·commit·switch·merge…)뿐**이고, 그 프로필에는 네트워크·ssh 키·키체인·askpass가 없다. **원격 명령(fetch·pull·push)에는 셸을 절대 열지 않는다**(net이면 `allow_sh`는 무시): fetch·pull에는 검증기가 `-c filter.lfs.smudge= -c filter.lfs.process= -c filter.lfs.required=false`를 붙여 체크아웃된 LFS 파일이 포인터로 남게 하고(`git lfs pull`은 사용자가 직접), **LFS 저장소에서 `push`는 거절**한다(pre-push 업로드가 셸을 요구; 사용자가 직접 push). 시험: net 프로필에서 덮어쓰기 없이는 LFS 체크아웃이 실패하고 덮어쓰기가 있으면 셸 없이 성공, LFS push 거절(`ai_mcp`), 전역 설정만 있으면 셸 닫힘(`mcp`).
- **Linux — `bwrap`(bubblewrap)이 실제로 돌면** 같은 정책: 시스템 읽기 전용 바인드, 저장소만 쓰기, 전용 임시 폴더를 `/tmp`로, 원격 명령에만 `--share-net`, 사용자 git 설정·(원격 명령에) ssh-agent 소켓 읽기 전용(키 파일 `~/.ssh/id_*`는 바인드하지 않음). **Seatbelt와 같은 정책이라고 할 수 없다**: 포트·호스트 제한이 없다(`--share-net`은 전부 연다). 셸은 존재하는 셸 실행 파일(`/bin/sh`·`bash`·`dash`·`zsh`…)을 `/dev/null`로 덮어 숨기지만(LFS 저장소의 네트워크 없는 단계 제외) 다른 경로의 프로그램 실행까지 막는 것은 아니다. ssh 키 파일은 바인드하지 않고(ssh-agent 소켓만 원격 명령에) 키체인·askpass는 Linux에 해당 없음. **이 환경에서는 시험하지 못했고 인자 구성만 단위 시험한다.** bubblewrap이 없거나 사용자 네임스페이스가 막혀 있으면 샌드박스 없음으로 본다.
- **Windows·샌드박스 없음**: 샌드박스를 쓸 수 없으므로 **AI 채팅은 매 대화(깨끗한 로컬 저장소도) 확인창 + 위험 문구**(`aiChat.confirmNoSandbox`)를 요구한다(백엔드가 강제, `Risk.sandbox: "none"`). 이때 앱의 검사(층 1~4)만 남는다.
- **샌드박스 시험**(`cargo test -p gc-backend sandbox`, macOS는 실제 Seatbelt): 정상 흐름(status·diff·add·commit·switch·stash·merge/rebase 충돌 해결·`rebase --continue`·cherry-pick·revert·mv·rm·reset·log·show·blame·branch·config)이 샌드박스 안에서 된다; **검증기·설정 판정을 거치지 않은** 이전 RCE 재현(textconv·filter·훅·`!` alias(셸 실행), 대상 저장소 `core.alternateRefsCommand`, `core.worktree`로 밖에 쓰기, `commondir`로 다른 저장소 쓰기)이 흔적(밖·저장소 안 표식)을 남기지 못한다(각 공격은 샌드박스 없는 대조군에서 실제로 표식을 만드는 것까지 확인); 읽기 제한(저장소 밖 파일 읽기 실패); 원격 명령이 아니면 네트워크 차단·원격 명령에서 https·ssh 실행; LFS. 통합: `ai_mcp` 시험은 서버를 실제 Seatbelt로 띄워 정상 편집→커밋까지 확인하고, 방식이 없거나 잘못되면 git을 거절한다. 실제 claude 회귀(`--ignored live`)도 MCP 서버가 Seatbelt 안에서 돈다.
- 알려진 한계: 키체인·ssh 키는 원격 명령 중 git/ssh가 읽는다(셸이 막혀 있어 AI가 임의 프로그램으로 읽을 수는 없다). 앱 askpass 인증 경로는 프로파일에 허용했지만 이 시험 환경에서 실제 인증 흐름으로는 확인하지 못했다. credential-osxkeychain의 실제 저장·조회도 시험 환경에 자격 증명이 없어 확인하지 못했다.

### 1. AI가 쓰는 도구
- **AI에게 셸도 `Bash`도 주지 않는다.** 문자열 패턴(`Bash(git *)` 허용 + 금지 목록)은 폐기했다(`-nx`·옵션 묶음·줄임말·로컬 경로 원격·`--contents`·따옴표로 계속 우회됨). `claude`는 `--tools ""`로 내장 도구가 전부 없고, 앱 자신이 MCP stdio 서버(같은 실행 파일의 `--git403-mcp <저장소>`)로 `git{args[]}`(셸 없음)·`read_file`·`edit_file`만 준다. 저장소는 서버 시작 인자로 고정되고 도구는 경로를 받지 않는다.
- **저장소·사용자 설정을 읽지 않는다**: `--restricted`(user·project·local 설정 파일 무시), `--strict-mcp-config`(우리 서버만), `--disable-slash-commands`. `--safe-mode`는 MCP까지 꺼서 쓰지 않는다(남는 건 사용자가 설치한 플러그인의 훅뿐). 로그인(OAuth)은 유지.
- **MCP 서버**: git 출력은 스트림당 1MB까지만 읽고 넘으면 git을 kill("출력 잘림" 표기), 5분 제한(프로세스 그룹 kill, 읽기 스레드는 시간 제한으로 기다림), **redact한 뒤 길이를 자른다**.

### 2. git 인자 검증 (`ai_tool::validate`, 허용 목록)
- 하위 명령별 옵션 표: 긴 옵션은 정확한 이름 또는 `--opt=값`(줄임말 불허), 짧은 옵션 묶음은 글자 단위 분해 검사, 값 검사. **값 방식(없음/선택/필수)은 옵션마다 실제 git과 같아야 한다** — git은 선택값 옵션(`--pretty`·`--unified`…) 뒤 인자를 옵션으로 읽으므로 긴 자유 문자열 값은 `--opt=값` 한 인자만, 선택값은 붙인 값만 받는다. 표는 설치된 git과의 **차등 시험**(`option_table_matches_real_git_option_parsing`)으로 지킨다. 표에 없는 하위 명령·옵션은 거절한다.
- 위치 인자: log·diff·show·reset은 `--` 앞=리비전뿐(없으면 앱이 `--`를 붙임)·경로는 `--` 뒤, blame은 `-- <경로>` 필수, 리비전은 `-`·`+`·절대 경로·`~`·`..`·`.git`/`.claude` 성분 불가, **경로는 정규화 후 저장소 안만이고 성분 중 심볼릭 링크가 하나라도 있으면 거절**, 원격은 `git remote`에 설정된 이름만(fetch·pull·push는 이름을 항상 명시 — 인자 없는 호출은 설정이 가리키는 URL·경로로 갈 수 있다), fetch·pull은 원격 브랜치 이름만(`src:dst` 불가), push는 브랜치/태그 이름 `src[:dst]`(`+`·삭제·`refs/git403` 불가, `--all`·`--tags`·`--no-verify` 없음). 전역 옵션(`-c`·`-C`·`--git-dir`…)·alias·`config` 쓰기·`--list`·`remote -v`·rebase `-x/--exec`·force/delete/mirror·`reset --hard`·`commit -F/-t/--no-verify`·`blame --contents`·`diff --no-index/--output` 등은 없다.
- **앱이 모든 git 호출에 붙이는 옵션**(코드 `ai_tool::prefix`·`validate`와 같다): `--no-pager --work-tree=<저장소 폴더>`(`core.worktree`가 밖을 가리켜도 작업 트리를 이 폴더로 고정), `-c protocol.ext.allow=never core.fsmonitor=false core.pager=cat core.quotepath=false submodule.recurse=false diff.ignoreSubmodules=all status.submoduleSummary=false fetch.prune=false fetch.pruneTags=false push.default=nothing push.recurseSubmodules=no core.hooksPath=<null 장치>`, 원격 명령은 `-c remote.<r>.prune=false remote.<r>.mirror=false remote.<r>.pruneTags=false`. 하위 명령 뒤: diff·log·show·`stash show`에 `--no-ext-diff --no-textconv`, blame에 `--no-textconv`, fetch·pull·push에 `--no-recurse-submodules`, merge·switch에 `--no-overwrite-ignore`. **AI 차례의 모든 git 호출은 훅을 실행하지 않는다**(pre-commit 등; 사용자의 직접 작업에는 영향 없음).
- git 실행 환경: 셸 없음, `GIT_TERMINAL_PROMPT=0`·`GIT_EDITOR=:`·`GIT_SEQUENCE_EDITOR=:`(`true`는 git이 셸로 실행하므로 샌드박스에서 `rebase --continue`가 깨진다)·`GIT_PAGER=cat`, `GIT_DIR` 등 저장소 밖을 가리키는 변수 제거.

### 3. 저장소 쪽 git 설정은 허용 목록으로 판정한다 (`ai_config::check`)
- **판정 대상**: 상위 local·worktree 설정(include 포함), 공통 git 폴더의 `modules/**/config`(서브모듈), `worktrees/*/config.worktree`, **흡수되지 않은 서브모듈**(인덱스 gitlink 경로의 `.git` 디렉터리 config), `include.path`·`includeIf.<조건>.path`가 가리키는 파일 전부(**지금 조건이 안 맞아 git이 안 읽는 includeIf 대상도** 조건과 무관하게 읽어 판정, 중첩 깊이 5), 그리고 `rev-parse`의 최상위·git 폴더.
- **하위 키 단위 허용 목록 + 값 형식 검사**: 묶음 단위("gc.*·log.*·color.* 는 안전")는 없다(`gc.recentObjectsHook`·`log.showSignature` 같은 실행형 하위 키가 묶음에 숨는다). 키마다 값 종류(bool·정수·열거형·이름꼴·상대 경로)를 검사하고 형식이 틀리면 검토 대상이다. 실행·경로형 하위 키(`core.pager`·`core.editor`·`gpg.program`·`diff.*.textconv`·`filter.*`(표준 git-lfs 제외)·`merge.*.driver`·`credential.helper`(비어 있지 않을 때)·`remote.*.uploadpack|receivepack|vcs`·`core.sshCommand`…)는 하나도 안전 목록에 없다. 안전: `core.repositoryformatversion|filemode|bare=false|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|safecrlf|quotepath|untrackedcache|preloadindex|commitgraph|sparsecheckout|longpaths|protectntfs|protecthfs|fsmonitor(bool)|hookspath(상대 경로, 앱이 어차피 덮어씀)`, `extensions.objectformat|refstorage|worktreeconfig|preciousobjects`, `remote.<r>.url|pushurl`(로컬 경로 아님)·`fetch`(기본형)·`mirror=false`·`push`(빔)·`prune|prunetags|promisor`·`tagopt`·`partialclonefilter`, `branch.<b>.remote|pushremote|merge|rebase|description`, `user.name|email|useConfigOnly`, 표준 git-lfs 필터·`lfs.url`(http(s)), `submodule.<n>.url|active|branch|path|update|ignore|fetchrecurse`, `pull.rebase|ff`, `push.default|followTags|autoSetupRemote`, `merge.ff|conflictstyle|renormalize|…`, `rebase.autostash|autosquash|updaterefs`, `diff.renames|algorithm|context|…`, `commit.gpgsign`, `tag.gpgsign|sort`, `color.ui|diff|status|branch|…`, `status.…`, `log.date|abbrevCommit|decorate|…`, `gc.auto|autoDetach|pruneExpire|reflogExpire|writeCommitGraph`, `maintenance.auto`, `fetch.prune|…`, `advice.*`, `alias.*`(`!` 아닌 것), `credential.…username|useHttpPath`, `url.*.insteadOf|pushInsteadOf`. **목록 밖 키(`include.path`·`includeIf` 포함)가 하나라도 있으면 `review`: 로컬 전용이어도 대화 첫 실행 전 확인을 요구**하고 키 이름을 보여 준다.
- **확인으로도 허용하지 않고 거절**(`refuse`, `aiChat.configRefused`, 사유 표시): 작업 트리가 이 저장소 폴더가 아님(`core.worktree`가 밖·꾸며 낸 `.git` 파일), `core.bare=true`, `remote.*.mirror=true`, 비어 있지 않은 `remote.*.push`, 기본형이 아닌 `remote.*.fetch`, 서브모듈 `core.worktree`가 저장소 밖, 키·값이 `refs/git403`을 가리킴, **같은 컴퓨터의 경로·`file:` URL 원격**(`url.*.insteadOf` 적용 뒤의 fetch·push URL 기준 — 대상 저장소 자신의 설정(`core.alternateRefsCommand` 등)이 push·fetch 때 실행되고, fetch로 밖을 읽고 push로 밖에 쓸 수 있다; 로컬 경로 원격이 있는 저장소는 AI 차례를 쓸 수 없다), **git 폴더 구조**: `<repo>/.git`이 저장소 안의 실제 디렉터리가 아님(gitfile·심볼릭 링크 — 연결된 worktree·서브모듈 작업 폴더에서 직접 여는 경우 포함), 정규화한 git-dir·git-common-dir가 `<repo>/.git` 아래가 아님(`commondir` 리다이렉트), `.git/commondir` 파일, `objects/info/alternates`, `.git` 바로 아래의 심볼릭 링크, 서브모듈 gitfile이 `.git/modules` 밖을 가리킴.
- **지문**: 판정에 쓴 설정 전체(+ 최상위·git 폴더 경로)의 지문을 확인 키에 넣고(바뀌면 같은 대화도 다시 묻는다) MCP 서버에 `GIT403_CONFIG_FP`로 넘긴다. **서버는 git 도구 호출마다 설정을 다시 판정**해 거절 사유가 생겼거나 지문이 다르면 거절한다(없으면 git 거절 — fail-closed).
- 알려진 한계: `git add`는 수정된 서브모듈 안에서 그 서브모듈 설정의 filter를 실행할 수 있다(`--ignore-submodules` 옵션이 없다) — 서브모듈 설정은 위에서 판정·확인되므로 사용자가 키를 본 뒤에만 일어난다. 크기 상한(파일당 256KB·합계 20MB·5000개)을 넘는 ignored 파일은 백업에 담기지 않는다.

### 4. 쓰기 경로 (`edit_file`·`git mv`·git 작업이 들여오는 변경)
- **파일 도구**: 저장소 밖·`.git`·`.claude`(대소문자·보이지 않는 글자·8.3·ADS 변형 포함)·경로 성분이 심볼릭 링크인 경로는 읽기·쓰기 모두 거절. 내장 Read/Edit/Glob/Grep은 쓰지 않는다. `.claude` 내용을 `git show <rev>:.claude/…`로 읽는 것도 검증기가 `.claude`·`.git` 성분 인자를 막아 거절된다(정책 표현: "작업 트리 파일 도구로 접근 불가").
- **쓰기 금지 목록**(`ai_tool::write_protected`, 폴더는 어디서든): 에디터·에이전트 `.vscode .idea .cursor .windsurf .zed .devcontainer .continue`, `.mcp.json CLAUDE.md CLAUDE.local.md AGENTS.md GEMINI.md .cursorrules .windsurfrules .clinerules .roomodes .aider* copilot-instructions.md`; 환경 자동 로드 `.envrc`, `mise*.toml`, `.tool-versions`; 훅 도구 `.githooks .husky .lefthook lefthook.yml .pre-commit-config.yaml`; CI·빌드 `.github/** .gitlab .gitlab-ci.yml .circleci .travis.yml azure-pipelines.yml bitbucket-pipelines.yml Jenkinsfile`, `.cargo/config*`, `.npmrc .yarnrc* .pnpmfile.cjs`, `.gitmodules .gitattributes`. 읽기는 막지 않는다. 수용한 위험: `package.json`·`Makefile`·`build.rs` 같은 프로젝트 본문은 막지 않는다(막으면 AI 작업 대부분이 불가능하고, 실행은 사용자가 빌드할 때 일어나며 diff에 보인다).
- **git 작업의 효과는 실행 전후 비교로 막는다**: switch·merge·cherry-pick·revert·rebase·**pull**·`stash`(list·show 제외)·`rm`은 실행 **전에** HEAD·브랜치·보호 경로(추적·untracked·ignored 모두)의 내용을 기록하고, 실행 **후** 보호 경로가 달라졌으면(추가·수정·삭제) 그 명령의 효과를 되돌리고 오류를 낸다: 진행 중인 merge·rebase·cherry-pick·revert를 `--abort` → 브랜치·HEAD를 원위치(`switch`·`reset --keep`, 사용자의 기존 변경은 보존) → 보호 경로 파일 원복 → 전체 상태가 이전과 같은지 다시 검증(못 맞추면 "자동 되돌림이 완전하지 않다"는 경고 오류). 실제 git으로 안전성을 시험한다(HEAD·브랜치·작업 트리 상태·사용자의 기존 보호 파일 보존). 사전 검사(`mcp::preflight`)는 빠른 거절용으로 유지한다: switch 대상·`switch -c <이름> <시작점>`의 시작점, merge·cherry-pick·revert 대상, rebase의 upstream·branch·`--onto`, `stash apply`(untracked를 담은 `^3` 포함). 새로 만든 브랜치(`switch -c x`)는 되돌림 뒤에도 남을 수 있다(해롭지 않은 이름뿐인 ref).

### 5. 사용자 확인 (백엔드가 강제)
- 공개 저장소(`public`), 본인 외 협업자가 있는 private(`shared`), 판정 불가(`unknown`), 설정 키 검토(`review`)는 **대화 첫 실행 전** OS 확인창을 거친다(문구: 이유 + 허용 범위 + 훅 미실행·로컬 원격 불가·CI/에디터/훅 설정 쓰기 불가·저장소 밖 접근 불가). 이어 가기 차례는 생략하되 확인한 뒤 원격(URL·`pushurl`, `insteadOf` 적용 후)이나 설정 지문이 바뀌면 다시 묻는다. **원격이 없으면 `none`(확인 없음)이고, 같은 컴퓨터의 경로 원격은 `none`이 아니라 거절이다**(위 3). 판정: GitHub `GET /repos/{o}/{r}`의 `private`, private이면 `GET /user` + `GET /repos/{o}/{r}/collaborators`에서 본인을 뺀 수(1명 이상 = shared). 그 밖의 서비스·계정/토큰 없음·조회 실패·권한 없음·해석 못 하는 원격은 `unknown`.
- fetch·pull·push 직전에 MCP 서버가 원격 지문을 다시 계산해 확인 때와 다르면 거절한다(없으면 거절 — fail-closed). IPC `ai_chat_risk`로 UI가 묻고, `ai_chat_start`는 UI를 믿지 않고 다시 판정해 확인(`confirmed`) 없이는 `aiChat.confirmRequired`, 확인할 수 없는 설정은 `aiChat.configRefused`로 거절한다.

### 6. 백업·되돌리기
- 실행 전 **HEAD**(`refs/git403/ai-backup/<id>`), **로컬 브랜치 전체**(`…-heads/<id>/<브랜치>`), **작업 트리 스냅숏 커밋**(`…-wip/<id>`: 추적 변경 + untracked + **크기 상한 안의 ignored 파일(.env 등)**, 임시 인덱스라 진짜 인덱스·작업 트리는 그대로)을 보존하고 지문(`digest`)을 기록한다. **차례 끝과 되돌리기 전에 지문을 다시 계산**해 백업 ref가 바뀌었으면(`aiBackup.tampered`) 경고하고 되돌리기를 거절한다.
- 되돌리기는 `reset --hard`가 아니라 `switch` + `reset --keep`(진행 중인 rebase·merge는 사용자가 허락할 때만 abort)이고, 사용자가 따로 승낙하면 다른 로컬 브랜치를 백업 위치로(AI가 만든 브랜치는 보존, 현재·다른 worktree 브랜치는 건너뜀), 작업 트리 파일을 스냅숏 내용으로 복원한다(그 사이 바뀐 파일은 덮어씀).

### 7. 이력·UI
- 이력은 저장 전 `redact`(토큰, URL `user:pass@`, `Authorization: Bearer`·`bearer`, `password=`/`pass=`/`pwd=`/`credential`/`private_key` 값, 개인키 블록)로 가린다. 저장 실패는 `note` 이벤트로 알린다. AI 답의 링크는 실제 주소를 숨기지 않는다(전체 주소를 title로, 보이는 글자에 호스트가 없으면 ` (호스트)` 덧붙임).
- Tauri CSP(`src-tauri/tauri.conf.json`): `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: asset:…; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost; object-src 'none'; frame-src 'none'; form-action 'none'`. 이유: UI는 `fetch`·웹소켓·`eval`을 쓰지 않고 네트워크는 Rust 쪽이 하며, 이미지는 아바타(GitHub·Gravatar·PR 본문)처럼 임의 https 호스트와 data·blob만 필요하다. 인라인 스타일은 React `style`·초기 스플래시용이라 `'unsafe-inline'`(스타일만). 개발(`tauri dev`)용 `devCsp`만 Vite HMR(`ws://localhost:1420`)을 더 연다.

## 검증 (보안에 닿는 변경마다 필수)

1. **우회 시도를 테스트로 남긴다.** 허용 목록·경로 제한을 바꾸면 실제 `claude` CLI로 우회 명령(예: `git -c alias.x='!sh' x`, `git -c core.pager=…`, `git config core.hooksPath …`, 체이닝 `&&`·`;`·`$( )`·리다이렉트, 저장소 밖 Read/Edit, 악의적 `.claude/settings.json`이 든 저장소)이 막히는지 확인하고 회귀 테스트로 고정한다.
2. **독립 리뷰.** 구현자가 아닌 `reviewer` 에이전트가 "우회할 수 있는가"를 목표로 diff를 점검하고, 지적은 모두 그 단계 안에서 고친다.
3. **문서 동기화.** 허용 목록·확인 규칙이 바뀌면 이 문서와 `docs/reuse.md`를 함께 고친다. 문서와 코드가 다르면 버그로 본다.

변경 이력
- 2026-11-05: AI 채팅 보안 리뷰(금지 목록 `-c` 우회·도구 경로 무제한·저장소 설정 신뢰) 뒤 작성
- 2026-11-05: OS 샌드박스 방어층(macOS Seatbelt·Linux bubblewrap·Windows는 확인+경고)과 "다층 방어" 절
- 2026-11-05: 9차 리뷰 — hooksPath 홈 전개·서브모듈 기준·include 설정 파일 보호·샌드박스 밖 git 생성 단일화+소스 검사·확인에 본 지문 대조·저장소 잠금·되돌리기 digest 강제·이력 권한
- 2026-11-05: 8차 리뷰 — 설정이 가리키는 훅 폴더 쓰기 금지·hooksPath review·샌드박스 밖 git(백업·판정)에 훅·필터·fsmonitor 끔 옵션·edit_file 하드링크·O_NOFOLLOW
- 2026-11-05: 7차 리뷰 — 서버 쪽 쓰기 심볼릭 링크 안전화·링크 변화 전후 비교·LFS는 저장소가 실제 쓸 때만 네트워크 없는 단계에서 셸(LFS push 거절)·`.lfsconfig`·`lfs.url`·Linux bwrap 정리
- 2026-11-05: 6차 리뷰 — 하위 키 단위 설정 허용 목록·include 대상 판정·로컬 경로 원격 거절·git 폴더 구조 검사·gc/maintenance/file 프로토콜 끔·실행 전후 비교로 보호 경로 변경 되돌림
- 2026-11-05: 5차 리뷰 — 저장소 설정 허용 목록 판정(서브모듈 포함)·`--work-tree` 고정·지문 매 호출 대조·백업 무결성·ignored 스냅숏·보호 경로 확대와 git 작업이 들여오는 변경 검사·CSP
- 2026-11-05: 4차 리뷰 — AI 차례 훅 끔·ext-diff/textconv 끔·실행형 저장소 설정 확인·백업 범위(브랜치·작업 트리)·지속형 설정 쓰기 금지·fail-closed 원격 지문
- 2026-11-05: AI 채팅 Bash 폐기 → 자체 MCP 도구 + 검증기(문자열 패턴 우회 재현 뒤), 원격 URL(pushurl·insteadOf) 판정
- 2026-11-05: AI 채팅 허용 목록 전환(금지 목록 `-c alias` 우회·도구 경로 무제한·저장소 설정 신뢰 해소), 위험 저장소 확인 규칙 확정

## 7차 리뷰 반영

- **서버 쪽 파일 쓰기·삭제는 심볼릭 링크를 따라가지 않는다.** MCP 서버(샌드박스 밖)가 직접 하는 되돌림·`edit_file`은 `safe_write`·`safe_remove`·`safe_remove_link`·`safe_make_link`만 쓴다: 경로의 모든 성분을 `symlink_metadata`로 검사해 링크가 있거나 저장소 밖·`.git` 아래면 쓰지 않고 실패, 최종 파일은 `O_NOFOLLOW`. 재현(무시된 `x/.cargo/config.toml` + `stash apply`/`switch`로 `x -> $HOME` 링크가 들어옴) → 홈 파일은 그대로, `x`는 실제 디렉터리로 복구(시험 `revert_does_not_write_through_a_directory_replaced_by_a_symlink`).
- **링크 변화도 되돌림 대상**: 실행 전후 비교(`Snap`)가 작업 트리의 **모든 심볼릭 링크**(추적·untracked·ignored)와 보호 경로 내용·HEAD·브랜치를 본다(링크 성분을 따라 읽지 않는다). 사전 검사는 들어오는 변경(`diff --raw -z`의 모드 120000, 스태시 untracked `^3`, merge·cherry-pick·rebase·switch)에서 보호 경로나 심볼릭 링크를 보면 실행 전에 거절한다. `stash apply`처럼 HEAD가 안 바뀌는 명령도 같은 전후 비교를 거친다. 되돌림 순서: 진행 중 작업 `--abort` → 브랜치 → `reset --keep` → 링크 복원(새 링크는 `safe_remove_link` + 샌드박스 git `restore`, 사라진·바뀐 링크는 `safe_make_link`) → 보호 파일 → 최종 동일성 확인(안 맞으면 경고).
- **`.lfsconfig`**는 쓰기 금지 목록에 있고 `ai_config`가 설정 파일처럼 판정한다(`lfs.url`: 로컬 경로 거절·http(s) 안전·그 밖 검토). `lfs.url`(저장소 설정·`.lfsconfig`)은 원격과 같이 `ai_risk` 호스팅 판정에 들어간다(전역 설정의 `lfs.url`은 사용자 환경이라 제외).

## 8차 리뷰 반영

- **설정이 가리키는 훅 폴더는 쓰기 금지**: `core.hooksPath`(상위·서브모듈·worktree·include 어디서든)는 값이 비어 있지 않으면 `review`(사용자 확인에 키 이름이 보임)이고, `ai_config::Verdict.hooks_dirs`가 그 실제 값을 저장소 상대 경로로 모은다. MCP 서버가 `git` 호출과 `edit_file`마다 판정을 다시 해 `ai_tool::set_extra_protected`로 넣으면 정적 목록(`.githooks`·`.husky`…)과 똑같이 `edit_file`·`mv`·`mcp::preflight`(들어오는 변경)·`run_guarded`(전후 비교·되돌림)에 적용된다. 이름 비교는 대소문자·끝의 점·공백을 무시한다(대소문자 무시 파일 시스템·Windows에서 `.HUSKY`·`.GitHub.` 우회 불가 — 시험은 정적 목록 전체의 변형과 이 파일 시스템의 실제 다른 철자 쓰기 거절을 확인).
- **샌드박스 밖에서 도는 모든 git에 안전 옵션**: 앱의 백업 생성·되돌리기·삭제(`ai_backup`)는 샌드박스 밖이라 `GitRunner::hardened`로 `ai_tool::hardened_args()`(훅 끔=`core.hooksPath` null 장치·fsmonitor 끔·외부 프로토콜 끔·pager 없음·서브모듈 안 들어감·gc/maintenance 끔)와 **저장소 설정의 모든 `filter.<이름>`의 clean·smudge·process를 비우고 `required=false`**를 붙인다(`add -A`의 clean, `switch`·`reset`·`restore`의 smudge, `update-ref`의 `reference-transaction`·`post-checkout` 훅이 막힘). 같은 옵션을 설정 판정(`ai_config::check`)의 읽기 git에도 붙였다 — 시험으로 `ls-files`가 `core.fsmonitor` 프로그램을 실행하던 것을 찾아 막았다(`-c`는 command 범위라 판정·지문에 안 들어감). 시험: 대조군(보통 git)은 훅·clean·smudge·fsmonitor가 전부 표식을 만들고, 백업 생성·복원(브랜치·wip 포함)·삭제는 하나도 못 만든다(안전 옵션을 빼면 시험이 실패함을 확인). 이 경로는 사용자가 review 키를 승낙한 뒤에도 같다.
- **`edit_file`은 `ai_tool::write_confined`로**: 경로 성분 심볼릭 링크 거절·`O_NOFOLLOW`·새 파일은 `create_new`, 기존 파일은 하드링크(`nlink>1`)면 거절(링크 반대편이 저장소 밖·보호 경로일 수 있음). 서버의 되돌림 쓰기(`mcp::safe_write`)도 같은 함수.

## 9차 리뷰 반영

- **설정 의존 경로 보호 확대**: `core.hooksPath` 값은 `~`·`~user`를 홈으로 전개하고, 상대 경로는 훅을 돌리는 작업 트리 기준으로 푼다 — 서브모듈 설정(`.git/modules/<이름>/config`는 `core.worktree`, `<서브모듈>/.git/config`는 그 폴더) 출처의 값은 그 서브모듈 작업 트리 기준(작업 트리를 모르면 저장소 루트 기준으로 넓게). include 대상 설정 파일 중 **저장소 안** 경로(아직 없는 파일 포함, `include.path ../local.cfg` 등)는 `Verdict.config_files`로 모아 훅 폴더와 함께 `set_extra_protected`에 넣는다(`edit_file`·`mv`·`preflight`·`run_guarded`). `~user` 전개를 include 경로에도 쓴다.
- **샌드박스 밖 git 생성을 한 곳으로**: 동기는 `ai_tool::git_command(git, cwd)`(훅·fsmonitor·외부 프로토콜 끔 + git 환경 변수 제거), 비동기는 `GitRunner::hardened(hardened_args())`뿐이다. `ai_config::check`·`mcp`의 LFS·credential helper 조회·`ai_risk`의 원격·`lfs.url` 조회·`ai_backup`의 필터 조회가 모두 이걸 쓴다(LFS 판정 git이 맨 `Command::new`이던 곳 수정). 지키는 시험은 `crates/backend/tests/ai_guard.rs`(소스 검사): AI 코드의 비시험 부분에 맨 `Command::new(`·무방비 `GitRunner` 호출이 없고, `ai_backup` 공개 함수마다 `hardened`를 쓴다.
- **확인은 본 상태에만 유효**: `ai_chat_risk`가 `fingerprint`(원격)·`configFp`(설정)를 UI에 주고, `ai_chat_start`는 `confirmed`와 함께 확인창에서 본 값 `seen`을 받아 **다시 판정한 값과 같을 때만** 인정한다(없거나 다르면 `aiChat.confirmRequired`). UI는 이어 가기에서 거절되면 다시 묻고 새 지문으로 한 번 더 시도한다.
- **저장소 단위 잠금**: 정규화한 경로 기준으로 같은 저장소에서 AI 차례는 동시에 하나(대화가 달라도 `aiChat.busy`), 차례가 도는 동안 되돌리기도 `aiChat.busy`. 차례가 끝나면(이력 저장 뒤 마지막 이벤트 직전) 풀린다.
- **되돌리기 지문은 백엔드가 강제**: 이 프로세스가 만든 백업(없으면 채팅 이력)에서 `digest`를 찾아 검사한다 — UI가 `digest`를 빼먹거나 바꿔도 소용없고, 어느 쪽에도 없는 id는 `aiBackup.missing`.
- **이력 보호**: 이력 폴더는 정규화한 경로로 해시(링크·`..`·끝 슬래시로 다른 이력이 되지 않음), 폴더 0700·파일 0600(기존 파일도 다음 저장 때 좁힘, 유닉스).
