#!/bin/bash
# macOS 배포 (서명 없음): 빌드 → git403-releases 릴리스 → 같은 저장소의 캐스크 갱신. Windows는 scripts/windows/release.ps1.
# 설치: brew tap goldtagworks/git403 https://github.com/goldtagworks/git403-releases && brew install --cask git403 · 절차: docs/release.md
set -euo pipefail
cd "$(dirname "$0")/.."

OWNER=goldtagworks
RELEASES=$OWNER/git403-releases
VERSION=$(node -p "require('./src-tauri/tauri.conf.json').version")
DMG=target/release/bundle/dmg/git403_${VERSION}_aarch64.dmg
APP=target/release/bundle/macos/git403.app.tar.gz
KEY=$HOME/.tauri/git403.key
[ -f "$KEY" ] || { echo "업데이터 서명 키 $KEY 가 없습니다."; exit 1; }

# 활성 gh 계정과 상관없이 goldtagworks 토큰으로 올린다.
export GH_TOKEN=$(gh auth token -u $OWNER)


pnpm install --frozen-lockfile && pnpm --dir ui install --frozen-lockfile
# 앱 안 업데이트용 .app.tar.gz·.sig도 만든다.
TAURI_SIGNING_PRIVATE_KEY="$KEY" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" pnpm tauri build --bundles app,dmg
[ -f "$DMG" ] || { echo "$DMG 가 없습니다."; exit 1; }
SHA=$(shasum -a 256 "$DMG" | cut -d' ' -f1)

# Windows가 먼저 만들었을 수 있다.
gh release view "v$VERSION" -R $RELEASES >/dev/null 2>&1 || gh release create "v$VERSION" -R $RELEASES --title "git403 v$VERSION" --notes "$(node scripts/release-notes.mjs "$VERSION")"
TAR=git403_${VERSION}_aarch64.app.tar.gz
TMPD=$(mktemp -d)
cp "$APP" "$TMPD/$TAR"
gh release download "v$VERSION" -R $RELEASES -p latest.json -D "$TMPD" 2>/dev/null || true
node scripts/latest-json.mjs "$TMPD/latest.json" "$VERSION" darwin-aarch64 "https://github.com/$RELEASES/releases/download/v$VERSION/$TAR" "$APP.sig"
gh release upload "v$VERSION" "$DMG" "$TMPD/$TAR" "$TMPD/latest.json" -R $RELEASES --clobber
rm -rf "$TMPD"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git clone -q "https://x-access-token:$GH_TOKEN@github.com/$RELEASES.git" "$TMP"
mkdir -p "$TMP/Casks"
cat > "$TMP/Casks/git403.rb" <<EOF
cask "git403" do
  version "$VERSION"
  sha256 "$SHA"

  url "https://github.com/$RELEASES/releases/download/v#{version}/git403_#{version}_aarch64.dmg"
  name "git403"
  desc "가볍고 빠른 Git 클라이언트 (코드 서명 없음)"
  homepage "https://github.com/$RELEASES"

  depends_on arch: :arm64
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
