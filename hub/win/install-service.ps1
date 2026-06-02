<#
.SYNOPSIS
    Registra o maestro do hub Exped como servico Windows (auto-start) via NSSM,
    e abre as portas do app + gateway no firewall para a LAN. Idempotente.

.DESCRIPTION
    Servico:
      Nome           : ExpedHub
      Display        : Exped Hub (pilha local Supabase + app)
      Comando        : C:\Exped\bin\node.exe C:\Exped\hub\maestro.mjs
      Working dir    : C:\Exped
      Start          : SERVICE_AUTO_START (sobe sozinho no boot)
      Logs (stdout)  : C:\Exped\logs\service-out.log
      Logs (stderr)  : C:\Exped\logs\service-err.log

    O maestro NAO le config.json sozinho - ele monta a config a partir de
    variaveis de ambiente EXPED_* (ver hub/config.mjs) + EXPED_PG_BIN (ver
    hub/maestro.mjs). Este script LE o config.json e injeta cada chave como uma
    env var DO SERVICO (AppEnvironmentExtra do NSSM), pra que os filhos
    (Postgres, PostgREST, GoTrue, gateway, app) herdem tudo.

    Idempotente: se o servico ExpedHub ja existe, ele e parado e removido antes
    de ser recriado. A regra de firewall idem (removida e recriada).

.NOTES
    Rodar como Administrador (registrar servico + firewall exige elevacao).
    Validacao no Windows (o usuario roda):  sc query ExpedHub   -> STATE: RUNNING

    Este arquivo e salvo em UTF-8 com BOM e usa SOMENTE ASCII no codigo, pra
    nao quebrar o parser do PowerShell 5.1 (Windows Server) com caracteres
    nao-ASCII (travessao, acentos).
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
$NodeDir = Join-Path $Root 'bin\node'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# ---------------------------------------------------------------------------
# 0. Pre-condicoes
# ---------------------------------------------------------------------------
foreach ($p in @($Nssm, $NodeExe, $Maestro)) {
    if (-not (Test-Path $p)) { throw "Arquivo obrigatorio ausente: $p (rode download-binaries.ps1 e confira o pacote do hub)." }
}
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# ---------------------------------------------------------------------------
# 1. Ler config.json -> mapa de env vars EXPED_* do servico
# ---------------------------------------------------------------------------
# config.json (ver config.example.json) tem o shape { ports:{...}, paths:{...},
# jwtSecret, manifestUrl }. Traduzimos pra EXPED_* que hub/config.mjs entende.
$envMap = [ordered]@{}

# PATH do servico: o maestro chama psql/pg_ctl/initdb no bootstrap, e o spawn
# do Node precisa do node\ no PATH. Colocamos o pgsql\bin e o node\ ANTES do
# PATH herdado pra garantir que o servico ache os binarios mesmo num ambiente
# de servico minimo (sem o PATH do usuario interativo).
$envMap['PATH'] = "$PgBin;$NodeDir;$env:PATH"

# EXPED_PG_BIN: onde estao initdb.exe/pg_ctl.exe/psql.exe no Windows.
# (hub/maestro.mjs usa essa var; default dele e um path Linux - obrigatorio aqui.)
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
    if ($cfg.cloud) {
        if ($cfg.cloud.apiBase)       { $envMap['EXPED_CLOUD_API']          = "$($cfg.cloud.apiBase)" }
        if ($cfg.cloud.deviceToken)   { $envMap['EXPED_DEVICE_TOKEN']       = "$($cfg.cloud.deviceToken)" }
        if ($cfg.cloud.syncIntervalMs){ $envMap['EXPED_SYNC_INTERVAL_MS']   = "$($cfg.cloud.syncIntervalMs)" }
    }
} else {
    Write-Host "    AVISO: $ConfigPath nao encontrado - usando defaults do hub/config.mjs (so PATH/EXPED_PG_BIN serao setados)." -ForegroundColor Yellow
}

# Ports usadas no firewall (default do config.mjs: app 3000, gateway 54320).
$appPort     = if ($envMap['EXPED_APP_PORT'])     { $envMap['EXPED_APP_PORT'] }     else { '3000' }
$gatewayPort = if ($envMap['EXPED_GATEWAY_PORT']) { $envMap['EXPED_GATEWAY_PORT'] } else { '54320' }

# ---------------------------------------------------------------------------
# 2. (Re)criar o servico com NSSM - idempotente
# ---------------------------------------------------------------------------
# Verificar se o servico ja existe. Usamos 'Continue' aqui porque em PS 5.1
# o stderr de um processo nativo com exit!=0 gera NativeCommandError que com
# 'Stop' aborta o script - mesmo com 2>$null (o redirect suprime a saida mas
# nao o ErrorRecord). Queremos apenas inspecionar o exit code.
$prevEAP2 = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$null = & $Nssm status $ServiceName 2>$null
$svcExists = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $prevEAP2
if ($svcExists) {
    Write-Step "Servico $ServiceName ja existe - parando e removendo (recriar)"
    # Tolerante a erro: 'nssm stop' num servico ja STOPPED/inexistente lanca
    # excecao e abortaria o script ($ErrorActionPreference='Stop' global). Aqui
    # trocamos pra 'Continue' so neste bloco e blindamos com try/catch, pra
    # manter a idempotencia (parar/remover nunca derruba a reinstalacao).
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Nssm stop $ServiceName 2>$null | Out-Null } catch {}
    Start-Sleep -Seconds 2
    try { & $Nssm remove $ServiceName confirm 2>$null | Out-Null } catch {}
    Start-Sleep -Seconds 1
    $ErrorActionPreference = $prevEAP
}

Write-Step "Registrando servico $ServiceName"
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

# Env vars do servico (formato NSSM: linhas KEY=VALUE separadas por \n).
$envLines = ($envMap.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "`r`n"
& $Nssm set $ServiceName AppEnvironmentExtra $envLines
Write-Host "    Env do servico:"
$envMap.GetEnumerator() | ForEach-Object {
    $shown = if ($_.Key -eq 'EXPED_JWT_SECRET') { '***' } else { $_.Value }
    Write-Host "      $($_.Key)=$shown"
}

# ---------------------------------------------------------------------------
# 3. Firewall - liberar app + gateway pra LAN (inbound TCP)
# ---------------------------------------------------------------------------
# Idempotente: remove uma regra "ExpedHub" antiga (se houver) e recria.
Write-Step "Configurando firewall (inbound TCP $appPort,$gatewayPort)"
netsh advfirewall firewall delete rule name="ExpedHub" | Out-Null
netsh advfirewall firewall add rule name="ExpedHub" dir=in action=allow protocol=TCP localport="$appPort,$gatewayPort" | Out-Null

# ---------------------------------------------------------------------------
# 4. Iniciar o servico
# ---------------------------------------------------------------------------
Write-Step "Iniciando servico $ServiceName"
& $Nssm start $ServiceName

Write-Host ""
Write-Step "Concluido."
Write-Host "    Verifique:  sc query $ServiceName   (deve estar RUNNING)"
Write-Host "    Logs:       $LogDir  (service-out.log, service-err.log, maestro.log e por-peca)"
Write-Host "    /status:    http://127.0.0.1:$([int]$appPort + 1)/status"
