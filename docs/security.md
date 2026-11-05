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

### 1. AI가 쓰는 도구
- **AI에게 셸도 `Bash`도 주지 않는다.** 문자열 패턴(`Bash(git *)` 허용 + 금지 목록)은 폐기했다(`-nx`·옵션 묶음·줄임말·로컬 경로 원격·`--contents`·따옴표로 계속 우회됨). `claude`는 `--tools ""`로 내장 도구가 전부 없고, 앱 자신이 MCP stdio 서버(같은 실행 파일의 `--git403-mcp <저장소>`)로 `git{args[]}`(셸 없음)·`read_file`·`edit_file`만 준다. 저장소는 서버 시작 인자로 고정되고 도구는 경로를 받지 않는다.
- **저장소·사용자 설정을 읽지 않는다**: `--restricted`(user·project·local 설정 파일 무시), `--strict-mcp-config`(우리 서버만), `--disable-slash-commands`. `--safe-mode`는 MCP까지 꺼서 쓰지 않는다(남는 건 사용자가 설치한 플러그인의 훅뿐). 로그인(OAuth)은 유지.
- **MCP 서버**: git 출력은 스트림당 1MB까지만 읽고 넘으면 git을 kill("출력 잘림" 표기), 5분 제한(프로세스 그룹 kill, 읽기 스레드는 시간 제한으로 기다림), **redact한 뒤 길이를 자른다**.

### 2. git 인자 검증 (`ai_tool::validate`, 허용 목록)
- 하위 명령별 옵션 표: 긴 옵션은 정확한 이름 또는 `--opt=값`(줄임말 불허), 짧은 옵션 묶음은 글자 단위 분해 검사, 값 검사. **값 방식(없음/선택/필수)은 옵션마다 실제 git과 같아야 한다** — git은 선택값 옵션(`--pretty`·`--unified`…) 뒤 인자를 옵션으로 읽으므로 긴 자유 문자열 값은 `--opt=값` 한 인자만, 선택값은 붙인 값만 받는다. 표는 설치된 git과의 **차등 시험**(`option_table_matches_real_git_option_parsing`)으로 지킨다. 표에 없는 하위 명령·옵션은 거절한다.
- 위치 인자: log·diff·show·reset은 `--` 앞=리비전뿐(없으면 앱이 `--`를 붙임)·경로는 `--` 뒤, blame은 `-- <경로>` 필수, 리비전은 `-`·`+`·절대 경로·`~`·`..`·`.git`/`.claude` 성분 불가, **경로는 정규화 후 저장소 안만이고 성분 중 심볼릭 링크가 하나라도 있으면 거절**, 원격은 `git remote`에 설정된 이름만(fetch·pull·push는 이름을 항상 명시 — 인자 없는 호출은 설정이 가리키는 URL·경로로 갈 수 있다), fetch·pull은 원격 브랜치 이름만(`src:dst` 불가), push는 브랜치/태그 이름 `src[:dst]`(`+`·삭제·`refs/git403` 불가, `--all`·`--tags`·`--no-verify` 없음). 전역 옵션(`-c`·`-C`·`--git-dir`…)·alias·`config` 쓰기·`--list`·`remote -v`·rebase `-x/--exec`·force/delete/mirror·`reset --hard`·`commit -F/-t/--no-verify`·`blame --contents`·`diff --no-index/--output` 등은 없다.
- **앱이 모든 git 호출에 붙이는 옵션**(코드 `ai_tool::prefix`·`validate`와 같다): `--no-pager --work-tree=<저장소 폴더>`(`core.worktree`가 밖을 가리켜도 작업 트리를 이 폴더로 고정), `-c protocol.ext.allow=never core.fsmonitor=false core.pager=cat core.quotepath=false submodule.recurse=false diff.ignoreSubmodules=all status.submoduleSummary=false fetch.prune=false fetch.pruneTags=false push.default=nothing push.recurseSubmodules=no core.hooksPath=<null 장치>`, 원격 명령은 `-c remote.<r>.prune=false remote.<r>.mirror=false remote.<r>.pruneTags=false`. 하위 명령 뒤: diff·log·show·`stash show`에 `--no-ext-diff --no-textconv`, blame에 `--no-textconv`, fetch·pull·push에 `--no-recurse-submodules`, merge·switch에 `--no-overwrite-ignore`. **AI 차례의 모든 git 호출은 훅을 실행하지 않는다**(pre-commit 등; 사용자의 직접 작업에는 영향 없음).
- git 실행 환경: 셸 없음, `GIT_TERMINAL_PROMPT=0`·`GIT_EDITOR=true`·`GIT_PAGER=cat`, `GIT_DIR` 등 저장소 밖을 가리키는 변수 제거.

