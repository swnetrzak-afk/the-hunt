// Caller authentication for the HTTP-invoked functions.
//
// Every function endpoint spends Anthropic credits and/or writes rows with the
// service key, so none of them may be callable by anyone who merely knows the
// site URL. Two accepted callers:
//
//   1. The browser app — sends the signed-in user's Supabase access token as
//      `Authorization: Bearer <jwt>`. We validate it with Supabase Auth
//      (GET /auth/v1/user) and then require that user to OWN the user_profile
//      row, so a stray signup (if signups were ever left enabled) still can't
//      drive the system. Before any profile exists (first-run setup), any valid
//      session is accepted.
//
//   2. nightly-fetch → fetch-jobs-background (server-to-server, no user
//      session). It sends `x-hunt-internal: <token>`, where the token is an HMAC
//      of a fixed label keyed by SUPABASE_SERVICE_KEY. Both functions can derive
//      it, no extra env var is needed, and the service key itself never goes
//      over the wire. Only endpoints that opt in with { allowInternal: true }
//      accept it.
//
// Usage (env needs supabaseUrl + supabaseServiceKey):
//   const auth = await authorize(req, env);
//   if (!auth.ok) return json({ error: auth.error }, auth.status);

import { createHmac, timingSafeEqual } from 'node:crypto';
import { fetchWithRetry } from './http.js';

const INTERNAL_LABEL = 'the-hunt:internal-trigger';

export function internalToken(serviceKey) {
  return createHmac('sha256', serviceKey).update(INTERNAL_LABEL).digest('hex');
}

function safeEqual(a, b) {
  const ab = Buffer.from(a || '');
  const bb = Buffer.from(b || '');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function authorize(req, env, { allowInternal = false } = {}) {
  if (!env.supabaseUrl || !env.supabaseServiceKey) {
    return { ok: false, status: 500, error: 'Supabase not configured' };
  }

  if (allowInternal) {
    const internal = req.headers.get('x-hunt-internal');
    if (internal && safeEqual(internal, internalToken(env.supabaseServiceKey))) {
      return { ok: true, internal: true, userId: null };
    }
  }

  const header = req.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return { ok: false, status: 401, error: 'Not signed in' };

  let user;
  try {
    const res = await fetchWithRetry(`${env.supabaseUrl}/auth/v1/user`, {
      headers: { apikey: env.supabaseServiceKey, Authorization: `Bearer ${token}` },
    }, { label: 'auth user' });
    if (!res.ok) return { ok: false, status: 401, error: 'Invalid or expired session' };
    user = await res.json();
  } catch (e) {
    console.error('authorize: Supabase auth check failed:', e.message);
    return { ok: false, status: 503, error: 'Auth check unavailable' };
  }
  if (!user?.id) return { ok: false, status: 401, error: 'Invalid or expired session' };

  // Owner check — the system is single-user; the owner is the user_profile row.
  let profiles;
  try {
    const res = await fetchWithRetry(
      `${env.supabaseUrl}/rest/v1/user_profile?select=user_id&limit=1`,
      { headers: { apikey: env.supabaseServiceKey, Authorization: `Bearer ${env.supabaseServiceKey}` } },
      { label: 'auth owner' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    profiles = await res.json();
  } catch (e) {
    console.error('authorize: owner lookup failed:', e.message);
    return { ok: false, status: 503, error: 'Auth check unavailable' };
  }
  if (profiles.length && profiles[0].user_id !== user.id) {
    console.warn(`authorize: rejected non-owner user ${user.id}`);
    return { ok: false, status: 403, error: 'Not authorized' };
  }

  return { ok: true, internal: false, userId: user.id };
}
