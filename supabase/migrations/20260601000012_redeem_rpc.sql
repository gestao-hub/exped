-- 20260601000012_redeem_rpc.sql — resgate atômico + throttle por IP
create table if not exists public.provision_redeem_attempts (
  id  bigserial primary key,
  ip  text not null,
  at  timestamptz not null default now()
);
create index if not exists provision_attempts_ip_at on public.provision_redeem_attempts(ip, at);

-- registra 1 tentativa e devolve quantas houve desse IP nos últimos 10 min
create or replace function public.provision_note_attempt(p_ip text)
returns integer language plpgsql security definer set search_path = public as $$
declare c integer;
begin
  insert into public.provision_redeem_attempts(ip) values (coalesce(p_ip,'unknown'));
  select count(*) into c from public.provision_redeem_attempts
   where ip = coalesce(p_ip,'unknown') and at > now() - interval '10 minutes';
  return c;
end $$;

-- resgate: valida o código (for update), cria o dispositivo, marca usado. Token vem do Node (só o hash).
create or replace function public.redeem_provisioning_code(
  p_code_hash text, p_token_hash text, p_dispositivo_nome text
) returns table(empresa_id uuid, empresa_nome text)
language plpgsql security definer set search_path = public as $$
declare v_code public.provisioning_codes; v_disp uuid; v_nome text;
begin
  select * into v_code from public.provisioning_codes where code_hash = p_code_hash for update;
  if not found then raise exception 'codigo inexistente' using errcode='P0001'; end if;
  if v_code.used_at is not null then raise exception 'codigo ja usado' using errcode='P0002'; end if;
  if v_code.expires_at < now() then raise exception 'codigo expirado' using errcode='P0003'; end if;
  insert into public.dispositivos(empresa_id, nome, token_hash, ativo)
    values (v_code.empresa_id, p_dispositivo_nome, p_token_hash, true) returning id into v_disp;
  update public.provisioning_codes set used_at = now(), used_dispositivo_id = v_disp where id = v_code.id;
  select nome into v_nome from public.empresas where id = v_code.empresa_id;
  return query select v_code.empresa_id, v_nome;
end $$;

revoke all on function public.redeem_provisioning_code(text,text,text) from public, anon, authenticated;
revoke all on function public.provision_note_attempt(text) from public, anon, authenticated;
grant execute on function public.redeem_provisioning_code(text,text,text) to service_role;
grant execute on function public.provision_note_attempt(text) to service_role;
