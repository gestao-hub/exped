begin;

select plan(16);

select has_function(
  'public',
  'resolve_cliente_ingest',
  array['uuid', 'jsonb'],
  'RPC de resolucao do cliente do ingest existe'
);

select is(
  (
    select procedure.prosecdef
    from pg_catalog.pg_proc procedure
    where procedure.oid = to_regprocedure('public.resolve_cliente_ingest(uuid,jsonb)')
  ),
  true,
  'RPC usa SECURITY DEFINER'
);

select is(
  (
    select procedure.proconfig
    from pg_catalog.pg_proc procedure
    where procedure.oid = to_regprocedure('public.resolve_cliente_ingest(uuid,jsonb)')
  ),
  array['search_path=""']::text[],
  'RPC fixa search_path vazio'
);

select ok(
  not has_function_privilege('anon', 'public.resolve_cliente_ingest(uuid,jsonb)', 'execute'),
  'anon nao executa a RPC do ingest'
);

select ok(
  not has_function_privilege('authenticated', 'public.resolve_cliente_ingest(uuid,jsonb)', 'execute'),
  'authenticated nao executa a RPC do ingest'
);

select ok(
  has_function_privilege('service_role', 'public.resolve_cliente_ingest(uuid,jsonb)', 'execute'),
  'service_role executa a RPC do ingest'
);

insert into public.empresas (id, nome, slug)
values
  ('93000000-0000-0000-0000-000000000011', 'Ingest A', 'ingest-a-20260715'),
  ('93000000-0000-0000-0000-000000000012', 'Ingest B', 'ingest-b-20260715');

select throws_ok(
  $$
    select public.resolve_cliente_ingest(
      '93000000-0000-0000-0000-000000000011',
      '{"nome":"Sem chave"}'::jsonb
    )
  $$,
  '22023',
  'Cliente sem documento ou codigo ERP',
  'RPC recusa criar cliente sem chave natural'
);

create temporary table ingest_created as
select public.resolve_cliente_ingest(
  '93000000-0000-0000-0000-000000000011',
  '{"nome":"Cliente Hiper","codigo_erp":"1000373"}'::jsonb
) as result;

select is(
  (select result ->> 'criou' from ingest_created),
  'true',
  'primeira resolucao por codigo cria o cliente'
);

select is(
  public.resolve_cliente_ingest(
    '93000000-0000-0000-0000-000000000011',
    '{"nome":"Cliente Hiper","codigo_erp":"1000373"}'::jsonb
  ) ->> 'id',
  (select result ->> 'id' from ingest_created),
  'segunda resolucao pelo mesmo codigo reutiliza o cliente'
);

select is(
  public.resolve_cliente_ingest(
    '93000000-0000-0000-0000-000000000011',
    '{"nome":"Cliente Hiper","cnpj_cpf":"067.203.989-38","codigo_erp":"1000373"}'::jsonb
  ) ->> 'id',
  (select result ->> 'id' from ingest_created),
  'documento novo enriquece o cliente resolvido pelo codigo'
);

select is(
  (
    select cnpj_cpf
    from public.clientes
    where id = (select (result ->> 'id')::uuid from ingest_created)
  ),
  '067.203.989-38',
  'resolucao preenche documento anteriormente vazio'
);

insert into public.clientes (id, empresa_id, nome, cnpj_cpf, codigo_erp)
values
  (
    '93000000-0000-0000-0000-000000000021',
    '93000000-0000-0000-0000-000000000011',
    'Documento A',
    '11.111.111/0001-11',
    '2000001'
  ),
  (
    '93000000-0000-0000-0000-000000000022',
    '93000000-0000-0000-0000-000000000011',
    'Codigo B',
    '22.222.222/0001-22',
    '2000002'
  );

select throws_ok(
  $$
    select public.resolve_cliente_ingest(
      '93000000-0000-0000-0000-000000000011',
      '{"nome":"Conflito","cnpj_cpf":"11.111.111/0001-11","codigo_erp":"2000002"}'::jsonb
    )
  $$,
  '23505',
  'Documento e codigo ERP pertencem a clientes diferentes',
  'RPC recusa conflito entre documento e codigo'
);

select throws_ok(
  $$
    select public.resolve_cliente_ingest(
      '93000000-0000-0000-0000-000000000011',
      '{"nome":"Documento divergente","cnpj_cpf":"33.333.333/0001-33","codigo_erp":"2000001"}'::jsonb
    )
  $$,
  '23505',
  'Documento diverge do cliente encontrado pelo codigo ERP',
  'RPC recusa documento novo divergente do cliente encontrado apenas pelo codigo'
);

select throws_ok(
  $$
    select public.resolve_cliente_ingest(
      '93000000-0000-0000-0000-000000000011',
      '{"nome":"Codigo divergente","cnpj_cpf":"11.111.111/0001-11","codigo_erp":"2999999"}'::jsonb
    )
  $$,
  '23505',
  'Codigo ERP diverge do cliente encontrado pelo documento',
  'RPC recusa codigo novo divergente do cliente encontrado apenas pelo documento'
);

select isnt(
  public.resolve_cliente_ingest(
    '93000000-0000-0000-0000-000000000012',
    '{"nome":"Outro tenant","codigo_erp":"1000373"}'::jsonb
  ) ->> 'id',
  (select result ->> 'id' from ingest_created),
  'mesmo codigo em outra empresa cria outro cliente'
);

select is(
  (
    select count(*)::integer
    from public.clientes
    where empresa_id = '93000000-0000-0000-0000-000000000011'
      and codigo_erp = '1000373'
      and deleted_at is null
  ),
  1,
  'codigo estavel permanece com um unico cliente ativo'
);

select * from finish();
rollback;
