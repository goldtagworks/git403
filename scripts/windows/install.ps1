# git403 설치 (Windows). 도구 설치(winget) → 빌드 → 설치 프로그램 실행. 여러 번 실행해도 안전하다.
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")
function Fail($m) { Write-Host "`n✘ $m" -ForegroundColor Red; exit 1 }
function Has($c) { [bool](Get-Command $c -ErrorAction SilentlyContinue) }
function Reload { $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User") + ";$env:USERPROFILE\.cargo\bin" }
function Get($id, $extra = @()) {
  winget install --id $id -e --accept-source-agreements --accept-package-agreements @extra
  if ($LASTEXITCODE -and $LASTEXITCODE -ne -1978335189) { Fail "$id 설치 실패" } # -1978335189 = 이미 설치됨
  Reload
}
Reload
if (-not (Has winget)) { Fail "winget이 없습니다. Microsoft Store에서 '앱 설치 관리자'를 설치하세요." }

Write-Host "git403 설치를 시작합니다. 중간에 관리자 권한을 요청할 수 있어요."

Write-Host "`n▶ 1/3 Visual Studio C++ 빌드 도구 · Rust · Node · pnpm · git"
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$hasVc = (Test-Path $vswhere) -and (& $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
if (-not $hasVc) { Get "Microsoft.VisualStudio.2022.BuildTools" @("--override", "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended") }
if (-not (Has rustup)) { Get "Rustlang.Rustup" }
$nodeOk = (Has node) -and ([int](node -p "process.versions.node.split('.')[0]") -ge 22)
if (-not $nodeOk) { Get "OpenJS.NodeJS.LTS" }
if (-not (Has pnpm)) { npm i -g pnpm; Reload }
if (-not (Has git)) { Get "Git.Git" }
Write-Host "✔ $(cargo -V) · Node $(node -v) · pnpm $(pnpm -v)"

Write-Host "`n▶ 2/3 빌드 (처음엔 몇 분 걸려요)"
& "$PSScriptRoot\build.ps1"; if ($LASTEXITCODE) { exit 1 }

Write-Host "`n▶ 3/3 설치"
Get-Process git403 -ErrorAction SilentlyContinue | Stop-Process
$setup = Get-ChildItem out\nsis\*-setup.exe | Select-Object -First 1
if (-not $setup) { Fail "설치 프로그램을 찾지 못했습니다 (out\nsis)" }
Start-Process $setup.FullName -ArgumentList "/S" -Wait
Write-Host "`n설치 완료! 시작 메뉴에서 git403 을 실행하세요." -ForegroundColor Green
