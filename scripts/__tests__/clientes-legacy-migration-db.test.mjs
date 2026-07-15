import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dbUrl = process.env.SYNC_TEST_DB_URL;
const describeWithDb = dbUrl ? describe : describe.skip;
const migrationPath = fileURLToPath(new URL(
  '../../supabase/migrations/20260714215521_clientes_tombstone_hardening.sql',
  import.meta.url,
));

function startPsql(args, sql) {
  const child = spawn('psql', [dbUrl, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(sql ?? '');

  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`psql terminou com ${code}: ${stderr.trim()}`));
    });
  });
}

async function runPsql(sql) {
  return startPsql([], sql);
}

async function runMigration() {
  return startPsql(['-f', migrationPath]);
}

const uniqueIndexSql = `
  create unique index clientes_cnpj_cpf_uniq
    on public.clientes (
      empresa_id,
      (pg_catalog.regexp_replace(cnpj_cpf, '\\D', '', 'g'))
    )
    where cnpj_cpf is not null
      and pg_catalog.regexp_replace(cnpj_cpf, '\\D', '', 'g') <> ''
      and deleted_at is null;
`;

describeWithDb('reconciliacao executavel de clientes legados', () => {
  it('reponta o pedido, preserva o codigo ERP e arquiva o alias', async () => {
    const empresaId = '96000000-0000-0000-0000-000000000001';
    const targetId = '96000000-0000-0000-0000-000000000002';
    const sourceId = '96000000-0000-0000-0000-000000000003';
    const pedidoId = '96000000-0000-0000-0000-000000000004';

    await runPsql(`
      drop index public.clientes_cnpj_cpf_uniq;
      insert into public.empresas (id, nome, slug)
      values ('${empresaId}', 'Legado reconciliado', 'legado-reconciliado');
      insert into public.clientes (id, empresa_id, nome, cnpj_cpf, codigo_erp, created_at)
      values
        ('${targetId}', '${empresaId}', 'Canonico', '11.111.111/0001-11', null, '2026-01-01T00:00:00Z'),
        ('${sourceId}', '${empresaId}', 'Alias', '11111111000111', 'LEGACY-1', '2026-01-02T00:00:00Z');
      insert into public.pedidos (
        id, numero_mapa, documento_erp, empresa_id, cliente_id, cliente_nome, valor_total
      ) values (
        '${pedidoId}', 960004, 'LEGACY-960004', '${empresaId}', '${sourceId}', 'Alias', 10
      );
    `);

    try {
      await runMigration();
      const state = await runPsql(`
        select concat_ws(
          '|',
          target.codigo_erp,
          (source.deleted_at is not null)::text,
          pedido.cliente_id::text
        )
        from public.clientes target
        join public.clientes source on source.id = '${sourceId}'
        join public.pedidos pedido on pedido.id = '${pedidoId}'
        where target.id = '${targetId}';
      `);
      expect(state).toBe(`LEGACY-1|true|${targetId}`);
    } finally {
      await runPsql(`
        delete from public.pedidos where id = '${pedidoId}';
        delete from public.clientes where empresa_id = '${empresaId}';
        delete from public.empresas where id = '${empresaId}';
      `);
    }
  }, 20_000);

  it('aborta sem arquivar quando o mesmo documento possui codigos divergentes', async () => {
    const empresaId = '96000000-0000-0000-0000-000000000011';
    const targetId = '96000000-0000-0000-0000-000000000012';
    const sourceId = '96000000-0000-0000-0000-000000000013';

    await runPsql(`
      drop index public.clientes_cnpj_cpf_uniq;
      insert into public.empresas (id, nome, slug)
      values ('${empresaId}', 'Legado conflitante', 'legado-conflitante');
      insert into public.clientes (id, empresa_id, nome, cnpj_cpf, codigo_erp, created_at)
      values
        ('${targetId}', '${empresaId}', 'Canonico A', '22.222.222/0001-22', 'LEGACY-A', '2026-01-01T00:00:00Z'),
        ('${sourceId}', '${empresaId}', 'Alias B', '22222222000122', 'LEGACY-B', '2026-01-02T00:00:00Z');
    `);

    try {
      await expect(runMigration()).rejects.toThrow(
        'Documento duplicado possui codigos ERP divergentes',
      );
      const state = await runPsql(`
        select string_agg(concat_ws('|', codigo_erp, (deleted_at is null)::text), ',' order by codigo_erp)
        from public.clientes
        where empresa_id = '${empresaId}';
      `);
      expect(state).toBe('LEGACY-A|true,LEGACY-B|true');
    } finally {
      await runPsql(`
        delete from public.clientes where empresa_id = '${empresaId}';
        delete from public.empresas where id = '${empresaId}';
        drop index if exists public.clientes_cnpj_cpf_uniq;
        ${uniqueIndexSql}
      `);
    }
  }, 20_000);
});
