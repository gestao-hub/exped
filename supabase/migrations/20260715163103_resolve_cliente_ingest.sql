-- Resolve a chave natural do cliente e cria o cadastro do ingest na mesma
-- transacao. O lock evita duplicatas quando o agente reenvia pedidos em paralelo.
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
  v_id uuid;
begin
  if p_empresa is null then
    raise exception using errcode = '22023', message = 'Empresa ausente';
  end if;
  if pg_catalog.jsonb_typeof(coalesce(p_cliente, '{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = 'Cliente invalido';
  end if;

  -- A ordem e fixa em todas as chamadas para evitar deadlock entre documento e codigo.
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
    select cliente.id
      into v_id
    from public.clientes cliente
    where cliente.empresa_id = p_empresa
      and cliente.deleted_at is null
      and pg_catalog.regexp_replace(coalesce(cliente.cnpj_cpf, ''), '\D', '', 'g') = v_documento
    order by cliente.created_at, cliente.id
    limit 1
    for update;
  end if;

  if v_id is null and v_codigo is not null then
    select cliente.id
      into v_id
    from public.clientes cliente
    where cliente.empresa_id = p_empresa
      and cliente.deleted_at is null
      and pg_catalog.btrim(coalesce(cliente.codigo_erp, '')) = v_codigo
    order by cliente.created_at, cliente.id
    limit 1
    for update;
  end if;

  if v_id is not null then
    update public.clientes cliente
    set
      cnpj_cpf = coalesce(cliente.cnpj_cpf, nullif(p_cliente ->> 'cnpj_cpf', '')),
      codigo_erp = coalesce(cliente.codigo_erp, v_codigo)
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

commit;
