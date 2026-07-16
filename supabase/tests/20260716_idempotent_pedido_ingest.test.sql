begin;

select plan(59);

select has_column(
  'public',
  'pedidos',
  'ingest_snapshot_hash',
  'pedidos guarda o hash semantico do ingest'
);

select has_column(
  'public',
  'pedidos',
  'ingest_pdf_snapshot_hash',
  'pedidos associa o PDF ao snapshot do ingest'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.resync_pedido_ingest(uuid,uuid,jsonb,jsonb,jsonb)',
    'execute'
  ),
  'authenticated nao executa o wrapper de ingest'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.resync_pedido_ingest(uuid,uuid,jsonb,jsonb,jsonb)',
    'execute'
  ),
  'service_role executa o wrapper de ingest'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.create_pedido_ingest(uuid,jsonb,jsonb,jsonb)',
    'execute'
  ),
  'authenticated nao cria pedido pelo ingest'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.create_pedido_ingest(uuid,jsonb,jsonb,jsonb)',
    'execute'
  ),
  'service_role cria pedido pelo ingest'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.attach_pedido_ingest_pdf(uuid,uuid,text,text)',
    'execute'
  ),
  'authenticated nao vincula PDF do ingest'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.attach_pedido_ingest_pdf(uuid,uuid,text,text)',
    'execute'
  ),
  'service_role vincula PDF do ingest'
);

insert into public.empresas (id, nome, slug)
values ('95000000-0000-0000-0000-000000000001', 'Ingest idempotente', 'ingest-idempotente-20260716');

create temporary table atomic_create_result as
select public.create_pedido_ingest(
  '95000000-0000-0000-0000-000000000001',
  jsonb_build_object(
    'documento_erp', 'HIPER-950015',
    'cliente_codigo', 'CLI-950015',
    'cliente_nome', 'Cliente atomico',
    'valor_total', 60,
    'valor_frete', 0,
    'receber_na_entrega', false,
    'ingest_snapshot_hash', repeat('e', 64)
  ),
  '{"codigo_erp":"CLI-950015","nome":"Cliente atomico"}'::jsonb,
  '[{"tipo":"loja","empresa_nome":"Loja","itens":[{"codigo":"ATOMIC","descricao":"Item atomico","quantidade":1,"unidade":"UN","preco_unitario":60,"desconto":0,"total":60,"modalidade":"loja"}]}]'::jsonb
) as result;

select is((select result ->> 'created' from atomic_create_result), 'true', 'criacao atomica cria o pedido');
select is(
  (
    select ingest_snapshot_hash
    from public.pedidos
    where id = (select (result ->> 'id')::uuid from atomic_create_result)
  ),
  repeat('e', 64),
  'criacao atomica confirma o hash junto com os filhos'
);
select ok(
  (
    select cliente_id is not null
    from public.pedidos
    where id = (select (result ->> 'id')::uuid from atomic_create_result)
  ),
  'criacao atomica vincula o cliente'
);
select is(
  (
    select count(*)::integer
    from public.pedido_pontos_retirada
    where pedido_id = (select (result ->> 'id')::uuid from atomic_create_result)
      and deleted_at is null
  ),
  1,
  'criacao atomica insere um ponto'
);
select is(
  (
    select count(*)::integer
    from public.pedido_itens item
    join public.pedido_pontos_retirada ponto on ponto.id = item.ponto_retirada_id
    where ponto.pedido_id = (select (result ->> 'id')::uuid from atomic_create_result)
      and ponto.deleted_at is null
      and item.deleted_at is null
  ),
  1,
  'criacao atomica insere um item'
);

create temporary table atomic_replay_result as
select public.create_pedido_ingest(
  '95000000-0000-0000-0000-000000000001',
  jsonb_build_object(
    'documento_erp', 'HIPER-950015',
    'cliente_codigo', 'CLI-950015',
    'cliente_nome', 'Cliente atomico',
    'valor_total', 60,
    'ingest_snapshot_hash', repeat('e', 64)
  ),
  '{"codigo_erp":"CLI-950015","nome":"Cliente atomico"}'::jsonb,
  '[]'::jsonb
) as result;

