#!/bin/bash
# macOS 배포 (서명 없음): Apple Silicon·Intel 빌드 → 이 저장소(goldtagworks/git403) 릴리스 → main의 캐스크 갱신. Windows는 scripts/windows/release.ps1.
# 설치: brew tap goldtagworks/git403 https://github.com/goldtagworks/git403 && brew install --cask git403 · 절차: docs/release.md
set -euo pipefail
cd "$(dirname "$0")/.."

OWNER=goldtagworks
RELEASES=$OWNER/git403
VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
KEY=$HOME/.tauri/git403.key
[ -f "$KEY" ] || { echo "업데이터 서명 키 $KEY 가 없습니다."; exit 1; }

# 활성 gh 계정과 상관없이 goldtagworks 토큰으로 올린다.
export GH_TOKEN=$(gh auth token -u $OWNER)

pnpm install --frozen-lockfile && pnpm --dir ui install --frozen-lockfile

# Apple Silicon·Intel을 따로 빌드한다(유니버설 대신 아키텍처별 dmg). 이름의 아키텍처는 Tauri 규칙(aarch64·x64)을 따른다.
# Windows가 먼저 만들었을 수 있다.
gh release view "v$VERSION" -R $RELEASES >/dev/null 2>&1 || gh release create "v$VERSION" -R $RELEASES --title "git403 v$VERSION" --notes "$(node scripts/release-notes.mjs "$VERSION")"
TMPD=$(mktemp -d)
rm -rf out
gh release download "v$VERSION" -R $RELEASES -p latest.json -D "$TMPD" 2>/dev/null || true
for T in aarch64-apple-darwin:aarch64:darwin-aarch64 x86_64-apple-darwin:x64:darwin-x86_64; do
  IFS=: read -r TRIPLE ARCH PLATFORM <<<"$T"
  rustup target add "$TRIPLE" >/dev/null
  # 앱 안 업데이트용 .app.tar.gz·.sig도 만든다.
  TAURI_SIGNING_PRIVATE_KEY="$KEY" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" pnpm tauri build --target "$TRIPLE" --bundles app,dmg
  DMG=target/$TRIPLE/release/bundle/dmg/git403_${VERSION}_${ARCH}.dmg
  APP=target/$TRIPLE/release/bundle/macos/git403.app.tar.gz
  [ -f "$DMG" ] || { echo "$DMG 가 없습니다."; exit 1; }
  printf -v "SHA_$ARCH" %s "$(shasum -a 256 "$DMG" | cut -d' ' -f1)"
  TAR=git403_${VERSION}_${ARCH}.app.tar.gz
  cp "$APP" "$TMPD/$TAR"
  node scripts/latest-json.mjs "$TMPD/latest.json" "$VERSION" "$PLATFORM" "https://github.com/$RELEASES/releases/download/v$VERSION/$TAR" "$APP.sig"
  # 로컬 확인용으로 out/<아키텍처>에 복사한다(pnpm build와 같은 자리).
  mkdir -p out && cp -R "target/$TRIPLE/release/bundle" "out/$ARCH"
  gh release upload "v$VERSION" "$DMG" "$TMPD/$TAR" -R $RELEASES --clobber
done
gh release upload "v$VERSION" "$TMPD/latest.json" -R $RELEASES --clobber
rm -rf "$TMPD"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git clone -q --depth 1 "https://x-access-token:$GH_TOKEN@github.com/$RELEASES.git" "$TMP"
mkdir -p "$TMP/Casks"
cat > "$TMP/Casks/git403.rb" <<EOF
cask "git403" do
  version "$VERSION"

  on_arm do
    sha256 "$SHA_aarch64"
    url "https://github.com/$RELEASES/releases/download/v#{version}/git403_#{version}_aarch64.dmg"
  end
  on_intel do
    sha256 "$SHA_x64"
    url "https://github.com/$RELEASES/releases/download/v#{version}/git403_#{version}_x64.dmg"
  end

  name "git403"
  desc "가볍고 빠른 Git 클라이언트 (코드 서명 없음)"
  homepage "https://github.com/$RELEASES"

  depends_on macos: ">= :big_sur"

  auto_updates true # 앱이 스스로 업데이트한다(brew upgrade도 된다)

  app "git403.app"

  # 서명이 없어 Gatekeeper가 막으므로 격리 속성을 지운다.
  postflight do
    system_command "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "#{appdir}/git403.app"]
  end

  zap trash: [
    "~/Library/Application Support/com.goldtagworks.git403",
    "~/Library/Caches/com.goldtagworks.git403",
    "~/Library/WebKit/com.goldtagworks.git403",
  ]
end
EOF
git -C "$TMP" add Casks/git403.rb
git -C "$TMP" -c user.name=$OWNER -c user.email=$OWNER@gmail.com commit -qm "git403 $VERSION"
git -C "$TMP" push -q origin HEAD:main

echo "완료: brew update && brew upgrade --cask git403"
