$ErrorActionPreference = 'Stop'

$assistantDir = $PSScriptRoot
$panelRoot = Split-Path -Parent $assistantDir
$operationsRoot = Split-Path -Parent $panelRoot
$dataDir = Join-Path $panelRoot 'data'
$logPath = Join-Path $dataDir 'operations-dashboard.log'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'No encuentro Node.js en el entorno de Windows.' }

New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
Remove-Item Env:TELEGRAM_BOT_TOKEN,Env:TELEGRAM_ALLOWED_CHAT_ID -ErrorAction SilentlyContinue
$env:CENTRO_OPERACIONES_ROOT = $operationsRoot
Push-Location $panelRoot
try {
    & $node.Source (Join-Path $panelRoot 'dashboard.mjs') *>> $logPath
    exit $LASTEXITCODE
} finally {
    Pop-Location
    Remove-Item Env:CENTRO_OPERACIONES_ROOT -ErrorAction SilentlyContinue
}
