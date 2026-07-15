# Runs only through Inno Setup's runasoriginaluser boundary.
[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$Start,
    [switch]$Uninstall,
    [switch]$Rollback,
    [switch]$Finalize,
    [string]$Root = 'C:\Exped',
    [string]$StageDir = 'C:\Exped\agent-stage',
    [string]$ReceiptId = '',
    [string]$ExpectedUserSid = '',
    [string]$ExpectedSettingsPath = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'agent-settings.ps1')

function Get-VerifiedInteractiveUserSid {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $currentSid = $identity.User.Value
    $sessionId = (Get-Process -Id $PID).SessionId
    $shellSids = @(
        Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" |
            Where-Object { $_.SessionId -eq $sessionId } |
            ForEach-Object { (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid } |
            Where-Object { $_ } |
            Sort-Object -Unique
    )
    if ($shellSids.Count -ne 1 -or $shellSids[0] -ne $currentSid) {
        throw 'Nao foi possivel provar o usuario interativo original. Feche e abra o instalador com duplo clique, sem Executar como administrador.'
    }
    return $currentSid
}

function Get-ThisUserAgentProcesses($AgentExe) {
    return @(
        Get-Process -Name 'ExpedAgent' -ErrorAction SilentlyContinue | Where-Object {
            try { [System.IO.Path]::GetFullPath($_.MainModule.FileName) -ieq $AgentExe } catch { $false }
        }
    )
}

function Test-ExpedAgentHttpReady([int]$Port) {
    $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/sync-now")
    $request.Method = 'GET'
    $request.Timeout = 2000
    $request.ReadWriteTimeout = 2000
    $request.AllowAutoRedirect = $false
    $request.Proxy = $null
    $response = $null
    try {
        try {
            $response = [System.Net.HttpWebResponse]$request.GetResponse()
        } catch [System.Net.WebException] {
            if ($null -eq $_.Exception.Response) { return $false }
            $response = [System.Net.HttpWebResponse]$_.Exception.Response
        }
        # The Agent has no separate health route. An empty sync request is
        # side-effect free and has a stable 400 JSON contract once ready.
        if ($response.StatusCode -ne [System.Net.HttpStatusCode]::BadRequest) { return $false }
        $reader = New-Object System.IO.StreamReader ($response.GetResponseStream())
        try { $body = $reader.ReadToEnd() | ConvertFrom-Json }
        finally { $reader.Dispose() }
        $properties = @($body.PSObject.Properties.Name)
        return (
            $properties -contains 'success' -and
            $properties -contains 'synced' -and
            $properties -contains 'error' -and
            [bool]$body.success -eq $false
        )
    } catch {
        return $false
    } finally {
        if ($response) { $response.Dispose() }
    }
}

function Wait-ExpedAgentReady($AgentExe, $SettingsPath, [int]$TimeoutSeconds = 30) {
    $syncNowPort = Get-ExpedInstalledAgentSyncNowPort $SettingsPath
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $stableProcessSince = $null
    do {
        $processes = @(Get-ThisUserAgentProcesses $AgentExe)
        if ($processes.Count -gt 0) {
            if ($syncNowPort -eq 0) {
                if ($null -eq $stableProcessSince) { $stableProcessSince = Get-Date }
                if (((Get-Date) - $stableProcessSince).TotalSeconds -ge 2) { return }
            } elseif (Test-ExpedAgentHttpReady $syncNowPort) {
                return
            }
        } else {
            $stableProcessSince = $null
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)

    throw "Timeout de $TimeoutSeconds s aguardando processo/health do ExpedAgent."
}

function Assert-AgentReceiptTransition($HubConfig, $SettingsPath, $UserSid) {
    $nodeExe = Join-Path $Root 'bin\node.exe'
    $contractPath = Join-Path $Root 'hub\win\agent-sync-contract.mjs'
    foreach ($required in @($nodeExe, $contractPath)) {
        if (-not (Test-Path -LiteralPath $required)) { throw "Preflight do agente ausente: $required" }
    }

    $existingSettingsPath = if ($HubConfig.agent -and $HubConfig.agent.settingsPath) {
        [System.IO.Path]::GetFullPath("$($HubConfig.agent.settingsPath)")
    } else { '-' }
    $existingUserSid = if ($HubConfig.agent -and $HubConfig.agent.userSid) {
        "$($HubConfig.agent.userSid)"
    } else { '-' }
    $existingSettingsOwnerSid = '-'
    if ($existingSettingsPath -ne '-' -and $existingUserSid -eq '-') {
        try { $existingSettingsOwnerSid = Get-ExpedFileOwnerSid $existingSettingsPath }
        catch {
            throw "Config legado sem userSid exige owner SID verificavel em $existingSettingsPath. Desinstale o agente anterior ou migre explicitamente. $($_.Exception.Message)"
        }
    }

    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = @(& $nodeExe $contractPath 'receipt-transition' `
            $existingSettingsPath $existingUserSid $existingSettingsOwnerSid `
            ([System.IO.Path]::GetFullPath($SettingsPath)) $UserSid 2>&1 | ForEach-Object { "$_" })
        $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousEap }
    if ($exitCode -ne 0) {
        throw "Reinstalacao rejeitada antes de alterar o perfil. Desinstale o agente anterior ou migre explicitamente. $($output -join ' ')"
    }
    try { $transition = (($output -join "`n") | ConvertFrom-Json) }
    catch { throw "Resposta invalida do preflight do agente: $($_.Exception.Message)" }
    if (
        -not [string]::Equals("$($transition.settingsPath)", [System.IO.Path]::GetFullPath($SettingsPath), [System.StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals("$($transition.userSid)", $UserSid, [System.StringComparison]::OrdinalIgnoreCase)
    ) {
        throw 'Preflight do agente retornou identidade/caminho inesperados.'
    }
}

function Get-AgentTransactionDir($Id) {
    return Join-Path (Join-Path $env:LOCALAPPDATA 'Exped\InstallTransactions') $Id
}

function Get-AgentFileDigest($Path) {
    $stream = $null
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::Open(
            $Path,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read
        )
        $hash = $sha.ComputeHash($stream)
        return [pscustomobject]@{
            Length = $stream.Length
            Sha256 = (($hash | ForEach-Object { $_.ToString('x2') }) -join '')
        }
    } finally {
        if ($stream) { $stream.Dispose() }
        $sha.Dispose()
    }
}

function Get-AgentTreeManifest($BasePath) {
    $base = [System.IO.Path]::GetFullPath($BasePath).TrimEnd('\', '/')
    $prefix = $base + [System.IO.Path]::DirectorySeparatorChar
    $manifest = @()
    foreach ($item in @(Get-ChildItem -LiteralPath $base -Force -Recurse | Sort-Object FullName)) {
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Backup do agente recusou reparse point: $($item.FullName)"
        }
        $fullPath = [System.IO.Path]::GetFullPath($item.FullName)
        if (-not $fullPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Item do agente escapou da raiz protegida: $fullPath"
        }
        $entry = [ordered]@{
            RelativePath = $fullPath.Substring($prefix.Length)
            Kind = if ($item.PSIsContainer) { 'Directory' } else { 'File' }
            Length = 0
            Sha256 = ''
        }
        if (-not $item.PSIsContainer) {
            $digest = Get-AgentFileDigest $fullPath
            $entry.Length = $digest.Length
            $entry.Sha256 = $digest.Sha256
        }
        $manifest += [pscustomobject]$entry
    }
    return $manifest
}

function Assert-AgentTreeMatchesManifest($BasePath, $Manifest) {
    if (-not (Test-Path -LiteralPath $BasePath -PathType Container)) {
        throw "BackupAgentDir ausente: $BasePath"
    }
    $actual = @(Get-AgentTreeManifest $BasePath)
    $expected = @($Manifest)
    if ($actual.Count -ne $expected.Count) {
        throw 'BackupAgentDir diverge do manifesto em quantidade de itens.'
    }
    for ($i = 0; $i -lt $expected.Count; $i++) {
        foreach ($property in @('RelativePath', 'Kind', 'Length', 'Sha256')) {
            if (-not [string]::Equals(
                "$($actual[$i].$property)", "$($expected[$i].$property)",
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
                throw "BackupAgentDir diverge do manifesto em $($expected[$i].RelativePath): $property"
            }
        }
    }
}

function Assert-AgentFileBackup($Path, $ExpectedLength, $ExpectedSha256, $Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label ausente." }
    $digest = Get-AgentFileDigest $Path
    if ([long]$ExpectedLength -ne [long]$digest.Length -or -not [string]::Equals(
        "$ExpectedSha256", "$($digest.Sha256)", [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw "$Label diverge do manifesto transacional."
    }
}

function Assert-AgentTransactionRestorable($Transaction) {
    $state = $Transaction.State
    $manifestPath = Join-Path $Transaction.Dir 'backup-manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw 'backup-manifest.json ausente.'
    }
    $manifestDocument = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    $manifest = @($manifestDocument.Entries)
    if ($state.AgentDirExisted) {
        Assert-AgentTreeMatchesManifest (Join-Path $Transaction.Dir 'BackupAgentDir') $manifest
    } elseif ($manifest.Count -ne 0) {
        throw 'Manifesto do agente deveria estar vazio para instalacao anterior ausente.'
    }
    if ($state.SettingsExisted) {
        Assert-AgentFileBackup (Join-Path $Transaction.Dir 'BackupSettings') `
            $state.SettingsBackupLength $state.SettingsBackupSha256 'BackupSettings'
    }
    if ($state.StartupExisted) {
        Assert-AgentFileBackup (Join-Path $Transaction.Dir 'BackupStartup') `
            $state.StartupBackupLength $state.StartupBackupSha256 'BackupStartup'
    }
}

function New-AgentTransaction($Id, $UserSid, $AgentDir, $SettingsPath, $StartupVbs, $AgentExe) {
    $transactionDir = Get-AgentTransactionDir $Id
    if (Test-Path -LiteralPath $transactionDir) {
        throw "Transacao do agente ja existe: $Id"
    }
    try {
        New-Item -ItemType Directory -Force -Path $transactionDir | Out-Null
        $agentDirExisted = Test-Path -LiteralPath $AgentDir -PathType Container
        $settingsExisted = Test-Path -LiteralPath $SettingsPath -PathType Leaf
        $startupExisted = Test-Path -LiteralPath $StartupVbs -PathType Leaf
        $agentWasRunning = (Get-ThisUserAgentProcesses $AgentExe).Count -gt 0
        $agentManifest = @()
        if ($agentDirExisted) {
            $agentManifest = @(Get-AgentTreeManifest $AgentDir)
            $backupAgentDir = Join-Path $transactionDir 'BackupAgentDir'
            New-Item -ItemType Directory -Force -Path $backupAgentDir | Out-Null
            Get-ChildItem -LiteralPath $AgentDir -Force | ForEach-Object {
                Copy-Item -LiteralPath $_.FullName -Destination $backupAgentDir -Recurse -Force
            }
            Assert-AgentTreeMatchesManifest $backupAgentDir $agentManifest
        }
        Write-ExpedJsonAtomically (Join-Path $transactionDir 'backup-manifest.json') `
            ([pscustomobject]@{ Entries = @($agentManifest) })
        $settingsBackupLength = 0
        $settingsBackupSha256 = ''
        if ($settingsExisted) {
            $settingsBackup = Join-Path $transactionDir 'BackupSettings'
            [System.IO.File]::WriteAllBytes(
                $settingsBackup,
                [System.IO.File]::ReadAllBytes($SettingsPath)
            )
            $settingsDigest = Get-AgentFileDigest $settingsBackup
            $settingsBackupLength = $settingsDigest.Length
            $settingsBackupSha256 = $settingsDigest.Sha256
        }
        $startupBackupLength = 0
        $startupBackupSha256 = ''
        if ($startupExisted) {
            $startupBackup = Join-Path $transactionDir 'BackupStartup'
            [System.IO.File]::WriteAllBytes(
                $startupBackup,
                [System.IO.File]::ReadAllBytes($StartupVbs)
            )
            $startupDigest = Get-AgentFileDigest $startupBackup
            $startupBackupLength = $startupDigest.Length
            $startupBackupSha256 = $startupDigest.Sha256
        }
        $state = [pscustomobject]@{
            UserSid = $UserSid
            AgentDir = [System.IO.Path]::GetFullPath($AgentDir)
            SettingsPath = [System.IO.Path]::GetFullPath($SettingsPath)
            StartupVbs = [System.IO.Path]::GetFullPath($StartupVbs)
            AgentDirExisted = $agentDirExisted
            AgentWasRunning = $agentWasRunning
            SettingsExisted = $settingsExisted
            StartupExisted = $startupExisted
            SettingsBackupLength = $settingsBackupLength
            SettingsBackupSha256 = $settingsBackupSha256
            StartupBackupLength = $startupBackupLength
            StartupBackupSha256 = $startupBackupSha256
        }
        Write-ExpedJsonAtomically (Join-Path $transactionDir 'state.json') $state
        Assert-AgentTransactionRestorable ([pscustomobject]@{ Dir = $transactionDir; State = $state })
        return $transactionDir
    } catch {
        if (Test-Path -LiteralPath $transactionDir) {
            Remove-Item -LiteralPath $transactionDir -Recurse -Force -ErrorAction SilentlyContinue
        }
        throw
    }
}

function Get-AgentTransaction($Id) {
    $transactionDir = Get-AgentTransactionDir $Id
    $statePath = Join-Path $transactionDir 'state.json'
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return $null }
    return [pscustomobject]@{
        Dir = $transactionDir
        State = (Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json)
    }
}

function Restore-AgentTransaction($Id, $UserSid, $AgentExe) {
    $transaction = Get-AgentTransaction $Id
    $receiptKey = "HKCU:\Software\Exped\InstallReceipts\$Id"
    if ($null -eq $transaction) {
        if (Test-Path -LiteralPath $receiptKey) {
            throw "Receipt existe sem backup transacional: $Id"
        }
        return
    }
    $state = $transaction.State
    if (-not [string]::Equals("$($state.UserSid)", $UserSid, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'SID atual diverge do backup transacional do agente.'
    }

    Assert-AgentTransactionRestorable $transaction
    Get-ThisUserAgentProcesses $AgentExe | Stop-Process -Force
    Start-Sleep -Milliseconds 300
    if (Test-Path -LiteralPath $state.AgentDir) {
        Remove-Item -LiteralPath $state.AgentDir -Recurse -Force
    }
    if ($state.AgentDirExisted) {
        $backupAgentDir = Join-Path $transaction.Dir 'BackupAgentDir'
        if (-not (Test-Path -LiteralPath $backupAgentDir -PathType Container)) {
            throw 'BackupAgentDir ausente.'
        }
        New-Item -ItemType Directory -Force -Path $state.AgentDir | Out-Null
        Get-ChildItem -LiteralPath $backupAgentDir -Force | ForEach-Object {
            Copy-Item -LiteralPath $_.FullName -Destination $state.AgentDir -Recurse -Force
        }
        $manifestDocument = Get-Content -Raw -LiteralPath `
            (Join-Path $transaction.Dir 'backup-manifest.json') | ConvertFrom-Json
        $manifest = @($manifestDocument.Entries)
        Assert-AgentTreeMatchesManifest $state.AgentDir $manifest
    }

    if ($state.StartupExisted) {
        $backup = Join-Path $transaction.Dir 'BackupStartup'
        if (-not (Test-Path -LiteralPath $backup)) { throw 'BackupStartup ausente.' }
        Write-ExpedBytesAtomically $state.StartupVbs ([System.IO.File]::ReadAllBytes($backup))
    } elseif (Test-Path -LiteralPath $state.StartupVbs) {
        Remove-Item -LiteralPath $state.StartupVbs -Force
    }

    if ($state.AgentWasRunning) {
        if (-not (Test-Path -LiteralPath $state.StartupVbs -PathType Leaf)) {
            throw 'Startup anterior ausente para reiniciar o agente restaurado.'
        }
        Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') `
            -ArgumentList @("`"$($state.StartupVbs)`"")
        Wait-ExpedAgentReady $AgentExe $state.SettingsPath 30
    }
    if (Test-Path -LiteralPath $receiptKey) { Remove-Item -LiteralPath $receiptKey -Recurse -Force }
    Remove-Item -LiteralPath $transaction.Dir -Recurse -Force
}

$modeCount = ([int]$Install.IsPresent) + ([int]$Start.IsPresent) +
    ([int]$Uninstall.IsPresent) + ([int]$Rollback.IsPresent) + ([int]$Finalize.IsPresent)
if ($modeCount -ne 1) {
    throw 'Informe exatamente um modo: -Install, -Start, -Uninstall, -Rollback ou -Finalize.'
}
if (-not $env:LOCALAPPDATA -or -not $env:APPDATA) { throw 'Perfil do usuario original nao esta carregado.' }

$userSid = Get-VerifiedInteractiveUserSid
$agentDir = Join-Path $env:LOCALAPPDATA 'ExpedAgent'
$settingsPath = Join-Path $agentDir 'appsettings.json'
$agentExe = Join-Path $agentDir 'ExpedAgent.exe'
$startCmd = Join-Path $agentDir 'start.cmd'
$startupDir = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
$startupVbs = Join-Path $startupDir 'ExpedAgent.vbs'

if ($Rollback) {
    if ($ReceiptId -notmatch '^[A-Za-z0-9_-]{16,80}$') { throw 'ReceiptId de rollback invalido.' }
    Restore-AgentTransaction $ReceiptId $userSid $agentExe
    exit 0
}

if ($Finalize) {
    if ($ReceiptId -notmatch '^[A-Za-z0-9_-]{16,80}$') { throw 'ReceiptId de finalize invalido.' }
    $receiptKey = "HKCU:\Software\Exped\InstallReceipts\$ReceiptId"
    if (-not (Test-Path -LiteralPath $receiptKey)) { throw 'Receipt de install ausente na finalizacao.' }
    $receipt = Get-ItemProperty -LiteralPath $receiptKey
    if ($receipt.UserSid -ne $userSid -or -not [string]::Equals(
        [System.IO.Path]::GetFullPath("$($receipt.SettingsPath)"),
        $settingsPath,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'Receipt de install diverge do usuario/caminho atual.'
    }
    Remove-Item -LiteralPath $receiptKey -Recurse -Force
    $transaction = Get-AgentTransaction $ReceiptId
    if ($transaction) { Remove-Item -LiteralPath $transaction.Dir -Recurse -Force }
    exit 0
}

if ($Uninstall) {
    if ($ReceiptId -notmatch '^[A-Za-z0-9_-]{16,80}$') { throw 'ReceiptId de uninstall invalido.' }
    if (-not (Test-ExpedUserSid $ExpectedUserSid) -or $userSid -ne $ExpectedUserSid) {
        throw 'SID atual nao corresponde ao agent.userSid esperado para uninstall.'
    }
    if (-not $ExpectedSettingsPath) { throw 'ExpectedSettingsPath obrigatorio para uninstall.' }
    $expectedPath = [System.IO.Path]::GetFullPath($ExpectedSettingsPath)
    if (-not [string]::Equals($settingsPath, $expectedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Caminho do agente atual diverge do settingsPath persistido. Atual=$settingsPath Esperado=$expectedPath"
    }

    $receiptKey = "HKCU:\Software\Exped\UninstallReceipts\$ReceiptId"
    try {
        Get-ThisUserAgentProcesses $agentExe | Stop-Process -Force
        Start-Sleep -Milliseconds 500
        if (Test-Path -LiteralPath $startupVbs) { Remove-Item -LiteralPath $startupVbs -Force }
        if (Test-Path -LiteralPath $agentDir) { Remove-Item -LiteralPath $agentDir -Recurse -Force }
        New-Item -Path $receiptKey -Force | Out-Null
        New-ItemProperty -Path $receiptKey -Name UserSid -Value $userSid -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $receiptKey -Name Status -Value 'Complete' -PropertyType String -Force | Out-Null
    } catch {
        try {
            New-Item -Path $receiptKey -Force | Out-Null
            New-ItemProperty -Path $receiptKey -Name UserSid -Value $userSid -PropertyType String -Force | Out-Null
            New-ItemProperty -Path $receiptKey -Name Status -Value 'Failed' -PropertyType String -Force | Out-Null
            New-ItemProperty -Path $receiptKey -Name Message -Value "$($_.Exception.Message)" -PropertyType String -Force | Out-Null
        } catch { }
        throw
    }
    exit 0
}

if ($Install) {
    if ($ReceiptId -notmatch '^[A-Za-z0-9_-]{16,80}$') { throw 'ReceiptId invalido.' }
    if (-not (Test-Path -LiteralPath $StageDir)) { throw "Stage do agente nao encontrado: $StageDir" }
    $hubConfigPath = Join-Path $Root 'config.json'
    if (-not (Test-Path -LiteralPath $hubConfigPath)) { throw "Config do Hub nao encontrado: $hubConfigPath" }

    $hubConfig = Get-Content -Raw -LiteralPath $hubConfigPath | ConvertFrom-Json
    if (-not $hubConfig.cloud.apiBase -or -not $hubConfig.cloud.deviceToken) {
        throw 'config.json do Hub sem cloud.apiBase/deviceToken apos provisionamento.'
    }
    Assert-AgentReceiptTransition $hubConfig $settingsPath $userSid
    $null = New-AgentTransaction $ReceiptId $userSid $agentDir $settingsPath $startupVbs $agentExe
    try {
        Get-ThisUserAgentProcesses $agentExe | Stop-Process -Force
        Start-Sleep -Milliseconds 500
        New-Item -ItemType Directory -Force -Path $agentDir | Out-Null

        foreach ($item in Get-ChildItem -LiteralPath $StageDir) {
            if ($item.Name -ieq 'appsettings.json' -and (Test-Path -LiteralPath $settingsPath)) { continue }
            Copy-Item -LiteralPath $item.FullName -Destination $agentDir -Recurse -Force
        }

        $syncNowPort = Get-ExpedAgentSyncNowPort $hubConfig
        $appPort = if ($null -ne $hubConfig.ports -and $null -ne $hubConfig.ports.app) {
            [int]$hubConfig.ports.app
        } else {
            3000
        }
        if ($appPort -lt 1 -or $appPort -gt 65535) {
            throw "config.json contem ports.app invalida: $appPort"
        }
        Set-ExpedAgentSettings -SettingsPath $settingsPath -SyncNowPort $syncNowPort `
            -ApiBaseUrl "http://127.0.0.1:$appPort" -DeviceToken "$($hubConfig.cloud.deviceToken)" `
            -UpdateCredentials

        New-Item -ItemType Directory -Force -Path $startupDir | Out-Null
        $vbsLines = @(
            'Set sh = CreateObject("WScript.Shell")',
            ('sh.Run "cmd /c ""{0}""", 0, False' -f $startCmd)
        )
        [System.IO.File]::WriteAllText(
            $startupVbs,
            ($vbsLines -join "`r`n"),
            (New-Object System.Text.UTF8Encoding $false)
        )

        $receiptKey = "HKCU:\Software\Exped\InstallReceipts\$ReceiptId"
        New-Item -Path $receiptKey -Force | Out-Null
        New-ItemProperty -Path $receiptKey -Name UserSid -Value $userSid -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $receiptKey -Name SettingsPath -Value $settingsPath -PropertyType String -Force | Out-Null
    } catch {
        try { Restore-AgentTransaction $ReceiptId $userSid $agentExe }
        catch { Write-Warning "Rollback local do agente falhou: $($_.Exception.Message)" }
        throw
    }
    exit 0
}

if ($ReceiptId) {
    if ($ReceiptId -notmatch '^[A-Za-z0-9_-]{16,80}$') { throw 'ReceiptId de start invalido.' }
    $receiptKey = "HKCU:\Software\Exped\InstallReceipts\$ReceiptId"
    if (-not (Test-Path -LiteralPath $receiptKey)) { throw 'Receipt de install ausente antes do start.' }
    $startReceipt = Get-ItemProperty -LiteralPath $receiptKey
    if ($startReceipt.UserSid -ne $userSid -or -not [string]::Equals(
        [System.IO.Path]::GetFullPath("$($startReceipt.SettingsPath)"),
        $settingsPath,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'Receipt de install diverge do usuario/caminho no start.'
    }
}
if (-not (Test-Path -LiteralPath $startCmd)) { throw "start.cmd do agente nao encontrado: $startCmd" }
if (-not (Test-Path -LiteralPath $startupVbs)) { throw "Startup do agente nao encontrado: $startupVbs" }
try {
    if ((Get-ThisUserAgentProcesses $agentExe).Count -eq 0) {
        Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') `
            -ArgumentList @("`"$startupVbs`"")
    }
    Wait-ExpedAgentReady $agentExe $settingsPath 30
} catch {
    $startFailure = $_
    if ($ReceiptId) {
        try { Restore-AgentTransaction $ReceiptId $userSid $agentExe }
        catch {
            throw "Start/health do agente falhou e rollback local tambem falhou. Start=$($startFailure.Exception.Message) Rollback=$($_.Exception.Message)"
        }
    }
    throw $startFailure
}
