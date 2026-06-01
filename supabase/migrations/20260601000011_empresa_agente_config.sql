-- 20260601000011_empresa_agente_config.sql — config do agente por empresa (sincroniza pro hub)
alter table public.empresas
  add column if not exists agente_situacoes_venda text    not null default '2,5,7',
  add column if not exists agente_sync_os         boolean not null default false,
  add column if not exists agente_situacoes_os    text    not null default '',
  add column if not exists agente_poll_segundos   integer not null default 30;
