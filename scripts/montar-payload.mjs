// Monta hub/win/payload/ a partir do repo já buildado (npm run build + dotnet publish + auth.exe).
// Uso: node scripts/montar-payload.mjs --auth <auth.exe> --auth-migrations <dir> [--version X.Y.Z]
// Reaproveitável local e no CI (Fase 1.3 do hub/win/README.md).

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAYLOAD = path.join(ROOT, 'hub', 'win', 'payload');

export const LOCAL_STACK_FILES = [
  '00-prelude-helpers.sql',
  '00-roles-ext.sql',
  'gateway.mjs',
  'postgrest.conf',
  'make-keys.sh',
  'gotrue.env',
];

/** Lista pura das cópias padrão (de→para, relativos a ROOT/PAYLOAD). Testável sem I/O. */
export function planoDeCopias() {
  return [
    { de: '.next/standalone', para: 'app', tipo: 'dir' },
    { de: '.next/static', para: 'app/.next/static', tipo: 'dir' },
    { de: 'public', para: 'app/public', tipo: 'dir-opcional' },
    { de: 'hub', para: 'hub', tipo: 'mjs' },
    { de: 'hub/watchdog.ps1', para: 'hub/watchdog.ps1', tipo: 'arquivo' },
    ...LOCAL_STACK_FILES.map((f) => ({ de: `scripts/local-stack/${f}`, para: `scripts/local-stack/${f}`, tipo: 'arquivo' })),
    { de: 'supabase/migrations', para: 'supabase/migrations', tipo: 'sql' },
  ];
}

function copiarPorExtensao(deDir, paraDir, ext) {
  mkdirSync(paraDir, { recursive: true });
  for (const f of readdirSync(deDir).filter((x) => x.endsWith(ext))) {
    cpSync(path.join(deDir, f), path.join(paraDir, f));
  }
}

function arg(nome) {
  const i = process.argv.indexOf(nome);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main() {
  const authExe = arg('--auth');
  const authMig = arg('--auth-migrations');
  const versao = arg('--version') || JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  if (!authExe || !authMig) throw new Error('use --auth <auth.exe> --auth-migrations <dir>');

  rmSync(PAYLOAD, { recursive: true, force: true });

  for (const c of planoDeCopias()) {
    const de = path.join(ROOT, c.de);
    const para = path.join(PAYLOAD, c.para);
    if (c.tipo === 'dir-opcional' && !existsSync(de)) continue;
    if (c.tipo === 'dir' || c.tipo === 'dir-opcional') {
      mkdirSync(path.dirname(para), { recursive: true });
      cpSync(de, para, { recursive: true });
    } else if (c.tipo === 'mjs') {
      copiarPorExtensao(de, para, '.mjs');
    } else if (c.tipo === 'sql') {
      copiarPorExtensao(de, para, '.sql');
    } else {
      mkdirSync(path.dirname(para), { recursive: true });
      cpSync(de, para);
    }
  }

  // auth.exe + migrations em DOIS lugares (o maestro lê de scripts/local-stack/bin).
  for (const base of ['bin', 'scripts/local-stack/bin']) {
    const dir = path.join(PAYLOAD, base);
    mkdirSync(dir, { recursive: true });
    cpSync(authExe, path.join(dir, 'auth.exe'));
    cpSync(authMig, path.join(dir, 'migrations'), { recursive: true });
  }

  // mkcert.exe (HTTPS na LAN) — opcional. O install-service.ps1 le de bin\mkcert.exe.
  // Ausente => hub sobe em HTTP (sem notificacao); presente => gera CA+cert e habilita HTTPS.
  const mkcertExe = arg('--mkcert');
  if (mkcertExe && existsSync(mkcertExe)) {
    const binDir = path.join(PAYLOAD, 'bin');
    mkdirSync(binDir, { recursive: true });
    cpSync(mkcertExe, path.join(binDir, 'mkcert.exe'));
  }

  // config.json de config.example.json, com a versao carimbada (base do auto-update).
  const cfg = JSON.parse(readFileSync(path.join(ROOT, 'hub', 'win', 'config.example.json'), 'utf8'));
  cfg.version = versao;
  writeFileSync(path.join(PAYLOAD, 'config.json'), JSON.stringify(cfg, null, 2));

  console.log(`payload montado em ${PAYLOAD} (versao ${versao})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
