alter table public.provision_redeem_attempts enable row level security;
revoke all on table public.provision_redeem_attempts from public, anon, authenticated;

revoke all on function public.log_pedido_status_change() from public, anon, authenticated;
revoke all on function public.pedido_reconcilia_cliente() from public, anon, authenticated;
revoke all on function public.prevent_vendedor_qtd_entregue() from public, anon, authenticated;

alter function public.stamp_sync_fields() set search_path = public;
alter function public.historico_kpis() set search_path = public;
alter function public.admin_top_clientes(integer) set search_path = public;
alter function public.admin_top_bairros(integer) set search_path = public;
alter function public.admin_tempo_medio_horas() set search_path = public;