select is((select result ->> 'created' from atomic_replay_result), 'false', 'replay atomico nao cria outro pedido');
select is((select result ->> 'duplicate' from atomic_replay_result), 'true', 'replay atomico informa duplicidade');
select is(
  (select result ->> 'id' from atomic_replay_result),
  (select result ->> 'id' from atomic_create_result),
  'replay atomico devolve o mesmo pedido'
);
select is(
  (
    select count(*)::integer
    from public.pedido_pontos_retirada
    where pedido_id = (select (result ->> 'id')::uuid from atomic_create_result)
  ),
  1,
  'replay atomico nao duplica ponto'
);
select is(
  (
    select count(*)::integer
    from public.pedido_itens item
    join public.pedido_pontos_retirada ponto on ponto.id = item.ponto_retirada_id
    where ponto.pedido_id = (select (result ->> 'id')::uuid from atomic_create_result)
  ),
  1,
  'replay atomico nao duplica item'
);

select throws_ok(
  $$
    select public.create_pedido_ingest(
      '95000000-0000-0000-0000-000000000001',
      jsonb_build_object(
        'documento_erp', 'HIPER-950016',
        'cliente_nome', 'Criacao invalida',
        'valor_total', 70,
        'ingest_snapshot_hash', repeat('f', 64)
      ),
      '{}'::jsonb,
      '[{"tipo":"loja","empresa_nome":"Loja","itens":[{"codigo":"INVALID","descricao":"Item invalido","quantidade":1,"unidade":"UN","total":70,"modalidade":"invalida"}]}]'::jsonb
    )
  $$,
  '22P02',
  'invalid input value for enum public.modalidade_item: "invalida"',
  'falha em filho aborta a criacao atomica'
);
select is(
  (select count(*)::integer from public.pedidos where documento_erp = 'HIPER-950016'),
  0,
  'falha em filho nao deixa cabecalho parcial'
);

create temporary table pdf_attach_result as
select public.attach_pedido_ingest_pdf(
  (select (result ->> 'id')::uuid from atomic_create_result),
  '95000000-0000-0000-0000-000000000001',
  repeat('e', 64),
  'hiper-sync/95000000-0000-0000-0000-000000000001/HIPER-950015-eeee.pdf'
) as result;

select is((select result ->> 'attached' from pdf_attach_result), 'true', 'RPC vincula PDF ao snapshot');
select is(
  (
    select storage_pdf_path
    from public.pedidos
    where id = (select (result ->> 'id')::uuid from atomic_create_result)
  ),
  'hiper-sync/95000000-0000-0000-0000-000000000001/HIPER-950015-eeee.pdf',
  'caminho do PDF foi persistido'
);
select is(
  (
    select ingest_pdf_snapshot_hash
    from public.pedidos
    where id = (select (result ->> 'id')::uuid from atomic_create_result)
  ),
  repeat('e', 64),
  'PDF foi associado ao hash esperado'
);

create temporary table pdf_replay_result as
select public.attach_pedido_ingest_pdf(
  (select (result ->> 'id')::uuid from atomic_create_result),
  '95000000-0000-0000-0000-000000000001',
  repeat('e', 64),
  'hiper-sync/95000000-0000-0000-0000-000000000001/outro.pdf'
) as result;

select is((select result ->> 'attached' from pdf_replay_result), 'false', 'replay do PDF nao atualiza novamente');
select is((select result ->> 'reason' from pdf_replay_result), 'already_attached', 'replay informa PDF ja vinculado');
select is(
  (
    select storage_pdf_path
    from public.pedidos
    where id = (select (result ->> 'id')::uuid from atomic_create_result)
  ),
  'hiper-sync/95000000-0000-0000-0000-000000000001/HIPER-950015-eeee.pdf',
  'replay preserva o primeiro caminho do mesmo snapshot'
);

