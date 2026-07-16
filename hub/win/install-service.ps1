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
      Start          : SERVICE_DELAYED_AUTO_START (sobe sozinho apos o boot)
      Logs (stdout)  : C:\Exped\logs\service-out.log
      Logs (stderr)  : C:\Exped\logs\service-err.log

    O maestro NAO le config.json sozinho - ele monta a config a partir de
    variaveis de ambiente EXPED_* (ver hub/config.mjs) + EXPED_PG_BIN (ver
    hub/maestro.mjs). Este script LE o config.json e injeta cada chave como uma
    env var DO SERVICO (AppEnvironmentExtra do NSSM), pra que os filhos
    (Postgres, PostgREST, GoTrue, gateway, app) herdem tudo.

    Idempotente: se o servico ExpedHub ja existe, ele e parado e atualizado no
    lugar. A regra de firewall e removida e recriada.

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
    [string]$ConfigPath  = 'C:\Exped\config.json',
    [string]$ServerIp    = '',
    [string]$AgentReceiptId = '',
    [string]$AgentUserSid = '',
    [string]$TransactionDir = '',
    [ValidateSet('true', 'false')]
    [string]$ManageAgent = 'false'
)

$ErrorActionPreference = 'Stop'
$ManageAgentEnabled = $ManageAgent -eq 'true'

$Nssm    = Join-Path $Root 'bin\nssm.exe'
$NodeExe = Join-Path $Root 'bin\node.exe'
$Maestro = Join-Path $Root 'hub\maestro.mjs'
$LogDir  = Join-Path $Root 'logs'
$PgBin   = Join-Path $Root 'bin\pgsql\bin'
$NodeDir = Join-Path $Root 'bin\node'
$Mkcert  = Join-Path $Root 'bin\mkcert.exe'
$CertDir = Join-Path $Root 'cert'
$AgentSettingsHelper = Join-Path $Root 'hub\win\agent-settings.ps1'
$AgentSyncContract = Join-Path $Root 'hub\win\agent-sync-contract.mjs'
$script:SensitiveEnvNamePattern = '(?:SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE_KEY|API_KEY|ANON_KEY|SERVICE_ROLE)'

# Capture ownership of the service before any filesystem, config, URL ACL or
# registry mutation. A failure in an earlier phase must never classify an
# existing service as one created by this attempt.
$initialService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
$serviceExistedBefore = $null -ne $initialService
$serviceWasRunningBefore = (
    $serviceExistedBefore -and
    $initialService.Status -eq [System.ServiceProcess.ServiceControllerStatus]::Running
)

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

function Protect-ExpedConfigAcl($Path, $OperationalUserSid = '') {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "config.json ausente para aplicar ACL: $Path"
    }
    $systemSid = New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'
    $administratorsSid = New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-32-544'
    $security = New-Object System.Security.AccessControl.FileSecurity
    $security.SetOwner($administratorsSid)
    $security.SetAccessRuleProtection($true, $false)
    $security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
        $systemSid,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.AccessControlType]::Allow
    )))
    $security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
        $administratorsSid,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.AccessControlType]::Allow
    )))
    if ($OperationalUserSid) {
        if (-not (Test-ExpedUserSid $OperationalUserSid)) {
            throw "SID operacional invalido para ACL do config.json: $OperationalUserSid"
        }
        $userSid = New-Object System.Security.Principal.SecurityIdentifier $OperationalUserSid
        $security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
            $userSid,
            [System.Security.AccessControl.FileSystemRights]::ReadAndExecute,
            [System.Security.AccessControl.AccessControlType]::Allow
        )))
    }
    Set-Acl -LiteralPath $Path -AclObject $security
    if (-not (Get-Acl -LiteralPath $Path).AreAccessRulesProtected) {
        throw 'ACL do config.json continuou herdavel apos hardening.'
    }
}

