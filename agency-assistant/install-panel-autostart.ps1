$ErrorActionPreference = 'Stop'

$assistantDir = $PSScriptRoot
$runnerPath = Join-Path $assistantDir 'run-windows-panel.ps1'
$taskName = 'CentroOperaciones-PanelLocal'
if (-not (Test-Path -LiteralPath $runnerPath)) { throw "No encuentro el lanzador del panel: $runnerPath" }

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
Write-Host "Tarea '$taskName' instalada para iniciar el panel al iniciar sesión en Windows."
Write-Host 'El panel actual sigue disponible en http://127.0.0.1:4187'
Write-Host 'El proceso necesita que el PC esté encendido y que tu sesión de Windows esté abierta.'
