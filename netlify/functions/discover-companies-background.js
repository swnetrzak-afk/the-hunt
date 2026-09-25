// Netlify Background Function — POST /discover-companies (returns 202, runs async).
//
// Expands tracked_companies. Two modes (body.mode):
//   - 'paste':   body.names — company names supplied by the user
//   - 'suggest': Claude generates candidates in the user's target domains
//
// For each candidate: detect its ATS (Greenhouse/Lever/Ashby) by probing guessed
// slugs, with a capped web_search fallback for non-obvious ones; require >=1 role
// that passes the user's title filter; then insert as a DISABLED tracked_companies
// row for the user to review + enable in Settings. Never auto-enabled.
//
// Runs as a background function (15-min budget) because web_search + probing many
// companies exceeds a normal function's timeout. The 202 is immediate; results
// appear as disabled rows. It is intentionally NOT scheduled.
//
// Env vars: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY,
//           COMPANY_DISCOVER_PROMPT (optional — falls back to a built-in default,
//           and logs a [discover][config-fallback] warning when it does),
//           COMPANY_DISCOVER_MODEL (optional — defaults to claude-sonnet-4-6).

import {
  DEFAULT_DISCOVER_PROMPT, generateCandidates, detectAts, probeSlug,
  webSearchAts, relevanceCheck,
} from './lib/discover.js';
import { authorize } from './lib/auth.js';

const MAX_CANDIDATES = 40;
const WEB_SEARCH_CAP = 15;
const DETECT_CONCURRENCY = 4;

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const env = getEnv();
  if (!env.supabaseUrl || !env.supabaseServiceKey) return json({ error: 'Supabase not configured' }, 500);
  // Background function: Netlify has already answered 202, so a rejection here
  // just stops the work (and is visible in the function logs).
  const auth = await authorize(req, env);
  if (!auth.ok) {
    console.warn(`discover-companies: rejected caller (${auth.status} ${auth.error})`);
    return json({ error: auth.error }, auth.status);
  }
  if (!env.anthropicKey) return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);

  // Prompt env var with logged fallback — so the feature works without setup, but
  // a missing env var is visible now (Netlify logs) and to the future logging pass.
  let usedDefaultPrompt = false;
  if (!env.discoverPrompt || !env.discoverPrompt.trim()) {
    env.discoverPrompt = DEFAULT_DISCOVER_PROMPT;
    usedDefaultPrompt = true;
    console.warn('[discover][config-fallback] COMPANY_DISCOVER_PROMPT is unset — using built-in default prompt. Set it in Netlify env vars to customize.');
  }

  let body;
  try { body = await req.json(); } catch { body = {}; }
  const mode = body.mode === 'paste' ? 'paste' : 'suggest';
  const count = Math.min(Math.max(parseInt(body.count, 10) || 20, 1), MAX_CANDIDATES);

  // Resolve the single user + their title filters (service key bypasses RLS, so
  // we must set user_id explicitly on insert — the column is NOT NULL).
  const profiles = await sbGet(env, 'user_profile',
    'select=user_id,profile_text,title_filter_positive,title_filter_negative&limit=1');
  if (!profiles.length) return json({ error: 'No user profile configured' }, 400);
  const userId = profiles[0].user_id;
  const profileText = profiles[0].profile_text || '';
  const positive = Array.isArray(profiles[0].title_filter_positive) ? profiles[0].title_filter_positive : [];
  const negative = Array.isArray(profiles[0].title_filter_negative) ? profiles[0].title_filter_negative : [];

  const existing = await sbGet(env, 'tracked_companies', `select=name,careers_url&user_id=eq.${userId}`);
  const existingNames = existing.map(r => r.name);
  const existingNameSet = new Set(existing.map(r => norm(r.name)));
  const existingUrlSet = new Set(existing.map(r => (r.careers_url || '').toLowerCase()));

  // 1. Build candidates
  let candidates = [];
  if (mode === 'paste') {
    const raw = Array.isArray(body.names) ? body.names : String(body.names || '').split(/[\n,]/);
    candidates = raw.map(s => ({ name: String(s).trim(), domain: null })).filter(c => c.name);
  } else {
    candidates = await generateCandidates({
      env, profileText, existingNames, count, prompt: env.discoverPrompt, model: env.discoverModel,
    });
  }

  // Drop already-tracked + in-list duplicates, cap the batch
  const seen = new Set();
  candidates = candidates.filter(c => {
    const n = norm(c.name);
    if (!n || existingNameSet.has(n) || seen.has(n)) return false;
    seen.add(n);
    return true;
  }).slice(0, MAX_CANDIDATES);

  console.log(`[discover] mode=${mode} candidates=${candidates.length}`);

  // 2. Detect ATS by guessed slugs (concurrency-limited)
  const misses = [];
  await mapLimit(candidates, DETECT_CONCURRENCY, async (c) => {
    const det = await detectAts(c.name);
    if (det) c._det = det;
    else misses.push(c);
  });

  // 3. web_search fallback for misses (capped, sequential)
  let webSearches = 0;
  for (const c of misses) {
    if (webSearches >= WEB_SEARCH_CAP) break;
    webSearches++;
    const ws = await webSearchAts({ env, name: c.name, model: env.discoverModel });
    if (!ws) continue;
    const det = await probeSlug(c.name, ws.provider, ws.slug);
    if (det) c._det = det;
  }

  // 4. Relevance-gate + insert disabled rows
  let added = 0, skipped = 0, irrelevant = 0;
  for (const c of candidates) {
    const det = c._det;
    if (!det) continue;
    if (existingUrlSet.has((det.careers_url || '').toLowerCase())) { skipped++; continue; }
    const rel = relevanceCheck(det.jobs, positive, negative);
    if (rel.count < 1) { irrelevant++; continue; }

    const notes = `[auto-discovered ${today()}] ${c.domain ? c.domain + ' · ' : ''}`
      + `${det.provider} · ${rel.count} PM role(s)${rel.sample ? `, e.g. "${rel.sample}"` : ''}`;
    const ok = await sbInsert(env, 'tracked_companies', {
      user_id: userId,
      name: c.name,
      careers_url: det.careers_url,
      provider: det.provider,
      notes,
      enabled: false,   // review gate — user enables in Settings
    });
    if (ok) { added++; existingUrlSet.add(det.careers_url.toLowerCase()); }
    else skipped++;
  }

  const summary = {
    mode, candidates: candidates.length, detected: candidates.filter(c => c._det).length,
    added, skipped, irrelevant, web_searches: webSearches, used_default_prompt: usedDefaultPrompt,
  };
  console.log('[discover] complete:', JSON.stringify(summary));
  return json(summary, 200);
};

