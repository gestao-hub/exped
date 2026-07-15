import { describe, expect, it } from 'vitest';
import {
  currentVersionForForceUpdate,
  resolveForceUpdatePaths,
} from '../force-update.mjs';

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
