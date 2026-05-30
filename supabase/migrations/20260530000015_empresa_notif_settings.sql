-- 20260530000015_empresa_notif_settings.sql — config de notificação por empresa (multi-tenant)
-- Creds ficam por empresa (cada cliente tem sua instância de WhatsApp). Tudo nullable:
-- o operador pluga na ativação. Sem cred → a notificação é enfileirada mas não enviada.
alter table public.empresas
  add column if not exists notif_whatsapp_ativo boolean not null default false,
  add column if not exists uazapi_url        text,
  add column if not exists uazapi_token      text,
  add column if not exists uazapi_instancia  text,
  add column if not exists notif_email_ativo boolean not null default false,
  add column if not exists email_remetente   text,   -- ex: "Oficina X <oi@oficina.com>"
  add column if not exists manutencao_lembrete_dias int not null default 7; -- antecedência do lembrete
