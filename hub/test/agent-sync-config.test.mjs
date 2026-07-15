import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readJson(path) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
}

function readSource(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

function routine(text, name) {
  const start = text.search(new RegExp(`^(?:function|procedure)\\s+${name}\\b`, 'm'));
  if (start < 0) return '';
  const rest = text.slice(start);
  const next = rest.slice(1).search(/^\s*(?:function|procedure)\s+[\w-]+\b/m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function sectionEntries(source, section) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `[${section.toLowerCase()}]`);
  if (start < 0) return [];

  const entries = [];
  let current = '';
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (/^\[.+\]$/.test(line)) break;
    if (!line || line.startsWith(';')) continue;
    current += `${current ? ' ' : ''}${line.replace(/\\$/, '').trim()}`;
    if (!line.endsWith('\\')) {
      entries.push(current);
      current = '';
    }
  }
  return entries;
}

function powerShellPattern(source, variableName) {
  const match = source.match(new RegExp(`\\$script:${variableName}\\s*=\\s*'([^']+)'`));
  return match ? new RegExp(match[1], 'i') : null;
}

describe('configuração do sync sob demanda', () => {
  it('mantém Hub e agente na mesma porta padrão', () => {
    const hub = readJson('../win/config.example.json');
    const agent = readJson('../../agent/ExpedAgent/appsettings.json');

    expect(hub.agent.syncNowPort).toBe(5005);
    expect(agent.Agent.SyncNowPort).toBe(hub.agent.syncNowPort);
  });

  it('usa helper atômico no serviço e no helper do usuário, sem provision direto do Agent', () => {
    const install = readSource('../win/install-service.ps1');
    const provision = readSource('../win/provision.ps1');
    const userInstall = readSource('../win/agent-user-install.ps1');
    const helperUrl = new URL('../win/agent-settings.ps1', import.meta.url);

    expect(existsSync(helperUrl)).toBe(true);
    const helper = existsSync(helperUrl) ? readFileSync(helperUrl, 'utf8') : '';
    expect(helper).toContain('[System.IO.File]::Replace(');
    expect(install).toMatch(/Set-ExpedAgentSettings[\s\S]*-SyncNowPort/);
    expect(userInstall).toMatch(/Set-ExpedAgentSettings[\s\S]*-UpdateCredentials/);
    expect(provision).toContain('Write-ExpedJsonAtomically $configPath $config');
    expect(provision).not.toContain('Set-ExpedAgentSettings');
    expect(provision).not.toMatch(/Join-Path \$env:LOCALAPPDATA/);
  });

  it('provisionamento direto falha antes de credencial/mutacao e apenas o Inno pode deferir', () => {
    const provision = readSource('../win/provision.ps1');
    const setup = readSource('../win/exped-setup.iss');
    const run = sectionEntries(setup, 'Run');

    expect(provision).toContain('DeferAgent');
    expect(provision).toContain('InstallerTransactionId');
    const directGuard = provision.indexOf("if (-not $DeferAgent)");
    expect(directGuard).toBeGreaterThanOrEqual(0);
    expect(directGuard).toBeLessThan(provision.indexOf('$logDir'));
    expect(directGuard).toBeLessThan(provision.indexOf('Invoke-RestMethod'));
    expect(provision.slice(directGuard, provision.indexOf('$logDir'))).toMatch(/ExpedSetup|fluxo do instalador/i);
    expect(provision).toMatch(/\$Code\s*-or\s*\$DeviceToken[\s\S]*(?:CredentialsFile|ExpedSetup)/i);
    expect(run).toEqual([]);
    expect(setup).toMatch(/provision\.ps1[\s\S]*-CredentialsFile[\s\S]*-DeferAgent[\s\S]*-InstallerTransactionId/);
    expect(setup).not.toContain('-Code');
    expect(setup).not.toContain('-DeviceToken');
  });

  it('instala, configura e inicia o agente sob o usuário original em ordem segura', () => {
    const setup = readSource('../win/exped-setup.iss');
    const files = sectionEntries(setup, 'Files');
    const agentFiles = files.filter((entry) => entry.includes('{#AgentPublish}') || entry.includes('{#AgentStartCmd}'));
    const originalUserWrapper = routine(setup, 'ExecOriginalUserChecked');
    const installCode = routine(setup, 'RunTransactionalInstall');
    const provisionIndex = installCode.indexOf('provision.ps1');
    const installUserIndex = installCode.indexOf("'-Install -Root");
    const installHubIndex = installCode.indexOf('install-service.ps1');
    const startUserIndex = installCode.indexOf("'-Start -Root");

    expect(agentFiles.length).toBeGreaterThan(0);
    expect(agentFiles.every((entry) => entry.includes('DestDir: "{app}\\agent-stage"'))).toBe(true);
    expect(originalUserWrapper).toContain('ExecAsOriginalUser');
    expect(installCode.match(/ExecOriginalUserChecked/g)?.length).toBeGreaterThanOrEqual(2);
    expect([provisionIndex, installUserIndex, installHubIndex, startUserIndex]).toEqual(
      [...[provisionIndex, installUserIndex, installHubIndex, startUserIndex]].sort((a, b) => a - b),
    );
    expect(Math.min(provisionIndex, installUserIndex, installHubIndex, startUserIndex)).toBeGreaterThanOrEqual(0);
    expect(files.some((entry) => entry.includes('DestDir: "{localappdata}'))).toBe(false);
  });

  it('propaga ports.app ao ApiBaseUrl do Agent', () => {
    const helper = readSource('../win/agent-user-install.ps1');
    expect(helper).toMatch(/ports\.app[\s\S]*ApiBaseUrl/i);
    expect(helper).not.toMatch(/ApiBaseUrl\s+'http:\/\/127\.0\.0\.1:3000'/);
  });

  it('usa recibo por nonce + SID exato, sem procurar perfis', () => {
    const install = readSource('../win/install-service.ps1');
    const setup = readSource('../win/exped-setup.iss');
    const helperUrl = new URL('../win/agent-user-install.ps1', import.meta.url);

    expect(existsSync(helperUrl)).toBe(true);
    const helper = existsSync(helperUrl) ? readFileSync(helperUrl, 'utf8') : '';
    expect(setup).toContain('ExecAsOriginalUser');
    expect(helper).toContain('GetOwnerSid');
    expect(helper).toContain('Get-ExpedFileOwnerSid');
    expect(helper).toContain('InstallReceipts');
    expect(helper).toContain("'receipt-transition'");
    expect(install).toContain('AgentReceiptId');
    expect(install).toContain("'receipt-transition'");
    expect(install).toMatch(/desinstale[\s\S]*migre/i);
    const elevatedCall = install.match(/-Arguments @\('receipt-transition', ([^)]+)\)/);
    expect(elevatedCall?.[1].split(',').map((arg) => arg.trim())).toEqual([
      '$existingSettingsPath',
      '$existingUserSid',
      '$existingSettingsOwnerSid',
      '$receiptSettingsPath',
      '$receipt.UserSid',
    ]);
    const installMode = helper.indexOf('if ($Install)');
    const preflight = helper.indexOf('Assert-AgentReceiptTransition $hubConfig', installMode);
    const installEffects = [
      'New-AgentTransaction',
      'Get-ThisUserAgentProcesses $agentExe | Stop-Process -Force',
      'Copy-Item -LiteralPath $item.FullName',
      'Set-ExpedAgentSettings -SettingsPath $settingsPath',
      '($vbsLines -join',
      'InstallReceipts',
    ].map((needle) => helper.indexOf(needle, installMode));
    expect(preflight).toBeGreaterThan(installMode);
    expect(installEffects.every((index) => index > preflight)).toBe(true);
    expect(install).not.toMatch(/Get-ChildItem[^\r\n]*Users|Get-Process -Name 'ExpedAgent'/);
  });

  it('migra config legada pelo owner SID exato ou por parâmetro explícito', () => {
    const install = readSource('../win/install-service.ps1');
    const helper = readSource('../win/agent-settings.ps1');

    expect(install).toContain('[string]$AgentUserSid');
    expect(helper).toContain('Get-ExpedFileOwnerSid');
    expect(helper).toContain('GetOwner([System.Security.Principal.SecurityIdentifier])');
    expect(install).toMatch(/agentSettingsPath[\s\S]*Get-ExpedFileOwnerSid[\s\S]*NotePropertyName userSid/);
    expect(install).toMatch(/AgentUserSid[\s\S]*Test-ExpedUserSid/);
    expect(install).not.toMatch(/Environment\]::UserName|Win32_UserProfile|C:\\Users\\\*/);
  });

  it('desinstala agente e Startup no contexto do SID original por handoff interativo', () => {
    const setup = readSource('../win/exped-setup.iss');
    const uninstall = readSource('../win/uninstall-service.ps1');
    const helper = readSource('../win/agent-user-install.ps1');
    const uninstallRun = sectionEntries(setup, 'UninstallRun');

    expect(uninstallRun).toEqual([]);
    const uninstallCode = setup.slice(setup.indexOf('procedure CurUninstallStepChanged'));
    for (const contractPart of [
      'usUninstall',
      'uninstall-service.ps1',
      'Exec(PowerShellPath',
      'ResultCode <> 0',
      'Abort',
    ]) expect(uninstallCode).toContain(contractPart);
    expect(uninstallCode.indexOf('Exec(PowerShellPath')).toBeLessThan(
      uninstallCode.indexOf('ResultCode <> 0'),
    );
    expect(uninstall).toContain('TASK_LOGON_INTERACTIVE_TOKEN');
    expect(uninstall).toContain('agent-user-install.ps1');
    expect(uninstall).toContain('-Uninstall');
    expect(uninstall).toContain('UninstallReceipts');
    expect(helper).toContain('[switch]$Uninstall');
    expect(helper).toMatch(/ExpectedUserSid[\s\S]*Get-VerifiedInteractiveUserSid/);
    expect(helper).toMatch(/Get-ThisUserAgentProcesses[\s\S]*Stop-Process/);
    expect(helper).toMatch(/Remove-Item[^\r\n]*startupVbs/);
    expect(helper).toMatch(/Remove-Item[^\r\n]*agentDir/);
    expect(uninstall).toContain('$agentCleanupComplete');
    expect(uninstall).toContain('DESINSTALACAO ABORTADA');
    expect(uninstall).toMatch(/exit 2/);
    const teardown = uninstall.slice(uninstall.indexOf('$agentCleanupComplete = $true'));
    expect(teardown.indexOf('if (-not $agentCleanupComplete)')).toBeLessThan(
      teardown.indexOf('if (Test-Path $Nssm)'),
    );
    expect(teardown.indexOf('exit 2')).toBeLessThan(teardown.indexOf('if (Test-Path $Nssm)'));
  });

  it('gerencia URL ACL no install, disable e uninstall sem nomes localizados', () => {
    const install = readSource('../win/install-service.ps1');
    const uninstall = readSource('../win/uninstall-service.ps1');

    expect(install).toContain('agent-sync-contract.mjs');
    expect(install).toContain("'urlacl-plan'");
    expect(install).toContain('expectedSddl');
    expect(install).toContain('rollbackArgs');
    expect(install).toMatch(/catch[\s\S]*rollbackArgs[\s\S]*Invoke-NetshCommand/);
    expect(install).toContain('Get-ExpedInstalledAgentSyncNowPort');
    expect(install).toMatch(
      /urlAclPort[\s\S]*Get-ExpedInstalledAgentSyncNowPort[\s\S]*Get-AgentUrlAclPlan/,
    );
    expect(install).not.toMatch(/urlacl[^\r\n]*(?:user=|['"](?:Users|Usuários|Administrators)['"])/i);
    expect(uninstall).toContain('urlAclPort');
    expect(uninstall).toContain('urlAclUserSid');
    expect(uninstall).toMatch(/@\('http', 'show', 'urlacl'/);
    expect(uninstall).toContain('[string]::Equals');
    expect(uninstall).toMatch(/@\('http', 'delete', 'urlacl'/);

    const planIndex = install.lastIndexOf('foreach ($step in $aclPlan)');
    const settingsIndex = install.lastIndexOf('Set-ExpedAgentSettings');
    const deferredDeleteIndex = install.lastIndexOf('foreach ($step in $deferredAclDeletes)');
    expect([planIndex, settingsIndex, deferredDeleteIndex]).toEqual(
      [...[planIndex, settingsIndex, deferredDeleteIndex]].sort((a, b) => a - b),
    );
    expect(planIndex).toBeGreaterThanOrEqual(0);
  });

  it('nunca registra tokens, segredos ou credenciais de serviço em texto claro', () => {
    const install = readSource('../win/install-service.ps1');
    const pattern = powerShellPattern(install, 'SensitiveEnvNamePattern');

    expect(pattern).not.toBeNull();
    for (const name of [
      'EXPED_DEVICE_TOKEN',
      'EXPED_JWT_SECRET',
      'DATABASE_PASSWORD',
      'SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'EXTERNAL_API_KEY',
    ]) {
      expect(pattern.test(name), `${name} deve ser sigiloso`).toBe(true);
    }
    for (const name of ['PATH', 'EXPED_PG_BIN', 'EXPED_CLOUD_API', 'EXPED_APP_PORT']) {
      expect(pattern.test(name), `${name} pode ser diagnosticado`).toBe(false);
    }

    expect(install).toContain('Protect-ExpedEnvValueForLog');
    expect(install).toContain('Protect-ExpedNativeArgumentsForLog');
    const nativeWrapper = install.slice(
      install.indexOf('function Invoke-NativeChecked'),
      install.indexOf('function Ensure-AgentSection'),
    );
    expect(nativeWrapper).toMatch(/Protect-ExpedNativeArgumentsForLog\s+\$Arguments/);
    expect(nativeWrapper).not.toMatch(/throw[^\r\n]*\$\(\$Arguments -join/);
    const loggingBlock = install.slice(
      install.indexOf('Write-Host "    Env do servico:"'),
      install.indexOf('# ---------------------------------------------------------------------------\n# 3.'),
    );
    expect(loggingBlock).toMatch(/Protect-ExpedEnvValueForLog\s+\$_.Key\s+\$_.Value/);
    expect(loggingBlock).not.toMatch(/Write-Host[^\r\n]*\$\(\$_.Value\)/);
  });

  it('recarrega e tenta novamente falhas transitórias sem reiniciar o agente elevado', () => {
    const install = readSource('../win/install-service.ps1');
    const program = readSource('../../agent/ExpedAgent/Program.cs');
    const puxar = readSource('../../agent/ExpedAgent/PuxarService.cs');

    expect(program).toContain('reloadOnChange: true');
    expect(program).toContain('Configure<AgentConfig>');
    expect(puxar).toContain('IOptionsMonitor<AgentConfig>');
    expect(puxar).toContain('.OnChange(');
    expect(puxar).toMatch(/RetryDelay[\s\S]*Task\.Delay/);
    expect(puxar).toMatch(/Task\.WhenAny\([^)]*(?:retry|delay)[^)]*change/i);
    expect(puxar).toMatch(/Math\.Clamp\([^;]+0,\s*4\)/);
    expect(puxar).toMatch(/Math\.Min\(4000,\s*250\s*\*/);
    expect(install).not.toMatch(/(?:Start|Stop)-Process[^\r\n]*ExpedAgent/i);
  });
});
