-- 00-prelude.sql
-- Prelúdio que emula o "ambiente Supabase" num Postgres PURO (nativo, sem Docker),
-- pra que as migrations de supabase/migrations/*.sql apliquem limpo.
--
-- O Supabase, antes das migrations do app, já provê: extensões, roles
-- (anon/authenticated/service_role/authenticator), schema auth com auth.users e
-- as funções helper auth.uid()/auth.role()/auth.jwt(), schema storage com
-- storage.buckets/objects/foldername(), e a publication supabase_realtime.
-- Num Postgres puro nada disso existe — este arquivo recria o mínimo necessário,
-- descoberto investigando o que as migrations realmente usam.
--
-- Idempotente: pode rodar mais de uma vez.

-- ============================================================
-- 1) Extensões usadas pelas migrations (migration 01 e gen_random_uuid)
-- ============================================================
create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "pg_trgm";     -- busca textual
create extension if not exists "unaccent";    -- normaliza acentos

-- ============================================================
-- 2) Roles que o Supabase cria. As policies usam "to authenticated"
--    e grants "to authenticated"/"to anon". O PostgREST loga como
--    'authenticator' e troca de role via SET ROLE.
-- ============================================================
do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticator') then
    create role authenticator login password 'authpass' noinherit;
  end if;
end $$;

grant anon          to authenticator;
grant authenticated to authenticator;
grant service_role  to authenticator;

-- O PostgREST precisa enxergar o schema public e usar as tabelas.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;

-- ============================================================
-- 3) Schema auth + auth.users mínimo + funções helper
-- ============================================================
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

-- auth.users: as migrations referenciam id (FK profiles.id), email,
-- raw_user_meta_data (trigger handle_new_user lê full_name/role dele).
-- Mantemos as colunas que o Supabase real tem e que o app toca.
create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  raw_app_meta_data  jsonb default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- Helpers compatíveis com Supabase: leem os claims do JWT que o PostgREST
-- injeta em request.jwt.claims. Em SQL direto / service_role esses settings
-- não existem → retornam null/anon (e o código trata auth.uid() null como
-- "contexto de servidor confiável").
create or replace function auth.uid() returns uuid
  language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::json->>'sub', '')::uuid
$$;

create or replace function auth.role() returns text
  language sql stable
as $$
  select coalesce(current_setting('request.jwt.claims', true)::json->>'role', 'anon')
$$;

create or replace function auth.jwt() returns jsonb
  language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  )
$$;

-- ============================================================
-- 4) Schema storage + buckets/objects + foldername()
--    (migration 06 insere bucket e cria policies em storage.objects)
-- ============================================================
create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz not null default now()
);

create table if not exists storage.objects (
  id          uuid primary key default gen_random_uuid(),
  bucket_id   text references storage.buckets(id),
  name        text,
  owner       uuid,
  created_at  timestamptz not null default now(),
  metadata    jsonb
);
alter table storage.objects enable row level security;

-- storage.foldername(name) -> text[] dos segmentos de path (igual Supabase)
create or replace function storage.foldername(name text) returns text[]
  language sql immutable
as $$
  select string_to_array(name, '/')
$$;

-- ============================================================
-- 5) Publication supabase_realtime (migration 06 e outras dão ALTER ADD TABLE)
-- ============================================================
do $$ begin
  if not exists (select from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
