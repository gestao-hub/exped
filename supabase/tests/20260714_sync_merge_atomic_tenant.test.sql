begin;

select plan(36);

select has_function(
  'public',
  'sync_merge_upsert',
  array['text', 'uuid', 'jsonb'],
  'RPC atomica de merge existe'
);

select is(
  (
    select p.prosecdef
    from pg_catalog.pg_proc p
    where p.oid = to_regprocedure('public.sync_merge_upsert(text,uuid,jsonb)')
  ),
  true,
  'RPC atomica usa SECURITY DEFINER'
);

select is(
  (
    select p.proconfig
    from pg_catalog.pg_proc p
    where p.oid = to_regprocedure('public.sync_merge_upsert(text,uuid,jsonb)')
  ),
  array['search_path=""']::text[],
  'RPC atomica fixa search_path vazio'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.sync_merge_upsert(text,uuid,jsonb)',
    'execute'
  ),
  'anon nao executa merge atomico'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.sync_merge_upsert(text,uuid,jsonb)',
    'execute'
  ),
  'authenticated nao executa merge atomico'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.sync_merge_upsert(text,uuid,jsonb)',
    'execute'
  ),
  'service_role executa merge atomico'
);

select has_function(
  'public',
  'sync_push_upsert',
  array['text', 'jsonb'],
  'RPC legada permanece para compatibilidade de rollout'
);

set local exped.sync = 'on';

insert into public.empresas (id, nome, slug)
values
  ('91000000-0000-0000-0000-000000000001', 'Sync atomic A', 'sync-atomic-a'),
  ('91000000-0000-0000-0000-000000000002', 'Sync atomic B', 'sync-atomic-b');

insert into public.clientes (
  id, empresa_id, nome, endereco_padrao, telefone_padrao,
  updated_at, field_updated_at
)
values
  (
    '91000000-0000-0000-0000-000000000011',
    '91000000-0000-0000-0000-000000000001',
    'Cliente A',
    'Rua antiga',
    '1111',
    '2026-07-14T10:00:00Z',
    '{"endereco_padrao":"2026-07-14T10:00:00Z","telefone_padrao":"2026-07-14T10:00:00Z"}'
  ),
  (
    '91000000-0000-0000-0000-000000000012',
    '91000000-0000-0000-0000-000000000002',
    'Cliente B',
    'Rua B',
    '9999',
    '2026-07-14T10:00:00Z',
    '{"nome":"2026-07-14T10:00:00Z"}'
  );

select is(
  public.sync_merge_upsert(
    'clientes',
    '91000000-0000-0000-0000-000000000001',
    '{
      "id":"91000000-0000-0000-0000-000000000011",
      "empresa_id":"91000000-0000-0000-0000-000000000002",
      "endereco_padrao":"Rua nova",
      "telefone_padrao":"1111",
      "field_updated_at":{
        "endereco_padrao":"2026-07-14T11:00:00Z",
        "telefone_padrao":"2026-07-14T10:00:00Z"
      }
    }'::jsonb
  ) ->> 'endereco_padrao',
  'Rua nova',
  'primeiro push aplica campo mais novo'
);

select is(
  public.sync_merge_upsert(
    'clientes',
    '91000000-0000-0000-0000-000000000001',
    '{
      "id":"91000000-0000-0000-0000-000000000011",
      "endereco_padrao":"Rua antiga",
      "telefone_padrao":"2222",
      "field_updated_at":{
        "endereco_padrao":"2026-07-14T10:00:00Z",
        "telefone_padrao":"2026-07-14T12:00:00Z"
      }
    }'::jsonb
  ) ->> 'endereco_padrao',
  'Rua nova',
  'segundo push stale nao desfaz campo do primeiro'
);

select is(
  (select telefone_padrao from public.clientes
   where id = '91000000-0000-0000-0000-000000000011'),
  '2222',
  'segundo push preserva ambos os campos concorrentes'
);