insert into public.pedidos (
  id, numero_mapa, documento_erp, empresa_id, cliente_nome, status, valor_total
) values (
  '95000000-0000-0000-0000-000000000011', 950011, 'HIPER-950011',
  '95000000-0000-0000-0000-000000000001', 'Antes', 'rascunho', 10
);

insert into public.pedido_pontos_retirada (
  id, pedido_id, tipo, empresa_nome, ordem
) values (
  '95000000-0000-0000-0000-000000000021',
  '95000000-0000-0000-0000-000000000011', 'loja', 'Ponto antigo', 0
);

insert into public.pedido_itens (
  id, ponto_retirada_id, codigo, descricao, quantidade, unidade, total
) values (
  '95000000-0000-0000-0000-000000000031',
  '95000000-0000-0000-0000-000000000021', 'OLD', 'Item antigo', 1, 'UN', 10
);

create temporary table first_result as
select public.resync_pedido_ingest(
  '95000000-0000-0000-0000-000000000011',
  '95000000-0000-0000-0000-000000000001',
  '{"cliente_nome":"Depois","valor_total":125,"valor_frete":0,"receber_na_entrega":false,"ingest_snapshot_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'::jsonb,
  '{"nome":"Depois"}'::jsonb,
  '[{"tipo":"loja","empresa_nome":"Loja","itens":[{"codigo":"NEW","descricao":"Item novo","quantidade":3,"unidade":"UN","preco_unitario":41.6667,"desconto":0,"total":125,"modalidade":"loja"}]}]'::jsonb
) as result;

select is((select result ->> 'updated' from first_result), 'true', 'primeiro snapshot atualiza');

select is(
  (select ingest_snapshot_hash from public.pedidos where id = '95000000-0000-0000-0000-000000000011'),
  repeat('a', 64),
  'hash foi persistido'
);

create temporary table state_after_first as
select
  pedido.updated_at as pedido_updated_at,
  ponto.id as ponto_id,
  item.id as item_id,
  (select count(*) from public.pedido_pontos_retirada all_points where all_points.pedido_id = pedido.id) as point_count,
  (
    select count(*)
    from public.pedido_itens all_items
    join public.pedido_pontos_retirada all_points on all_points.id = all_items.ponto_retirada_id
    where all_points.pedido_id = pedido.id
  ) as item_count
from public.pedidos pedido
join public.pedido_pontos_retirada ponto
  on ponto.pedido_id = pedido.id and ponto.deleted_at is null
join public.pedido_itens item
  on item.ponto_retirada_id = ponto.id and item.deleted_at is null
where pedido.id = '95000000-0000-0000-0000-000000000011';

select pg_catalog.pg_sleep(0.01);

create temporary table second_result as
select public.resync_pedido_ingest(
  '95000000-0000-0000-0000-000000000011',
  '95000000-0000-0000-0000-000000000001',
  '{"cliente_nome":"Depois","valor_total":125,"valor_frete":0,"receber_na_entrega":false,"ingest_snapshot_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'::jsonb,
  '{"nome":"Depois"}'::jsonb,
  '[{"tipo":"loja","empresa_nome":"Loja","itens":[{"codigo":"NEW","descricao":"Item novo","quantidade":3,"unidade":"UN","preco_unitario":41.6667,"desconto":0,"total":125,"modalidade":"loja"}]}]'::jsonb
) as result;

select is((select result ->> 'updated' from second_result), 'false', 'replay nao atualiza');
select is((select result ->> 'reason' from second_result), 'unchanged', 'replay informa unchanged');

select is(
  (select updated_at from public.pedidos where id = '95000000-0000-0000-0000-000000000011'),
  (select pedido_updated_at from state_after_first),
  'replay nao toca updated_at do pedido'
);

