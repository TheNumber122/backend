import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_KEY!;

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Second Supabase instance belonging to the external auto-leave bot project.
// Telegap writes the channels it creates here (table `protected_channels`) so the
// bot can skip them. The server logs a clear warning when this integration is not
// configured, and the channel page exposes a backfill action after configuration.
const OTHER_SUPABASE_URL = process.env.OTHER_SUPABASE_URL;
// Prefer a service-role key for the sister project. Keep the old variable as a
// fallback so an existing deployment can be upgraded without a flag day.
const OTHER_SUPABASE_KEY =
  process.env.OTHER_SUPABASE_SERVICE_ROLE_KEY || process.env.OTHER_SUPABASE_KEY;

export const protectedDb: SupabaseClient | null =
  OTHER_SUPABASE_URL && OTHER_SUPABASE_KEY
    ? createClient(OTHER_SUPABASE_URL, OTHER_SUPABASE_KEY)
    : null;

if (!protectedDb) {
  console.warn(
    "[Telegap] Protected-channel sync is disabled: set OTHER_SUPABASE_URL and " +
      "OTHER_SUPABASE_SERVICE_ROLE_KEY (or OTHER_SUPABASE_KEY)."
  );
}
