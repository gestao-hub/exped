-- 20260530000017_empresa_os_gatilhos.sql — mapeamento de situação da OS → gatilho de notificação
-- O valor de `situacao` da OS varia por cliente no Hiper. O operador informa qual situação
-- significa "fechada/precisa autorizar" e qual significa "pronta para retirar". Nulo = gatilho
-- desligado (a notificação simplesmente não é enfileirada).
alter table public.empresas
  add column if not exists os_situacao_autorizacao smallint,
  add column if not exists os_situacao_pronto      smallint;
