// Shared scoring module — single source of truth for both scoring paths:
//   - fetch-jobs-background.js (nightly pipeline, context 'nightly')
//   - score-job.js            (rescore / manual triage, context 'rescore')
//
// scoreJob() calls Claude and parses the result. It does NOT touch the DB.
// writeJobScore() inserts the resulting event into job_scores.
//
// Config (model + max_tokens) comes from env vars selected by `context`, so
// models can be swapped without a deploy. Caching (the cache_control split) is
// preserved for the nightly context and skipped for rescore — caching a single
// low-volume rescore call costs more than it saves (write premium, no reads).
//
// Env fields consumed (built by each caller's getEnv):
//   anthropicKey, scoringPrompt,
//   scoringModelNightly, scoringMaxTokensNightly,
//   scoringModelRescore, scoringMaxTokensRescore,
//   supabaseUrl, supabaseServiceKey   (writeJobScore only)

import { computeCompOk, compNote } from './comp.js';
import { fetchWithRetry } from './http.js';

const RAMP_COST = ['high', 'low', 'n/a'];

// Returns a discriminated result — never throws:
//   success:  { ok: true,  result: {...}, model }
//   failure:  { ok: false, stage: 'network'|'http'|'parse', reason, model }
// `model` is the request alias we sent (e.g. 'claude-haiku-4-5'), stored as-is
// for provenance. Every failure path logs to console.error (v3 will also route
// `reason` to scoring_failures).
export async function scoreJob(env, job, profileText, context) {
  const cfg = context === 'nightly'
    ? { model: env.scoringModelNightly, maxTokens: env.scoringMaxTokensNightly }
    : { model: env.scoringModelRescore, maxTokens: env.scoringMaxTokensRescore };
  const model = cfg.model;

  // Static prefix: candidate profile. In the nightly context it's marked
  // cache_control: ephemeral so the system prompt + this block become one cache
  // entry — first job in a run pays the write premium, the rest hit cache at
  // 0.1x and don't count against the per-minute input-token quota.
  const profileBlock = 'CANDIDATE PROFILE:\n' + profileText.trim();

  // Per-job content: always fresh, never cached.
  const jd = (job.jd || '(no description available)').slice(0, 15000);

  // comp_ok is computed here (deterministic threshold), not asked of the model.
  // The model gets the posted string, the annualized numbers, the floor, and a
  // plain-English note so it can weigh comp in the score without doing the math.
  const compOk = computeCompOk(job.comp_min, job.comp_max, env.compFloor);
  const compLines = ['Compensation (posted): ' + (job.comp || 'not listed')];
  if (job.comp_min != null || job.comp_max != null) {
    compLines.push(`Compensation (annualized USD): ${job.comp_min ?? '?'} to ${job.comp_max ?? 'open'}`);
  }
  if (env.compFloor != null) {
    compLines.push(`Your comp floor (annual USD): ${env.compFloor}`);
    compLines.push(`Comp check: ${compNote(job.comp_min, job.comp_max, env.compFloor)} (verdict: ${compOk})`);
  }

  const perJobBlock = [
    '---',
    'JOB TO SCORE:',
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.location || 'not specified'}`,
    `Remote: ${job.remote || 'not specified'}`,
    ...compLines,
    '',
    jd,
  ].join('\n');

  const content = context === 'nightly'
    ? [
        { type: 'text', text: profileBlock, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: perJobBlock },
      ]
    : [profileBlock, '', perJobBlock].join('\n');

  let res;
  try {
    res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: cfg.maxTokens,
        system: env.scoringPrompt,
        messages: [{ role: 'user', content }],
      }),
    }, { allowNonGet: true, retryStatuses: [429, 503, 529], label: `anthropic score[${context}]` });
  } catch (e) {
    console.error(`scoreJob[${context}] Claude API call failed:`, e.message);
    return { ok: false, stage: 'network', reason: e.message, model };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const reason = `HTTP ${res.status}${body ? ' — ' + body.slice(0, 300) : ''}`;
    console.error(`scoreJob[${context}] Claude API error: ${reason}`);
    return { ok: false, stage: 'http', reason, model };
  }

  const data = await res.json();

  // Take the LAST text block, not content[0]. A response can lead with a
  // non-text block (e.g. a thinking block), which left content[0].text
  // undefined → empty string → JSON.parse('') throwing with a blank reason.
  // (company-scan.js already does this for its web_search responses.)
  const textBlocks = (data?.content || []).filter(b => b.type === 'text');
  const text = (textBlocks[textBlocks.length - 1]?.text || '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  // Empty text on a 200 is its own failure mode — surface why (stop_reason,
  // which block types came back, token usage) instead of logging a blank line.
  if (!text) {
    const blocks = (data?.content || []).map(b => b.type).join(',') || 'none';
    const reason = `empty model response (stop_reason=${data?.stop_reason}, blocks=[${blocks}], usage=${JSON.stringify(data?.usage || {})})`;
    console.error(`scoreJob[${context}] ${reason}`);
    return { ok: false, stage: 'parse', reason, model };
  }

  try {
    const parsed = JSON.parse(text);
    const result = {
      score: Number.isInteger(parsed.score) ? Math.min(10, Math.max(1, parsed.score)) : null,
      score_reason: parsed.reason || null,
      archetype: parsed.archetype || null,
      comp_ok: compOk,   // computed above from comp_min/comp_max vs the floor
      ramp_cost: RAMP_COST.includes(parsed.ramp_cost) ? parsed.ramp_cost : null,
    };
    return { ok: true, result, model };
  } catch {
    // Include stop_reason so a truncated (max_tokens) vs malformed response is distinguishable.
    const reason = `${text.slice(0, 200)} | stop_reason=${data?.stop_reason}`;
    console.error(`scoreJob[${context}] score JSON parse failed. Raw response:`, reason);
    return { ok: false, stage: 'parse', reason, model };
  }
}

// Inserts one scoring event into job_scores via the service key (bypasses RLS).
// row: { discovered_job_id, user_id, score, score_reason, archetype, comp_ok,
//        ramp_cost, model, scoring_source }  (scored_at defaults to now()).
export async function writeJobScore(env, row) {
  const res = await fetch(`${env.supabaseUrl}/rest/v1/job_scores`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.supabaseServiceKey}`,
      'apikey': env.supabaseServiceKey,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(stripNullBytes(row)),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`writeJobScore insert error: ${res.status}`, detail.slice(0, 200));
    return false;
  }
  return true;
}

// Postgres `text` columns reject literal null bytes (22P05). Strip recursively.
function stripNullBytes(value) {
  if (typeof value === 'string') return value.replaceAll(String.fromCharCode(0), '');
  if (Array.isArray(value)) return value.map(stripNullBytes);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = stripNullBytes(v);
    return out;
  }
  return value;
}
