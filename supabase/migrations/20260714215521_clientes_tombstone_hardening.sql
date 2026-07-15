-- Clientes removidos permanecem como referencia historica. A chave natural pode
-- ser reutilizada somente depois do tombstone, sem reativar o cadastro antigo.
begin;
set local exped.sync = 'on';

drop index if exists public.clientes_cnpj_cpf_uniq;

-- Instalacoes locais antigas aceitavam o mesmo documento com e sem mascara. O
-- indice normalizado abaixo nao pode ser criado enquanto ambas estiverem ativas.
-- Mantemos a linha mais antiga, repontamos todas as FKs e arquivamos os aliases.
create temporary table clientes_documento_reconciliation as
with ranked as (
  select
    cliente.id as source_id,
    first_value(cliente.id) over (
      partition by cliente.empresa_id,
        pg_catalog.regexp_replace(cliente.cnpj_cpf, '\D', '', 'g')
      order by cliente.created_at, cliente.id
    ) as target_id,
    row_number() over (
      partition by cliente.empresa_id,
        pg_catalog.regexp_replace(cliente.cnpj_cpf, '\D', '', 'g')
      order by cliente.created_at, cliente.id
    ) as position
  from public.clientes cliente
  where cliente.deleted_at is null
    and cliente.cnpj_cpf is not null
    and pg_catalog.regexp_replace(cliente.cnpj_cpf, '\D', '', 'g') <> ''
)
select source_id, target_id
from ranked
where position > 1;

create unique index clientes_documento_reconciliation_source_idx
  on clientes_documento_reconciliation(source_id);

update public.pedidos pedido
set cliente_id = reconciliation.target_id
from clientes_documento_reconciliation reconciliation
where pedido.cliente_id = reconciliation.source_id;

update public.ordens_servico ordem
set cliente_id = reconciliation.target_id
from clientes_documento_reconciliation reconciliation
where ordem.cliente_id = reconciliation.source_id;

-- Evita colisao do indice parcial de endereco padrao durante o repontamento.
update public.cliente_enderecos endereco
set is_padrao = false
from clientes_documento_reconciliation reconciliation
where endereco.cliente_id = reconciliation.source_id
  and endereco.is_padrao = true;

update public.cliente_enderecos endereco
set cliente_id = reconciliation.target_id
from clientes_documento_reconciliation reconciliation
where endereco.cliente_id = reconciliation.source_id;

with target_without_default as (
  select distinct reconciliation.target_id
  from clientes_documento_reconciliation reconciliation
  where not exists (
    select 1
    from public.cliente_enderecos endereco
    where endereco.cliente_id = reconciliation.target_id
      and endereco.is_padrao = true
  )
), chosen_default as (
  select
    target.target_id,
    (pg_catalog.array_agg(endereco.id order by endereco.id))[1] as endereco_id
  from target_without_default target
  join public.cliente_enderecos endereco
    on endereco.cliente_id = target.target_id
  group by target.target_id
)
update public.cliente_enderecos endereco
set is_padrao = true
from chosen_default chosen
where endereco.id = chosen.endereco_id;

update public.clientes cliente
set deleted_at = coalesce(cliente.deleted_at, pg_catalog.clock_timestamp())
from clientes_documento_reconciliation reconciliation
where cliente.id = reconciliation.source_id;

create unique index clientes_cnpj_cpf_uniq
  on public.clientes (
    empresa_id,
    (pg_catalog.regexp_replace(cnpj_cpf, '\D', '', 'g'))
  )
  where cnpj_cpf is not null
    and pg_catalog.regexp_replace(cnpj_cpf, '\D', '', 'g') <> ''
    and deleted_at is null;

-- O fluxo autenticado arquiva clientes por UPDATE. Sem policy de DELETE, uma
-- chamada direta ao Data API nao consegue acionar o ON DELETE SET NULL da FK.
drop policy if exists clientes_admin_delete on public.clientes;

create or replace function public.merge_clientes(
  p_source_id uuid,
  p_target_id uuid
)
returns bigint
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_empresa_id uuid;
  v_cliente_id uuid;
  v_clientes_bloqueados integer := 0;
  v_pedidos_movidos bigint := 0;
