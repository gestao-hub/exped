/**
 * Importa a base de clientes exportada do Hiper (CSV) pra dentro do Exped,
 * mesclando CPF/CNPJ repetido num único cliente com vários endereços.
 *
 * Uso:
 *   npx tsx scripts/import-clientes.ts [--empresa <uuid>] [--dry-run] arquivo1.csv [arquivo2.csv ...]
 *
 * - Lê NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY de .env.local.
 * - empresa padrão = Franzoni (00000000-0000-0000-0000-0000000f0001).
 * - --dry-run: só parseia e mostra o relatório, não grava nada.
 *
 * Como roda com service_role (ignora RLS), o empresa_id é setado EXPLICITAMENTE
 * em cada insert (clientes.empresa_id e cliente_enderecos.empresa_id).
 */
import { createClient } from '@supabase/supabase-js';
import { config as loadEnv } from 'dotenv';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Database } from '../lib/types/database';
import {
  parseClientesCsv,
  mergeClientes,
  chaveCliente,
  type ImportCliente,
} from '../lib/clientes/import-csv';

loadEnv({ path: path.resolve(process.cwd(), '.env.local') });

const FRANZONI = '00000000-0000-0000-0000-0000000f0001';
const CHUNK = 500;

function parseArgs(argv: string[]) {
  let empresaId = FRANZONI;
  let dryRun = false;
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--empresa') empresaId = argv[++i];
    else files.push(a);
  }
  return { empresaId, dryRun, files };
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Lê o CSV detectando o encoding: exports do Hiper (ERP Windows) costumam vir em
 * windows-1252/latin1, não UTF-8. Tenta UTF-8 estrito; se falhar, decodifica como
 * windows-1252 (cobre acentos PT-BR). Sem essa detecção, acentos viram � irreversível.
 */
