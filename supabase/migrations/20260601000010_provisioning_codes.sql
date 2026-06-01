-- 20260601000010_provisioning_codes.sql — códigos de instalação (uso único, 24h)
create table if not exists public.provisioning_codes (
  id                   uuid primary key default gen_random_uuid(),
  empresa_id           uuid not null references public.empresas(id) on delete cascade,
  code_hash            text not null unique,              -- sha256 do código (nunca o cru)
  expires_at           timestamptz not null,
  used_at              timestamptz,
  used_dispositivo_id  uuid references public.dispositivos(id) on delete set null,
  created_by           uuid references auth.users(id) on delete set null,
  created_at           timestamptz not null default now()
);
create index if not exists provisioning_codes_empresa_idx on public.provisioning_codes(empresa_id);

alter table public.provisioning_codes enable row level security;
-- Leitura/escrita só platform admin (o resgate usa service_role e ignora RLS).
drop policy if exists provisioning_codes_platform on public.provisioning_codes;
create policy provisioning_codes_platform on public.provisioning_codes for all to authenticated
  using (public.is_platform_admin()) with check (public.is_platform_admin());