begin
  if p_source_id is null
     or p_target_id is null
     or p_source_id = p_target_id then
    raise exception using
      errcode = '22023',
      message = 'Origem e destino devem ser clientes diferentes';
  end if;

  if public.current_user_role() is distinct from 'admin'::public.user_role then
    raise exception using
      errcode = '42501',
      message = 'Apenas administradores podem mesclar clientes';
  end if;

  v_empresa_id := public.current_empresa_id();
  if v_empresa_id is null then
    raise exception using
      errcode = '42501',
      message = 'Clientes ativos nao encontrados na empresa atual';
  end if;

  -- A ordem fixa evita deadlock entre merges concorrentes com pares invertidos.
  for v_cliente_id in
    select cliente.id
    from public.clientes cliente
    where cliente.id in (p_source_id, p_target_id)
      and cliente.empresa_id = v_empresa_id
      and cliente.deleted_at is null
    order by cliente.id
    for update
  loop
    v_clientes_bloqueados :=
      v_clientes_bloqueados + (v_cliente_id is not null)::integer;
  end loop;

  if v_clientes_bloqueados <> 2 then
    raise exception using
      errcode = '42501',
      message = 'Clientes ativos nao encontrados na empresa atual';
  end if;

  update public.pedidos pedido
  set cliente_id = p_target_id
  where pedido.cliente_id = p_source_id
    and pedido.empresa_id = v_empresa_id
    and pedido.deleted_at is null;
  get diagnostics v_pedidos_movidos = row_count;

  update public.clientes cliente
  set deleted_at = pg_catalog.clock_timestamp()
  where cliente.id = p_source_id
    and cliente.empresa_id = v_empresa_id
    and cliente.deleted_at is null;

  if not found then
    raise exception using
      errcode = '40001',
      message = 'Cliente de origem mudou durante o merge';
  end if;

  return v_pedidos_movidos;
end;
$$;

revoke all on function public.merge_clientes(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.merge_clientes(uuid, uuid)
  to authenticated;

-- A assinatura legada segue disponivel durante o rollout do sync. Ela tambem
-- precisa ignorar tombstones; caso contrario, a RPC atomica acabaria delegando
-- para um reconciliador que devolve o cadastro removido.
create or replace function public.sync_push_upsert(p_table text, p_row jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_set  text;
  v_pk   text := 'id';
  v_has_empresa boolean;
  v_guard text := '';
  v_result jsonb;
  v_existing jsonb;
begin
  if p_table not in (
    'clientes','pedidos','pedido_pontos_retirada','pedido_itens',
    'ordens_servico','os_itens','os_servicos','os_notificacoes'
  ) then
    raise exception 'sync_push_upsert: tabela não permitida %', p_table;
  end if;

  if p_table = 'clientes' and nullif(p_row->>'cnpj_cpf','') is not null then
    select to_jsonb(c.*) into v_existing
    from public.clientes c
    where c.empresa_id = (p_row->>'empresa_id')::uuid
      and c.deleted_at is null
      and regexp_replace(coalesce(c.cnpj_cpf,''), '\D', '', 'g')
          = regexp_replace(p_row->>'cnpj_cpf', '\D', '', 'g')
      and c.id <> (p_row->>'id')::uuid
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  set local exped.sync = 'on';

  select string_agg(format('%I = excluded.%I', c.column_name, c.column_name), ', ')
    into v_set
  from information_schema.columns c
  where c.table_schema = 'public'
    and c.table_name = p_table
    and c.column_name <> v_pk
    and c.column_name in (select jsonb_object_keys(p_row));

  select exists(
    select 1 from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = p_table
      and c.column_name = 'empresa_id'
  ) into v_has_empresa;

  if v_has_empresa then
    v_guard := format(
      ' where public.%I.empresa_id = ($1->>%L)::uuid',
      p_table, 'empresa_id'
    );
  end if;

  execute format(
    'insert into public.%I select * from jsonb_populate_record(null::public.%I, $1) ' ||
    'on conflict (%I) do update set %s%s returning to_jsonb(public.%I.*)',
    p_table, p_table, v_pk, v_set, v_guard, p_table
  )
  using p_row
  into v_result;

  return v_result;
end $$;

revoke all on function public.sync_push_upsert(text, jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_push_upsert(text, jsonb)
  to service_role;

commit;
