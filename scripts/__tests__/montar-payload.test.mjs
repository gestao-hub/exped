import { describe, it, expect } from 'vitest';
import { planoDeCopias, LOCAL_STACK_FILES } from '../montar-payload.mjs';

describe('montar-payload planoDeCopias', () => {
  it('cobre app standalone, static, hub, migrations', () => {
    const p = planoDeCopias();
    const paras = p.map((c) => c.para);
    expect(paras).toContain('app');
    expect(paras).toContain('app/.next/static');
    expect(paras).toContain('hub');
    expect(paras).toContain('supabase/migrations');
  });
  it('inclui os 6 arquivos do local-stack', () => {
    const p = planoDeCopias();
    for (const f of LOCAL_STACK_FILES) {
      expect(p.some((c) => c.de === `scripts/local-stack/${f}`)).toBe(true);
    }
    expect(LOCAL_STACK_FILES).toHaveLength(6);
  });
  it('inclui o watchdog exigido pelos dois instaladores', () => {
    expect(planoDeCopias()).toContainEqual({
      de: 'hub/watchdog.ps1',
      para: 'hub/watchdog.ps1',
      tipo: 'arquivo',
    });
  });
});
