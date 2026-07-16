begin;

alter table public.pedidos
  add column ingest_snapshot_hash text;

alter table public.pedidos
  add column ingest_pdf_snapshot_hash text;

alter table public.pedidos
  add constraint pedidos_ingest_snapshot_hash_check
  check (
    ingest_snapshot_hash is null
    or ingest_snapshot_hash ~ '^[0-9a-f]{64}$'
  );

alter table public.pedidos
  add constraint pedidos_ingest_pdf_snapshot_hash_check
  check (
    ingest_pdf_snapshot_hash is null
    or ingest_pdf_snapshot_hash ~ '^[0-9a-f]{64}$'
  );

comment on column public.pedidos.ingest_snapshot_hash is
  'SHA-256 do snapshot semantico recebido do Hiper; evita recriar filhos em backfill identico.';

comment on column public.pedidos.ingest_pdf_snapshot_hash is
  'Hash do snapshot cujo PDF esta em storage_pdf_path; serializa retries do upload.';

-- Mantem a implementacao transacional anterior isolada. O wrapper abaixo adquire
-- o mesmo lock do pedido, elimina replays identicos e so entao delega a mudanca real.
alter function public.resync_pedido_ingest(uuid, uuid, jsonb, jsonb, jsonb)
  rename to resync_pedido_ingest_apply;

revoke all on function public.resync_pedido_ingest_apply(uuid, uuid, jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role;

create function public.resync_pedido_ingest(
  p_pedido_id uuid,
  p_empresa uuid,
  p_header jsonb,
  p_cliente jsonb,
  p_pontos jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pedido public.pedidos%rowtype;
  v_hash text := nullif(p_header ->> 'ingest_snapshot_hash', '');
  v_has_client_identity boolean := (
    nullif(
      pg_catalog.regexp_replace(coalesce(p_cliente ->> 'cnpj_cpf', ''), '\D', '', 'g'),
      ''
    ) is not null
    or nullif(pg_catalog.btrim(coalesce(p_cliente ->> 'codigo_erp', '')), '') is not null
  );
  v_cliente_result jsonb;
  v_cliente_id uuid;
  v_cliente_warning text;
  v_pontos_ativos integer;
  v_result jsonb;
begin
  if p_pedido_id is null or p_empresa is null then
    raise exception using errcode = '22023', message = 'Pedido ou empresa ausente';
  end if;

  if v_hash is not null and v_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Hash do snapshot de ingest invalido';
  end if;

  select pedido.*
  into v_pedido
  from public.pedidos pedido
  where pedido.id = p_pedido_id
    and pedido.empresa_id = p_empresa
    and pedido.deleted_at is null
  for update;

  if found then
    -- Revalida a protecao dentro do mesmo lock usado pelo re-sync. O estado lido
    -- pela aplicacao pode ter mudado entre a deduplicacao e esta chamada.
    perform ponto.id
    from public.pedido_pontos_retirada ponto
    where ponto.pedido_id = p_pedido_id
      and ponto.deleted_at is null
    order by ponto.id
    for update;

    select pg_catalog.count(*)::integer
    into v_pontos_ativos
    from public.pedido_pontos_retirada ponto
    where ponto.pedido_id = p_pedido_id
      and ponto.deleted_at is null;

    if v_pedido.status <> 'rascunho'::public.pedido_status
       or v_pontos_ativos > 1 then
      return pg_catalog.jsonb_build_object(
        'updated', false,
        'reason', 'protected',
        'id', v_pedido.id,
        'numero', v_pedido.numero_mapa
      );
    end if;
  end if;

  if found
     and v_hash is not null
     and v_pedido.ingest_snapshot_hash = v_hash then
    -- O snapshot ja foi aplicado. Se apenas o cliente continua pendente, tenta
    -- resolver o vinculo sem tocar nos pontos e itens existentes.
    if v_pedido.cliente_id is null and v_has_client_identity then
      begin
        v_cliente_result := public.resolve_cliente_ingest(p_empresa, p_cliente);
        v_cliente_id := nullif(v_cliente_result ->> 'id', '')::uuid;

        update public.pedidos pedido
        set cliente_id = v_cliente_id
        where pedido.id = p_pedido_id
          and pedido.empresa_id = p_empresa;

        return pg_catalog.jsonb_build_object(
          'updated', true,
          'reason', 'client_resolved',
          'snapshot_changed', false,
          'id', v_pedido.id,
          'numero', v_pedido.numero_mapa,
          'cliente_id', v_cliente_id
        );
      exception
        when sqlstate '22023' or unique_violation then
          v_cliente_warning := sqlerrm;
          return pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
            'updated', false,
            'reason', 'client_unresolved',
            'snapshot_changed', false,
            'id', v_pedido.id,
            'numero', v_pedido.numero_mapa,
            'cliente_warning', v_cliente_warning
          ));
      end;
    end if;

    return pg_catalog.jsonb_build_object(
      'updated', false,
      'reason', 'unchanged',
      'id', v_pedido.id,
      'numero', v_pedido.numero_mapa
    );
  end if;

  v_result := public.resync_pedido_ingest_apply(
    p_pedido_id,
    p_empresa,
    p_header,
    p_cliente,
    p_pontos
  );

  if v_hash is not null and coalesce((v_result ->> 'updated')::boolean, false) then
    update public.pedidos pedido
    set ingest_snapshot_hash = v_hash
    where pedido.id = p_pedido_id
      and pedido.empresa_id = p_empresa;

    v_result := v_result || pg_catalog.jsonb_build_object('snapshot_changed', true);
  end if;

  return v_result;
