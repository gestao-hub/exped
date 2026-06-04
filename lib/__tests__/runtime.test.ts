import { describe, it, expect, afterEach, vi } from 'vitest';
import { isHub } from '../runtime';

afterEach(() => vi.unstubAllEnvs());

describe('isHub', () => {
  it('true quando SUPABASE_URL é localhost (hub)', () => {
    vi.stubEnv('EXPED_HUB', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('SUPABASE_URL', 'http://127.0.0.1:54340');
    expect(isHub()).toBe(true);
  });
  it('false quando SUPABASE_URL é a nuvem', () => {
    vi.stubEnv('EXPED_HUB', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('SUPABASE_URL', 'https://louaguxcohfeicxxqggw.supabase.co');
    expect(isHub()).toBe(false);
  });
  it('true quando EXPED_HUB=1 mesmo com URL da nuvem (override explícito)', () => {
    vi.stubEnv('EXPED_HUB', '1');
    vi.stubEnv('SUPABASE_URL', 'https://louaguxcohfeicxxqggw.supabase.co');
    expect(isHub()).toBe(true);
  });
});
