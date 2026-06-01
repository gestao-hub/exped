-- 20260601000013_provision_attempts_purge.sql — purga oportunista do throttle
-- (review: provision_redeem_attempts crescia sem limite). create or replace só da função.
create or replace function public.provision_note_attempt(p_ip text)
returns integer language plpgsql security definer set search_path = public as $$
declare c integer;
begin
  -- limpa tentativas com mais de 1h a cada chamada (evita crescimento sem fim)
  delete from public.provision_redeem_attempts where at < now() - interval '1 hour';
  insert into public.provision_redeem_attempts(ip) values (coalesce(p_ip,'unknown'));
  select count(*) into c from public.provision_redeem_attempts
   where ip = coalesce(p_ip,'unknown') and at > now() - interval '10 minutes';
  return c;
end $$;
