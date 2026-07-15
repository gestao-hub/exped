import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const powerShellExecutable = process.env.PWSH || 'pwsh';
const hasPowerShell = spawnSync(
  powerShellExecutable,
  ['-NoLogo', '-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'],
  { encoding: 'utf8' },
).status === 0;
const powerShellIt = (name, test) =>
  (hasPowerShell ? it : it.skip)(name, test, 15_000);
const watchdog = source('../watchdog.ps1');

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n?/g, '\n');
}

function sectionEntries(text, section) {
  const lines = text.split(/\r?\n/);
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

function routine(text, name) {
  const start = text.search(new RegExp(`^(?:function|procedure)\\s+${name}\\b`, 'm'));
  if (start < 0) return '';
  const rest = text.slice(start);
  const next = rest.slice(1).search(/^\s*(?:function|procedure)\s+[\w-]+\b/m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function expectOrder(text, needles) {
  const positions = needles.map((needle) => text.indexOf(needle));
  expect(positions.every((position) => position >= 0), `itens ausentes: ${needles}`).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
}

function runPowerShellFile(relativePath, args) {
  return spawnSync(
    powerShellExecutable,
    [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      fileURLToPath(new URL(relativePath, import.meta.url)),
      ...args,
    ],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
}

function expectPowerShellSuccess(result) {
  expect(
    result.status,
    `stdout:\n${result.stdout || ''}\nstderr:\n${result.stderr || ''}`,
  ).toBe(0);
}

function writeFixture(root, relativePath, bytes) {
  const destination = path.join(root, relativePath);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
}

function snapshotHub(root, transaction) {
  expectPowerShellSuccess(runPowerShellFile('../win/installer-orchestrator.ps1', [
    '-Operation', 'SnapshotHub', '-Root', root, '-TransactionDir', transaction,
  ]));
}

function issueProvisionCapability(root, transaction, transactionId) {
  expectPowerShellSuccess(runPowerShellFile('../win/installer-orchestrator.ps1', [
    '-Operation', 'IssueProvisionCapability', '-Root', root,
    '-TransactionDir', transaction, '-InstallerTransactionId', transactionId,
  ]));
  return path.join(transaction, 'provision-capability.json');
}

describe('orquestração transacional do Inno', () => {
  const unified = source('../win/exped-setup.iss');
  const hubOnly = source('../win/exped-hub.iss');
  const orchestrator = source('../win/installer-orchestrator.ps1');
  const workflow = source('../../.github/workflows/build-installer.yml');

  it('não delega operações críticas a [Run] e confere criação + ResultCode', () => {
    expect(sectionEntries(unified, 'Run')).toEqual([]);
    expect(sectionEntries(hubOnly, 'Run')).toEqual([]);

    for (const installer of [unified, hubOnly]) {
      const checked = routine(installer, 'ExecChecked');
      expect(checked).toMatch(/Exec\(/);
      expect(checked).toMatch(/ResultCode\s*<>\s*0/);
      expect(checked).toMatch(/RaiseException/);
    }
    const originalUser = routine(unified, 'ExecOriginalUserChecked');
    expect(originalUser).toMatch(/ExecAsOriginalUser\(/);
    expect(originalUser).toMatch(/ResultCode\s*<>\s*0/);
    expect(originalUser).toMatch(/RaiseException/);
  });

  it('executa a transacao durante [Files], antes de o Inno finalizar o uninstall log', () => {
    for (const installer of [unified, hubOnly]) {
      const files = sectionEntries(installer, 'Files');
      const marker = files.at(-1);
      expect(marker).toContain('install-transaction.marker');
      expect(marker).toContain('DestDir: "{tmp}"');
      expect(marker).toContain('Flags: deleteafterinstall');
      expect(marker).toContain('AfterInstall: RunTransactionalInstall');

      const transaction = routine(installer, 'RunTransactionalInstall');
      expect(transaction).toContain("'StampHubVersion'");
      expect(transaction).toContain('download-binaries.ps1');
      expect(transaction).toContain('install-service.ps1');

      const postInstall = routine(installer, 'CurStepChanged');
      expect(postInstall).not.toMatch(/ssPostInstall|download-binaries|install-service|provision\.ps1/);
    }
  });

  it('separa identidades de produto porque o cleanup do Agent e diferente', () => {
    const appId = (installer) => sectionEntries(installer, 'Setup')
      .find((entry) => entry.startsWith('AppId='));
    expect(appId(unified)).toBe('AppId=Exped');
    expect(appId(hubOnly)).toBe('AppId=Exped Hub');
    expect(unified).toMatch(/uninstall-service\.ps1[\s\S]*-ManageAgent true/);
    expect(hubOnly).toMatch(/uninstall-service\.ps1[\s\S]*-ManageAgent false/);
  });

  it('upgrade provisionado preserva credenciais existentes e o pacote Hub bloqueia clean install', () => {
    const unifiedInstall = routine(unified, 'RunTransactionalInstall');
    expect(unifiedInstall).toMatch(/if\s+not\s+ExistingProvisionedConfig\s+then/i);
    expectOrder(unifiedInstall, [
      'if not ExistingProvisionedConfig then',
      'IssueProvisionCapability',
      'provision.ps1',
      'agent-user-install.ps1',
      'install-service.ps1',
    ]);
    expect(routine(unified, 'PrepareToInstall')).toContain('QueryProvisionedConfig');

    const hubPrepare = routine(hubOnly, 'PrepareToInstall');
    expect(hubPrepare).toContain('QueryProvisionedConfig');
    expect(hubPrepare).toMatch(/if\s+not\s+ExistingProvisionedConfig\s+then[\s\S]*RaiseException/i);
  });

  it('nao expande {app} durante InitializeWizard e exercita essa inicializacao no CI', () => {
    const initializeWizard = routine(unified, 'InitializeWizard');
    const earlyQuery = routine(unified, 'QueryProvisionedConfigAtRoot');

    expect(initializeWizard).toContain("QueryProvisionedConfigAtRoot('{#InstallRoot}')");
    expect(initializeWizard).not.toContain('QueryProvisionedConfig;');
    expect(earlyQuery).toContain('OrchestratorParamsForRoot');
    expect(earlyQuery).not.toContain("ExpandConstant('{app}')");

    expect(workflow).toContain('Smoke unified installer initialization');
    expect(workflow).toContain('Modo silencioso exige /credentialsfile protegido');
    expect(workflow).toMatch(/expand the ["']app["'] constant/i);
  });

  it('faz preflight e descobre o servico antes de snapshot, stop, download, escrita ou redeem', () => {
    const prepare = routine(unified, 'PrepareToInstall');
    expectOrder(prepare, ['PreflightUser', 'QueryHubRunning', 'SnapshotHub', 'StopHub']);
    expect(prepare).toContain('RunOriginalOrchestratorChecked');
    expect(routine(unified, 'RunOriginalOrchestratorChecked')).toContain('ExecOriginalUserChecked');
    expect(prepare).not.toMatch(/download-binaries|provision\.ps1|SaveStringToFile/);

    const hubPrepare = routine(hubOnly, 'PrepareToInstall');
    expectOrder(hubPrepare, ['QueryHubRunning', 'SnapshotHub', 'StopHub']);

    const install = routine(unified, 'RunTransactionalInstall');
    expectOrder(install, [
      'download-binaries.ps1',
      'provision.ps1',
      "'-Install -Root",
      'install-service.ps1',
      "'-Start -Root",
      "'-Finalize -Root",
    ]);
    expect(unified).toMatch(/procedure DeinitializeSetup[\s\S]*RestoreHubAfterFailure/);
  });

  it('restaura payload, registro e estado anterior do servico sem reinstalar com payload novo', () => {
    const install = routine(unified, 'RunTransactionalInstall');
    const restore = routine(unified, 'RestoreHubAfterFailure');
    expectOrder(install.slice(install.indexOf('except')), [
      'GetExceptionMessage',
      'RollbackAgentUrlAclAfterFailure',
      'RollbackAgentAfterFailure',
      'RollbackProvisionAfterFailure',
      'RestoreHubAfterFailure',
      'RaiseException',
    ]);
    expectOrder(routine(unified, 'DeinitializeSetup'), [
      'RollbackAgentUrlAclAfterFailure',
      'RollbackAgentAfterFailure',
      'RollbackProvisionAfterFailure',
      'RestoreHubAfterFailure',
    ]);
    expectOrder(install, ['-Start', '-Finalize']);
    expect(routine(unified, 'RollbackAgentUrlAclAfterFailure'))
      .toContain("OrchestratorParams('RollbackAgentUrlAcl'");
    expect(restore).toContain("OrchestratorParams('RestoreHub'");
    expect(restore).not.toMatch(/install-service\.ps1|uninstall-service\.ps1/);
    expect(orchestrator).toContain("'RollbackAgentUrlAcl'");
    expect(orchestrator).toMatch(/service\.reg|RegistryServiceBackup/i);
    expect(orchestrator).toMatch(/ServiceExistedBefore[\s\S]*ServiceWasRunningBefore/i);
    expect(orchestrator).toMatch(/Restore-HubServiceSnapshot[\s\S]*Start-Service/i);
    expect(unified).toContain('SnapshotHub');
    expect(unified).toContain('FinalizeHub');
  });

  it('relanca a falha original com a API suportada pelo Pascal Script', () => {
    for (const installer of [unified, hubOnly]) {
      const transaction = routine(installer, 'RunTransactionalInstall');
      expect(transaction).not.toMatch(/\braise\s*;/i);
      expectOrder(transaction.slice(transaction.indexOf('except')), [
        'GetExceptionMessage',
        'RestoreHubAfterFailure',
        'RaiseException',
      ]);
    }
  });

  it('limita o snapshot ao payload executavel/config/binarios e exclui estado mutavel', () => {
    for (const relativePath of ['app', 'hub', 'scripts', 'supabase', 'bin']) {
      expect(orchestrator).toMatch(new RegExp(`['"]${relativePath}['"]`, 'i'));
    }
    expect(orchestrator).toMatch(/HubTransactionalDirectories|TransactionalDirectories/);
    expect(orchestrator).toMatch(/robocopy(?:\.exe)?[\s\S]*\/MIR[\s\S]*\/COPY:/i);
    expect(orchestrator).not.toMatch(/HubTransactionalDirectories\s*=\s*@\([^)]*['"](?:data|logs|releases)['"]/is);
    expect(orchestrator).toMatch(/Restore-HubSnapshot[\s\S]*Remove-Item[\s\S]*Copy-HubTreeExact/i);
    expectOrder(routine(orchestrator, 'Restore-HubSnapshot'), [
      'Assert-HubSnapshotComplete',
      'Stop-HubServiceIfPresent',
      'Remove-Item',
    ]);
  });

  it('carimba MyAppVersion atomicamente nos dois instaladores sob o mesmo snapshot', () => {
    for (const installer of [unified, hubOnly]) {
      const install = routine(installer, 'RunTransactionalInstall');
      expect(install).toContain("'StampHubVersion'");
      expect(install).toContain('{#MyAppVersion}');
      expectOrder(install, ['StampHubVersion', 'download-binaries.ps1', 'install-service.ps1']);
    }
    expect(orchestrator).toContain("'StampHubVersion'");
    expect(orchestrator).toMatch(/function Set-HubVersionAtomically[\s\S]*Write-BytesAtomically/i);
  });

  it('usa backup temporario nao vazio ao substituir arquivos no Windows', () => {
    const agentSettings = source('../win/agent-settings.ps1');
    const nullBackup = /\[System\.IO\.File\]::Replace\(\s*\$tempPath,\s*\$fullPath,\s*\$null\s*\)/g;

    expect(orchestrator).not.toMatch(nullBackup);
    expect(agentSettings).not.toMatch(nullBackup);
    expect(orchestrator).toMatch(
      /\$replaceBackupPath[\s\S]*\[System\.IO\.File\]::Replace\(\$tempPath, \$fullPath, \$replaceBackupPath\)/,
    );
    expect(agentSettings.match(
      /\[System\.IO\.File\]::Replace\(\$tempPath, \$fullPath, \$replaceBackupPath\)/g,
    )).toHaveLength(2);
  });

  it('mantém código e token fora da linha de comando e apaga o arquivo protegido', () => {
    expect(unified).not.toContain('-DeviceToken');
    expect(unified).not.toContain('-Code');
    expect(unified).not.toContain('{param:token}');
    expect(unified).toContain('-CredentialsFile');
    expect(routine(unified, 'QuoteArg')).toMatch(/Pos\('\"',[\s\S]*#13[\s\S]*#10[\s\S]*RaiseException/);
    expect(unified).toMatch(/LoadSilentManualCredentials[\s\S]*DeleteFile\(SourceFile\)/);
    const install = routine(unified, 'RunTransactionalInstall');
    expectOrder(install, [
      "SaveStringToFile(CredentialsFile, '', False)",
      "RunOrchestratorChecked('ProtectCredentials'",
      "AnsiString('manual'",
      "AnsiString('code'",
      "PowerShellFileParams(ExpandConstant('{app}\\hub\\win\\provision.ps1')",
    ]);
    expect(install).toMatch(/'manual'\s*\+\s*#13#10[\s\S]*GetManualToken/);
    expect(install).toMatch(/'code'\s*\+\s*#13#10[\s\S]*GetCode/);
    expect(unified).toMatch(/finally[\s\S]*DeleteFile\(CredentialsFile\)/i);
    expect(routine(unified, 'DeinitializeSetup')).toContain('DeleteSilentCredentialSource');
  });

  it('mantém gates nativos no runner Windows para os dois instaladores', () => {
    expect(workflow).toContain('npm test');
    expect(workflow).toContain('Language.Parser]::ParseFile');
    expectOrder(workflow, [
      'dotnet test agent/ExpedAgent.Tests/ExpedAgent.Tests.csproj --configuration Release',
      'dotnet publish agent/ExpedAgent',
    ]);
    expect(workflow).toContain('dotnet publish agent/ExpedAgent');
    expect(workflow).toContain('hub\\win\\exped-setup.iss');
    expect(workflow).toContain('hub\\win\\exped-hub.iss');
    expect(workflow).toContain('hub/win/Output/ExpedSetup.exe');
    expect(workflow).toContain('hub/win/Output/ExpedHubSetup.exe');
  });
});

describe('comportamento real do helper transacional', () => {
  powerShellIt('reconhece somente config cloud provisionado e completo', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'exped-query-provisioned-'));
    const root = path.join(sandbox, 'root');

    try {
      writeFixture(root, 'config.json', Buffer.from(JSON.stringify({
        cloud: {
          apiBase: 'https://cloud.example.test',
          deviceToken: 'device-token',
          syncIntervalMs: 12_345,
        },
      })));
      const valid = runPowerShellFile('../win/installer-orchestrator.ps1', [
        '-Operation', 'QueryProvisionedConfig', '-Root', root,
      ]);
      expectPowerShellSuccess(valid);

      writeFileSync(path.join(root, 'config.json'), JSON.stringify({
        cloud: { apiBase: 'https://cloud.example.test', deviceToken: '' },
      }));
      const missingToken = runPowerShellFile('../win/installer-orchestrator.ps1', [
        '-Operation', 'QueryProvisionedConfig', '-Root', root,
      ]);
      expect(missingToken.status).toBe(4);

      writeFileSync(path.join(root, 'config.json'), '{invalid-json');
      const invalidJson = runPowerShellFile('../win/installer-orchestrator.ps1', [
        '-Operation', 'QueryProvisionedConfig', '-Root', root,
      ]);
      expect(invalidJson.status).toBe(4);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  powerShellIt('provisionamento direto falha fechado antes de log ou mutacao', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'exped-provision-direct-'));
    const root = path.join(sandbox, 'root');
    const original = Buffer.from('{"version":"unchanged"}\r\n');
    const commandLineSecret = 'must-never-reach-runtime';

    try {
      writeFixture(root, 'config.json', original);
      const result = runPowerShellFile('../win/provision.ps1', [
        '-DeviceToken', commandLineSecret,
        '-Root', root,
      ]);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/ExpedSetup|CredentialsFile|fluxo do instalador/i);
      expect(`${result.stdout}${result.stderr}`).not.toContain(commandLineSecret);
      expect(readFileSync(path.join(root, 'config.json'))).toEqual(original);
      expect(existsSync(path.join(root, 'logs', 'provision.log'))).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  powerShellIt('DeferAgent sem capability do ExpedSetup falha antes de ler credencial', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'exped-provision-no-capability-'));
    const root = path.join(sandbox, 'root');
    const credentials = path.join(sandbox, 'credentials.txt');
    const original = Buffer.from('{"version":"unchanged"}\r\n');
    const token = 'must-remain-only-in-credential-file';

    try {
      writeFixture(root, 'config.json', original);
      writeFileSync(credentials, '');
      expectPowerShellSuccess(runPowerShellFile('../win/installer-orchestrator.ps1', [
        '-Operation', 'ProtectCredentials', '-Root', root,
        '-CredentialsFile', credentials,
      ]));
      writeFileSync(credentials, `manual\r\nhttps://cloud.example.test\r\n${token}`);

      const result = runPowerShellFile('../win/provision.ps1', [
        '-CredentialsFile', credentials,
        '-Root', root,
        '-DeferAgent',
        '-InstallerTransactionId', 'exped-test-no-capability-123456',
      ]);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/capability|ExpedSetup/i);
      expect(`${result.stdout}${result.stderr}`).not.toContain(token);
      expect(readFileSync(path.join(root, 'config.json'))).toEqual(original);
      expect(existsSync(credentials)).toBe(true);
      expect(existsSync(path.join(root, 'logs', 'provision.log'))).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  powerShellIt('aceita uma capability one-shot emitida pelo snapshot do ExpedSetup', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'exped-provision-capability-'));
    const root = path.join(sandbox, 'root');
    const transaction = path.join(sandbox, 'hub-transaction');
    const credentials = path.join(sandbox, 'credentials.txt');
    const capability = path.join(transaction, 'provision-capability.json');
    const transactionId = 'exped-test-capability-1234567890';
    const token = 'token-through-issued-capability';

    try {
      writeFixture(root, 'config.json', Buffer.from(JSON.stringify({
        version: 'before',
        cloud: { syncIntervalMs: 12_345, customCloudSetting: 'preserve-me' },
      })));
      snapshotHub(root, transaction);
      issueProvisionCapability(root, transaction, transactionId);
      writeFileSync(credentials, '');
      expectPowerShellSuccess(runPowerShellFile('../win/installer-orchestrator.ps1', [
        '-Operation', 'ProtectCredentials', '-Root', root,
        '-CredentialsFile', credentials,
      ]));
      writeFileSync(credentials, `manual\r\nhttps://cloud.example.test\r\n${token}`);

      const result = runPowerShellFile('../win/provision.ps1', [
        '-CredentialsFile', credentials,
        '-InstallerCapabilityFile', capability,
        '-Root', root,
        '-DeferAgent',
        '-InstallerTransactionId', transactionId,
      ]);
      expectPowerShellSuccess(result);
      expect(`${result.stdout}${result.stderr}`).not.toContain(token);
      expect(existsSync(capability)).toBe(false);
      expect(existsSync(path.join(
        root, 'data', 'installer-transactions', 'provision-capabilities', `${transactionId}.json`,
      ))).toBe(false);
      const config = JSON.parse(readFileSync(path.join(root, 'config.json'), 'utf8'));
      expect(config.cloud.deviceToken).toBe(token);
      expect(config.cloud.syncIntervalMs).toBe(12_345);
      expect(config.cloud.customCloudSetting).toBe('preserve-me');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  powerShellIt('restaura bytes e remove arquivos novos sem tocar data, logs ou releases', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'exped-hub-transaction-'));
    const root = path.join(sandbox, 'root');
    const transaction = path.join(sandbox, 'transaction');
    const included = ['app', 'hub', 'scripts', 'supabase', 'bin'];
    const excluded = ['data', 'logs', 'releases'];
    const originals = new Map();

    try {
      for (const [index, directory] of included.entries()) {
        const bytes = Buffer.from([0, 255, index, 13, 10, 65 + index]);
        originals.set(directory, bytes);
        writeFixture(root, path.join(directory, 'nested', 'artifact.bin'), bytes);
      }
      for (const directory of excluded) {
        writeFixture(root, path.join(directory, 'state.txt'), Buffer.from('before'));
      }
      const configBytes = Buffer.from('{\r\n  "version": "before"\r\n}\r\n');
      writeFixture(root, 'config.json', configBytes);

      expectPowerShellSuccess(runPowerShellFile('../win/installer-orchestrator.ps1', [
        '-Operation', 'SnapshotHub', '-Root', root, '-TransactionDir', transaction,
      ]));

      for (const directory of included) {
        rmSync(path.join(root, directory), { recursive: true, force: true });
        writeFixture(root, path.join(directory, 'nested', 'artifact.bin'), Buffer.from('corrupted'));
        writeFixture(root, path.join(directory, 'new.bin'), Buffer.from('must disappear'));
      }
      for (const directory of excluded) {
        writeFileSync(path.join(root, directory, 'state.txt'), 'after');
      }
      writeFileSync(path.join(root, 'config.json'), '{"version":"corrupted"}');

      expectPowerShellSuccess(runPowerShellFile('../win/installer-orchestrator.ps1', [
        '-Operation', 'RestoreHub', '-Root', root, '-TransactionDir', transaction,
      ]));

      for (const directory of included) {
        expect(readFileSync(path.join(root, directory, 'nested', 'artifact.bin')))
          .toEqual(originals.get(directory));
        expect(existsSync(path.join(root, directory, 'new.bin'))).toBe(false);
      }
      for (const directory of excluded) {
        expect(readFileSync(path.join(root, directory, 'state.txt'), 'utf8')).toBe('after');
      }
      expect(readFileSync(path.join(root, 'config.json'))).toEqual(configBytes);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  powerShellIt('snapshot truncado falha antes de remover qualquer payload atual', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'exped-hub-truncated-'));
    const root = path.join(sandbox, 'root');
    const transaction = path.join(sandbox, 'transaction');
    const currentApp = Buffer.from('current-app-must-survive');
    const currentBin = Buffer.from('current-bin-must-survive');

    try {
      writeFixture(root, 'app/runtime.bin', Buffer.from('old-app'));
      writeFixture(root, 'bin/runtime.bin', Buffer.from('old-bin'));
      expectPowerShellSuccess(runPowerShellFile('../win/installer-orchestrator.ps1', [
        '-Operation', 'SnapshotHub', '-Root', root, '-TransactionDir', transaction,
      ]));
      writeFileSync(path.join(transaction, 'payload', 'bin', 'runtime.bin'), 'bad-bin');
      writeFileSync(path.join(root, 'app', 'runtime.bin'), currentApp);
      writeFileSync(path.join(root, 'bin', 'runtime.bin'), currentBin);

      const result = runPowerShellFile('../win/installer-orchestrator.ps1', [
        '-Operation', 'RestoreHub', '-Root', root, '-TransactionDir', transaction,
      ]);
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/snapshot|backup|truncado|ausente/i);
      expect(readFileSync(path.join(root, 'app', 'runtime.bin'))).toEqual(currentApp);
      expect(readFileSync(path.join(root, 'bin', 'runtime.bin'))).toEqual(currentBin);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  powerShellIt('carimba version atomicamente e o snapshot recupera os bytes anteriores', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'exped-version-transaction-'));
    const root = path.join(sandbox, 'root');
    const transaction = path.join(sandbox, 'transaction');
    const original = Buffer.from('{\r\n  "version": "1.2.3",\r\n  "custom": true\r\n}\r\n');

    try {
      writeFixture(root, 'config.json', original);
      expectPowerShellSuccess(runPowerShellFile('../win/installer-orchestrator.ps1', [
        '-Operation', 'SnapshotHub', '-Root', root, '-TransactionDir', transaction,
      ]));
      expectPowerShellSuccess(runPowerShellFile('../win/installer-orchestrator.ps1', [
        '-Operation', 'StampHubVersion', '-Root', root, '-AppVersion', '9.8.7',
      ]));
      expect(JSON.parse(readFileSync(path.join(root, 'config.json'), 'utf8')).version).toBe('9.8.7');
      expectPowerShellSuccess(runPowerShellFile('../win/installer-orchestrator.ps1', [
        '-Operation', 'RestoreHub', '-Root', root, '-TransactionDir', transaction,
      ]));
      expect(readFileSync(path.join(root, 'config.json'))).toEqual(original);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  powerShellIt('persiste provisioning para rollback e retry sem novo segredo na linha de comando', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'exped-provision-journal-'));
    const root = path.join(sandbox, 'root');
    const firstCredentials = path.join(sandbox, 'first-credentials.txt');
    const retryCredentials = path.join(sandbox, 'retry-credentials.txt');
    const hubTransaction = path.join(sandbox, 'hub-transaction');
    const firstTransactionId = 'exped-test-first-1234567890';
    const retryTransactionId = 'exped-test-retry-1234567890';
    const journal = path.join(root, 'data', 'installer-transactions', 'provision-current');
    const original = Buffer.from('{\r\n  "version": "old",\r\n  "agent": { "syncNowPort": 0 }\r\n}\r\n');
    const firstToken = 'test-token-only-in-protected-file';
    const ignoredRetryToken = 'different-token-must-not-be-used';

    const protectAndWrite = (credentialsPath, contents) => {
      writeFileSync(credentialsPath, '');
      expectPowerShellSuccess(runPowerShellFile('../win/installer-orchestrator.ps1', [
        '-Operation', 'ProtectCredentials', '-Root', root,
        '-CredentialsFile', credentialsPath,
      ]));
      writeFileSync(credentialsPath, contents);
    };

    try {
      writeFixture(root, 'config.json', original);
      snapshotHub(root, hubTransaction);
      const firstCapability = issueProvisionCapability(
        root, hubTransaction, firstTransactionId,
      );
      protectAndWrite(firstCredentials, `manual\r\nhttps://cloud.example.test\r\n${firstToken}`);

      const provisioned = runPowerShellFile('../win/provision.ps1', [
        '-CredentialsFile', firstCredentials,
        '-InstallerCapabilityFile', firstCapability,
        '-Root', root,
        '-DeferAgent',
        '-InstallerTransactionId', firstTransactionId,
      ]);
      expectPowerShellSuccess(provisioned);
      expect(`${provisioned.stdout}${provisioned.stderr}`).not.toContain(firstToken);
      expect(existsSync(firstCredentials)).toBe(false);
      expect(JSON.parse(readFileSync(path.join(root, 'config.json'), 'utf8')).cloud.deviceToken)
        .toBe(firstToken);
      expect(JSON.parse(readFileSync(path.join(journal, 'state.json'), 'utf8')).Phase)
        .toBe('ConfigsWritten');
      expect(existsSync(path.join(journal, 'recovery-credentials.json'))).toBe(true);

      expectPowerShellSuccess(runPowerShellFile('../win/provision.ps1', [
        '-RollbackTransaction', '-Root', root,
        '-InstallerTransactionId', firstTransactionId,
      ]));
      expect(readFileSync(path.join(root, 'config.json'))).toEqual(original);
      const rolledBack = JSON.parse(readFileSync(path.join(journal, 'state.json'), 'utf8'));
      expect(rolledBack.Phase).toBe('RolledBackRetryable');
      expect(rolledBack.RedeemIsReversible).toBe(false);

      protectAndWrite(retryCredentials, `manual\r\nhttps://ignored.example.test\r\n${ignoredRetryToken}`);
      const retryCapability = issueProvisionCapability(
        root, hubTransaction, retryTransactionId,
      );
      const retried = runPowerShellFile('../win/provision.ps1', [
        '-CredentialsFile', retryCredentials,
        '-InstallerCapabilityFile', retryCapability,
        '-Root', root,
        '-DeferAgent',
        '-InstallerTransactionId', retryTransactionId,
      ]);
      expectPowerShellSuccess(retried);
      expect(`${retried.stdout}${retried.stderr}`).not.toContain(firstToken);
      expect(`${retried.stdout}${retried.stderr}`).not.toContain(ignoredRetryToken);
      expect(JSON.parse(readFileSync(path.join(root, 'config.json'), 'utf8')).cloud.deviceToken)
        .toBe(firstToken);

      expectPowerShellSuccess(runPowerShellFile('../win/provision.ps1', [
        '-FinalizeTransaction', '-Root', root,
        '-InstallerTransactionId', retryTransactionId,
      ]));
      expect(existsSync(journal)).toBe(false);
      const historyDir = path.join(root, 'data', 'installer-transactions', 'provision-history');
      const history = readFileSync(
        path.join(historyDir, 'latest.json'),
        'utf8',
      );
      expect(history).toContain('Completed');
      expect(history).not.toContain(firstToken);
      expect(history).not.toContain(ignoredRetryToken);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 20_000);

  powerShellIt('recupera journal parcial criado antes de Prepared sem repetir estado remoto', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'exped-provision-partial-journal-'));
    const root = path.join(sandbox, 'root');
    const credentials = path.join(sandbox, 'credentials.txt');
    const hubTransaction = path.join(sandbox, 'hub-transaction');
    const transactionId = 'exped-test-partial-1234567890';
    const journal = path.join(root, 'data', 'installer-transactions', 'provision-current');
    const history = path.join(root, 'data', 'installer-transactions', 'provision-history');
    const token = 'token-after-partial-journal';

    try {
      writeFixture(root, 'config.json', Buffer.from('{"version":"before"}\r\n'));
      mkdirSync(journal, { recursive: true });
      writeFileSync(path.join(journal, 'config.backup'), 'orphaned-before-prepared');
      snapshotHub(root, hubTransaction);
      const capability = issueProvisionCapability(root, hubTransaction, transactionId);
      writeFileSync(credentials, '');
      expectPowerShellSuccess(runPowerShellFile('../win/installer-orchestrator.ps1', [
        '-Operation', 'ProtectCredentials', '-Root', root,
        '-CredentialsFile', credentials,
      ]));
      writeFileSync(credentials, `manual\r\nhttps://cloud.example.test\r\n${token}`);

      const result = runPowerShellFile('../win/provision.ps1', [
        '-CredentialsFile', credentials,
        '-InstallerCapabilityFile', capability,
        '-Root', root,
        '-DeferAgent',
        '-InstallerTransactionId', transactionId,
      ]);
      expectPowerShellSuccess(result);
      expect(`${result.stdout}${result.stderr}`).not.toContain(token);
      expect(JSON.parse(readFileSync(path.join(root, 'config.json'), 'utf8')).cloud.deviceToken)
        .toBe(token);
      expect(JSON.parse(readFileSync(path.join(journal, 'state.json'), 'utf8')).Phase)
        .toBe('ConfigsWritten');
      expect(existsSync(history)).toBe(true);
      expect(
        readFileSync(path.join(history, 'latest-incomplete.json'), 'utf8'),
      ).toMatch(/IncompleteBeforePrepared/);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 10_000);

  powerShellIt('atualiza modo e hash ao retomar Prepared antes de qualquer redeem', () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'exped-provision-prepared-retry-'));
    const root = path.join(sandbox, 'root');
    const configPath = path.join(root, 'config.json');
    const credentials = path.join(sandbox, 'credentials.txt');
    const hubTransaction = path.join(sandbox, 'hub-transaction');
    const transactionId = 'exped-test-new-prepared-123456';
    const journal = path.join(root, 'data', 'installer-transactions', 'provision-current');
    const original = Buffer.from('{"version":"before"}\r\n');
    const token = 'new-manual-token-after-prepared';

    try {
      writeFixture(root, 'config.json', original);
      mkdirSync(journal, { recursive: true });
      writeFileSync(path.join(journal, 'config.backup'), original);
      writeFileSync(path.join(journal, 'state.json'), JSON.stringify({
        TransactionId: 'exped-test-old-prepared-123456',
        ConfigPath: configPath,
        ConfigExisted: true,
        Mode: 'code',
        SecretHash: '0'.repeat(64),
        RedeemIsReversible: false,
        CreatedAtUtc: new Date(0).toISOString(),
        Phase: 'Prepared',
      }));
      snapshotHub(root, hubTransaction);
      const capability = issueProvisionCapability(root, hubTransaction, transactionId);
      writeFileSync(credentials, '');
      expectPowerShellSuccess(runPowerShellFile('../win/installer-orchestrator.ps1', [
        '-Operation', 'ProtectCredentials', '-Root', root,
        '-CredentialsFile', credentials,
      ]));
      writeFileSync(credentials, `manual\r\nhttps://cloud.example.test\r\n${token}`);

      expectPowerShellSuccess(runPowerShellFile('../win/provision.ps1', [
        '-CredentialsFile', credentials,
        '-InstallerCapabilityFile', capability,
        '-Root', root,
        '-DeferAgent',
        '-InstallerTransactionId', transactionId,
      ]));
      const state = JSON.parse(readFileSync(path.join(journal, 'state.json'), 'utf8'));
      expect(state.Mode).toBe('manual');
      expect(state.SecretHash).toBe(createHash('sha256').update(token).digest('hex'));
      expect(state.TransactionId).toBe('exped-test-new-prepared-123456');
      expect(state.Phase).toBe('ConfigsWritten');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 10_000);
});

describe('contratos PowerShell do instalador', () => {
  const install = source('../win/install-service.ps1');
  const uninstall = source('../win/uninstall-service.ps1');
  const provision = source('../win/provision.ps1');
  const userHelper = source('../win/agent-user-install.ps1');
  const settings = source('../win/agent-settings.ps1');
  const preflight = source('../win/installer-orchestrator.ps1');
  const unified = source('../win/exped-setup.iss');
  const hubOnly = source('../win/exped-hub.iss');
  const orchestrator = source('../win/installer-orchestrator.ps1');

  it('aborta cleanup antes de teardown e confere comandos nativos', () => {
    const teardown = uninstall.slice(uninstall.indexOf('$agentCleanupComplete = $true'));
    expectOrder(teardown, [
      '$agentCleanupComplete = Invoke-AgentCleanupAsOriginalUser',
      'if (-not $agentCleanupComplete)',
      'exit 2',
      'if (Test-Path $Nssm)',
      'Remove-AgentUrlAcl',
      'advfirewall',
    ]);
    expect(routine(uninstall, 'Invoke-NativeQuery')).toMatch(/\$LASTEXITCODE/);
    expect(routine(uninstall, 'Invoke-NativeChecked')).toMatch(/throw/);
    expect(uninstall).toMatch(/Invoke-NativeChecked[\s\S]*(?:nssm|\$Nssm)/i);
    expect(uninstall).toMatch(/Invoke-NativeChecked[\s\S]*netsh/i);
  });

  it('mantém journal persistente e não promete desfazer código resgatado', () => {
    expect(provision).toMatch(/data[\\']installer-transactions|installer-transactions/i);
    expect(provision).toContain('provision-current');
    expect(provision).toContain('Write-ProvisionJournalState');
    expect(routine(provision, 'New-ProvisionJournal')).toContain("Write-ProvisionJournalState $state 'Prepared'");
    const redeemExecution = provision.slice(
      provision.lastIndexOf("Write-ProvisionJournalState $state 'RedeemStarted'"),
    );
    expectOrder(redeemExecution, [
      "'RedeemStarted'",
      'Invoke-RestMethod',
      'Write-RecoveryCredentials',
      "'Redeemed'",
      'Write-ExpedJsonAtomically $configPath',
      "'ConfigsWritten'",
    ]);
    expect(provision).toMatch(/RedeemStarted[\s\S]*(?:resultado desconhecido|pode ter sido consumido)/i);
    expect(provision).toMatch(/Redeemed[\s\S]*(?:nao pode ser desfeito|nao e reversivel)/i);
    expect(provision).toMatch(/RollbackTransaction[\s\S]*Restore-ProvisionSnapshots/i);
    expect(provision).toMatch(/RolledBackRetryable[\s\S]*Redeem/i);
    expect(provision).toMatch(/FinalizeTransaction[\s\S]*Completed/i);
    expect(userHelper).toContain('[switch]$Rollback');
    expect(userHelper).toContain('[switch]$Finalize');
    expect(userHelper).toMatch(/InstallTransactions[\s\S]*BackupSettings/);
    expect(userHelper).toMatch(/BackupAgentDir[\s\S]*AgentWasRunning/);
    expect(userHelper).toMatch(/backup-manifest\.json/i);
    expect(userHelper).toMatch(/backup-manifest\.json[\s\S]*Entries/i);
    expect(userHelper).toContain('Assert-AgentTransactionRestorable');
    expect(userHelper).toMatch(/Restore-AgentTransaction[\s\S]*BackupAgentDir[\s\S]*wscript\.exe/);
    expect(install).not.toMatch(/DeleteSubKeyTree\(\$receipt\.RegistryPath/);
    expectOrder(unified, ['install-service.ps1', '-Start', '-Finalize']);
  });

  it('valida todo o backup do agente antes de parar ou remover a instalação atual', () => {
    const restore = routine(userHelper, 'Restore-AgentTransaction');
    expectOrder(restore, [
      'Assert-AgentTransactionRestorable',
      'Get-ThisUserAgentProcesses',
      'Stop-Process',
      'Remove-Item -LiteralPath $state.AgentDir',
    ]);
    const validate = routine(userHelper, 'Assert-AgentTransactionRestorable');
    expect(validate).toMatch(/BackupAgentDir[\s\S]*(?:manifest|Sha256)/i);
    expect(validate).toMatch(/BackupStartup[\s\S]*(?:Length|Sha256)/i);
  });

  it('valida conta de usuário e perfil sem nomes localizados', () => {
    expect(preflight).toContain('WindowsIdentity]::GetCurrent()');
    expectOrder(preflight, ['WindowsIdentity]::GetCurrent()', 'explorer.exe', 'GetOwnerSid']);
    const originalUserPreflight = routine(preflight, 'Assert-OriginalInteractiveUser');
    expect(originalUserPreflight).toContain('Win32_UserAccount');
    expect(originalUserPreflight).toContain('SIDType');
    expect(originalUserPreflight).toContain('ProfileList');
    expect(originalUserPreflight).toContain('User Shell Folders');
    expect(originalUserPreflight).toContain("'Local AppData'");
    expect(originalUserPreflight).toMatch(/Test-Path\s+-LiteralPath\s+\$profilePath\s+-PathType\s+Container/);
    expect(originalUserPreflight).toMatch(/Test-Path\s+-LiteralPath\s+\$registeredLocalAppData\s+-PathType\s+Container/);
    expectOrder(originalUserPreflight, ['Win32_UserAccount', 'ProfileList', 'User Shell Folders', 'config.json']);
    expect(settings).toContain('Win32_UserAccount');
    expect(settings).toContain('SIDType');
    expect(settings).toContain('ProfileList');
    expect(settings).toContain('User Shell Folders');
    expect(settings).toContain("'Local AppData'");
    expect(settings).not.toMatch(/(?:Users|Usuários|Administrators|Administradores)/);
    expect(install).toContain('Assert-ExpedInteractiveUserSid');
  });

  it('isola agente por ManageAgent explícito nos dois pacotes', () => {
    expect(install).toMatch(/ManageAgent[\s\S]*'false'/);
    expect(uninstall).toMatch(/ManageAgent[\s\S]*'false'/);
    expect(unified).toMatch(/install-service\.ps1[\s\S]*-ManageAgent true/);
    expect(unified).toMatch(/uninstall-service\.ps1[\s\S]*-ManageAgent true/);
    expect(hubOnly).toMatch(/install-service\.ps1[\s\S]*-ManageAgent false/);
    expect(hubOnly).toMatch(/uninstall-service\.ps1[\s\S]*-ManageAgent false/);
    expect(hubOnly).not.toContain('agent-user-install.ps1');
  });

  it('aceita credenciais efêmeras sem registrar o segredo', () => {
    expect(provision).toContain('[string]$CredentialsFile');
    expect(provision).toContain('[string]$InstallerCapabilityFile');
    expectOrder(provision, ['$CredentialsFile', 'finally', 'Remove-Item -LiteralPath $credentialsPathToDelete']);
    expect(provision).not.toMatch(/Log[^\r\n]*(?:DeviceToken|\$token)/);
    expect(unified).not.toContain('-DeviceToken');
    expect(unified).not.toContain('-Code');
    expect(provision).toMatch(/Assert-ProtectedCredentialsFile|Assert-ProtectedSecretFile/);
    expect(provision).toMatch(/-DeviceToken[\s\S]*(?:ExpedSetup|CredentialsFile)/i);
    const execution = provision.slice(provision.indexOf('Initialize-ProvisionStorage'));
    expectOrder(execution, ['Consume-InstallerCapability', 'Read-ProvisionInput']);
    const install = routine(unified, 'RunTransactionalInstall');
    expectOrder(install, ['IssueProvisionCapability', 'provision.ps1', '-InstallerCapabilityFile']);
    expect(install).not.toMatch(/Nonce|CapabilityHash/);
    const orchestratorEntry = sectionEntries(unified, 'Files')
      .find((entry) => entry.includes('installer-orchestrator.ps1'));
    expect(orchestratorEntry).toContain('Flags: dontcopy');
    expect(orchestratorEntry).not.toContain('DestDir:');
  });

  it('só confirma start depois de processo exato e probe HTTP, com timeout e rollback', () => {
    const wait = routine(userHelper, 'Wait-ExpedAgentReady');
    const probe = routine(userHelper, 'Test-ExpedAgentHttpReady');
    const restore = userHelper.slice(
      userHelper.indexOf('function Restore-AgentTransaction'),
      userHelper.indexOf('$modeCount ='),
    );
    expect(wait).toMatch(/Get-ThisUserAgentProcesses/);
    expect(wait).toMatch(/Get-ExpedInstalledAgentSyncNowPort/);
    expect(wait).toContain('Test-ExpedAgentHttpReady');
    expect(probe).toMatch(/HttpWebRequest\]::Create[\s\S]*127\.0\.0\.1/);
    expect(probe).toMatch(/StatusCode[\s\S]*BadRequest/);
    expect(probe).toContain('$properties = @($body.PSObject.Properties.Name)');
    expect(probe).toMatch(/\$properties\s+-contains\s+'success'/);
    expect(probe).toMatch(/\$properties\s+-contains\s+'synced'/);
    expect(probe).toMatch(/\$properties\s+-contains\s+'error'/);
    expect(probe).not.toMatch(/\$properties\s+-contains\s+'msg'/);
    expect(wait).toMatch(/Deadline|Timeout/i);
    const startBlock = userHelper.slice(
      userHelper.lastIndexOf('if (-not (Test-Path -LiteralPath $startCmd)'),
    );
    expectOrder(startBlock, ['Start-Process', 'Wait-ExpedAgentReady']);
    expect(startBlock).toMatch(/catch[\s\S]*Restore-AgentTransaction[\s\S]*throw/i);
    expectOrder(restore, [
      'Start-Process',
      'Wait-ExpedAgentReady',
      'Remove-Item -LiteralPath $transaction.Dir',
    ]);
  });

  it('grava ambiente do NSSM direto no registro protegido, nunca em argumento nativo', () => {
    const serviceEnvironment = routine(install, 'Set-NssmServiceEnvironment');
    expect(serviceEnvironment).toContain('RegistryValueKind]::MultiString');
    expect(serviceEnvironment).toMatch(/RegistrySecurity|SetSecurityDescriptorSddlForm/);
    expect(serviceEnvironment).toContain('AppEnvironmentExtra');
    const nssmSettings = install.slice(
      install.indexOf('$nssmSettings = @('),
      install.indexOf('foreach ($setting in $nssmSettings)'),
    );
    expect(nssmSettings).not.toContain('AppEnvironmentExtra');
    expect(install).not.toMatch(/@\('set',\s*\$ServiceName,\s*'AppEnvironmentExtra'/);
    expectOrder(install, ['$nssmSettings = @(', 'Set-NssmServiceEnvironment $envMap']);
  });

  it('snapshot do serviço restaura a chave inteira e seus ACLs exatos', () => {
    const snapshot = routine(orchestrator, 'New-HubSnapshot');
    const restore = routine(orchestrator, 'Restore-HubServiceSnapshot');
    expect(snapshot).toContain('RegistryServiceAclBackup');
    expect(orchestrator).toContain('Get-HubServiceRegistryAclSnapshot');
    expect(orchestrator).toContain('Restore-HubServiceRegistryAcls');
    expectOrder(restore, [
      'Stop-HubServiceIfPresent',
      "@('delete', $serviceKey",
      "@('import', $registryBackup)",
      'Restore-HubServiceRegistryAcls',
    ]);
    expect(restore).not.toMatch(/Remove-Item[\s\S]*\\Parameters/);
  });

  it('não altera o trust store global e inclui firewall no rollback transacional', () => {
    expect(install).not.toMatch(/\$Mkcert\s+-Arguments\s+@\('-install'\)/i);
    expect(install).toMatch(/\$env:CAROOT[\s\S]*\$CertDir/i);
    expect(orchestrator).toContain('FirewallSnapshot');
    expect(orchestrator).toContain('Restore-FirewallSnapshot');
    expectOrder(routine(orchestrator, 'Restore-HubSnapshot'), [
      'Assert-HubSnapshotComplete',
      'Restore-FirewallSnapshot',
      'Restore-HubServiceSnapshot',
    ]);
  });

  it('captura existencia do servico antes de qualquer mutacao e preserva preexistente', () => {
    const executionStart = install.indexOf('# 0. Pre-condicoes');
    const firstMutation = executionStart + install.slice(executionStart)
      .search(/New-Item|Set-ExpedAgentSettings|Invoke-AgentUrlAclStep|Invoke-NativeChecked/);
    const serviceProbe = install.indexOf('$serviceExistedBefore =');
    expect(serviceProbe).toBeGreaterThanOrEqual(0);
    expect(serviceProbe).toBeLessThan(firstMutation);
    expect(install).toMatch(/\$serviceExistedBefore[\s\S]*catch[\s\S]*elseif \(-not \$serviceExistedBefore\)/i);
  });

  it('configura boot atrasado e reinicio controlado do ExpedHub', () => {
    const install = source('../win/install-service.ps1');
    const nssmSettings = install.slice(
      install.indexOf('$nssmSettings = @('),
      install.indexOf('foreach ($setting in $nssmSettings)'),
    );

    expect(nssmSettings).toContain("@('Start', 'SERVICE_DELAYED_AUTO_START')");
    expect(nssmSettings).toContain("@('AppThrottle', '5000')");
    expect(nssmSettings).toContain("@('AppRestartDelay', '5000')");
    expect(install).toMatch(/nssm[\s\S]*set[\s\S]*AppExit[\s\S]*Default[\s\S]*Restart/i);
    expect(install).toMatch(/sc\.exe[\s\S]*failure[\s\S]*restart\/10000/i);
    expect(install).toMatch(/sc\.exe[\s\S]*failureflag[\s\S]*1/i);
  });

  it('migra perfil legado do Agent ou falha fechado sem desabilitar silenciosamente', () => {
    expect(install).toMatch(/legacyAgentSettingsPath[\s\S]*Get-ExpedFileOwnerSid/i);
    expect(install).toMatch(/agentHasExactProfile[\s\S]*throw[\s\S]*Trusted_Connection/i);
    expect(install).not.toMatch(
      /-not \$agentHasExactProfile[\s\S]{0,180}\$agentStartupMode\s*=\s*'disabled'/i,
    );
  });

  it('substitui o watchdog legado por diagnostico sem mutar agente ou cursores', () => {
    expect(watchdog).toContain('config.json');
    expect(watchdog).toContain('/status');
    expect(watchdog).toContain('/sync-now');
    expect(watchdog).not.toMatch(/Get-ChildItem\s+['"]C:\\Users\\\*/i);
    expect(watchdog).not.toMatch(/(?:Start|Stop)-Process/i);
    expect(watchdog).not.toMatch(/WriteAllText[\s\S]*\bHwm\b/i);
    expect(watchdog).not.toMatch(/SqlConnection|pedido_venda|last_backfill/i);

    for (const installer of [unified, hubOnly]) {
      expect(sectionEntries(installer, 'Files').some((entry) =>
        entry.includes('watchdog.ps1') && entry.includes('DestDir: "{app}"'))).toBe(true);
    }
    expect(orchestrator).toMatch(/HubTransactionalFiles[\s\S]*watchdog\.ps1/);
  });

  it('uninstall ManageAgent=true falha fechado sem settings e owner comprovados', () => {
    const cleanup = routine(uninstall, 'Invoke-AgentCleanupAsOriginalUser');
    expect(cleanup).toMatch(/-not \$settingsPath[\s\S]*throw/i);
    expect(cleanup).toMatch(/Test-Path[^\r\n]*\$settingsPath[^\r\n]*PathType Leaf[\s\S]*throw/i);
    expect(cleanup).toMatch(/Get-ExpedFileOwnerSid\s+\$settingsPath/);
    expect(cleanup).toMatch(/ownerSid[\s\S]*userSid[\s\S]*throw/i);
    expect(cleanup).not.toMatch(/-not \$settingsPath\)\s*\{\s*return \$true/i);
  });

  it('rollback troca SID na mesma URL com compensação verificável', () => {
    const rollback = routine(preflight, 'Rollback-AgentUrlAcl');
    const replace = routine(preflight, 'Replace-AgentUrlAcl');
    expect(rollback).toMatch(/samePort[\s\S]*Replace-AgentUrlAcl/i);
    expect(replace).toMatch(/delete[\s\S]*add/i);
    expect(replace).toMatch(/catch[\s\S]*(?:current|atual)[\s\S]*add/i);
    expect(replace).toMatch(/Get-CurrentUrlAclSddl[\s\S]*ExpectedSddl/i);
    expect(rollback).not.toMatch(/recusou troca de SID na mesma URL/i);
  });

  it('persiste plano exato de URL ACL para rollback externo repetível', () => {
    expect(install).toContain('[string]$TransactionDir');
    expect(install).toContain('urlacl-rollback.json');
    expect(unified).toMatch(/install-service\.ps1[\s\S]*-TransactionDir/);
    const rollback = routine(orchestrator, 'Rollback-AgentUrlAcl');
    expect(rollback).toContain('urlacl-rollback.json');
    expect(rollback).toMatch(/Previous[\s\S]*Current/i);
    const innoRollback = routine(unified, 'RollbackAgentUrlAclAfterFailure');
    expect(innoRollback).toMatch(/AgentUrlAclRollbackDone\s*:=\s*False/i);
  });

  it('não inicia serviço parcialmente mutado antes do rollback externo do instalador', () => {
    const failure = install.slice(install.lastIndexOf('} catch {\n    $failure'));
    expect(failure).toMatch(/if\s*\(\$TransactionDir\)[\s\S]*rollback externo/i);
    expect(failure.indexOf('if ($TransactionDir)')).toBeLessThan(
      failure.indexOf('if ($serviceExistedBefore -and $serviceWasRunningBefore)'),
    );
  });
});

describe('configuração live dos clientes do agente', () => {
  it('lê IOptionsMonitor.CurrentValue a cada operação de rede', () => {
    const ingest = source('../../agent/ExpedAgent/IngestClient.cs');
    const remote = source('../../agent/ExpedAgent/RemoteConfigClient.cs');

    expect(ingest).toContain('IOptionsMonitor<AgentConfig>');
    expect(remote).toContain('IOptionsMonitor<AgentConfig>');
    expect(ingest).not.toMatch(/\bAgentConfig\s+cfg\b/);
    expect(remote).not.toMatch(/\bAgentConfig\s+cfg\b/);
    expect(ingest.match(/\.CurrentValue/g)?.length).toBeGreaterThanOrEqual(5);
    expect(remote.match(/\.CurrentValue/g)?.length).toBeGreaterThanOrEqual(1);
  });
});
