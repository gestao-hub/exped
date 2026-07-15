begin;

select plan(18);

select has_function(
  'public',
  'resync_pedido_ingest',
  array['uuid', 'uuid', 'jsonb', 'jsonb', 'jsonb'],
  'RPC transacional de re-sync do pedido existe'
);

select is(
  (
    select procedure.prosecdef
    from pg_catalog.pg_proc procedure
    where procedure.oid = to_regprocedure('public.resync_pedido_ingest(uuid,uuid,jsonb,jsonb,jsonb)')
  ),
  true,
  'RPC usa SECURITY DEFINER'
);

select is(
  (
    select procedure.proconfig
    from pg_catalog.pg_proc procedure
    where procedure.oid = to_regprocedure('public.resync_pedido_ingest(uuid,uuid,jsonb,jsonb,jsonb)')
  ),
  array['search_path=""']::text[],
  'RPC fixa search_path vazio'
);

select ok(
  not has_function_privilege('anon', 'public.resync_pedido_ingest(uuid,uuid,jsonb,jsonb,jsonb)', 'execute'),
  'anon nao executa re-sync do ingest'
);

select ok(
  not has_function_privilege('authenticated', 'public.resync_pedido_ingest(uuid,uuid,jsonb,jsonb,jsonb)', 'execute'),
  'authenticated nao executa re-sync do ingest'
);

select ok(
  has_function_privilege('service_role', 'public.resync_pedido_ingest(uuid,uuid,jsonb,jsonb,jsonb)', 'execute'),
  'service_role executa re-sync do ingest'
);

insert into public.empresas (id, nome, slug)
values ('94000000-0000-0000-0000-000000000001', 'Pedido ingest', 'pedido-ingest-20260715');

insert into public.pedidos (
  id, numero_mapa, documento_erp, empresa_id, cliente_nome, status, valor_total
) values (
  '94000000-0000-0000-0000-000000000011', 940011, 'HIPER-940011',
  '94000000-0000-0000-0000-000000000001', 'Antes', 'rascunho', 10
);

insert into public.pedido_pontos_retirada (
  id, pedido_id, tipo, empresa_nome, ordem
) values (
  '94000000-0000-0000-0000-000000000021',
  '94000000-0000-0000-0000-000000000011', 'loja', 'Ponto antigo', 0
);

insert into public.pedido_itens (
  id, ponto_retirada_id, codigo, descricao, quantidade, unidade, total
) values (
  '94000000-0000-0000-0000-000000000031',
  '94000000-0000-0000-0000-000000000021', 'OLD', 'Item antigo', 1, 'UN', 10
);

create temporary table pedido_resync_result as
select public.resync_pedido_ingest(
  '94000000-0000-0000-0000-000000000011',
  '94000000-0000-0000-0000-000000000001',
  '{"cliente_nome":"Depois","cliente_cnpj_cpf":"067.203.989-38","cliente_codigo":"1000373","valor_total":125,"valor_frete":0,"receber_na_entrega":false}'::jsonb,
  '{"nome":"Depois","cnpj_cpf":"067.203.989-38","codigo_erp":"1000373"}'::jsonb,
  '[{"tipo":"entrega","empresa_nome":"Franzoni","endereco":"Rua nova","itens":[{"codigo":"NEW","descricao":"Item novo","quantidade":3,"unidade":"UN","preco_unitario":41.6667,"desconto":0,"total":125,"modalidade":"entrega"}]}]'::jsonb
) as result;

select is(
  (select result ->> 'updated' from pedido_resync_result),
  'true',
  'rascunho intacto e atualizado'
);

select is(
  (select cliente_nome from public.pedidos where id = '94000000-0000-0000-0000-000000000011'),
  'Depois',
  'cabecalho foi atualizado'
);

select ok(
  (select cliente_id is not null from public.pedidos where id = '94000000-0000-0000-0000-000000000011'),
  'cliente foi resolvido e vinculado na transacao'
);

