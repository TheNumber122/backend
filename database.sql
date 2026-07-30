-- Updated telegram_accounts table with groups_count field and username
create table if not exists telegram_accounts (
  phone text primary key,
  username text,
  groups_count integer not null default 0,
  channels_count integer not null default 0,
  groups_created_24h integer not null default 0,
  next_available_time timestamptz,
  flood_wait_until timestamptz,
  session_string text,
  -- Owner tag: isolates one user's accounts from another's. Pre-existing rows
  -- default to 'default'. See backend/src/workspace.ts.
  workspace text not null default 'default',
  -- Bots created via BotFather for this account. Telegram caps this at 20 per
  -- account; we force it to 20 when BotFather reports the cap (see routes.ts).
  bots_count integer not null default 0,
  -- Rolling 24h bot-creation limit (max 3/day). bots_next_reset marks when the
  -- window (started on the first creation) resets bots_created_24h back to 0.
  bots_created_24h integer not null default 0,
  bots_next_reset timestamptz,
  -- Per-pattern bot counters, bumped on every successful BotFather creation
  -- (see register_bot_creation). These are the source of truth for the bots
  -- page "X/10 default · Y/10 crypto" tally — independent of whether the
  -- telegram_bots row saved — so the count always reflects reality.
  default_bots_count integer not null default 0,
  crypto_bots_count integer not null default 0
);

-- Enable RLS
alter table telegram_accounts enable row level security;

-- Grant permissions to service_role (needed for Supabase access)
grant all privileges on table telegram_accounts to service_role;
grant all privileges on all sequences in schema public to service_role;

-- Function to increment groups count for an account.
-- groups_count is the COMBINED total (groups + channels) and drives the 500-full
-- limit and the 50/24h rate limit; channels_count (below) is the channels-only
-- subset used purely for display breakdown.
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

-- Function to increment the channels-only counter (a subset of groups_count).
-- Called in addition to increment_groups_count when the created entity is a channel.
create or replace function increment_channels_count(phone_number text, increment_amount integer)
returns void
language plpgsql
as $$
begin
  update telegram_accounts
  set channels_count = channels_count + increment_amount
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
  -- Channels-only counter (subset of groups_count). Existing rows default to 0,
  -- so channels created before this column existed still count toward groups_count
  -- and will display as groups; the breakdown is accurate for creations going forward.
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'telegram_accounts'
    and column_name = 'channels_count'
  ) then
    alter table telegram_accounts add column channels_count integer not null default 0;
  end if;

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

  -- Workspace/owner tag for multi-user isolation. Existing accounts default to
  -- 'default'; new logins are tagged with the caller's workspace.
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'telegram_accounts'
    and column_name = 'workspace'
  ) then
    alter table telegram_accounts add column workspace text not null default 'default';
  end if;

  -- Per-account BotFather bot counter (Telegram caps bots at 20 per account).
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'telegram_accounts'
    and column_name = 'bots_count'
  ) then
    alter table telegram_accounts add column bots_count integer not null default 0;
  end if;

  -- Rolling 24h bot-creation limit (max 3/day).
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'telegram_accounts' and column_name = 'bots_created_24h'
  ) then
    alter table telegram_accounts add column bots_created_24h integer not null default 0;
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'telegram_accounts' and column_name = 'bots_next_reset'
  ) then
    alter table telegram_accounts add column bots_next_reset timestamptz;
  end if;

  -- Per-pattern bot counters. On first add, backfill default_bots_count from the
  -- existing total (all historical bots were default) so accounts immediately
  -- show the right split (e.g. an account with 8 bots -> 8 default).
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'telegram_accounts' and column_name = 'default_bots_count'
  ) then
    alter table telegram_accounts add column default_bots_count integer not null default 0;
    alter table telegram_accounts add column crypto_bots_count integer not null default 0;
    update telegram_accounts set default_bots_count = bots_count, crypto_bots_count = 0;
  end if;
end $$;

-- Check both bot limits for an account, resetting the 24h window if it elapsed.
-- Returns json: { can_create, reason, bots_count, bots_created_24h, next_reset }.
-- reason ∈ 'total' (hit 20 cap) | 'daily' (hit 3/24h) | null (can create).
create or replace function check_bot_limits(account_phone text)
returns json
language plpgsql
as $$
declare
  acct telegram_accounts;
  now_ts timestamptz := now();
