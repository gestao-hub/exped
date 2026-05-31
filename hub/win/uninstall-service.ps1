<#
.SYNOPSIS
    Para e remove o serviço Windows ExpedHub e remove a regra de firewall.
    Por padrao PRESERVA os dados (C:\Exped\data); use -RemoveData para apagar.

.DESCRIPTION
    - Para o serviço ExpedHub (se rodando) e o remove via NSSM.
    - Remove a regra de firewall "ExpedHub".
    - NAO apaga C:\Exped\data por padrao (banco + storage do cliente).
      Passe -RemoveData $true SOMENTE se quiser zerar tudo.

.NOTES
    Rodar como Administrador. Chamado pelo [UninstallRun] do Inno Setup.
#>

[CmdletBinding()]
param(
    [string]$Root        = 'C:\Exped',
    [string]$ServiceName = 'ExpedHub',
    [bool]  $RemoveData  = $false
)

$ErrorActionPreference = 'Continue'   # uninstall deve ser tolerante a faltas
$Nssm    = Join-Path $Root 'bin\nssm.exe'
$DataDir = Join-Path $Root 'data'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# ---------------------------------------------------------------------------
# 1. Parar + remover o serviço
# ---------------------------------------------------------------------------
if (Test-Path $Nssm) {
    & $Nssm status $ServiceName 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Step "Parando serviço $ServiceName"
        & $Nssm stop $ServiceName 2>$null | Out-Null
        Start-Sleep -Seconds 2
        Write-Step "Removendo serviço $ServiceName"
        & $Nssm remove $ServiceName confirm | Out-Null
    } else {
        Write-Host "    Serviço $ServiceName nao registrado — nada a remover."
    }
} else {
    # Fallback se o nssm.exe ja foi apagado: usa sc.exe.
    Write-Step "nssm.exe ausente — tentando remover via sc.exe"
    sc.exe stop   $ServiceName | Out-Null
    Start-Sleep -Seconds 2
    sc.exe delete $ServiceName | Out-Null
}

# ---------------------------------------------------------------------------
# 2. Firewall
# ---------------------------------------------------------------------------
Write-Step "Removendo regra de firewall ExpedHub"
netsh advfirewall firewall delete rule name="ExpedHub" | Out-Null

# ---------------------------------------------------------------------------
# 3. Dados (opcional)
# ---------------------------------------------------------------------------
if ($RemoveData) {
    Write-Step "RemoveData=true — apagando $DataDir"
    if (Test-Path $DataDir) { Remove-Item -Recurse -Force $DataDir }
} else {
    Write-Host "==> Dados PRESERVADOS em $DataDir (use -RemoveData `$true para apagar)." -ForegroundColor Yellow
}

Write-Step "Concluido."
