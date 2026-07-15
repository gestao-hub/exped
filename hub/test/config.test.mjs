import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../config.mjs';

const PLACEHOLDER = 'exped-local-super-secret-jwt-with-at-least-32-chars';
const VALID = 'um-segredo-forte-de-instalacao-com-mais-de-32-chars';

describe('config.loadConfig — jwtSecret obrigatório', () => {
  let saved;
  beforeEach(() => {
    saved = process.env.EXPED_JWT_SECRET;
    delete process.env.EXPED_JWT_SECRET;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.EXPED_JWT_SECRET;
    else process.env.EXPED_JWT_SECRET = saved;
  });

  it('lança se não há env nem override', () => {
    expect(() => loadConfig()).toThrow();
  });

  it('lança se o segredo é o placeholder conhecido', () => {
    expect(() => loadConfig({ jwtSecret: PLACEHOLDER })).toThrow();
    process.env.EXPED_JWT_SECRET = PLACEHOLDER;
    expect(() => loadConfig()).toThrow();
  });

  it('lança se o segredo tem menos de 32 chars', () => {
    expect(() => loadConfig({ jwtSecret: 'curto' })).toThrow();
  });

  it('retorna cfg com o jwtSecret válido via override', () => {
    const cfg = loadConfig({ jwtSecret: VALID });
    expect(cfg.jwtSecret).toBe(VALID);
  });

  it('retorna cfg com o jwtSecret válido via env', () => {
    process.env.EXPED_JWT_SECRET = VALID;
    const cfg = loadConfig();
    expect(cfg.jwtSecret).toBe(VALID);
  });
});

describe('config.loadConfig — pgData vs pgHost (Bug 2 portabilidade Windows)', () => {
  const ENVS = ['EXPED_PG_DATA', 'EXPED_PG_HOST'];
  let savedJwt;
  let savedEnvs;
  beforeEach(() => {
    savedJwt = process.env.EXPED_JWT_SECRET;
    process.env.EXPED_JWT_SECRET = VALID;
    savedEnvs = {};
    for (const k of ENVS) {
      savedEnvs[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    if (savedJwt === undefined) delete process.env.EXPED_JWT_SECRET;
    else process.env.EXPED_JWT_SECRET = savedJwt;
    for (const k of ENVS) {
      if (savedEnvs[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnvs[k];
    }
  });

  it('default: pgData e pgHost coincidem no socket dir do Linux', () => {
    const cfg = loadConfig();
    expect(cfg.paths.pgData).toBe('/tmp/exped-pg');
    expect(cfg.paths.pgHost).toBe('/tmp/exped-pg');
  });

  it('EXPED_PG_DATA e EXPED_PG_HOST sao respeitadas independentemente', () => {
    process.env.EXPED_PG_DATA = 'C:\\Exped\\data\\pg';
    process.env.EXPED_PG_HOST = '127.0.0.1';
    const cfg = loadConfig();
    expect(cfg.paths.pgData).toBe('C:\\Exped\\data\\pg');
    expect(cfg.paths.pgHost).toBe('127.0.0.1');
  });

  it('EXPED_PG_HOST sozinho NAO vira data dir (pgData fica no default)', () => {
    process.env.EXPED_PG_HOST = '127.0.0.1';
    const cfg = loadConfig();
    expect(cfg.paths.pgHost).toBe('127.0.0.1');
    expect(cfg.paths.pgData).toBe('/tmp/exped-pg');
  });

  it('overrides.paths tem prioridade sobre env para pgData/pgHost', () => {
    process.env.EXPED_PG_DATA = '/env/data';
    const cfg = loadConfig({ paths: { pgData: '/over/data', pgHost: '/over/host' } });
    expect(cfg.paths.pgData).toBe('/over/data');
    expect(cfg.paths.pgHost).toBe('/over/host');
  });
});

describe('config — defaults de release', () => {
  it('tem version, releasesDir e releasesPtr', () => {
    const cfg = loadConfig({ jwtSecret: 'x'.repeat(40) });
    expect(typeof cfg.version).toBe('string');
    expect(cfg.paths.releasesDir).toBeTruthy();
    expect(cfg.paths.releasesPtr).toBeTruthy();
  });
});

describe('config — versão por env', () => {
  it('EXPED_VERSION sobrescreve cfg.version', () => {
    const orig = process.env.EXPED_VERSION;
    process.env.EXPED_VERSION = '1.4.2';
    try {
      const cfg = loadConfig({ jwtSecret: 'x'.repeat(40) });
      expect(cfg.version).toBe('1.4.2');
    } finally {
      if (orig === undefined) delete process.env.EXPED_VERSION;
      else process.env.EXPED_VERSION = orig;
    }
  });
});

describe('config — sync sob demanda do agente', () => {
  const key = 'EXPED_AGENT_SYNC_PORT';
  let saved;

  beforeEach(() => {
    saved = process.env[key];
    delete process.env[key];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  });

  it('usa a porta local padrão', () => {
    expect(loadConfig({ jwtSecret: VALID }).agent.syncNowPort).toBe(5005);
  });

  it('aceita porta customizada e zero para desativar', () => {
    process.env[key] = '6005';
    expect(loadConfig({ jwtSecret: VALID }).agent.syncNowPort).toBe(6005);

    process.env[key] = '0';
    expect(loadConfig({ jwtSecret: VALID }).agent.syncNowPort).toBe(0);
  });
});

describe('config — contrato de startup do agente', () => {
  it('declara somente recuperacao no logon interativo', () => {
    const cfg = loadConfig({ jwtSecret: VALID });
    expect(cfg.agent.startupMode).toBe('interactive_logon');
    expect(cfg.agent.survivesRebootWithoutLogon).toBe(false);
    expect(cfg.agent.healthPath).toMatch(/ExpedAgent.*health\.json/i);
  });

  it('recusa windows_service sem servico real e identidade comprovada', () => {
    expect(() => loadConfig({
      jwtSecret: VALID,
      agent: { startupMode: 'windows_service' },
    })).toThrow(/interactive_logon|windows_service/i);
  });

  it('mantem disabled verdadeiro sem prometer recuperacao pre-login', () => {
    const cfg = loadConfig({
      jwtSecret: VALID,
      agent: { startupMode: 'disabled', syncNowPort: 0 },
    });
    expect(cfg.agent.startupMode).toBe('disabled');
    expect(cfg.agent.survivesRebootWithoutLogon).toBe(false);
  });

  it('recusa afirmar sobrevivencia a reboot sem login', () => {
    expect(() => loadConfig({
      jwtSecret: VALID,
      agent: { survivesRebootWithoutLogon: true },
    })).toThrow(/survivesRebootWithoutLogon|sem login/i);
  });
});
