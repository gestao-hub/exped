-- Fecha duas janelas de concorrencia do ingest:
-- 1) uma chave parcial nunca pode vincular um documento/codigo divergente;
-- 2) cabecalho, cliente, pontos e itens de um re-sync mudam no mesmo commit.
begin;

create or replace function public.resolve_cliente_ingest(
  p_empresa uuid,
  p_cliente jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_documento text := nullif(
    pg_catalog.regexp_replace(coalesce(p_cliente ->> 'cnpj_cpf', ''), '\D', '', 'g'),
    ''
  );
  v_codigo text := nullif(pg_catalog.btrim(coalesce(p_cliente ->> 'codigo_erp', '')), '');
  v_documento_ids uuid[];
  v_codigo_ids uuid[];
  v_documento_id uuid;
  v_codigo_id uuid;
  v_id uuid;
  v_documento_existente text;
  v_codigo_existente text;
begin
  if p_empresa is null then
    raise exception using errcode = '22023', message = 'Empresa ausente';
  end if;
  if pg_catalog.jsonb_typeof(coalesce(p_cliente, '{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = 'Cliente invalido';
  end if;
  if v_documento is null and v_codigo is null then
    raise exception using errcode = '22023', message = 'Cliente sem documento ou codigo ERP';
  end if;

  if v_documento is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('exped.ingest.cliente.documento.' || p_empresa::text),
      pg_catalog.hashtext(v_documento)
    );
  end if;
  if v_codigo is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('exped.ingest.cliente.codigo.' || p_empresa::text),
      pg_catalog.hashtext(v_codigo)
    );
  end if;

  if v_documento is not null then
    select pg_catalog.array_agg(candidate.id order by candidate.created_at, candidate.id)
      into v_documento_ids
    from (
      select cliente.id, cliente.created_at
      from public.clientes cliente
      where cliente.empresa_id = p_empresa
        and cliente.deleted_at is null
        and pg_catalog.regexp_replace(coalesce(cliente.cnpj_cpf, ''), '\D', '', 'g') = v_documento
      order by cliente.created_at, cliente.id
      limit 2
      for update
    ) candidate;
    if coalesce(pg_catalog.cardinality(v_documento_ids), 0) > 1 then
      raise exception using errcode = '23505', message = 'Documento associado a mais de um cliente ativo';
    end if;
    v_documento_id := v_documento_ids[1];
  end if;

  if v_codigo is not null then
    select pg_catalog.array_agg(candidate.id order by candidate.created_at, candidate.id)
      into v_codigo_ids
    from (
      select cliente.id, cliente.created_at
      from public.clientes cliente
      where cliente.empresa_id = p_empresa
        and cliente.deleted_at is null
        and pg_catalog.btrim(coalesce(cliente.codigo_erp, '')) = v_codigo
      order by cliente.created_at, cliente.id
      limit 2
      for update
    ) candidate;
    if coalesce(pg_catalog.cardinality(v_codigo_ids), 0) > 1 then
      raise exception using errcode = '23505', message = 'Codigo ERP associado a mais de um cliente ativo';
    end if;
    v_codigo_id := v_codigo_ids[1];
  end if;

  if v_documento_id is not null and v_codigo_id is not null
     and v_documento_id <> v_codigo_id then
    raise exception using
      errcode = '23505',
      message = 'Documento e codigo ERP pertencem a clientes diferentes';
  end if;

  v_id := coalesce(v_documento_id, v_codigo_id);
  if v_id is not null then
    select
      nullif(pg_catalog.regexp_replace(coalesce(cliente.cnpj_cpf, ''), '\D', '', 'g'), ''),
      nullif(pg_catalog.btrim(coalesce(cliente.codigo_erp, '')), '')
    into v_documento_existente, v_codigo_existente
    from public.clientes cliente
    where cliente.id = v_id
    for update;

    if v_documento is not null
       and v_documento_existente is not null
       and v_documento <> v_documento_existente then
      raise exception using
        errcode = '23505',
        message = 'Documento diverge do cliente encontrado pelo codigo ERP';
    end if;
    if v_codigo is not null
       and v_codigo_existente is not null
       and v_codigo <> v_codigo_existente then
      raise exception using
        errcode = '23505',
        message = 'Codigo ERP diverge do cliente encontrado pelo documento';
    end if;

    update public.clientes cliente
    set
      cnpj_cpf = coalesce(
        nullif(pg_catalog.btrim(cliente.cnpj_cpf), ''),
        nullif(p_cliente ->> 'cnpj_cpf', '')
      ),
      codigo_erp = coalesce(nullif(pg_catalog.btrim(cliente.codigo_erp), ''), v_codigo)
    where cliente.id = v_id;
    return pg_catalog.jsonb_build_object('id', v_id, 'criou', false);
  end if;

  insert into public.clientes (
    empresa_id,
    cnpj_cpf,
    codigo_erp,
    nome,
    endereco_padrao,
    bairro_padrao,
    cidade_padrao,
    uf_padrao,
    cep_padrao,
    telefone_padrao
  ) values (
    p_empresa,
    nullif(p_cliente ->> 'cnpj_cpf', ''),
    v_codigo,
    coalesce(nullif(p_cliente ->> 'nome', ''), 'Cliente'),
    nullif(p_cliente ->> 'endereco', ''),
    nullif(p_cliente ->> 'bairro', ''),
    nullif(p_cliente ->> 'cidade', ''),
    nullif(p_cliente ->> 'uf', ''),
    nullif(p_cliente ->> 'cep', ''),
    nullif(p_cliente ->> 'telefone', '')
  )
  returning id into v_id;

  return pg_catalog.jsonb_build_object('id', v_id, 'criou', true);
end;
$$;

revoke all on function public.resolve_cliente_ingest(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.resolve_cliente_ingest(uuid, jsonb)
  to service_role;

create or replace function public.resync_pedido_ingest(
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
  v_header public.pedidos%rowtype;
  v_cliente_result jsonb;
  v_cliente_id uuid;
  v_cliente_warning text;
  v_pontos_ativos integer;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_ponto jsonb;
  v_ponto_ord bigint;
  v_ponto_id uuid;
  v_item jsonb;
  v_item_ord bigint;
begin
  if p_pedido_id is null or p_empresa is null then
    raise exception using errcode = '22023', message = 'Pedido ou empresa ausente';
  end if;
  if pg_catalog.jsonb_typeof(coalesce(p_header, '{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = 'Cabecalho do pedido invalido';
  end if;
  if pg_catalog.jsonb_typeof(coalesce(p_pontos, '[]'::jsonb)) <> 'array' then
    raise exception using errcode = '22023', message = 'Pontos do pedido invalidos';
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
      'updated', false,
      'reason', 'not_found',
      'id', p_pedido_id
    );
  end if;

  -- O lock no pai impede novas filhas por FK; os locks abaixo estabilizam as
  -- filhas existentes enquanto revalidamos se o vendedor ja dividiu o pedido.
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

  v_cliente_id := v_pedido.cliente_id;
  if v_cliente_id is null and p_cliente is not null then
    begin
      v_cliente_result := public.resolve_cliente_ingest(p_empresa, p_cliente);
      v_cliente_id := nullif(v_cliente_result ->> 'id', '')::uuid;
    exception
      when sqlstate '22023' or unique_violation then
        v_cliente_warning := sqlerrm;
        v_cliente_id := null;
    end;
  end if;

  v_header := pg_catalog.jsonb_populate_record(null::public.pedidos, p_header);
  update public.pedidos pedido
  set
    documento_erp = v_header.documento_erp,
    data_emissao = v_header.data_emissao,
    data_entrega = v_header.data_entrega,
    cliente_codigo = v_header.cliente_codigo,
    cliente_nome = v_header.cliente_nome,
    cliente_cnpj_cpf = v_header.cliente_cnpj_cpf,
    cliente_endereco = v_header.cliente_endereco,
    cliente_bairro = v_header.cliente_bairro,
    cliente_cidade = v_header.cliente_cidade,
    cliente_uf = v_header.cliente_uf,
    cliente_cep = v_header.cliente_cep,
    cliente_telefone = v_header.cliente_telefone,
    cliente_id = v_cliente_id,
    cliente_endereco_id = v_header.cliente_endereco_id,
    forma_pagamento = v_header.forma_pagamento,
    parcelas = v_header.parcelas,
    receber_na_entrega = coalesce(v_header.receber_na_entrega, false),
    valor_total = coalesce(v_header.valor_total, 0),
    valor_frete = coalesce(v_header.valor_frete, 0),
    data_entrega_inicio = v_header.data_entrega_inicio,
    nf_numero = v_header.nf_numero,
    nf_chave = v_header.nf_chave,
    nf_emitida_em = v_header.nf_emitida_em,
    nf_valor = v_header.nf_valor,
    observacoes = v_header.observacoes,
    storage_pdf_path = v_header.storage_pdf_path,
    vendedor_id = v_header.vendedor_id,
    exige_emissao = case
      when p_header ? 'exige_emissao' then coalesce(v_header.exige_emissao, false)
      else pedido.exige_emissao
    end
  where pedido.id = p_pedido_id;

  update public.pedido_itens item
  set deleted_at = v_now
  where item.ponto_retirada_id in (
    select ponto.id
    from public.pedido_pontos_retirada ponto
    where ponto.pedido_id = p_pedido_id
      and ponto.deleted_at is null
  )
    and item.deleted_at is null;

  update public.pedido_pontos_retirada ponto
  set deleted_at = v_now
  where ponto.pedido_id = p_pedido_id
    and ponto.deleted_at is null;

  for v_ponto, v_ponto_ord in
    select entry.value, entry.ordinality
    from pg_catalog.jsonb_array_elements(coalesce(p_pontos, '[]'::jsonb))
      with ordinality as entry(value, ordinality)
  loop
    insert into public.pedido_pontos_retirada (
      pedido_id, tipo, empresa_nome, endereco, ordem
    ) values (
      p_pedido_id,
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
    'updated', true,
    'id', v_pedido.id,
    'numero', v_pedido.numero_mapa,
    'cliente_id', v_cliente_id,
    'cliente_warning', v_cliente_warning
  ));
end;
$$;

revoke all on function public.resync_pedido_ingest(uuid, uuid, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.resync_pedido_ingest(uuid, uuid, jsonb, jsonb, jsonb)
  to service_role;

commit;
