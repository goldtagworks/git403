cask "git403" do
  version "1.0.2"

  on_arm do
    sha256 "576e5ad531f0f5e5faf3d37395ead5fcd1190dff0090c6435216a38118f3a3d5"
    url "https://github.com/goldtagworks/git403/releases/download/v#{version}/git403_#{version}_aarch64.dmg"
  end
  on_intel do
    sha256 "5ce1db820f1bc9f34d0aefea01506fc12b5ceba3e458fd258b88c1fd26d0ab5f"
    url "https://github.com/goldtagworks/git403/releases/download/v#{version}/git403_#{version}_x64.dmg"
  end

  name "git403"
  desc "가볍고 빠른 Git 클라이언트 (코드 서명 없음)"
  homepage "https://github.com/goldtagworks/git403"

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
