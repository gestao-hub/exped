-- O merge antigo fazia SELECT pela Data API, calculava em Node e gravava em outra
-- request/transacao. Dois hubs podiam ler o mesmo snapshot e o ultimo restaurava
-- campos que o primeiro acabara de atualizar. A validacao de tenant das tabelas
-- filhas sofria do mesmo TOCTOU.
--
-- Esta RPC recebe o tenant resolvido pelo token do dispositivo e executa, em uma
-- unica transacao: lock por PK, lock da linha/ancestrais, validacao de escopo,
-- merge por field_updated_at e upsert. A assinatura legada permanece durante o
-- rollout para que a migration possa ser aplicada antes do deploy da API.

create or replace function public.sync_merge_upsert(
  p_table text,
  p_empresa uuid,
  p_row jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_incoming jsonb := coalesce(p_row, '{}'::jsonb);
  v_existing jsonb;
  v_reconciled jsonb;
  v_merged jsonb;
  v_incoming_fua jsonb;
  v_existing_fua jsonb;
  v_merged_fua jsonb;
  v_incoming_fua_raw jsonb;
  v_existing_fua_raw jsonb;
  v_pk text;
  v_key text;
  v_incoming_ts timestamptz;
  v_existing_ts timestamptz;
  v_updated_at timestamptz;
  v_now timestamptz := statement_timestamp();
  v_epoch constant timestamptz := '1970-01-01T00:00:00Z'::timestamptz;
  v_existing_parent uuid;
  v_incoming_parent uuid;
  v_parent_empresa uuid;
  v_reference uuid;
  v_reference_empresa uuid;
  v_reference_exists boolean;
  v_has_empresa boolean;
begin
  if p_table not in (
    'clientes', 'pedidos', 'pedido_pontos_retirada', 'pedido_itens',
    'ordens_servico', 'os_itens', 'os_servicos', 'os_notificacoes'
  ) then
    raise exception 'sync_merge_upsert: tabela nao permitida %', p_table;
  end if;

  if p_empresa is null then
    raise exception 'sync_merge_upsert: empresa ausente';
  end if;

  if jsonb_typeof(v_incoming) <> 'object' then
    raise exception 'sync_merge_upsert: linha invalida';
  end if;

  v_pk := nullif(v_incoming ->> 'id', '');
  if v_pk is null then
    raise exception 'sync_merge_upsert: id ausente';
  end if;

  -- Mesmo uma PK ainda inexistente precisa de lock: FOR UPDATE nao serializa o
  -- vazio e dois INSERTs concorrentes poderiam passar pela validacao juntos.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('exped.sync.' || p_table),
    pg_catalog.hashtext(v_pk)
  );

  -- Mass-assignment: somente colunas reais atravessam para o merge/upsert.
  select coalesce(pg_catalog.jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
    into v_incoming
  from pg_catalog.jsonb_each(v_incoming) entry
  join information_schema.columns column_info
    on column_info.table_schema = 'public'
   and column_info.table_name = p_table
   and column_info.column_name = entry.key;

  v_has_empresa := p_table in (
    'clientes', 'pedidos', 'ordens_servico', 'os_notificacoes'
  );
  if v_has_empresa then
    -- O valor confiavel vem do token do dispositivo, nao do JSON recebido.
    v_incoming := pg_catalog.jsonb_set(
      v_incoming,
      '{empresa_id}',
      pg_catalog.to_jsonb(p_empresa),
      true
    );
  end if;

  execute pg_catalog.format(
    'select to_jsonb(row_data.*) from public.%I row_data ' ||
    'where row_data.id = $1::uuid for update',
    p_table
  )
  using v_pk
  into v_existing;

  -- Tabelas diretas: a linha existente nunca pode migrar de empresa.
  if v_existing is not null and v_has_empresa then
    if nullif(v_existing ->> 'empresa_id', '')::uuid is distinct from p_empresa then
      return null;
    end if;
  end if;

  -- Mantem o contrato legado de reconciliacao de cliente por CNPJ/CPF. O lock
  -- natural evita duas insercoes simultaneas com IDs locais diferentes.
  if p_table = 'clientes'
     and v_existing is null
     and nullif(v_incoming ->> 'cnpj_cpf', '') is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('exped.sync.clientes.cnpj'),
      pg_catalog.hashtext(
        pg_catalog.regexp_replace(v_incoming ->> 'cnpj_cpf', '\D', '', 'g')
      )
    );

    select pg_catalog.to_jsonb(cliente.*)
      into v_reconciled
    from public.clientes cliente
    where cliente.empresa_id = p_empresa
      and cliente.deleted_at is null
      and pg_catalog.regexp_replace(
        coalesce(cliente.cnpj_cpf, ''),
        '\D',
        '',
        'g'
      ) = pg_catalog.regexp_replace(v_incoming ->> 'cnpj_cpf', '\D', '', 'g')
      and cliente.id <> v_pk::uuid
    limit 1
    for update;

    if v_reconciled is not null then
      v_pk := v_reconciled ->> 'id';
      perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('exped.sync.' || p_table),
        pg_catalog.hashtext(v_pk)
      );
      v_incoming := pg_catalog.jsonb_set(
        v_incoming,
        '{id}',
        pg_catalog.to_jsonb(v_pk::uuid),
        true
      );
      v_existing := v_reconciled;
    end if;
  end if;

  -- Para filhas, valida tanto o ancestral da linha existente quanto o ancestral
  -- solicitado. Os FOR UPDATE mantem a cadeia estavel ate o upsert terminar.
  if p_table = 'pedido_pontos_retirada' then
    if v_existing is not null then
      v_existing_parent := nullif(v_existing ->> 'pedido_id', '')::uuid;
      select pedido.empresa_id
        into v_parent_empresa
      from public.pedidos pedido
      where pedido.id = v_existing_parent
      for update;
      if v_parent_empresa is distinct from p_empresa then return null; end if;
    end if;

    v_incoming_parent := coalesce(
      nullif(v_incoming ->> 'pedido_id', '')::uuid,
      v_existing_parent
    );
    v_parent_empresa := null;
    select pedido.empresa_id
      into v_parent_empresa
    from public.pedidos pedido
    where pedido.id = v_incoming_parent
    for update;
    if v_parent_empresa is distinct from p_empresa then return null; end if;

  elsif p_table = 'pedido_itens' then
    if v_existing is not null then
      v_existing_parent := nullif(v_existing ->> 'ponto_retirada_id', '')::uuid;
      select pedido.empresa_id
        into v_parent_empresa
      from public.pedido_pontos_retirada ponto
      join public.pedidos pedido on pedido.id = ponto.pedido_id
      where ponto.id = v_existing_parent
      for update of ponto, pedido;
      if v_parent_empresa is distinct from p_empresa then return null; end if;
    end if;

    v_incoming_parent := coalesce(
      nullif(v_incoming ->> 'ponto_retirada_id', '')::uuid,
      v_existing_parent
    );
    v_parent_empresa := null;
    select pedido.empresa_id
      into v_parent_empresa
    from public.pedido_pontos_retirada ponto
    join public.pedidos pedido on pedido.id = ponto.pedido_id
    where ponto.id = v_incoming_parent
    for update of ponto, pedido;
    if v_parent_empresa is distinct from p_empresa then return null; end if;

  elsif p_table in ('os_itens', 'os_servicos') then
    if v_existing is not null then
      v_existing_parent := nullif(v_existing ->> 'os_id', '')::uuid;
      select ordem.empresa_id
        into v_parent_empresa
      from public.ordens_servico ordem
      where ordem.id = v_existing_parent
      for update;
      if v_parent_empresa is distinct from p_empresa then return null; end if;
    end if;

    v_incoming_parent := coalesce(
      nullif(v_incoming ->> 'os_id', '')::uuid,
      v_existing_parent
    );
    v_parent_empresa := null;
    select ordem.empresa_id
      into v_parent_empresa
    from public.ordens_servico ordem
    where ordem.id = v_incoming_parent
    for update;
    if v_parent_empresa is distinct from p_empresa then return null; end if;
  end if;

  -- field_updated_at chega de maquinas com fusos e relogios diferentes. Mantem
  -- apenas chaves que correspondem a colunas realmente enviadas, aceita somente
  -- strings parseaveis como timestamptz e limita o futuro ao relogio confiavel
  -- desta transacao. Isso impede uma chave desconhecida/2099 de envenenar o
  -- updated_at usado pelos cursores de pull.
  v_incoming_fua_raw := case
    when pg_catalog.jsonb_typeof(v_incoming -> 'field_updated_at') = 'object'
      then v_incoming -> 'field_updated_at'
    else '{}'::jsonb
  end;
  v_incoming_fua := '{}'::jsonb;

  for v_key in
    select entry.key
    from pg_catalog.jsonb_each(v_incoming_fua_raw) entry
    where pg_catalog.jsonb_typeof(entry.value) = 'string'
      and v_incoming ? entry.key
      and entry.key not in ('id', 'field_updated_at', 'updated_at')
  loop
    v_incoming_ts := null;
    begin
      v_incoming_ts := (v_incoming_fua_raw ->> v_key)::timestamptz;
    exception when others then
      v_incoming_ts := null;
    end;

    if v_incoming_ts is not null then
      v_incoming_ts := greatest(
        v_epoch,
        least(v_incoming_ts, v_now)
      );
      v_incoming_fua := pg_catalog.jsonb_set(
        v_incoming_fua,
        array[v_key],
        pg_catalog.to_jsonb(v_incoming_ts),
        true
      );
    end if;
  end loop;

  v_existing_fua_raw := case
    when pg_catalog.jsonb_typeof(v_existing -> 'field_updated_at') = 'object'
      then v_existing -> 'field_updated_at'
    else '{}'::jsonb
  end;
  v_existing_fua := '{}'::jsonb;

  for v_key in
    select entry.key
    from pg_catalog.jsonb_each(v_existing_fua_raw) entry
    where pg_catalog.jsonb_typeof(entry.value) = 'string'
      and entry.key not in ('id', 'field_updated_at', 'updated_at')
      and exists (
        select 1
        from information_schema.columns column_info
        where column_info.table_schema = 'public'
          and column_info.table_name = p_table
          and column_info.column_name = entry.key
      )
  loop
    v_existing_ts := null;
    begin
      v_existing_ts := (v_existing_fua_raw ->> v_key)::timestamptz;
    exception when others then
      v_existing_ts := null;
    end;

    if v_existing_ts is not null then
      v_existing_ts := greatest(
        v_epoch,
        least(v_existing_ts, v_now)
      );
      v_existing_fua := pg_catalog.jsonb_set(
        v_existing_fua,
        array[v_key],
        pg_catalog.to_jsonb(v_existing_ts),
        true
      );
    end if;
  end loop;

  if v_existing is null then
    v_merged := v_incoming;
    v_merged_fua := v_incoming_fua;

    -- Linhas legadas sem metadata ainda precisam entrar no proximo pull. O
    -- servidor atribui um carimbo aos campos recebidos sem timestamp confiavel.
    for v_key in
      select entry.key
      from pg_catalog.jsonb_each(v_incoming) entry
      where entry.key not in ('id', 'field_updated_at', 'updated_at')
    loop
      if not (v_merged_fua ? v_key) then
        v_merged_fua := pg_catalog.jsonb_set(
          v_merged_fua,
          array[v_key],
          pg_catalog.to_jsonb(v_now),
          true
        );
      end if;
    end loop;
  else
    v_merged := v_existing;
    v_merged_fua := v_existing_fua;

    -- Empate favorece o incoming, preservando o contrato de merge existente.
    for v_key in
      select entry.key
      from pg_catalog.jsonb_each(v_incoming) entry
      where entry.key not in ('id', 'field_updated_at', 'updated_at')
    loop
      v_incoming_ts := case
        when v_incoming_fua ? v_key
          then (v_incoming_fua ->> v_key)::timestamptz
        else null
      end;
      v_existing_ts := case
        when v_existing_fua ? v_key
          then (v_existing_fua ->> v_key)::timestamptz
        else null
      end;

      if (
        v_incoming_ts is not null
        and (v_existing_ts is null or v_incoming_ts >= v_existing_ts)
      ) or (
        v_incoming_ts is null and v_existing_ts is null
      ) then
        v_merged := pg_catalog.jsonb_set(
          v_merged,
          array[v_key],
          v_incoming -> v_key,
          true
        );
        v_merged_fua := pg_catalog.jsonb_set(
          v_merged_fua,
          array[v_key],
          pg_catalog.to_jsonb(
            case
              when v_incoming_ts is not null
               and v_existing_ts is not null
               and v_incoming_ts = v_existing_ts
               and (v_existing -> v_key) is distinct from (v_incoming -> v_key)
                then v_now
              else coalesce(v_incoming_ts, v_now)
            end
          ),
          true
        );
      end if;
    end loop;
  end if;

  if v_has_empresa then
    v_merged := pg_catalog.jsonb_set(
      v_merged,
      '{empresa_id}',
      pg_catalog.to_jsonb(p_empresa),
      true
    );
  end if;

  -- As tabelas diretas tambem possuem FKs multi-tenant. A empresa da propria
  -- linha nao basta: valida a referencia final ja mergeada e a mantem travada
  -- ate o upsert, evitando TOCTOU e relacionamentos cruzados.
  if p_table = 'pedidos' then
    v_reference := nullif(v_merged ->> 'cliente_id', '')::uuid;
    if v_reference is not null then
      v_reference_exists := false;
      v_reference_empresa := null;
      select true, cliente.empresa_id
        into v_reference_exists, v_reference_empresa
      from public.clientes cliente
      where cliente.id = v_reference
      for update;
      if coalesce(v_reference_exists, false)
         and v_reference_empresa is distinct from p_empresa then
        return null;
      end if;
    end if;

    v_reference := nullif(v_merged ->> 'cliente_endereco_id', '')::uuid;
    if v_reference is not null then
      v_reference_exists := false;
      v_reference_empresa := null;
      select true, endereco.empresa_id
        into v_reference_exists, v_reference_empresa
      from public.cliente_enderecos endereco
      where endereco.id = v_reference
      for update;
      if coalesce(v_reference_exists, false)
         and v_reference_empresa is distinct from p_empresa then
        return null;
      end if;
    end if;

    v_reference := nullif(v_merged ->> 'vendedor_id', '')::uuid;
    if v_reference is not null then
      v_reference_exists := false;
      v_reference_empresa := null;
      select true, profile.empresa_id
        into v_reference_exists, v_reference_empresa
      from public.profiles profile
      where profile.id = v_reference
      for update;
      if coalesce(v_reference_exists, false)
         and v_reference_empresa is distinct from p_empresa then
        return null;
      end if;
    end if;

  elsif p_table = 'ordens_servico' then
    v_reference := nullif(v_merged ->> 'cliente_id', '')::uuid;
    if v_reference is not null then
      v_reference_exists := false;
      v_reference_empresa := null;
      select true, cliente.empresa_id
        into v_reference_exists, v_reference_empresa
      from public.clientes cliente
      where cliente.id = v_reference
      for update;
      if coalesce(v_reference_exists, false)
         and v_reference_empresa is distinct from p_empresa then
        return null;
      elsif not coalesce(v_reference_exists, false) then
        v_merged := v_merged - 'cliente_id';
      end if;
    end if;

    v_reference := nullif(v_merged ->> 'vendedor_id', '')::uuid;
    if v_reference is not null then
      v_reference_exists := false;
      v_reference_empresa := null;
      select true, profile.empresa_id
        into v_reference_exists, v_reference_empresa
      from public.profiles profile
      where profile.id = v_reference
      for update;
      if coalesce(v_reference_exists, false)
         and v_reference_empresa is distinct from p_empresa then
        return null;
      elsif not coalesce(v_reference_exists, false) then
        v_merged := v_merged - 'vendedor_id';
      end if;
    end if;

  elsif p_table = 'os_notificacoes' then
    v_reference := nullif(v_merged ->> 'os_id', '')::uuid;
    if v_reference is not null then
      v_reference_exists := false;
      v_reference_empresa := null;
      select true, ordem.empresa_id
        into v_reference_exists, v_reference_empresa
      from public.ordens_servico ordem
      where ordem.id = v_reference
      for update;
      if not coalesce(v_reference_exists, false)
         or v_reference_empresa is distinct from p_empresa then
        return null;
      end if;
    end if;
  end if;

  select pg_catalog.max((entry.value #>> '{}')::timestamptz)
    into v_updated_at
  from pg_catalog.jsonb_each(v_merged_fua) entry
  where pg_catalog.jsonb_typeof(entry.value) = 'string';

  v_updated_at := coalesce(v_updated_at, v_now);

  v_merged := pg_catalog.jsonb_set(
    v_merged,
    '{field_updated_at}',
    v_merged_fua,
    true
  );
  v_merged := pg_catalog.jsonb_set(
    v_merged,
    '{updated_at}',
    pg_catalog.to_jsonb(v_updated_at),
    true
  );

  -- A funcao legada continua concentrando casts, allowlist de colunas e os
  -- gatilhos de reconciliacao. Como e chamada aqui, participa desta transacao.
  return public.sync_push_upsert(p_table, v_merged);
end;
$$;

revoke all on function public.sync_merge_upsert(text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_merge_upsert(text, uuid, jsonb)
  to service_role;
