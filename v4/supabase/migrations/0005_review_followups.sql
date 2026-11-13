-- 0005_review_followups.sql
-- Sprint 0 review follow-ups (idempotent; must run after 0004 on every pass):
--   A. idempotency_keys and counters are server-only: no access for authenticated.
--   B. public.my_account_status(): lets a logged-in user learn why they see
--      nothing, without revealing anything about other users.

-- ---------------------------------------------------------------------------
-- A. Server-only technical tables
-- ---------------------------------------------------------------------------
revoke all on table public.idempotency_keys from public, anon, authenticated;
revoke all on table public.counters         from public, anon, authenticated;
drop policy if exists idempotency_keys_select on public.idempotency_keys;
drop policy if exists counters_select         on public.counters;

-- ---------------------------------------------------------------------------
-- B. Account status of the caller (auth.uid() only)
-- ---------------------------------------------------------------------------
create or replace function public.my_account_status()
returns text
language sql stable security definer
set search_path = ''
as $$
  select coalesce((
    select case
             when not p.active then 'INACTIVE'
             when p.unit_id is not null and not u.active then 'UNIT_INACTIVE'
             else 'ACTIVE'
           end
    from public.profiles p
    left join public.units u on u.id = p.unit_id
    where p.user_id = auth.uid()
  ), 'NO_PROFILE')
$$;
comment on function public.my_account_status() is
  'ACTIVE | INACTIVE | UNIT_INACTIVE | NO_PROFILE for the calling user (auth.uid()). authenticated only.';

revoke all on function public.my_account_status() from public, anon, authenticated, service_role;
grant execute on function public.my_account_status() to authenticated;

-- Self-check
do $$
begin
  if has_table_privilege('authenticated', 'public.idempotency_keys', 'SELECT')
     or has_table_privilege('authenticated', 'public.counters', 'SELECT') then
    raise exception 'review self-check: authenticated can still read idempotency_keys/counters';
  end if;
  if has_function_privilege('anon', 'public.my_account_status()', 'EXECUTE') then
    raise exception 'review self-check: anon can execute my_account_status()';
  end if;
end
$$;

insert into public.schema_migrations_log (version, name)
values ('0005', 'review_followups') on conflict (version) do nothing;
