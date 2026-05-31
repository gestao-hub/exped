import net from 'node:net';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Espera um endpoint HTTP ficar pronto. Resolve true assim que responder com
 * status < 500. Rejeita se o deadline passar sem nenhuma resposta utilizável.
 */
export async function waitForHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.status < 500) return true;
    } catch {
      /* ainda subindo */
    }
    await sleep(500);
  }
  throw new Error(`health timeout: ${url}`);
}

/**
 * Espera uma porta TCP aceitar conexão. Resolve true na primeira conexão
 * bem-sucedida. Rejeita se o deadline passar sem conseguir conectar.
 */
export async function waitForTcp(host, port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const s = net.connect({ host, port }, () => {
        s.end();
        resolve(true);
      });
      s.on('error', () => resolve(false));
      s.setTimeout(1500, () => {
        s.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await sleep(500);
  }
  throw new Error(`tcp timeout: ${host}:${port}`);
}
