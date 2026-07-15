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
    URLs e SHA-256 validados em 2026-07-14 a partir das distribuicoes oficiais:
      - PostgreSQL : HTTP 200  (get.enterprisedb.com)
      - PostgREST  : HTTP 200  (github.com/PostgREST/postgrest releases)
      - Node       : HTTP 200  (nodejs.org/dist/v24.18.0/node-v24.18.0-win-x64.zip)
      - NSSM       : HTTP 206  (nssm.cc bloqueia HEAD com 503, mas serve o GET - ver README)
    Se uma versao sair do ar, ajuste os parametros de versao abaixo.
#>

[CmdletBinding()]
param(
    [string]$InstallDir       = 'C:\Exped\bin',
    [string]$PgVersion        = '16.14-1',                 # PostgreSQL EDB win-x64
    [string]$PostgrestVersion = 'v14.12',                  # PostgREST release tag
    [string]$NodeVersion      = 'v24.18.0',                # Node.js LTS win-x64
    [string]$NssmVersion      = '2.24',                    # NSSM release
    [ValidatePattern('^[0-9a-fA-F]{64}$')]
    [string]$PgSha256         = '98af1417ba6a8dc30543e560e5407833a3b9e7cc7ed20e73b2006f3aa2f04663',
    [ValidatePattern('^[0-9a-fA-F]{64}$')]
    [string]$PostgrestSha256  = '0265772defae0fc24615ccb1e5a40c3f81d59f8f2fbc57ab20ac8e1d1aa7d0a3',
    [ValidatePattern('^[0-9a-fA-F]{64}$')]
    [string]$NodeSha256       = '0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821',
    [ValidatePattern('^[0-9a-fA-F]{64}$')]
    [string]$NssmSha256       = '727d1e42275c605e0f04aba98095c38a8e1e46def453cdffce42869428aa6743',
    [ValidatePattern('^[0-9a-fA-F]{64}$')]
    [string]$NssmExeSha256    = 'f689ee9af94b00e9e3f0bb072b34caaf207f32dcb4f5782fc9ca351df9a06c97'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference     = 'SilentlyContinue'  # evita o overhead da barra de progresso

# TLS 1.2 (Windows Server / PowerShell 5.1 antigo pode nao habilitar por padrao)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

function Assert-Sha256 {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Expected
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Arquivo ausente para validacao SHA-256: $Path"
    }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
    $normalizedExpected = $Expected.ToLowerInvariant()
    if ($actual -ne $normalizedExpected) {
        throw "SHA-256 nao confere para $Path. Esperado $normalizedExpected, obtido $actual."
    }
    Write-Host "    SHA-256 OK: $actual"
}

# Log em arquivo: o [Code] do Inno roda este script oculto (saida invisivel).
# Start-Transcript grava tudo (passos + erros) em C:\Exped\logs\download-binaries.log
# pra auditar depois. (InstallDir e ...\bin; o pai e a raiz C:\Exped.)
$logDir = Join-Path (Split-Path -Parent $InstallDir) 'logs'
try {
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  Start-Transcript -Path (Join-Path $logDir 'download-binaries.log') -Append | Out-Null
} catch { }

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
Invoke-WebRequest -Uri $pgUrl -OutFile $pgZip -UseBasicParsing
Assert-Sha256 -Path $pgZip -Expected $PgSha256

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
Invoke-WebRequest -Uri $prUrl -OutFile $prZip -UseBasicParsing
Assert-Sha256 -Path $prZip -Expected $PostgrestSha256

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
Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeZip -UseBasicParsing
Assert-Sha256 -Path $nodeZip -Expected $NodeSha256

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
# normalmente (validado com `curl -r 0-0` -> HTTP 206). O cmdlet usa GET,
# entao o download funciona. Se cair, ha mirrors (ver README, secao troubleshooting).
$nssmExe = Join-Path $InstallDir 'nssm.exe'
if (Test-Path -LiteralPath $nssmExe) {
    # Pre-empacotado (o instalador copiou payload\bin\nssm.exe). nssm.cc e instavel
    # (503/timeout); ter o nssm.exe no payload e o caminho robusto pra producao.
    Write-Step "NSSM ja presente em $nssmExe (pre-empacotado) - pulando download."
    Assert-Sha256 -Path $nssmExe -Expected $NssmExeSha256
} else {
    $nssmUrl = "https://nssm.cc/release/nssm-$NssmVersion.zip"
    $nssmZip = Join-Path $tmp "nssm.zip"
    Write-Step "Baixando NSSM $NssmVersion ..."
    Write-Host "    $nssmUrl"
    # nssm.cc cai com frequencia (503/timeout). Tenta 3x antes de desistir.
    $nssmOk = $false
    for ($i = 1; $i -le 3 -and -not $nssmOk; $i++) {
        try { Invoke-WebRequest -Uri $nssmUrl -OutFile $nssmZip -TimeoutSec 30 -UseBasicParsing; $nssmOk = $true }
        catch { Write-Host "    tentativa $i de NSSM falhou: $($_.Exception.Message)"; Start-Sleep -Seconds 3 }
    }
    if (-not $nssmOk) {
        throw "Falha ao baixar NSSM (nssm.cc) apos 3 tentativas. Solucao robusta: pre-empacote o nssm.exe (win64) em payload\bin\nssm.exe - o instalador o copia e este download e pulado. (Ou copie um nssm.exe para $InstallDir e rode de novo.)"
    }
    Assert-Sha256 -Path $nssmZip -Expected $NssmSha256
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
    Assert-Sha256 -Path $nssmExe -Expected $NssmExeSha256
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

try { Stop-Transcript | Out-Null } catch { }
