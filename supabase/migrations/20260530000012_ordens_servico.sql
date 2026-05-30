-- 20260530000012_ordens_servico.sql — módulo Ordem de Serviço (espelho genérico da OS do Hiper)
-- Multi-tenant; serve qualquer nicho (automecânica, assistência, etc.) pois o schema do Hiper é o mesmo.

-- flag por empresa: liga o módulo só pra quem usa OS
alter table public.empresas add column if not exists usa_os boolean not null default false;

-- CABEÇALHO
create table if not exists public.ordens_servico (
  id              uuid primary key default gen_random_uuid(),
  empresa_id      uuid not null references public.empresas(id) on delete restrict default public.current_empresa_id(),
  documento_erp   text,                 -- nº/código da OS no Hiper
  os_erp_id       integer,              -- id_ordem_servico no Hiper
  cliente_id      uuid references public.clientes(id) on delete set null,
  cliente_nome    text not null default '',
  cliente_cnpj_cpf text,
  cliente_telefone text,
  categoria       text,
  situacao_erp    smallint,             -- status cru do Hiper (valores variam por cliente)
  prioridade      smallint,
  data_abertura   timestamptz,
  data_previsao   timestamptz,
  data_conclusao  timestamptz,
  objeto          text,                 -- equipamento/objeto (carro, aparelho...)
  defeito_relatado text,
  diagnostico     text,
  garantia_inicio date,
  garantia_fim    date,
  tecnico_nome    text,
  observacao      text,
  valor_total     numeric not null default 0,
  status          text not null default 'aberta',   -- workflow simples da plataforma
  vendedor_id     uuid references public.profiles(id) on delete set null,
  storage_pdf_path text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists ordens_servico_doc_uniq on public.ordens_servico(empresa_id, documento_erp) where documento_erp is not null;
create index if not exists ordens_servico_empresa_idx on public.ordens_servico(empresa_id);

-- PEÇAS
create table if not exists public.os_itens (
  id uuid primary key default gen_random_uuid(),
  os_id uuid not null references public.ordens_servico(id) on delete cascade,
  codigo text, descricao text not null default '', quantidade numeric not null default 0,
  unidade text, preco_unitario numeric not null default 0, desconto numeric not null default 0,
  total numeric not null default 0, ordem int
);
create index if not exists os_itens_os_idx on public.os_itens(os_id);

-- SERVIÇOS / mão de obra
create table if not exists public.os_servicos (
  id uuid primary key default gen_random_uuid(),
  os_id uuid not null references public.ordens_servico(id) on delete cascade,
  descricao text not null default '', quantidade numeric not null default 0,
  valor_unitario numeric not null default 0, total numeric not null default 0,
  tecnico_nome text, ordem int
);
create index if not exists os_servicos_os_idx on public.os_servicos(os_id);

drop trigger if exists set_ordens_servico_updated_at on public.ordens_servico;
create trigger set_ordens_servico_updated_at before update on public.ordens_servico
  for each row execute function public.set_updated_at();

-- RLS (espelha pedidos): por empresa; vendedor vê os seus, admin/logística da empresa veem todos, platform admin tudo.
alter table public.ordens_servico enable row level security;
alter table public.os_itens enable row level security;
alter table public.os_servicos enable row level security;

create policy os_read on public.ordens_servico for select using (
  public.is_platform_admin() or (empresa_id = public.current_empresa_id()
    and (current_user_role() in ('admin','logistica') or vendedor_id = auth.uid())));
create policy os_admin_all on public.ordens_servico for all using (
  public.is_platform_admin() or (empresa_id = public.current_empresa_id() and current_user_role() = 'admin'))
  with check (public.is_platform_admin() or (empresa_id = public.current_empresa_id() and current_user_role() = 'admin'));

create policy os_itens_via_os on public.os_itens for all using (
  public.is_platform_admin() or exists (select 1 from public.ordens_servico o where o.id = os_id
    and o.empresa_id = public.current_empresa_id()
    and (current_user_role() in ('admin','logistica') or o.vendedor_id = auth.uid())))
  with check (public.is_platform_admin() or exists (select 1 from public.ordens_servico o where o.id = os_id
    and o.empresa_id = public.current_empresa_id()
    and (current_user_role() in ('admin','logistica') or o.vendedor_id = auth.uid())));

create policy os_servicos_via_os on public.os_servicos for all using (
  public.is_platform_admin() or exists (select 1 from public.ordens_servico o where o.id = os_id
    and o.empresa_id = public.current_empresa_id()
    and (current_user_role() in ('admin','logistica') or o.vendedor_id = auth.uid())))
  with check (public.is_platform_admin() or exists (select 1 from public.ordens_servico o where o.id = os_id
    and o.empresa_id = public.current_empresa_id()
    and (current_user_role() in ('admin','logistica') or o.vendedor_id = auth.uid())));
