import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const dbUrl = process.env.SYNC_TEST_DB_URL;
const describeWithDb = dbUrl ? describe : describe.skip;

function startPsql(sql) {
  const child = spawn('psql', [dbUrl, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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
  return { child, done, output: () => stdout };
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

describeWithDb('resolve_cliente_ingest com conexoes concorrentes', () => {
  it('serializa a mesma chave ERP e cria um unico cliente', async () => {
    const empresaId = '93000000-0000-0000-0000-000000000001';
    await runPsql(`
      insert into public.empresas (id, nome, slug)
      values ('${empresaId}', 'Ingest concorrente', 'ingest-concorrente');
    `);

    try {
      const first = startPsql(`
        begin;
        select public.resolve_cliente_ingest(
          '${empresaId}',
          '{"nome":"Cliente concorrente","codigo_erp":"1000373"}'::jsonb
        );
        select 'CLIENTE_RESOLVIDO';
        select pg_sleep(0.75);
        commit;
      `);
      await waitForOutput(first, 'CLIENTE_RESOLVIDO');

      const second = startPsql(`
        select public.resolve_cliente_ingest(
          '${empresaId}',
          '{"nome":"Cliente concorrente","codigo_erp":"1000373"}'::jsonb
        );
      `);

      await Promise.all([first.done, second.done]);
      const count = Number(await runPsql(`
        select count(*)
        from public.clientes
        where empresa_id = '${empresaId}'
          and codigo_erp = '1000373'
          and deleted_at is null;
      `));
      expect(count).toBe(1);
    } finally {
      await runPsql(`
        delete from public.clientes where empresa_id = '${empresaId}';
        delete from public.empresas where id = '${empresaId}';
      `);
    }
  }, 15_000);

  it('revalida o status do pedido depois de esperar por uma edicao concorrente', async () => {
    const empresaId = '93000000-0000-0000-0000-000000000101';
    const pedidoId = '93000000-0000-0000-0000-000000000102';
    await runPsql(`
      insert into public.empresas (id, nome, slug)
      values ('${empresaId}', 'Pedido concorrente', 'pedido-concorrente');
      insert into public.pedidos (
        id, numero_mapa, documento_erp, empresa_id, cliente_nome, status, valor_total
      ) values (
        '${pedidoId}', 930102, 'CONCORRENTE-930102', '${empresaId}', 'Original', 'rascunho', 10
      );
      insert into public.pedido_pontos_retirada (pedido_id, tipo, empresa_nome, ordem)
      values ('${pedidoId}', 'loja', 'Original', 0);
    `);

    try {
      const editor = startPsql(`
        begin;
        update public.pedidos set status = 'finalizado' where id = '${pedidoId}';
        select 'PEDIDO_PROTEGIDO';
        select pg_sleep(0.75);
        commit;
      `);
      await waitForOutput(editor, 'PEDIDO_PROTEGIDO');

      const ingest = startPsql(`
        select public.resync_pedido_ingest(
          '${pedidoId}',
          '${empresaId}',
          '{"cliente_nome":"Sobrescrito","valor_total":999}'::jsonb,
          '{"nome":"Orfao","codigo_erp":"ORFAO-CONCORRENTE"}'::jsonb,
          '[]'::jsonb
        ) ->> 'reason';
      `);

      const [, reason] = await Promise.all([editor.done, ingest.done]);
      expect(reason).toBe('protected');

      const state = await runPsql(`
        select concat_ws('|', status, cliente_nome, valor_total)
        from public.pedidos
        where id = '${pedidoId}';
      `);
      expect(state).toBe('finalizado|Original|10.00');

      const orphanCount = Number(await runPsql(`
        select count(*)
        from public.clientes
        where empresa_id = '${empresaId}'
          and codigo_erp = 'ORFAO-CONCORRENTE';
      `));
      expect(orphanCount).toBe(0);
    } finally {
      await runPsql(`
        delete from public.pedidos where id = '${pedidoId}';
        delete from public.clientes where empresa_id = '${empresaId}';
        delete from public.empresas where id = '${empresaId}';
      `);
    }
  }, 15_000);

  it('serializa a criacao completa do mesmo pedido e preserva um unico conjunto de filhos', async () => {
    const empresaId = '93000000-0000-0000-0000-000000000201';
    const header = JSON.stringify({
      documento_erp: 'CONCORRENTE-930201',
      cliente_codigo: 'CLI-930201',
      cliente_nome: 'Pedido atomico concorrente',
      valor_total: 80,
      ingest_snapshot_hash: 'a'.repeat(64),
    }).replaceAll("'", "''");
    const cliente = JSON.stringify({
      codigo_erp: 'CLI-930201',
      nome: 'Pedido atomico concorrente',
    }).replaceAll("'", "''");
    const pontos = JSON.stringify([{
      tipo: 'loja',
      empresa_nome: 'Loja',
      itens: [{
        codigo: 'CONCURRENT',
        descricao: 'Item concorrente',
        quantidade: 1,
        unidade: 'UN',
        preco_unitario: 80,
        desconto: 0,
        total: 80,
        modalidade: 'loja',
      }],
    }]).replaceAll("'", "''");

    await runPsql(`
      insert into public.empresas (id, nome, slug)
      values ('${empresaId}', 'Criacao atomica concorrente', 'criacao-atomica-concorrente');
    `);

    try {
      const first = startPsql(`
        begin;
        select public.create_pedido_ingest(
          '${empresaId}', '${header}'::jsonb, '${cliente}'::jsonb, '${pontos}'::jsonb
        ) ->> 'created';
        select 'PEDIDO_ATOMICO_CRIADO';
        select pg_sleep(0.75);
        commit;
      `);
      await waitForOutput(first, 'PEDIDO_ATOMICO_CRIADO');

      const second = startPsql(`
        select public.create_pedido_ingest(
          '${empresaId}', '${header}'::jsonb, '${cliente}'::jsonb, '${pontos}'::jsonb
        ) ->> 'created';
      `);

      const [firstOutput, secondOutput] = await Promise.all([first.done, second.done]);
      expect(firstOutput.split('\n')[0]).toBe('true');
      expect(secondOutput).toBe('false');

      const state = await runPsql(`
        select concat_ws('|',
          (select count(*) from public.pedidos where empresa_id = '${empresaId}' and documento_erp = 'CONCORRENTE-930201'),
          (
            select count(*)
            from public.pedido_pontos_retirada ponto
            join public.pedidos pedido on pedido.id = ponto.pedido_id
            where pedido.empresa_id = '${empresaId}' and pedido.documento_erp = 'CONCORRENTE-930201'
          ),
          (
            select count(*)
            from public.pedido_itens item
            join public.pedido_pontos_retirada ponto on ponto.id = item.ponto_retirada_id
            join public.pedidos pedido on pedido.id = ponto.pedido_id
            where pedido.empresa_id = '${empresaId}' and pedido.documento_erp = 'CONCORRENTE-930201'
          )
        );
      `);
      expect(state).toBe('1|1|1');
    } finally {
      await runPsql(`
        delete from public.pedido_itens
        where ponto_retirada_id in (
          select ponto.id
          from public.pedido_pontos_retirada ponto
          join public.pedidos pedido on pedido.id = ponto.pedido_id
          where pedido.empresa_id = '${empresaId}'
        );
        delete from public.pedido_pontos_retirada
        where pedido_id in (select id from public.pedidos where empresa_id = '${empresaId}');
        delete from public.pedidos where empresa_id = '${empresaId}';
        delete from public.clientes where empresa_id = '${empresaId}';
        delete from public.empresas where id = '${empresaId}';
      `);
    }
  }, 15_000);
});
