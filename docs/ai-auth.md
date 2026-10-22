# AI 기능 인증 방식 검토 (18단계)

대상 기능: 커밋 메시지 생성, 코드 리뷰, 충돌 해결 도우미, PR 설명 생성.
원칙: git 클라이언트 역할에 충실 — AI는 git 작업을 돕는 데만 쓴다. 범용 에디터·에이전트는 넣지 않는다.

## 선택지

| 방식 | 사용자 경험 | 과금 | 앱이 다루는 비밀 | 판단 |
|---|---|---|---|---|
| A. 설치된 Claude Code CLI에 위임 (`claude -p`, 헤드리스) | 사용자가 이미 Claude Code에 로그인했다면 설정 없음 | 사용자의 Claude Code 계정(구독 또는 API) | 없음 — 인증은 CLI가 처리 | **1순위** |
| B. Anthropic OAuth 프로필 재사용 (`ant auth login`) | 브라우저 로그인 한 번. 공식 SDK가 프로필을 자동으로 읽음 | Claude API 사용량(조직·워크스페이스) | 짧은 수명 토큰 (프로필이 갱신) | 2순위 |
| C. API 키 입력 | 키 복사·붙여넣기 | Claude API 사용량 | 장기 키 — OS 키체인에 저장 | 대체 수단 |
| D. 앱 자체 OAuth로 Claude.ai 구독 계정 연결 | 가장 매끄러워 보임 | 구독 | 앱이 구독 토큰 보관 | **채택하지 않음** (아래) |

### D를 채택하지 않는 이유
- Claude.ai 구독(Pro/Max) 로그인은 Anthropic 자사 제품(Claude 앱, Claude Code)용이다. 서드파티 앱이 이 로그인을 대신 받아 쓰는 공개된 OAuth 클라이언트 등록 경로는 확인되지 않았다.
- 구독 자격 증명을 서드파티 앱에서 쓰는 것은 이용약관상 문제가 될 수 있다. 출시 전에 Anthropic의 최신 약관·개발자 문서로 반드시 다시 확인한다.
- 같은 사용자 경험은 A(CLI 위임)로 얻을 수 있다: 사용자가 자기 Claude Code로 로그인하고, 앱은 그 CLI를 실행만 한다.

## 권장 구조

```
설정 > AI
  ├─ 자동 감지: PATH에 `claude`가 있고 로그인 상태면 → A 사용 (기본)
  ├─ Anthropic 계정으로 로그인 → B (`ant auth login`을 안내하거나 실행, SDK가 프로필 사용)
  └─ API 키 직접 입력 → C (OS 키체인 저장, 화면에 다시 표시하지 않음)
  셋 다 없으면 AI 메뉴를 숨긴다.
```

- 호출은 Rust 코어에서 한다(UI 스레드 차단 없음, 키가 웹뷰에 노출되지 않음).
  - A: `claude -p "<프롬프트>" --output-format json`을 기존 `GitRunner`처럼 비동기 자식 프로세스로 실행, diff는 stdin으로 전달.
  - B·C: Messages API를 HTTP로 호출. 모델 기본값 `claude-opus-5-5`.
    OAuth 토큰은 `Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20` 헤더, API 키는 `x-api-key`.
- 보내는 데이터는 사용자가 고른 diff·커밋 메시지뿐이다. 처음 쓸 때 "선택한 변경 내용이 Anthropic으로 전송됩니다"를 한 번 알리고 동의를 받는다.
- 회사 환경: 저장소별로 AI를 끌 수 있게 하고(`.git/config`의 앱 전용 키), 회사 정책상 외부 전송이 막힌 저장소에서는 메뉴를 숨긴다.

## 기능별 사용

