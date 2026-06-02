<#
.SYNOPSIS
    Baixa os binarios win-x64 do hub local do Exped (PostgreSQL + PostgREST + Node + NSSM) para C:\Exped\bin.

.DESCRIPTION
    O hub local roda a pilha Supabase nativa (sem Docker):
      - PostgreSQL  (banco)          -> baixado por este script (zip oficial EDB)
      - PostgREST   (REST API)       -> baixado por este script (release GitHub)
      - Node.js     (runtime do hub) -> baixado por este script (zip oficial nodejs.org)
      - NSSM        (Windows service)-> baixado por este script (nssm.cc)
      - GoTrue/auth (login)          -> NAO baixado aqui. O auth.exe + migrations/
                                        vem JUNTO do pacote do hub (cross-compilado
                                        win-x64 a partir de supabase/auth; ver README.md).

    Apos rodar, a estrutura fica:
      C:\Exped\bin\
        pgsql\        (PostgreSQL: bin\initdb.exe, bin\pg_ctl.exe, bin\psql.exe, ...)
        postgrest.exe
        node\         (Node portatil: node.exe, npm, ...)
        node.exe      (atalho/copia de node\node.exe, usado pelo serviço ExpedHub)
        nssm.exe      (gerenciador de serviço Windows)
        auth.exe      (vem do pacote, copiado pelo instalador do hub)
        migrations\   (vem do pacote, copiado pelo instalador do hub)

.NOTES
    URLs validadas em 2026-05-31 a partir do Linux (curl -sI / -r 0-0):
      - PostgreSQL : HTTP 200  (get.enterprisedb.com)
      - PostgREST  : HTTP 200  (github.com/PostgREST/postgrest releases)
      - Node       : HTTP 200  (nodejs.org/dist/v20.18.0/node-v20.18.0-win-x64.zip)
      - NSSM       : HTTP 206  (nssm.cc bloqueia HEAD com 503, mas serve o GET - ver README)
    Se uma versao sair do ar, ajuste os parametros de versao abaixo.
#>