select is(
  (select empresa_id from public.clientes
   where id = '91000000-0000-0000-0000-000000000011'),
  '91000000-0000-0000-0000-000000000001'::uuid,
  'tenant autenticado sobrescreve empresa_id do payload'
);

insert into public.clientes (
  id, empresa_id, nome, cnpj_cpf, updated_at, field_updated_at
)
values (
  '91000000-0000-0000-0000-000000000017',
  '91000000-0000-0000-0000-000000000001',
  'Cliente canonico antigo',
  '12.345.678/0001-90',
  '2026-07-14T10:00:00Z',
  '{"nome":"2026-07-14T10:00:00Z","cnpj_cpf":"2026-07-14T10:00:00Z"}'
);

select is(
  public.sync_merge_upsert(
    'clientes',
    '91000000-0000-0000-0000-000000000001',
    '{
      "id":"91000000-0000-0000-0000-000000000018",
      "nome":"Cliente canonico atualizado",
      "cnpj_cpf":"12345678000190",
      "field_updated_at":{
        "nome":"2026-07-14T11:00:00Z",
        "cnpj_cpf":"2026-07-14T11:00:00Z"
      }
    }'::jsonb
  ) ->> 'id',
  '91000000-0000-0000-0000-000000000017',
  'reconciliacao por CNPJ devolve a PK canonica'
);

select is(
  (select nome from public.clientes
   where id = '91000000-0000-0000-0000-000000000017'),
  'Cliente canonico atualizado',
  'reconciliacao por CNPJ tambem incorpora os campos mais novos'
);

select is(
  public.sync_merge_upsert(
    'clientes',
    '91000000-0000-0000-0000-000000000001',
    '{
      "id":"91000000-0000-0000-0000-000000000012",
      "nome":"Takeover",
      "field_updated_at":{"nome":"2026-07-14T13:00:00Z"}
    }'::jsonb
  ),
  null::jsonb,
  'PK direta de outro tenant e recusada dentro da transacao'
);

select is(
  (select nome from public.clientes
   where id = '91000000-0000-0000-0000-000000000012'),
  'Cliente B',
  'colisao direta deixa linha do outro tenant intacta'
);

insert into public.clientes (
  id, empresa_id, nome, updated_at, field_updated_at
)
values (
  '91000000-0000-0000-0000-000000000013',
  '91000000-0000-0000-0000-000000000001',
  'Antes do fuso',
  '2026-07-14T12:00:00Z',
  '{"nome":"2026-07-14T12:00:00Z"}'
);

select is(
  public.sync_merge_upsert(
    'clientes',
    '91000000-0000-0000-0000-000000000001',
    '{
      "id":"91000000-0000-0000-0000-000000000013",
      "nome":"Depois do fuso",
      "field_updated_at":{"nome":"2026-07-14T10:00:00-03:00"}
    }'::jsonb
  ) ->> 'nome',
  'Depois do fuso',
  'merge compara o instante timestamptz e nao a representacao textual'
);

update public.clientes
set nome = 'Antes do empate',
    updated_at = '2020-01-01T00:00:00Z',
    field_updated_at = '{"nome":"2020-01-01T00:00:00Z","empresa_id":"2020-01-01T00:00:00Z"}'::jsonb
where id = '91000000-0000-0000-0000-000000000013';

select ok(
  (
    public.sync_merge_upsert(
      'clientes',
      '91000000-0000-0000-0000-000000000001',
      '{
        "id":"91000000-0000-0000-0000-000000000013",
        "nome":"Depois do empate",
        "field_updated_at":{
          "nome":"2020-01-01T00:00:00Z",
          "empresa_id":"2020-01-01T00:00:00Z"
        }
      }'::jsonb
    ) ->> 'updated_at'
  )::timestamptz > '2020-01-01T00:00:00Z'::timestamptz,
  'empate com valor diferente avanca o cursor para o pull enxergar a mudanca'
);

