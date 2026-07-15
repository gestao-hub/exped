# Self-contained operations used by Inno before and after [Files].
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('PreflightUser', 'SnapshotHub', 'RestoreHub', 'FinalizeHub',
        'SuspendLegacyWatchdog', 'RestoreLegacyWatchdog',
        'RollbackAgentUrlAcl', 'QueryHubRunning', 'QueryProvisionedConfig', 'StopHub', 'StartHub',
        'ProtectCredentials', 'StampHubVersion', 'IssueProvisionCapability',
        'VerifyCompleteStatus')]
    [string]$Operation,
    [string]$Root = 'C:\Exped',
    [string]$TransactionDir = '',
    [string]$CredentialsFile = '',
    [string]$ServiceName = 'ExpedHub',
    [string]$LegacyWatchdogTaskName = 'ExpedWatchdog',
    [string]$LegacyWatchdogTaskPath = '\',
    [string]$AppVersion = '',
    [string]$InstallerTransactionId = '',
    [int]$StatusTimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$script:IsWindowsPlatform = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
$script:HubTransactionalDirectories = @('app', 'hub', 'scripts', 'supabase', 'bin', 'cert', 'agent-stage')
$script:HubTransactionalFiles = @('config.json', 'rootCA-Exped.crt', 'watchdog.ps1')

function Test-UserSid($Sid) {
    return ("$Sid" -match '^S-\d-(?:\d+-)+\d+$')
}

function Get-FileOwnerSid($Path) {
    $acl = Get-Acl -LiteralPath $Path
    $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
    if ($owner) { return "$($owner.Value)" }
    return ''
}

function Resolve-RegisteredLocalAppData($ProfilePath, $RawValue) {
    $value = "$RawValue"
    if ($value.StartsWith('%USERPROFILE%', [System.StringComparison]::OrdinalIgnoreCase)) {
        $value = $ProfilePath + $value.Substring(13)
    }
    return [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($value))
}

