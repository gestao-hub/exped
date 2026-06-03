// Empacota o app Next standalone + migrations num <versao>.zip e publica no bucket
// público `hub-releases` do Supabase Storage, com manifest.json {versao,url,sha256}.
//
// Uso (CI ou local):
//   SR=<service_role> PROJECT_REF=louaguxcohfeicxxqggw node scripts/release-hub.mjs [versao]
// Sem `versao`, usa a do package.json. Pré-requisito: `npm run build` já rodado.

import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function buildManifest(versao, url, sha256) {
  return { versao, url, sha256 };
}
export function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}
export function versaoValida(v) {
  return typeof v === 'string' && /^[0-9]+(\.[0-9]+){0,2}$/.test(v);
}

/** Monta releases/<versao>/ com o app standalone + static + public + migrations. */
function montarRelease(versao) {
  const out = path.join(ROOT, 'releases', versao);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(path.join(ROOT, '.next', 'standalone'), out, { recursive: true });
  mkdirSync(path.join(out, '.next'), { recursive: true });
  cpSync(path.join(ROOT, '.next', 'static'), path.join(out, '.next', 'static'), { recursive: true });
  if (existsSync(path.join(ROOT, 'public')))
    cpSync(path.join(ROOT, 'public'), path.join(out, 'public'), { recursive: true });
  cpSync(path.join(ROOT, 'supabase', 'migrations'), path.join(out, 'supabase', 'migrations'), { recursive: true });
  return out;
}

async function uploadStorage(ref, sr, objectPath, buf, contentType) {
  const url = `https://${ref}.supabase.co/storage/v1/object/hub-releases/${objectPath}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { apikey: sr, Authorization: `Bearer ${sr}`, 'Content-Type': contentType, 'x-upsert': 'true' },
    body: buf,
  });
  if (!res.ok) throw new Error(`upload ${objectPath} HTTP ${res.status}: ${await res.text()}`);
}

async function main() {
  const ref = process.env.PROJECT_REF;
  const sr = process.env.SR;
  if (!ref || !sr) throw new Error('defina PROJECT_REF e SR (service_role)');
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const versao = process.argv[2] || pkg.version;
  if (!versaoValida(versao)) throw new Error(`versão inválida: ${versao}`);

  const releaseDir = montarRelease(versao);
  const zipPath = path.join(ROOT, 'releases', `${versao}.zip`);
  rmSync(zipPath, { force: true });
  execFileSync('bash', ['-c', `cd "${releaseDir}" && zip -qr "${zipPath}" .`], { stdio: 'inherit' });

  const zipBuf = readFileSync(zipPath);
  const sha = sha256Buffer(zipBuf);
  const zipUrl = `https://${ref}.supabase.co/storage/v1/object/public/hub-releases/${versao}.zip`;
  const manifest = buildManifest(versao, zipUrl, sha);

  await uploadStorage(ref, sr, `${versao}.zip`, zipBuf, 'application/zip');
  await uploadStorage(ref, sr, 'manifest.json', Buffer.from(JSON.stringify(manifest)), 'application/json');

  console.log('Publicado:', JSON.stringify(manifest));
  console.log('manifestUrl:', `https://${ref}.supabase.co/storage/v1/object/public/hub-releases/manifest.json`);
}

// só roda main() quando executado direto (não no import dos testes)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
}
