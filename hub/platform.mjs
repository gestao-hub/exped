// Helpers de plataforma para o hub local. Isolados pra ficarem testáveis sem
// depender do SO real (o 2º arg `plat` permite simular nos testes).

import process from 'node:process';

/**
 * Resolve o caminho de um binário nativo para spawn. No Windows o spawn NÃO
 * auto-anexa ".exe", então acrescentamos quando faltar. Em outros SOs devolve
 * o caminho inalterado.
 */
export function exe(p, plat = process.platform) {
  if (plat === 'win32' && !p.toLowerCase().endsWith('.exe')) {
    return `${p}.exe`;
  }
  return p;
}

export default exe;
