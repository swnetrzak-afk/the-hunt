// Netlify Function: POST /company-scan
// Body: { company_name: "<string>" }
// Stage 1 of the manual triage flow. Returns a quick scan verdict.
//
// Looks up company_scans first (cache hit = $0). On miss, calls Sonnet with
// the web_search server tool capped at max_uses: 2, persists the result, and
// returns it. Subsequent scans of the same company are free.
//
// Required env vars: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY,
//                    COMPANY_SCAN_PROMPT

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const apiKey = Netlify.env.get('ANTHROPIC_API_KEY');
  const supabaseUrl = Netlify.env.get('SUPABASE_URL');
  const supabaseServiceKey = Netlify.env.get('SUPABASE_SERVICE_KEY');
  const scanPrompt = Netlify.env.get('COMPANY_SCAN_PROMPT');

  if (!supabaseUrl || !supabaseServiceKey) return json({ error: 'Supabase not configured' }, 500);
  if (!apiKey) return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
  if (!scanPrompt || !scanPrompt.trim()) {
    console.error('COMPANY_SCAN_PROMPT env var not set');
    return json({ error: 'COMPANY_SCAN_PROMPT env var not set' }, 500);
  }

  const env = { anthropicKey: apiKey, supabaseUrl, supabaseServiceKey, scanPrompt };

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }

  const companyName = (body.company_name || '').trim();
  if (!companyName) return json({ error: 'Missing company_name' }, 400);

  // Resolve user_id from the single user_profile row (consistent with score-job)
  const profiles = await sbGet(env, 'user_profile', 'select=user_id&limit=1');
  if (!profiles.length) return json({ error: 'No user profile configured' }, 400);
  const userId = profiles[0].user_id;

  // 1. Cache lookup — case-insensitive on company_name (PostgREST ilike)
  const encoded = encodeURIComponent(companyName);
  const existing = await sbGet(env, 'company_scans',
    `select=*&user_id=eq.${userId}&company_name=ilike.${encoded}&limit=1`);
  if (existing.length) {
    return json({ ...existing[0], cached: true }, 200);
  }

  // 2. Cache miss — call Anthropic with web_search
  const result = await runScan(env, companyName);
  if (!result) return json({ error: 'Scan failed — check logs' }, 502);

  // 3. Persist and return the stored row (so the client gets a stable id)
  const inserted = await sbInsert(env, 'company_scans', {
    user_id: userId,
    company_name: companyName,
    verdict: result.verdict,
    bottom_line: result.bottom_line || null,
    proceeded_to_score: false,
  });

  return json({ ...(inserted || {}), ...result, cached: false }, 200);
};

async function runScan(env, companyName) {
  const userMessage = `Company: ${companyName}\nRole: a product management role at this company\n\nScan and decide.`;

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        system: env.scanPrompt,
        tools: [{
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 2,
        }],
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
  } catch (e) {
    console.error('Scan API call failed:', e.message);
    return null;
  }

  if (!res.ok) {
    const detail = await res.text();
    console.error(`Scan API error: HTTP ${res.status}`, detail.slice(0, 300));
    return null;
  }

  const data = await res.json();
  // The model emits server_tool_use + web_search_tool_result blocks for each
  // search, then a final text block with the JSON answer. Pull the last text.
  const textBlocks = (data?.content || []).filter(b => b.type === 'text');
  const text = (textBlocks[textBlocks.length - 1]?.text || '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  try {
    const parsed = JSON.parse(text);
    if (!['thumbs_up', 'thumbs_down'].includes(parsed.verdict)) {
      console.error('Scan returned invalid verdict:', parsed.verdict);
      return null;
    }
    return {
      verdict: parsed.verdict,
      bottom_line: parsed.bottom_line || null,
      what_they_do: parsed.what_they_do || null,
      financial_health: parsed.financial_health || null,
      remote_culture: parsed.remote_culture || null,
      red_flags: parsed.red_flags || null,
    };
  } catch {
    console.error('Scan JSON parse failed. Raw text:', text.slice(0, 200));
    return null;
  }
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
  if (!res.ok) return [];
  return res.json();
}

async function sbInsert(env, table, row) {
  const res = await fetch(`${env.supabaseUrl}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbHeaders(env), 'Prefer': 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    console.error(`sbInsert ${table} error: ${res.status}`);
    return null;
  }
  const data = await res.json();
  return Array.isArray(data) ? data[0] : data;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}
