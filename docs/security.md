# 보안 규칙

보안 문제는 기능 문제보다 우선한다. 이 문서의 규칙을 어기는 변경은 다른 테스트가 통과해도 완료가 아니다.

## 원칙

- **허용 목록만 쓴다.** 외부 프로세스·AI 도구에 줄 권한은 "안전한 것만 허용"으로 정한다. "위험한 것만 막는" 금지 목록은 보조 수단일 뿐 단독으로 쓰지 않는다(옵션 조합·별칭·전역 옵션으로 우회된다).
- **저장소는 신뢰하지 않는다.** 클론한 저장소의 설정(`.claude/`, `.git/config`, 훅, `.gitattributes` 필터 등)이 앱이나 AI 도구의 권한을 넓히면 안 된다.
- **강제는 백엔드에서.** 사용자 확인·권한 판정은 UI만 믿지 않고 백엔드(IPC)에서 다시 검사한다. 확인 없이 들어온 요청은 코드 있는 오류로 거절한다.
- **판정 불가 = 위험.** 공개 여부·권한을 알 수 없으면 안전한 쪽(확인 요구·거절)으로 간다.
- **비밀은 남기지 않는다.** 이력·로그·오류 토스트·AI 입력에 들어가는 텍스트는 저장 전에 `settings_io::redact`로 가린다(토큰, URL `user:pass@`, `Authorization: Bearer`, `password=` 류, 개인키 블록).

## AI 채팅 (`crates/ai/src/chat.rs`, `crates/core/src/ai_tool.rs`, `crates/backend/src/{mcp,ai_chat,ai_risk}.rs`)

실제 인자·허용 표는 `docs/reuse.md` "AI 채팅" 절. 규칙의 원본은 검증기 코드(`ai_tool.rs`의 하위 명령별 옵션 표)이고, 문서와 다르면 버그다.

