-- 20260601000001_sync_stamps.sql — carimbos p/ sync (updated_at + field_updated_at + deleted_at)
--
-- INVENTÁRIO (local 54329 == nuvem louaguxcohfeicxxqggw, idênticos em 2026-06-01):
--   updated_at JÁ EXISTE em: clientes, ordens_servico, pedidos  (add column = no-op nessas)
--   field_updated_at / deleted_at: NÃO existem em nenhuma das 8.
--   triggers updated_at JÁ existentes (BEFORE UPDATE): set_clientes_updated_at,
--     set_ordens_servico_updated_at, set_pedidos_updated_at.
--   Mantidos: ambos setam updated_at=now() no MESMO statement → mesmo valor, sem conflito.
--   Ordem BEFORE é alfabética; set_* roda antes de trg_stamp_sync, ok.
--
-- Trigger genérico: em INSERT/UPDATE marca updated_at=now() e field_updated_at[col]=now()
-- só p/ colunas que mudaram (compara to_jsonb(new) vs to_jsonb(old)). Migração ADITIVA e idempotente.

create or replace function public.stamp_sync_fields() returns trigger language plpgsql as $$
declare
  k text;
  jn jsonb := to_jsonb(new);
  jo jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  m  jsonb := case when tg_op = 'UPDATE' then coalesce(old.field_updated_at, '{}'::jsonb) else '{}'::jsonb end;
begin
  new.updated_at := now();
  for k in select jsonb_object_keys(jn) loop
    if k not in ('field_updated_at', 'updated_at') then
      if tg_op = 'INSERT' or (jn -> k) is distinct from (jo -> k) then
        m := m || jsonb_build_object(k, to_jsonb(now()));
      end if;
    end if;
  end loop;
  new.field_updated_at := m;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['pedidos','pedido_pontos_retirada','pedido_itens',
    'ordens_servico','os_itens','os_servicos','clientes','os_notificacoes'] loop
    execute format('alter table public.%I add column if not exists updated_at timestamptz not null default now()', t);
    execute format('alter table public.%I add column if not exists field_updated_at jsonb not null default ''{}''::jsonb', t);
    execute format('alter table public.%I add column if not exists deleted_at timestamptz', t);
    execute format('drop trigger if exists trg_stamp_sync on public.%I', t);
    execute format('create trigger trg_stamp_sync before insert or update on public.%I for each row execute function public.stamp_sync_fields()', t);
  end loop;
end $$;
