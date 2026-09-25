// Netlify Scheduled Function — nightly at 9am UTC (5am ET). Schedule is declared
// in netlify.toml under [functions."nightly-fetch"].
//
// A scheduled function has the standard short timeout (~10s), which isn't enough
// for the full harvest. So its only job is to async-fire the background function
// (fetch-jobs-background), which returns 202 immediately and then runs the real
// pipeline for up to 15 minutes. This scheduled-calls-background split is
// Netlify's recommended pattern for long-running scheduled work.
//
// The background function rejects unauthenticated callers, so this sends the
// internal HMAC token (lib/auth.js) — derived from SUPABASE_SERVICE_KEY, which
// both functions already have. The key itself is never sent.

import { internalToken } from './lib/auth.js';

export default async () => {
  // Netlify sets URL to the site's primary production address at runtime.
  const base = Netlify.env.get('URL');
  if (!base) {
    console.error('nightly-fetch: URL env var not set — cannot locate background function');
    return new Response('URL not configured', { status: 500 });
  }
  const serviceKey = Netlify.env.get('SUPABASE_SERVICE_KEY');
  if (!serviceKey) {
    console.error('nightly-fetch: SUPABASE_SERVICE_KEY not set — cannot authenticate to background function');
    return new Response('SUPABASE_SERVICE_KEY not configured', { status: 500 });
  }

  const endpoint = `${base}/.netlify/functions/fetch-jobs-background`;
  try {
    // Background functions ack with 202; this returns fast, well under the limit.
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hunt-internal': internalToken(serviceKey) },
      body: JSON.stringify({ trigger: 'nightly' }),
    });
    console.log(`nightly-fetch: triggered background fetch → HTTP ${res.status}`);
  } catch (e) {
    console.error('nightly-fetch: failed to trigger background fetch:', e.message);
    return new Response('Trigger failed', { status: 500 });
  }

  return new Response('Nightly fetch triggered', { status: 200 });
};