select ok(
  (
    public.sync_merge_upsert(
      'clientes',
      '91000000-0000-0000-0000-000000000001',
      '{
        "id":"91000000-0000-0000-0000-000000000013",
        "nome":"Chave desconhecida ignorada",
        "field_updated_at":{
          "nome":"2026-07-14T13:01:00Z",
          "campo_que_nao_existe":"2099-01-01T00:00:00Z"
        }
      }'::jsonb
    ) ->> 'updated_at'
  )::timestamptz <= statement_timestamp(),
  'chave inexistente nao empurra updated_at para o futuro'
);

select ok(
  (
    public.sync_merge_upsert(
      'clientes',
      '91000000-0000-0000-0000-000000000001',
      '{
        "id":"91000000-0000-0000-0000-000000000014",
        "nome":"Timestamp numerico",
        "created_at":"2026-07-14T13:00:00Z",
        "updated_at":"2026-07-14T13:00:00Z",
        "field_updated_at":{"nome":12345}
      }'::jsonb
    ) ->> 'updated_at'
  )::timestamptz > '2026-01-01T00:00:00Z'::timestamptz,
  'timestamp nao textual recebe carimbo seguro em vez de 1970'
);

select lives_ok(
  $$
    select public.sync_merge_upsert(
      'clientes',
      '91000000-0000-0000-0000-000000000001',
      '{
        "id":"91000000-0000-0000-0000-000000000015",
        "nome":"Timestamp malformado",
        "created_at":"2026-07-14T13:00:00Z",
        "updated_at":"2026-07-14T13:00:00Z",
        "field_updated_at":{"nome":"nao-e-data"}
      }'::jsonb
    )
  $$,
  'timestamp malformado nao derruba o lote'
);

select ok(
  (
    public.sync_merge_upsert(
      'clientes',
      '91000000-0000-0000-0000-000000000001',
      '{
        "id":"91000000-0000-0000-0000-000000000016",
        "nome":"Relogio futuro",
        "created_at":"2026-07-14T13:00:00Z",
        "updated_at":"2026-07-14T13:00:00Z",
        "field_updated_at":{"nome":"2099-01-01T00:00:00Z"}
      }'::jsonb
    ) ->> 'updated_at'
  )::timestamptz <= statement_timestamp(),
  'relogio futuro e limitado ao horario confiavel do servidor'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values (
  '91000000-0000-0000-0000-000000000071',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'sync-b@example.test', '',
  '{}'::jsonb, '{}'::jsonb, now(), now()
);
update public.profiles
set empresa_id = '91000000-0000-0000-0000-000000000002'
where id = '91000000-0000-0000-0000-000000000071';

insert into public.pedidos (id, empresa_id, cliente_nome)
values
  ('91000000-0000-0000-0000-000000000021', '91000000-0000-0000-0000-000000000001', 'Pedido A'),
  ('91000000-0000-0000-0000-000000000022', '91000000-0000-0000-0000-000000000002', 'Pedido B'),
  ('91000000-0000-0000-0000-000000000023', '91000000-0000-0000-0000-000000000001', 'Referencia cruzada'),
  ('91000000-0000-0000-0000-000000000024', '91000000-0000-0000-0000-000000000001', 'Vendedor cruzado');

select is(
  public.sync_merge_upsert(
    'pedidos',
    '91000000-0000-0000-0000-000000000001',
    '{
      "id":"91000000-0000-0000-0000-000000000023",
      "cliente_id":"91000000-0000-0000-0000-000000000012",
      "field_updated_at":{"cliente_id":"2026-07-14T13:00:00Z"}
    }'::jsonb
  ),
  null::jsonb,
  'pedido nao referencia cliente de outro tenant'
);

select is(
  public.sync_merge_upsert(
    'pedidos',
    '91000000-0000-0000-0000-000000000001',
    '{
      "id":"91000000-0000-0000-0000-000000000024",
      "vendedor_id":"91000000-0000-0000-0000-000000000071",
      "field_updated_at":{"vendedor_id":"2026-07-14T13:00:00Z"}
    }'::jsonb
  ),
  null::jsonb,
  'pedido nao referencia vendedor de outro tenant'
);

