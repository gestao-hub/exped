begin;

select plan(10);

insert into public.empresas (id, nome, slug)
values
  ('b1000000-0000-4000-8000-000000000001', 'Historico A', 'historico-a-20260714'),
  ('b1000000-0000-4000-8000-000000000002', 'Historico B', 'historico-b-20260714');

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select
  id,
  '00000000-0000-0000-0000-000000000000'::uuid,
  'authenticated',
  'authenticated',
  email,
  '',
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
from (values
  ('b1000000-0000-4000-8000-000000000011'::uuid, 'admin-a-history@teste.local'),
  ('b1000000-0000-4000-8000-000000000012'::uuid, 'admin-b-history@teste.local'),
  ('b1000000-0000-4000-8000-000000000013'::uuid, 'financeiro-a-history@teste.local'),
  ('b1000000-0000-4000-8000-000000000014'::uuid, 'vendedor-a-history@teste.local')
) as users(id, email);

update public.profiles
set empresa_id = case id
      when 'b1000000-0000-4000-8000-000000000012'::uuid
        then 'b1000000-0000-4000-8000-000000000002'::uuid
      else 'b1000000-0000-4000-8000-000000000001'::uuid
    end,
    role = case id
      when 'b1000000-0000-4000-8000-000000000013'::uuid
        then 'financeiro'::public.user_role
      when 'b1000000-0000-4000-8000-000000000014'::uuid
        then 'vendedor'::public.user_role
      else 'admin'::public.user_role
    end
where id in (
  'b1000000-0000-4000-8000-000000000011',
  'b1000000-0000-4000-8000-000000000012',
  'b1000000-0000-4000-8000-000000000013',
  'b1000000-0000-4000-8000-000000000014'
);

insert into public.pedidos (
  id, empresa_id, cliente_nome, vendedor_id, status
)
values
  (
    'b1000000-0000-4000-8000-000000000101',
    'b1000000-0000-4000-8000-000000000001',
    'Pedido rascunho A',
    'b1000000-0000-4000-8000-000000000014',
    'rascunho'
  ),
  (
    'b1000000-0000-4000-8000-000000000102',
    'b1000000-0000-4000-8000-000000000001',
    'Pedido finalizado A',
    'b1000000-0000-4000-8000-000000000014',
    'finalizado'
  ),
  (
    'b1000000-0000-4000-8000-000000000103',
    'b1000000-0000-4000-8000-000000000002',
    'Pedido B',
    null,
    'finalizado'
  );

insert into public.pedido_pontos_retirada (id, pedido_id, empresa_nome)
values
  (
    'b1000000-0000-4000-8000-000000000201',
    'b1000000-0000-4000-8000-000000000101',
    'Ponto rascunho A'
  ),
  (
    'b1000000-0000-4000-8000-000000000202',
    'b1000000-0000-4000-8000-000000000102',
    'Ponto finalizado A'
  ),
  (
    'b1000000-0000-4000-8000-000000000203',
    'b1000000-0000-4000-8000-000000000103',
    'Ponto B'
  );

insert into public.pedido_itens (id, ponto_retirada_id, codigo, descricao)
values
  (
    'b1000000-0000-4000-8000-000000000301',
    'b1000000-0000-4000-8000-000000000201',
    'RASCUNHO',
    'Item rascunho A'
  ),
  (
    'b1000000-0000-4000-8000-000000000302',
    'b1000000-0000-4000-8000-000000000202',
    'FINAL',
    'Item finalizado A'
  ),
  (
    'b1000000-0000-4000-8000-000000000303',
    'b1000000-0000-4000-8000-000000000203',
    'B',
    'Item B'
  );

insert into public.pedido_comentarios (id, pedido_id, autor_id, texto)
values (
  'b1000000-0000-4000-8000-000000000401',
  'b1000000-0000-4000-8000-000000000103',
  'b1000000-0000-4000-8000-000000000012',
  'Comentario do tenant B'
);

select ok(
  not has_table_privilege('authenticated', 'public.pedido_itens', 'delete'),
  'authenticated nao possui hard delete de itens'
);

select ok(
  not has_table_privilege('authenticated', 'public.pedido_pontos_retirada', 'delete'),
  'authenticated nao possui hard delete de pontos'
);

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"b1000000-0000-4000-8000-000000000013","role":"authenticated"}';

select is(
  (select count(*)::integer from public.pedido_itens),
  2,
  'financeiro le itens do proprio tenant'
);

update public.pedido_itens
set descricao = 'Financeiro alterou'
where id = 'b1000000-0000-4000-8000-000000000301';

select is(
  (
    select descricao
    from public.pedido_itens
    where id = 'b1000000-0000-4000-8000-000000000301'
  ),
  'Item rascunho A',
  'financeiro nao altera itens'
);

update public.pedido_pontos_retirada
set empresa_nome = 'Financeiro alterou'
where id = 'b1000000-0000-4000-8000-000000000201';

select is(
  (
    select empresa_nome
    from public.pedido_pontos_retirada
    where id = 'b1000000-0000-4000-8000-000000000201'
  ),
  'Ponto rascunho A',
  'financeiro nao altera pontos'
);

set local request.jwt.claims =
  '{"sub":"b1000000-0000-4000-8000-000000000014","role":"authenticated"}';

update public.pedido_itens
set descricao = 'Edicao valida do rascunho'
where id = 'b1000000-0000-4000-8000-000000000301';

select is(
  (
    select descricao
    from public.pedido_itens
    where id = 'b1000000-0000-4000-8000-000000000301'
  ),
  'Edicao valida do rascunho',
  'vendedor altera item do proprio rascunho'
);

update public.pedido_itens
set descricao = 'Edicao indevida do historico'
where id = 'b1000000-0000-4000-8000-000000000302';

select is(
  (
    select descricao
    from public.pedido_itens
    where id = 'b1000000-0000-4000-8000-000000000302'
  ),
  'Item finalizado A',
  'vendedor nao altera item finalizado'
);

select throws_ok(
  $$
    delete from public.pedido_itens
    where id = 'b1000000-0000-4000-8000-000000000302'
  $$,
  '42501',
  'permission denied for table pedido_itens',
  'hard delete autenticado e bloqueado antes da RLS'
);

set local request.jwt.claims =
  '{"sub":"b1000000-0000-4000-8000-000000000011","role":"authenticated"}';

delete from public.pedido_comentarios
where id = 'b1000000-0000-4000-8000-000000000401';

reset role;

select is(
  (
    select count(*)::integer
    from public.pedido_comentarios
    where id = 'b1000000-0000-4000-8000-000000000401'
  ),
  1,
  'admin nao apaga comentario de outro tenant'
);

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"b1000000-0000-4000-8000-000000000012","role":"authenticated"}';

delete from public.pedido_comentarios
where id = 'b1000000-0000-4000-8000-000000000401';

reset role;

select is(
  (
    select count(*)::integer
    from public.pedido_comentarios
    where id = 'b1000000-0000-4000-8000-000000000401'
  ),
  0,
  'admin apaga comentario do proprio tenant'
);

select * from finish();
rollback;