// ── helpers ───────────────────────────────────────────────────────────────────

function getEnv() {
  return {
    anthropicKey: Netlify.env.get('ANTHROPIC_API_KEY'),
    supabaseUrl: Netlify.env.get('SUPABASE_URL'),
    supabaseServiceKey: Netlify.env.get('SUPABASE_SERVICE_KEY'),
    discoverPrompt: Netlify.env.get('COMPANY_DISCOVER_PROMPT'),
    discoverModel: Netlify.env.get('COMPANY_DISCOVER_MODEL') || 'claude-sonnet-4-6',
  };
}

const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const today = () => new Date().toISOString().split('T')[0];

// Run fn over items with limited concurrency.
async function mapLimit(items, limit, fn) {
  const it = items[Symbol.iterator]();
  const worker = async () => {
    for (;;) {
      const { value, done } = it.next();
      if (done) return;
      await fn(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function sbHeaders(env) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${env.supabaseServiceKey}`,
    'apikey': env.supabaseServiceKey,
  };
}

async function sbGet(env, table, query) {
  const res = await fetch(`${env.supabaseUrl}/rest/v1/${table}?${query}`, { headers: sbHeaders(env) });
  if (!res.ok) { console.error(`[discover] sbGet ${table} error: ${res.status}`); return []; }
  return res.json();
}

async function sbInsert(env, table, row) {
  const res = await fetch(`${env.supabaseUrl}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbHeaders(env), 'Prefer': 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`[discover] sbInsert ${table} error: ${res.status}`, detail.slice(0, 200));
    return null;
  }
  const data = await res.json();
  return Array.isArray(data) ? data[0] : data;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