| 기능 | 입력 | 출력 |
|---|---|---|
| 커밋 메시지 | 스테이지된 diff | 제목(50자 안팎) + 본문 초안 → 커밋 상자에 채움, 사용자가 수정 |
| 코드 리뷰 | 커밋 또는 브랜치 diff | 파일·줄 위치가 있는 지적 목록 → diff 옆에 표시 |
| 충돌 도우미 | 충돌 파일의 양쪽 버전 + 공통 조상 | 양쪽 의도 설명 + 병합안 → 사용자가 확인 후 적용 |
| PR 설명 | 브랜치 커밋 목록 + 요약 diff | PR 본문 초안 → PR 만들기 화면(15단계)에 채움 |

## worktree 에이전트 실행
"클라이언트 역할에 충실"하기로 한 결정에 따라 넣지 않는다.
나중에 다시 검토한다면 A(CLI 위임)를 그대로 쓰면 된다 — 앱은 worktree를 만들고 `claude`를 그 안에서 실행한 뒤, 결과를 기존 변경사항·diff 화면으로 검토만 한다.

## 함께 필요한 OAuth (AI 아님)
PR 만들기(15단계)에는 GitHub·GitLab 등의 OAuth가 필요하다. GitHub는 데스크톱 앱용 **device flow**(코드 입력 방식)가 공식 지원되어 비밀 키 없이 연결할 수 있다. 토큰은 OS 키체인에 저장한다.

## 구현 상태 (18단계)

| 항목 | 상태 |
|---|---|
| A. Claude Code CLI 위임 | 구현. `claude --version`으로 감지, `claude -p --output-format json --tools ""`(stdin 프롬프트). PATH는 로그인 셸 보정 사용 |
| B. Anthropic OAuth 프로필 | **후속**(이번 범위 제외). 구현하면 `Backend`에 변형을 하나 추가하고 `resolve`의 우선순위에 넣는다 |
| C. API 키 | 구현. Messages API 직접 호출(reqwest), 키는 OS 키체인(`git403` / `ai:anthropic`), 웹뷰로는 "설정됨"만 전달 |
| D. 구독 계정 OAuth | 채택하지 않음(위 사유 그대로) |
| 방식 선택 | 설정 > AI: 자동(CLI 우선) / CLI만 / 키만. 쓸 방식이 없으면 AI 메뉴·버튼을 숨김 |
| 동의 | 첫 사용 때 OS 확인창으로 한 번, `ai.json`에 저장. 설정에서 초기화. `ai_run`은 동의 전에는 Rust에서도 거부 |
| 저장소별 끄기 | `git config --local git403.ai false`. 설정 > AI 체크박스로도 바꾼다 |
| 저장소 규칙 따르기 | 커밋 메시지·PR 설명에만, 저장소의 CLAUDE.md·AGENTS.md·커밋/PR 스킬·템플릿·commitlint·최근 커밋 제목·브랜치를 읽어(읽기 전용, 저장소 밖 심볼릭 링크 거부, 파일당 16KB·합계 40KB) 함께 보낸다. 저장소 스킬이 없을 때만 설치된 플러그인 스킬. **이 문서들의 내용이 선택한 공급자에게 전송된다**(diff와 같은 동의 범위) — 규칙 문서 안의 실행 지시는 시스템 프롬프트로 무시하게 한다. 규칙 문서가 커밋·PR용으로 지정한 스킬(예: "`commit-message` 스킬로 커밋")을 먼저 찾아 따르고(해석 순서 사용자 > 저장소 > 설치 플러그인), 지정이 없을 때만 이름·설명으로 고른다. 쓴 출처(`via`·`from`·못 찾은 지정 `missing`)는 결과의 `sources`로 보여 준다. 끄기: 설정(`ai.json` `conventions`) 또는 `git config --local git403.aiConventions false` |
| 입력 상한 | 200KB. 넘으면 자르지 않고 "너무 큼, 파일을 골라서" 안내 |
| 모델 | 기본 `claude-opus-5-5`, 설정 > AI에서 문자열로 변경(API 키 방식에만 적용 — CLI는 CLI 설정을 따른다) |
| 기능 | 커밋 메시지(변경 화면)·코드 리뷰(커밋·브랜치 우클릭)·충돌 도우미(충돌 파일 우클릭, 적용은 파일 쓰기까지)·PR 설명(PR 시트) |
| 리뷰 결과의 파일·줄 이동 | 미구현 — 시트에 `파일:줄`만 표시(후속) |