begin
  select * into acct from telegram_accounts where phone = account_phone;
  if acct is null then
    return json_build_object('can_create', false, 'reason', 'not_found');
  end if;

  -- Reset the daily window once it has elapsed.
  if acct.bots_next_reset is not null and now_ts >= acct.bots_next_reset then
    update telegram_accounts
    set bots_created_24h = 0, bots_next_reset = null
    where phone = account_phone;
    acct.bots_created_24h := 0;
    acct.bots_next_reset := null;
  end if;

  if acct.bots_count >= 20 then
    return json_build_object('can_create', false, 'reason', 'total',
      'bots_count', acct.bots_count);
  end if;

  if acct.bots_created_24h >= 3 then
    return json_build_object('can_create', false, 'reason', 'daily',
      'bots_count', acct.bots_count, 'bots_created_24h', acct.bots_created_24h,
      'next_reset', acct.bots_next_reset);
  end if;

  return json_build_object('can_create', true, 'bots_count', acct.bots_count,
    'bots_created_24h', acct.bots_created_24h);
end;
$$;

-- Record one successful bot creation: bump total + daily counters, bump the
-- matching per-pattern counter, and start the 24h window on the first creation
-- (it does not slide on later creations). bot_pattern ∈ 'default'|'crypto'|
-- 'custom'; custom bumps neither pattern counter (only the total).
create or replace function register_bot_creation(
  account_phone text,
  bot_pattern text default 'default'
)
returns void
language plpgsql
as $$
begin
  update telegram_accounts
  set bots_count = bots_count + 1,
      bots_created_24h = bots_created_24h + 1,
      bots_next_reset = coalesce(bots_next_reset, now() + interval '24 hours'),
      default_bots_count = default_bots_count + (case when bot_pattern = 'default' then 1 else 0 end),
      crypto_bots_count = crypto_bots_count + (case when bot_pattern = 'crypto' then 1 else 0 end)
  where phone = account_phone;
end;
$$;

-- Increment the bot counter for an account (mirrors increment_groups_count).
create or replace function increment_bots_count(phone_number text, increment_amount integer)
returns void
language plpgsql
as $$
begin
  update telegram_accounts
  set bots_count = bots_count + increment_amount
  where phone = phone_number;
end;
$$;

-- Force an account's bot counter to a value (used to mark an account as having
-- hit Telegram's 20-bot cap when BotFather refuses, so we stop retrying it).
create or replace function set_bots_count(phone_number text, new_count integer)
returns void
language plpgsql
as $$
begin
  update telegram_accounts
  set bots_count = new_count
  where phone = phone_number;
end;
$$;

-- Record one successful bot deletion: decrement total + per-pattern counters.
-- bot_pattern ∈ 'default'|'crypto'|'custom'; custom decrements neither pattern
-- counter (only the total). All counters are floored at 0 to prevent negatives.
create or replace function register_bot_deletion(
  account_phone text,
  bot_pattern text default 'default'
)
returns void
language plpgsql
as $$
begin
  update telegram_accounts
  set bots_count = greatest(bots_count - 1, 0),
      bots_created_24h = greatest(bots_created_24h - 1, 0),
      default_bots_count = default_bots_count - (case when bot_pattern = 'default' then 1 else 0 end),
      crypto_bots_count = crypto_bots_count - (case when bot_pattern = 'crypto' then 1 else 0 end)
  where phone = account_phone;

  -- Floor per-pattern counters at 0
  update telegram_accounts
  set default_bots_count = greatest(default_bots_count, 0),
      crypto_bots_count = greatest(crypto_bots_count, 0)
  where phone = account_phone;
end;
$$;

-- Bot ownership transfers: Telegram allows max 3 transfers per account per 24h,
-- tracked separately from the 3-creations/24h window. Same fixed-window design
-- as bots_created_24h (window starts on the first transfer, does not slide).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'telegram_accounts' and column_name = 'bots_transferred_24h'
  ) then
    alter table telegram_accounts add column bots_transferred_24h integer not null default 0;
    alter table telegram_accounts add column transfers_next_reset timestamptz;
  end if;
