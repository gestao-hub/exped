import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function routine(text, name) {
  const start = text.search(new RegExp(`^(?:function|procedure)\\s+${name}\\b`, 'mi'));
  if (start < 0) return '';
  const rest = text.slice(start);
  const next = rest.slice(1).search(/^\s*(?:function|procedure)\s+[\w-]+\b/mi);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe('hardening do instalador Windows', () => {
  const setup = source('../win/exped-setup.iss');
  const hubOnly = source('../win/exped-hub.iss');
  const runbook = source('../win/README.md');
  const install = source('../win/install-service.ps1');
  const orchestrator = existsSync(new URL('../win/installer-orchestrator.ps1', import.meta.url))
    ? source('../win/installer-orchestrator.ps1')
    : '';
  const download = source('../win/download-binaries.ps1');
  const workflow = source('../../.github/workflows/build-installer.yml');
  const agentStart = source('../../agent/installer/start.cmd');
  const agentSettings = JSON.parse(source('../../agent/ExpedAgent/appsettings.json'));
  const standaloneAgent = source('../../agent/installer/ExpedAgent.iss');

  it('usa AppIds explícitos, distintos e compatíveis com os nomes legados', () => {
    const unifiedId = setup.match(/^AppId=(.+)$/m)?.[1].trim();
    const hubId = hubOnly.match(/^AppId=(.+)$/m)?.[1].trim();
    expect(unifiedId).toBe('Exped');
    expect(hubId).toBe('Exped Hub');
    expect(unifiedId).not.toBe(hubId);
    expect(setup).toMatch(/uninstall-service\.ps1[\s\S]*-ManageAgent true/);
    expect(hubOnly).toMatch(/uninstall-service\.ps1[\s\S]*-ManageAgent false/);
  });

  it('só finaliza snapshots depois de /status completo', () => {
    const installFlow = routine(setup, 'RunTransactionalInstall') ||
      setup.slice(setup.indexOf('procedure CurStepChanged'));
    const health = installFlow.indexOf("OrchestratorParams('VerifyCompleteStatus'");
    const provisionFinalize = installFlow.indexOf('-FinalizeTransaction');
    const hubFinalize = installFlow.indexOf("OrchestratorParams('FinalizeHub'");
    const agentFinalize = installFlow.indexOf("'-Finalize -Root");
    expect([health, provisionFinalize, hubFinalize, agentFinalize].every((i) => i >= 0)).toBe(true);
    expect([health, provisionFinalize, hubFinalize, agentFinalize]).toEqual(
      [...[health, provisionFinalize, hubFinalize, agentFinalize]].sort((a, b) => a - b),
    );
    const verify = routine(orchestrator, 'Assert-CompleteHubStatus');
    for (const marker of [
      'storage', 'postgres', 'postgrest', 'gotrue', 'gateway', 'app', 'events',
      'frontdoor', 'interactive_logon', 'survivesRebootWithoutLogon', 'hiper',
      'queryOk', 'schemaCompatible', 'sync', 'lastError', 'lastSyncOk', 'lastSyncAt',
    ]) expect(verify).toContain(marker);
  });

  it('usa Invoke-WebRequest compatível com Windows PowerShell 5.1', () => {
    const scripts = [download, install, orchestrator];
    for (const script of scripts) {
      const calls = script.match(/Invoke-WebRequest[^\r\n]*/g) || [];
      for (const call of calls) expect(call).toContain('-UseBasicParsing');
    }
    expect(workflow).toMatch(/shell:\s*powershell[\s\S]*PSVersionTable\.PSVersion\.Major[\s\S]*-ne 5/i);
    expect(workflow).toContain('Language.Parser]::ParseFile');
    expect(workflow).toMatch(/Get-ChildItem\s+agent\/installer\s+-Filter\s+\*\.ps1/i);
  });

  it('baixa todos os binários com retentativa e SHA-256 por tentativa', () => {
    const retry = routine(download, 'Invoke-VerifiedDownload');
    expect(retry).toContain('for ($attempt = 1; $attempt -le $Attempts; $attempt++)');
    expect(retry).toContain('Invoke-WebRequest');
    expect(retry).toContain('Assert-Sha256');
    expect(retry).toContain('Remove-Item');

    const calls = download.match(/Invoke-VerifiedDownload\s+-Uri/g) || [];
    expect(calls).toHaveLength(4);
    expect(download).not.toMatch(/^Invoke-WebRequest\s+-Uri\s+\$(?:pg|pr|node|nssm)Url/m);
  });

  it('protege config.json transacionalmente por SID e restringe firewall', () => {
    const protectAcl = routine(install, 'Protect-ExpedConfigAcl');
    expect(protectAcl).toContain('S-1-5-18');
    expect(protectAcl).toContain('S-1-5-32-544');
    expect(protectAcl).toContain('OperationalUserSid');
    expect(protectAcl).not.toMatch(/['"](?:BUILTIN\\)?(?:Users|Usuarios|Authenticated Users)['"]/i);
    expect(orchestrator).toContain('ConfigAclSddl');
    expect(orchestrator).toMatch(/SetSecurityDescriptorSddlForm\([^)]*ConfigAclSddl/s);

    expect(install).toMatch(/New-NetFirewallRule[\s\S]*-RemoteAddress\s+'?LocalSubnet'?/i);
    expect(install).toMatch(/-Profile\s+[^\r\n]*Domain[^\r\n]*Private/i);
    expect(install).not.toMatch(/-Profile\s+[^\r\n]*Public/i);
  });

  it('captura firewall fiel e não deixa falha dele interromper arquivos/serviço', () => {
    const capture = routine(orchestrator, 'Export-FirewallSnapshot');
    for (const marker of [
      'Direction', 'Action', 'Enabled', 'Profile', 'Protocol', 'LocalPort',
      'RemoteAddress', 'Program', 'Service', 'InterfaceType',
    ]) expect(capture).toContain(marker);

    const restore = routine(orchestrator, 'Restore-HubSnapshot');
    expect(restore).toMatch(/try[\s\S]*Restore-FirewallSnapshot[\s\S]*catch/i);
    expect(restore.indexOf('Restore-FirewallSnapshot')).toBeLessThan(restore.indexOf('Restore-HubServiceSnapshot'));
    expect(restore).toContain('Restore-HubServiceSnapshot');
  });

  it('seleciona IP físico/gateway e valida HTTPS', () => {
    const selectIp = routine(install, 'Resolve-ExpedServerIp');
    const validateIp = routine(install, 'Test-ExpedUsableIpv4');
    expect(selectIp).toContain('IPv4DefaultGateway');
    expect(selectIp).toMatch(/Hyper-V|vEthernet/i);
    expect(selectIp).toMatch(/VPN|TAP|TUN/i);
    expect(validateIp).toMatch(/169[\s\S]*254/);
    expect(validateIp).toContain('127');
    expect(selectIp).toContain('$ServerIp');
    expect(install).toMatch(/https:\/\/["$A-Za-z][^\r\n]*\/login[\s\S]*UseBasicParsing/i);
  });

  it('alinha timeout/métodos NSSM ao shutdown e pg_ctl', () => {
    const serviceEnvironment = routine(install, 'Set-NssmServiceEnvironment');
    expect(install).toMatch(/AppStopMethodConsole['"),\s]+60000/);
    expect(install).toMatch(/AppStopMethodSkip['"),\s]+0/);
    expect(serviceEnvironment).toMatch(
      /SetValue\([\s\S]*AppKillProcessTree[\s\S]*\[int\]0[\s\S]*RegistryValueKind\]::DWord/i,
    );
    expect(install).toMatch(/AppStopMethodWindow/);
    expect(install).toMatch(/AppStopMethodThreads/);
  });

  it('protege o ambiente NSSM sem exigir troca do proprietário da chave existente', () => {
    const serviceEnvironment = routine(install, 'Set-NssmServiceEnvironment');
    const aclSetup = serviceEnvironment.slice(0, serviceEnvironment.indexOf('$key.SetAccessControl'));
    expect(aclSetup).toContain('AccessControlSections]::Access');
    expect(aclSetup).toMatch(/D:P\(A;CI;KA;;;SY\)\(A;CI;KA;;;BA\)/);
    expect(aclSetup).not.toMatch(/O:(?:SY|BA)|G:(?:SY|BA)/);
  });

  it('remove NUL dos diagnósticos pela sobrecarga de string no PowerShell 5.1', () => {
    expect(install).not.toMatch(/\.Replace\(\[char\]0,\s*''\)/);
    expect(install).toContain("([char]0).ToString()");
  });

  it('inclui canário pré/pós-login, botão, sync, rollback e 03:00 pausado', () => {
    const canaryUrl = new URL('../win/windows-canary.ps1', import.meta.url);
    expect(existsSync(canaryUrl)).toBe(true);
    const canary = existsSync(canaryUrl) ? readFileSync(canaryUrl, 'utf8') : '';
    for (const marker of [
      'PreLogin', 'PostLogin', 'Sincronizar', '/status', 'sync', 'rollback',
      'Hiper Loja 195', 'Hiper Loja 197', 'pedido local', 'sync cloud',
    ]) expect(canary).toContain(marker);
    expect(canary).toContain("Start-Process 'https://localhost/vendas'");
    expect(canary).not.toContain("Start-Process 'https://localhost/plataforma'");
    expect(canary).toMatch(/lastSyncNowAt/);
    expect(canary).toMatch(/lastSyncNowOk/);
    expect(canary).toMatch(/Test-NewerTimestamp\s+\$after\.sync\.lastSyncAt\s+\$after\.agent\.lastSyncNowAt/);
    expect(canary).not.toMatch(/\$agentAdvanced\s*=.*agent\.checkedAt/);
    expect(canary).toMatch(/\$env:EXPED_ROOT\s*=\s*\$Root[\s\S]*force-update\.mjs/);
    expect(canary).toMatch(/03:00[\s\S]*PAUSADO/i);
    expect(canary).not.toMatch(/New-ScheduledTaskTrigger\s+-Daily\s+-At\s+['"]?03:00/i);
    expect(runbook).toMatch(/03:00[\s\S]*pausada/i);
    expect(runbook).toContain('agent.running=false');
    expect(runbook).toContain('Trusted_Connection');
    expect(runbook).not.toMatch(/manifesto fake[\s\S]*http:\/\//i);
  });

  it('limita o log do Agent antes do start e reduz o ruído de HTTP interno', () => {
    const rotateUrl = new URL('../../agent/installer/rotate-log.ps1', import.meta.url);
    const settingsHelperUrl = new URL('../win/agent-settings.ps1', import.meta.url);
    expect(existsSync(rotateUrl)).toBe(true);
    expect(agentStart).toContain('rotate-log.ps1');
    expect(setup).toMatch(/AgentRotateLog[\s\S]*rotate-log\.ps1/);
    expect(agentSettings.Logging.LogLevel['System.Net.Http.HttpClient']).toBe('Warning');
    if (!existsSync(rotateUrl)) return;

    const dir = mkdtempSync(path.join(tmpdir(), 'exped-agent-log-'));
    const logPath = path.join(dir, 'agent.log');
    const settingsPath = path.join(dir, 'appsettings.json');
    writeFileSync(logPath, 'a'.repeat(128));
    writeFileSync(`${logPath}.1`, 'backup-anterior');
    writeFileSync(settingsPath, JSON.stringify({ Agent: { SyncNowPort: 5005 } }));
    try {
      const result = spawnSync('pwsh', [
        '-NoLogo', '-NoProfile', '-File', fileURLToPath(rotateUrl),
        '-Path', logPath, '-MaxBytes', '64', '-Backups', '2',
      ], { encoding: 'utf8' });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(existsSync(logPath)).toBe(false);
      expect(readFileSync(`${logPath}.1`, 'utf8')).toBe('a'.repeat(128));
      expect(readFileSync(`${logPath}.2`, 'utf8')).toBe('backup-anterior');

      const update = spawnSync('pwsh', [
        '-NoLogo', '-NoProfile', '-Command',
        `. '${fileURLToPath(settingsHelperUrl)}'; Set-ExpedAgentSettings ` +
          `-SettingsPath '${settingsPath}' -SyncNowPort 5005`,
      ], { encoding: 'utf8' });
      expect(update.status, update.stderr || update.stdout).toBe(0);
      const installedSettings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(installedSettings.Logging.LogLevel['System.Net.Http.HttpClient']).toBe('Warning');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserva appsettings no instalador standalone e aplica logging atomicamente', () => {
    const ensureUrl = new URL('../../agent/installer/ensure-log-settings.ps1', import.meta.url);
    expect(existsSync(ensureUrl)).toBe(true);
    expect(standaloneAgent).toMatch(/publish\\\*[^\r\n]*Excludes:\s*"appsettings\.json"/i);
    expect(standaloneAgent).toMatch(/publish\\appsettings\.json[^\r\n]*onlyifdoesntexist/i);
    expect(standaloneAgent).toContain('ensure-log-settings.ps1');
    expect(agentStart).toContain('ensure-log-settings.ps1');
    expect(setup).toMatch(/AgentEnsureLogSettings[\s\S]*ensure-log-settings\.ps1/);
    if (!existsSync(ensureUrl)) return;

    const dir = mkdtempSync(path.join(tmpdir(), 'exped-agent-settings-'));
    const settingsPath = path.join(dir, 'appsettings.json');
    const original = {
      Agent: {
        DeviceToken: 'token-deve-permanecer',
        SqlConnectionString: 'Server=.\\HIPER;Trusted_Connection=True;',
        SyncNowPort: 5005,
      },
      FeatureFlag: { Preserve: true },
    };
    writeFileSync(settingsPath, JSON.stringify(original));
    try {
      const result = spawnSync('pwsh', [
        '-NoLogo', '-NoProfile', '-File', fileURLToPath(ensureUrl),
        '-SettingsPath', settingsPath,
      ], { encoding: 'utf8' });
      expect(result.status, result.stderr || result.stdout).toBe(0);
      const updated = JSON.parse(readFileSync(settingsPath, 'utf8'));
      expect(updated.Agent).toEqual(original.Agent);
      expect(updated.FeatureFlag).toEqual(original.FeatureFlag);
      expect(updated.Logging.LogLevel['System.Net.Http.HttpClient']).toBe('Warning');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'win32')(
    'start.cmd continua iniciando o Agent quando a rotacao falha',
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'exped-agent-start-failure-'));
      const marker = path.join(dir, 'started.txt');
      const startPath = path.join(dir, 'start.cmd');
      const testStart = agentStart.replace(
        /^"%~dp0ExpedAgent\.exe".*$/m,
        `echo STARTED>"${marker}"`,
      );
      writeFileSync(startPath, testStart);
      writeFileSync(path.join(dir, 'ensure-log-settings.ps1'), 'exit 0');
      writeFileSync(path.join(dir, 'rotate-log.ps1'), 'exit 9');
      try {
        const result = spawnSync('cmd.exe', ['/d', '/c', startPath], { encoding: 'utf8' });
        expect(result.status, result.stderr || result.stdout).toBe(0);
        expect(readFileSync(marker, 'utf8').trim()).toBe('STARTED');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
