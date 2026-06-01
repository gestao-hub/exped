-- 20260601000003_sync_guc_trigger.sql — trigger stamp_sync respeita flag de sessão GUC.
--
-- POR QUE GUC e não session_replication_role:
--   Desligar o trigger via `set local session_replication_role = replica` exige
--   privilégio de superusuário/replication — NÃO disponível no Supabase gerenciado.
--   Em vez disso, o RPC de sync seta um GUC custom (`set local exped.sync = 'on'`),
--   que NÃO exige superuser, e este trigger pula o recarimbo quando a flag está 'on'.
--   Assim a escrita do merge preserva field_updated_at/updated_at exatamente como
--   calculados, sem depender de session_replication_role.
--
-- Migração ADITIVA e idempotente (create or replace). NÃO recria os triggers nas
-- tabelas — basta substituir o corpo das funções (os triggers já apontam pra elas).
--
-- IMPORTANTE: clientes/pedidos/ordens_servico também têm o trigger pré-existente
-- `set_updated_at` (BEFORE UPDATE) que força updated_at=now() — independente do
-- stamp_sync. Como a abordagem GUC só curto-circuita stamp_sync (e NÃO desliga TODOS
-- os triggers como session_replication_role fazia), set_updated_at TAMBÉM precisa
-- respeitar a flag, senão clobbaria o updated_at calculado pelo merge.

-- set_updated_at: respeita a flag de sync (preserva o updated_at vindo da escrita).
create or replace function public.set_updated_at() returns trigger
  language plpgsql set search_path to 'public' as $$
begin
  if current_setting('exped.sync', true) = 'on' then
    return new;
  end if;
  new.updated_at = now();
  return new;
end $$;

create or replace function public.stamp_sync_fields() returns trigger language plpgsql as $$
declare
  k text;
  jn jsonb := to_jsonb(new);
  jo jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  m  jsonb := case when tg_op = 'UPDATE' then coalesce(old.field_updated_at, '{}'::jsonb) else '{}'::jsonb end;
begin
  -- Escrita de sync (RPC seta `set local exped.sync='on'`): respeita os valores que
  -- vierem na escrita (resultado do merge), sem recarimbar.
  if current_setting('exped.sync', true) = 'on' then
    return new;
  end if;

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
