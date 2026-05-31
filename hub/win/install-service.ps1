<#
.SYNOPSIS
    Registra o maestro do hub Exped como serviço Windows (auto-start) via NSSM,
    e abre as portas do app + gateway no firewall para a LAN. Idempotente.

.DESCRIPTION
    Serviço:
      Nome           : ExpedHub
      Display        : Exped Hub (pilha local Supabase + app)
      Comando        : C:\Exped\bin\node.exe C:\Exped\hub\maestro.mjs
      Working dir    : C:\Exped
      Start          : SERVICE_AUTO_START (sobe sozinho no boot)
      Logs (stdout)  : C:\Exped\logs\service-out.log
      Logs (stderr)  : C:\Exped\logs\service-err.log

    O maestro NAO le config.json sozinho — ele monta a config a partir de
    variaveis de ambiente EXPED_* (ver hub/config.mjs) + EXPED_PG_BIN (ver
    hub/maestro.mjs). Este script LE o config.json e injeta cada chave como uma
    env var DO SERVIÇO (AppEnvironmentExtra do NSSM), pra que os filhos
    (Postgres, PostgREST, GoTrue, gateway, app) herdem tudo.

    Idempotente: se o serviço ExpedHub ja existe, ele é parado e removido antes
    de ser recriado. A regra de firewall idem (removida e recriada).

.NOTES
    Rodar como Administrador (registrar serviço + firewall exige elevacao).
    Validacao no Windows (o usuario roda):  sc query ExpedHub   -> STATE: RUNNING
#>

[CmdletBinding()]
param(
    [string]$Root        = 'C:\Exped',
    [string]$ServiceName = 'ExpedHub',
    [string]$ConfigPath  = 'C:\Exped\config.json'
)

$ErrorActionPreference = 'Stop'

$Nssm    = Join-Path $Root 'bin\nssm.exe'
$NodeExe = Join-Path $Root 'bin\node.exe'
$Maestro = Join-Path $Root 'hub\maestro.mjs'
$LogDir  = Join-Path $Root 'logs'
$PgBin   = Join-Path $Root 'bin\pgsql\bin'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# ---------------------------------------------------------------------------
# 0. Pre-condicoes
# ---------------------------------------------------------------------------
foreach ($p in @($Nssm, $NodeExe, $Maestro)) {
    if (-not (Test-Path $p)) { throw "Arquivo obrigatorio ausente: $p (rode download-binaries.ps1 e confira o pacote do hub)." }
}
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# ---------------------------------------------------------------------------
# 1. Ler config.json -> mapa de env vars EXPED_* do serviço
# ---------------------------------------------------------------------------
# config.json (ver config.example.json) tem o shape { ports:{...}, paths:{...},
# jwtSecret, manifestUrl }. Traduzimos pra EXPED_* que hub/config.mjs entende.
$envMap = [ordered]@{}

# EXPED_PG_BIN: onde estao initdb.exe/pg_ctl.exe/psql.exe no Windows.
# (hub/maestro.mjs usa essa var; default dele é um path Linux — obrigatorio aqui.)
$envMap['EXPED_PG_BIN'] = $PgBin

if (Test-Path $ConfigPath) {
    Write-Step "Lendo config de $ConfigPath"
    $cfg = Get-Content -Raw -Path $ConfigPath | ConvertFrom-Json

    if ($cfg.ports) {
        if ($cfg.ports.pg)        { $envMap['EXPED_PG_PORT']        = "$($cfg.ports.pg)" }
        if ($cfg.ports.postgrest) { $envMap['EXPED_POSTGREST_PORT'] = "$($cfg.ports.postgrest)" }
        if ($cfg.ports.gotrue)    { $envMap['EXPED_GOTRUE_PORT']    = "$($cfg.ports.gotrue)" }
        if ($cfg.ports.gateway)   { $envMap['EXPED_GATEWAY_PORT']   = "$($cfg.ports.gateway)" }
        if ($cfg.ports.storage)   { $envMap['EXPED_STORAGE_PORT']   = "$($cfg.ports.storage)" }
        if ($cfg.ports.app)       { $envMap['EXPED_APP_PORT']       = "$($cfg.ports.app)" }
    }
    if ($cfg.paths) {
        # No Windows os dois conceitos sao SEPARADOS:
        #   pgData = diretorio de dados do cluster (pg_ctl -D <pgData>)
        #   pgHost = host de conexao TCP (psql/PostgREST/GoTrue) -> 127.0.0.1
        # Defaults seguros se o config.json nao trouxer: data em C:\Exped\data\pg,
        # host em 127.0.0.1 (nao ha socket Unix no Windows).
        if ($cfg.paths.pgData) { $envMap['EXPED_PG_DATA'] = "$($cfg.paths.pgData)" }
        else                   { $envMap['EXPED_PG_DATA'] = (Join-Path $Root 'data\pg') }
        if ($cfg.paths.pgHost) { $envMap['EXPED_PG_HOST'] = "$($cfg.paths.pgHost)" }
        else                   { $envMap['EXPED_PG_HOST'] = '127.0.0.1' }
        if ($cfg.paths.db)     { $envMap['EXPED_DB']       = "$($cfg.paths.db)" }
        if ($cfg.paths.user)   { $envMap['EXPED_DB_USER']  = "$($cfg.paths.user)" }
    }
    if ($cfg.jwtSecret)   { $envMap['EXPED_JWT_SECRET']  = "$($cfg.jwtSecret)" }
    if ($cfg.manifestUrl) { $envMap['EXPED_MANIFEST_URL'] = "$($cfg.manifestUrl)" }
} else {
    Write-Host "    AVISO: $ConfigPath nao encontrado — usando defaults do hub/config.mjs (so EXPED_PG_BIN sera setado)." -ForegroundColor Yellow
}

