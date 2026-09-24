# Configura integração local TetOS + AutoMate + desktop.
# Uso: powershell -ExecutionPolicy Bypass -File scripts/setup-desktop-local.ps1

$ErrorActionPreference = "Stop"
$tetos = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$root = Split-Path $tetos -Parent
$automate = Join-Path $root "AutoMate"
$desktop = Join-Path $root "tetos-desktop\apps\desktop"
$tokensFile = Join-Path $tetos "data\deviceTokens.json"

function Ensure-Line($path, $pattern, $block) {
  if (-not (Test-Path $path)) { Write-Host "[!] Ausente: $path"; return }
  if (Select-String -Path $path -Pattern $pattern -Quiet) {
    Write-Host "[ok] $pattern em $(Split-Path $path -Leaf)"
    return
  }
  Add-Content -Path $path -Value $block -Encoding UTF8
  Write-Host "[+] $(Split-Path $path -Leaf)"
}

$uiBlock = @"

# === UI desktop + relay AutoMate ===
TETOS_UI_SESSION_TOKEN=tetos-dev-session
TETOS_DEFAULT_DEVICE_ID=default-device
"@
Ensure-Line (Join-Path $tetos ".env") "TETOS_UI_SESSION_TOKEN" $uiBlock

if (-not (Test-Path $tokensFile)) {
  Write-Host "[!] Inicie a API uma vez: npm run start:api"
  exit 1
}
$tokens = Get-Content $tokensFile -Raw | ConvertFrom-Json
$device = $tokens.devices | Where-Object { $_.id -eq "default-device" -and -not $_.revokedAt } | Select-Object -First 1
if (-not $device) {
  Write-Host "[!] Emita token: POST /ui/devices/default-device/issue (Bearer tetos-dev-session)"
  exit 1
}
$token = $device.token

$relayBlock = @"

# === Relay TetOS (app desktop) ===
AUTOMATE_RELAY_URL=ws://127.0.0.1:6453/device-link
AUTOMATE_RELAY_TOKEN=$token
AUTOMATE_RELAY_DEVICE_ID=default-device
"@
Ensure-Line (Join-Path $automate ".env") "AUTOMATE_RELAY_URL" $relayBlock

if (Test-Path $desktop) {
  $desktopEnv = @"
VITE_USE_MOCK=false
VITE_USE_MOCK_ON_ERROR=false
VITE_TETOS_URL=http://127.0.0.1:6453
VITE_TETOS_TOKEN=tetos-dev-session
VITE_AUTOMATE_RELAY_URL=ws://127.0.0.1:6453/device-link
VITE_AUTOMATE_DEVICE_ID=default-device
VITE_AUTOMATE_DEVICE_TOKEN=$token
"@
  Set-Content -Path (Join-Path $desktop ".env") -Value $desktopEnv -Encoding UTF8
  Copy-Item (Join-Path $desktop "local.config.example.json") (Join-Path $desktop "local.config.json") -ErrorAction SilentlyContinue
  Write-Host "[+] desktop .env + local.config.json"
}

Write-Host "Concluído. TetOS: npm run start:api | AutoMate: automate link | Desktop: pnpm --filter @tetos/desktop dev"