API 요청 규칙(Opus 5.5): `thinking` 파라미터와 assistant prefill은 보내지 않는다(400). 구조화 출력은 `output_config.format`의 JSON 스키마로 받고, 응답은 `stop_reason`(`refusal`·`max_tokens`)을 먼저 확인한다. 자세한 인자·헤더는 docs/reuse.md `gc-ai` 절.

충돌 도우미 적용 안전장치: 충돌 단계는 바이트로 읽어 NUL·비UTF-8이면 거부(조용히 변환하지 않음), 적용 때 아직 충돌 상태인지·요청 이후 작업 파일이 안 바뀌었는지(지문)·OS 확인을 거치고, 요청 시점의 저장소에 쓴다.

CLI 방식은 구조화 출력이 없어 프롬프트로 JSON을 요구하고, 응답에서 JSON을 뽑아 같은 스키마로 검사한다. CLI에는 `--tools ""`·`--strict-mcp-config`(빈 MCP)·`--setting-sources local`·`--disable-slash-commands`·`--permission-mode dontAsk`를 주어 도구·사용자 MCP/훅/스킬을 막고, 저장소가 아닌 임시 폴더에서 실행한다(`--bare`는 로그인을 읽지 않아 제외). 인자는 설치된 실제 `claude --help`로 존재를 확인하는 테스트가 있다(미설치면 skip).

## 공급자 확장 (OpenAI·Google·xAI)

공급자마다 같은 두 방식을 둔다: CLI 로그인 위임(OAuth는 CLI가 보관, 앱은 토큰을 다루지 않음) / API 키(키체인 `ai:<공급자>`). 동의는 전송 대상이 다르므로 공급자별. 설정 `ai.json`에서 기존 `model`·`method`·`consent`는 Anthropic 것으로 읽는다.

| 공급자 | CLI 위임 | API 키 | 상태 |
|---|---|---|---|
| Anthropic | `claude -p`(위 표) | Messages API | 구현(기존) |
| OpenAI | `codex exec --json`, 샌드박스 read-only·승인 never·웹검색 끔·`--ignore-user-config`·임시 폴더, 로그인 `codex login` | Responses API `/v1/responses`, `text.format` json_schema strict, Bearer | 구현. 설치된 `codex exec --help`로 인자 확인 테스트. JSONL 이벤트 해석은 문서 기준(실제 호출 미검증) |
| Google | `gemini -p`+stdin, `--output-format json`, `--approval-mode default`, `--extensions none`, `--skip-trust`, 임시 폴더 | `generateContent`, `x-goog-api-key`, `responseJsonSchema` | 구현. CLI 미설치로 `--help` 검증 못 함(테스트는 설치 시 검사). 도구·MCP 전용 차단 플래그는 문서에 없음 |
| xAI | `grok -p <프롬프트> --output-format json --max-turns 1 --disable-web-search …`(승인 필요 → `--always-approve` 금지), 감지 `grok version`, 로그인 `grok login` | `https://api.x.ai/v1/responses`(OpenAI 호환, `text.format`) | 구현. CLI 미설치로 `--help` 검증 못 함. JSON 출력 필드 이름 문서 없음(후보 이름·원문을 차례로 시도). 프롬프트가 인자라 크기 상한 100KB(Windows 28KB). **한계**: 인자는 같은 사용자의 프로세스 목록(`ps` 등)에 보이므로 diff·규칙 내용이 노출된다(UI가 경고, 코드로는 막을 수 없음) |

API 키 방식 기본 모델(설정에서 변경 가능): OpenAI `gpt-6-astra`, Google `gemini-4-argon`, xAI `grok-4.7` — 각사 모델 문서(2026-10)에서 읽은 값이라 출시 전 다시 확인한다.
