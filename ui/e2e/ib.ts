// xib/storyboard 시각 diff E2E용 작은 Interface Builder 픽스처 (25c)
const rect = (x: number, y: number, w: number, h: number) => `<rect key="frame" x="${x}" y="${y}" width="${w}" height="${h}"/>`;
const con = (id: string, f: string, fa: string, s?: string, sa?: string, extra = "") =>
  `<constraint firstItem="${f}" firstAttribute="${fa}"${s ? ` secondItem="${s}" secondAttribute="${sa}"` : ""}${extra} id="${id}"/>`;

/** 셀 xib. after=false가 이전, true가 이후 */
export const cellXib = (after: boolean) => `<?xml version="1.0" encoding="UTF-8"?>
<document type="com.apple.InterfaceBuilder3.CocoaTouch.XIB" version="3.0" toolsVersion="21507" targetRuntime="iOS.CocoaTouch">
  <objects>
    <placeholder placeholderIdentifier="IBFilesOwner" id="-1" userLabel="File's Owner">
      <connections>
        <outlet property="coverImageView" destination="img-1" id="o1"/>
        <outlet property="titleLabel" destination="lbl-1" id="o2"/>
      </connections>
    </placeholder>
    <tableViewCell contentMode="scaleToFill" id="cell-1" customClass="SongCell">
      ${rect(0, 0, 320, 64)}
      <tableViewCellContentView key="contentView" id="cv-1">
        ${rect(0, 0, 320, 64)}
        <subviews>
          <view id="up-1" userLabel="Upper View">${rect(0, 0, 320, 40)}</view>
          <imageView id="img-1" image="cover">${rect(16, 8, 48, 48)}</imageView>
          <label id="lbl-1" text="Title">
            ${rect(120, after ? 24 : 28, after ? 169 : 173, after ? 21 : 20)}
            <fontDescription key="fontDescription" type="boldSystem" pointSize="${after ? 17 : 16}"/>
            <color key="textColor" name="labelColor"/>
          </label>
          <view id="mv-1" userLabel="moveView">${rect(after ? 220 : 200, 4, 30, 30)}</view>
          ${after ? `<label id="bdg-1" userLabel="badgeLabel" text="NEW">${rect(260, 40, 40, 16)}</label>` : `<label id="sub-1" userLabel="subLabel" text="Artist">${rect(120, 48, 100, 14)}</label>`}
        </subviews>
        <constraints>
          ${con("c1", "img-1", "leading", after ? "cv-1" : "up-1", "leading", ' constant="16"')}
          ${con("c2", "lbl-1", "top", "img-1", "top", ` constant="${after ? 12 : 8}"`)}
          ${after ? con("c4", "bdg-1", "trailing", "cv-1", "trailing", ' constant="-8"') : con("c3", "sub-1", "top", "lbl-1", "bottom", ' constant="4"')}
        </constraints>
      </tableViewCellContentView>
    </tableViewCell>
  </objects>
</document>`;

/** 스토리보드: scene 둘(A는 제목 글자 변경, B는 뷰 하나 추가), C는 변경 없음 */
export const board = (after: boolean) => `<?xml version="1.0" encoding="UTF-8"?>
<document type="com.apple.InterfaceBuilder3.CocoaTouch.Storyboard.XIB" version="3.0">
  <scenes>
    <scene sceneID="sA">
      <objects>
        <viewController id="vcA" customClass="HomeViewController">
          <view key="view" id="rootA">
            ${rect(0, 0, 375, 667)}
            <subviews><label id="la" userLabel="homeTitle" text="${after ? "Home!" : "Home"}">${rect(16, 60, 100, 20)}</label></subviews>
            <viewLayoutGuide key="safeArea" id="saA"/>
            <constraints>
              ${con("ca", "la", "top", "saA", "top", ` constant="${after ? 20 : 16}"`)}
              ${after ? con("cb", "la", "leading", "saA", "leading", ' constant="16"') : ""}
            </constraints>
          </view>
          <connections><outlet property="view" destination="rootA" id="oA"/></connections>
        </viewController>
      </objects>
    </scene>
    <scene sceneID="sB">
      <objects>
        <viewController id="vcB" customClass="DetailViewController">
          <view key="view" id="rootB">
            ${rect(0, 0, 375, 667)}
            <subviews>
              <view id="vb1" userLabel="header">${rect(0, 0, 375, 100)}</view>
              <view id="nf" userLabel="noFrame"><subviews><label id="nfc" userLabel="nestedLabel">${rect(16, after ? 310 : 300, 100, 20)}</label></subviews></view>
              <scrollView id="sv" userLabel="scroller">
                ${rect(0, 100, 375, 400)}
                <point key="contentOffset" x="0" y="50"/>
                <subviews><view id="svc" userLabel="scrollChild">${rect(0, after ? 160 : 150, 375, 40)}</view></subviews>
              </scrollView>
              <tableView id="tv" userLabel="songTable">
                ${rect(0, 520, 375, 100)}
                <prototypes>
                  <tableViewCell id="pc" customClass="ProtoCell">
                    ${rect(0, 0, 375, 44)}
                    <tableViewCellContentView key="contentView" id="pcv">
                      ${rect(0, 0, 375, 44)}
                      <subviews><label id="pl" userLabel="protoTitle" text="${after ? "Song!" : "Song"}">${rect(16, 12, 100, 20)}</label></subviews>
                    </tableViewCellContentView>
                  </tableViewCell>
                </prototypes>
              </tableView>
              ${after ? `<button id="vb2" userLabel="buyButton">${rect(16, 600, 343, 44)}</button>` : ""}
            </subviews>
          </view>
        </viewController>
      </objects>
    </scene>
    <scene sceneID="sC">
      <objects>
        <viewController id="vcC" customClass="SameViewController">
          <view key="view" id="rootC">${rect(0, 0, 375, 667)}</view>
        </viewController>
      </objects>
    </scene>
  </scenes>
</document>`;

/** Raw 보기용 텍스트 diff */
export const textDiff = (path: string) => `diff --git a/${path} b/${path}
index 3f2a1b0..9c4d2e1 100644
--- a/${path}
+++ b/${path}
@@ -1,3 +1,3 @@
 <?xml version="1.0" encoding="UTF-8"?>
-<document old="1">
+<document new="1">
   <objects>
`;
