#!/bin/bash
# 사용: scripts/make-dmg.sh <git403.app 경로> <만들 dmg 경로>
# 마운트 없이 dmg를 만든다: Tauri의 bundle_dmg.sh는 임시 볼륨을 마운트하는데, 보안 에이전트(EDR)가 새 앱을 검사하며
# 붙잡으면 해제가 안 돼 "hdiutil: create failed - 리소스 사용 중"으로 실패한다.
# 창 배치(.DS_Store)는 Tauri로 만든 v1.0.6 dmg에서 꺼낸 scripts/dmg/DS_Store, 볼륨 아이콘은 src-tauri/icons/icon.icns.
# .DS_Store는 볼륨 이름 git403·앱 이름 git403.app 기준이라 둘을 바꾸면 다시 꺼내야 한다.
set -e
APP=$1 DMG=$2 DIR=$(cd "$(dirname "$0")/dmg" && pwd)
SRC=$(mktemp -d)
trap 'rm -rf "$SRC" "$SRC.dmg"' EXIT
cp -R "$APP" "$SRC/git403.app"
ln -s /Applications "$SRC/Applications"
cp "$DIR/DS_Store" "$SRC/.DS_Store"
cp "$DIR/../../src-tauri/icons/icon.icns" "$SRC/.VolumeIcon.icns" # 볼륨 아이콘 = 현재 앱 아이콘
SetFile -a C "$SRC" # 볼륨 루트에 사용자 아이콘 플래그
mkdir -p "$(dirname "$DMG")" && rm -f "$DMG"
hdiutil makehybrid -quiet -hfs -default-volume-name git403 -o "$SRC.dmg" "$SRC"
hdiutil convert -quiet -format UDZO -o "$DMG" "$SRC.dmg"
