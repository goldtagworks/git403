# git403 빌드 (Windows). 결과물은 out\ (out\nsis\*-setup.exe, out\msi\*.msi)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..\..")
function Fail($m) { Write-Host "`n✘ $m" -ForegroundColor Red; exit 1 }
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User") + ";$env:USERPROFILE\.cargo\bin"

if (-not (Get-Command cargo -ErrorAction SilentlyContinue) -or -not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Fail "Rust·pnpm이 없습니다. install-windows.bat 을 먼저 실행하세요."
}

Write-Host "`n▶ 의존성"
pnpm install --frozen-lockfile; if ($LASTEXITCODE) { Fail "의존성 설치 실패" }
pnpm --dir ui install --frozen-lockfile; if ($LASTEXITCODE) { Fail "의존성 설치 실패" }

Write-Host "`n▶ 릴리스 빌드"
# 자동 업데이트 파일 서명 키. 없으면 업데이트 파일 없이 만든다.
$key = if ($env:TAURI_SIGNING_PRIVATE_KEY) { $env:TAURI_SIGNING_PRIVATE_KEY } else { "$env:USERPROFILE\.tauri\git403.key" }
if ($env:TAURI_SIGNING_PRIVATE_KEY -or (Test-Path $key)) {
  $env:TAURI_SIGNING_PRIVATE_KEY = $key
  if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) { $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "" }
} else {
  Write-Host "  (서명 키가 없어 자동 업데이트 파일은 만들지 않습니다)"
  $env:TAURI_CONFIG = '{"bundle":{"createUpdaterArtifacts":false}}'
}
pnpm build; if ($LASTEXITCODE) { Fail "빌드 실패" }
Write-Host "`n빌드 완료! out\ 폴더에 있습니다." -ForegroundColor Green