select ok(
  (select deleted_at is not null from public.pedido_pontos_retirada where id = '94000000-0000-0000-0000-000000000021'),
  'ponto anterior foi arquivado'
);

select ok(
  (select deleted_at is not null from public.pedido_itens where id = '94000000-0000-0000-0000-000000000031'),
  'item anterior foi arquivado'
);

select is(
  (
    select count(*)::integer
    from public.pedido_itens item
    join public.pedido_pontos_retirada ponto on ponto.id = item.ponto_retirada_id
    where ponto.pedido_id = '94000000-0000-0000-0000-000000000011'
      and ponto.deleted_at is null
      and item.deleted_at is null
      and item.codigo = 'NEW'
  ),
  1,
  'novo ponto e item foram inseridos'
);

create temporary table cliente_vinculado_antes as
select cliente_id
from public.pedidos
where id = '94000000-0000-0000-0000-000000000011';

select public.resync_pedido_ingest(
  '94000000-0000-0000-0000-000000000011',
  '94000000-0000-0000-0000-000000000001',
  '{"cliente_nome":"Ainda vinculado","valor_total":126,"valor_frete":0,"receber_na_entrega":false}'::jsonb,
  '{"nome":"Outro cliente","cnpj_cpf":"11.111.111/0001-11","codigo_erp":"OUTRO-CLIENTE"}'::jsonb,
  '[{"tipo":"loja","empresa_nome":"Franzoni","itens":[]}]'::jsonb
);

select is(
  (select cliente_id from public.pedidos where id = '94000000-0000-0000-0000-000000000011'),
  (select cliente_id from cliente_vinculado_antes),
  'cliente ja vinculado permanece no pedido durante o re-sync'
);

select is(
  (
    select count(*)::integer
    from public.clientes
    where empresa_id = '94000000-0000-0000-0000-000000000001'
      and codigo_erp = 'OUTRO-CLIENTE'
  ),
  0,
  'identidade recebida nao cria cliente quando o pedido ja possui vinculo'
);

update public.pedidos
set status = 'finalizado'
where id = '94000000-0000-0000-0000-000000000011';

select is(
  public.resync_pedido_ingest(
    '94000000-0000-0000-0000-000000000011',
    '94000000-0000-0000-0000-000000000001',
    '{"cliente_nome":"Nao sobrescrever","valor_total":999}'::jsonb,
    '{"nome":"Nao criar","codigo_erp":"NAO-CRIAR"}'::jsonb,
    '[]'::jsonb
  ) ->> 'reason',
  'protected',
  'pedido finalizado fica protegido'
);

select is(
  (select cliente_nome from public.pedidos where id = '94000000-0000-0000-0000-000000000011'),
  'Ainda vinculado',
  're-sync protegido nao altera cabecalho'
);

select is(
  (
    select count(*)::integer
    from public.clientes
    where empresa_id = '94000000-0000-0000-0000-000000000001'
      and codigo_erp = 'NAO-CRIAR'
  ),
  0,
  're-sync protegido nao cria cliente orfao'
);

update public.pedidos
set status = 'rascunho'
where id = '94000000-0000-0000-0000-000000000011';

insert into public.pedido_pontos_retirada (
  pedido_id, tipo, empresa_nome, ordem
) values (
  '94000000-0000-0000-0000-000000000011', 'loja', 'Divisao manual', 1
);

select is(
  public.resync_pedido_ingest(
    '94000000-0000-0000-0000-000000000011',
    '94000000-0000-0000-0000-000000000001',
    '{"cliente_nome":"Nao sobrescrever divisao","valor_total":999}'::jsonb,
    '{"nome":"Nao criar divisao","codigo_erp":"NAO-CRIAR-2"}'::jsonb,
    '[]'::jsonb
  ) ->> 'reason',
  'protected',
  'rascunho dividido manualmente fica protegido'
);

select * from finish();
rollback;
