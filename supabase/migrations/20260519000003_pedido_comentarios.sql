-- Migration 10: thread de comentários no pedido
-- Comunicação vendedor ↔ logística direto na plataforma
-- (substitui WhatsApp paralelo)

create table if not exists public.pedido_comentarios (
  id         uuid primary key default gen_random_uuid(),
  pedido_id  uuid not null references public.pedidos(id) on delete cascade,
  autor_id   uuid references public.profiles(id) on delete set null,
  texto      text not null,
  created_at timestamptz not null default now()
);

create index if not exists comentarios_pedido_idx
  on public.pedido_comentarios(pedido_id, created_at desc);

-- RLS: qualquer um que tenha acesso ao pedido (via RLS de pedidos)
-- pode ler/comentar. Apaga só o autor ou admin.
alter table public.pedido_comentarios enable row level security;

drop policy if exists comentarios_read on public.pedido_comentarios;
create policy comentarios_read on public.pedido_comentarios
  for select to authenticated
  using (
    exists (
      select 1 from public.pedidos p
      where p.id = pedido_comentarios.pedido_id
    )
  );

drop policy if exists comentarios_insert on public.pedido_comentarios;
create policy comentarios_insert on public.pedido_comentarios
  for insert to authenticated
  with check (
    autor_id = auth.uid()
    and exists (
      select 1 from public.pedidos p
      where p.id = pedido_comentarios.pedido_id
    )
  );

drop policy if exists comentarios_delete on public.pedido_comentarios;
create policy comentarios_delete on public.pedido_comentarios
  for delete to authenticated
  using (autor_id = auth.uid() or current_user_role() = 'admin');

-- Realtime
do $$ begin
  alter publication supabase_realtime add table public.pedido_comentarios;
exception when duplicate_object then null; end $$;
