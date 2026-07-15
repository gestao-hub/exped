import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const dbUrl = process.env.SYNC_TEST_DB_URL;
const describeWithDb = dbUrl ? describe : describe.skip;
let makePsqlDb = null;
let localDbConfig = null;

if (dbUrl) {
  const parsed = new URL(dbUrl);
  process.env.PGPASSWORD = decodeURIComponent(parsed.password);
  ({ makePsqlDb } = await import('../../hub/sync.mjs'));
  localDbConfig = {
    ports: { pg: Number(parsed.port || 5432) },
    paths: {
      pgHost: parsed.hostname,
      user: decodeURIComponent(parsed.username),
      db: decodeURIComponent(parsed.pathname.slice(1)),
    },
  };
}

function startPsql(sql) {
  const child = spawn('psql', [
    dbUrl,
    '-X',
    '-qAt',
    '-v',
    'ON_ERROR_STOP=1',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(sql);

  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`psql terminou com ${code}: ${stderr.trim()}`));
    });
  });

  return {
    child,
    done,
    output: () => stdout,
  };
}

async function runPsql(sql) {
  return startPsql(sql).done;
}

async function waitForOutput(process, marker, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (!process.output().includes(marker)) {
    if (Date.now() - startedAt > timeoutMs) {
      process.child.kill();
      throw new Error(`psql nao publicou marcador ${marker}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describeWithDb('sync_merge_upsert com conexoes PostgreSQL concorrentes', () => {
  it('serializa a mesma PK e preserva campos editados por dois hubs', async () => {
    const empresaId = '92000000-0000-0000-0000-000000000001';
    const clienteId = '92000000-0000-0000-0000-000000000011';

    await runPsql(`
      begin;
      set local exped.sync = 'on';
      delete from public.clientes where id = '${clienteId}';
      delete from public.empresas where id = '${empresaId}';
      insert into public.empresas (id, nome, slug)
      values ('${empresaId}', 'Sync concorrente', 'sync-concorrente');
      insert into public.clientes (
        id, empresa_id, nome, endereco_padrao, telefone_padrao,
        updated_at, field_updated_at
      ) values (
        '${clienteId}', '${empresaId}', 'Cliente concorrente', 'Rua antiga', '1111',
        '2026-07-14T10:00:00Z',
        '{"endereco_padrao":"2026-07-14T10:00:00Z","telefone_padrao":"2026-07-14T10:00:00Z"}'::jsonb
      );
      commit;
    `);

    try {
      const first = startPsql(`
        begin;
        select public.sync_merge_upsert(
          'clientes', '${empresaId}',
          '{
            "id":"${clienteId}",
            "endereco_padrao":"Rua do hub A",
            "field_updated_at":{"endereco_padrao":"2026-07-14T11:00:00Z"}
          }'::jsonb
        );
        select 'MERGED';
        select pg_sleep(0.75);
        commit;
      `);
      await waitForOutput(first, 'MERGED');

      const second = startPsql(`
        select public.sync_merge_upsert(
          'clientes', '${empresaId}',
          '{
            "id":"${clienteId}",
            "telefone_padrao":"2222",
            "field_updated_at":{"telefone_padrao":"2026-07-14T12:00:00Z"}
          }'::jsonb
        );
      `);

      await Promise.all([first.done, second.done]);

      const canonical = JSON.parse(await runPsql(`
        select json_build_object(
          'endereco', endereco_padrao,
          'telefone', telefone_padrao
        )::text
        from public.clientes
        where id = '${clienteId}';
      `));
      expect(canonical).toEqual({
        endereco: 'Rua do hub A',
        telefone: '2222',
      });
    } finally {
      await runPsql(`
        delete from public.clientes where id = '${clienteId}';
        delete from public.empresas where id = '${empresaId}';
      `);
    }
  }, 15_000);

  it('mantem a empresa da referencia travada ate o commit do pedido', async () => {
    const empresaA = '92000000-0000-0000-0000-000000000021';
    const empresaB = '92000000-0000-0000-0000-000000000022';
    const clienteId = '92000000-0000-0000-0000-000000000023';
    const pedidoId = '92000000-0000-0000-0000-000000000024';

    await runPsql(`
      begin;
      set local exped.sync = 'on';
      insert into public.empresas (id, nome, slug) values
        ('${empresaA}', 'Referencia A', 'sync-referencia-a'),
        ('${empresaB}', 'Referencia B', 'sync-referencia-b');
      insert into public.clientes (id, empresa_id, nome)
      values ('${clienteId}', '${empresaA}', 'Cliente referenciado');
      insert into public.pedidos (id, empresa_id, cliente_id, cliente_nome)
      values ('${pedidoId}', '${empresaA}', '${clienteId}', 'Cliente referenciado');
      commit;
    `);

    try {
      const merge = startPsql(`
        begin;
        select public.sync_merge_upsert(
          'pedidos', '${empresaA}',
          '{
            "id":"${pedidoId}",
            "cliente_id":"${clienteId}",
            "status":"em_separacao",
            "field_updated_at":{
              "cliente_id":"2026-07-14T12:00:00Z",
              "status":"2026-07-14T12:00:00Z"
            }
          }'::jsonb
        );
        select 'REFERENCE_LOCKED';
        select pg_sleep(0.75);
        commit;
      `);
      await waitForOutput(merge, 'REFERENCE_LOCKED');

      const startedAt = Date.now();
      const move = startPsql(`
        update public.clientes
        set empresa_id = '${empresaB}'
        where id = '${clienteId}';
      `);

      await Promise.all([merge.done, move.done]);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(500);
    } finally {
      await runPsql(`
        delete from public.pedidos where id = '${pedidoId}';
        delete from public.clientes where id = '${clienteId}';
        delete from public.empresas where id in ('${empresaA}', '${empresaB}');
      `);
    }
  }, 15_000);

  it('aplica a PK canonica localmente sem republicar o alias de CNPJ', async () => {
    const empresaId = '92000000-0000-0000-0000-000000000031';
    const aliasId = '92000000-0000-0000-0000-000000000032';
    const canonicalId = '92000000-0000-0000-0000-000000000033';
    const pedidoId = '92000000-0000-0000-0000-000000000034';
    const osId = '92000000-0000-0000-0000-000000000035';
    const enderecoId = '92000000-0000-0000-0000-000000000036';
    const sourceUpdatedAt = '2026-07-14T12:00:00.000Z';
    const db = makePsqlDb(localDbConfig);

    await runPsql(`
      begin;
      set local exped.sync = 'on';
      insert into public.empresas (id, nome, slug)
      values ('${empresaId}', 'Alias local', 'sync-alias-local');
      insert into public.clientes (
        id, empresa_id, nome, cnpj_cpf, updated_at, field_updated_at
      ) values (
        '${aliasId}', '${empresaId}', 'Cliente alias', '12.345.678/0001-90',
        '${sourceUpdatedAt}',
        '{"nome":"${sourceUpdatedAt}","cnpj_cpf":"${sourceUpdatedAt}"}'::jsonb
      );
      insert into public.pedidos (id, empresa_id, cliente_id, cliente_nome)
      values ('${pedidoId}', '${empresaId}', '${aliasId}', 'Cliente alias');
      insert into public.ordens_servico (id, empresa_id, cliente_id, cliente_nome)
      values ('${osId}', '${empresaId}', '${aliasId}', 'Cliente alias');
      insert into public.cliente_enderecos (
        id, empresa_id, cliente_id, rotulo, is_padrao
      ) values ('${enderecoId}', '${empresaId}', '${aliasId}', 'Principal', true);
      commit;
    `);

    try {
      await db.ensureCursorTable();
      await db.applyCanonicalPage(
        'clientes',
        'id',
        [{
          id: canonicalId,
          empresa_id: empresaId,
          nome: 'Cliente canonico',
          cnpj_cpf: '12345678000190',
          updated_at: '2026-07-14T12:01:00.000Z',
          field_updated_at: {
            nome: '2026-07-14T12:01:00.000Z',
            cnpj_cpf: '2026-07-14T12:01:00.000Z',
          },
          deleted_at: null,
        }],
        { push_at: sourceUpdatedAt, push_pk: aliasId },
        [{
          oldId: aliasId,
          canonicalId,
          empresaId,
          sourceUpdatedAt,
        }],
      );

      const result = JSON.parse(await runPsql(`
        select json_build_object(
          'alias_deleted', (select deleted_at is not null from public.clientes where id = '${aliasId}'),
          'canonical_active', (select deleted_at is null from public.clientes where id = '${canonicalId}'),
          'pedido_cliente', (select cliente_id from public.pedidos where id = '${pedidoId}'),
          'os_cliente', (select cliente_id from public.ordens_servico where id = '${osId}'),
          'endereco_cliente', (select cliente_id from public.cliente_enderecos where id = '${enderecoId}'),
          'alias_pending', exists(
            select 1 from public.clientes, public._sync_cursors cursor
            where clientes.id = '${aliasId}' and cursor.table_name = 'clientes'
              and (clientes.updated_at, clientes.id::text) > (cursor.push_at, cursor.push_pk)
          )
        )::text;
      `));

      expect(result).toEqual({
        alias_deleted: true,
        canonical_active: true,
        pedido_cliente: canonicalId,
        os_cliente: canonicalId,
        endereco_cliente: canonicalId,
        alias_pending: false,
      });
    } finally {
      await runPsql(`
        delete from public.cliente_enderecos where id = '${enderecoId}';
        delete from public.pedidos where id = '${pedidoId}';
        delete from public.ordens_servico where id = '${osId}';
        delete from public.clientes where id in ('${aliasId}', '${canonicalId}');
        delete from public._sync_cursors where table_name = 'clientes';
        delete from public.empresas where id = '${empresaId}';
      `);
    }
  }, 15_000);
});
