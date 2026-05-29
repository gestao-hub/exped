-- 20260530000007_dispositivos.sql — agentes Hiper por empresa
create table if not exists public.dispositivos (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references public.empresas(id) on delete cascade,
  nome          text not null,                 -- ex.: "PDV Loja Centro"
  token_hash    text not null unique,          -- hash do token (nunca o token cru)
  ativo         boolean not null default true,
  last_seen_at  timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists dispositivos_empresa_idx on public.dispositivos(empresa_id);

alter table public.dispositivos enable row level security;
-- Admin da empresa lê os seus; platform admin tudo. Escrita: platform admin.
-- O endpoint de ingestão usa service_role e ignora RLS.
drop policy if exists dispositivos_read on public.dispositivos;
create policy dispositivos_read on public.dispositivos for select to authenticated using (
  public.is_platform_admin()
  or (empresa_id = public.current_empresa_id() and public.current_user_role() = 'admin')
);
drop policy if exists dispositivos_platform_write on public.dispositivos;
create policy dispositivos_platform_write on public.dispositivos for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());
