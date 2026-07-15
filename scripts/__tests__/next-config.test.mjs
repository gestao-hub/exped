import { describe, expect, it } from 'vitest';
import nextConfig, { resolveBuildId } from '../../next.config';

describe('next.config build id', () => {
  it('prioriza EXPED_BUILD_ID, GITHUB_SHA e VERCEL_GIT_COMMIT_SHA nessa ordem', () => {
    expect(resolveBuildId({
      EXPED_BUILD_ID: 'exped-build-1234567',
      GITHUB_SHA: 'a'.repeat(40),
      VERCEL_GIT_COMMIT_SHA: 'b'.repeat(40),
    })).toBe('exped-build-1234567');
    expect(resolveBuildId({
      GITHUB_SHA: 'a'.repeat(40),
      VERCEL_GIT_COMMIT_SHA: 'b'.repeat(40),
    })).toBe('a'.repeat(40));
    expect(resolveBuildId({
      VERCEL_GIT_COMMIT_SHA: 'b'.repeat(40),
    })).toBe('b'.repeat(40));
  });

  it('produz o mesmo BUILD_ID em geracoes remotas do mesmo SHA', () => {
    const env = { GITHUB_SHA: 'c'.repeat(40) };
    expect(resolveBuildId(env)).toBe(resolveBuildId(env));
  });

  it('usa fallback local unico quando nao existe identidade remota', () => {
    const first = resolveBuildId({});
    const second = resolveBuildId({});
    expect(first).toMatch(/^local-[0-9a-f-]{36}$/);
    expect(second).toMatch(/^local-[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
  });

  it('rejeita BUILD_ID remoto inseguro', () => {
    expect(() => resolveBuildId({ EXPED_BUILD_ID: '../release' }))
      .toThrow('BUILD_ID remoto invalido');
  });

  it('mantem standalone e conecta generateBuildId ao resolvedor', async () => {
    expect(nextConfig.output).toBe('standalone');
    expect(nextConfig.generateBuildId).toBeTypeOf('function');
    await expect(nextConfig.generateBuildId?.()).resolves.toMatch(/^(local-|[A-Za-z0-9])/);
  });
});
