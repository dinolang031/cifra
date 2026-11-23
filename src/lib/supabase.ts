import { createClient } from '@supabase/supabase-js'
import type { Database } from './database.types'

const url = import.meta.env.VITE_SUPABASE_URL?.trim()
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()

export const supabaseConfigurationError = url && publishableKey
  ? null
  : 'Supabase nije konfiguriran. Dodajte VITE_SUPABASE_URL i VITE_SUPABASE_PUBLISHABLE_KEY u .env.local.'

export const supabase = url && publishableKey
  ? createClient<Database>(url, publishableKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: true,
      },
    })
  : null