select is(
  (select id from public.pedido_pontos_retirada where pedido_id = '95000000-0000-0000-0000-000000000011' and deleted_at is null),
  (select ponto_id from state_after_first),
  'replay preserva o UUID do ponto'
);

select is(
  (
    select item.id
    from public.pedido_itens item
    join public.pedido_pontos_retirada ponto on ponto.id = item.ponto_retirada_id
    where ponto.pedido_id = '95000000-0000-0000-0000-000000000011'
      and ponto.deleted_at is null
      and item.deleted_at is null
  ),
  (select item_id from state_after_first),
  'replay preserva o UUID do item'
);

select is(
  (select count(*) from public.pedido_pontos_retirada where pedido_id = '95000000-0000-0000-0000-000000000011'),
  (select point_count from state_after_first),
  'replay nao cria outro ponto'
);

select is(
  (
    select count(*)
    from public.pedido_itens item
    join public.pedido_pontos_retirada ponto on ponto.id = item.ponto_retirada_id
    where ponto.pedido_id = '95000000-0000-0000-0000-000000000011'
  ),
  (select item_count from state_after_first),
  'replay nao cria outro item'
);

insert into public.pedidos (
  id, numero_mapa, documento_erp, empresa_id, cliente_codigo, cliente_nome,
  status, valor_total, ingest_snapshot_hash
) values (
  '95000000-0000-0000-0000-000000000012', 950012, 'HIPER-950012',
  '95000000-0000-0000-0000-000000000001', 'CLI-950012', 'Cliente tardio',
  'rascunho', 20, repeat('b', 64)
);

insert into public.pedido_pontos_retirada (
  id, pedido_id, tipo, empresa_nome, ordem
) values (
  '95000000-0000-0000-0000-000000000022',
  '95000000-0000-0000-0000-000000000012', 'loja', 'Ponto preservado', 0
);

insert into public.pedido_itens (
  id, ponto_retirada_id, codigo, descricao, quantidade, unidade, total
) values (
  '95000000-0000-0000-0000-000000000032',
  '95000000-0000-0000-0000-000000000022', 'KEEP', 'Item preservado', 1, 'UN', 20
);

create temporary table client_retry_result as
select public.resync_pedido_ingest(
  '95000000-0000-0000-0000-000000000012',
  '95000000-0000-0000-0000-000000000001',
  jsonb_build_object('ingest_snapshot_hash', repeat('b', 64)),
  '{"codigo_erp":"CLI-950012","nome":"Cliente tardio"}'::jsonb,
  '[]'::jsonb
) as result;

select is((select result ->> 'updated' from client_retry_result), 'true', 'replay tenta vincular cliente pendente');
select is((select result ->> 'reason' from client_retry_result), 'client_resolved', 'replay informa cliente resolvido');
select is((select result ->> 'snapshot_changed' from client_retry_result), 'false', 'vinculo nao altera o snapshot');
select ok(
  (select cliente_id is not null from public.pedidos where id = '95000000-0000-0000-0000-000000000012'),
  'cliente tardio foi vinculado'
);
select is(
  (select id from public.pedido_pontos_retirada where pedido_id = '95000000-0000-0000-0000-000000000012' and deleted_at is null),
  '95000000-0000-0000-0000-000000000022'::uuid,
  'vinculo tardio preserva o UUID do ponto'
);
select is(
  (
    select item.id
    from public.pedido_itens item
    join public.pedido_pontos_retirada ponto on ponto.id = item.ponto_retirada_id
    where ponto.pedido_id = '95000000-0000-0000-0000-000000000012'
      and ponto.deleted_at is null
      and item.deleted_at is null
  ),
  '95000000-0000-0000-0000-000000000032'::uuid,
  'vinculo tardio preserva o UUID do item'
);