end $$;

-- Check the 3-transfers/24h limit, resetting the window if it elapsed.
-- Returns json: { can_transfer, bots_transferred_24h, next_reset }.
create or replace function check_transfer_limits(account_phone text)
returns json
language plpgsql
as $$
declare
  acct telegram_accounts;
  now_ts timestamptz := now();
begin
  select * into acct from telegram_accounts where phone = account_phone;
  if acct is null then
    return json_build_object('can_transfer', false, 'reason', 'not_found');
  end if;

  if acct.transfers_next_reset is not null and now_ts >= acct.transfers_next_reset then
    update telegram_accounts
    set bots_transferred_24h = 0, transfers_next_reset = null
    where phone = account_phone;
    acct.bots_transferred_24h := 0;
    acct.transfers_next_reset := null;
  end if;

  if acct.bots_transferred_24h >= 3 then
    return json_build_object('can_transfer', false, 'reason', 'daily',
      'bots_transferred_24h', acct.bots_transferred_24h,
      'next_reset', acct.transfers_next_reset);
  end if;

  return json_build_object('can_transfer', true,
    'bots_transferred_24h', acct.bots_transferred_24h);
end;
$$;

-- Record one successful transfer: bump the daily transfer counter (the 24h
-- window extends from the LATEST transfer) and decrement the total/per-pattern
-- bot counters — the bot has left the account, same effect as a deletion
-- (minus the 24h-creations decrement, since the creation still happened).
create or replace function register_bot_transfer(
  account_phone text,
  bot_pattern text default 'default'
)
returns void
language plpgsql
as $$
begin
  update telegram_accounts
  set bots_transferred_24h = bots_transferred_24h + 1,
      transfers_next_reset = now() + interval '24 hours',
      bots_count = greatest(bots_count - 1, 0),
      default_bots_count = greatest(default_bots_count - (case when bot_pattern = 'default' then 1 else 0 end), 0),
      crypto_bots_count = greatest(crypto_bots_count - (case when bot_pattern = 'crypto' then 1 else 0 end), 0)
  where phone = account_phone;
end;
$$;

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
  error_message text,
  -- Owner tag, mirrors telegram_accounts.workspace. See backend/src/workspace.ts.
  workspace text not null default 'default',
  -- Bot-job fields (unused by group/channel jobs). Bot jobs are processed one bot
  -- at a time by the round-robin scheduler; these track progress + cooldown.
  bots_done integer not null default 0,        -- bots created so far for this job
  bots_attempts integer not null default 0,    -- failed attempts (runaway guard)
  next_attempt_at timestamptz                  -- earliest time the next bot may run
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

  -- Workspace/owner tag for multi-user isolation (safe to re-run).
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'group_creation_queue'
    and column_name = 'workspace'
  ) then
    alter table group_creation_queue add column workspace text not null default 'default';
  end if;

  -- Bot-job progress/cooldown columns (safe to re-run).
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'group_creation_queue' and column_name = 'bots_done'
  ) then
    alter table group_creation_queue add column bots_done integer not null default 0;
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'group_creation_queue' and column_name = 'bots_attempts'
  ) then
    alter table group_creation_queue add column bots_attempts integer not null default 0;
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'group_creation_queue' and column_name = 'next_attempt_at'
  ) then
    alter table group_creation_queue add column next_attempt_at timestamptz;
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

-- Bots created via BotFather. The token is the valuable output and enables a
-- future "transfer ownership" action. Scoped by workspace like everything else.
create table if not exists telegram_bots (
  id serial primary key,
  workspace text not null default 'default',
  owner_phone text not null references telegram_accounts(phone),
  username text not null unique,        -- the @handle, without a leading @
  display_name text,
  token text not null,                  -- BotFather HTTP API token
  theme text,                           -- custom-pattern theme, null for default
  -- Which naming pattern produced this bot: 'default' | 'crypto' | 'custom'.
  -- This is the source of truth for the per-account 10-default / 10-crypto split
  -- shown on the bots page (never re-derive it from the username).
  pattern text not null default 'default',
  created_at timestamptz not null default now()
);

