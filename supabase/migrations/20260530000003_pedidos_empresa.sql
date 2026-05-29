-- 20260530000003_pedidos_empresa.sql
alter table public.pedidos
  add column if not exists empresa_id uuid references public.empresas(id) on delete restrict;

update public.pedidos
  set empresa_id = '00000000-0000-0000-0000-0000000f0001'
  where empresa_id is null;

alter table public.pedidos alter column empresa_id set not null;
create index if not exists pedidos_empresa_idx on public.pedidos(empresa_id);

-- documento único POR EMPRESA (antes era global). Cobre os dois casos: constraint ou índice.
alter table public.pedidos drop constraint if exists pedidos_documento_erp_uniq;
drop index if exists public.pedidos_documento_erp_uniq;
-- Preserva a semântica original (reaproveitar documento se o anterior foi cancelado),
-- agora escopo POR EMPRESA.
create unique index pedidos_documento_erp_uniq
  on public.pedidos (empresa_id, documento_erp)
  where documento_erp is not null and status <> 'cancelado';
