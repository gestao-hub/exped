import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationsDir = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));

describe('migrations de clientes do ingest', () => {
  it('reconcilia duplicatas legadas antes de criar o indice normalizado', () => {
    const source = readFileSync(
      new URL('../../supabase/migrations/20260714215521_clientes_tombstone_hardening.sql', import.meta.url),
      'utf8',
    );
    const reconciliation = source.indexOf('clientes_documento_reconciliation');
    const uniqueIndex = source.indexOf('create unique index clientes_cnpj_cpf_uniq');

    expect(reconciliation).toBeGreaterThanOrEqual(0);
    expect(reconciliation).toBeLessThan(uniqueIndex);
    expect(source).toMatch(/update public\.pedidos[\s\S]*cliente_id/);
    expect(source).toMatch(/update public\.ordens_servico[\s\S]*cliente_id/);
    expect(source).toMatch(/clientes_documento_reconciliation_codes/);
    expect(source).toMatch(/count\(distinct candidates\.codigo_erp\) > 1/);
    expect(source).toMatch(/Documento duplicado possui codigos ERP divergentes/);
  });

  it('expoe uma RPC restrita para resolver ou criar cliente do ingest atomicamente', () => {
    const migrations = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => readFileSync(`${migrationsDir}/${name}`, 'utf8'))
      .join('\n');

    expect(migrations).toMatch(/create or replace function public\.resolve_cliente_ingest/);
    expect(migrations).toMatch(/pg_advisory_xact_lock/);
    expect(migrations).toMatch(/v_documento is null and v_codigo is null/);
    expect(migrations).toMatch(/v_documento_id is not null and v_codigo_id is not null/);
    expect(migrations).toMatch(/coalesce\(nullif\(pg_catalog\.btrim\(cliente\.codigo_erp\)/);
    expect(migrations).toMatch(/revoke all on function public\.resolve_cliente_ingest/);
    expect(migrations).toMatch(/grant execute on function public\.resolve_cliente_ingest[\s\S]*to service_role/);
    expect(migrations).toMatch(/begin;[\s\S]*create or replace function public\.resolve_cliente_ingest[\s\S]*commit;/);
  });

  it('faz o re-sync do pedido e de seus filhos dentro de uma unica transacao restrita', () => {
    const migrations = readdirSync(migrationsDir)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => readFileSync(`${migrationsDir}/${name}`, 'utf8'))
      .join('\n');

    expect(migrations).toMatch(/create or replace function public\.resync_pedido_ingest/);
    expect(migrations).toMatch(/from public\.pedidos pedido[\s\S]*for update/);
    expect(migrations).toMatch(/update public\.pedido_itens[\s\S]*deleted_at/);
    expect(migrations).toMatch(/update public\.pedido_pontos_retirada[\s\S]*deleted_at/);
    expect(migrations).toMatch(/revoke all on function public\.resync_pedido_ingest/);
    expect(migrations).toMatch(/grant execute on function public\.resync_pedido_ingest[\s\S]*to service_role/);
  });
});