[CmdletBinding()]
param(
    [string]$InstallDir       = 'C:\Exped\bin',
    [string]$PgVersion        = '16.9-1',                  # PostgreSQL EDB win-x64
    [string]$PostgrestVersion = 'v14.12',                  # PostgREST release tag
    [string]$NodeVersion      = 'v20.18.0',                # Node.js LTS win-x64
    [string]$NssmVersion      = '2.24',                    # NSSM release
    # SHA-256 do node-v20.18.0-win-x64.zip (de nodejs.org/dist/<ver>/SHASUMS256.txt).
    # Se mudar $NodeVersion, atualize este hash ou passe '' para pular a verificacao.
    [string]$NodeSha256       = 'f5cea43414cc33024bbe5867f208d1c9c915d6a38e92abeee07ed9e563662297'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference     = 'SilentlyContinue'  # downloads muito mais rapidos no Invoke-WebRequest

# TLS 1.2 (Windows Server / PowerShell 5.1 antigo pode nao habilitar por padrao)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# ---------------------------------------------------------------------------
# 0. Preparar diretorios
# ---------------------------------------------------------------------------
Write-Step "Criando diretorio de instalacao: $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
# Diretorio de trabalho FIXO sob $InstallDir (ex.: C:\Exped\bin\_tmp), evitando o
# $env:TEMP - que no Win11 pode conter ESPACO (ex.: C:\Users\Joao Silva\AppData\...),
# o que quebra Move-Item/Expand-Archive sem -LiteralPath. Aqui o caminho e controlado.
$tmp = Join-Path $InstallDir "_tmp"
if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

# ---------------------------------------------------------------------------
# 1. PostgreSQL (zip oficial EDB)
# ---------------------------------------------------------------------------
$pgUrl = "https://get.enterprisedb.com/postgresql/postgresql-$PgVersion-windows-x64-binaries.zip"
$pgZip = Join-Path $tmp "postgresql.zip"
Write-Step "Baixando PostgreSQL $PgVersion ..."
Write-Host "    $pgUrl"
Invoke-WebRequest -Uri $pgUrl -OutFile $pgZip

Write-Step "Extraindo PostgreSQL para $InstallDir\pgsql ..."
# O zip da EDB contem uma pasta raiz "pgsql\". Extraimos direto em $InstallDir.
if (Test-Path -LiteralPath (Join-Path $InstallDir 'pgsql')) {
    Remove-Item -LiteralPath (Join-Path $InstallDir 'pgsql') -Recurse -Force
}
Expand-Archive -LiteralPath $pgZip -DestinationPath $InstallDir -Force

$initdb = Join-Path $InstallDir 'pgsql\bin\initdb.exe'
if (-not (Test-Path $initdb)) {
    throw "initdb.exe nao encontrado em $initdb apos extracao. Verifique o layout do zip."
}
Write-Host "    OK: $initdb"

# ---------------------------------------------------------------------------
# 2. PostgREST (release GitHub, asset windows-x86-64)
# ---------------------------------------------------------------------------
$prUrl = "https://github.com/PostgREST/postgrest/releases/download/$PostgrestVersion/postgrest-$PostgrestVersion-windows-x86-64.zip"
$prZip = Join-Path $tmp "postgrest.zip"
Write-Step "Baixando PostgREST $PostgrestVersion ..."
Write-Host "    $prUrl"
Invoke-WebRequest -Uri $prUrl -OutFile $prZip

Write-Step "Extraindo PostgREST para $InstallDir ..."
Expand-Archive -LiteralPath $prZip -DestinationPath $InstallDir -Force

$postgrest = Join-Path $InstallDir 'postgrest.exe'
if (-not (Test-Path $postgrest)) {
    throw "postgrest.exe nao encontrado em $postgrest apos extracao."
}
Write-Host "    OK: $postgrest"

# O maestro (hub\maestro.mjs) procura o PostgREST em scripts\local-stack\bin\postgrest
# (caminho fixo, sem .exe). $InstallDir e tipicamente C:\Exped\bin -> a raiz e o pai.
# Copiamos postgrest.exe pra la, e tambem uma copia SEM extensao (defesa: spawn no
# Windows nao auto-anexa .exe). Ver README, "Concerns Windows-only".
$root = Split-Path -Parent $InstallDir
$lsBin = Join-Path $root 'scripts\local-stack\bin'
New-Item -ItemType Directory -Force -Path $lsBin | Out-Null
Copy-Item -LiteralPath $postgrest -Destination (Join-Path $lsBin 'postgrest.exe') -Force
Copy-Item -LiteralPath $postgrest -Destination (Join-Path $lsBin 'postgrest')     -Force
Write-Host "    Copiado para $lsBin (postgrest.exe + postgrest)"

# ---------------------------------------------------------------------------
# 3. Node.js portatil (zip oficial nodejs.org)
# ---------------------------------------------------------------------------
# O serviço ExpedHub roda `C:\Exped\bin\node.exe C:\Exped\hub\maestro.mjs`.
# Usamos a distribuicao portatil (zip) - nao precisa de instalador/MSI.
$nodeDirName = "node-$NodeVersion-win-x64"
$nodeUrl     = "https://nodejs.org/dist/$NodeVersion/$nodeDirName.zip"
$nodeZip     = Join-Path $tmp "node.zip"
Write-Step "Baixando Node.js $NodeVersion ..."
Write-Host "    $nodeUrl"
Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip

if ($NodeSha256) {
    $got = (Get-FileHash -Algorithm SHA256 -Path $nodeZip).Hash.ToLower()
    if ($got -ne $NodeSha256.ToLower()) {
        throw "SHA-256 do Node nao confere. Esperado $NodeSha256, obtido $got."
    }
    Write-Host "    SHA-256 OK"
}

Write-Step "Extraindo Node.js para $InstallDir\node ..."
# O zip contem uma pasta raiz "node-vX-win-x64\". Extraimos no tmp e movemos
# o conteudo pra $InstallDir\node (achatando a pasta raiz versionada).
$nodeExtract = Join-Path $tmp "node-extract"
if (Test-Path -LiteralPath $nodeExtract) { Remove-Item -LiteralPath $nodeExtract -Recurse -Force }
Expand-Archive -LiteralPath $nodeZip -DestinationPath $nodeExtract -Force
$nodeDest = Join-Path $InstallDir 'node'
if (Test-Path -LiteralPath $nodeDest) { Remove-Item -LiteralPath $nodeDest -Recurse -Force }
# -LiteralPath em Move-Item: o source/destino podem conter caracteres especiais;
# como $tmp agora e sob $InstallDir (sem espaco herdado do TEMP), isto e estavel.
Move-Item -LiteralPath (Join-Path $nodeExtract $nodeDirName) -Destination $nodeDest

# Copia node.exe pra raiz do bin\ tambem, pra o comando do serviço ficar simples
# (C:\Exped\bin\node.exe ...). O resto do runtime (npm etc.) fica em bin\node\.
Copy-Item -LiteralPath (Join-Path $nodeDest 'node.exe') -Destination (Join-Path $InstallDir 'node.exe') -Force

$nodeExe = Join-Path $InstallDir 'node.exe'
if (-not (Test-Path $nodeExe)) {
    throw "node.exe nao encontrado em $nodeExe apos extracao."
}
Write-Host "    OK: $nodeExe"

# ---------------------------------------------------------------------------
# 4. NSSM (Non-Sucking Service Manager) - registra o maestro como serviço Windows
# ---------------------------------------------------------------------------
# NOTA: nssm.cc responde 503 a requisicoes HEAD (anti-bot), mas serve o GET
# normalmente (validado com `curl -r 0-0` -> HTTP 206). Invoke-WebRequest usa GET,
# entao o download funciona. Se cair, ha mirrors (ver README, secao troubleshooting).
$nssmExe = Join-Path $InstallDir 'nssm.exe'
if (Test-Path -LiteralPath $nssmExe) {
    # Pre-empacotado (o instalador copiou payload\bin\nssm.exe). nssm.cc e instavel
    # (503/timeout); ter o nssm.exe no payload e o caminho robusto pra producao.
    Write-Step "NSSM ja presente em $nssmExe (pre-empacotado) - pulando download."
} else {
    $nssmUrl = "https://nssm.cc/release/nssm-$NssmVersion.zip"
    $nssmZip = Join-Path $tmp "nssm.zip"
    Write-Step "Baixando NSSM $NssmVersion ..."
    Write-Host "    $nssmUrl"
    # nssm.cc cai com frequencia (503/timeout). Tenta 3x antes de desistir.
    $nssmOk = $false
    for ($i = 1; $i -le 3 -and -not $nssmOk; $i++) {
        try { Invoke-WebRequest -Uri $nssmUrl -OutFile $nssmZip -TimeoutSec 30; $nssmOk = $true }
        catch { Write-Host "    tentativa $i de NSSM falhou: $($_.Exception.Message)"; Start-Sleep -Seconds 3 }
    }
    if (-not $nssmOk) {
        throw "Falha ao baixar NSSM (nssm.cc) apos 3 tentativas. Solucao robusta: pre-empacote o nssm.exe (win64) em payload\bin\nssm.exe — o instalador o copia e este download e pulado. (Ou copie um nssm.exe para $InstallDir e rode de novo.)"
    }
    Write-Step "Extraindo NSSM (nssm.exe win64) para $InstallDir ..."
    $nssmExtract = Join-Path $tmp "nssm-extract"
    if (Test-Path -LiteralPath $nssmExtract) { Remove-Item -LiteralPath $nssmExtract -Recurse -Force }
    Expand-Archive -LiteralPath $nssmZip -DestinationPath $nssmExtract -Force
    # O zip do NSSM tem layout: nssm-2.24\win64\nssm.exe e nssm-2.24\win32\nssm.exe. Pegamos o win64.
    $nssmSrc = Get-ChildItem -Path $nssmExtract -Recurse -Filter 'nssm.exe' |
        Where-Object { $_.FullName -match '\\win64\\' } |
        Select-Object -First 1
    if (-not $nssmSrc) {
        throw "nssm.exe (win64) nao encontrado no zip extraido em $nssmExtract."
    }
    Copy-Item -LiteralPath $nssmSrc.FullName -Destination $nssmExe -Force
    Write-Host "    OK: $nssmExe"
}

# ---------------------------------------------------------------------------
# 5. GoTrue / auth.exe  (NAO baixado - vem do pacote do hub)
# ---------------------------------------------------------------------------
Write-Step "GoTrue (auth.exe + migrations\): NAO baixado por este script."
Write-Host  "    O auth.exe win-x64 e a pasta migrations\ sao cross-compilados a partir"
Write-Host  "    de github.com/supabase/auth e distribuidos JUNTO do pacote do hub."
Write-Host  "    O instalador do hub os copia para $InstallDir\auth.exe e $InstallDir\migrations\."
$authExe = Join-Path $InstallDir 'auth.exe'
if (Test-Path $authExe) {
    Write-Host "    OK: $authExe ja presente." -ForegroundColor Green
} else {
    Write-Host "    AVISO: $authExe ainda nao presente (sera copiado pelo pacote do hub)." -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# Limpeza + resumo
# ---------------------------------------------------------------------------
Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue

Write-Step "Concluido. Binarios em $InstallDir :"
Write-Host "    PostgreSQL : pgsql\bin\ (initdb.exe, pg_ctl.exe, psql.exe, postgres.exe)"
Write-Host "    PostgREST  : postgrest.exe"
Write-Host "    Node.js    : node.exe (+ node\ com npm etc.)"
Write-Host "    NSSM       : nssm.exe"
Write-Host "    GoTrue     : auth.exe + migrations\ (do pacote do hub)"
Write-Host ""
Write-Host "Veja README.md para os passos de validacao de cada binario." -ForegroundColor Cyan
