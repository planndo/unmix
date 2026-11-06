-- Accounts, subscriptions and monthly song usage for Unmix.
-- Stripe is the source of truth for billing; these tables are written only by the
-- stripe-webhook and create-checkout functions (service role) and claim_song() below.

create table public.customers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at timestamptz not null default now()
);

create table public.subscriptions (
  stripe_subscription_id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null,
  billing_interval text,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_at timestamptz not null default now()
);
create index subscriptions_user_id_idx on public.subscriptions (user_id);

create table public.usage_months (
  user_id uuid not null references auth.users (id) on delete cascade,
  month date not null,
  songs integer not null default 0,
  primary key (user_id, month)
);

-- Row level security: signed-in users can read their own billing state and nothing else.
-- There are deliberately no insert, update or delete policies.
alter table public.customers enable row level security;
alter table public.subscriptions enable row level security;
alter table public.usage_months enable row level security;

create policy "read own subscriptions" on public.subscriptions
  for select to authenticated using (user_id = auth.uid());
create policy "read own usage" on public.usage_months
  for select to authenticated using (user_id = auth.uid());

-- 'past_due' keeps access while Stripe retries the card; Stripe then moves the
-- subscription to 'canceled' or 'unpaid' according to the dashboard's retry settings.
create function public.has_pro(target uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.subscriptions
    where user_id = target and status in ('active', 'trialing', 'past_due')
  );
$$;

-- The free plan's monthly allowance. Keep FREE_SONGS_PER_MONTH in plans.js the same.
create function public.free_song_limit()
returns integer language sql immutable set search_path = '' as $$ select 5 $$;

create function public.get_entitlements()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  this_month date := date_trunc('month', now() at time zone 'utc')::date;
  used integer;
begin
  if uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  select songs into used from public.usage_months where user_id = uid and month = this_month;
  return jsonb_build_object(
    'plan', case when public.has_pro(uid) then 'pro' else 'free' end,
    'used', coalesce(used, 0),
    'limit', public.free_song_limit(),
    'resets_on', (this_month + interval '1 month')::date
  );
end;
$$;

-- Atomically takes one song from this month's allowance. Pro accounts are not metered.
create function public.claim_song()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  this_month date := date_trunc('month', now() at time zone 'utc')::date;
  song_limit integer := public.free_song_limit();
  used integer;
begin
  if uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if public.has_pro(uid) then
    return jsonb_build_object('allowed', true, 'plan', 'pro');
  end if;
  insert into public.usage_months as u (user_id, month, songs)
    values (uid, this_month, 1)
    on conflict (user_id, month) do update set songs = u.songs + 1
    where u.songs < song_limit
    returning u.songs into used;
  if used is null then
    return jsonb_build_object('allowed', false, 'plan', 'free', 'used', song_limit, 'limit', song_limit);
  end if;
  return jsonb_build_object('allowed', true, 'plan', 'free', 'used', used, 'limit', song_limit);
end;
$$;

revoke all on function public.has_pro(uuid) from public, anon, authenticated;
revoke all on function public.free_song_limit() from public, anon;
revoke all on function public.get_entitlements() from public, anon;
revoke all on function public.claim_song() from public, anon;
grant execute on function public.free_song_limit() to authenticated;
grant execute on function public.get_entitlements() to authenticated;
grant execute on function public.claim_song() to authenticated;
