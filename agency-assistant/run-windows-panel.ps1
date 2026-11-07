$ErrorActionPreference = 'Stop'

$assistantDir = $PSScriptRoot
$workspaceRoot = Split-Path -Parent $assistantDir
$operationsRoot = (Resolve-Path -LiteralPath (Join-Path $workspaceRoot '..\..')).Path
$dataDir = Join-Path $workspaceRoot 'data'
$logPath = Join-Path $dataDir 'operations-dashboard.log'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'No encuentro Node.js en el entorno de Windows.' }

New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
Remove-Item Env:TELEGRAM_BOT_TOKEN,Env:TELEGRAM_ALLOWED_CHAT_ID -ErrorAction SilentlyContinue
$env:CENTRO_OPERACIONES_ROOT = $operationsRoot
Push-Location $workspaceRoot
try {
    & $node.Source (Join-Path $workspaceRoot 'dashboard.mjs') *>> $logPath
    exit $LASTEXITCODE
} finally {
    Pop-Location
    Remove-Item Env:CENTRO_OPERACIONES_ROOT -ErrorAction SilentlyContinue
}
