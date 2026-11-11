# Pasa las pruebas del Centro y, solo si pasan y no hay ningun trabajo en marcha, reinicia el panel.
# Uso: REINICIAR_PANEL.cmd (doble clic) o  powershell -File panel\reiniciar-panel.ps1 [-SinPruebas]
# Deja el detalle en panel\data\reinicio-tests.log y el resultado en panel\data\reinicio-resultado.json.
param([switch]$SinPruebas)
$ErrorActionPreference = 'Stop'
$panelRoot = Split-Path -Parent $PSCommandPath
$root = [IO.Path]::GetFullPath((Join-Path $panelRoot '..'))
$dataDir = Join-Path $panelRoot 'data'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$log = Join-Path $dataDir 'reinicio-tests.log'
$resultFile = Join-Path $dataDir 'reinicio-resultado.json'
$stateUrl = 'http://127.0.0.1:4187/api/state'
$result = [ordered]@{ startedAt = (Get-Date).ToUniversalTime().ToString('o'); step = 'inicio'; ok = $false }
function Save-Result { ($result | ConvertTo-Json -Depth 4) | Set-Content -Path $resultFile -Encoding UTF8 }
function Get-PanelListener {
    $connection = Get-NetTCPConnection -LocalPort 4187 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($connection) { return [int]$connection.OwningProcess }
    return $null
}

try {
    Save-Result
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $result.node = $node

    if (-not $SinPruebas) {
        $result.step = 'pruebas'; Save-Result
        Write-Host 'Ejecutando las pruebas del Centro (puede tardar unos minutos)...'
        $tests = Start-Process -FilePath $node -ArgumentList 'tests/run-tests.mjs' -WorkingDirectory $root -NoNewWindow -Wait -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
        $tests.WaitForExit()
        $testsExit = $tests.ExitCode
        $result.testsExitCode = $testsExit
        $summary = @{}
        foreach ($line in (Select-String -Path $log -Pattern '^# (tests|pass|fail|skipped|cancelled) (\d+)' -ErrorAction SilentlyContinue)) {
            $summary[$line.Matches[0].Groups[1].Value] = [int]$line.Matches[0].Groups[2].Value
        }
        $result.tests = $summary
        Save-Result
        $testsPassed = ($testsExit -eq 0) -or ($null -eq $testsExit -and $summary['fail'] -eq 0 -and $summary['cancelled'] -eq 0 -and $summary['pass'] -gt 0)
        if (-not $testsPassed) { throw "Las pruebas no pasan (codigo $testsExit, fallos $($summary['fail'])). El panel NO se ha reiniciado. Revisa $log" }
        Write-Host "Pruebas correctas: $($summary['pass']) de $($summary['tests'])."
    }

    $result.step = 'comprobar-panel'; Save-Result
    $oldPid = Get-PanelListener
    $result.oldPid = $oldPid
    if ($oldPid) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$oldPid"
        if (-not $process -or $process.Name -ne 'node.exe' -or $process.CommandLine -notmatch 'dashboard\.mjs') {
            throw "El puerto 4187 lo ocupa un proceso que no es el panel (PID $oldPid). No se toca."
        }
        $state = $null
        try { $state = Invoke-RestMethod -Uri $stateUrl -TimeoutSec 90 } catch { Write-Host 'El panel no responde a /api/state; se reinicia igualmente.' }
        if ($state) {
            $running = [int]$state.queue.counts.running
            $result.runningJobs = $running
            if ($running -gt 0) { throw "Hay $running trabajo(s) en marcha. No se reinicia el panel para no interrumpirlos." }
            if ([int]$state.settings.runtime.pid -ne $oldPid) { throw "El PID del panel ($($state.settings.runtime.pid)) no coincide con el del puerto 4187 ($oldPid). No se toca." }
        }
        $result.step = 'parar'; Save-Result
        Write-Host "Parando el panel (PID $oldPid)..."
        Stop-Process -Id $oldPid -Force
        for ($attempt = 0; $attempt -lt 60 -and (Get-PanelListener); $attempt++) { Start-Sleep -Milliseconds 250 }
        if (Get-PanelListener) { throw 'El puerto 4187 sigue ocupado tras parar el panel.' }
    }

    $result.step = 'arrancar'; Save-Result
    Write-Host 'Arrancando el panel...'
    & (Join-Path $panelRoot 'start-panel.ps1')
    $newPid = Get-PanelListener
    if (-not $newPid) { throw 'El panel no quedo escuchando en 127.0.0.1:4187.' }
    $result.newPid = $newPid
    $result.step = 'hecho'; $result.ok = $true
    $result.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    Save-Result
    Write-Host "Panel reiniciado (PID $newPid)."
    exit 0
} catch {
    $result.error = $_.Exception.Message
    $result.finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    Save-Result
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
