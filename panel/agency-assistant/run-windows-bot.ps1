$ErrorActionPreference = 'Stop'

$assistantDir = $PSScriptRoot
$workspaceRoot = Split-Path -Parent $assistantDir
$configDir = Join-Path $workspaceRoot 'data'
$configPath = Join-Path $configDir 'agency-assistant-windows.json'
$secretPath = Join-Path $configDir 'telegram-token.dpapi'
$logPath = Join-Path $configDir 'operations-dashboard.log'

try {
    $settings = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $secureToken = ConvertTo-SecureString (Get-Content -LiteralPath $secretPath -Raw).Trim()
    $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
    try {
        $env:TELEGRAM_BOT_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
    }
    $env:TELEGRAM_ALLOWED_CHAT_ID = [string]$settings.allowedChatId
    $env:CENTRO_OPERACIONES_ROOT = [string]$settings.queueRoot

    Push-Location $assistantDir
    try {
        & $settings.nodePath (Join-Path $workspaceRoot 'dashboard.mjs') *>> $logPath
        $botExitCode = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    exit $botExitCode
} catch {
    "$(Get-Date -Format o) No se pudo iniciar el bot local: $($_.Exception.Message)" | Add-Content -LiteralPath $logPath
    exit 1
} finally {
    Remove-Item Env:TELEGRAM_BOT_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:TELEGRAM_ALLOWED_CHAT_ID -ErrorAction SilentlyContinue
    Remove-Item Env:CENTRO_OPERACIONES_ROOT -ErrorAction SilentlyContinue
}
