-- 20260530000001_empresas.sql — tenants + white-label
create table if not exists public.empresas (
  id            uuid primary key default gen_random_uuid(),
  nome          text not null,
  slug          text not null unique,
  logo_url      text,
  cor_primaria  text default '#F25C05',           -- default = laranja Franzoni atual
  ativo         boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

drop trigger if exists set_empresas_updated_at on public.empresas;
create trigger set_empresas_updated_at
  before update on public.empresas
  for each row execute function public.set_updated_at();

-- Seed: Franzoni é a empresa #1. UUID fixo pra facilitar os backfills seguintes.
insert into public.empresas (id, nome, slug, cor_primaria)
values ('00000000-0000-0000-0000-0000000f0001', 'Franzoni Casa & Construção', 'franzoni', '#F25C05')
on conflict (id) do nothing;

alter table public.empresas enable row level security;
-- RLS definida na migration 05 (precisa dos helpers da migration 02 primeiro).
