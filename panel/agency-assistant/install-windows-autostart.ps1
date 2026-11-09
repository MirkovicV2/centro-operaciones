$ErrorActionPreference = 'Stop'

$assistantDir = $PSScriptRoot
$workspaceRoot = Split-Path -Parent $assistantDir
$configDir = Join-Path $workspaceRoot 'data'
$configPath = Join-Path $configDir 'agency-assistant-windows.json'
$secretPath = Join-Path $configDir 'telegram-token.dpapi'
$runnerPath = Join-Path $assistantDir 'run-windows-bot.ps1'
$taskName = 'CentroOperaciones-PanelLocal'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'No encuentro Node.js. Instala Node.js 20 o posterior y vuelve a ejecutar este script.' }
$nodeVersion = (& $node.Source --version).Trim()
if ($LASTEXITCODE -ne 0 -or [version]($nodeVersion.TrimStart('v')) -lt [version]'20.0') {
    throw "Se necesita Node.js 20 o posterior. Versión detectada: $nodeVersion"
}

$defaultQueueRoot = (Resolve-Path (Join-Path $assistantDir '..\..\..')).Path
$queueRootInput = Read-Host "Carpeta del Centro de Operaciones que contiene queue.mjs [$defaultQueueRoot]"
$queueRoot = if ([string]::IsNullOrWhiteSpace($queueRootInput)) { $defaultQueueRoot } else { $queueRootInput.Trim() }
$queueRoot = (Resolve-Path -LiteralPath $queueRoot).Path
if (-not (Test-Path -LiteralPath (Join-Path $queueRoot 'queue.mjs'))) {
    throw "No encuentro queue.mjs en: $queueRoot"
}

$token = Read-Host 'Pega el token privado de BotFather' -AsSecureString
$tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($token)
try {
    $env:TELEGRAM_BOT_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
    $env:CENTRO_OPERACIONES_ROOT = $queueRoot
    Write-Host 'Buscando el chat privado. Antes, envía /start a tu bot en Telegram.'
    $discoveryOutput = & $node.Source (Join-Path $assistantDir 'bot.mjs') --discover-chat 2>&1
    $discoveryOutput | ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo consultar el bot. Revisa el token, la conexión y que hayas enviado /start.' }
    if ($discoveryOutput -notmatch 'Chat privado detectado') {
        throw 'No se encontró ningún chat privado. En Telegram, abre el bot y envíale /start; luego ejecuta este instalador de nuevo.'
    }
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
    Remove-Item Env:TELEGRAM_BOT_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:CENTRO_OPERACIONES_ROOT -ErrorAction SilentlyContinue
}

$chatId = (Read-Host 'Escribe aquí el ID del chat privado que acaba de mostrar').Trim()
if ($chatId -notmatch '^-?\d+$') { throw 'El ID debe contener solo números y, opcionalmente, un signo menos.' }

New-Item -ItemType Directory -Path $configDir -Force | Out-Null
$token | ConvertFrom-SecureString | Set-Content -LiteralPath $secretPath -Encoding Ascii
$settings = [ordered]@{
    nodePath = $node.Source
    queueRoot = $queueRoot
    allowedChatId = $chatId
}
$settings | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8

$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$powershellPath = (Get-Process -Id $PID).Path
$action = New-ScheduledTaskAction -Execute $powershellPath -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runnerPath`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$taskSettings = New-ScheduledTaskSettingsSet `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $taskSettings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host "Tarea programada '$taskName' instalada e iniciada. Arrancará el panel y el bot al iniciar sesión en Windows."
Write-Host "Panel: http://127.0.0.1:4187"
Write-Host "Registro local: $(Join-Path $configDir 'operations-dashboard.log')"
Write-Host 'El token está cifrado por Windows para esta cuenta y no se escribe en el script.'
