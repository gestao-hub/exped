import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildManifest, sha256Buffer, versaoValida } from '../release-hub.mjs';

describe('release-hub (partes puras)', () => {
  it('buildManifest monta {versao,url,sha256}', () => {
    expect(buildManifest('1.2.0', 'https://x/h/1.2.0.zip', 'abc')).toEqual({
      versao: '1.2.0', url: 'https://x/h/1.2.0.zip', sha256: 'abc',
    });
  });
  it('sha256Buffer = hash hex do buffer', () => {
    const buf = Buffer.from('hello');
    expect(sha256Buffer(buf)).toBe(createHash('sha256').update(buf).digest('hex'));
  });
  it('versaoValida aceita semver limpo, rejeita lixo', () => {
    expect(versaoValida('1.2.0')).toBe(true);
    expect(versaoValida('v1.2.0')).toBe(false);
    expect(versaoValida('1.2.0; rm')).toBe(false);
  });
});