- **AI에게 셸도 `Bash`도 주지 않는다.** 문자열 패턴(`Bash(git *)` 허용 + 금지 목록) 방식은 폐기했다(`-nx`·옵션 묶음·줄임말·로컬 경로 원격·`--contents`·따옴표로 계속 우회됨). `claude`는 `--tools ""`로 내장 도구가 전부 없고, 앱 자신이 MCP stdio 서버(같은 실행 파일의 `--git403-mcp <저장소>` 모드)로 도구 셋만 준다: `git{args[]}`(셸 없음)·`read_file`·`edit_file`. 저장소는 서버 시작 인자로 고정되고 도구는 경로를 받지 않는다.
- **저장소·사용자 설정을 읽지 않는다**: `--restricted`(user·project·local 설정 파일 무시), `--strict-mcp-config`(우리 서버만), `--disable-slash-commands`. `--safe-mode`는 MCP까지 꺼서 쓰지 않는다(남는 건 사용자가 설치한 플러그인의 훅뿐). 로그인(OAuth)은 유지.
- **인자 검증은 우리 코드(`ai_tool::validate`)**: 하위 명령별 허용 옵션 표(긴 옵션은 정확한 이름 또는 `--opt=값`, 줄임말 불허, 짧은 옵션 묶음은 글자 단위 분해 검사, 값 검사). 표에 없는 하위 명령·옵션은 거절(허용 목록 — 새 git 옵션이 생겨도 열리지 않음). 위치 인자: 리비전은 `-`·`+`·절대 경로·`~`·`..` 성분·`.git`/`.claude` 불가, 경로는 정규화+심볼릭 링크 해석 후 저장소 안만, 원격은 `git remote`에 설정된 이름만(URL·경로·`file://` 불가), refspec은 `+`·`:dst`·따옴표 불가. 전역 옵션(`-c`·`-C`·`--git-dir`…)·alias·`config` 쓰기·`--list`·`remote -v`·rebase `-x/--exec`·force/delete/mirror·`reset --hard`·`commit -F/-t`·`blame --contents`·`diff --no-index/--output` 등은 없다.
- **파일 도구도 우리 코드**: 저장소 밖·`.git`·`.claude`(대소문자·보이지 않는 글자·8.3·ADS 변형 포함)·심볼릭 링크로 나가는 경로는 읽기·쓰기 모두 거절. 내장 Read/Edit/Glob/Grep은 쓰지 않는다.
- **git 실행 환경**: 셸 없음, `GIT_TERMINAL_PROMPT=0`·`GIT_EDITOR=true`·`GIT_PAGER=cat`, `GIT_DIR` 등 저장소 밖을 가리키는 변수 제거, `-c protocol.ext.allow=never -c core.fsmonitor=false`, 5분 제한. 훅·필터·textconv는 앱의 일반 git과 같이 사용자 저장소 설정을 따르되 AI는 `.git`·config를 바꿀 수 없다(앱 일반 git 대비 새 위험 없음). 출력은 모델에 넘기기 전 `redact`.
- **사용자 확인(백엔드가 강제)**: 공개 저장소(`public`), 본인 외 협업자가 있는 private(`shared`), 판정 불가(`unknown`)는 **대화 첫 실행 전** OS 확인창을 거친다(문구: 이유 + 허용 범위 + 저장소 밖 접근 불가). 이어 가기 차례는 생략하되 **확인한 뒤 원격(URL·`pushurl`, `insteadOf` 적용 후)이 바뀌면 다시 묻는다**(원격 지문을 확인 키에 포함). 원격이 없거나 전부 같은 컴퓨터의 경로(`/x`·`../x`·`file://`)면 `none`(로컬 전용 — 확인 없음). 판정: GitHub `GET /repos/{o}/{r}`의 `private`(공개는 토큰 없이도 읽힘), private이면 `GET /user` + `GET /repos/{o}/{r}/collaborators`에서 본인을 뺀 수(1명 이상 = shared). 그 밖의 서비스·계정/토큰 없음·조회 실패·협업자 조회 권한 없음·해석 못 하는 원격은 `unknown`(= 확인). IPC `ai_chat_risk`로 UI가 묻고, `ai_chat_start`는 UI를 믿지 않고 다시 판정해 확인(`confirmed`) 없이는 `aiChat.confirmRequired`로 거절한다.
- 실행 전 HEAD를 `refs/git403/ai-backup/<id>`에 백업하고, 되돌리기는 `reset --hard`가 아니라 `switch` + `reset --keep`(진행 중인 rebase·merge는 사용자가 허락할 때만 abort).
- 이력은 저장 전 `redact`(토큰, URL `user:pass@`(비밀번호에 `/` 포함), `Authorization: Bearer`·`bearer`, `password=`/`pass=`/`pwd=`/`credential`/`private_key` 값, 개인키 블록)로 가린다. 이력 저장이 실패하면 `note` 이벤트로 사용자에게 알린다.

## 검증 (보안에 닿는 변경마다 필수)

1. **우회 시도를 테스트로 남긴다.** 허용 목록·경로 제한을 바꾸면 실제 `claude` CLI로 우회 명령(예: `git -c alias.x='!sh' x`, `git -c core.pager=…`, `git config core.hooksPath …`, 체이닝 `&&`·`;`·`$( )`·리다이렉트, 저장소 밖 Read/Edit, 악의적 `.claude/settings.json`이 든 저장소)이 막히는지 확인하고 회귀 테스트로 고정한다.
2. **독립 리뷰.** 구현자가 아닌 `reviewer` 에이전트가 "우회할 수 있는가"를 목표로 diff를 점검하고, 지적은 모두 그 단계 안에서 고친다.
3. **문서 동기화.** 허용 목록·확인 규칙이 바뀌면 이 문서와 `docs/reuse.md`를 함께 고친다. 문서와 코드가 다르면 버그로 본다.

변경 이력
- 2026-11-05: AI 채팅 보안 리뷰(금지 목록 `-c` 우회·도구 경로 무제한·저장소 설정 신뢰) 뒤 작성
- 2026-11-05: AI 채팅 Bash 폐기 → 자체 MCP 도구 + 검증기(문자열 패턴 우회 재현 뒤), 원격 URL(pushurl·insteadOf) 판정
- 2026-11-05: AI 채팅 허용 목록 전환(금지 목록 `-c alias` 우회·도구 경로 무제한·저장소 설정 신뢰 해소), 위험 저장소 확인 규칙 확정
