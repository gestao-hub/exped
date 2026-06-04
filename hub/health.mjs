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
 * Probe ÚNICO (não fica retentando, ao contrário de waitForTcp): há algo
 * aceitando conexão TCP em host:port agora? Resolve true se conectou, false se
 * recusou/timeout/erro. Usado pelo /status pra refletir o estado REAL de uma
 * peça cujo processo supervisionado não representa o daemon (ex.: Postgres, que
 * sobe via `pg_ctl start` — um lançador one-shot que sai após disparar o
 * postmaster). Checar a porta diz a verdade; checar o child do pg_ctl, não.
 */
export function tcpAlive(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(ok);
    };
    const s = net.connect({ host, port }, () => finish(true));
    s.on('error', () => finish(false));
    s.setTimeout(timeoutMs, () => finish(false));
  });
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