insert into public.clientes (id, empresa_id, cnpj_cpf, nome)
values (
  '95000000-0000-0000-0000-000000000041',
  '95000000-0000-0000-0000-000000000001',
  '11111111111',
  'Cliente por documento'
);

insert into public.clientes (id, empresa_id, codigo_erp, nome)
values (
  '95000000-0000-0000-0000-000000000042',
  '95000000-0000-0000-0000-000000000001',
  'CLI-CONFLITO-950013',
  'Cliente por codigo'
);

insert into public.pedidos (
  id, numero_mapa, documento_erp, empresa_id, cliente_nome,
  status, valor_total, ingest_snapshot_hash
) values (
  '95000000-0000-0000-0000-000000000013', 950013, 'HIPER-950013',
  '95000000-0000-0000-0000-000000000001', 'Cliente conflitante',
  'rascunho', 30, repeat('c', 64)
);

insert into public.pedido_pontos_retirada (
  id, pedido_id, tipo, empresa_nome, ordem
) values (
  '95000000-0000-0000-0000-000000000023',
  '95000000-0000-0000-0000-000000000013', 'loja', 'Ponto em conflito', 0
);

insert into public.pedido_itens (
  id, ponto_retirada_id, codigo, descricao, quantidade, unidade, total
) values (
  '95000000-0000-0000-0000-000000000033',
  '95000000-0000-0000-0000-000000000023', 'CONFLICT', 'Item em conflito', 1, 'UN', 30
);

create temporary table client_conflict_result as
select public.resync_pedido_ingest(
  '95000000-0000-0000-0000-000000000013',
  '95000000-0000-0000-0000-000000000001',
  jsonb_build_object('ingest_snapshot_hash', repeat('c', 64)),
  '{"cnpj_cpf":"11111111111","codigo_erp":"CLI-CONFLITO-950013","nome":"Cliente conflitante"}'::jsonb,
  '[]'::jsonb
) as result;

select is((select result ->> 'updated' from client_conflict_result), 'false', 'conflito de cliente nao altera pedido');
select is((select result ->> 'reason' from client_conflict_result), 'client_unresolved', 'conflito informa cliente pendente');
select ok(
  (select cliente_id is null from public.pedidos where id = '95000000-0000-0000-0000-000000000013'),
  'conflito nao vincula cliente incorreto'
);
select is(
  (select id from public.pedido_pontos_retirada where pedido_id = '95000000-0000-0000-0000-000000000013' and deleted_at is null),
  '95000000-0000-0000-0000-000000000023'::uuid,
  'conflito preserva o UUID do ponto'
);
select is(
  (
    select item.id
    from public.pedido_itens item
    join public.pedido_pontos_retirada ponto on ponto.id = item.ponto_retirada_id
    where ponto.pedido_id = '95000000-0000-0000-0000-000000000013'
      and ponto.deleted_at is null
      and item.deleted_at is null
  ),
  '95000000-0000-0000-0000-000000000033'::uuid,
  'conflito preserva o UUID do item'
);
select is(
  (select ingest_snapshot_hash from public.pedidos where id = '95000000-0000-0000-0000-000000000013'),
  repeat('c', 64),
  'conflito preserva o hash para evitar recriar filhos'
);

insert into public.pedidos (
  id, numero_mapa, documento_erp, empresa_id, cliente_codigo, cliente_nome,
  status, valor_total, ingest_snapshot_hash
) values (
  '95000000-0000-0000-0000-000000000014', 950014, 'HIPER-950014',
  '95000000-0000-0000-0000-000000000001', 'CLI-PROTEGIDO-950014', 'Cliente protegido',
  'finalizado', 40, repeat('d', 64)
);

insert into public.pedido_pontos_retirada (
  id, pedido_id, tipo, empresa_nome, ordem
) values (
  '95000000-0000-0000-0000-000000000024',
  '95000000-0000-0000-0000-000000000014', 'loja', 'Ponto protegido', 0
);

