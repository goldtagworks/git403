# 보안 규칙

보안 문제는 기능 문제보다 우선한다. 이 문서의 규칙을 어기는 변경은 다른 테스트가 통과해도 완료가 아니다.

## 원칙

- **허용 목록만 쓴다.** 외부 프로세스·AI 도구에 줄 권한은 "안전한 것만 허용"으로 정한다. "위험한 것만 막는" 금지 목록은 보조 수단일 뿐 단독으로 쓰지 않는다(옵션 조합·별칭·전역 옵션으로 우회된다).
- **저장소는 신뢰하지 않는다.** 클론한 저장소의 설정(`.claude/`, `.git/config`, 훅, `.gitattributes` 필터 등)이 앱이나 AI 도구의 권한을 넓히면 안 된다.
- **강제는 백엔드에서.** 사용자 확인·권한 판정은 UI만 믿지 않고 백엔드(IPC)에서 다시 검사한다. 확인 없이 들어온 요청은 코드 있는 오류로 거절한다.
- **판정 불가 = 위험.** 공개 여부·권한을 알 수 없으면 안전한 쪽(확인 요구·거절)으로 간다.
- **비밀은 남기지 않는다.** 이력·로그·오류 토스트·AI 입력에 들어가는 텍스트는 저장 전에 `settings_io::redact`로 가린다(토큰, URL `user:pass@`, `Authorization: Bearer`, `password=` 류, 개인키 블록).

## AI 채팅 (`crates/ai/src/chat.rs`, `crates/backend/src/ai_chat.rs`·`ai_risk.rs`)

실제 인자·규칙 값은 `docs/reuse.md` "AI 채팅" 절(코드 `chat.rs`의 `ALLOW_*`·`DENY_*`가 원본, 문서와 다르면 버그).

- **저장소·사용자 설정을 읽지 않는다**: `claude --restricted --safe-mode --strict-mcp-config --mcp-config '{"mcpServers":{}}' --disable-slash-commands`. `--restricted`가 user·project·local 설정 파일(저장소 `.claude/settings*.json`의 allow·훅, 사용자 전역 허용 규칙)을 무시하고 파일 도구를 작업 폴더로 가두며, `--safe-mode`가 플러그인·훅·CLAUDE.md·스킬을 끈다. 로그인(OAuth)은 유지.
- **Bash는 허용 목록만**: `Bash(git *)` 같은 포괄 허용 없이 허용한 하위 명령(`status log diff show … add commit merge rebase fetch pull push switch reset`, 조회형 `branch`·`remote`·`tag`·`config --get`·`worktree list`, `stash push|list|show|apply`)만. 허용 안에서도 위험 옵션은 **줄임말까지 접두사로** 거부(`push --for*`·`reset --h*`·`rebase --ex*`·`fetch --upl*`·`diff --no-i*|--ou*` …, 짧은 옵션 묶음 포함). 전역 옵션(`git -*`: `-c`·`-C`·`--git-dir`…)·별칭·`git config` 쓰기·checkout/restore/clean/pop/drop 등은 허용하지 않는다. 체이닝·`$( )`·리다이렉트·env 접두사는 claude가 승인 필요로 처리해 `-p`에서 거부된다(실제 CLI로 확인).
- **Read·Edit·Glob·Grep은 저장소 작업 트리 안만**(`--restricted`). `.git/**`·`.claude/**` 쓰기는 deny + 제한 모드 승인 필요(`-p`에서 거부). 저장소 밖(`~/.ssh`, `~/.gitconfig`, 셸 rc, `/etc`)은 읽기·쓰기 모두 막힘(실제 CLI로 확인).
- **사용자 확인(백엔드가 강제)**: 공개 저장소(`public`), 본인 외 협업자가 있는 private(`shared`), 판정 불가(`unknown`)는 **대화 첫 실행 전** OS 확인창을 거친다(문구: 이유 + 허용 범위 + 저장소 밖 접근 불가). 이어 가기 차례는 생략. 원격이 없거나 전부 같은 컴퓨터의 경로(`/x`·`../x`·`file://`)면 `none`(로컬 전용 — 확인 없음). 판정: GitHub `GET /repos/{o}/{r}`의 `private`(공개는 토큰 없이도 읽힘), private이면 `GET /user` + `GET /repos/{o}/{r}/collaborators`에서 본인을 뺀 수(1명 이상 = shared). 그 밖의 서비스·계정/토큰 없음·조회 실패·협업자 조회 권한 없음·해석 못 하는 원격은 `unknown`(= 확인). IPC `ai_chat_risk`로 UI가 묻고, `ai_chat_start`는 UI를 믿지 않고 다시 판정해 확인(`confirmed`) 없이는 `aiChat.confirmRequired`로 거절한다.
- 실행 전 HEAD를 `refs/git403/ai-backup/<id>`에 백업하고, 되돌리기는 `reset --hard`가 아니라 `switch` + `reset --keep`(진행 중인 rebase·merge는 사용자가 허락할 때만 abort).
- 이력은 저장 전 `redact`(토큰, URL `user:pass@`(비밀번호에 `/` 포함), `Authorization: Bearer`·`bearer`, `password=`/`pass=`/`pwd=`/`credential`/`private_key` 값, 개인키 블록)로 가린다. 이력 저장이 실패하면 `note` 이벤트로 사용자에게 알린다(로그에만 남기지 않는다).

## 검증 (보안에 닿는 변경마다 필수)

1. **우회 시도를 테스트로 남긴다.** 허용 목록·경로 제한을 바꾸면 실제 `claude` CLI로 우회 명령(예: `git -c alias.x='!sh' x`, `git -c core.pager=…`, `git config core.hooksPath …`, 체이닝 `&&`·`;`·`$( )`·리다이렉트, 저장소 밖 Read/Edit, 악의적 `.claude/settings.json`이 든 저장소)이 막히는지 확인하고 회귀 테스트로 고정한다.
2. **독립 리뷰.** 구현자가 아닌 `reviewer` 에이전트가 "우회할 수 있는가"를 목표로 diff를 점검하고, 지적은 모두 그 단계 안에서 고친다.
3. **문서 동기화.** 허용 목록·확인 규칙이 바뀌면 이 문서와 `docs/reuse.md`를 함께 고친다. 문서와 코드가 다르면 버그로 본다.

변경 이력
- 2026-11-05: AI 채팅 보안 리뷰(금지 목록 `-c` 우회·도구 경로 무제한·저장소 설정 신뢰) 뒤 작성
- 2026-11-05: AI 채팅 허용 목록 전환(금지 목록 `-c alias` 우회·도구 경로 무제한·저장소 설정 신뢰 해소), 위험 저장소 확인 규칙 확정
