$ErrorActionPreference = 'Stop'
$panelRoot = Split-Path -Parent $PSCommandPath
$panelUrl = 'http://127.0.0.1:4187/'
$stateUrl = 'http://127.0.0.1:4187/api/state'
$nearbyQueueRoot = [IO.Path]::GetFullPath((Join-Path $panelRoot '..'))
$expectedQueueRoot = if (Test-Path (Join-Path $nearbyQueueRoot 'queue.mjs')) { $nearbyQueueRoot } else { $panelRoot }
$expectedQueueRoot = $expectedQueueRoot.TrimEnd('\')

function Test-CentroPanel {
    try {
        $state = Invoke-RestMethod -Uri $stateUrl -TimeoutSec 2
        $actualRoot = [IO.Path]::GetFullPath([string]$state.settings.queueRoot).TrimEnd('\')
        return $actualRoot.Equals($expectedQueueRoot, [StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}

if (Test-CentroPanel) {
    Start-Process $panelUrl
    exit 0
}

$node = Get-Command node.exe -ErrorAction Stop
$logDirectory = Join-Path $panelRoot 'data'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$stdout = Join-Path $logDirectory 'dashboard.stdout.log'
$stderr = Join-Path $logDirectory 'dashboard.stderr.log'
$env:CENTRO_OPERATIONS_PORT = '4187'
$server = Start-Process -FilePath $node.Source -ArgumentList 'dashboard.mjs' -WorkingDirectory $panelRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr

# 30 s: a cold start (first run after boot, antivirus scan) can take well over 10 s before the panel answers.
for ($attempt = 0; $attempt -lt 120; $attempt++) {
    if (Test-CentroPanel) {
        Start-Process $panelUrl
        exit 0
    }
    $server.Refresh()
    if ($server.HasExited) { break }
    Start-Sleep -Milliseconds 250
}

throw "El panel no respondio en 127.0.0.1:4187. Revisa $stderr"