function Test-ExpedUsableIpv4($Address) {
    $parsed = $null
    if (-not [System.Net.IPAddress]::TryParse("$Address", [ref]$parsed)) { return $false }
    if ($parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { return $false }
    $octets = $parsed.GetAddressBytes()
    if ($octets[0] -eq 0 -or $octets[0] -eq 127 -or $octets[0] -ge 224) { return $false }
    if ($octets[0] -eq 169 -and $octets[1] -eq 254) { return $false }
    return $true
}

function Resolve-ExpedServerIp($Config) {
    $requested = "$ServerIp"
    if (-not $requested -and $Config -and $Config.network -and $Config.network.serverIp) {
        $requested = "$($Config.network.serverIp)"
    }
    if ($requested) {
        if (-not (Test-ExpedUsableIpv4 $requested)) {
            throw "ServerIp explicito nao e IPv4 LAN utilizavel: $requested"
        }
        return $requested
    }

    $candidates = @()
    foreach ($ipConfig in @(Get-NetIPConfiguration -ErrorAction Stop)) {
        $identity = "$($ipConfig.InterfaceAlias) $($ipConfig.NetAdapter.InterfaceDescription)"
        if ($identity -match 'Hyper-V|vEthernet|VPN|TAP|TUN|Loopback|Virtual|Pseudo') { continue }
        if ($null -eq $ipConfig.NetAdapter -or "$($ipConfig.NetAdapter.Status)" -ne 'Up') { continue }
        foreach ($address in @($ipConfig.IPv4Address)) {
            if (-not (Test-ExpedUsableIpv4 $address.IPAddress)) { continue }
            $candidates += [pscustomobject]@{
                Address = "$($address.IPAddress)"
                HasGateway = $null -ne $ipConfig.IPv4DefaultGateway
                Metric = if ($ipConfig.NetIPv4Interface) {
                    [int]$ipConfig.NetIPv4Interface.InterfaceMetric
                } else { [int]::MaxValue }
            }
        }
    }
    $selected = @($candidates | Sort-Object `
        @{ Expression = { $_.HasGateway }; Descending = $true },
        @{ Expression = { $_.Metric }; Ascending = $true }) | Select-Object -First 1
    if ($null -eq $selected) {
        throw 'Nenhum IPv4 fisico ativo foi encontrado; informe -ServerIp explicitamente.'
    }
    return $selected.Address
}

function Wait-ExpedHttpsReady($Address, $CertificatePath, [int]$TimeoutSeconds = 90) {
    if (-not (Test-Path -LiteralPath $CertificatePath -PathType Leaf)) {
        throw "Certificado HTTPS ausente para validacao: $CertificatePath"
    }
    if (-not ('ExpedInstallerCertificateValidator' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;

public static class ExpedInstallerCertificateValidator
{
    public static string ExpectedThumbprint { get; set; }
    public static readonly RemoteCertificateValidationCallback Callback = Validate;

    private static bool Validate(
        object sender,
        X509Certificate certificate,
        X509Chain chain,
        SslPolicyErrors sslPolicyErrors)
    {
        if (certificate == null || String.IsNullOrWhiteSpace(ExpectedThumbprint)) {
            return false;
        }
        using (var presented = new X509Certificate2(certificate)) {
            return String.Equals(
                presented.Thumbprint,
                ExpectedThumbprint,
                StringComparison.OrdinalIgnoreCase
            );
        }
    }
}
'@
    }
    $expectedCertificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $CertificatePath
    $expectedThumbprint = $expectedCertificate.Thumbprint
    $previousCallback = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
    $uri = "https://$Address/login"
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $lastFailure = 'sem resposta'
    try {
        [ExpedInstallerCertificateValidator]::ExpectedThumbprint = $expectedThumbprint
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = [ExpedInstallerCertificateValidator]::Callback
        do {
            try {
                $response = Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 5
                if ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 400) { return }
                $lastFailure = "HTTP $([int]$response.StatusCode)"
            } catch {
                $lastFailure = $_.Exception.Message
            }
            Start-Sleep -Seconds 1
        } while ((Get-Date) -lt $deadline)
    } finally {
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $previousCallback
        [ExpedInstallerCertificateValidator]::ExpectedThumbprint = $null
        $expectedCertificate.Dispose()
    }
    throw "HTTPS nao ficou pronto em $uri. Ultimo erro: $lastFailure"
}

function Protect-ExpedEnvValueForLog($Name, $Value) {
    if ("$Name" -match $script:SensitiveEnvNamePattern) { return '***' }
    return "$Value"
}

function Protect-ExpedNativeArgumentsForLog($Arguments) {
    $safe = foreach ($argument in @($Arguments)) {
        $text = "$argument"
        $containsSecret = $false
        foreach ($line in ($text -split "`r?`n")) {
            if ($line -match '^([^=]+)=' -and $Matches[1] -match $script:SensitiveEnvNamePattern) {
                $containsSecret = $true
                break
            }
        }
        if ($containsSecret) { '<redacted-env-block>' } else { $text }
    }
    return ($safe -join ' ')
}

function Protect-ExpedDiagnosticText($Text) {
    $safe = "$Text".Replace(([char]0).ToString(), '')
    if ($null -ne $envMap) {
        foreach ($entry in @($envMap.GetEnumerator())) {
            $value = "$($entry.Value)"
            if ("$($entry.Key)" -match $script:SensitiveEnvNamePattern -and $value) {
                $safe = $safe.Replace($value, '***')
            }
        }
    }
    if ($safe.Length -gt 8192) { return $safe.Substring(0, 8192) + '...[truncated]' }
    return $safe
}

function Write-InstallFailureJournal($Failure) {
    if (-not $TransactionDir) { return }

    $transactionPath = [System.IO.Path]::GetFullPath($TransactionDir)
    $statePath = Join-Path $transactionPath 'hub-state.json'
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        throw 'TransactionDir sem snapshot para registrar falha do install-service.'
    }
    $snapshot = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    $expectedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    if (-not [string]::Equals(
        "$($snapshot.Root)", $expectedRoot, [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'TransactionDir pertence a outro Root; journal de falha recusado.'
    }

    $invocation = $Failure.InvocationInfo
    $journal = [pscustomobject]@{
        schema = 'exped-install-service-failure-v1'
        capturedAt = (Get-Date).ToUniversalTime().ToString('o')
        root = $expectedRoot
        serviceName = $ServiceName
        message = Protect-ExpedDiagnosticText $Failure.Exception.Message
        fullyQualifiedErrorId = Protect-ExpedDiagnosticText $Failure.FullyQualifiedErrorId
        category = Protect-ExpedDiagnosticText $Failure.CategoryInfo.Category
        scriptStackTrace = Protect-ExpedDiagnosticText $Failure.ScriptStackTrace
        invocation = [pscustomobject]@{
            scriptName = Protect-ExpedDiagnosticText $invocation.ScriptName
            scriptLineNumber = [int]$invocation.ScriptLineNumber
            offsetInLine = [int]$invocation.OffsetInLine
            positionMessage = Protect-ExpedDiagnosticText $invocation.PositionMessage
        }
    }

    $journalPath = Join-Path $transactionPath 'install-service-failure.json'
    $tempPath = "$journalPath.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
    $replaceBackup = "$journalPath.$PID.$([Guid]::NewGuid().ToString('N')).bak"
    try {
        [System.IO.File]::WriteAllText(
            $tempPath,
            ($journal | ConvertTo-Json -Depth 8),
            (New-Object System.Text.UTF8Encoding $false)
        )
        $security = New-Object System.Security.AccessControl.FileSecurity
        $security.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)')
        Set-Acl -LiteralPath $tempPath -AclObject $security
        if (Test-Path -LiteralPath $journalPath) {
            [System.IO.File]::Replace($tempPath, $journalPath, $replaceBackup)
        } else {
            [System.IO.File]::Move($tempPath, $journalPath)
        }
    } finally {
        if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force }
        if (Test-Path -LiteralPath $replaceBackup) {
            Remove-Item -LiteralPath $replaceBackup -Force
        }
    }
}

function Invoke-NativeChecked($FilePath, $Arguments, $AllowedExitCodes = @(0)) {
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = @(& $FilePath @Arguments 2>&1 | ForEach-Object { "$_" })
        $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousEap }
    if ($AllowedExitCodes -notcontains $exitCode) {
        $safeArguments = Protect-ExpedNativeArgumentsForLog $Arguments
        $safeOutput = @($output | ForEach-Object {
            if ("$_" -match $script:SensitiveEnvNamePattern) { '***' } else { "$_" }
        }) -join ' '
        throw "$FilePath falhou ($exitCode): $safeArguments - $safeOutput"
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = ($output -join "`n") }
}

function Start-HubServiceAndWait([int]$TimeoutSeconds = 90) {
    $startResult = Invoke-NativeChecked -FilePath $Nssm `
        -Arguments @('start', $ServiceName) -AllowedExitCodes @(0, 1)
    $service = Get-Service -Name $ServiceName -ErrorAction Stop
    $pendingDeadline = (Get-Date).AddSeconds(5)
    do {
        $service.Refresh()
        if ($service.Status -in @(
            [System.ServiceProcess.ServiceControllerStatus]::StartPending,
            [System.ServiceProcess.ServiceControllerStatus]::Running
        )) { break }
        Start-Sleep -Milliseconds 100
    } while ((Get-Date) -lt $pendingDeadline)

    if ($startResult.ExitCode -ne 0 -and $service.Status -notin @(
        [System.ServiceProcess.ServiceControllerStatus]::StartPending,
        [System.ServiceProcess.ServiceControllerStatus]::Running
    )) {
        $startOutput = "$($startResult.Output)".Replace(([char]0).ToString(), '')
        throw "NSSM nao iniciou $ServiceName. Estado=$($service.Status). $startOutput"
    }

    if ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running) {
        try {
            $service.WaitForStatus(
                [System.ServiceProcess.ServiceControllerStatus]::Running,
                [TimeSpan]::FromSeconds($TimeoutSeconds)
            )
        } catch {
            $service.Refresh()
            throw "$ServiceName nao ficou Running em ${TimeoutSeconds}s. Estado=$($service.Status). $($_.Exception.Message)"
        }
    }
    $service.Refresh()
    if ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running) {
        throw "$ServiceName terminou o start em estado inesperado: $($service.Status)"
    }
}

function Ensure-AgentSection($Config, [int]$Port) {
    if (-not $Config.agent) {
        $Config | Add-Member -NotePropertyName agent -NotePropertyValue ([pscustomobject]@{ syncNowPort=$Port }) -Force
    }
    return $Config.agent
}

function Write-AgentUrlAclRollbackPlan([int]$PreviousPort, $PreviousSid, [int]$CurrentPort, $CurrentSid) {
    if (-not $TransactionDir) { return }
    $transactionPath = [System.IO.Path]::GetFullPath($TransactionDir)
    $statePath = Join-Path $transactionPath 'hub-state.json'
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        throw 'TransactionDir nao contem snapshot do Hub para o plano de URL ACL.'
    }
    $snapshot = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    if (-not [string]::Equals(
        "$($snapshot.Root)", [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/'),
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'TransactionDir pertence a outro Root.'
    }
    $plan = [pscustomobject]@{
        Schema = 'exped-urlacl-rollback-v1'
        Previous = [pscustomobject]@{ Port = $PreviousPort; Sid = "$PreviousSid" }
        Current = [pscustomobject]@{ Port = $CurrentPort; Sid = "$CurrentSid" }
    }
    Write-ExpedJsonAtomically (Join-Path $transactionPath 'urlacl-rollback.json') $plan
}

function Invoke-AgentSyncContract($Arguments, $FailureMessage) {
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = @(& $NodeExe $AgentSyncContract @Arguments 2>&1 | ForEach-Object { "$_" })
        $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousEap }
    if ($exitCode -ne 0) { throw "$FailureMessage $($output -join ' ')" }
    if ($output.Count -eq 0) { return $null }
    try { return (($output -join "`n") | ConvertFrom-Json) }
    catch { throw "$FailureMessage Resposta JSON invalida: $($_.Exception.Message)" }
}

function Import-AgentReceipt($Config, $ReceiptId, [int]$Port) {
    if ($ReceiptId -notmatch '^[A-Za-z0-9_-]{16,80}$') { throw 'AgentReceiptId invalido.' }
    $matches = @()
    $users = [Microsoft.Win32.Registry]::Users
    foreach ($sid in $users.GetSubKeyNames()) {
        if (-not (Test-ExpedUserSid $sid)) { continue }
        $relativePath = "$sid\Software\Exped\InstallReceipts\$ReceiptId"
        $key = $users.OpenSubKey($relativePath, $true)
        if ($null -eq $key) { continue }
        try {
            $matches += [pscustomobject]@{
                HiveSid = $sid
                UserSid = "$($key.GetValue('UserSid', ''))"
                SettingsPath = "$($key.GetValue('SettingsPath', ''))"
                RegistryPath = $relativePath
            }
        } finally { $key.Close() }
    }
    if ($matches.Count -ne 1) { throw "Recibo do usuario original nao encontrado de forma unica: $ReceiptId" }
    $receipt = $matches[0]
    if ($receipt.UserSid -ne $receipt.HiveSid -or -not (Test-ExpedUserSid $receipt.UserSid)) {
        throw 'Recibo do agente com SID inconsistente.'
    }
    if (-not (Test-Path -LiteralPath $receipt.SettingsPath)) {
        throw "Recibo aponta para appsettings.json ausente: $($receipt.SettingsPath)"
    }

    $agent = Ensure-AgentSection $Config $Port
    $existingSettingsPath = if ($agent.settingsPath) {
        [System.IO.Path]::GetFullPath("$($agent.settingsPath)")
    } else { '-' }
    $existingUserSid = if ($agent.userSid) { "$($agent.userSid)" } else { '-' }
    $existingSettingsOwnerSid = '-'
    if ($existingSettingsPath -ne '-' -and $existingUserSid -eq '-') {
        try { $existingSettingsOwnerSid = Get-ExpedFileOwnerSid $existingSettingsPath }
        catch {
            throw "Recibo rejeitado: config legado sem userSid exige owner SID verificavel em $existingSettingsPath. Desinstale o agente anterior ou migre explicitamente. $($_.Exception.Message)"
        }
    }
    $receiptSettingsPath = [System.IO.Path]::GetFullPath($receipt.SettingsPath)
    $null = Assert-ExpedInteractiveUserSid $receipt.UserSid $receiptSettingsPath
    $transition = Invoke-AgentSyncContract `
        -Arguments @('receipt-transition', $existingSettingsPath, $existingUserSid, $existingSettingsOwnerSid, $receiptSettingsPath, $receipt.UserSid) `
        -FailureMessage 'Recibo rejeitado. Desinstale o agente anterior ou migre explicitamente antes de reinstalar.'
    $agent | Add-Member -NotePropertyName settingsPath -NotePropertyValue $transition.settingsPath -Force
    $agent | Add-Member -NotePropertyName userSid -NotePropertyValue $transition.userSid -Force
    return $receipt
}

function Invoke-NetshQuery($Arguments) {
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $lines = @(& netsh.exe @Arguments 2>&1 | ForEach-Object { "$_" })
        $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousEap }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = ($lines -join "`n") }
}

