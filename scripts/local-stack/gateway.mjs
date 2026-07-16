// Gateway 1-URL para o stack Supabase local nativo (spike "Jeito A").
//
// O supabase-js espera UMA URL base com /auth/v1/*, /rest/v1/*, /storage/v1/*.
// Aqui PostgREST e GoTrue rodam em portas separadas, então este proxy reverso
// (Node puro, sem deps) une tudo numa porta só, roteando por prefixo de caminho:
//
//   /auth/v1/*    -> GoTrue     127.0.0.1:9999   (remove prefixo /auth/v1)
//   /rest/v1/*    -> PostgREST  127.0.0.1:54331  (remove prefixo /rest/v1)
//   /storage/v1/* -> storage local (hub/storage-local.mjs) 127.0.0.1:5402 (mantém prefixo)
//
// Repassa método + headers (Authorization, apikey, Content-Type, Prefer, etc.) + body.
//
// Subir em background:
//   node scripts/local-stack/gateway.mjs > /tmp/gateway.log 2>&1 &

import http from 'node:http';

const PORT = Number(process.env.GATEWAY_PORT || 54320);
const STORAGE_PORT = Number(process.env.STORAGE_PORT || 5402);
const ACCESS_LOG_ENABLED = process.env.GATEWAY_ACCESS_LOG === '1';

const TARGETS = [
  { prefix: '/auth/v1', host: '127.0.0.1', port: 9999, name: 'gotrue' },
  { prefix: '/rest/v1', host: '127.0.0.1', port: 54331, name: 'postgrest' },
  // Storage local (hub/storage-local.mjs) espera o path COMPLETO /storage/v1/object/...,
  // então mantemos o prefixo (keepPrefix) em vez de removê-lo como nas demais rotas.
  { prefix: '/storage/v1', host: '127.0.0.1', port: STORAGE_PORT, name: 'storage', keepPrefix: true },
];

function pickTarget(url) {
  for (const t of TARGETS) {
    if (url === t.prefix || url.startsWith(t.prefix + '/') || url.startsWith(t.prefix + '?')) {
      return t;
    }
  }
  return null;
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';

  const target = pickTarget(url);
  if (!target) {
    console.log(`${req.method} ${url} -> 404 (sem rota)`);
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `nenhuma rota para ${url}` }));
    return;
  }

  // Reescreve o path tirando o prefixo (/auth/v1 ou /rest/v1). Para o storage,
  // keepPrefix=true mantém o /storage/v1 intacto (o servidor local casa o path completo).
  let downstreamPath;
  if (target.keepPrefix) {
    downstreamPath = url;
  } else {
    downstreamPath = url.slice(target.prefix.length);
    if (downstreamPath === '') downstreamPath = '/';
    if (!downstreamPath.startsWith('/') && !downstreamPath.startsWith('?')) {
      downstreamPath = '/' + downstreamPath;
    }
  }

  // Repassa todos os headers, ajustando Host pro alvo.
  const headers = { ...req.headers, host: `${target.host}:${target.port}` };

  const proxyReq = http.request(
    { host: target.host, port: target.port, method: req.method, path: downstreamPath, headers },
    (proxyRes) => {
      const status = proxyRes.statusCode || 502;
      if (ACCESS_LOG_ENABLED || status >= 400) {
        const line = `${req.method} ${url} -> ${target.name} ` +
          `${target.host}:${target.port}${downstreamPath} <- ${status}`;
        if (status >= 500) console.error(line);
        else console.log(line);
      }
      res.writeHead(status, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('error', (err) => {
    console.error(`ERRO proxy ${target.name}${downstreamPath}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
    }
    res.end(JSON.stringify({ error: `falha ao contatar ${target.name}: ${err.message}` }));
  });

  req.pipe(proxyReq);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[gateway] escutando em http://127.0.0.1:${PORT}`);
  console.log(`[gateway] /auth/v1/* -> 127.0.0.1:9999  |  /rest/v1/* -> 127.0.0.1:54331  |  /storage/v1/* -> 127.0.0.1:${STORAGE_PORT}`);
});
