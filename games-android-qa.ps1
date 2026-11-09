param(
    [ValidateSet('status', 'start', 'host')]
    [string] $Action = 'status',
    [ValidateRange(15, 600)]
    [int] $TimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'
$sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$adb = Join-Path $sdk 'platform-tools\adb.exe'
$emulator = Join-Path $sdk 'emulator\emulator.exe'
$avd = 'FlechaTrampa_QA_API35_320'
$serial = 'emulator-5556'
$taskName = 'CentroOperaciones-AndroidQA'
$config = Join-Path $env:USERPROFILE ".android\avd\$avd.avd\config.ini"

function Get-AndroidQaStatus {
    $result = [ordered]@{ ready = $false; avd = $avd; serial = $serial; adb = $adb; sdk = $sdk }
    $missing = @($adb, $emulator, $config | Where-Object { !(Test-Path -LiteralPath $_ -PathType Leaf) })
    if ($missing.Count) {
        $result.status = 'environment_missing'
        $result.missing = $missing
        return $result
    }

    $device = & $adb devices | Where-Object { $_ -match "^$serial\s+" } | Select-Object -First 1
    if (!$device) {
        $result.status = 'offline'
        return $result
    }
    if ($device -notmatch "^$serial\s+device\s*$") {
        $result.status = 'booting'
        return $result
    }
    $reportedAvd = & $adb -s $serial emu avd name | Select-Object -First 1
    if ($reportedAvd -ne $avd) {
        $result.status = 'unexpected_device'
        return $result
    }
    $boot = & $adb -s $serial shell getprop sys.boot_completed
    if (("$boot").Trim() -ne '1') {
        $result.status = 'booting'
        return $result
    }

    $result.status = 'ready'
    $result.ready = $true
    $result.size = ((& $adb -s $serial shell wm size) -join ' ').Trim()
    $result.density = ((& $adb -s $serial shell wm density) -join ' ').Trim()
    return $result
}

$status = Get-AndroidQaStatus
if ($Action -eq 'status' -or $status.ready -or $status.status -in 'environment_missing', 'unexpected_device') {
    $status | ConvertTo-Json -Compress
    if ($Action -ne 'status' -and !$status.ready) { exit 1 }
    exit 0
}

if ($Action -eq 'host') {
    if (Get-NetTCPConnection -LocalPort 5556,5557 -State Listen -ErrorAction SilentlyContinue) {
        throw 'El puerto del dispositivo QA ya está ocupado.'
    }
    $logRoot = Join-Path $env:LOCALAPPDATA 'CentroOperaciones\AndroidQA'
    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    $env:ANDROID_HOME = $sdk
    $acceleration = @(& $emulator -accel-check)
    $mode = 'on'
    if ($acceleration -notcontains '0') {
        $env:ANDROID_I_WANT_MY_TCG = 'yes'
        $mode = 'off'
    }
    & $emulator -avd $avd -port 5556 -no-window -no-snapshot -gpu host -accel $mode -no-boot-anim *> (Join-Path $logRoot 'emulator.log')
    exit $LASTEXITCODE
}

$launcher = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (!$launcher) {
    $status.status = 'launcher_missing'
    $status | ConvertTo-Json -Compress
    exit 1
}
if ($launcher.State -ne 'Running' -and $status.status -eq 'offline') {
    if (Get-NetTCPConnection -LocalPort 5556,5557 -State Listen -ErrorAction SilentlyContinue) {
        $status.status = 'unexpected_device'
        $status | ConvertTo-Json -Compress
        exit 1
    }
    Start-ScheduledTask -InputObject $launcher
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
do {
    Start-Sleep -Seconds 3
    $status = Get-AndroidQaStatus
    if ($status.ready -or $status.status -eq 'unexpected_device') { break }
} while ((Get-Date) -lt $deadline)

$status | ConvertTo-Json -Compress
if (!$status.ready) { exit 1 }
