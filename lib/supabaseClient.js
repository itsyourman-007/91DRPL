// Supabase client — server-side only.
//
// Uses the SERVICE ROLE key, never the anon/public key, because this file
// only ever runs on the server (it's required from lib/store.js, which is
// only required from server.js). The service role key bypasses Row Level
// Security, which is intentional here: supabase/schema.sql turns RLS on
// with zero policies, so the anon key can't touch this table at all, and
// every read/write in this app already goes through the requireAdmin
// check or the validated checkout API in server.js. Never send this key
// to the browser or commit it to git.
//
// The client is created lazily (on first use, not at import time) so the
// server can still boot — and serve the storefront pages — even before
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are set. You only hit the error
// below when an order-related route is actually called.

const { createClient } = require('@supabase/supabase-js');

let client = null;

function getClient() {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      'Supabase is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. ' +
      'See README.md > "Supabase setup".'
    );
  }

  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

module.exports = { getClient };
