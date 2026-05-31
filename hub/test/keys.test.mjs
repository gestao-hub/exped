import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { mintJwt, makeKeys } from '../keys.mjs';

const SECRET = 'exped-local-super-secret-jwt-with-at-least-32-chars';

function b64urlDecode(s) {
  return Buffer.from(s, 'base64url').toString('utf8');
}

describe('keys (JWT HS256 em node:crypto puro)', () => {
  it('mintJwt produz 3 partes separadas por "."', () => {
    const jwt = mintJwt('anon', SECRET);
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    expect(parts.every((p) => p.length > 0)).toBe(true);
  });

  it('a assinatura confere ao recomputar o HMAC-SHA256', () => {
    const jwt = mintJwt('service_role', SECRET);
    const [h, p, sig] = jwt.split('.');
    const expected = crypto
      .createHmac('sha256', SECRET)
      .update(`${h}.${p}`)
      .digest('base64url');
    expect(sig).toBe(expected);
  });

  it('o header é {"alg":"HS256","typ":"JWT"}', () => {
    const [h] = mintJwt('anon', SECRET).split('.');
    expect(JSON.parse(b64urlDecode(h))).toEqual({ alg: 'HS256', typ: 'JWT' });
  });

  it('o payload contém o role correto e nenhum exp', () => {
    const [, p] = mintJwt('anon', SECRET).split('.');
    const payload = JSON.parse(b64urlDecode(p));
    expect(payload.role).toBe('anon');
    expect(payload.exp).toBeUndefined();
  });

  it('makeKeys retorna anon e service com os roles certos', () => {
    const { anon, service } = makeKeys(SECRET);
    const roleOf = (jwt) => JSON.parse(b64urlDecode(jwt.split('.')[1])).role;
    expect(roleOf(anon)).toBe('anon');
    expect(roleOf(service)).toBe('service_role');
  });

  it('é determinístico para o mesmo secret/role', () => {
    expect(mintJwt('anon', SECRET)).toBe(mintJwt('anon', SECRET));
  });
});
