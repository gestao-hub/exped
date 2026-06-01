# provision.ps1 — resgata o código de instalação e escreve os 2 configs.
# Uso (modo código):  provision.ps1 -Code "EXPED-7K4P-2QXM" [-CloudApi "https://app-exped.vercel.app"]
# Uso (modo manual):  provision.ps1 -DeviceToken "hpr_..." -CloudApi "https://app-exped.vercel.app"
#   No modo manual (suporte) NÃO há resgate: o token e a URL são informados direto.
param(
  [string]$Code,
  [string]$DeviceToken,
  [string]$CloudApi = "https://app-exped.vercel.app",
  [string]$Root = "C:\Exped"
)
$ErrorActionPreference = "Stop"

# 1) Obter token + URL: por resgate do código OU direto (modo manual).
if ($DeviceToken) {
  # --- Modo manual: usa o token/URL informados, sem chamar a nuvem. ---
  $token = $DeviceToken
  $cloud = $CloudApi
} else {
  if (-not $Code) { Write-Error "Informe -Code (modo código) ou -DeviceToken (modo manual)."; exit 1 }
  # --- Modo código: resgata na nuvem. ---
  $body = @{ code = $Code } | ConvertTo-Json -Compress
  try {
    $resp = Invoke-RestMethod -Method Post -Uri "$CloudApi/api/provision/redeem" `
              -ContentType "application/json" -Body $body -TimeoutSec 30
  } catch {
    Write-Error "Falha ao resgatar o código. Verifique a internet e gere um novo código no painel. ($_)"
    exit 2
  }
  if (-not $resp.deviceToken) { Write-Error "Resgate sem token — código inválido ou expirado."; exit 3 }

  $token = $resp.deviceToken
  $cloud = $resp.cloudApiUrl
}

# 2) Escrever config.json do hub (preserva jwtSecret/portas já gerados no install)
$cfgPath = Join-Path $Root "config.json"
$cfg = if (Test-Path $cfgPath) { Get-Content $cfgPath -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
$cfg | Add-Member -NotePropertyName cloud -NotePropertyValue ([pscustomobject]@{ apiBase=$cloud; deviceToken=$token }) -Force
($cfg | ConvertTo-Json -Depth 8) | Set-Content -Path $cfgPath -Encoding UTF8

# 3) Escrever appsettings.json do agente (aponta pro hub LOCAL)
$agentDir = Join-Path $env:LOCALAPPDATA "ExpedAgent"
$appPath  = Join-Path $agentDir "appsettings.json"
if (Test-Path $appPath) {
  $app = Get-Content $appPath -Raw | ConvertFrom-Json
  $app.Agent.ApiBaseUrl = "http://127.0.0.1:3000"
  $app.Agent.DeviceToken = $token
  ($app | ConvertTo-Json -Depth 8) | Set-Content -Path $appPath -Encoding UTF8
}
if ($resp -and $resp.empresaNome) {
  Write-Host "Provisionamento concluído para a empresa: $($resp.empresaNome)"
} else {
  Write-Host "Provisionamento concluído (modo manual). URL: $cloud"
}
