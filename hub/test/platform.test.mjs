import { describe, it, expect } from 'vitest';
import { exe } from '../platform.mjs';

describe('platform.exe', () => {
  it('anexa .exe no Windows', () => {
    expect(exe('/x/postgrest', 'win32')).toBe('/x/postgrest.exe');
  });

  it('não anexa .exe fora do Windows', () => {
    expect(exe('/x/postgrest', 'linux')).toBe('/x/postgrest');
    expect(exe('/x/postgrest', 'darwin')).toBe('/x/postgrest');
  });

  it('não duplica .exe se o caminho já termina em .exe (Windows)', () => {
    expect(exe('/x/postgrest.exe', 'win32')).toBe('/x/postgrest.exe');
  });

  it('usa process.platform quando o 2º arg é omitido', () => {
    const expected = process.platform === 'win32' ? '/x/auth.exe' : '/x/auth';
    expect(exe('/x/auth')).toBe(expected);
  });
});
