-- Migration 08: tabela clientes (cadastro recorrente) + cliente_id em pedidos
--
-- Estratégia: pedido continua com cliente_* denormalizado (snapshot do
-- momento da venda — endereço pode ter sido diferente). cliente_id é
-- opcional e aponta pro cadastro central; é populado automaticamente
-- no upload do PDF via upsert por CNPJ/CPF.

create table if not exists public.clientes (
  id              uuid primary key default gen_random_uuid(),
  cnpj_cpf        text,                    -- chave natural (não obrigatório)
  codigo_erp      text,                    -- código do cliente no ERP origem
  nome            text not null,
  endereco_padrao text,
  bairro_padrao   text,
  cidade_padrao   text,
  uf_padrao       text,
  cep_padrao      text,
  telefone_padrao text,
  observacoes     text,                    -- "cliente VIP", instruções especiais
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Único parcial: CNPJ/CPF é único quando preenchido
create unique index if not exists clientes_cnpj_cpf_uniq
  on public.clientes (cnpj_cpf) where cnpj_cpf is not null;

-- Busca por nome ou CNPJ (autocomplete)
create index if not exists clientes_nome_trgm
  on public.clientes using gin (nome gin_trgm_ops);

create index if not exists clientes_codigo_erp_idx on public.clientes(codigo_erp);

-- FK opcional no pedido
alter table public.pedidos
  add column if not exists cliente_id uuid references public.clientes(id) on delete set null;

create index if not exists pedidos_cliente_id_idx on public.pedidos(cliente_id);

-- updated_at trigger (reutiliza função existente)
drop trigger if exists set_clientes_updated_at on public.clientes;
create trigger set_clientes_updated_at
  before update on public.clientes
  for each row execute function public.set_updated_at();

-- RLS
alter table public.clientes enable row level security;

-- Qualquer autenticado lê (necessário pro autocomplete)
drop policy if exists clientes_read on public.clientes;
create policy clientes_read on public.clientes
  for select to authenticated using (true);

-- Qualquer autenticado pode criar (upload do PDF cria automaticamente)
drop policy if exists clientes_insert on public.clientes;
create policy clientes_insert on public.clientes
  for insert to authenticated with check (true);

-- Só admin pode editar
drop policy if exists clientes_admin_update on public.clientes;
create policy clientes_admin_update on public.clientes
  for update to authenticated
  using (current_user_role() = 'admin')
  with check (current_user_role() = 'admin');

-- Só admin pode deletar
drop policy if exists clientes_admin_delete on public.clientes;
create policy clientes_admin_delete on public.clientes
  for delete to authenticated
  using (current_user_role() = 'admin');

-- Realtime
do $$ begin
  alter publication supabase_realtime add table public.clientes;
exception when duplicate_object then null; end $$;