insert into public.pedido_itens (
  id, ponto_retirada_id, codigo, descricao, quantidade, unidade, total
) values (
  '95000000-0000-0000-0000-000000000034',
  '95000000-0000-0000-0000-000000000024', 'PROTECTED', 'Item protegido', 1, 'UN', 40
);

create temporary table protected_retry_result as
select public.resync_pedido_ingest(
  '95000000-0000-0000-0000-000000000014',
  '95000000-0000-0000-0000-000000000001',
  jsonb_build_object('ingest_snapshot_hash', repeat('d', 64)),
  '{"codigo_erp":"CLI-PROTEGIDO-950014","nome":"Cliente protegido"}'::jsonb,
  '[]'::jsonb
) as result;

select is((select result ->> 'updated' from protected_retry_result), 'false', 'replay nao altera pedido protegido');
select is((select result ->> 'reason' from protected_retry_result), 'protected', 'replay reconhece protecao sob lock');
select ok(
  (select cliente_id is null from public.pedidos where id = '95000000-0000-0000-0000-000000000014'),
  'replay nao vincula cliente no pedido protegido'
);
select is(
  (
    select count(*)::integer
    from public.clientes
    where empresa_id = '95000000-0000-0000-0000-000000000001'
      and codigo_erp = 'CLI-PROTEGIDO-950014'
  ),
  0,
  'replay protegido nao cria cliente'
);
select is(
  (select id from public.pedido_pontos_retirada where pedido_id = '95000000-0000-0000-0000-000000000014' and deleted_at is null),
  '95000000-0000-0000-0000-000000000024'::uuid,
  'replay protegido preserva o UUID do ponto'
);
select is(
  (
    select item.id
    from public.pedido_itens item
    join public.pedido_pontos_retirada ponto on ponto.id = item.ponto_retirada_id
    where ponto.pedido_id = '95000000-0000-0000-0000-000000000014'
      and ponto.deleted_at is null
      and item.deleted_at is null
  ),
  '95000000-0000-0000-0000-000000000034'::uuid,
  'replay protegido preserva o UUID do item'
);

create temporary table protected_pdf_result as
select public.attach_pedido_ingest_pdf(
  '95000000-0000-0000-0000-000000000014',
  '95000000-0000-0000-0000-000000000001',
  repeat('d', 64),
  'hiper-sync/95000000-0000-0000-0000-000000000001/protegido.pdf'
) as result;

select is((select result ->> 'attached' from protected_pdf_result), 'false', 'PDF nao altera pedido protegido');
select is((select result ->> 'reason' from protected_pdf_result), 'protected', 'PDF reconhece pedido protegido sob lock');
select ok(
  (select storage_pdf_path is null from public.pedidos where id = '95000000-0000-0000-0000-000000000014'),
  'pedido protegido permanece sem caminho novo'
);

create temporary table stale_pdf_result as
select public.attach_pedido_ingest_pdf(
  (select (result ->> 'id')::uuid from atomic_create_result),
  '95000000-0000-0000-0000-000000000001',
  repeat('f', 64),
  'hiper-sync/95000000-0000-0000-0000-000000000001/stale.pdf'
) as result;

select is((select result ->> 'attached' from stale_pdf_result), 'false', 'PDF de snapshot antigo nao altera pedido');
select is((select result ->> 'reason' from stale_pdf_result), 'snapshot_changed', 'PDF antigo informa mudanca de snapshot');

select throws_ok(
  $$
    select public.resync_pedido_ingest(
      '95000000-0000-0000-0000-000000000011',
      '95000000-0000-0000-0000-000000000001',
      '{"ingest_snapshot_hash":"invalido"}'::jsonb,
      '{}'::jsonb,
      '[]'::jsonb
    )
  $$,
  '22023',
  'Hash do snapshot de ingest invalido',
  'hash invalido e recusado'
);

select * from finish();
rollback;
