// Storage local do Hub Exped (Windows/offline) — substituto do Supabase Storage.
//
// AUDITORIA (passo 1 — YAGNI): o app usa SOMENTE upload de PDF no bucket
// `pedidos-pdfs`. Linhas relevantes (git grep, fora de node_modules):
//
//   app/api/ingest/os/route.ts:59
//     supabase.storage.from('pedidos-pdfs').upload(path, buffer, { contentType: 'application/pdf', upsert: false })
//   app/api/ingest/pedido/route.ts:111-114
//     .upload(path, buffer, { contentType: 'application/pdf', upsert: false })
//   app/api/parse-pdf/route.ts:63-66
//     .upload(storagePath, buffer, { contentType: 'application/pdf', ... })
//
// NÃO há uso de createSignedUrl / getPublicUrl / .download() no código do app.
// O path retornado (`storage_pdf_path`) é gravado no banco; a equipe abre/baixa
// o PDF via GET no mesmo path. Por isso implementamos só:
//   - POST/PUT /storage/v1/object/<bucket>/<path>  -> grava em root/<bucket>/<path>
//   - GET      /storage/v1/object/<bucket>/<path>  -> serve como application/pdf (404 se ausente)
//
// Protegido contra path traversal (normalize + remoção de `..`). Node puro, sem deps.

import http from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';

function safeRel(raw) {
  // decodifica %2F etc., normaliza separadores e remove segmentos `..` / absolutos.
  let p = decodeURIComponent(raw).replace(/\\/g, '/');
  p = normalize(p).replace(/^([/\\])+/, '');
  // remove qualquer segmento `..` remanescente
  const parts = p.split(/[/\\]/).filter((s) => s && s !== '.' && s !== '..');
  return parts.join(sep);
}

export async function startStorage({ port = 5402, root }) {
  const server = http.createServer(async (req, res) => {
    const url = req.url || '/';
    // aceita /storage/v1/object/<bucket>/<path>, com prefixo opcional sign/ ou public/.
    const m = url.match(/^\/storage\/v1\/object\/(?:sign\/|public\/)?([^?]+)/);
    if (!m) {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ error: 'rota de storage desconhecida' }));
    }
    const rel = safeRel(m[1]);
    const abs = join(root, rel);
    try {
      if (req.method === 'POST' || req.method === 'PUT') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, Buffer.concat(chunks));
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ Key: rel }));
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const data = await readFile(abs);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', String(data.length));
        return res.end(req.method === 'HEAD' ? undefined : data);
      }
      res.statusCode = 405;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ error: 'método não suportado' }));
    } catch {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ error: 'objeto não encontrado' }));
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { port: server.address().port, close: () => server.close() };
}
