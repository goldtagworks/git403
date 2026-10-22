#!/bin/bash
# git403 설치 (macOS) — Finder에서 더블클릭. 도구 설치 → 빌드 → /Applications 에 복사. 여러 번 실행해도 안전하다.
cd "$(dirname "$0")" || exit 1

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
fail() { printf '\n\033[31m✘ %s\033[0m\n' "$1"; read -r -p "엔터를 누르면 창이 닫힙니다…"; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }
load_paths() {
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && eval "$("$b" shellenv)"; done
  export PATH="$HOME/.cargo/bin:$PATH"
  [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
}
load_paths

echo "git403 설치를 시작합니다. 중간에 Mac 비밀번호를 요청할 수 있어요."

step "1/4 Xcode 명령줄 도구 · Homebrew"
if ! xcode-select -p >/dev/null 2>&1; then
  xcode-select --install
  read -r -p "  설치 창이 끝나면 엔터를 누르세요…"
fi
if ! has brew; then
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || fail "Homebrew 설치 실패"
  load_paths
fi
echo "✔ Xcode 도구 · Homebrew"

step "2/4 Rust · Node · pnpm · git"
has rustup || { curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none || fail "Rust 설치 실패"; load_paths; }
node_ok() { has node && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; }
node_ok || brew install node || fail "Node 설치 실패"
has pnpm || brew install pnpm || fail "pnpm 설치 실패"
has git || brew install git || fail "git 설치 실패"
echo "✔ $(cargo -V 2>/dev/null | cut -d' ' -f1-2) · Node $(node -v) · pnpm $(pnpm -v)"

step "3/4 빌드 (처음엔 몇 분 걸려요)"
./build-mac.command --quiet || fail "빌드 실패"

step "4/4 응용 프로그램 폴더에 설치"
pkill -x git403 2>/dev/null
rm -rf /Applications/git403.app && cp -R out/macos/git403.app /Applications/ || fail "복사 실패"
echo "✔ /Applications/git403.app"

printf '\n\033[32m설치 완료!\033[0m Launchpad나 응용 프로그램 폴더에서 git403 을 실행하세요.\n'
open /Applications/git403.app
read -r -p "엔터를 누르면 창이 닫힙니다…"