update public.pedidos
set cliente_id = '91000000-0000-0000-0000-000000000011',
    updated_at = '2026-07-14T12:00:00Z',
    field_updated_at = '{"cliente_id":"2026-07-14T12:00:00Z"}'::jsonb
where id = '91000000-0000-0000-0000-000000000021';

select is(
  public.sync_merge_upsert(
    'pedidos',
    '91000000-0000-0000-0000-000000000001',
    '{
      "id":"91000000-0000-0000-0000-000000000021",
      "cliente_id":"91000000-0000-0000-0000-000000000012",
      "field_updated_at":{"cliente_id":"2026-07-14T11:00:00Z"}
    }'::jsonb
  ) ->> 'cliente_id',
  '91000000-0000-0000-0000-000000000011',
  'referencia cross-tenant stale e ignorada sem bloquear a linha valida'
);

insert into public.pedido_pontos_retirada (id, pedido_id, tipo, empresa_nome)
values
  ('91000000-0000-0000-0000-000000000031', '91000000-0000-0000-0000-000000000021', 'loja', 'Ponto A'),
  ('91000000-0000-0000-0000-000000000032', '91000000-0000-0000-0000-000000000022', 'loja', 'Ponto B');

select is(
  public.sync_merge_upsert(
    'pedido_pontos_retirada',
    '91000000-0000-0000-0000-000000000001',
    '{
      "id":"91000000-0000-0000-0000-000000000032",
      "pedido_id":"91000000-0000-0000-0000-000000000021",
      "tipo":"entrega",
      "field_updated_at":{"pedido_id":"2026-07-14T13:00:00Z"}
    }'::jsonb
  ),
  null::jsonb,
  'ponto existente nao pode ser reatribuido cross-tenant'
);

select is(
  (select pedido_id from public.pedido_pontos_retirada
   where id = '91000000-0000-0000-0000-000000000032'),
  '91000000-0000-0000-0000-000000000022'::uuid,
  'ponto do outro tenant permanece no pai original'
);

select is(
  public.sync_merge_upsert(
    'pedido_pontos_retirada',
    '91000000-0000-0000-0000-000000000001',
    '{
      "id":"91000000-0000-0000-0000-000000000033",
      "pedido_id":"91000000-0000-0000-0000-000000000021",
      "tipo":"entrega",
      "empresa_nome":"Ponto novo A",
      "endereco":null,
      "ordem":0,
      "created_at":"2026-07-14T13:00:00Z",
      "updated_at":"2026-07-14T13:00:00Z",
      "field_updated_at":{"tipo":"2026-07-14T13:00:00Z"},
      "deleted_at":null
    }'::jsonb
  ) ->> 'pedido_id',
  '91000000-0000-0000-0000-000000000021',
  'ponto novo com pai do tenant e aceito'
);

insert into public.pedido_itens (id, ponto_retirada_id, descricao)
values (
  '91000000-0000-0000-0000-000000000041',
  '91000000-0000-0000-0000-000000000032',
  'Item B'
);

select is(
  public.sync_merge_upsert(
    'pedido_itens',
    '91000000-0000-0000-0000-000000000001',
    '{
      "id":"91000000-0000-0000-0000-000000000041",
      "ponto_retirada_id":"91000000-0000-0000-0000-000000000031",
      "descricao":"Takeover item",
      "field_updated_at":{"ponto_retirada_id":"2026-07-14T13:00:00Z"}
    }'::jsonb
  ),
  null::jsonb,
  'item existente nao pode ser reatribuido cross-tenant'
);

select is(
  (select ponto_retirada_id from public.pedido_itens
   where id = '91000000-0000-0000-0000-000000000041'),
  '91000000-0000-0000-0000-000000000032'::uuid,
  'item do outro tenant permanece no ponto original'
);

