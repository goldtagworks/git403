#!/bin/bash
# git403 빌드 (macOS) — Finder에서 더블클릭. 결과물은 out/ (out/macos/git403.app, out/dmg/*.dmg)
cd "$(dirname "$0")" || exit 1

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
fail() { printf '\n\033[31m✘ %s\033[0m\n' "$1"; [ -t 0 ] && read -r -p "엔터를 누르면 창이 닫힙니다…"; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done
export PATH="$HOME/.cargo/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1

has cargo && has pnpm || fail "Rust·pnpm이 없습니다. install-mac.command 를 먼저 실행하세요."

step "의존성"
pnpm install --frozen-lockfile && pnpm --dir ui install --frozen-lockfile || fail "의존성 설치 실패"

step "릴리스 빌드"
# 자동 업데이트 파일 서명 키. 없으면 서명 단계에서 실패하므로 업데이트 파일 없이 만든다.
KEY="${TAURI_SIGNING_PRIVATE_KEY:-$HOME/.tauri/git403.key}"
if [ -f "$KEY" ] || [ -n "$TAURI_SIGNING_PRIVATE_KEY" ]; then
  export TAURI_SIGNING_PRIVATE_KEY="$KEY" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
  pnpm build || fail "빌드 실패"
else
  echo "  (서명 키가 없어 자동 업데이트 파일은 만들지 않습니다)"
  pnpm build:nosign || fail "빌드 실패"
fi

printf '\n\033[32m빌드 완료!\033[0m out/ 폴더에 있습니다.\n'
[ "$1" = "--quiet" ] || open -R out/macos/git403.app
