// Netlify Background Function — runs the full job-fetch pipeline (up to 15 min).
//
// Invoked two ways, both async (returns 202 immediately, then runs in background):
//   - Manual "Fetch now" button  → POST /run-fetch  (rewrite in netlify.toml)
//   - Nightly schedule           → nightly-fetch.js fires this endpoint on cron
//
// This function is intentionally NOT scheduled itself. A function that is both a
// background function AND scheduled fails silently on Netlify: the scheduler acks
// the invocation (~100ms) but the async body never runs, and HTTP-triggering a
// scheduled function returns 403. The schedule lives in nightly-fetch.js instead.
//
// All pipeline logic + env loading lives in lib/run-fetch.js (shared, testable).

import { runFetch, getEnv } from './lib/run-fetch.js';

export default async (req) => {
  const env = getEnv();
  // Manual "Fetch now" (POST /run-fetch) sends no body → 'manual';
  // nightly-fetch sends { trigger: 'nightly' }. Recorded on the pipeline_runs row.
  try { const b = await req.json(); if (b && b.trigger) env.runTrigger = String(b.trigger); } catch {}
  return runFetch(env);
};
