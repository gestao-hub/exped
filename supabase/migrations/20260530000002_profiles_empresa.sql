-- 20260530000002_profiles_empresa.sql
alter table public.profiles
  add column if not exists empresa_id uuid references public.empresas(id) on delete restrict,
  add column if not exists is_platform_admin boolean not null default false;

-- Backfill: todos os profiles atuais são da Franzoni
update public.profiles
  set empresa_id = '00000000-0000-0000-0000-0000000f0001'
  where empresa_id is null;

create index if not exists profiles_empresa_idx on public.profiles(empresa_id);

-- Helpers (security definer, search_path fixo)
create or replace function public.current_empresa_id()
returns uuid language sql stable security definer set search_path = public as $$
  select empresa_id from public.profiles where id = auth.uid()
$$;

create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_platform_admin from public.profiles where id = auth.uid()), false)
$$;

-- SEGURANÇA: NUNCA confiar em raw_user_meta_data (controlado pelo cliente no signup)
-- para role/empresa_id — senão um signup público poderia se autodeclarar admin de
-- qualquer empresa (bypass de tenant). Usuário novo nasce SEM empresa (empresa_id=NULL
-- → RLS nega tudo, fail-closed) e como 'vendedor'. A atribuição de empresa/role é feita
-- depois por um fluxo de SERVIDOR confiável (onboarding via service_role).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, role, empresa_id)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    'vendedor',
    null
  )
  on conflict (id) do nothing;
  return new;
end $$;
