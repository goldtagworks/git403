# Windows 설치 파일 배포 (서명 없음): build.ps1 빌드 → goldtagworks/git403 릴리스 v<version>에 setup.exe 업로드.
# macOS(scripts/release-mac.sh)와 순서 상관없음 — 릴리스가 없으면 만든다. 절차: docs/release.md
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")
function Fail($m) { Write-Host "`n✘ $m" -ForegroundColor Red; exit 1 }

$repo = "goldtagworks/git403"
$v = node -p "require('./src-tauri/tauri.conf.json').version"
# 활성 gh 계정과 상관없이 goldtagworks 토큰으로 올린다.
$env:GH_TOKEN = gh auth token -u goldtagworks; if ($LASTEXITCODE) { Fail "gh auth login 으로 goldtagworks 계정을 추가하세요." }

# 앱 안 업데이트 서명 키 (Mac의 ~/.tauri/git403.key를 복사해 둔다). build.ps1이 이 키로 .sig를 만든다.
if (-not (Test-Path "$env:USERPROFILE\.tauri\git403.key")) { Fail "업데이터 서명 키 %USERPROFILE%\.tauri\git403.key 가 없습니다." }
& "$PSScriptRoot\build.ps1"; if ($LASTEXITCODE) { Fail "빌드 실패" }
$exe = "out\nsis\git403_${v}_x64-setup.exe"
if (-not (Test-Path $exe)) { Fail "$exe 가 없습니다." }

gh release view "v$v" -R $repo *> $null
if ($LASTEXITCODE) { gh release create "v$v" -R $repo --title "git403 v$v" --notes "$(node scripts/release-notes.mjs $v | Out-String)"; if ($LASTEXITCODE) { Fail "릴리스 생성 실패" } }
$tmp = New-Item -ItemType Directory (Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid()))
gh release download "v$v" -R $repo -p latest.json -D $tmp *> $null
$name = Split-Path $exe -Leaf
node scripts/latest-json.mjs "$tmp\latest.json" $v windows-x86_64 "https://github.com/$repo/releases/download/v$v/$name" "$exe.sig"; if ($LASTEXITCODE) { Fail "latest.json 생성 실패" }
gh release upload "v$v" $exe "$tmp\latest.json" -R $repo --clobber; if ($LASTEXITCODE) { Fail "업로드 실패" }
Remove-Item -Recurse -Force $tmp
Write-Host "`n완료: https://github.com/$repo/releases/tag/v$v" -ForegroundColor Green
