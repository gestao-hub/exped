// Geração das chaves anon/service_role do Supabase local (JWT HS256), em
// node:crypto puro — sem bash, sem python3, sem libs externas. Roda igual em
// Windows limpo. Equivalente ao scripts/local-stack/make-keys.sh do spike,
// porém sem dependências de ambiente.

import crypto from 'node:crypto';

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/**
 * Assina um JWT HS256 sem expiração com o payload mínimo { role }.
 * header: {"alg":"HS256","typ":"JWT"} ; payload: {"role":"<role>"}.
 */
export function mintJwt(role, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ role }));
  const signingInput = `${header}.${payload}`;
  const sig = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${sig}`;
}

/**
 * Verifica um JWT HS256: recomputa o HMAC-SHA256 sobre `header.payload` e
 * compara com a assinatura em tempo constante (crypto.timingSafeEqual).
 * Retorna o payload decodificado se válido; `null` se malformado/inválido.
 * Nunca lança.
 */
export function verifyJwt(token, secret) {
  try {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, payload, sig] = parts;
    if (!header || !payload || !sig) return null;
    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${header}.${payload}`)
      .digest();
    const got = Buffer.from(sig, 'base64url');
    if (got.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(got, expected)) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Retorna { anon, service } assinadas com o mesmo secret. */
export function makeKeys(secret) {
  return {
    anon: mintJwt('anon', secret),
    service: mintJwt('service_role', secret),
  };
}

export default makeKeys;
