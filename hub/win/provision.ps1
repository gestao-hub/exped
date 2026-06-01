# provision.ps1 — resgata o código de instalação e escreve os 2 configs.
# Uso (modo código):  provision.ps1 -Code "EXPED-7K4P-2QXM" [-CloudApi "https://app-exped.vercel.app"]
# Uso (modo manual):  provision.ps1 -DeviceToken "hpr_..." -CloudApi "https://app-exped.vercel.app"
#   No modo manual (suporte) NÃO há resgate: o token e a URL são informados direto.
# -AgentDir: caminho do ExpedAgent (o Inno passa {localappdata}\ExpedAgent — sob install
#   elevado, $env:LOCALAPPDATA apontaria pro perfil do admin, então recebemos explícito).
param(
  [string]$Code,
  [string]$DeviceToken,
  [string]$CloudApi = "https://app-exped.vercel.app",
  [string]$Root = "C:\Exped",
  [string]$AgentDir = ""
)
$ErrorActionPreference = "Stop"

# LOG em arquivo: o [Run] do Inno roda com runhidden e esconde a saída; o log deixa
# rastro de cada passo (e do erro) pra diagnóstico. Nunca deixa uma falha passar calada.
$logDir = Join-Path $Root "logs"
try { if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null } } catch {}
$logFile = Join-Path $logDir "provision.log"
function Log($m) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $m
  try { Add-Content -Path $logFile -Value $line } catch {}
  Write-Host $line
}

try {
  Log "provision.ps1 iniciado. modoCodigo=$([bool]$Code) modoManual=$([bool]$DeviceToken) Root=$Root"
  if (-not $AgentDir -or $AgentDir -eq "") { $AgentDir = Join-Path $env:LOCALAPPDATA "ExpedAgent" }

  # 1) Obter token + URL: por resgate do código OU direto (modo manual).
  if ($DeviceToken) {
    $token = $DeviceToken
    $cloud = $CloudApi
    Log "Modo manual: usando token/URL informados."
  } else {
    if (-not $Code) { throw "Informe -Code (modo código) ou -DeviceToken (modo manual)." }
    $body = @{ code = $Code } | ConvertTo-Json -Compress
    Log "Resgatando código em $CloudApi/api/provision/redeem ..."
    $resp = Invoke-RestMethod -Method Post -Uri "$CloudApi/api/provision/redeem" `
              -ContentType "application/json" -Body $body -TimeoutSec 30
    if (-not $resp.deviceToken) { throw "Resgate sem token — código inválido ou expirado." }
    $token = $resp.deviceToken
    $cloud = $resp.cloudApiUrl
    Log "Resgate OK. empresa=$($resp.empresaNome)"
  }

  # 2) config.json do hub (preserva jwtSecret/portas; só injeta/atualiza 'cloud').
  $cfgPath = Join-Path $Root "config.json"
  $cfg = if (Test-Path $cfgPath) { Get-Content $cfgPath -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
  $cfg | Add-Member -NotePropertyName cloud -NotePropertyValue ([pscustomobject]@{ apiBase=$cloud; deviceToken=$token }) -Force
  # UTF-8 SEM BOM: Set-Content -Encoding UTF8 grava BOM no PS 5.1 e quebra o JSON.parse do Node/.NET
  [System.IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding $false))
  Log "config.json escrito: $cfgPath"

  # 3) appsettings.json do agente (aponta pro hub LOCAL).
  $appPath = Join-Path $AgentDir "appsettings.json"
  if (Test-Path $appPath) {
    $app = Get-Content $appPath -Raw | ConvertFrom-Json
    if ($app.PSObject.Properties.Name -contains 'Agent' -and $app.Agent) {
      $app.Agent.ApiBaseUrl = "http://127.0.0.1:3000"
      $app.Agent.DeviceToken = $token
      [System.IO.File]::WriteAllText($appPath, ($app | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding $false))
      Log "appsettings.json do agente escrito: $appPath"
    } else {
      Log "AVISO: appsettings.json sem o nó 'Agent' em $appPath — não atualizei o token."
    }
  } else {
    Log "AVISO: appsettings.json não encontrado em $appPath (agente instalado em outro perfil?)."
  }

  if ($resp -and $resp.empresaNome) { Log "CONCLUÍDO. Empresa: $($resp.empresaNome)" }
  else { Log "CONCLUÍDO (modo manual). URL: $cloud" }
} catch {
  Log "ERRO: $($_.Exception.Message)"
  Log "Stack: $($_.ScriptStackTrace)"
  exit 1
}
