// Porteiro de rede (LAN) do hub Exped — a ÚNICA peça que escuta em 0.0.0.0.
//
// Termina TLS (se há cert) e roteia por prefixo de caminho pras peças locais
// (todas em 127.0.0.1):
//   /auth/v1,/rest/v1,/storage/v1  -> gateway Supabase
//   /avisos                        -> events (SSE, tempo-real)
//   /* (resto)                     -> app Next standalone
//
// Single-origin: as 5 máquinas abrem https://<ip-do-servidor> e tudo (app +
// Supabase + SSE) vem da mesma origem → sem CORS, sem mixed-content, e a
// Notification API funciona (contexto seguro via HTTPS).

import http from 'node:http';
import https from 'node:https';
import { createSecureContext as tlsCreateSecureContext } from 'node:tls';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Roteia por prefixo de caminho. Supabase->gateway; /avisos->events; resto->app. */
export function pickFrontdoorTarget(url, ports) {
  if (/^\/(auth|rest|storage)\/v1(\/|$|\?)/.test(url)) {
    return { host: '127.0.0.1', port: ports.gateway, name: 'gateway' };
  }
  if (url === '/avisos' || url.startsWith('/avisos/') || url.startsWith('/avisos?')) {
    return { host: '127.0.0.1', port: ports.events, name: 'events' };
  }
  return { host: '127.0.0.1', port: ports.app, name: 'app' };
}

function makeHandler(ports) {
  return (req, res) => {
    const target = pickFrontdoorTarget(req.url || '/', ports);
    const proxyReq = http.request(
      {
        host: target.host,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: target.name === 'app' ? { ...req.headers, 'x-forwarded-host': req.headers['x-forwarded-host'] || req.headers.host, 'x-forwarded-proto': req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http') } : { ...req.headers, host: `${target.host}:${target.port}` },
      },
      (proxyRes) => {
        // Repassa status+headers crus e faz pipe (inclui SSE: stream aberto, sem buffer).
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
        proxyRes.on('error', () => res.destroy());
      },
    );
    proxyReq.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `frontdoor: ${target.name} indisponivel: ${err.message}` }));
    });
    // CRÍTICO p/ SSE: se o cliente (browser) desconecta — fecha aba, recarrega, rede cai —
    // derruba a conexão upstream também. Sem isto, o socket frontdoor→events fica aberto pra
    // sempre, o events nunca remove o cliente-fantasma e segue escrevendo/heartbeat num morto.
    res.on('close', () => proxyReq.destroy());
    req.pipe(proxyReq);
  };
}

/**
 * cert: lê server.key/server.crt do certDir. Ausente OU inválido/corrompido => null
 * (roda HTTP). Half-write do mkcert / disco cheio / antivírus não pode brickar o porteiro.
 */
function loadCert(certDir) {
  if (!certDir) return null;
  const key = path.join(certDir, 'server.key');
  const crt = path.join(certDir, 'server.crt');
  if (!existsSync(key) || !existsSync(crt)) return null;
  try {
    const tls = { key: readFileSync(key), cert: readFileSync(crt) };
    // valida cedo: createSecureContext lança em PEM inválido — aqui cai p/ HTTP, não crasha.
    tlsCreateSecureContext(tls);
    return tls;
  } catch (e) {
    console.error(`[frontdoor] cert invalido/ilegivel (${e.message}) — caindo p/ HTTP`);
    return null;
  }
}

/** Sobe o porteiro em 0.0.0.0:port. HTTPS se há cert válido; senão HTTP. Em EADDRINUSE,
 * tenta a porta de fallback uma vez. NUNCA deixa um erro de bind virar crash não-tratado. */
export function startFrontdoor({ port, ports, certDir, fallbackPort = null }) {
  const tls = loadCert(certDir);
  const h = makeHandler(ports);
  const server = tls ? https.createServer(tls, h) : http.createServer(h);
  const isHttps = !!tls;
  let triedFallback = false;

  const bind = (p) => {
    server.listen(p, '0.0.0.0', () => {
      console.log(`[frontdoor] ${isHttps ? 'https' : 'http'} 0.0.0.0:${server.address().port} -> app:${ports.app} gw:${ports.gateway} events:${ports.events}`);
    });
  };
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && fallbackPort && !triedFallback && port !== fallbackPort) {
      triedFallback = true;
      console.error(`[frontdoor] porta ${port} ocupada (EADDRINUSE) — tentando fallback ${fallbackPort}`);
      setTimeout(() => bind(fallbackPort), 300);
    } else {
      // Erro tratado (sem crash não-tratado → sem loop de respawn apertado). Operador vê o log.
      console.error(`[frontdoor] erro de bind na porta ${port}: ${err.message}`);
    }
  });
  bind(port);
  return server;
}

const isMain = (() => {
  try {
    return fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isMain) {
  startFrontdoor({
    port: Number(process.env.FRONTDOOR_PORT || 443),
    fallbackPort: Number(process.env.FRONTDOOR_FALLBACK_PORT || 8443),
    ports: {
      app: Number(process.env.APP_PORT || 3000),
      gateway: Number(process.env.GATEWAY_PORT || 54320),
      events: Number(process.env.EVENTS_PORT || 54350),
    },
    certDir: process.env.CERT_DIR || '',
  });
}