### 3. 저장소 쪽 git 설정은 허용 목록으로 판정한다 (`ai_config::check`)
- 판정 대상: 상위 local·worktree 설정(include 포함), 공통 git 폴더의 `modules/**/config`(서브모듈 — 상위 설정만 보면 서브모듈의 filter가 `status` 한 번에 실행된다), `worktrees/*/config.worktree`, 그리고 `rev-parse`가 알려 주는 최상위 폴더·git 폴더(꾸며 낸 `.git` 파일).
- 안전 목록에 있는 키만 "깨끗함"(`core.repositoryformatversion/filemode/bare=false/logallrefupdates/ignorecase/precomposeunicode/symlinks/autocrlf/eol…`, `remote.<r>.url|pushurl`, `remote.<r>.fetch`는 기본형 `+refs/heads/*:refs/remotes/<r>/*`일 때만, `remote.<r>.mirror=false`, `branch.<b>.remote|merge|rebase|pushremote|description`, `user.*`, 표준 git-lfs 필터, `submodule.<n>.url|active|branch|path`, `pull|push|rebase|merge.ff|diff.renames|commit.gpgsign|color|status|log|gc|tag|alias(무해)|include|extensions` 등). **목록 밖 키가 하나라도 있으면(`review`) 로컬 전용이어도 대화 첫 실행 전 확인을 요구**하고 키 이름을 보여 준다(textconv·filter·driver·`core.sshCommand`·`credential.helper`·`gpg.program`·`remote.*.uploadpack|vcs`·`core.editor`… 훅·ext-diff·textconv는 앱이 끄지만 필터·병합 드라이버 등은 끌 수 없다).
- **확인으로도 허용하지 않고 거절**(`refuse`, `aiChat.configRefused`): 작업 트리가 이 저장소 폴더가 아님(`core.worktree`가 밖·꾸며 낸 `.git` 파일), `core.bare=true`, `remote.*.mirror=true`, 비어 있지 않은 `remote.*.push`, 기본형이 아닌 `remote.*.fetch`(백업 ref·로컬 브랜치 덮어쓰기·prune 삭제), 서브모듈 `core.worktree`가 저장소 밖, 키·값이 `refs/git403`(백업 이름공간)을 가리킴.
- **지문**: 판정에 쓴 설정 전체의 지문을 확인 키에 넣고(바뀌면 같은 대화도 다시 묻는다), MCP 서버에 `GIT403_CONFIG_FP`로 넘긴다. **서버는 git 도구 호출마다 설정을 다시 판정**해 거절 사유가 생겼거나 지문이 다르면 거절한다(지문이 없으면 git 자체를 거절 — fail-closed). 따라서 차례 중 저장소 설정이 바뀌어도(다른 도구가 바꿔도) 이어서 쓰이지 않는다.
- 알려진 한계: `git add`는 수정된 서브모듈 안에서 그 서브모듈 설정의 filter를 실행할 수 있다(`--ignore-submodules` 옵션이 없다) — 서브모듈 설정은 위에서 판정·확인되므로 사용자가 키를 본 뒤에만 일어난다. 크기 상한(파일당 256KB·합계 20MB·5000개)을 넘는 ignored 파일은 백업에 담기지 않는다.

