-- 20260530000016_os_notificacoes.sql — outbox de notificações + dados de manutenção na OS

-- Campos de retenção/manutenção e contato na OS
alter table public.ordens_servico
  add column if not exists cliente_email           text,
  add column if not exists data_proxima_manutencao date,
  add column if not exists proxima_manutencao_obs  text;   -- ex: "Troca de óleo (5.000 km)"

-- Outbox: toda notificação nasce aqui (pendente) e o dispatcher envia quando vence.
create table if not exists public.os_notificacoes (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references public.empresas(id) on delete cascade default public.current_empresa_id(),
  os_id         uuid references public.ordens_servico(id) on delete set null,
  canal         text not null check (canal in ('whatsapp','email')),
  tipo          text not null check (tipo in ('autorizacao','pronto','lembrete_manutencao')),
  destino       text not null,                 -- telefone (whatsapp) ou e-mail
  assunto       text,                          -- usado no e-mail
  corpo         text not null,
  status        text not null default 'pendente' check (status in ('pendente','enviada','falha','cancelada')),
  agendada_para timestamptz not null default now(),
  enviada_em    timestamptz,
  tentativas    int not null default 0,
  erro          text,
  created_at    timestamptz not null default now()
);
create index if not exists os_notificacoes_fila_idx
  on public.os_notificacoes(empresa_id, status, agendada_para);
create index if not exists os_notificacoes_os_idx on public.os_notificacoes(os_id);

alter table public.os_notificacoes enable row level security;
-- Leitura/gestão: admin da empresa (e platform admin). Vendedor não mexe em notificação.
create policy os_notif_admin on public.os_notificacoes for all using (
  public.is_platform_admin() or (empresa_id = public.current_empresa_id() and public.current_user_role() = 'admin'))
  with check (
  public.is_platform_admin() or (empresa_id = public.current_empresa_id() and public.current_user_role() = 'admin'));
