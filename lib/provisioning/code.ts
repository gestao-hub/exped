// lib/provisioning/code.ts
import { randomBytes, createHash } from 'node:crypto';

/** Alfabeto sem caracteres ambíguos (sem 0,O,1,I,L). 31 símbolos. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Remove tudo que não é A-Z/0-9 e sobe pra maiúsculo (p/ digitação tolerante). */
export function normalizeCodigo(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** SHA-256 (hex) do código normalizado — o que guardamos no banco. */
export function hashCodigo(raw: string): string {
  return createHash('sha256').update(normalizeCodigo(raw)).digest('hex');
}

/** n caracteres aleatórios do ALPHABET com rejection sampling (sem viés de módulo). */
function randomChars(n: number): string {
  const out: string[] = [];
  const limit = 256 - (256 % ALPHABET.length); // 248 = 31*8
  while (out.length < n) {
    for (const b of randomBytes(n * 2)) {
      if (b < limit) {
        out.push(ALPHABET[b % ALPHABET.length]);
        if (out.length === n) break;
      }
    }
  }
  return out.join('');
}

/** Gera o código cru `EXPED-XXXX-XXXX` + seu hash. O cru é exibido 1x ao operador. */
export function gerarCodigoInstalacao(): { raw: string; hash: string } {
  const raw = `EXPED-${randomChars(4)}-${randomChars(4)}`;
  return { raw, hash: hashCodigo(raw) };
}
