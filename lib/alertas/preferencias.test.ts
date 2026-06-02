import { describe, it, expect } from 'vitest';
import {
  PREFERENCIAS_PADRAO,
  mesclarPreferencias,
  chaveStorage,
  carregar,
  salvar,
  type PreferenciasAviso,
} from './preferencias';

describe('preferencias de aviso', () => {
  it('mescla parcial sobre os defaults', () => {
    const r = mesclarPreferencias({ som: false, somId: 'alarme' });
    expect(r).toEqual({ ...PREFERENCIAS_PADRAO, som: false, somId: 'alarme' });
  });

  it('ignora campos inválidos e cai no default', () => {
    const r = mesclarPreferencias({ somId: 'inexistente', ativado: 'sim' as unknown });
    expect(r.somId).toBe(PREFERENCIAS_PADRAO.somId);
    expect(r.ativado).toBe(PREFERENCIAS_PADRAO.ativado);
  });

  it('mesclarPreferencias(null) devolve uma cópia dos defaults', () => {
    expect(mesclarPreferencias(null)).toEqual(PREFERENCIAS_PADRAO);
  });

  it('chaveStorage inclui o userId', () => {
    expect(chaveStorage('u1')).toBe('exped:avisos:u1');
  });

  it('salvar + carregar faz round-trip via storage injetado', () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
    const prefs: PreferenciasAviso = { ...PREFERENCIAS_PADRAO, ativado: true, somId: 'bipe' };
    salvar('u1', prefs, storage);
    expect(carregar('u1', storage)).toEqual(prefs);
  });

  it('carregar com storage vazio devolve defaults', () => {
    const storage = { getItem: () => null, setItem: () => {} };
    expect(carregar('u1', storage)).toEqual(PREFERENCIAS_PADRAO);
  });

  it('carregar com JSON corrompido devolve defaults (não lança)', () => {
    const storage = { getItem: () => '{lixo', setItem: () => {} };
    expect(carregar('u1', storage)).toEqual(PREFERENCIAS_PADRAO);
  });
});