### 4. 쓰기 경로 (`edit_file`·`git mv`·git 작업이 들여오는 변경)
- **파일 도구**: 저장소 밖·`.git`·`.claude`(대소문자·보이지 않는 글자·8.3·ADS 변형 포함)·경로 성분이 심볼릭 링크인 경로는 읽기·쓰기 모두 거절. 내장 Read/Edit/Glob/Grep은 쓰지 않는다. `.claude` 내용을 `git show <rev>:.claude/…`로 읽는 것도 검증기가 `.claude`·`.git` 성분 인자를 막아 거절된다(정책 표현: "작업 트리 파일 도구로 접근 불가").
- **쓰기 금지 목록**(`ai_tool::write_protected`, 폴더는 어디서든): 에디터·에이전트 `.vscode .idea .cursor .windsurf .zed .devcontainer .continue`, `.mcp.json CLAUDE.md CLAUDE.local.md AGENTS.md GEMINI.md .cursorrules .windsurfrules .clinerules .roomodes .aider* copilot-instructions.md`; 환경 자동 로드 `.envrc`, `mise*.toml`, `.tool-versions`; 훅 도구 `.githooks .husky .lefthook lefthook.yml .pre-commit-config.yaml`(이후 사용자의 commit이 실행); CI·빌드 `.github/** .gitlab .gitlab-ci.yml .circleci .travis.yml azure-pipelines.yml bitbucket-pipelines.yml Jenkinsfile`, `.cargo/config*`(링커·rustflags가 빌드 때 실행), `.npmrc .yarnrc* .pnpmfile.cjs`, `.gitmodules .gitattributes`(서브모듈 URL·필터·diff 드라이버). 읽기는 막지 않는다.
- **git 작업이 들여오는 변경도 검사**: switch·merge·cherry-pick·revert·rebase·`stash apply`는 **실행 전에** 들여올 변경(대상 트리와의 diff)에 쓰기 금지 경로가 있으면 거절한다(`edit_file`·`mv`로 못 쓰는 파일을 git으로 쓰는 우회 차단). `pull`은 가져온 뒤 병합이라 미리 알 수 없어 **끝난 뒤 보호 경로가 바뀌었으면 결과에 경고**를 담는다(UI의 도구 출력에 보임). 수용한 위험: `package.json`·`Makefile`·`build.rs` 같은 프로젝트 본문은 막지 않는다(막으면 AI 작업 대부분이 불가능하고, 실행은 사용자가 빌드할 때 일어나며 diff에 보인다).

### 5. 사용자 확인 (백엔드가 강제)
- 공개 저장소(`public`), 본인 외 협업자가 있는 private(`shared`), 판정 불가(`unknown`), 설정 키 검토(`review`)는 **대화 첫 실행 전** OS 확인창을 거친다(문구: 이유 + 허용 범위 + 저장소 밖 접근 불가). 이어 가기 차례는 생략하되 확인한 뒤 원격(URL·`pushurl`, `insteadOf` 적용 후)이나 설정 지문이 바뀌면 다시 묻는다. 원격이 없거나 전부 같은 컴퓨터의 경로면 `none`(로컬 전용). 판정: GitHub `GET /repos/{o}/{r}`의 `private`, private이면 `GET /user` + `GET /repos/{o}/{r}/collaborators`에서 본인을 뺀 수(1명 이상 = shared). 그 밖의 서비스·계정/토큰 없음·조회 실패·권한 없음·해석 못 하는 원격은 `unknown`.
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
- 2026-11-05: 5차 리뷰 — 저장소 설정 허용 목록 판정(서브모듈 포함)·`--work-tree` 고정·지문 매 호출 대조·백업 무결성·ignored 스냅숏·보호 경로 확대와 git 작업이 들여오는 변경 검사·CSP
- 2026-11-05: 4차 리뷰 — AI 차례 훅 끔·ext-diff/textconv 끔·실행형 저장소 설정 확인·백업 범위(브랜치·작업 트리)·지속형 설정 쓰기 금지·fail-closed 원격 지문
- 2026-11-05: AI 채팅 Bash 폐기 → 자체 MCP 도구 + 검증기(문자열 패턴 우회 재현 뒤), 원격 URL(pushurl·insteadOf) 판정
- 2026-11-05: AI 채팅 허용 목록 전환(금지 목록 `-c alias` 우회·도구 경로 무제한·저장소 설정 신뢰 해소), 위험 저장소 확인 규칙 확정
