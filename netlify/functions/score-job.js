// Netlify Function: POST /score-job
// Body: { job_id: "<uuid>" }
// Re-scores an existing discovered_job against the current stored profile.
// Useful after updating your profile, or to retry a job that failed to score.
//
// Required env vars: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, SCORING_PROMPT
// SCORING_PROMPT lives in Netlify env vars (not in code) so the nightly pipeline
// and rescore path are guaranteed to use the same prompt with no drift.

import { scoreJob, writeJobScore } from './lib/score.js';
import { authorize } from './lib/auth.js';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY');
  const supabaseUrl = Netlify.env.get('SUPABASE_URL');
  const supabaseServiceKey = Netlify.env.get('SUPABASE_SERVICE_KEY');
  const scoringPrompt = Netlify.env.get('SCORING_PROMPT');

  if (!supabaseUrl || !supabaseServiceKey) return json({ error: 'Supabase not configured' }, 500);
  const auth = await authorize(req, { supabaseUrl, supabaseServiceKey });
  if (!auth.ok) return json({ error: auth.error }, auth.status);
  if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
  if (!scoringPrompt || !scoringPrompt.trim()) {
    console.error('SCORING_PROMPT env var not set');
    return json({ error: 'SCORING_PROMPT env var not set' }, 500);
  }

  const env = {
    anthropicKey: apiKey, supabaseUrl, supabaseServiceKey, scoringPrompt,
    scoringModelRescore: Netlify.env.get('SCORING_MODEL_RESCORE') || 'claude-sonnet-4-6',
    scoringMaxTokensRescore: parseInt(Netlify.env.get('SCORING_MAX_TOKENS_RESCORE'), 10) || 1024,
  };

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }

  const { job_id } = body;
  if (!job_id) return json({ error: 'Missing job_id' }, 400);
  // 'manual' = first score of a manually-triaged job; 'rescore' (default) = re-scoring an existing job.
  const scoringSource = body.source === 'manual' ? 'manual' : 'rescore';

  // Fetch the job
  const jobs = await sbGet(env, 'discovered_jobs', `select=*&id=eq.${job_id}&limit=1`);
  if (!jobs.length) return json({ error: 'Job not found' }, 404);
  const job = jobs[0];

  // Fetch the user profile
  const profiles = await sbGet(env, 'user_profile', 'select=profile_text,comp_floor&limit=1');
  const profileText = profiles[0]?.profile_text || '';
  if (!profileText.trim()) return json({ error: 'Profile text is empty — set it up in Settings' }, 400);
  env.compFloor = profiles[0]?.comp_floor ?? null;   // structured floor for code-computed comp_ok

  // Score (rescore config: Sonnet, no cache split)
  const r = await scoreJob(env, job, profileText, 'rescore');
  if (!r.ok) return json({ error: 'Scoring failed — check logs', reason: r.reason }, 502);

  // Persist as a new job_scores event
  await writeJobScore(env, {
    discovered_job_id: job_id,
    user_id: job.user_id,
    ...r.result,
    model: r.model,
    scoring_source: scoringSource,
  });

  return json(r.result, 200);
};

function sbHeaders(env) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${env.supabaseServiceKey}`,
    'apikey': env.supabaseServiceKey,
  };
}

async function sbGet(env, table, query) {
  const res = await fetch(`${env.supabaseUrl}/rest/v1/${table}?${query}`, { headers: sbHeaders(env) });
  if (!res.ok) return [];
  return res.json();
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