function lerCsv(p: string): string {
  const buf = readFileSync(path.resolve(p));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

async function main() {
  const { empresaId, dryRun, files } = parseArgs(process.argv.slice(2));
  if (files.length === 0) {
    console.error('Informe ao menos 1 arquivo CSV. Veja o cabeçalho do script pra uso.');
    process.exit(1);
  }

  // 1. Parse + merge entre arquivos
  const grupos: ImportCliente[][] = [];
  for (const f of files) {
    const texto = lerCsv(f);
    const r = parseClientesCsv(texto);
    console.log(
      `📄 ${f}: ${r.totalLinhas} linhas · ${r.clientes.length} clientes · ` +
        `${r.ignoradas} ignoradas · ${r.malformadas} malformadas · ${r.docsInvalidos} docs inválidos · ` +
        `${r.mesclados} mesclados · +${r.enderecosExtras} endereços extras`,
    );
    grupos.push(r.clientes);
  }
  const clientes = mergeClientes(grupos);
  const totalEnderecos = clientes.reduce((s, c) => s + c.enderecos.length, 0);
  const comMultiplos = clientes.filter((c) => c.enderecos.length > 1).length;
  console.log(
    `\n🧮 Após merge entre arquivos: ${clientes.length} clientes únicos · ` +
      `${totalEnderecos} endereços · ${comMultiplos} clientes com +1 endereço`,
  );

  if (dryRun) {
    const acentuados = clientes.filter((c) => [...c.nome].some((ch) => ch.charCodeAt(0) > 127)).slice(0, 5).map((c) => c.nome);
    console.log('\n🔤 Amostra de nomes com acento (confira se o encoding está certo, sem �):');
    acentuados.forEach((n) => console.log(`   ${n}`));
    console.log('\n--dry-run: nada gravado. Amostra dos 3 primeiros com múltiplos endereços:');
    clientes
      .filter((c) => c.enderecos.length > 1)
      .slice(0, 3)
      .forEach((c) => {
        console.log(`  • ${c.nome} (${c.cnpj_cpf ?? 's/doc'})`);
        c.enderecos.forEach((e) =>
          console.log(`      - [${e.rotulo}${e.is_padrao ? ' ★' : ''}] ${e.endereco ?? ''} · ${e.bairro ?? ''} · ${e.cep ?? ''}`),
        );
      });
    return;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Faltando NEXT_PUBLIC_SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY em .env.local');
  }
  const db = createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  console.log(`\n🎯 Alvo: ${new URL(url).host} (empresa ${empresaId})`);

  // 2. Clientes existentes da empresa (pra não duplicar por CNPJ/CPF)
  const existentesPorChave = new Map<string, string>(); // chave → id
  {
    let from = 0;
    for (;;) {
      const { data, error } = await db
        .from('clientes')
        .select('id, cnpj_cpf, codigo_erp, nome')
        .eq('empresa_id', empresaId)
        .range(from, from + 999);
      if (error) throw new Error(`Falha lendo clientes existentes: ${error.message}`);
      for (const c of data ?? []) {
        existentesPorChave.set(
          chaveCliente({ cnpj_cpf: c.cnpj_cpf, codigo_erp: c.codigo_erp, nome: c.nome }),
          c.id,
        );
      }
      if (!data || data.length < 1000) break;
      from += 1000;
    }
  }
  console.log(`\n👥 Já existem ${existentesPorChave.size} clientes na empresa.`);

  // 3. Insere os clientes que faltam
  const aInserir = clientes.filter((c) => !existentesPorChave.has(chaveCliente(c)));
  console.log(`➕ Inserindo ${aInserir.length} clientes novos...`);
  let inseridos = 0;
  for (const grupo of chunk(aInserir, CHUNK)) {
    const rows = grupo.map((c) => ({
      empresa_id: empresaId,
      cnpj_cpf: c.cnpj_cpf,
      codigo_erp: c.codigo_erp,
      nome: c.nome,
      endereco_padrao: c.endereco,
      bairro_padrao: c.bairro,
      cidade_padrao: c.cidade,
      uf_padrao: c.uf,
      cep_padrao: c.cep,
      telefone_padrao: c.telefone,
    }));
    const { error } = await db.from('clientes').insert(rows);
    if (error) {
      // fallback linha-a-linha pra pular conflitos pontuais (ex.: CNPJ já em outra empresa)
      for (const row of rows) {
        const { error: e1 } = await db.from('clientes').insert(row);
        if (e1) console.warn(`   ⚠️ ${row.nome} (${row.cnpj_cpf ?? 's/doc'}): ${e1.message}`);
        else inseridos++;
      }
    } else {
      inseridos += rows.length;
    }
    process.stdout.write(`   ${inseridos}/${aInserir.length}\r`);
  }
  console.log(`\n✅ ${inseridos} clientes inseridos.`);

  // 4. Re-resolve TODOS os ids (existentes + novos) por chave
  const idPorChave = new Map<string, string>();
  {
    let from = 0;
    for (;;) {
      const { data, error } = await db
        .from('clientes')
        .select('id, cnpj_cpf, codigo_erp, nome')
        .eq('empresa_id', empresaId)
        .range(from, from + 999);
      if (error) throw new Error(`Falha re-lendo clientes: ${error.message}`);
      for (const c of data ?? []) {
        idPorChave.set(
          chaveCliente({ cnpj_cpf: c.cnpj_cpf, codigo_erp: c.codigo_erp, nome: c.nome }),
          c.id,
        );
      }
      if (!data || data.length < 1000) break;
      from += 1000;
    }
  }

  // 5. Endereços existentes (dedup + saber quem já tem padrão)
  const clienteIds = clientes
    .map((c) => idPorChave.get(chaveCliente(c)))
    .filter((x): x is string => !!x);
  const sigExistente = new Set<string>(); // `${cliente_id}|${endereco}|${cep}|${bairro}`
  const temPadrao = new Set<string>(); // cliente_id que já tem is_padrao
  for (const grupo of chunk(clienteIds, 300)) {
    const { data, error } = await db
      .from('cliente_enderecos')
      .select('cliente_id, endereco, cep, bairro, is_padrao')
      .in('cliente_id', grupo);
    if (error) throw new Error(`Falha lendo endereços existentes: ${error.message}`);
    for (const e of data ?? []) {
      sigExistente.add(
        `${e.cliente_id}|${(e.endereco ?? '').toLowerCase()}|${e.cep ?? ''}|${(e.bairro ?? '').toLowerCase()}`,
      );
      if (e.is_padrao) temPadrao.add(e.cliente_id);
    }
  }

  // 6. Monta e insere endereços que faltam
  const enderecoRows: Database['public']['Tables']['cliente_enderecos']['Insert'][] = [];
  for (const c of clientes) {
    const cid = idPorChave.get(chaveCliente(c));
    if (!cid) continue;
    let clienteJaTemPadrao = temPadrao.has(cid);
    for (const e of c.enderecos) {
      const sig = `${cid}|${(e.endereco ?? '').toLowerCase()}|${e.cep ?? ''}|${(e.bairro ?? '').toLowerCase()}`;
      if (sigExistente.has(sig)) continue;
      sigExistente.add(sig);
      // Só 1 padrão por cliente (unique parcial no banco).
      const padrao = e.is_padrao && !clienteJaTemPadrao;
      if (padrao) clienteJaTemPadrao = true;
      enderecoRows.push({
        cliente_id: cid,
        empresa_id: empresaId,
        rotulo: e.rotulo,
        endereco: e.endereco,
        bairro: e.bairro,
        cidade: e.cidade,
        uf: e.uf,
        cep: e.cep,
        telefone: e.telefone,
        is_padrao: padrao,
      });
    }
  }
  console.log(`\n📍 Inserindo ${enderecoRows.length} endereços...`);
  let endIns = 0;
  for (const grupo of chunk(enderecoRows, CHUNK)) {
    const { error } = await db.from('cliente_enderecos').insert(grupo);
    if (error) {
      for (const row of grupo) {
        const { error: e1 } = await db.from('cliente_enderecos').insert(row);
        if (e1) console.warn(`   ⚠️ endereço de ${row.cliente_id}: ${e1.message}`);
        else endIns++;
      }
    } else {
      endIns += grupo.length;
    }
    process.stdout.write(`   ${endIns}/${enderecoRows.length}\r`);
  }
  console.log(`\n✅ ${endIns} endereços inseridos.`);
  console.log('\n🎉 Importação concluída.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
