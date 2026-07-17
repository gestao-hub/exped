import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as forceUpdate from '../force-update.mjs';

const {
  currentVersionForForceUpdate,
  resolveForceUpdatePaths,
} = forceUpdate;

describe('force-update current version policy', () => {
  it('usa a versao real do ponteiro antes da versao baked no config', () => {
    expect(currentVersionForForceUpdate(
      '/releases/current',
      '1.5.0',
      () => ' 2.3.0\n',
    )).toBe('2.3.0');
  });

  it('cai para cfg.version quando o ponteiro esta ausente ou vazio', () => {
    expect(currentVersionForForceUpdate(
      '/releases/current',
      '1.5.0',
      () => { throw new Error('ENOENT'); },
    )).toBe('1.5.0');
    expect(currentVersionForForceUpdate(
      '/releases/current',
      '1.5.0',
      () => '   ',
    )).toBe('1.5.0');
  });

  it('usa 0.0.0 somente quando ponteiro e config nao informam versao', () => {
    expect(currentVersionForForceUpdate('/releases/current', undefined, () => ''))
      .toBe('0.0.0');
  });
});

describe('force-update path policy no Windows', () => {
  it('resolve caminhos relativos contra C:\\Exped, nunca System32', () => {
    expect(resolveForceUpdatePaths({
      platform: 'win32',
      cwd: 'C:\\Windows\\System32',
      configPath: 'config.json',
      releasesDir: 'releases',
      releasesPtr: 'releases\\current',
    })).toMatchObject({
      root: 'C:\\Exped',
      configPath: 'C:\\Exped\\config.json',
      releasesDir: 'C:\\Exped\\releases',
      pointerPath: 'C:\\Exped\\releases\\current',
    });
  });

  it('respeita Root explicito para config e releases relativos', () => {
    expect(resolveForceUpdatePaths({
      platform: 'win32',
      cwd: 'C:\\Windows\\System32',
      root: 'D:\\ExpedLoja',
      configPath: 'config.json',
      releasesDir: 'payloads',
      releasesPtr: 'payloads\\active',
    })).toMatchObject({
      root: 'D:\\ExpedLoja',
      configPath: 'D:\\ExpedLoja\\config.json',
      releasesDir: 'D:\\ExpedLoja\\payloads',
      pointerPath: 'D:\\ExpedLoja\\payloads\\active',
    });
  });
});

describe('force-update service restart no Windows', () => {
  it('usa o Service Manager e aguarda stop/start em vez do restart fragil do NSSM', () => {
    const calls = [];

    forceUpdate.restartWindowsService('ExpedHub', (...args) => calls.push(args));

    expect(calls).toHaveLength(1);
    const [file, args, options] = calls[0];
    expect(file).toBe('powershell.exe');
    expect(args).not.toContain('--');
    const command = args[args.indexOf('-Command') + 1];
    expect(command).toContain('$env:EXPED_WINDOWS_SERVICE_NAME');
    expect(command).toContain('Stop-Service');
    expect(command).toContain("WaitForStatus('Stopped'");
    expect(command).toContain('Start-Service');
    expect(command).toContain("WaitForStatus('Running'");
    expect(command).not.toContain('ExpedHub');
    expect(options).toMatchObject({
      stdio: 'inherit',
      env: { EXPED_WINDOWS_SERVICE_NAME: 'ExpedHub' },
    });

    const encoded = Buffer.from(command, 'utf16le').toString('base64');
    const parsed = spawnSync('pwsh', [
      '-NoLogo',
      '-NoProfile',
      '-Command',
      "$source=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($env:EXPED_TEST_PS));" +
        '$tokens=$null;$errors=$null;' +
        '[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)|Out-Null;' +
        'if($errors.Count){$errors|ForEach-Object{Write-Error $_.Message};exit 1}',
    ], {
      encoding: 'utf8',
      env: { ...process.env, EXPED_TEST_PS: encoded },
    });
    expect(parsed.status, parsed.stderr || parsed.stdout).toBe(0);

    const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
    const argumentProbe = spawnSync(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-Command',
      '$env:EXPED_WINDOWS_SERVICE_NAME',
    ], {
      encoding: 'utf8',
      env: { ...process.env, EXPED_WINDOWS_SERVICE_NAME: 'ExpedHub' },
    });
    expect(argumentProbe.status, argumentProbe.stderr).toBe(0);
    expect(argumentProbe.stdout.trim()).toBe('ExpedHub');
  }, 30_000);
});
