begin;

select plan(24);

select ok(c.relrowsecurity, 'RLS ativo em provision_redeem_attempts')
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'provision_redeem_attempts';

select ok(
  not has_table_privilege('anon', 'public.provision_redeem_attempts', 'select'),
  'anon sem select'
);
select ok(
  not has_table_privilege('authenticated', 'public.provision_redeem_attempts', 'select'),
  'authenticated sem select'
);
select ok(
  not has_table_privilege('anon', 'public.provision_redeem_attempts', 'insert'),
  'anon sem insert'
);
select ok(
  not has_table_privilege('authenticated', 'public.provision_redeem_attempts', 'insert'),
  'authenticated sem insert'
);

select is(
  (
    select count(*)
    from pg_policies
    where schemaname = 'public'
      and tablename = 'provision_redeem_attempts'
  ),
  0::bigint,
  'provision_redeem_attempts sem policies de cliente'
);

select ok(
  not has_function_privilege('anon', 'public.log_pedido_status_change()', 'execute'),
  'trigger log não é RPC anon'
);
select ok(
  not has_function_privilege('authenticated', 'public.log_pedido_status_change()', 'execute'),
  'trigger log não é RPC autenticada'
);
select ok(
  not has_function_privilege('anon', 'public.pedido_reconcilia_cliente()', 'execute'),
  'trigger cliente não é RPC anon'
);
select ok(
  not has_function_privilege('authenticated', 'public.pedido_reconcilia_cliente()', 'execute'),
  'trigger cliente não é RPC autenticada'
);
select ok(
  not has_function_privilege('anon', 'public.prevent_vendedor_qtd_entregue()', 'execute'),
  'trigger entrega não é RPC anon'
);
select ok(
  not has_function_privilege('authenticated', 'public.prevent_vendedor_qtd_entregue()', 'execute'),
  'trigger entrega não é RPC autenticada'
);

select ok(
  has_function_privilege('authenticated', 'public.current_empresa_id()', 'execute'),
  'helper de RLS continua executável'
);
select ok(
  has_function_privilege('authenticated', 'public.current_user_role()', 'execute'),
  'helper de role continua executável'
);
select ok(
  has_function_privilege('authenticated', 'public.is_platform_admin()', 'execute'),
  'helper platform continua executável'
);
select ok(
  has_function_privilege('service_role', 'public.provision_note_attempt(text)', 'execute'),
  'service_role continua executando provision_note_attempt'
);

select ok(
  'search_path=public' = any(coalesce(proconfig, '{}'::text[])),
  'stamp_sync_fields com search_path fixo'
)
from pg_proc
where oid = 'public.stamp_sync_fields()'::regprocedure;

select ok(
  'search_path=public' = any(coalesce(proconfig, '{}'::text[])),
  'historico_kpis com search_path fixo'
)
from pg_proc
where oid = 'public.historico_kpis()'::regprocedure;

select ok(
  'search_path=public' = any(coalesce(proconfig, '{}'::text[])),
  'admin_top_clientes com search_path fixo'
)
from pg_proc
where oid = 'public.admin_top_clientes(integer)'::regprocedure;

select ok(
  'search_path=public' = any(coalesce(proconfig, '{}'::text[])),
  'admin_top_bairros com search_path fixo'
)
from pg_proc
where oid = 'public.admin_top_bairros(integer)'::regprocedure;

select ok(
  'search_path=public' = any(coalesce(proconfig, '{}'::text[])),
  'admin_tempo_medio_horas com search_path fixo'
)
from pg_proc
where oid = 'public.admin_tempo_medio_horas()'::regprocedure;

insert into public.empresas (id, nome, slug)
values
  ('00000000-0000-0000-0000-00000000a001', 'Empresa teste A', 'teste-a-20260714'),
  ('00000000-0000-0000-0000-00000000a002', 'Empresa teste B', 'teste-b-20260714');

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select id,
       '00000000-0000-0000-0000-000000000000'::uuid,
       'authenticated', 'authenticated', email, '', now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       '{}'::jsonb, now(), now()
from (values
  ('00000000-0000-0000-0000-00000000a011'::uuid, 'admin-a@teste.local'),
  ('00000000-0000-0000-0000-00000000a012'::uuid, 'financeiro-a@teste.local'),
  ('00000000-0000-0000-0000-00000000a013'::uuid, 'vendedor-a@teste.local'),
  ('00000000-0000-0000-0000-00000000a014'::uuid, 'outro-vendedor-a@teste.local')
) as users(id, email);

update public.profiles
set empresa_id = '00000000-0000-0000-0000-00000000a001',
    role = case id
      when '00000000-0000-0000-0000-00000000a011' then 'admin'::public.user_role
      when '00000000-0000-0000-0000-00000000a012' then 'financeiro'::public.user_role
      else 'vendedor'::public.user_role
    end
where id in (
  '00000000-0000-0000-0000-00000000a011',
  '00000000-0000-0000-0000-00000000a012',
  '00000000-0000-0000-0000-00000000a013',
  '00000000-0000-0000-0000-00000000a014'
);

insert into public.pedidos
  (id, empresa_id, cliente_nome, data_emissao, vendedor_id, status)
values
  ('00000000-0000-0000-0000-00000000a021', '00000000-0000-0000-0000-00000000a001', 'Próprio', current_date, '00000000-0000-0000-0000-00000000a013', 'finalizado'),
  ('00000000-0000-0000-0000-00000000a022', '00000000-0000-0000-0000-00000000a001', 'Sem vendedor', current_date, null, 'em_separacao'),
  ('00000000-0000-0000-0000-00000000a023', '00000000-0000-0000-0000-00000000a001', 'Outro vendedor', current_date, '00000000-0000-0000-0000-00000000a014', 'pendente'),
  ('00000000-0000-0000-0000-00000000a024', '00000000-0000-0000-0000-00000000a002', 'Outro tenant', current_date, null, 'finalizado');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000a011","role":"authenticated"}';
select is(
  (select count(*) from public.pedidos),
  3::bigint,
  'admin lê todos da própria empresa'
);
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000a012","role":"authenticated"}';
select is(
  (select count(*) from public.pedidos),
  3::bigint,
  'financeiro lê todos da própria empresa'
);
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000a013","role":"authenticated"}';
select is(
  (select count(*) from public.pedidos),
  2::bigint,
  'vendedor lê próprios e sem responsável'
);
reset role;

select * from finish();
rollback;
