-- Updated telegram_accounts table with groups_count field and username
create table if not exists telegram_accounts (
  phone text primary key,
  username text,
  groups_count integer not null default 0,
  groups_created_24h integer not null default 0,
  next_available_time timestamptz,
  flood_wait_until timestamptz,
  session_string text
);

-- Enable RLS
alter table telegram_accounts enable row level security;

-- Grant permissions to service_role (needed for Supabase access)
grant all privileges on table telegram_accounts to service_role;
grant all privileges on all sequences in schema public to service_role;

-- Function to increment groups count for an account
create or replace function increment_groups_count(phone_number text, increment_amount integer)
returns void
language plpgsql
as $$
begin
  update telegram_accounts 
  set groups_count = groups_count + increment_amount,
      groups_created_24h = groups_created_24h + increment_amount
  where phone = phone_number;
end;
$$;

-- Drop existing functions first
DROP FUNCTION IF EXISTS update_rate_limit_status(text, integer);
DROP FUNCTION IF EXISTS check_rate_limit(text);

-- Function to update rate limit status.
-- next_available_time marks when the rolling 24h window RESETS (not a block).
-- Start the window on the first creation and leave it running for subsequent
-- batches — only check_rate_limit clears it once the window has elapsed.
create or replace function update_rate_limit_status(
  account_phone text,
  groups_created integer default 1
) returns void as $$
begin
  update telegram_accounts
  set
    next_available_time = coalesce(next_available_time, now() + interval '24 hours')
  where phone = account_phone;
end;
$$ language plpgsql;

-- Function to check and update rate limit.
-- Two independent block sources:
--   1. flood_wait_until  — a real Telegram flood wait; blocks until it passes
--                          (can trigger before the 50/24h cap is reached).
--   2. groups_created_24h >= 50 — the app's 50-per-rolling-24h cap.
-- next_available_time is only the window-reset marker and never blocks on its own.
create or replace function check_rate_limit(
  account_phone text
) returns json as $$
declare
  account telegram_accounts;
  current_ts timestamptz;
  wait_seconds integer;
  result json;
begin
  select * into account from telegram_accounts where phone = account_phone;

  if account is null then
    return json_build_object('error', 'Account not found');
  end if;

  current_ts := now();

  -- 1. Active Telegram flood wait — hard block until it expires.
  if account.flood_wait_until is not null and current_ts < account.flood_wait_until then
    wait_seconds := extract(epoch from (account.flood_wait_until - current_ts))::integer;
    return json_build_object(
      'can_create', false,
      'wait_seconds', wait_seconds,
      'groups_created_24h', account.groups_created_24h,
      'total_groups', account.groups_count,
      'error', 'Account is in a Telegram flood wait.'
    );
  end if;

  -- Flood wait has passed — clear the stale marker.
  if account.flood_wait_until is not null and current_ts >= account.flood_wait_until then
    update telegram_accounts
    set flood_wait_until = null
    where phone = account_phone;
    account.flood_wait_until := null;
  end if;

  -- 2. Rolling 24h window elapsed — reset the daily counter.
  if account.next_available_time is not null and current_ts >= account.next_available_time then
    update telegram_accounts
    set
      groups_created_24h = 0,
      next_available_time = null
    where phone = account_phone;
    account.groups_created_24h := 0;
    account.next_available_time := null;
  end if;

  -- 3. Hit the 50-per-24h cap — blocked until the window resets.
  if account.groups_created_24h >= 50 then
    wait_seconds := coalesce(
      extract(epoch from (account.next_available_time - current_ts))::integer,
      0
    );
    return json_build_object(
      'can_create', false,
      'wait_seconds', wait_seconds,
      'groups_created_24h', account.groups_created_24h,
      'total_groups', account.groups_count,
      'error', 'Rate limit exceeded. Maximum 50 groups per 24 hours.'
    );
  end if;

  -- Otherwise the account is free to create.
  return json_build_object(
    'can_create', true,
    'wait_seconds', 0,
    'groups_created_24h', account.groups_created_24h,
    'total_groups', account.groups_count
  );
end;
$$ language plpgsql;

-- Add columns if they don't exist (safe to run multiple times)
do $$
begin
  if not exists (
    select 1 from information_schema.columns 
    where table_name = 'telegram_accounts' 
    and column_name = 'groups_created_24h'
  ) then
    alter table telegram_accounts add column groups_created_24h integer not null default 0;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_name = 'telegram_accounts'
    and column_name = 'next_available_time'
  ) then
    alter table telegram_accounts add column next_available_time timestamptz;
  end if;

  -- Real Telegram flood-wait deadline, kept separate from the 24h window marker
  -- so a flood wait can block the account before the 50/24h cap is reached.
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'telegram_accounts'
    and column_name = 'flood_wait_until'
  ) then
    alter table telegram_accounts add column flood_wait_until timestamptz;
  end if;
end $$;

-- Add migration for first_creation_time if it exists
do $$ 
begin
  if exists (
    select 1 from information_schema.columns 
    where table_name = 'telegram_accounts' 
    and column_name = 'first_creation_time'
  ) then
    alter table telegram_accounts drop column first_creation_time;
  end if;
end $$;

-- Add migration for last_active if it exists
do $$ 
begin
  if exists (
    select 1 from information_schema.columns 
    where table_name = 'telegram_accounts' 
    and column_name = 'last_active'
  ) then
    alter table telegram_accounts drop column last_active;
  end if;
end $$;

 -- Create RLS policy to allow all operations on telegram_accounts table
CREATE POLICY "Allow full access to telegram_accounts" 
ON telegram_accounts
FOR ALL
USING (true)
WITH CHECK (true);

-- Alternatively, you can disable RLS if you don't need it
-- ALTER TABLE telegram_accounts DISABLE ROW LEVEL SECURITY;

-- Create group creation queue table
create table if not exists group_creation_queue (
  id serial primary key,
  phone text not null references telegram_accounts(phone),
  group_count integer not null,
  naming_pattern text not null,
  description text,
  messages jsonb,
  type text not null default 'group',
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_message text
);

-- Add type column to group_creation_queue if it doesn't exist (safe to re-run).
-- 'group' = megagroup/supergroup, 'channel' = broadcast channel.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'group_creation_queue'
    and column_name = 'type'
  ) then
    alter table group_creation_queue add column type text not null default 'group';
  end if;
end $$;

-- Enable RLS for queue table
alter table group_creation_queue enable row level security;

-- Grant permissions to service_role
grant all privileges on table group_creation_queue to service_role;
grant all privileges on sequence group_creation_queue_id_seq to service_role;

-- Create RLS policy for queue table
CREATE POLICY "Allow full access to group_creation_queue" 
ON group_creation_queue
FOR ALL
USING (true)
WITH CHECK (true);

-- Create RLS policy for telegram_accounts
CREATE POLICY "Allow full access to telegram_accounts" 
ON telegram_accounts
FOR ALL
USING (true)
WITH CHECK (true);