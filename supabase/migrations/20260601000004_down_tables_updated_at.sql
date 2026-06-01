-- 20260601000004_down_tables_updated_at.sql — updated_at nas tabelas "só-descem" do sync
-- O pull do sincronizador filtra por updated_at > cursor em TODAS as SYNC_TABLES (inclusive as
-- "down": empresas/profiles/hiper_vendedor_map/dispositivos). empresas e profiles já tinham
-- updated_at; faltava em hiper_vendedor_map e dispositivos. Aditivo: add column + trigger
-- set_updated_at (que já respeita o GUC exped.sync, igual às demais). Linhas existentes ganham
-- now() no default → entram no 1º cold start. Não precisam de field_updated_at/deleted_at (são
-- read-only no hub: sem merge, sem soft-delete).
alter table public.hiper_vendedor_map add column if not exists updated_at timestamptz not null default now();
alter table public.dispositivos      add column if not exists updated_at timestamptz not null default now();

drop trigger if exists set_hiper_vendedor_map_updated_at on public.hiper_vendedor_map;
create trigger set_hiper_vendedor_map_updated_at before update on public.hiper_vendedor_map
  for each row execute function public.set_updated_at();

drop trigger if exists set_dispositivos_updated_at on public.dispositivos;
create trigger set_dispositivos_updated_at before update on public.dispositivos
  for each row execute function public.set_updated_at();