insert into public.ordens_servico (id, empresa_id, cliente_nome)
values
  ('91000000-0000-0000-0000-000000000051', '91000000-0000-0000-0000-000000000001', 'OS A'),
  ('91000000-0000-0000-0000-000000000052', '91000000-0000-0000-0000-000000000002', 'OS B'),
  ('91000000-0000-0000-0000-000000000053', '91000000-0000-0000-0000-000000000001', 'OS cruzada');

select is(
  public.sync_merge_upsert(
    'ordens_servico',
    '91000000-0000-0000-0000-000000000001',
    '{
      "id":"91000000-0000-0000-0000-000000000053",
      "cliente_id":"91000000-0000-0000-0000-000000000012",
      "field_updated_at":{"cliente_id":"2026-07-14T13:00:00Z"}
    }'::jsonb
  ),
  null::jsonb,
  'OS nao referencia cliente de outro tenant'
);

insert into public.os_notificacoes (
  id, empresa_id, os_id, canal, tipo, destino, corpo
)
values (
  '91000000-0000-0000-0000-000000000054',
  '91000000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000051',
  'email', 'pronto', 'sync@example.test', 'tenant A'
);

select is(
  public.sync_merge_upsert(
    'os_notificacoes',
    '91000000-0000-0000-0000-000000000001',
    '{
      "id":"91000000-0000-0000-0000-000000000054",
      "os_id":"91000000-0000-0000-0000-000000000052",
      "field_updated_at":{"os_id":"2026-07-14T13:00:00Z"}
    }'::jsonb
  ),
  null::jsonb,
  'notificacao nao referencia OS de outro tenant'
);

insert into public.os_itens (id, os_id, descricao)
values ('91000000-0000-0000-0000-000000000061', '91000000-0000-0000-0000-000000000052', 'Peca B');

select is(
  public.sync_merge_upsert(
    'os_itens',
    '91000000-0000-0000-0000-000000000001',
    '{
      "id":"91000000-0000-0000-0000-000000000061",
      "os_id":"91000000-0000-0000-0000-000000000051",
      "descricao":"Takeover peca",
      "field_updated_at":{"os_id":"2026-07-14T13:00:00Z"}
    }'::jsonb
  ),
  null::jsonb,
  'peca de OS existente nao pode ser reatribuida cross-tenant'
);

select is(
  (select os_id from public.os_itens
   where id = '91000000-0000-0000-0000-000000000061'),
  '91000000-0000-0000-0000-000000000052'::uuid,
  'peca do outro tenant permanece na OS original'
);

insert into public.os_servicos (id, os_id, descricao)
values ('91000000-0000-0000-0000-000000000062', '91000000-0000-0000-0000-000000000052', 'Servico B');

select is(
  public.sync_merge_upsert(
    'os_servicos',
    '91000000-0000-0000-0000-000000000001',
    '{
      "id":"91000000-0000-0000-0000-000000000062",
      "os_id":"91000000-0000-0000-0000-000000000051",
      "descricao":"Takeover servico",
      "field_updated_at":{"os_id":"2026-07-14T13:00:00Z"}
    }'::jsonb
  ),
  null::jsonb,
  'servico de OS existente nao pode ser reatribuido cross-tenant'
);

select is(
  (select os_id from public.os_servicos
   where id = '91000000-0000-0000-0000-000000000062'),
  '91000000-0000-0000-0000-000000000052'::uuid,
  'servico do outro tenant permanece na OS original'
);

select throws_ok(
  $$
    select public.sync_merge_upsert(
      'auth.users',
      '91000000-0000-0000-0000-000000000001',
      '{"id":"91000000-0000-0000-0000-000000000099"}'::jsonb
    )
  $$,
  'P0001',
  'sync_merge_upsert: tabela nao permitida auth.users',
  'RPC rejeita tabela fora da allowlist'
);

select * from finish();
rollback;