function Assert-OriginalInteractiveUser {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $sid = "$($identity.User.Value)"
    $principal = New-Object System.Security.Principal.WindowsPrincipal $identity
    if ($principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Setup iniciou elevado e nao preservou um token original nao elevado. Abra por duplo clique.'
    }

    $sessionId = (Get-Process -Id $PID).SessionId
    $explorerSids = @(
        Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" |
            Where-Object { $_.SessionId -eq $sessionId } |
            ForEach-Object { (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid } |
            Where-Object { $_ } |
            Sort-Object -Unique
    )
    if ($explorerSids.Count -ne 1 -or $explorerSids[0] -ne $sid) {
        throw 'Nao foi possivel provar o usuario original por Explorer. Abra o Setup por duplo clique.'
    }
    if (-not $env:USERPROFILE -or -not $env:LOCALAPPDATA) {
        throw 'Perfil do usuario original nao esta carregado.'
    }

    $escapedSid = $sid.Replace("'", "''")
    $accounts = @(
        Get-CimInstance -ClassName Win32_UserAccount -Filter "SID='$escapedSid'" -ErrorAction Stop
    )
    if ($accounts.Count -ne 1 -or [int]$accounts[0].SIDType -ne 1 -or $accounts[0].Disabled) {
        throw "SID nao identifica uma conta de usuario Windows habilitada: $sid"
    }

    $profileKey = "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$sid"
    if (-not (Test-Path -LiteralPath $profileKey)) {
        throw "SID sem ProfileList registrado: $sid"
    }
    $profilePath = [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables(
        "$(Get-ItemPropertyValue -LiteralPath $profileKey -Name ProfileImagePath -ErrorAction Stop)"
    )).TrimEnd('\')
    if (-not (Test-Path -LiteralPath $profilePath -PathType Container)) {
        throw "ProfileList aponta para diretorio inexistente: $profilePath"
    }
    $environmentProfile = [System.IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\')
    if (-not [string]::Equals(
        $profilePath, $environmentProfile, [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'USERPROFILE diverge do ProfileList do usuario original.'
    }

    $userShellKey = "Registry::HKEY_USERS\$sid\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders"
    if (-not (Test-Path -LiteralPath $userShellKey)) {
        throw "User Shell Folders do usuario original nao esta carregado: $sid"
    }
    $registeredLocalAppData = Resolve-RegisteredLocalAppData $profilePath (
        Get-ItemPropertyValue -LiteralPath $userShellKey -Name 'Local AppData' -ErrorAction Stop
    )
    if (-not (Test-Path -LiteralPath $registeredLocalAppData -PathType Container)) {
        throw "User Shell Folders aponta para Local AppData inexistente: $registeredLocalAppData"
    }
    $localAppData = [System.IO.Path]::GetFullPath($env:LOCALAPPDATA)
    if (-not [string]::Equals(
        $registeredLocalAppData, $localAppData, [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'LOCALAPPDATA diverge de User Shell Folders do usuario original.'
    }

    $targetPath = [System.IO.Path]::GetFullPath(
        (Join-Path $registeredLocalAppData 'ExpedAgent\appsettings.json')
    )
    $configPath = Join-Path $Root 'config.json'
    if (-not (Test-Path -LiteralPath $configPath)) { return }
    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    $existingPath = if ($config.agent -and $config.agent.settingsPath) {
        [System.IO.Path]::GetFullPath("$($config.agent.settingsPath)")
    } else { '' }
    $existingSid = if ($config.agent -and $config.agent.userSid) { "$($config.agent.userSid)" } else { '' }

    if ($existingSid -and -not $existingPath) {
        throw 'agent.userSid existe sem agent.settingsPath; desinstale ou migre explicitamente.'
    }
    if ($existingPath -and -not [string]::Equals(
        $existingPath, $targetPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Outro perfil ja possui o agente. Desinstale ou migre explicitamente antes de reinstalar.'
    }
    if ($existingSid -and -not [string]::Equals(
        $existingSid, $sid, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Outro SID ja possui o agente. Desinstale ou migre explicitamente antes de reinstalar.'
    }
    if ($existingPath) {
        if (-not (Test-Path -LiteralPath $existingPath -PathType Leaf)) {
            throw "agent.settingsPath existente nao foi encontrado: $existingPath"
        }
        $ownerSid = Get-FileOwnerSid $existingPath
        if (-not [string]::Equals($ownerSid, $sid, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'Owner do settings legado/atual diverge do usuario original; desinstale ou migre explicitamente.'
        }
    }
}

function Write-BytesAtomically($Path, [byte[]]$Bytes) {
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $parent = [System.IO.Path]::GetDirectoryName($fullPath)
    if (-not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    $tempPath = "$fullPath.$PID.$([Guid]::NewGuid().ToString('N')).tmp"
    $replaceBackupPath = "$fullPath.$PID.$([Guid]::NewGuid().ToString('N')).replace.bak"
    try {
        [System.IO.File]::WriteAllBytes($tempPath, $Bytes)
        if (Test-Path -LiteralPath $fullPath) {
            if ($script:IsWindowsPlatform) {
                [System.IO.File]::Replace($tempPath, $fullPath, $replaceBackupPath)
                [System.IO.File]::Delete($replaceBackupPath)
            } else {
                [System.IO.File]::Move($tempPath, $fullPath, $true)
            }
        } else {
            [System.IO.File]::Move($tempPath, $fullPath)
        }
    } finally {
        if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force }
        if (Test-Path -LiteralPath $replaceBackupPath) {
            Remove-Item -LiteralPath $replaceBackupPath -Force
        }
    }
}

function Write-JsonAtomically($Path, $Value) {
    $json = $Value | ConvertTo-Json -Depth 12
    Write-BytesAtomically $Path $utf8NoBom.GetBytes($json)
}

function Convert-BytesToHex([byte[]]$Bytes) {
    return (($Bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Get-BytesSha256Hex([byte[]]$Bytes) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $hash = $sha.ComputeHash($Bytes)
        return Convert-BytesToHex $hash
    }
    finally { $sha.Dispose() }
}

function Get-FileDigest($Path) {
    $stream = $null
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::Open(
            $Path,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read
        )
        return [pscustomobject]@{
            Length = $stream.Length
            Sha256 = Convert-BytesToHex ($sha.ComputeHash($stream))
        }
    } catch {
        throw "Backup ausente ou ilegivel: $Path. $($_.Exception.Message)"
    } finally {
        if ($stream) { $stream.Dispose() }
        $sha.Dispose()
    }
}

function Get-RelativeBackupPath($BasePath, $ChildPath) {
    $base = [System.IO.Path]::GetFullPath($BasePath).TrimEnd('\', '/')
    $child = [System.IO.Path]::GetFullPath($ChildPath)
    $prefix = $base + [System.IO.Path]::DirectorySeparatorChar
    if (-not $child.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Path de backup escapou da raiz protegida: $child"
    }
    return $child.Substring($prefix.Length)
}

function Get-HubTreeManifest($BasePath) {
    $entries = @()
    foreach ($item in @(Get-ChildItem -LiteralPath $BasePath -Force -Recurse -ErrorAction Stop |
        Sort-Object FullName)) {
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Snapshot recusou reparse point: $($item.FullName)"
        }
        $relativePath = Get-RelativeBackupPath $BasePath $item.FullName
        if ($item.PSIsContainer) {
            $entries += [pscustomobject]@{
                RelativePath = $relativePath
                Kind = 'Directory'
                Length = 0
                Sha256 = ''
            }
        } else {
            $digest = Get-FileDigest $item.FullName
            $entries += [pscustomobject]@{
                RelativePath = $relativePath
                Kind = 'File'
                Length = $digest.Length
                Sha256 = $digest.Sha256
            }
        }
    }
    return $entries
}

function Protect-AdministratorPath($Path, [switch]$Directory) {
    if ($script:IsWindowsPlatform) {
        if ($Directory) {
            $security = New-Object System.Security.AccessControl.DirectorySecurity
            $security.SetSecurityDescriptorSddlForm(
                'O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
            )
        } else {
            $security = New-Object System.Security.AccessControl.FileSecurity
            $security.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)')
        }
        Set-Acl -LiteralPath $Path -AclObject $security
        return
    }

    $mode = if ($Directory) { '700' } else { '600' }
    & chmod $mode -- $Path
    if ($LASTEXITCODE -ne 0) { throw "chmod falhou para path protegido: $Path" }
}

function Copy-HubTreeExact($Source, $Destination) {
    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        throw "Arvore de origem ausente: $Source"
    }
    if ($script:IsWindowsPlatform) {
        New-Item -ItemType Directory -Force -Path $Destination | Out-Null
        $previousEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $output = @(& robocopy.exe $Source $Destination /MIR /COPY:DATSOU /DCOPY:DAT `
                /R:2 /W:1 /XJ /NFL /NDL /NJH /NJS /NP 2>&1 | ForEach-Object { "$_" })
            $exitCode = $LASTEXITCODE
        } finally { $ErrorActionPreference = $previousEap }
        if ($exitCode -gt 7) {
            throw "robocopy.exe falhou ($exitCode): $($output -join ' ')"
        }
        return
    }

    if (Test-Path -LiteralPath $Destination) {
        Remove-Item -LiteralPath $Destination -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
    }
}

function Get-HubService {
    if (-not $script:IsWindowsPlatform) { return $null }
    return Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
}

function Get-LegacyWatchdogTask {
    if (-not $script:IsWindowsPlatform) { return $null }
    $tasks = @(
        Get-ScheduledTask -TaskName $LegacyWatchdogTaskName `
            -TaskPath $LegacyWatchdogTaskPath -ErrorAction SilentlyContinue
    )
    if ($tasks.Count -gt 1) {
        throw "Mais de uma tarefa watchdog corresponde a $LegacyWatchdogTaskPath$LegacyWatchdogTaskName."
    }
    if ($tasks.Count -eq 1) { return $tasks[0] }
    return $null
}

function Test-ProvisionedCloudConfig {
    $configPath = Join-Path $Root 'config.json'
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { return $false }
    try {
        $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
        $apiBase = "$($config.cloud.apiBase)".Trim()
        $deviceToken = "$($config.cloud.deviceToken)".Trim()
        $uri = $null
        if (-not [Uri]::TryCreate($apiBase, [UriKind]::Absolute, [ref]$uri)) { return $false }
        return $uri.Scheme -eq [Uri]::UriSchemeHttps -and $deviceToken.Length -gt 0
    } catch {
        return $false
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
        throw "$FilePath falhou ($exitCode): $($Arguments -join ' ') - $($output -join ' ')"
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = ($output -join "`n") }
}

function Get-HubServiceRegistryAclSnapshot {
    if (-not $script:IsWindowsPlatform) { return @() }
    $baseKey = $null
    $rootKey = $null
    try {
        $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
            [Microsoft.Win32.RegistryHive]::LocalMachine,
            [Microsoft.Win32.RegistryView]::Registry64
        )
        $serviceSubKey = "SYSTEM\CurrentControlSet\Services\$ServiceName"
        $readRights = [System.Security.AccessControl.RegistryRights]::ReadKey -bor
            [System.Security.AccessControl.RegistryRights]::ReadPermissions
        $rootKey = $baseKey.OpenSubKey(
            $serviceSubKey,
            [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadSubTree,
            $readRights
        )
        if ($null -eq $rootKey) { return @() }

        $pendingPaths = New-Object 'System.Collections.Generic.Queue[string]'
        $pendingPaths.Enqueue('')
        $entries = @()
        while ($pendingPaths.Count -gt 0) {
            $relativePath = $pendingPaths.Dequeue()
            $key = $null
            try {
                $key = if ($relativePath) {
                    $rootKey.OpenSubKey(
                        $relativePath,
                        [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadSubTree,
                        $readRights
                    )
                } else {
                    $rootKey
                }
                if ($null -eq $key) {
                    throw "Subchave ausente ao capturar ACL: $relativePath"
                }
                $security = $key.GetAccessControl(
                    [System.Security.AccessControl.AccessControlSections]::All
                )
                $entries += [pscustomobject]@{
                    RelativePath = $relativePath
                    Sddl = $security.GetSecurityDescriptorSddlForm(
                        [System.Security.AccessControl.AccessControlSections]::All
                    )
                }
                foreach ($childName in @($key.GetSubKeyNames() | Sort-Object)) {
                    $childPath = if ($relativePath) {
                        "$relativePath\$childName"
                    } else {
                        "$childName"
                    }
                    $pendingPaths.Enqueue($childPath)
                }
            } finally {
                if ($null -ne $key -and $key -ne $rootKey) { $key.Dispose() }
            }
        }
        return @($entries)
    } finally {
        if ($null -ne $rootKey) { $rootKey.Dispose() }
        if ($null -ne $baseKey) { $baseKey.Dispose() }
    }
}

function Restore-HubServiceRegistryAcls($Entries) {
    if (-not $script:IsWindowsPlatform) { return }
    $baseKey = $null
    try {
        $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
            [Microsoft.Win32.RegistryHive]::LocalMachine,
            [Microsoft.Win32.RegistryView]::Registry64
        )
        $serviceSubKey = "SYSTEM\CurrentControlSet\Services\$ServiceName"
        $writeRights = [System.Security.AccessControl.RegistryRights]::ReadKey -bor
            [System.Security.AccessControl.RegistryRights]::ReadPermissions -bor
            [System.Security.AccessControl.RegistryRights]::ChangePermissions -bor
            [System.Security.AccessControl.RegistryRights]::TakeOwnership
        foreach ($entry in @($Entries | Sort-Object { "$($_.RelativePath)".Length })) {
            $relativePath = "$($entry.RelativePath)"
            if ([System.IO.Path]::IsPathRooted($relativePath) -or $relativePath -match '(^|[\\/])\.\.([\\/]|$)') {
                throw "Path relativo de ACL invalido: $relativePath"
            }
            $subKeyPath = if ($relativePath) {
                "$serviceSubKey\$relativePath"
            } else {
                $serviceSubKey
            }
            $key = $null
            try {
                $key = $baseKey.OpenSubKey(
                    $subKeyPath,
                    [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,
                    $writeRights
                )
                if ($null -eq $key) {
                    throw "Subchave ausente ao restaurar ACL: $relativePath"
                }
                $security = New-Object System.Security.AccessControl.RegistrySecurity
                $security.SetSecurityDescriptorSddlForm(
                    "$($entry.Sddl)",
                    [System.Security.AccessControl.AccessControlSections]::All
                )
                $key.SetAccessControl($security)
            } finally {
                if ($null -ne $key) { $key.Dispose() }
            }
        }
    } finally {
        if ($null -ne $baseKey) { $baseKey.Dispose() }
    }
}

function Export-HubServiceSnapshot($Destination, $AclDestination) {
    $serviceKey = "HKLM\SYSTEM\CurrentControlSet\Services\$ServiceName"
    $null = Invoke-NativeChecked 'reg.exe' @('export', $serviceKey, $Destination, '/y')
    Write-JsonAtomically $AclDestination ([pscustomobject]@{
        Keys = @(Get-HubServiceRegistryAclSnapshot)
    })
}

function Get-ExpedFirewallRules {
    if (-not $script:IsWindowsPlatform) { return @() }
    return @(
        Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction Stop |
            Where-Object { $_.Name -eq $ServiceName -or $_.DisplayName -eq $ServiceName }
    )
}

function Export-FirewallSnapshot($Destination) {
    $entries = @()
    foreach ($rule in @(Get-ExpedFirewallRules)) {
        $port = @(Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule -ErrorAction Stop) |
            Select-Object -First 1
        $address = @(Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $rule -ErrorAction Stop) |
            Select-Object -First 1
        $application = @(Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $rule -ErrorAction Stop) |
            Select-Object -First 1
        $service = @(Get-NetFirewallServiceFilter -AssociatedNetFirewallRule $rule -ErrorAction Stop) |
            Select-Object -First 1
        $interface = @(Get-NetFirewallInterfaceFilter -AssociatedNetFirewallRule $rule -ErrorAction Stop) |
            Select-Object -First 1
        $interfaceType = @(Get-NetFirewallInterfaceTypeFilter -AssociatedNetFirewallRule $rule -ErrorAction Stop) |
            Select-Object -First 1

        $entries += [pscustomobject]@{
            Name = "$($rule.Name)"
            DisplayName = "$($rule.DisplayName)"
            Description = "$($rule.Description)"
            Group = "$($rule.Group)"
            Direction = "$($rule.Direction)"
            Action = "$($rule.Action)"
            Enabled = "$($rule.Enabled)"
            Profile = "$($rule.Profile)"
            EdgeTraversalPolicy = "$($rule.EdgeTraversalPolicy)"
            Protocol = if ($port) { "$($port.Protocol)" } else { 'Any' }
            LocalPort = if ($port) { $port.LocalPort } else { 'Any' }
            RemotePort = if ($port) { $port.RemotePort } else { 'Any' }
            IcmpType = if ($port) { $port.IcmpType } else { 'Any' }
            LocalAddress = if ($address) { $address.LocalAddress } else { 'Any' }
            RemoteAddress = if ($address) { $address.RemoteAddress } else { 'Any' }
            Program = if ($application) { "$($application.Program)" } else { 'Any' }
            Service = if ($service) { "$($service.Service)" } else { 'Any' }
            InterfaceType = if ($interfaceType) { "$($interfaceType.InterfaceType)" } else { 'Any' }
            InterfaceAlias = if ($interface) { $interface.InterfaceAlias } else { 'Any' }
        }
    }
    Write-JsonAtomically $Destination ([pscustomobject]@{ Rules = [object[]]$entries })
}

function Add-FirewallParameterIfSpecific($Parameters, $Name, $Value) {
    if ($null -eq $Value) { return }
    $values = @($Value)
    if ($values.Count -eq 0) { return }
    if ($values.Count -eq 1 -and ("$($values[0])" -eq '' -or "$($values[0])" -eq 'Any')) {
        return
    }
    $Parameters[$Name] = $Value
}

function Restore-FirewallSnapshot($State) {
    if (-not $script:IsWindowsPlatform) { return }
    $snapshotPath = Join-Path $TransactionDir "$($State.FirewallSnapshot)"
    if (-not (Test-Path -LiteralPath $snapshotPath -PathType Leaf)) {
        throw 'Snapshot de firewall ausente.'
    }
    $snapshot = Get-Content -Raw -LiteralPath $snapshotPath | ConvertFrom-Json
    foreach ($rule in @(Get-ExpedFirewallRules)) {
        Remove-NetFirewallRule -InputObject $rule -ErrorAction Stop
    }
    foreach ($entry in @($snapshot.Rules)) {
        $parameters = @{
            Name = if ($entry.Name) { "$($entry.Name)" } else { "$($entry.DisplayName)" }
            DisplayName = "$($entry.DisplayName)"
            Direction = "$($entry.Direction)"
            Action = "$($entry.Action)"
            Enabled = "$($entry.Enabled)"
            Profile = "$($entry.Profile)"
        }
        Add-FirewallParameterIfSpecific $parameters 'Description' $entry.Description
        Add-FirewallParameterIfSpecific $parameters 'Group' $entry.Group
        Add-FirewallParameterIfSpecific $parameters 'EdgeTraversalPolicy' $entry.EdgeTraversalPolicy
        Add-FirewallParameterIfSpecific $parameters 'Protocol' $entry.Protocol
        Add-FirewallParameterIfSpecific $parameters 'LocalPort' $entry.LocalPort
        Add-FirewallParameterIfSpecific $parameters 'RemotePort' $entry.RemotePort
        Add-FirewallParameterIfSpecific $parameters 'IcmpType' $entry.IcmpType
        Add-FirewallParameterIfSpecific $parameters 'LocalAddress' $entry.LocalAddress
        Add-FirewallParameterIfSpecific $parameters 'RemoteAddress' $entry.RemoteAddress
        Add-FirewallParameterIfSpecific $parameters 'Program' $entry.Program
        Add-FirewallParameterIfSpecific $parameters 'Service' $entry.Service
        Add-FirewallParameterIfSpecific $parameters 'InterfaceType' $entry.InterfaceType
        Add-FirewallParameterIfSpecific $parameters 'InterfaceAlias' $entry.InterfaceAlias
        $null = New-NetFirewallRule @parameters -PolicyStore PersistentStore -ErrorAction Stop
    }
}

function Stop-HubServiceIfPresent {
    $service = Get-HubService
    if ($service -and $service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Stopped) {
        Stop-Service -Name $ServiceName -Force -ErrorAction Stop
        (Get-Service -Name $ServiceName).WaitForStatus(
            [System.ServiceProcess.ServiceControllerStatus]::Stopped,
            [TimeSpan]::FromSeconds(30)
        )
    }
}

function Remove-HubServiceCreatedByAttempt {
    $service = Get-HubService
    if (-not $service) { return }
    Stop-HubServiceIfPresent
    $null = Invoke-NativeChecked 'sc.exe' @('delete', $ServiceName)
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-HubService) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
    }
    if (Get-HubService) { throw "Servico $ServiceName continuou registrado apos rollback." }
}

function Restore-HubServiceSnapshot($State) {
    if (-not $script:IsWindowsPlatform) { return }
    if (-not $State.ServiceExistedBefore) {
        Remove-HubServiceCreatedByAttempt
        return
    }
    if (-not (Get-HubService)) {
        throw "Servico preexistente $ServiceName desapareceu; rollback recusou criar outro registro aproximado."
    }
    Stop-HubServiceIfPresent
    $serviceKey = "HKLM\SYSTEM\CurrentControlSet\Services\$ServiceName"
    $registryBackup = Join-Path $TransactionDir "$($State.RegistryServiceBackup)"
    if (-not (Test-Path -LiteralPath $registryBackup -PathType Leaf)) {
        throw 'Backup do registro do servico preexistente esta ausente.'
    }
    $aclBackup = Join-Path $TransactionDir "$($State.RegistryServiceAclBackup)"
    if (-not (Test-Path -LiteralPath $aclBackup -PathType Leaf)) {
        throw 'Backup de ACL do registro do servico preexistente esta ausente.'
    }
    $aclState = Get-Content -Raw -LiteralPath $aclBackup | ConvertFrom-Json
    $null = Invoke-NativeChecked 'reg.exe' @('delete', $serviceKey, '/f')
    $null = Invoke-NativeChecked 'reg.exe' @('import', $registryBackup)
    Restore-HubServiceRegistryAcls @($aclState.Keys)
    if ($State.ServiceWasRunningBefore) {
        Start-Service -Name $ServiceName -ErrorAction Stop
        (Get-Service -Name $ServiceName).WaitForStatus(
            [System.ServiceProcess.ServiceControllerStatus]::Running,
            [TimeSpan]::FromSeconds(30)
        )
    }
}

function Suspend-LegacyWatchdogTask {
    $state = Read-HubSnapshotState
    Assert-LegacyWatchdogSnapshotState $state
    if (-not $script:IsWindowsPlatform -or -not [bool]$state.LegacyWatchdogTaskExistedBefore) {
        return
    }

    $task = Get-LegacyWatchdogTask
    if (-not $task) {
        throw "Tarefa watchdog preexistente desapareceu: $LegacyWatchdogTaskPath$LegacyWatchdogTaskName"
    }
    $wasRunning = "$($task.State)" -eq 'Running'
    Disable-ScheduledTask -TaskName $LegacyWatchdogTaskName `
        -TaskPath $LegacyWatchdogTaskPath -ErrorAction Stop | Out-Null

    $task = Get-LegacyWatchdogTask
    if ($wasRunning -or ($task -and "$($task.State)" -eq 'Running')) {
        Stop-ScheduledTask -TaskName $LegacyWatchdogTaskName `
            -TaskPath $LegacyWatchdogTaskPath -ErrorAction Stop
    }

    $deadline = (Get-Date).AddSeconds(30)
    do {
        $task = Get-LegacyWatchdogTask
        if (-not $task) {
            throw "Tarefa watchdog desapareceu durante a suspensao: $LegacyWatchdogTaskPath$LegacyWatchdogTaskName"
        }
        if ("$($task.State)" -ne 'Running') { break }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)

    if ("$($task.State)" -eq 'Running') {
        throw "Tarefa watchdog continuou em execucao apos a suspensao: $LegacyWatchdogTaskPath$LegacyWatchdogTaskName"
    }
    if ("$($task.State)" -ne 'Disabled') {
        throw "Tarefa watchdog nao ficou desabilitada: $LegacyWatchdogTaskPath$LegacyWatchdogTaskName"
    }
}

function Restore-LegacyWatchdogTaskState($State) {
    if (-not $script:IsWindowsPlatform -or -not [bool]$State.LegacyWatchdogTaskExistedBefore) {
        return
    }

    $task = Get-LegacyWatchdogTask
    if (-not $task) {
        throw "Tarefa watchdog preexistente desapareceu: $LegacyWatchdogTaskPath$LegacyWatchdogTaskName"
    }
    if ([bool]$State.LegacyWatchdogTaskEnabledBefore) {
        Enable-ScheduledTask -TaskName $LegacyWatchdogTaskName `
            -TaskPath $LegacyWatchdogTaskPath -ErrorAction Stop | Out-Null
    } else {
        Disable-ScheduledTask -TaskName $LegacyWatchdogTaskName `
            -TaskPath $LegacyWatchdogTaskPath -ErrorAction Stop | Out-Null
    }

    $task = Get-LegacyWatchdogTask
    $enabled = "$($task.State)" -ne 'Disabled'
    if ($enabled -ne [bool]$State.LegacyWatchdogTaskEnabledBefore) {
        throw "Estado habilitado da tarefa watchdog nao foi restaurado: $LegacyWatchdogTaskPath$LegacyWatchdogTaskName"
    }
}

function New-HubSnapshot {
    if (-not $TransactionDir) { throw 'TransactionDir obrigatorio para SnapshotHub.' }
    if (Test-Path -LiteralPath $TransactionDir) {
        throw "TransactionDir ja existe: $TransactionDir"
    }
    New-Item -ItemType Directory -Path $TransactionDir | Out-Null
    Protect-AdministratorPath $TransactionDir -Directory

    $backupRoot = Join-Path $TransactionDir 'payload'
    New-Item -ItemType Directory -Path $backupRoot | Out-Null
    $directoryStates = @()
    foreach ($relativePath in $script:HubTransactionalDirectories) {
        $sourcePath = Join-Path $Root $relativePath
        $existed = Test-Path -LiteralPath $sourcePath -PathType Container
        $manifest = @()
        if ($existed) {
            $backupPath = Join-Path $backupRoot $relativePath
            Copy-HubTreeExact $sourcePath $backupPath
            $manifest = @(Get-HubTreeManifest $backupPath)
        }
        $directoryStates += [pscustomobject]@{
            RelativePath = $relativePath
            Existed = $existed
            Manifest = $manifest
        }
    }

    $filesRoot = Join-Path $TransactionDir 'files'
    New-Item -ItemType Directory -Path $filesRoot | Out-Null
    $fileStates = @()
    foreach ($relativePath in $script:HubTransactionalFiles) {
        $sourcePath = Join-Path $Root $relativePath
        $existed = Test-Path -LiteralPath $sourcePath -PathType Leaf
        $length = 0
        $sha256 = ''
        if ($existed) {
            $backupPath = Join-Path $filesRoot $relativePath
            [System.IO.File]::WriteAllBytes($backupPath, [System.IO.File]::ReadAllBytes($sourcePath))
            $digest = Get-FileDigest $backupPath
            $length = $digest.Length
            $sha256 = $digest.Sha256
        }
        $fileStates += [pscustomobject]@{
            RelativePath = $relativePath
            Existed = $existed
            Length = $length
            Sha256 = $sha256
        }
    }

    $configAclSddl = ''
    $configPath = Join-Path $Root 'config.json'
    if ($script:IsWindowsPlatform -and (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        $configAclSddl = (Get-Acl -LiteralPath $configPath).GetSecurityDescriptorSddlForm(
            [System.Security.AccessControl.AccessControlSections]::All
        )
    }

    $service = Get-HubService
    $serviceExistedBefore = $null -ne $service
    $serviceWasRunningBefore = (
        $serviceExistedBefore -and
        $service.Status -eq [System.ServiceProcess.ServiceControllerStatus]::Running
    )
    $legacyWatchdogTask = Get-LegacyWatchdogTask
    $legacyWatchdogTaskExistedBefore = $null -ne $legacyWatchdogTask
    $legacyWatchdogTaskEnabledBefore = (
        $legacyWatchdogTaskExistedBefore -and "$($legacyWatchdogTask.State)" -ne 'Disabled'
    )
    $registryServiceBackup = ''
    $registryServiceBackupLength = 0
    $registryServiceBackupSha256 = ''
    $registryServiceAclBackup = ''
    $registryServiceAclBackupLength = 0
    $registryServiceAclBackupSha256 = ''
    if ($serviceExistedBefore) {
        $registryServiceBackup = 'service.reg'
        $registryServiceBackupPath = Join-Path $TransactionDir $registryServiceBackup
        $registryServiceAclBackup = 'service-acl.json'
        $registryServiceAclBackupPath = Join-Path $TransactionDir $registryServiceAclBackup
        Export-HubServiceSnapshot $registryServiceBackupPath $registryServiceAclBackupPath
        $registryDigest = Get-FileDigest $registryServiceBackupPath
        $registryServiceBackupLength = $registryDigest.Length
        $registryServiceBackupSha256 = $registryDigest.Sha256
        $registryAclDigest = Get-FileDigest $registryServiceAclBackupPath
        $registryServiceAclBackupLength = $registryAclDigest.Length
        $registryServiceAclBackupSha256 = $registryAclDigest.Sha256
    }

    $firewallSnapshot = 'firewall.json'
    $firewallSnapshotPath = Join-Path $TransactionDir $firewallSnapshot
    Export-FirewallSnapshot $firewallSnapshotPath
    $firewallDigest = Get-FileDigest $firewallSnapshotPath

    $state = [pscustomobject]@{
        Root = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
        Directories = $directoryStates
        Files = $fileStates
        ConfigAclSddl = $configAclSddl
        ServiceExistedBefore = $serviceExistedBefore
        ServiceWasRunningBefore = $serviceWasRunningBefore
        LegacyWatchdogTaskName = $LegacyWatchdogTaskName
        LegacyWatchdogTaskPath = $LegacyWatchdogTaskPath
        LegacyWatchdogTaskExistedBefore = $legacyWatchdogTaskExistedBefore
        LegacyWatchdogTaskEnabledBefore = $legacyWatchdogTaskEnabledBefore
        RegistryServiceBackup = $registryServiceBackup
        RegistryServiceBackupLength = $registryServiceBackupLength
        RegistryServiceBackupSha256 = $registryServiceBackupSha256
        RegistryServiceAclBackup = $registryServiceAclBackup
        RegistryServiceAclBackupLength = $registryServiceAclBackupLength
        RegistryServiceAclBackupSha256 = $registryServiceAclBackupSha256
        FirewallSnapshot = $firewallSnapshot
        FirewallSnapshotLength = $firewallDigest.Length
        FirewallSnapshotSha256 = $firewallDigest.Sha256
    }
    Write-JsonAtomically (Join-Path $TransactionDir 'hub-state.json') $state
}

function Read-HubSnapshotState {
    if (-not $TransactionDir) { throw 'TransactionDir obrigatorio.' }
    $statePath = Join-Path $TransactionDir 'hub-state.json'
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
        throw 'Journal do snapshot do Hub ausente.'
    }
    $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    $expectedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    if (-not [string]::Equals(
        "$($state.Root)", $expectedRoot, [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'Root do snapshot diverge do Root solicitado.'
    }
    return $state
}

function Assert-HubTreeBackup($Entry) {
    $relativeRoot = "$($Entry.RelativePath)"
    $backupPath = Join-Path (Join-Path $TransactionDir 'payload') $relativeRoot
    if (-not (Test-Path -LiteralPath $backupPath -PathType Container)) {
        throw "Snapshot truncado: backup de diretorio ausente: $relativeRoot"
    }
    if ($null -eq $Entry.PSObject.Properties['Manifest']) {
        throw "Snapshot truncado: manifesto ausente para diretorio: $relativeRoot"
    }

    try {
        $actualItems = @(Get-ChildItem -LiteralPath $backupPath -Force -Recurse -ErrorAction Stop)
    } catch {
        throw "Snapshot truncado: backup de diretorio ilegivel: $relativeRoot. $($_.Exception.Message)"
    }
    $manifest = @($Entry.Manifest)
    if ($actualItems.Count -ne $manifest.Count) {
        throw "Snapshot truncado: inventario diverge para diretorio: $relativeRoot"
    }

    $actualByPath = @{}
    foreach ($item in $actualItems) {
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Snapshot truncado: reparse point inesperado: $($item.FullName)"
        }
        $relativePath = Get-RelativeBackupPath $backupPath $item.FullName
        if ($actualByPath.ContainsKey($relativePath)) {
            throw "Snapshot truncado: path duplicado no backup: $relativePath"
        }
        $actualByPath[$relativePath] = $item
    }

    $expectedPaths = @{}
    foreach ($expected in $manifest) {
        $relativePath = "$($expected.RelativePath)"
        if (-not $relativePath -or [System.IO.Path]::IsPathRooted($relativePath)) {
            throw "Snapshot truncado: path invalido no manifesto de $relativeRoot"
        }
        $candidate = [System.IO.Path]::GetFullPath((Join-Path $backupPath $relativePath))
        $canonicalRelativePath = Get-RelativeBackupPath $backupPath $candidate
        if (-not [string]::Equals(
            $canonicalRelativePath, $relativePath, [System.StringComparison]::OrdinalIgnoreCase
        )) {
            throw "Snapshot truncado: path nao canonico no manifesto: $relativePath"
        }
        if ($expectedPaths.ContainsKey($relativePath)) {
            throw "Snapshot truncado: path duplicado no manifesto: $relativePath"
        }
        $expectedPaths[$relativePath] = $true
        if (-not $actualByPath.ContainsKey($relativePath)) {
            throw "Snapshot truncado: item de backup ausente: $relativeRoot/$relativePath"
        }

        $actual = $actualByPath[$relativePath]
        $expectedKind = "$($expected.Kind)"
        $actualKind = if ($actual.PSIsContainer) { 'Directory' } else { 'File' }
        if ($expectedKind -notin @('Directory', 'File') -or $actualKind -ne $expectedKind) {
            throw "Snapshot truncado: tipo diverge para $relativeRoot/$relativePath"
        }
        if ($actualKind -eq 'File') {
            $digest = Get-FileDigest $actual.FullName
            if ([long]$expected.Length -ne [long]$digest.Length -or
                -not [string]::Equals(
                    "$($expected.Sha256)", "$($digest.Sha256)",
                    [System.StringComparison]::OrdinalIgnoreCase
                )) {
                throw "Snapshot truncado: bytes divergem para $relativeRoot/$relativePath"
            }
        }
    }
}

function Assert-LegacyWatchdogSnapshotState($State) {
    if (-not [string]::Equals(
        "$($State.LegacyWatchdogTaskName)", $LegacyWatchdogTaskName,
        [System.StringComparison]::OrdinalIgnoreCase
    ) -or -not [string]::Equals(
        "$($State.LegacyWatchdogTaskPath)", $LegacyWatchdogTaskPath,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw 'Snapshot truncado: identidade da tarefa watchdog diverge.'
    }
    if ($null -eq $State.PSObject.Properties['LegacyWatchdogTaskExistedBefore'] -or
        $null -eq $State.PSObject.Properties['LegacyWatchdogTaskEnabledBefore']) {
        throw 'Snapshot truncado: estado da tarefa watchdog ausente.'
    }
    if (-not [bool]$State.LegacyWatchdogTaskExistedBefore -and
        [bool]$State.LegacyWatchdogTaskEnabledBefore) {
        throw 'Snapshot truncado: tarefa watchdog ausente nao pode estar habilitada.'
    }
}

function Assert-HubSnapshotComplete($State) {
    Assert-LegacyWatchdogSnapshotState $State

    $directories = @($State.Directories)
    if ($directories.Count -ne $script:HubTransactionalDirectories.Count) {
        throw 'Snapshot truncado: lista de diretorios transacionais incompleta.'
    }
    foreach ($relativePath in $script:HubTransactionalDirectories) {
        $matches = @($directories | Where-Object { "$($_.RelativePath)" -eq $relativePath })
        if ($matches.Count -ne 1) {
            throw "Snapshot truncado: estado de diretorio ausente ou duplicado: $relativePath"
        }
        if ([bool]$matches[0].Existed) { Assert-HubTreeBackup $matches[0] }
    }

    $files = @($State.Files)
    if ($files.Count -ne $script:HubTransactionalFiles.Count) {
        throw 'Snapshot truncado: lista de arquivos transacionais incompleta.'
    }
    foreach ($relativePath in $script:HubTransactionalFiles) {
        $matches = @($files | Where-Object { "$($_.RelativePath)" -eq $relativePath })
        if ($matches.Count -ne 1) {
            throw "Snapshot truncado: estado de arquivo ausente ou duplicado: $relativePath"
        }
        if ([bool]$matches[0].Existed) {
            $backup = Join-Path (Join-Path $TransactionDir 'files') $relativePath
            $digest = Get-FileDigest $backup
            if ([long]$matches[0].Length -ne [long]$digest.Length -or
                -not [string]::Equals(
                    "$($matches[0].Sha256)", "$($digest.Sha256)",
                    [System.StringComparison]::OrdinalIgnoreCase
                )) {
                throw "Snapshot truncado: bytes divergem para arquivo: $relativePath"
            }
        }
    }

    $configState = @($files | Where-Object { "$($_.RelativePath)" -eq 'config.json' })[0]
    if (
        $script:IsWindowsPlatform -and
        [bool]$configState.Existed -and
        -not "$($State.ConfigAclSddl)"
    ) {
        throw 'Snapshot truncado: SDDL original do config.json ausente.'
    }

    if ([bool]$State.ServiceExistedBefore) {
        if ("$($State.RegistryServiceBackup)" -ne 'service.reg') {
            throw 'Snapshot truncado: marcador do registro do servico invalido.'
        }
        $registryBackup = Join-Path $TransactionDir 'service.reg'
        $digest = Get-FileDigest $registryBackup
        if ([long]$State.RegistryServiceBackupLength -ne [long]$digest.Length -or
            -not [string]::Equals(
                "$($State.RegistryServiceBackupSha256)", "$($digest.Sha256)",
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
            throw 'Snapshot truncado: bytes do registro do servico divergem.'
        }
        if ("$($State.RegistryServiceAclBackup)" -ne 'service-acl.json') {
            throw 'Snapshot truncado: marcador de ACL do servico invalido.'
        }
        $aclDigest = Get-FileDigest (Join-Path $TransactionDir 'service-acl.json')
        if ([long]$State.RegistryServiceAclBackupLength -ne [long]$aclDigest.Length -or
            -not [string]::Equals(
                "$($State.RegistryServiceAclBackupSha256)", "$($aclDigest.Sha256)",
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
            throw 'Snapshot truncado: bytes das ACLs do servico divergem.'
        }
    }

    if ("$($State.FirewallSnapshot)" -ne 'firewall.json') {
        throw 'Snapshot truncado: marcador do firewall invalido.'
    }
    $firewallDigest = Get-FileDigest (Join-Path $TransactionDir 'firewall.json')
    if ([long]$State.FirewallSnapshotLength -ne [long]$firewallDigest.Length -or
        -not [string]::Equals(
            "$($State.FirewallSnapshotSha256)", "$($firewallDigest.Sha256)",
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'Snapshot truncado: bytes do firewall divergem.'
    }
}

function New-ProvisionCapability {
    if ($InstallerTransactionId -notmatch '^[A-Za-z0-9_-]{16,80}$') {
        throw 'InstallerTransactionId invalido para capability de provisioning.'
    }
    $state = Read-HubSnapshotState
    Assert-HubSnapshotComplete $state

    $capabilityPath = Join-Path $TransactionDir 'provision-capability.json'
    $capabilitiesDir = Join-Path (Join-Path (Join-Path $Root 'data') `
        'installer-transactions') 'provision-capabilities'
    $recordPath = Join-Path $capabilitiesDir "$InstallerTransactionId.json"
    if (Test-Path -LiteralPath $capabilityPath) {
        throw 'Capability de provisioning ja existe nesta transacao do ExpedSetup.'
    }
    if (Test-Path -LiteralPath $recordPath) {
        throw 'Verifier de capability ja existe para InstallerTransactionId.'
    }
    if (-not (Test-Path -LiteralPath $capabilitiesDir)) {
        New-Item -ItemType Directory -Force -Path $capabilitiesDir | Out-Null
    }
    Protect-AdministratorPath $capabilitiesDir -Directory

    $nonceBytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($nonceBytes)
        $expiresAtUtc = [DateTime]::UtcNow.AddMinutes(10).ToString(
            'o', [System.Globalization.CultureInfo]::InvariantCulture
        )
        $normalizedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
        $capability = [pscustomobject]@{
            Schema = 'exped-setup-provision-v1'
            TransactionId = $InstallerTransactionId
            Root = $normalizedRoot
            ExpiresAtUtc = $expiresAtUtc
            Nonce = [Convert]::ToBase64String($nonceBytes)
        }
        $record = [pscustomobject]@{
            Schema = 'exped-setup-provision-v1'
            TransactionId = $InstallerTransactionId
            Root = $normalizedRoot
            ExpiresAtUtc = $expiresAtUtc
            CapabilityHash = (Get-BytesSha256Hex $nonceBytes)
        }
        try {
            Write-JsonAtomically $recordPath $record
            Protect-AdministratorPath $recordPath
            Write-JsonAtomically $capabilityPath $capability
            Protect-AdministratorPath $capabilityPath
        } catch {
            if (Test-Path -LiteralPath $recordPath) {
                Remove-Item -LiteralPath $recordPath -Force
            }
            if (Test-Path -LiteralPath $capabilityPath) {
                Remove-Item -LiteralPath $capabilityPath -Force
            }
            throw
        }
    } finally {
        $rng.Dispose()
        [Array]::Clear($nonceBytes, 0, $nonceBytes.Length)
    }
}

function Restore-HubSnapshot {
    $state = Read-HubSnapshotState
    Assert-HubSnapshotComplete $state
    if ($script:IsWindowsPlatform) { Stop-HubServiceIfPresent }
    if (-not $state.ServiceExistedBefore -and $script:IsWindowsPlatform) {
        Remove-HubServiceCreatedByAttempt
    }

    foreach ($entry in @($state.Directories)) {
        $relativePath = "$($entry.RelativePath)"
        if ($script:HubTransactionalDirectories -notcontains $relativePath) {
            throw "Diretorio fora da allowlist no snapshot: $relativePath"
        }
        $destination = Join-Path $Root $relativePath
        if (Test-Path -LiteralPath $destination) {
            Remove-Item -LiteralPath $destination -Recurse -Force
        }
        if ($entry.Existed) {
            Copy-HubTreeExact (Join-Path (Join-Path $TransactionDir 'payload') $relativePath) $destination
        }
    }

    foreach ($entry in @($state.Files)) {
        $relativePath = "$($entry.RelativePath)"
        if ($script:HubTransactionalFiles -notcontains $relativePath) {
            throw "Arquivo fora da allowlist no snapshot: $relativePath"
        }
        $destination = Join-Path $Root $relativePath
        if ($entry.Existed) {
            $backup = Join-Path (Join-Path $TransactionDir 'files') $relativePath
            if (-not (Test-Path -LiteralPath $backup -PathType Leaf)) {
                throw "Backup de arquivo ausente: $relativePath"
            }
            Write-BytesAtomically $destination ([System.IO.File]::ReadAllBytes($backup))
        } elseif (Test-Path -LiteralPath $destination) {
            Remove-Item -LiteralPath $destination -Force
        }
    }

    $configState = @($state.Files | Where-Object { "$($_.RelativePath)" -eq 'config.json' })[0]
    if ($script:IsWindowsPlatform -and [bool]$configState.Existed) {
        $configPath = Join-Path $Root 'config.json'
        $configSecurity = New-Object System.Security.AccessControl.FileSecurity
        $configSecurity.SetSecurityDescriptorSddlForm(
            "$($state.ConfigAclSddl)",
            [System.Security.AccessControl.AccessControlSections]::All
        )
        Set-Acl -LiteralPath $configPath -AclObject $configSecurity
    }

    $firewallFailure = $null
    try {
        Restore-FirewallSnapshot $state
    } catch {
        $firewallFailure = $_
        Write-Warning "Rollback do firewall falhou; arquivos ja foram restaurados e o servico ainda sera restaurado: $($_.Exception.Message)"
    }

    $serviceFailure = $null
    try {
        Restore-HubServiceSnapshot $state
    } catch {
        $serviceFailure = $_
    }
    $watchdogFailure = $null
    try {
        Restore-LegacyWatchdogTaskState $state
    } catch {
        $watchdogFailure = $_
    }
    if ($firewallFailure -or $serviceFailure -or $watchdogFailure) {
        $firewallMessage = if ($firewallFailure) { $firewallFailure.Exception.Message } else { 'ok' }
        $serviceMessage = if ($serviceFailure) { $serviceFailure.Exception.Message } else { 'ok' }
        $watchdogMessage = if ($watchdogFailure) { $watchdogFailure.Exception.Message } else { 'ok' }
        throw "Rollback incompleto. Firewall=$firewallMessage Servico=$serviceMessage Watchdog=$watchdogMessage"
    }
}

function Assert-CompleteHubStatus($Status) {
    if ($null -eq $Status) { throw '/status ausente ou invalido.' }
    if ($null -eq $Status.storage -or $Status.storage.running -ne $true) {
        throw '/status: storage nao esta running.'
    }

    foreach ($peerName in @('postgres', 'postgrest', 'gotrue', 'gateway', 'app', 'events', 'frontdoor')) {
        $matches = @($Status.peers | Where-Object { $_.name -eq $peerName -and $_.running -eq $true })
        if ($matches.Count -ne 1) { throw "/status: peer essencial $peerName nao esta running." }
    }

    if ($Status.agent.survivesRebootWithoutLogon -ne $false) {
        throw '/status: Agent afirmou recuperacao sem login sem garantia real.'
    }
    if ($Status.agent.startupMode -eq 'disabled') {
        if ($Status.agent.enabled -ne $false -or $Status.agent.running -ne $false) {
            throw '/status: Agent disabled reportou processo habilitado.'
        }
    } elseif ($Status.agent.startupMode -eq 'interactive_logon') {
        if ($Status.agent.enabled -ne $true -or $Status.agent.running -ne $true) {
            throw '/status: Agent interactive_logon nao esta em execucao.'
        }
        if ([int]$Status.agent.syncNowPort -gt 0 -and $Status.agent.syncNowReady -ne $true) {
            throw '/status: endpoint do botao Sincronizar nao esta pronto.'
        }
        if ($Status.agent.hiper.connected -ne $true) {
            throw '/status: Agent em execucao, mas nao conectou ao Hiper.'
        }
        if ($Status.agent.hiper.queryOk -ne $true) {
            throw '/status: Agent em execucao, mas a consulta read-only ao Hiper falhou.'
        }
        if ($Status.agent.hiper.schemaCompatible -ne $true -or
            $Status.agent.hiper.targetSchema -ne 'Exped Agent schema v1') {
            throw '/status: probe nao comprovou o contrato de schema Exped Agent v1.'
        }
    } else {
        throw '/status: startupMode do Agent nao suportado.'
    }

    if ($Status.sync.enabled -ne $true) { throw '/status: sync cloud nao esta enabled.' }
    if (-not ($Status.sync.PSObject.Properties.Name -contains 'lastError')) {
        throw '/status: sync.lastError ausente.'
    }
    if ($null -ne $Status.sync.lastError) {
        throw "/status: sync cloud com lastError: $($Status.sync.lastError)"
    }
    if ($Status.sync.lastSyncOk -ne $true) {
        throw '/status: sync cloud ainda nao concluiu um ciclo com sucesso.'
    }
    $lastSyncAt = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse("$($Status.sync.lastSyncAt)", [ref]$lastSyncAt)) {
        throw '/status: sync cloud sem lastSyncAt valido.'
    }
    return $true
}

function Wait-CompleteHubStatus {
    if ($StatusTimeoutSeconds -lt 1 -or $StatusTimeoutSeconds -gt 900) {
        throw 'StatusTimeoutSeconds deve estar entre 1 e 900.'
    }
    if ($TransactionDir) {
        $snapshot = Read-HubSnapshotState
        Assert-HubSnapshotComplete $snapshot
    }
    $configPath = Join-Path $Root 'config.json'
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw "config.json ausente para health final: $configPath"
    }
    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    $appPort = if ($config.ports -and $config.ports.app) { [int]$config.ports.app } else { 3000 }
    $statusPort = if ($config.ports -and $config.ports.status) {
        [int]$config.ports.status
    } else { $appPort + 1 }
    if ($statusPort -lt 1 -or $statusPort -gt 65535) { throw 'ports.status invalida.' }

    $statusUrl = "http://127.0.0.1:$statusPort/status"
    $deadline = (Get-Date).AddSeconds($StatusTimeoutSeconds)
    $lastFailure = 'sem resposta'
    do {
        try {
            $response = Invoke-WebRequest -Uri $statusUrl -UseBasicParsing -TimeoutSec 5
            $status = $response.Content | ConvertFrom-Json
            $null = Assert-CompleteHubStatus $status
            Write-Host "Health completo comprovado em $statusUrl"
            return
        } catch {
            $lastFailure = $_.Exception.Message
        }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $deadline)
    throw "Timeout aguardando /status completo em $statusUrl. Ultimo diagnostico: $lastFailure"
}

function Set-HubVersionAtomically {
    if (-not $AppVersion -or $AppVersion.Length -gt 128 -or $AppVersion -match '[\x00-\x1f]') {
        throw 'AppVersion ausente ou invalida para StampHubVersion.'
    }
    $configPath = Join-Path $Root 'config.json'
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw "config.json ausente para carimbo de versao: $configPath"
    }
    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    $config | Add-Member -NotePropertyName version -NotePropertyValue $AppVersion -Force
    $json = $config | ConvertTo-Json -Depth 12
    Write-BytesAtomically $configPath $utf8NoBom.GetBytes($json)
}

function Invoke-Netsh($Arguments, $AllowedExitCodes = @(0)) {
    return Invoke-NativeChecked 'netsh.exe' $Arguments $AllowedExitCodes
}

function Get-UrlAclSddl($Output) {
    foreach ($line in ("$Output" -split "`r?`n")) {
        $index = $line.IndexOf('D:(', [System.StringComparison]::OrdinalIgnoreCase)
        if ($index -ge 0) { return $line.Substring($index).Trim() }
    }
    return $null
}

function Read-JsonFile($Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
}

function Get-AgentUrlAclState($Config) {
    if ($null -eq $Config -or -not $Config.agent) {
        return [pscustomobject]@{ Port = 0; Sid = ''; ExpectedSddl = '' }
    }
    $agent = $Config.agent
    if ($null -ne $agent.urlAclPort) {
        $port = [int]$agent.urlAclPort
    } elseif ($agent.settingsPath -and (Test-Path -LiteralPath "$($agent.settingsPath)")) {
        $settings = Read-JsonFile "$($agent.settingsPath)"
        $port = if ($settings.Agent -and $null -ne $settings.Agent.SyncNowPort) {
            [int]$settings.Agent.SyncNowPort
        } else { 5005 }
    } else {
        $port = 0
    }
    if ($port -lt 0 -or $port -gt 65535) { throw "Porta de URL ACL invalida no snapshot: $port" }
    $sid = if (Test-UserSid $agent.urlAclUserSid) {
        "$($agent.urlAclUserSid)"
    } elseif (Test-UserSid $agent.userSid) {
        "$($agent.userSid)"
    } else { '' }
    if ($port -gt 0 -and -not $sid) { throw 'Snapshot de URL ACL sem SID valido.' }
    $sddl = if ($port -gt 0) { "D:(A;;GX;;;$sid)" } else { '' }
    return [pscustomobject]@{ Port = $port; Sid = $sid; ExpectedSddl = $sddl }
}

function Get-CurrentUrlAclSddl([int]$Port) {
    $url = "http://127.0.0.1:$Port/"
    $query = Invoke-Netsh @('http', 'show', 'urlacl', "url=$url") @(0, 1)
    return Get-UrlAclSddl $query.Output
}

function Ensure-AgentUrlAcl($State) {
    if ($State.Port -le 0) { return }
    $url = "http://127.0.0.1:$($State.Port)/"
    $actual = Get-CurrentUrlAclSddl $State.Port
    if ($actual) {
        if (-not [string]::Equals($actual, $State.ExpectedSddl, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Rollback recusado: URL ACL pertence a outro SDDL. Atual=$actual Esperado=$($State.ExpectedSddl)"
        }
        return
    }
    $null = Invoke-Netsh @('http', 'add', 'urlacl', "url=$url", "sddl=$($State.ExpectedSddl)")
}

function Remove-AgentUrlAcl($State) {
    if ($State.Port -le 0) { return }
    $url = "http://127.0.0.1:$($State.Port)/"
    $actual = Get-CurrentUrlAclSddl $State.Port
    if (-not $actual) { return }
    if (-not [string]::Equals($actual, $State.ExpectedSddl, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Rollback recusado: URL ACL atual pertence a outro SDDL. Atual=$actual Esperado=$($State.ExpectedSddl)"
    }
    $null = Invoke-Netsh @('http', 'delete', 'urlacl', "url=$url")
}

function Replace-AgentUrlAcl($Current, $Previous) {
    $url = "http://127.0.0.1:$($Current.Port)/"
    $actual = Get-CurrentUrlAclSddl $Current.Port
    if ([string]::Equals($actual, $Previous.ExpectedSddl, [System.StringComparison]::OrdinalIgnoreCase)) {
        return
    }
    if (-not [string]::Equals($actual, $Current.ExpectedSddl, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Troca de URL ACL recusada: SDDL atual inesperado. Atual=$actual Esperado=$($Current.ExpectedSddl)"
    }

    $null = Invoke-Netsh @('http', 'delete', 'urlacl', "url=$url")
    try {
        $null = Invoke-Netsh @('http', 'add', 'urlacl', "url=$url", "sddl=$($Previous.ExpectedSddl)")
        $restored = Get-CurrentUrlAclSddl $Previous.Port
        if (-not [string]::Equals(
            $restored, $Previous.ExpectedSddl, [System.StringComparison]::OrdinalIgnoreCase
        )) {
            throw "SDDL anterior nao foi confirmado apos add. Atual=$restored"
        }
    } catch {
        $restoreFailure = $_.Exception.Message
        $currentAfterFailure = Get-CurrentUrlAclSddl $Current.Port
        if (-not $currentAfterFailure) {
            try {
                $null = Invoke-Netsh @('http', 'add', 'urlacl', "url=$url", "sddl=$($Current.ExpectedSddl)")
            } catch {
                throw "Troca de SID falhou e o add compensatorio do SDDL atual falhou. Original=$restoreFailure Compensacao=$($_.Exception.Message)"
            }
        }
        $currentAfterCompensation = Get-CurrentUrlAclSddl $Current.Port
        if (-not [string]::Equals(
            $currentAfterCompensation, $Current.ExpectedSddl, [System.StringComparison]::OrdinalIgnoreCase
        )) {
            throw "Troca de SID falhou e o SDDL atual nao foi recuperado. Atual=$currentAfterCompensation Original=$restoreFailure"
        }
        throw "Troca de SID falhou; o SDDL atual foi restaurado por compensacao. Original=$restoreFailure"
    }
}

function Get-SnapshotConfig($State) {
    $configState = @($State.Files | Where-Object { $_.RelativePath -eq 'config.json' })
    if ($configState.Count -ne 1 -or -not $configState[0].Existed) { return $null }
    return Read-JsonFile (Join-Path (Join-Path $TransactionDir 'files') 'config.json')
}

function Get-AgentUrlAclStateFromPlan($Value, $Label) {
    $port = [int]$Value.Port
    if ($port -lt 0 -or $port -gt 65535) { throw "$Label contem porta invalida: $port" }
    $sid = "$($Value.Sid)"
    if ($port -gt 0 -and -not (Test-UserSid $sid)) {
        throw "$Label contem SID invalido."
    }
    return [pscustomobject]@{
        Port = $port
        Sid = if ($port -gt 0) { $sid } else { '' }
        ExpectedSddl = if ($port -gt 0) { "D:(A;;GX;;;$sid)" } else { '' }
    }
}

function Rollback-AgentUrlAcl {
    $snapshot = Read-HubSnapshotState
    $planPath = Join-Path $TransactionDir 'urlacl-rollback.json'
    if (Test-Path -LiteralPath $planPath -PathType Leaf) {
        $plan = Read-JsonFile $planPath
        if ("$($plan.Schema)" -ne 'exped-urlacl-rollback-v1') {
            throw 'Schema do plano de rollback da URL ACL invalido.'
        }
        $previous = Get-AgentUrlAclStateFromPlan $plan.Previous 'Previous'
        $current = Get-AgentUrlAclStateFromPlan $plan.Current 'Current'
    } else {
        $previousConfig = Get-SnapshotConfig $snapshot
        $currentConfig = Read-JsonFile (Join-Path $Root 'config.json')
        $previous = Get-AgentUrlAclState $previousConfig
        $current = Get-AgentUrlAclState $currentConfig
    }
    $samePort = $previous.Port -eq $current.Port
    $sameSid = [string]::Equals($previous.Sid, $current.Sid, [System.StringComparison]::OrdinalIgnoreCase)
    if ($samePort -and $sameSid) { return }
    if ($samePort -and $previous.Port -gt 0) {
        Replace-AgentUrlAcl $current $previous
        return
    }

    # Different ports can overlap safely: restore the previous URL first, then
    # remove only the reservation whose current SDDL is still exact.
    Ensure-AgentUrlAcl $previous
    Remove-AgentUrlAcl $current
}

try {
    switch ($Operation) {
        'PreflightUser' { Assert-OriginalInteractiveUser; break }
        'SnapshotHub' { New-HubSnapshot; break }
        'SuspendLegacyWatchdog' { Suspend-LegacyWatchdogTask; break }
        'RestoreLegacyWatchdog' {
            $state = Read-HubSnapshotState
            Assert-LegacyWatchdogSnapshotState $state
            Restore-LegacyWatchdogTaskState $state
            break
        }
        'RestoreHub' { Restore-HubSnapshot; break }
        'RollbackAgentUrlAcl' { Rollback-AgentUrlAcl; break }
        'StampHubVersion' { Set-HubVersionAtomically; break }
        'IssueProvisionCapability' { New-ProvisionCapability; break }
        'VerifyCompleteStatus' { Wait-CompleteHubStatus; break }
        'FinalizeHub' {
            if ($TransactionDir -and (Test-Path -LiteralPath $TransactionDir)) {
                Remove-Item -LiteralPath $TransactionDir -Recurse -Force
            }
            break
        }
        'QueryHubRunning' {
            $service = Get-HubService
            if ($service -and $service.Status -eq [System.ServiceProcess.ServiceControllerStatus]::Running) {
                exit 0
            }
            if ($service) { exit 3 }
            exit 4
        }
        'QueryProvisionedConfig' {
            if (Test-ProvisionedCloudConfig) { exit 0 }
            exit 4
        }
        'StopHub' { Stop-HubServiceIfPresent; break }
        'StartHub' {
            $service = Get-HubService
            if (-not $service) { throw "Servico $ServiceName nao existe para restauracao." }
            if ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Running) {
                Start-Service -Name $ServiceName -ErrorAction Stop
                (Get-Service -Name $ServiceName).WaitForStatus(
                    [System.ServiceProcess.ServiceControllerStatus]::Running,
                    [TimeSpan]::FromSeconds(30)
                )
            }
            break
        }
        'ProtectCredentials' {
            if (-not $CredentialsFile -or -not (Test-Path -LiteralPath $CredentialsFile -PathType Leaf)) {
                throw 'CredentialsFile ausente para protecao.'
            }
            Protect-AdministratorPath $CredentialsFile
            break
        }
    }
    exit 0
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