function Invoke-NetshCommand($Arguments) {
    $result = Invoke-NetshQuery -Arguments $Arguments
    if ($result.ExitCode -ne 0) {
        throw "netsh.exe falhou ($($result.ExitCode)): $($Arguments -join ' ') - $($result.Output)"
    }
}

function Get-UrlAclSddlFromOutput($Output) {
    foreach ($line in ("$Output" -split "`r?`n")) {
        $index = $line.IndexOf('D:(', [System.StringComparison]::OrdinalIgnoreCase)
        if ($index -ge 0) { return $line.Substring($index).Trim() }
    }
    return $null
}

function Get-AgentUrlAclPlan([int]$PreviousPort, $PreviousUserSid, [int]$DesiredPort, $UserSid) {
    $previousSidArg = if ($PreviousUserSid) { "$PreviousUserSid" } else { '-' }
    $userSidArg = if ($UserSid) { "$UserSid" } else { '-' }
    $plan = Invoke-AgentSyncContract `
        -Arguments @('urlacl-plan', "$PreviousPort", $previousSidArg, "$DesiredPort", $userSidArg) `
        -FailureMessage 'Falha ao planejar URL ACL:'
    if ($null -eq $plan) { return }
    return @($plan)
}

function Invoke-AgentUrlAclStep($Step) {
    if ($Step.action -in @('add', 'ensure')) {
        $query = Invoke-NetshQuery -Arguments @($Step.showArgs)
        if ($query.ExitCode -notin @(0, 1)) {
            throw "Falha ao consultar URL ACL ($($query.ExitCode)): $($query.Output)"
        }
        $actualSddl = Get-UrlAclSddlFromOutput $query.Output
        if ($actualSddl) {
            if (-not [string]::Equals($actualSddl, "$($Step.expectedSddl)", [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "URL ACL ocupada por SDDL diferente. Atual=$actualSddl Esperado=$($Step.expectedSddl)"
            }
            return
        }
        $addArguments = if ($Step.action -eq 'ensure') { @($Step.addArgs) } else { @($Step.args) }
        try {
            Invoke-NetshCommand -Arguments $addArguments
        } catch {
            $addFailure = $_.Exception.Message
            if (-not ($Step.PSObject.Properties.Name -contains 'rollbackArgs')) { throw }

            # A troca de SID na mesma URL exige delete+add. Se o add falhar,
            # restaure o descritor anterior, sem sobrescrever uma reserva de terceiro.
            $afterFailure = Invoke-NetshQuery -Arguments @($Step.showArgs)
            if ($afterFailure.ExitCode -notin @(0, 1)) {
                throw "Falha ao verificar URL ACL apos erro ($($afterFailure.ExitCode)): $($afterFailure.Output)"
            }
            $afterFailureSddl = Get-UrlAclSddlFromOutput $afterFailure.Output
            if ([string]::Equals($afterFailureSddl, "$($Step.expectedSddl)", [System.StringComparison]::OrdinalIgnoreCase)) {
                return
            }
            if ($afterFailureSddl -and -not [string]::Equals(
                $afterFailureSddl, "$($Step.rollbackExpectedSddl)", [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Falha ao trocar URL ACL e rollback recusado: a URL passou a pertencer a outro SDDL. Atual=$afterFailureSddl. Erro original=$addFailure"
            }

            $rollbackFailure = $null
            if (-not $afterFailureSddl) {
                try { Invoke-NetshCommand -Arguments @($Step.rollbackArgs) }
                catch { $rollbackFailure = $_.Exception.Message }
            }

            $afterRollback = Invoke-NetshQuery -Arguments @($Step.showArgs)
            if ($afterRollback.ExitCode -notin @(0, 1)) {
                throw "Falha ao verificar rollback da URL ACL ($($afterRollback.ExitCode)): $($afterRollback.Output)"
            }
            $afterRollbackSddl = Get-UrlAclSddlFromOutput $afterRollback.Output
            if ([string]::Equals($afterRollbackSddl, "$($Step.expectedSddl)", [System.StringComparison]::OrdinalIgnoreCase)) {
                return
            }
            if ([string]::Equals($afterRollbackSddl, "$($Step.rollbackExpectedSddl)", [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Falha ao trocar URL ACL; o SDDL anterior foi restaurado. Erro original=$addFailure"
            }
            throw "Falha ao trocar URL ACL e o rollback nao restaurou o SDDL anterior. Atual=$afterRollbackSddl. Erro original=$addFailure. Erro rollback=$rollbackFailure"
        }
        return
    }

    if ($Step.action -eq 'delete') {
        $query = Invoke-NetshQuery -Arguments @($Step.showArgs)
        if ($query.ExitCode -notin @(0, 1)) {
            throw "Falha ao consultar URL ACL para delete ($($query.ExitCode)): $($query.Output)"
        }
        $actualSddl = Get-UrlAclSddlFromOutput $query.Output
        if (-not $actualSddl) { return }
        if (-not [string]::Equals($actualSddl, "$($Step.expectedSddl)", [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "URL ACL nao removida: SDDL atual nao pertence ao Exped. Atual=$actualSddl Esperado=$($Step.expectedSddl)"
        }
        Invoke-NetshCommand -Arguments @($Step.args)
        return
    }

    throw "Acao de URL ACL desconhecida: $($Step.action)"
}

function Set-AgentUrlAclTracking($Config, [int]$DesiredPort, $UserSid) {
    $agent = Ensure-AgentSection $Config $DesiredPort
    $agent | Add-Member -NotePropertyName urlAclPort -NotePropertyValue $DesiredPort -Force
    $trackedSid = if ($DesiredPort -gt 0) { "$UserSid" } else { $null }
    $agent | Add-Member -NotePropertyName urlAclUserSid -NotePropertyValue $trackedSid -Force
}

function Set-NssmServiceEnvironment($EnvironmentMap) {
    $registryPath = "SYSTEM\CurrentControlSet\Services\$ServiceName\Parameters"
    $key = [Microsoft.Win32.Registry]::LocalMachine.CreateSubKey(
        $registryPath,
        [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree
    )
    if ($null -eq $key) { throw "Nao foi possivel abrir o registro protegido do servico $ServiceName." }
    try {
        # Service registry keys are commonly readable by non-admin users. Lock
        # Parameters before writing the token-bearing REG_MULTI_SZ value.
        $security = New-Object System.Security.AccessControl.RegistrySecurity
        # Preserve owner/group: the existing CreateSubKey handle can change the
        # DACL, but does not request WRITE_OWNER on an already registered service.
        $security.SetSecurityDescriptorSddlForm(
            'D:P(A;CI;KA;;;SY)(A;CI;KA;;;BA)',
            [System.Security.AccessControl.AccessControlSections]::Access
        )
        $key.SetAccessControl($security)
        # NSSM 2.24 le este REG_DWORD, mas algumas builds estaveis nao o
        # aceitam pela CLI `nssm set`. Grave o contrato direto no registro.
        $key.SetValue(
            'AppKillProcessTree',
            [int]0,
            [Microsoft.Win32.RegistryValueKind]::DWord
        )
        $environmentLines = [string[]]@(
            $EnvironmentMap.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }
        )
        $key.SetValue(
            'AppEnvironmentExtra',
            $environmentLines,
            [Microsoft.Win32.RegistryValueKind]::MultiString
        )
        $key.Flush()
    } finally { $key.Dispose() }
}

# ---------------------------------------------------------------------------
# 0. Pre-condicoes
# ---------------------------------------------------------------------------
foreach ($p in @($Nssm, $NodeExe, $Maestro, $AgentSettingsHelper)) {
    if (-not (Test-Path $p)) { throw "Arquivo obrigatorio ausente: $p (rode download-binaries.ps1 e confira o pacote do hub)." }
}
if ($ManageAgentEnabled -and -not (Test-Path -LiteralPath $AgentSyncContract)) {
    throw "Arquivo obrigatorio do agente ausente: $AgentSyncContract"
}
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
. $AgentSettingsHelper

$hubSnapshot = if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
    New-ExpedFileSnapshot $ConfigPath
} else { $null }
$agentSnapshot = $null
$aclRollbackPlan = @()
$agentSyncNowPort = 0
$agentStartupMode = 'disabled'

try {

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
# certDir: onde o frontdoor le server.crt/server.key (gerados pelo mkcert abaixo).
$envMap['EXPED_CERT_DIR'] = $CertDir

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
    if ($cfg.version)     { $envMap['EXPED_VERSION']      = "$($cfg.version)" }
    if ($cfg.cloud) {
        if ($cfg.cloud.apiBase)       { $envMap['EXPED_CLOUD_API']          = "$($cfg.cloud.apiBase)" }
        if ($cfg.cloud.deviceToken)   { $envMap['EXPED_DEVICE_TOKEN']       = "$($cfg.cloud.deviceToken)" }
        if ($cfg.cloud.syncIntervalMs){ $envMap['EXPED_SYNC_INTERVAL_MS']   = "$($cfg.cloud.syncIntervalMs)" }
    }
    $agentSyncNowPort = Get-ExpedAgentSyncNowPort $cfg

    if ($ManageAgentEnabled) {
        if ($AgentReceiptId) { $null = Import-AgentReceipt $cfg $AgentReceiptId $agentSyncNowPort }

        $agent = Ensure-AgentSection $cfg $agentSyncNowPort
        $agent | Add-Member -NotePropertyName startupMode -NotePropertyValue 'interactive_logon' -Force
        $agentSettingsPath = if ($agent.settingsPath) {
            [System.IO.Path]::GetFullPath("$($agent.settingsPath)")
        } else { $null }
        if ($agentSettingsPath -and -not (Test-Path -LiteralPath $agentSettingsPath)) {
            throw "agent.settingsPath aponta para arquivo ausente: $agentSettingsPath"
        }
        if ($AgentUserSid -and -not (Test-ExpedUserSid $AgentUserSid)) {
            throw '-AgentUserSid deve ser um SID Windows valido.'
        }
        if (-not $agentSettingsPath -and $AgentUserSid) {
            throw '-AgentUserSid exige um agent.settingsPath exato no config.json.'
        }
        if ($agentSettingsPath) {
            $persistedAgentSid = "$($agent.userSid)"
            if (Test-ExpedUserSid $persistedAgentSid) {
                if ($AgentUserSid -and $AgentUserSid -ne $persistedAgentSid) {
                    throw '-AgentUserSid diverge do agent.userSid ja persistido.'
                }
            } else {
                try {
                    $resolvedAgentSid = if ($AgentUserSid) {
                        $AgentUserSid
                    } else {
                        Get-ExpedFileOwnerSid $agentSettingsPath
                    }
                } catch {
                    throw "Nao foi possivel migrar agent.userSid pelo owner ACL de $agentSettingsPath. Informe -AgentUserSid S-1-... explicitamente. $($_.Exception.Message)"
                }
                $agent | Add-Member -NotePropertyName userSid -NotePropertyValue $resolvedAgentSid -Force
                Write-Host "    agent.userSid migrado de forma exata: $resolvedAgentSid"
            }
            $null = Assert-ExpedInteractiveUserSid "$($agent.userSid)" $agentSettingsPath
            $agentSnapshot = New-ExpedFileSnapshot $agentSettingsPath
        }

        $hasTrackedAclPort = $null -ne $agent.urlAclPort
        $previousAclPort = if ($hasTrackedAclPort) {
            [int]$agent.urlAclPort
        } elseif ($agentSettingsPath) {
            Get-ExpedInstalledAgentSyncNowPort $agentSettingsPath
        } else { 0 }
        $previousAclSid = if ($hasTrackedAclPort -and (Test-ExpedUserSid $agent.urlAclUserSid)) {
            "$($agent.urlAclUserSid)"
        } else {
            "$($agent.userSid)"
        }
        $aclPlan = @()
        $deferredAclDeletes = @()
        if ($agentSettingsPath -or $previousAclPort -gt 0) {
            if (-not $agentSettingsPath -and $agentSyncNowPort -gt 0) {
                throw 'URL ACL rastreada sem agent.settingsPath; nao e seguro reservar uma nova porta.'
            }
            if ($agentSyncNowPort -gt 0 -and -not (Test-ExpedUserSid $agent.userSid)) {
                throw 'agent.userSid ausente/invalido; nao e seguro reservar URL ACL por SID.'
            }
            $aclPlan = @(Get-AgentUrlAclPlan $previousAclPort $previousAclSid $agentSyncNowPort "$($agent.userSid)")
            $aclRollbackPlan = @(
                Get-AgentUrlAclPlan $agentSyncNowPort "$($agent.userSid)" $previousAclPort $previousAclSid
            )
            Write-AgentUrlAclRollbackPlan $previousAclPort $previousAclSid `
                $agentSyncNowPort "$($agent.userSid)"
            foreach ($step in $aclPlan) {
                # Em move/disable, mantenha a reserva antiga ate o appsettings atomico
                # ser observado pelo agente. Troca de SID na mesma porta e feita antes.
                if ($step.action -eq 'delete' -and $previousAclPort -ne $agentSyncNowPort) {
                    $deferredAclDeletes += $step
                } else {
                    Invoke-AgentUrlAclStep $step
                }
            }
        }

        if ($agentSettingsPath) {
            Set-ExpedAgentSettings -SettingsPath $agentSettingsPath -SyncNowPort $agentSyncNowPort
            Write-Host "    ExpedAgent atualizado: $agentSettingsPath (SyncNowPort=$agentSyncNowPort)"
        }
        foreach ($step in $deferredAclDeletes) { Invoke-AgentUrlAclStep $step }
        if ($agentSettingsPath -or $previousAclPort -gt 0) {
            Set-AgentUrlAclTracking $cfg $agentSyncNowPort "$($agent.userSid)"
        }
        Write-ExpedJsonAtomically $ConfigPath $cfg
    }

    # Hub-only upgrades still need to preserve the interactive identity used by
    # Trusted_Connection. Migrate legacy configs from the settings owner (or a
    # previously tracked SID) instead of silently hiding the Sync button.
    $legacyAgentSettingsPath = if ($cfg.agent -and $cfg.agent.settingsPath) {
        [System.IO.Path]::GetFullPath("$($cfg.agent.settingsPath)")
    } else { $null }
    if (-not $legacyAgentSettingsPath -and $cfg.agent) {
        $legacyTrackedSid = if (Test-ExpedUserSid "$($cfg.agent.userSid)") {
            "$($cfg.agent.userSid)"
        } elseif (Test-ExpedUserSid "$($cfg.agent.urlAclUserSid)") {
            "$($cfg.agent.urlAclUserSid)"
        } else { $null }
        if ($legacyTrackedSid) {
            $legacyProfile = Assert-ExpedInteractiveUserSid $legacyTrackedSid
            $candidate = Join-Path $legacyProfile 'AppData\Local\ExpedAgent\appsettings.json'
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                $legacyAgentSettingsPath = [System.IO.Path]::GetFullPath($candidate)
                $agent = Ensure-AgentSection $cfg $agentSyncNowPort
                $agent | Add-Member -NotePropertyName settingsPath `
                    -NotePropertyValue $legacyAgentSettingsPath -Force
            }
        }
    }
    if ($legacyAgentSettingsPath) {
        if (-not (Test-Path -LiteralPath $legacyAgentSettingsPath -PathType Leaf)) {
            throw "agent.settingsPath legado aponta para arquivo ausente: $legacyAgentSettingsPath"
        }
        if (-not (Test-ExpedUserSid "$($cfg.agent.userSid)")) {
            try {
                $legacyAgentUserSid = Get-ExpedFileOwnerSid $legacyAgentSettingsPath
                $null = Assert-ExpedInteractiveUserSid $legacyAgentUserSid $legacyAgentSettingsPath
            } catch {
                throw "Nao foi possivel migrar a identidade Trusted_Connection do Agent legado. $($_.Exception.Message)"
            }
            $cfg.agent | Add-Member -NotePropertyName userSid `
                -NotePropertyValue $legacyAgentUserSid -Force
            Write-Host "    agent.userSid legado migrado pelo owner ACL: $legacyAgentUserSid"
        } else {
            $null = Assert-ExpedInteractiveUserSid "$($cfg.agent.userSid)" $legacyAgentSettingsPath
        }
    }

    $agentHasExactProfile = (
        $cfg.agent -and
        $cfg.agent.settingsPath -and
        (Test-ExpedUserSid "$($cfg.agent.userSid)")
    )
    if ($cfg.agent -and $cfg.agent.startupMode) {
        $agentStartupMode = "$($cfg.agent.startupMode)"
    } elseif ($agentHasExactProfile) {
        $agentStartupMode = 'interactive_logon'
    }
    if ($agentStartupMode -notin @('interactive_logon', 'disabled')) {
        throw "agent.startupMode=$agentStartupMode recusado: windows_service nao preserva a identidade Trusted_Connection comprovada."
    }
    if (-not $agentHasExactProfile -and $agentStartupMode -eq 'interactive_logon') {
        throw 'Agent configurado para interactive_logon sem perfil exato; nao e seguro perder a identidade Trusted_Connection.'
    }
    $agentWasRequested = (
        $cfg.agent -and
        (($cfg.agent.PSObject.Properties.Name -contains 'syncNowPort') -and $agentSyncNowPort -gt 0)
    )
    $agentExplicitlyDisabled = (
        $cfg.agent -and "$($cfg.agent.startupMode)" -eq 'disabled'
    )
    if (-not $agentHasExactProfile -and $agentWasRequested -and -not $agentExplicitlyDisabled) {
        throw 'Sync do Agent foi solicitado sem perfil exato da identidade Trusted_Connection.'
    }

    $agent = Ensure-AgentSection $cfg $agentSyncNowPort
    $agent | Add-Member -NotePropertyName startupMode -NotePropertyValue $agentStartupMode -Force
    $agent | Add-Member -NotePropertyName survivesRebootWithoutLogon -NotePropertyValue $false -Force
    if (-not $agent.healthPath) {
        $agent | Add-Member -NotePropertyName healthPath `
            -NotePropertyValue (Join-Path $env:ProgramData 'ExpedAgent\health.json') -Force
    }
    if (-not $agent.healthMaxAgeMs) {
        $agent | Add-Member -NotePropertyName healthMaxAgeMs -NotePropertyValue 90000 -Force
    }
    Write-ExpedJsonAtomically $ConfigPath $cfg

    $operationalUserSid = if ($cfg.agent -and (Test-ExpedUserSid $cfg.agent.userSid)) {
        "$($cfg.agent.userSid)"
    } else { '' }
    Protect-ExpedConfigAcl $ConfigPath $operationalUserSid
} else {
    Write-Host "    AVISO: $ConfigPath nao encontrado - usando defaults do hub/config.mjs (so PATH/EXPED_PG_BIN serao setados)." -ForegroundColor Yellow
}
$effectiveAgentSyncPort = if ($agentStartupMode -eq 'disabled') { 0 } else { $agentSyncNowPort }
$envMap['EXPED_AGENT_SYNC_PORT'] = "$effectiveAgentSyncPort"
$envMap['EXPED_AGENT_STARTUP_MODE'] = $agentStartupMode
$envMap['EXPED_AGENT_SURVIVES_REBOOT_WITHOUT_LOGON'] = 'false'
if ($cfg -and $cfg.agent) {
    $envMap['EXPED_AGENT_HEALTH_PATH'] = "$($cfg.agent.healthPath)"
    $envMap['EXPED_AGENT_HEALTH_MAX_AGE_MS'] = "$($cfg.agent.healthMaxAgeMs)"
}

# Ports usadas no firewall (default do config.mjs: app 3000, gateway 54320).
$appPort     = if ($envMap['EXPED_APP_PORT'])     { $envMap['EXPED_APP_PORT'] }     else { '3000' }
$gatewayPort = if ($envMap['EXPED_GATEWAY_PORT']) { $envMap['EXPED_GATEWAY_PORT'] } else { '54320' }

# ---------------------------------------------------------------------------
# 2. Criar/atualizar o servico com NSSM sem remover o registro existente
# ---------------------------------------------------------------------------
$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (($null -ne $existingService) -ne $serviceExistedBefore) {
    throw 'O registro do servico mudou durante o install; abortando sem reclassificar ownership.'
}
if ($serviceExistedBefore -and
    $existingService.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Stopped) {
    Write-Step "Parando servico $ServiceName para atualizar"
    $null = Invoke-NativeChecked -FilePath $Nssm -Arguments @('stop', $ServiceName)
    Start-Sleep -Seconds 2
}
if (-not $serviceExistedBefore) {
    Write-Step "Registrando servico $ServiceName"
    $null = Invoke-NativeChecked -FilePath $Nssm -Arguments @('install', $ServiceName, $NodeExe, $Maestro)
} else {
    Write-Step "Atualizando servico $ServiceName existente"
}

$nssmSettings = @(
    @('Application', $NodeExe),
    @('AppParameters', $Maestro),
    @('AppDirectory', $Root),
    @('DisplayName', 'Exped Hub (pilha local Supabase + app)'),
    @('Description', 'Orquestra Postgres + PostgREST + GoTrue + storage + gateway + app Next do Exped (offline/LAN).'),
    @('Start', 'SERVICE_DELAYED_AUTO_START'),
    @('AppStdout', (Join-Path $LogDir 'service-out.log')),
    @('AppStderr', (Join-Path $LogDir 'service-err.log')),
    @('AppRotateFiles', '1'),
    @('AppRotateBytes', '10485760'),
    @('AppStopMethodSkip', '0'),
    @('AppStopMethodConsole', '60000'),
    @('AppStopMethodWindow', '10000'),
    @('AppStopMethodThreads', '10000'),
    @('AppThrottle', '5000'),
    @('AppRestartDelay', '5000')
)
foreach ($setting in $nssmSettings) {
    $null = Invoke-NativeChecked -FilePath $Nssm `
        -Arguments @('set', $ServiceName, $setting[0], $setting[1])
}
$null = Invoke-NativeChecked -FilePath $Nssm `
    -Arguments @('set', $ServiceName, 'AppExit', 'Default', 'Restart')
$null = Invoke-NativeChecked -FilePath 'sc.exe' -Arguments @(
    'failure', $ServiceName, 'reset=', '86400',
    'actions=', 'restart/10000/restart/30000/restart/60000'
)
$null = Invoke-NativeChecked -FilePath 'sc.exe' `
    -Arguments @('failureflag', $ServiceName, '1')

# O token nunca cruza a command line do nssm. NSSM le AppEnvironmentExtra como
# REG_MULTI_SZ quando inicia; a chave e gravada diretamente sob ACL SY/BA.
Set-NssmServiceEnvironment $envMap
Write-Host "    Env do servico:"
$envMap.GetEnumerator() | ForEach-Object {
    $shown = Protect-ExpedEnvValueForLog $_.Key $_.Value
    Write-Host "      $($_.Key)=$shown"
}

# ---------------------------------------------------------------------------
# 3. Firewall - expor somente o porteiro para a sub-rede confiavel
# ---------------------------------------------------------------------------
# app e gateway permanecem em 127.0.0.1. A regra persistente aceita apenas
# Domain/Private e origem LocalSubnet; Public nunca e habilitado.
Write-Step 'Configurando firewall (HTTPS 443, LocalSubnet, Domain/Private)'
Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction Stop |
    Where-Object { $_.Name -eq 'ExpedHub' -or $_.DisplayName -eq 'ExpedHub' } |
    Remove-NetFirewallRule -ErrorAction Stop
$null = New-NetFirewallRule -Name 'ExpedHub' -DisplayName 'ExpedHub' `
    -Direction Inbound -Action Allow -Enabled True -Protocol TCP -LocalPort 443 `
    -RemoteAddress LocalSubnet -Profile Domain,Private -PolicyStore PersistentStore

# ---------------------------------------------------------------------------
# 4. HTTPS - CA local (mkcert) + cert do servidor (SAN com o IP da LAN)
# ---------------------------------------------------------------------------
# O porteiro (frontdoor) fala https com este cert. A notificacao do navegador
# exige contexto seguro (https). Distribua C:\Exped\rootCA-Exped.crt pras maquinas.
New-Item -ItemType Directory -Force -Path $CertDir | Out-Null
if (Test-Path $Mkcert) {
    $ServerIp = Resolve-ExpedServerIp $cfg
    Write-Step "Gerando CA + cert HTTPS (mkcert) para $ServerIp"
    $previousCaroot = $env:CAROOT
    try {
        # A CA pertence ao payload transacional. O instalador nao altera o trust
        # store global; clientes importam rootCA-Exped.crt de forma explicita.
        $env:CAROOT = Join-Path $CertDir 'ca'
        $null = Invoke-NativeChecked -FilePath $Mkcert -Arguments @(
            '-cert-file', (Join-Path $CertDir 'server.crt'),
            '-key-file', (Join-Path $CertDir 'server.key'),
            $ServerIp, 'localhost', '127.0.0.1'
        )
        $caRoot = (Invoke-NativeChecked -FilePath $Mkcert -Arguments @('-CAROOT')).Output.Trim()
        Copy-Item (Join-Path $caRoot 'rootCA.pem') (Join-Path $Root 'rootCA-Exped.crt') -Force
    } finally {
        $env:CAROOT = $previousCaroot
    }
    $certSecurity = New-Object System.Security.AccessControl.DirectorySecurity
    $certSecurity.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
    Set-Acl -LiteralPath $CertDir -AclObject $certSecurity
    Write-Host "    HTTPS pronto. Instale $Root\rootCA-Exped.crt nas maquinas (Autoridade Raiz Confiavel)." -ForegroundColor Green
} else {
    throw 'bin\mkcert.exe ausente; o instalador nao pode comprovar HTTPS da LAN.'
}

# ---------------------------------------------------------------------------
# 4. Iniciar o servico
# ---------------------------------------------------------------------------
Write-Step "Iniciando servico $ServiceName"
Start-HubServiceAndWait 90
Wait-ExpedHttpsReady $ServerIp (Join-Path $CertDir 'server.crt') 90

Write-Host ""
Write-Step "Concluido."
Write-Host "    Verifique:  sc query $ServiceName   (deve estar RUNNING)"
Write-Host "    Logs:       $LogDir  (service-out.log, service-err.log, maestro.log e por-peca)"
Write-Host "    /status:    http://127.0.0.1:$([int]$appPort + 1)/status"
} catch {
    $failure = $_
    try { Write-InstallFailureJournal $failure }
    catch { Write-Warning "Journal da falha do install-service nao foi gravado: $($_.Exception.Message)" }
    foreach ($step in $aclRollbackPlan) {
        try { Invoke-AgentUrlAclStep $step }
        catch { Write-Warning "Rollback de URL ACL falhou: $($_.Exception.Message)" }
    }
    try { Restore-ExpedFileSnapshot $agentSnapshot }
    catch { Write-Warning "Rollback do appsettings.json falhou: $($_.Exception.Message)" }
    try { Restore-ExpedFileSnapshot $hubSnapshot }
    catch { Write-Warning "Rollback do config.json falhou: $($_.Exception.Message)" }

    if ($TransactionDir) {
        Write-Warning 'Servico permanece parado para o rollback externo exato do ExpedSetup.'
    } elseif ($serviceExistedBefore -and $serviceWasRunningBefore) {
        try { Start-HubServiceAndWait 90 }
        catch { Write-Warning "Restauracao do servico falhou: $($_.Exception.Message)" }
    } elseif (-not $serviceExistedBefore) {
        try {
            $current = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
            if ($current) {
                if ($current.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Stopped) {
                    $null = Invoke-NativeChecked -FilePath $Nssm -Arguments @('stop', $ServiceName)
                }
                $null = Invoke-NativeChecked -FilePath $Nssm -Arguments @('remove', $ServiceName, 'confirm')
            }
        } catch { Write-Warning "Rollback do registro do servico falhou: $($_.Exception.Message)" }
    }
    throw $failure
}
