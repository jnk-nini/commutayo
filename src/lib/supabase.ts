// Single Supabase client for the whole app. Exported as possibly-null (not asserted / thrown on
// module load) because the dynamic network is feature-flagged off by default -- a dev environment
// without `.env.local` filled in should still be able to run the app on the hardcoded pilot
// network, per the safe-transition plan in dynamicRoutingEngine.ts.

import { createClient, type SupabaseClient } from "@supabase/supabase-js"

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const supabase: SupabaseClient | null =
  supabaseUrl !== undefined && supabaseAnonKey !== undefined ? createClient(supabaseUrl, supabaseAnonKey) : null