alter table telegram_bots enable row level security;
grant all privileges on table telegram_bots to service_role;
grant all privileges on sequence telegram_bots_id_seq to service_role;

CREATE POLICY "Allow full access to telegram_bots"
ON telegram_bots
FOR ALL
USING (true)
WITH CHECK (true);

-- Add the pattern column to pre-existing telegram_bots tables and backfill it
-- from the historical `theme` convention (crypto bots stored theme='crypto',
-- default bots theme=null, custom bots the actual theme text). Safe to re-run.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'telegram_bots' and column_name = 'pattern'
  ) then
    alter table telegram_bots add column pattern text not null default 'default';
    update telegram_bots
    set pattern = case
      when theme = 'crypto' then 'crypto'
      when theme is null then 'default'
      else 'custom'
    end;
  end if;
end $$;

-- Speeds up the per-account default/crypto/custom tally in GET /accounts.
create index if not exists idx_telegram_bots_ws_owner_pattern
  on telegram_bots (workspace, owner_phone, pattern);

-- ===========================================================================
-- Messaging feature: bulk-send to an account's EXISTING channels or groups.
-- Two shapes, one engine:
--   • broadcast : send ONE message (text, or image+caption) to every chat now.
--   • drip      : send X AI-generated messages per chat, spread over Y days.
-- Chat IDs are NOT stored anywhere — each account's channels/groups are
-- discovered live from Telegram (iterDialogs) at send time.
-- ===========================================================================

-- Parent row: one per user action. Holds the shared config, the (AI-generated
-- or user-typed) message pool, and any uploaded image.
create table if not exists messaging_jobs (
  id serial primary key,
  workspace text not null default 'default',   -- owner tag, see backend/src/workspace.ts
  mode text not null,                          -- 'broadcast' | 'drip'
  target_kind text not null,                   -- 'channel' | 'group'
  -- content
  message_pool jsonb,                          -- string[]; drip: len = total_rounds, broadcast: [text] or null
  image_path text,                             -- broadcast image on disk (nullable)
  caption text,                                -- broadcast image caption (nullable)
  theme text,                                  -- drip: the AI prompt/theme used
  -- schedule
  total_rounds integer not null default 1,     -- messages per chat (broadcast = 1)
  span_days numeric not null default 0,        -- spread window in days (broadcast = 0)
  interval_ms bigint not null default 0,       -- gap between rounds = span_days*86400000 / total_rounds
  send_delay_ms integer not null default 1500, -- gap between per-chat sends within a round
  status text not null default 'active',       -- 'active' | 'completed' | 'failed' | 'cancelled'
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  error_message text
);

-- Child row: one per (job, account). Tracks that account's own progress and
-- cooldown so the scheduler can round-robin and park flooded accounts
-- independently — mirrors the bot-job fields on group_creation_queue.
create table if not exists messaging_targets (
  id serial primary key,
  job_id integer not null references messaging_jobs(id) on delete cascade,
  phone text not null references telegram_accounts(phone),
  rounds_done integer not null default 0,      -- rounds completed for this account
  sent_count integer not null default 0,       -- successful per-chat sends (progress/analytics)
  chats_found integer,                         -- last discovery count (for UI display)
  status text not null default 'pending',      -- 'pending' | 'processing' | 'completed' | 'failed'
  next_attempt_at timestamptz,                 -- when this account's next round is due
  error_message text
);

create index if not exists messaging_targets_job_id_idx on messaging_targets(job_id);
create index if not exists messaging_targets_due_idx on messaging_targets(status, next_attempt_at);

alter table messaging_jobs enable row level security;
alter table messaging_targets enable row level security;
grant all privileges on table messaging_jobs to service_role;
grant all privileges on table messaging_targets to service_role;
grant all privileges on sequence messaging_jobs_id_seq to service_role;
grant all privileges on sequence messaging_targets_id_seq to service_role;

CREATE POLICY "Allow full access to messaging_jobs"
ON messaging_jobs
FOR ALL
USING (true)
WITH CHECK (true);

CREATE POLICY "Allow full access to messaging_targets"
ON messaging_targets
FOR ALL
USING (true)
WITH CHECK (true);
