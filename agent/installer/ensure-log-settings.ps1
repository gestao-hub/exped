param(
  [Parameter(Mandatory = $true)]
  [string]$SettingsPath
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$fullPath = [System.IO.Path]::GetFullPath($SettingsPath)

if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { exit 0 }

$settings = Get-Content -Raw -LiteralPath $fullPath | ConvertFrom-Json
if (-not $settings.Logging) {
  $settings | Add-Member -NotePropertyName Logging -NotePropertyValue ([pscustomobject]@{}) -Force
}
if (-not $settings.Logging.LogLevel) {
  $settings.Logging | Add-Member -NotePropertyName LogLevel `
    -NotePropertyValue ([pscustomobject]@{}) -Force
}
$settings.Logging.LogLevel | Add-Member `
  -NotePropertyName 'System.Net.Http.HttpClient' -NotePropertyValue 'Warning' -Force

$tempPath = "$fullPath.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
$backupPath = "$fullPath.$PID.$([Guid]::NewGuid().ToString('N')).replace.bak"
try {
  [System.IO.File]::WriteAllText(
    $tempPath,
    ($settings | ConvertTo-Json -Depth 16),
    $utf8NoBom
  )
  if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
    [System.IO.File]::Replace($tempPath, $fullPath, $backupPath)
    [System.IO.File]::Delete($backupPath)
  } else {
    Move-Item -LiteralPath $tempPath -Destination $fullPath -Force
  }
} finally {
  Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
}
