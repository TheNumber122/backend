import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_KEY!;

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Second Supabase instance belonging to the external auto-leave bot project.
// Telegap writes the channels it creates here (table `protected_channels`) so the
// bot can skip them. Optional: if the env vars are absent, `protectedDb` is null
// and the recording step is silently skipped.
const OTHER_SUPABASE_URL = process.env.OTHER_SUPABASE_URL;
const OTHER_SUPABASE_KEY = process.env.OTHER_SUPABASE_KEY;

export const protectedDb: SupabaseClient | null =
  OTHER_SUPABASE_URL && OTHER_SUPABASE_KEY
    ? createClient(OTHER_SUPABASE_URL, OTHER_SUPABASE_KEY)
    : null;