end;
$$;

revoke all on function public.resync_pedido_ingest(uuid, uuid, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.resync_pedido_ingest(uuid, uuid, jsonb, jsonb, jsonb)
  to service_role;

-- A criacao inicial usa a mesma unidade transacional do re-sync. O lock por
-- empresa/documento fecha a corrida entre dois agentes antes mesmo do INSERT.
create function public.create_pedido_ingest(
  p_empresa uuid,
  p_header jsonb,
  p_cliente jsonb,
  p_pontos jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_header public.pedidos%rowtype;
  v_pedido public.pedidos%rowtype;
  v_existing public.pedidos%rowtype;
  v_documento text := nullif(pg_catalog.btrim(coalesce(p_header ->> 'documento_erp', '')), '');
  v_hash text := nullif(p_header ->> 'ingest_snapshot_hash', '');
  v_cliente_result jsonb;
  v_cliente_id uuid;
  v_cliente_warning text;
  v_pontos_ativos integer;
  v_ponto jsonb;
  v_ponto_ord bigint;
  v_ponto_id uuid;
  v_item jsonb;
  v_item_ord bigint;
begin
  if p_empresa is null then
    raise exception using errcode = '22023', message = 'Empresa ausente';
  end if;
  if pg_catalog.jsonb_typeof(coalesce(p_header, '{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = 'Cabecalho do pedido invalido';
  end if;
  if pg_catalog.jsonb_typeof(coalesce(p_pontos, '[]'::jsonb)) <> 'array' then
    raise exception using errcode = '22023', message = 'Pontos do pedido invalidos';
  end if;
  if v_hash is null or v_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Hash do snapshot de ingest invalido';
  end if;

  v_header := pg_catalog.jsonb_populate_record(null::public.pedidos, p_header);

  if v_documento is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('exped.ingest.pedido.' || p_empresa::text),
      pg_catalog.hashtext(v_documento)
    );

    select pedido.*
    into v_existing
    from public.pedidos pedido
    where pedido.empresa_id = p_empresa
      and pedido.documento_erp = v_documento
      and pedido.status <> 'cancelado'::public.pedido_status
    order by pedido.created_at, pedido.id
    limit 1
    for update;

    if found then
      select pg_catalog.count(*)::integer
      into v_pontos_ativos
      from public.pedido_pontos_retirada ponto
      where ponto.pedido_id = v_existing.id
        and ponto.deleted_at is null;

      return pg_catalog.jsonb_build_object(
        'created', false,
        'duplicate', true,
        'id', v_existing.id,
        'numero', v_existing.numero_mapa,
        'storage_pdf_path', v_existing.storage_pdf_path,
        'pdf_recovery_allowed', (
          v_existing.deleted_at is null
          and v_existing.status = 'rascunho'::public.pedido_status
          and v_existing.ingest_snapshot_hash = v_hash
          and v_existing.ingest_pdf_snapshot_hash is distinct from v_hash
          and v_pontos_ativos <= 1
        )
      );
    end if;
  end if;

  -- O bloco tambem reverte um cliente recem-criado se um INSERT externo vencer
  -- a corrida pela chave unica do documento.
  begin
    if p_cliente is not null then
      begin
        v_cliente_result := public.resolve_cliente_ingest(p_empresa, p_cliente);
        v_cliente_id := nullif(v_cliente_result ->> 'id', '')::uuid;
      exception
        when sqlstate '22023' or unique_violation then
          v_cliente_warning := sqlerrm;
          v_cliente_id := null;
      end;
    end if;

    insert into public.pedidos (
      empresa_id,
      documento_erp,
      data_emissao,
      data_entrega,
      cliente_codigo,
      cliente_nome,
      cliente_cnpj_cpf,
      cliente_endereco,
      cliente_bairro,
      cliente_cidade,
      cliente_uf,
      cliente_cep,
      cliente_telefone,
      cliente_id,
      cliente_endereco_id,
      forma_pagamento,
      parcelas,
      receber_na_entrega,
      valor_total,
      valor_frete,
      data_entrega_inicio,
      nf_numero,
      nf_chave,
      nf_emitida_em,
      nf_valor,
      observacoes,
      storage_pdf_path,
      ingest_snapshot_hash,
      ingest_pdf_snapshot_hash,
      vendedor_id,
      exige_emissao,
      status
    ) values (
      p_empresa,
      v_documento,
      v_header.data_emissao,
      v_header.data_entrega,
      v_header.cliente_codigo,
      coalesce(v_header.cliente_nome, 'Cliente'),
      v_header.cliente_cnpj_cpf,
      v_header.cliente_endereco,
      v_header.cliente_bairro,
      v_header.cliente_cidade,
      v_header.cliente_uf,
      v_header.cliente_cep,
      v_header.cliente_telefone,
      v_cliente_id,
      v_header.cliente_endereco_id,
      v_header.forma_pagamento,
      v_header.parcelas,
      coalesce(v_header.receber_na_entrega, false),
      coalesce(v_header.valor_total, 0),
      coalesce(v_header.valor_frete, 0),
      v_header.data_entrega_inicio,
      v_header.nf_numero,
      v_header.nf_chave,
      v_header.nf_emitida_em,
      v_header.nf_valor,
      v_header.observacoes,
      null,
      v_hash,
      null,
      v_header.vendedor_id,
      case
        when p_header ? 'exige_emissao' then coalesce(v_header.exige_emissao, false)
        else false
      end,
      'rascunho'::public.pedido_status
    )
    returning * into v_pedido;
  exception
    when unique_violation then
      if v_documento is null then
        raise;
      end if;

      select pedido.*
      into v_existing
      from public.pedidos pedido
      where pedido.empresa_id = p_empresa
        and pedido.documento_erp = v_documento
        and pedido.status <> 'cancelado'::public.pedido_status
      order by pedido.created_at, pedido.id
      limit 1
      for update;

      if not found then
        raise;
      end if;

      select pg_catalog.count(*)::integer
      into v_pontos_ativos
      from public.pedido_pontos_retirada ponto
      where ponto.pedido_id = v_existing.id
        and ponto.deleted_at is null;

      return pg_catalog.jsonb_build_object(
        'created', false,
        'duplicate', true,
        'id', v_existing.id,
        'numero', v_existing.numero_mapa,
        'storage_pdf_path', v_existing.storage_pdf_path,
        'pdf_recovery_allowed', (
          v_existing.deleted_at is null
          and v_existing.status = 'rascunho'::public.pedido_status
          and v_existing.ingest_snapshot_hash = v_hash
          and v_existing.ingest_pdf_snapshot_hash is distinct from v_hash
          and v_pontos_ativos <= 1
        )
      );
  end;

  for v_ponto, v_ponto_ord in
    select entry.value, entry.ordinality
    from pg_catalog.jsonb_array_elements(coalesce(p_pontos, '[]'::jsonb))
      with ordinality as entry(value, ordinality)
  loop
    insert into public.pedido_pontos_retirada (
      pedido_id, tipo, empresa_nome, endereco, ordem
    ) values (
      v_pedido.id,
      coalesce(
        nullif(v_ponto ->> 'tipo', '')::public.ponto_retirada_destino,
        'loja'::public.ponto_retirada_destino
      ),
      coalesce(v_ponto ->> 'empresa_nome', ''),
      nullif(v_ponto ->> 'endereco', ''),
      (v_ponto_ord - 1)::smallint
    )
    returning id into v_ponto_id;

    for v_item, v_item_ord in
      select entry.value, entry.ordinality
      from pg_catalog.jsonb_array_elements(coalesce(v_ponto -> 'itens', '[]'::jsonb))
        with ordinality as entry(value, ordinality)
    loop
      insert into public.pedido_itens (
        ponto_retirada_id,
        codigo,
        descricao,
        quantidade,
        unidade,
        preco_unitario,
        desconto,
        total,
        modalidade,
        referencia,
        saldo_estoque,
        ordem
      ) values (
        v_ponto_id,
        coalesce(v_item ->> 'codigo', ''),
        coalesce(v_item ->> 'descricao', ''),
        coalesce(nullif(v_item ->> 'quantidade', '')::numeric, 0),
        coalesce(nullif(v_item ->> 'unidade', ''), 'UN'),
        coalesce(nullif(v_item ->> 'preco_unitario', '')::numeric, 0),
        coalesce(nullif(v_item ->> 'desconto', '')::numeric, 0),
        coalesce(nullif(v_item ->> 'total', '')::numeric, 0),
        coalesce(
          nullif(v_item ->> 'modalidade', '')::public.modalidade_item,
          'loja'::public.modalidade_item
        ),
        nullif(v_item ->> 'referencia', ''),
        nullif(v_item ->> 'saldo_estoque', '')::numeric,
        (v_item_ord - 1)::smallint
      );
    end loop;
  end loop;

  return pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'created', true,
    'id', v_pedido.id,
    'numero', v_pedido.numero_mapa,
    'cliente_id', v_cliente_id,
    'cliente_warning', v_cliente_warning
  ));
end;
$$;

revoke all on function public.create_pedido_ingest(uuid, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_pedido_ingest(uuid, jsonb, jsonb, jsonb)
  to service_role;

-- O upload acontece antes do vinculo. Esta RPC usa o hash como compare-and-set:
-- retries concorrentes nunca substituem o PDF de outro snapshot nem tocam pedido protegido.
create function public.attach_pedido_ingest_pdf(
  p_pedido_id uuid,
  p_empresa uuid,
  p_expected_hash text,
  p_storage_pdf_path text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pedido public.pedidos%rowtype;
  v_pontos_ativos integer;
  v_previous_path text;
begin
  if p_pedido_id is null or p_empresa is null then
    raise exception using errcode = '22023', message = 'Pedido ou empresa ausente';
  end if;
  if p_expected_hash is null or p_expected_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Hash esperado do PDF invalido';
  end if;
  if nullif(pg_catalog.btrim(coalesce(p_storage_pdf_path, '')), '') is null
     or pg_catalog.length(p_storage_pdf_path) > 1024
     or p_storage_pdf_path not like 'hiper-sync/' || p_empresa::text || '/%'
     or pg_catalog.strpos(p_storage_pdf_path, '..') > 0 then
    raise exception using errcode = '22023', message = 'Caminho do PDF invalido';
  end if;

  select pedido.*
  into v_pedido
  from public.pedidos pedido
  where pedido.id = p_pedido_id
    and pedido.empresa_id = p_empresa
    and pedido.deleted_at is null
  for update;

  if not found then
    return pg_catalog.jsonb_build_object(
      'attached', false,
      'reason', 'not_found',
      'id', p_pedido_id
    );
  end if;

  perform ponto.id
  from public.pedido_pontos_retirada ponto
  where ponto.pedido_id = p_pedido_id
    and ponto.deleted_at is null
  order by ponto.id
  for update;

  select pg_catalog.count(*)::integer
  into v_pontos_ativos
  from public.pedido_pontos_retirada ponto
  where ponto.pedido_id = p_pedido_id
    and ponto.deleted_at is null;

  if v_pedido.status <> 'rascunho'::public.pedido_status
     or v_pontos_ativos > 1 then
    return pg_catalog.jsonb_build_object(
      'attached', false,
      'reason', 'protected',
      'id', v_pedido.id,
      'numero', v_pedido.numero_mapa
    );
  end if;

  if v_pedido.ingest_snapshot_hash is distinct from p_expected_hash then
    return pg_catalog.jsonb_build_object(
      'attached', false,
      'reason', 'snapshot_changed',
      'id', v_pedido.id,
      'numero', v_pedido.numero_mapa
    );
  end if;

  if v_pedido.storage_pdf_path is not null
     and v_pedido.ingest_pdf_snapshot_hash = p_expected_hash then
    return pg_catalog.jsonb_build_object(
      'attached', false,
      'reason', 'already_attached',
      'id', v_pedido.id,
      'numero', v_pedido.numero_mapa,
      'storage_pdf_path', v_pedido.storage_pdf_path
    );
  end if;

  v_previous_path := v_pedido.storage_pdf_path;
  update public.pedidos pedido
  set
    storage_pdf_path = p_storage_pdf_path,
    ingest_pdf_snapshot_hash = p_expected_hash
  where pedido.id = p_pedido_id
    and pedido.empresa_id = p_empresa;

  return pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'attached', true,
    'id', v_pedido.id,
    'numero', v_pedido.numero_mapa,
    'storage_pdf_path', p_storage_pdf_path,
    'previous_storage_pdf_path', v_previous_path
  ));
end;
$$;

revoke all on function public.attach_pedido_ingest_pdf(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.attach_pedido_ingest_pdf(uuid, uuid, text, text)
  to service_role;

commit;
