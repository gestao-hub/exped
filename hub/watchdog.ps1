# ExpedWatchdog legacy task compatibility.
#
# This script is intentionally diagnostic-only. Older Franzoni installs may
# still run C:\Exped\watchdog.ps1 every 15 minutes. It must never start/stop an
# agent, scan arbitrary user profiles, reload schemas or rewrite sync cursors.

[CmdletBinding()]
param([string]$Root = 'C:\Exped')

$ErrorActionPreference = 'Stop'
$logDir = Join-Path $Root 'logs'
$logPath = Join-Path $logDir 'watchdog.log'
$configPath = Join-Path $Root 'config.json'

function Write-Diagnostic($Message) {
    try {
        if (-not (Test-Path -LiteralPath $logDir -PathType Container)) {
            New-Item -ItemType Directory -Force -Path $logDir | Out-Null
        }
        Add-Content -LiteralPath $logPath -Value (
            "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
        )
    } catch { }
}

function Test-AgentHttpReady([int]$Port) {
    if ($Port -le 0 -or $Port -gt 65535) { return $false }
    $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/sync-now")
    $request.Method = 'GET'
    $request.Timeout = 2000
    $request.ReadWriteTimeout = 2000
    $request.AllowAutoRedirect = $false
    $request.Proxy = $null
    $response = $null
    try {
        try {
            $response = [System.Net.HttpWebResponse]$request.GetResponse()
        } catch [System.Net.WebException] {
            if ($null -eq $_.Exception.Response) { return $false }
            $response = [System.Net.HttpWebResponse]$_.Exception.Response
        }
        if ([int]$response.StatusCode -ne 400) { return $false }
        $reader = New-Object System.IO.StreamReader ($response.GetResponseStream())
        try { $body = $reader.ReadToEnd() | ConvertFrom-Json }
        finally { $reader.Dispose() }
        $properties = @($body.PSObject.Properties.Name)
        return (
            $properties -contains 'success' -and
            $properties -contains 'synced' -and
            $properties -contains 'error' -and
            [bool]$body.success -eq $false
        )
    } catch {
        return $false
    } finally {
        if ($response) { $response.Dispose() }
    }
}

try {
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw "config.json ausente em $configPath"
    }
    $cfg = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    $appPort = if ($cfg.ports -and $cfg.ports.app) { [int]$cfg.ports.app } else { 3000 }
    $statusPort = if ($cfg.ports -and $cfg.ports.status) {
        [int]$cfg.ports.status
    } else {
        $appPort + 1
    }
    $status = Invoke-RestMethod "http://127.0.0.1:$statusPort/status" `
        -Method Get -TimeoutSec 5

    $agentPort = if ($cfg.agent -and $null -ne $cfg.agent.syncNowPort) {
        [int]$cfg.agent.syncNowPort
    } else {
        0
    }
    $agentReady = Test-AgentHttpReady $agentPort
    $syncOk = if ($status.sync.lastSyncOk -eq $null) { 'unknown' } else { "$($status.sync.lastSyncOk)" }
    Write-Diagnostic (
        "hub=on postgres={0} agent={1} syncEnabled={2} lastSyncOk={3} pending={4}" -f
        [bool](@($status.peers | Where-Object { $_.name -eq 'postgres' -and $_.running }).Count),
        $agentReady,
        [bool]$status.sync.enabled,
        $syncOk,
        [int]$status.sync.pendingPush
    )
} catch {
    Write-Diagnostic "hub=off diagnostic=$($_.Exception.Message)"
}