# Ports usadas no firewall (default do config.mjs: app 3000, gateway 54320).
$appPort     = if ($envMap['EXPED_APP_PORT'])     { $envMap['EXPED_APP_PORT'] }     else { '3000' }
$gatewayPort = if ($envMap['EXPED_GATEWAY_PORT']) { $envMap['EXPED_GATEWAY_PORT'] } else { '54320' }

# ---------------------------------------------------------------------------
# 2. (Re)criar o serviço com NSSM — idempotente
# ---------------------------------------------------------------------------
$existing = & $Nssm status $ServiceName 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Step "Serviço $ServiceName ja existe — parando e removendo (recriar)"
    & $Nssm stop   $ServiceName 2>$null | Out-Null
    Start-Sleep -Seconds 2
    & $Nssm remove $ServiceName confirm | Out-Null
    Start-Sleep -Seconds 1
}

Write-Step "Registrando serviço $ServiceName"
& $Nssm install $ServiceName $NodeExe $Maestro
& $Nssm set $ServiceName AppDirectory      $Root
& $Nssm set $ServiceName DisplayName        "Exped Hub (pilha local Supabase + app)"
& $Nssm set $ServiceName Description         "Orquestra Postgres + PostgREST + GoTrue + storage + gateway + app Next do Exped (offline/LAN)."
& $Nssm set $ServiceName Start              SERVICE_AUTO_START
& $Nssm set $ServiceName AppStdout          (Join-Path $LogDir 'service-out.log')
& $Nssm set $ServiceName AppStderr          (Join-Path $LogDir 'service-err.log')
# Rotaciona o log do NSSM em ~10MB pra nao encher o disco.
& $Nssm set $ServiceName AppRotateFiles     1
& $Nssm set $ServiceName AppRotateBytes     10485760
# Da tempo do maestro derrubar a pilha na ordem inversa antes de matar (SIGTERM-like).
& $Nssm set $ServiceName AppStopMethodConsole 15000

# Env vars do serviço (formato NSSM: linhas KEY=VALUE separadas por \n).
$envLines = ($envMap.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "`r`n"
& $Nssm set $ServiceName AppEnvironmentExtra $envLines
Write-Host "    Env do serviço:"
$envMap.GetEnumerator() | ForEach-Object {
    $shown = if ($_.Key -eq 'EXPED_JWT_SECRET') { '***' } else { $_.Value }
    Write-Host "      $($_.Key)=$shown"
}

# ---------------------------------------------------------------------------
# 3. Firewall — liberar app + gateway pra LAN (inbound TCP)
# ---------------------------------------------------------------------------
# Idempotente: remove uma regra "ExpedHub" antiga (se houver) e recria.
Write-Step "Configurando firewall (inbound TCP $appPort,$gatewayPort)"
netsh advfirewall firewall delete rule name="ExpedHub" | Out-Null
netsh advfirewall firewall add rule name="ExpedHub" dir=in action=allow protocol=TCP localport="$appPort,$gatewayPort" | Out-Null

# ---------------------------------------------------------------------------
# 4. Iniciar o serviço
# ---------------------------------------------------------------------------
Write-Step "Iniciando serviço $ServiceName"
& $Nssm start $ServiceName

Write-Host ""
Write-Step "Concluido."
Write-Host "    Verifique:  sc query $ServiceName   (deve estar RUNNING)"
Write-Host "    Logs:       $LogDir  (service-out.log, service-err.log, maestro.log e por-peca)"
Write-Host "    /status:    http://127.0.0.1:$([int]$appPort + 1)/status"
