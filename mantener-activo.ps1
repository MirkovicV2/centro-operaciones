param(
    [ValidateRange(1, 24)][int]$Hours = 8,
    [switch]$SmokeTest
)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace CentroOperaciones {
    public static class PowerRequest {
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint SetThreadExecutionState(uint flags);
    }
}
'@

$continuousFlag = [uint32]2147483648
$systemRequiredFlags = [uint32]2147483649
$previousState = [CentroOperaciones.PowerRequest]::SetThreadExecutionState($systemRequiredFlags)
if ($previousState -eq 0) { throw 'Windows no ha aceptado la solicitud temporal de actividad.' }
try {
    if ($SmokeTest) {
        Write-Output 'Solicitud temporal de actividad comprobada; se libera al finalizar.'
        return
    }
    Write-Output ('PC disponible durante un máximo de ' + $Hours + ' horas, mientras Orca siga abierto. La pantalla puede apagarse.')
    $guardClock = [Diagnostics.Stopwatch]::StartNew()
    $pauseMarker = Join-Path $PSScriptRoot 'data\PAUSE'
    while ($guardClock.Elapsed.TotalHours -lt $Hours) {
        if (Test-Path -LiteralPath $pauseMarker) { break }
        if (-not (Get-Process -Name Orca -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Seconds 15
    }
} finally {
    [void][CentroOperaciones.PowerRequest]::SetThreadExecutionState($continuousFlag)
    Write-Output 'Solicitud temporal de actividad liberada.'
}
