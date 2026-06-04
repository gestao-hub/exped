import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveLiveSource } from '../use-live-updates';

afterEach(() => vi.unstubAllGlobals());

describe('resolveLiveSource', () => {
  it('no hub (__SUPABASE_USE_ORIGIN__) → SSE em /avisos da origem', () => {
    vi.stubGlobal('window', { __SUPABASE_USE_ORIGIN__: true, location: { origin: 'https://10.1.1.30' } });
    expect(resolveLiveSource('E1')).toEqual({ kind: 'sse', url: 'https://10.1.1.30/avisos?empresa=E1' });
  });
  it('na nuvem → channel', () => {
    vi.stubGlobal('window', { location: { origin: 'https://app.vercel.app' } });
    expect(resolveLiveSource('E1')).toEqual({ kind: 'channel' });
  });
});
