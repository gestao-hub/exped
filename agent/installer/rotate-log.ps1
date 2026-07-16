param(
  [Parameter(Mandatory = $true)]
  [string]$Path,
  [long]$MaxBytes = 67108864,
  [int]$Backups = 2
)

$ErrorActionPreference = 'Stop'

if ($MaxBytes -lt 1 -or $Backups -lt 1) { exit 0 }
if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { exit 0 }
if ((Get-Item -LiteralPath $Path).Length -lt $MaxBytes) { exit 0 }

Remove-Item -LiteralPath "$Path.$Backups" -Force -ErrorAction SilentlyContinue
for ($index = $Backups - 1; $index -ge 1; $index--) {
  $source = "$Path.$index"
  if (Test-Path -LiteralPath $source -PathType Leaf) {
    Move-Item -LiteralPath $source -Destination "$Path.$($index + 1)" -Force
  }
}
Move-Item -LiteralPath $Path -Destination "$Path.1" -Force
