import { randomBytes, createHash } from 'node:crypto';

/** SHA-256 (hex) de um token — o que guardamos no banco (nunca o token cru). */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Gera um token de dispositivo aleatório + seu hash. O `raw` é exibido 1x ao operador. */
export function gerarTokenDispositivo(): { raw: string; hash: string } {
  const raw = 'hpr_' + randomBytes(24).toString('hex');
  return { raw, hash: hashToken(raw) };
}
