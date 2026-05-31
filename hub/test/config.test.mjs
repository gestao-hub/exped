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
