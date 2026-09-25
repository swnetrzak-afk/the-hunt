// Shared job-fetch pipeline. Runs the full nightly harvest: pull from every
// source, dedup + filter, insert, and score. Invoked two ways, both thin wrappers:
//   - fetch-jobs-background.js  — pure background function (15-min runtime),
//                                 triggered by the manual "Fetch now" button
//                                 (POST /run-fetch) and by the nightly scheduler.
//   - nightly-fetch.js          — scheduled function that async-fires the
//                                 background function on a cron.
//
// This split exists because a single function cannot be BOTH scheduled AND a
// background function on Netlify: the scheduler acks the invocation but the
// async body never runs (near-zero volume), and HTTP-triggering a scheduled
// function returns 403. Netlify's recommended pattern is a scheduled function
// that CALLS a background function — which is what these two wrappers do.
//
// Required Netlify env vars:
//   ANTHROPIC_API_KEY
//   ADZUNA_APP_ID, ADZUNA_APP_KEY
//   JSEARCH_API_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//   SCORING_PROMPT  (the scoring system prompt — single source of truth,
//                    shared with /score-job, edited in Netlify env vars)

import { detectGreenhouse, fetchGreenhouse } from '../providers/greenhouse.js';
import { detectLever, fetchLever } from '../providers/lever.js';
import { detectAshby, fetchAshby } from '../providers/ashby.js';
import { scoreJob, writeJobScore } from './score.js';
import { normalizeComp } from './comp.js';
import { resolveCompanyFromJd } from './company.js';
import { fetchWithRetry } from './http.js';

const PROVIDERS = {
  greenhouse: { detect: detectGreenhouse, fetch: fetchGreenhouse },
  lever:      { detect: detectLever,      fetch: fetchLever },
  ashby:      { detect: detectAshby,      fetch: fetchAshby },
};

const DAYS_OLD = 30;          // only import jobs posted within last N days
const RESULTS_PER_PAGE = 50;  // Adzuna results per keyword query

export async function runFetch(env) {
  if (!env.supabaseUrl || !env.supabaseServiceKey) {
    console.error('Missing Supabase env vars');
    return new Response('Configuration error', { status: 500 });
  }
  if (!env.scoringPrompt || !env.scoringPrompt.trim()) {
    console.error('SCORING_PROMPT env var not set — aborting run');
    return new Response('SCORING_PROMPT not configured', { status: 500 });
  }

  // 1. Load user profile (profile text + keywords)
  const profiles = await sbGet(env, 'user_profile', 'select=*&limit=1');
  if (!profiles.length) {
    console.log('No user profile found — skipping run. Set up your profile in the app first.');
    return new Response('No profile configured', { status: 200 });
  }
  const profile = profiles[0];
  const userId = profile.user_id;
  const profileText = profile.profile_text || '';
  env.compFloor = profile.comp_floor ?? null;   // structured floor for code-computed comp_ok
  const runId = await sbStartRun(env, userId, env.runTrigger || 'manual');   // run-status row for the client poller + v3 logging
  const keywords = Array.isArray(profile.search_keywords) && profile.search_keywords.length
    ? profile.search_keywords
    : DEFAULT_KEYWORDS;
  const positiveTitles = Array.isArray(profile.title_filter_positive) ? profile.title_filter_positive : [];
  const negativeTitles = Array.isArray(profile.title_filter_negative) ? profile.title_filter_negative : [];

  if (!profileText.trim()) {
    console.log('Profile text is empty — skipping run.');
    await sbFinishRun(env, runId, 'done', { inserted: 0, scored: 0, skipped: 0, errors: 0 }, 'profile empty');
    return new Response('Profile text empty', { status: 200 });
  }

  // Load tracked companies (enabled only)
  const trackedCompanies = await sbGet(env, 'tracked_companies', 'select=*&enabled=eq.true&limit=200');
  console.log(`${trackedCompanies.length} tracked companies enabled`);

  // 2. Build dedup sets from existing discovered_jobs
  //    - id key:    (source + external_id) — exact-row dedup
  //    - role key:  (company + title)      — collapses ATS spam where the same
  //                                          role is posted N times for N cities
  const existing = await sbGetAll(env, 'discovered_jobs', 'select=source,external_id,title,company');
  const seenIds = new Set(existing.map(r => `${r.source}:${r.external_id}`));
  const seenRoles = new Set(existing.map(r => roleKey(r.company, r.title)));
  console.log(`${seenIds.size} existing rows, ${seenRoles.size} unique roles`);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - DAYS_OLD);

  // 3. Fetch from all sources, dedup + filter on the fly
  const newJobs = [];
  let titleFilteredOut = 0;

  const accept = (job, idKey, extras = {}) => {
    if (seenIds.has(idKey)) return false;
    const rk = roleKey(job.company, job.title);
    if (seenRoles.has(rk)) return false;
    if (!isLocationEligible(job)) return false;
    if (!passesTitleFilter(job.title, positiveTitles, negativeTitles)) {
      titleFilteredOut++;
      return false;
    }
    seenIds.add(idKey);
    seenRoles.add(rk);
    Object.assign(job, extras);
    return true;
  };

  // Adzuna — one query per keyword
  if (env.adzunaId && env.adzunaKey) {
    for (const kw of keywords) {
      const results = await fetchAdzuna(env, kw, cutoff);
      for (const j of results) if (accept(j, `adzuna:${j.external_id}`)) newJobs.push(j);
    }
  } else {
    console.warn('ADZUNA_APP_ID / ADZUNA_APP_KEY not set — skipping Adzuna');
  }

  // JSearch — one cursor page per keyword.
  // JSearch's employer_name is often the job board, not the real employer, so the
  // (company + title) dedup key is unreliable and the same role slips through from
  // multiple boards. Before the role-dedup check, re-derive the real company from
  // the JD (v2.6.1). Runs only AFTER the cheap gates (id-dedup, title, location)
  // so we don't spend an LLM call on jobs we'd drop anyway.
  if (env.jsearchKey) {
    for (const kw of keywords) {
      const results = await fetchJSearch(env, kw, cutoff);
      for (const j of results) {
        const idKey = `jsearch:${j.external_id}`;
        if (seenIds.has(idKey)) continue;
        if (!isLocationEligible(j)) continue;
        if (!passesTitleFilter(j.title, positiveTitles, negativeTitles)) { titleFilteredOut++; continue; }
        if (env.anthropicKey && j.jd) {
          const { company } = await resolveCompanyFromJd(env, j.jd, j.company);
          j.company = company;
        }
        const rk = roleKey(j.company, j.title);
        if (seenRoles.has(rk)) continue;
        seenIds.add(idKey);
        seenRoles.add(rk);
        newJobs.push(j);
      }
    }
  } else {
    console.warn('JSEARCH_API_KEY not set — skipping JSearch');
  }

  // Built In — keyword-driven, scrapes search page + parses schema.org JSON-LD per job
  for (const kw of keywords) {
    const urls = await fetchBuiltinUrls(kw);
    // Dedup at URL level so we only fetch individual pages for net-new jobs
    const fresh = urls.filter(u => !seenIds.has(`builtin:${u.id}`));
    if (!fresh.length) continue;
    // Batch detail fetches with limited concurrency to keep total runtime reasonable
    const detailed = await batchFetch(fresh, 5, u => fetchBuiltinDetail(u));
    for (const j of detailed) {
      if (!j) continue;
      if (j.posted_at && new Date(j.posted_at) < cutoff) continue;
      if (accept(j, `builtin:${j.external_id}`)) newJobs.push(j);
    }
  }

  // The Muse — category-filtered remote Product Management roles.
  // Unlike Adzuna/JSearch (keyword relevance), The Muse filters by an explicit
  // category + remote-location flag, so every result is already a Product role
  // and already remote — no keyword-relevance noise (JSearch's failure mode),
  // and no unreliable remote flag. One paginated pull, not per-keyword.
  {
    const results = await fetchTheMuse(cutoff);
    for (const j of results) if (accept(j, `themuse:${j.external_id}`)) newJobs.push(j);
  }

  // Himalayas — server-side search API (q + employment_type + country), one query
  // per keyword. Richest source: full JD + structured comp. Title filter refines.
  for (const kw of keywords) {
    const results = await fetchHimalayas(kw, cutoff);
    for (const j of results) if (accept(j, `himalayas:${j.external_id}`)) newJobs.push(j);
  }

  // We Work Remotely — Product-category RSS (remote-only, full JD). One pull;
  // the loose category is narrowed by the title filter in accept().
  {
    const results = await fetchWwr(cutoff);
    for (const j of results) if (accept(j, `wwr:${j.external_id}`)) newJobs.push(j);
  }

  // Tracked companies — direct ATS pulls (Greenhouse / Lever / Ashby)
  for (const company of trackedCompanies) {
    const provider = pickProvider(company);
    if (!provider) {
      console.warn(`No matching provider for ${company.name} (${company.careers_url})`);
      continue;
    }
    let results;
    try {
      results = await PROVIDERS[provider].fetch(company);
    } catch (e) {
      console.error(`${provider}: error fetching ${company.name}:`, e.message);
      continue;
    }
    // Apply the same cutoff at the company level (ATS feeds return all jobs, not date-filtered)
    const fresh = results.filter(j => !j.posted_at || new Date(j.posted_at) >= cutoff);
    const extras = { tracked: true, company_notes: company.notes || null };
    for (const j of fresh) if (accept(j, `${j.source}:${j.external_id}`, extras)) newJobs.push(j);
  }

  console.log(`${newJobs.length} net-new jobs to process (title-filtered out: ${titleFilteredOut})`);

  // 4. Insert + score each new job
  let inserted = 0, scored = 0, skipped = 0, errors = 0;

  for (const job of newJobs) {
    try {
      const ins = await sbInsert(env, 'discovered_jobs', { ...job, user_id: userId });
      if (ins.status === 'duplicate') { skipped++; continue; }  // already in DB (dedup pre-check missed it)
      if (ins.status !== 'ok' || !ins.row) { errors++; continue; }
      inserted++;

      if (env.anthropicKey) {
        const r = await scoreJob(env, job, profileText, 'nightly');
        if (r.ok) {
          await writeJobScore(env, {
            discovered_job_id: ins.row.id,
            user_id: userId,
            ...r.result,
            model: r.model,
            scoring_source: 'nightly',
          });
          scored++;
        }
      }
    } catch (e) {
      console.error('Job processing error:', e.message, '|', job.title, '@', job.company);
      errors++;
    }
  }

  const summary = { inserted, scored, skipped, errors };
  console.log('Run complete:', summary);
  await sbFinishRun(env, runId, 'done', summary);
  return new Response(JSON.stringify(summary), { status: 200 });
}

// ── JOB SOURCES ──────────────────────────────────────────────────────────────

async function fetchAdzuna(env, keyword, cutoff) {
  const params = new URLSearchParams({
    app_id: env.adzunaId,
    app_key: env.adzunaKey,
    what: keyword,
    results_per_page: String(RESULTS_PER_PAGE),
    max_days_old: String(DAYS_OLD),
  });

  const url = `https://api.adzuna.com/v1/api/jobs/us/search/1?${params}`;
  let res;
  try {
    res = await fetchWithRetry(url, {}, { label: `Adzuna "${keyword}"` });
  } catch (e) {
    console.error(`Adzuna fetch failed for "${keyword}":`, e.message);
    return [];
  }

  if (!res.ok) {
    const body = await res.text();
    console.error(`Adzuna error for "${keyword}": HTTP ${res.status} — ${body.slice(0, 300)}`);
    return [];
  }

  const data = await res.json();
  return (data.results || [])
    .filter(j => j.created && new Date(j.created) >= cutoff)
    .map(j => ({
      source: 'adzuna',
      external_id: String(j.id),
      title: (j.title || '').trim(),
      company: j.company?.display_name || '',
      location: j.location?.display_name || '',
      remote: inferRemote(j.location?.display_name, j.title, j.description),
      comp: formatAdzunaComp(j.salary_min, j.salary_max),
      ...normalizeComp(j.salary_min, j.salary_max, 'year', 'USD'),
      url: j.redirect_url || '',
      jd: (j.description || '').trim(),
      posted_at: j.created ? j.created.split('T')[0] : null,
    }));
}

async function fetchJSearch(env, keyword, cutoff) {
  const params = new URLSearchParams({
    query: keyword,
    country: 'us',
    date_posted: '3days',
    work_from_home: 'true',
    employment_types: 'FULLTIME',
  });

  let res;
  try {
    res = await fetchWithRetry(`https://api.openwebninja.com/jsearch/search-v2?${params}`, {
      headers: { 'x-api-key': env.jsearchKey },
    }, { label: `JSearch "${keyword}"` });
  } catch (e) {
    console.error(`JSearch fetch failed for "${keyword}":`, e.message);
    return [];
  }

  if (!res.ok) {
    const body = await res.text();
    console.error(`JSearch error for "${keyword}": HTTP ${res.status} — ${body.slice(0, 300)}`);
    return [];
  }

  const data = await res.json();
  const jobs = data?.data?.jobs || [];

  return jobs
    .filter(j => {
      if (!j.job_posted_at_timestamp) return true;
      return new Date(j.job_posted_at_timestamp * 1000) >= cutoff;
    })
    .map(j => ({
      source: 'jsearch',
      external_id: String(j.job_id),
      title: (j.job_title || '').trim(),
      company: j.employer_name || '',
      location: j.job_location || [j.job_city, j.job_state, j.job_country].filter(Boolean).join(', '),
      remote: j.job_is_remote ? 'Remote' : inferRemote(j.job_location, j.job_title, j.job_description),
      comp: formatJSearchComp(j.job_min_salary, j.job_max_salary, j.job_salary_period),
      ...normalizeComp(j.job_min_salary, j.job_max_salary, j.job_salary_period, j.job_salary_currency),
      url: j.job_apply_link || (j.apply_options?.[0]?.apply_link) || '',
      jd: (j.job_description || '').trim(),
      posted_at: j.job_posted_at_timestamp
        ? new Date(j.job_posted_at_timestamp * 1000).toISOString().split('T')[0]
        : null,
    }));
}

function formatJSearchComp(min, max, period) {
  if (!min && !max) return '';
  const fmt = n => n >= 1000 ? `$${Math.round(n / 1000)}K` : `$${n}`;
  const suffix = period && period !== 'YEAR' ? `/${period.toLowerCase()}` : '';
  if (min && max) return `${fmt(min)}–${fmt(max)}${suffix}`;
  if (min) return `${fmt(min)}+${suffix}`;
  return `up to ${fmt(max)}${suffix}`;
}

// ── BUILT IN ──────────────────────────────────────────────────────────────────
// Built In doesn't have a public API. Its search pages are server-rendered HTML,
// and every individual job page embeds full schema.org JobPosting JSON-LD.
// We do a two-stage fetch:
//   1. Pull the search results page → extract /job/{slug}/{id} URLs (cheap)
//   2. For each net-new id, fetch the individual page → parse the JSON-LD
// Dedup happens between the stages so we don't refetch jobs we've already seen.

const BUILTIN_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchBuiltinUrls(keyword) {
  const search = encodeURIComponent(keyword);
  const url = `https://builtin.com/jobs?search=${search}&remote=true`;

  let res;
  try {
    res = await fetchWithRetry(url, { headers: { 'User-Agent': BUILTIN_USER_AGENT } }, { label: `builtin search "${keyword}"` });
  } catch (e) {
    console.error(`builtin: search fetch failed for "${keyword}":`, e.message);
    return [];
  }
  if (!res.ok) {
    console.error(`builtin: search HTTP ${res.status} for "${keyword}"`);
    return [];
  }

  const html = await res.text();
  // Extract unique /job/{slug}/{id} URLs from the rendered HTML
  const seen = new Set();
  const out = [];
  const re = /"(\/job\/[a-z0-9-]+\/(\d+))"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = m[2];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, url: `https://builtin.com${m[1]}` });
  }
  return out;
}

async function fetchBuiltinDetail({ id, url }) {
  let res;
  try {
    res = await fetchWithRetry(url, { headers: { 'User-Agent': BUILTIN_USER_AGENT } }, { label: `builtin detail ${id}` });
  } catch (e) {
    console.error(`builtin: detail fetch failed for ${id}:`, e.message);
    return null;
  }
  if (!res.ok) {
    if (res.status !== 404) console.error(`builtin: detail HTTP ${res.status} for ${id}`);
    return null;
  }

  const html = await res.text();
  const job = parseBuiltinJsonLd(html);
  if (!job) {
    console.warn(`builtin: no JobPosting JSON-LD found for ${id}`);
    return null;
  }

  // Map to our normalized shape
  const location = builtinLocationString(job.jobLocation, job.applicantLocationRequirements);
  const remote = inferBuiltinRemote(job, location);
  const jd = stripHtmlAndEntities(job.description || '');

  return {
    source: 'builtin',
    external_id: id,
    title: (job.title || '').trim(),
    company: job.hiringOrganization?.name || '',
    location,
    remote,
    comp: formatBuiltinComp(job.baseSalary),
    ...builtinCompBounds(job.baseSalary),
    url,
    jd,
    posted_at: job.datePosted ? job.datePosted.split('T')[0] : null,
  };
}

function parseBuiltinJsonLd(html) {
  // JobPosting is embedded as inline JSON-LD; find every <script type="application/ld+json"> block
  // and return the first one whose @type is JobPosting.
  // Built In encodes the '+' in the mime type as &#x2B; — match either form.
  const re = /<script[^>]*type=["']application\/ld(?:\+|&#x2B;)json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    // Could be a single object, an array, or { @graph: [...] } wrapper (Built In uses @graph)
    const candidates = [];
    const enqueue = node => {
      if (!node) return;
      if (Array.isArray(node)) node.forEach(enqueue);
      else if (Array.isArray(node['@graph'])) node['@graph'].forEach(enqueue);
      else candidates.push(node);
    };
    enqueue(parsed);
    for (const c of candidates) {
      const type = c?.['@type'];
      if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) {
        return c;
      }
    }
  }
  return null;
}

function builtinLocationString(jobLocation, applicantLocReq) {
  // Handle array or single object for jobLocation
  const locs = Array.isArray(jobLocation) ? jobLocation : (jobLocation ? [jobLocation] : []);
  const parts = locs.map(l => {
    const addr = l?.address || {};
    return [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean).join(', ');
  }).filter(Boolean);
  if (parts.length) return parts.join(' / ');

  // Fallback to applicantLocationRequirements for fully remote roles
  const reqs = Array.isArray(applicantLocReq) ? applicantLocReq : (applicantLocReq ? [applicantLocReq] : []);
  return reqs.map(r => r?.name || '').filter(Boolean).join(' / ');
}

function inferBuiltinRemote(job, locationStr) {
  if (job.jobLocationType === 'TELECOMMUTE') return 'Remote';
  const s = `${locationStr || ''} ${job.title || ''} ${(job.description || '').slice(0, 500)}`.toLowerCase();
  if (s.includes('remote')) return 'Remote';
  if (s.includes('hybrid')) return 'Hybrid';
  return 'On-site';
}

// Numeric annualized bounds from Built In's schema.org baseSalary
// (value can be a { minValue, maxValue, unitText } object or a single number).
function builtinCompBounds(baseSalary) {
  if (!baseSalary || !baseSalary.value) return { comp_min: null, comp_max: null };
  const v = baseSalary.value;
  const unit = (typeof v === 'object' && v.unitText) || baseSalary.unitText;
  if (typeof v === 'object') return normalizeComp(v.minValue, v.maxValue, unit, baseSalary.currency);
  if (typeof v === 'number') return normalizeComp(v, v, unit, baseSalary.currency);
  return { comp_min: null, comp_max: null };
}

function formatBuiltinComp(baseSalary) {
  if (!baseSalary) return '';
  const v = baseSalary.value;
  if (!v) return '';
  const fmt = n => n >= 1000 ? `$${Math.round(n / 1000)}K` : `$${n}`;
  // value can be { minValue, maxValue, unitText } or a single value
  if (typeof v === 'object') {
    const min = Number(v.minValue) || 0;
    const max = Number(v.maxValue) || 0;
    const unit = v.unitText && v.unitText !== 'YEAR' ? `/${v.unitText.toLowerCase()}` : '';
    if (min && max) return `${fmt(min)}–${fmt(max)}${unit}`;
    if (max) return `up to ${fmt(max)}${unit}`;
    if (min) return `${fmt(min)}+${unit}`;
  }
  if (typeof v === 'number') return fmt(v);
  return '';
}

function stripHtmlAndEntities(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&rsquo;/g, "'").replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"').replace(/&ldquo;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// Run fn over items with limited concurrency; returns array of results in input order.
async function batchFetch(items, concurrency, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try { results[idx] = await fn(items[idx]); }
      catch (e) { results[idx] = null; }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ── THE MUSE ──────────────────────────────────────────────────────────────────
// The Muse has a free public API (no key required) that filters by CATEGORY and
// location rather than free-text keyword relevance. We ask for the "Product
// Management" category + "Flexible / Remote" location directly, which sidesteps
// the relevance collapse that made JSearch return engineering/marketing roles for
// PM queries. Full JD ships in `contents` (HTML). Paginated: ~20 results/page,
// 1-indexed, with `page_count` telling us when to stop.

const MUSE_CATEGORY = 'Product Management';
const MUSE_LOCATION = 'Flexible / Remote';
const MUSE_MAX_PAGES = 6;   // safety cap on pages pulled per run

async function fetchTheMuse(cutoff) {
  const out = [];
  for (let page = 1; page <= MUSE_MAX_PAGES; page++) {
    // Build the query by hand: The Muse needs %20 for spaces (URLSearchParams
    // would emit '+', which its server does not treat as a space for `location`).
    const url = `https://www.themuse.com/api/public/jobs`
      + `?category=${encodeURIComponent(MUSE_CATEGORY)}`
      + `&location=${encodeURIComponent(MUSE_LOCATION)}`
      + `&page=${page}`;

    let res;
    try {
      res = await fetchWithRetry(url, {}, { label: `themuse page ${page}` });
    } catch (e) {
      console.error(`themuse: fetch failed (page ${page}):`, e.message);
      break;
    }
    if (!res.ok) {
      // The Muse returns 400 for a page beyond the last — expected; anything else logged.
      if (res.status !== 400) console.error(`themuse: HTTP ${res.status} (page ${page})`);
      break;
    }

    const data = await res.json();
    const results = data?.results || [];
    if (!results.length) break;

    for (const j of results) {
      const posted_at = j.publication_date ? j.publication_date.split('T')[0] : null;
      if (posted_at && new Date(posted_at) < cutoff) continue;
      const location = (j.locations || []).map(l => l?.name).filter(Boolean).join(' / ');
      out.push({
        source: 'themuse',
        external_id: String(j.id),
        title: (j.name || '').trim(),
        company: j.company?.name || '',
        location,
        remote: inferMuseRemote(location, j),
        comp: '',                                   // The Muse public API carries no salary
        ...normalizeComp(null, null, 'year', 'USD'),
        url: j.refs?.landing_page || '',
        jd: stripHtmlAndEntities(j.contents || ''),
        posted_at,
      });
    }

    if (data.page_count && page >= data.page_count) break;
  }
  return out;
}

function inferMuseRemote(location, job) {
  const loc = (location || '').toLowerCase();
  if (loc.includes('remote')) return 'Remote';   // "Flexible / Remote" and friends
  // Fall back to text inference over title + a JD slice for the rare non-flagged row.
  return inferRemote(location, job.name, stripHtmlAndEntities(job.contents || '').slice(0, 500));
}

// ── HIMALAYAS ─────────────────────────────────────────────────────────────────
// Himalayas has a proper search API with server-side filtering, so we query it
// per keyword like Adzuna/JSearch — but with WORKING relevance. It's the richest
// source: structured salary (→ real comp_ok), full JD, employment_type filter.
// Params: q (free text), employment_type, country, sort, page (1-based).

const HIMALAYAS_PAGES = 2;   // pages per keyword (~20/page, sorted recent)

async function fetchHimalayas(keyword, cutoff) {
  const out = [];
  for (let page = 1; page <= HIMALAYAS_PAGES; page++) {
    const url = `https://himalayas.app/jobs/api/search`
      + `?q=${encodeURIComponent(keyword)}`
      + `&employment_type=${encodeURIComponent('Full Time')}`
      + `&country=US`
      + `&sort=recent`
      + `&page=${page}`;

    let res;
    try {
      res = await fetchWithRetry(url, {}, { label: `himalayas "${keyword}" p${page}` });
    } catch (e) {
      console.error(`himalayas: fetch failed for "${keyword}" p${page}:`, e.message);
      break;
    }
    if (!res.ok) {
      console.error(`himalayas: HTTP ${res.status} for "${keyword}" p${page}`);
      break;
    }

    const data = await res.json();
    const jobs = data?.jobs || [];
    if (!jobs.length) break;

    for (const j of jobs) {
      const posted_at = himalayasDate(j.pubDate);
      if (posted_at && new Date(posted_at) < cutoff) continue;
      const location = Array.isArray(j.locationRestrictions) && j.locationRestrictions.length
        ? j.locationRestrictions.slice(0, 3).join(', ')
        : 'Remote';
      out.push({
        source: 'himalayas',
        external_id: String(j.guid || j.applicationLink || `${j.companySlug}:${j.title}`),
        title: (j.title || '').trim(),
        company: j.companyName || '',
        location,
        remote: 'Remote',   // Himalayas is remote-native
        comp: formatHimalayasComp(j.minSalary, j.maxSalary, j.salaryPeriod),
        ...normalizeComp(j.minSalary, j.maxSalary, j.salaryPeriod, j.currency),
        url: j.applicationLink || '',
        jd: stripHtmlAndEntities(j.description || ''),
        posted_at,
      });
    }
  }
  return out;
}

// pubDate may be an epoch (s or ms) or an ISO/RFC string — handle both.
function himalayasDate(v) {
  if (v == null) return null;
  if (typeof v === 'number') {
    const ms = v < 1e12 ? v * 1000 : v;
    const d = new Date(ms);
    return isNaN(d) ? null : d.toISOString().split('T')[0];
  }
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString().split('T')[0];
}

function formatHimalayasComp(min, max, period) {
  if (!min && !max) return '';
  const fmt = n => n >= 1000 ? `$${Math.round(n / 1000)}K` : `$${Math.round(n)}`;
  const suffix = period && !/ann|year/i.test(period) ? `/${String(period).toLowerCase()}` : '';
  if (min && max) return `${fmt(min)}–${fmt(max)}${suffix}`;
  if (min) return `${fmt(min)}+${suffix}`;
  return `up to ${fmt(max)}${suffix}`;
}

// ── WE WORK REMOTELY ──────────────────────────────────────────────────────────
// WWR has no API, but a per-category RSS feed. The "Product" category is loose
// (returns ops/eng/finance too), so the title filter refines it. Remote-only.
// Full JD lives in each item's <description> as entity-encoded HTML.

async function fetchWwr(cutoff) {
  const url = 'https://weworkremotely.com/categories/remote-product-jobs.rss';
  let res;
  try {
    res = await fetchWithRetry(url, { headers: { 'User-Agent': BUILTIN_USER_AGENT } }, { label: 'wwr' });
  } catch (e) {
    console.error('wwr: fetch failed:', e.message);
    return [];
  }
  if (!res.ok) {
    console.error(`wwr: HTTP ${res.status}`);
    return [];
  }

  const xml = await res.text();
  const out = [];
  const items = xml.split(/<item>/i).slice(1);
  for (const chunk of items) {
    const item = chunk.split(/<\/item>/i)[0];

    // Full-Time only (WWR <type> is "Full-Time" / "Contract" / etc.)
    const type = rssTag(item, 'type');
    if (type && !/full/i.test(type)) continue;

    const rawTitle = decodeEntities(rssTag(item, 'title') || '');
    const link = rssTag(item, 'link') || '';
    const guid = rssTag(item, 'guid') || link;
    if (!rawTitle || !guid) continue;

    // WWR titles are "Company: Role"
    const idx = rawTitle.indexOf(': ');
    const company = idx > 0 ? rawTitle.slice(0, idx).trim() : '';
    const title = idx > 0 ? rawTitle.slice(idx + 2).trim() : rawTitle.trim();

    const posted_at = wwrDate(rssTag(item, 'pubDate'));
    if (posted_at && new Date(posted_at) < cutoff) continue;

    const region = decodeEntities(rssTag(item, 'region') || '');
    const descRaw = rssTag(item, 'description') || '';

    out.push({
      source: 'wwr',
      external_id: wwrSlug(guid),
      title,
      company,
      location: region || 'Remote',
      remote: 'Remote',   // WWR is remote-only
      comp: '',
      ...normalizeComp(null, null, 'year', 'USD'),
      url: link,
      jd: stripHtmlAndEntities(decodeEntities(descRaw)),   // decode entity-encoded HTML first, then strip tags
      posted_at,
    });
  }
  return out;
}

// Extract a single RSS tag's inner text, unwrapping CDATA if present.
function rssTag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return null;
  return m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}

// Decode the entity layer WWR uses to embed HTML in <description> (&amp; last).
function decodeEntities(s) {
  return (s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

function wwrDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().split('T')[0];
}

function wwrSlug(u) {
  const m = (u || '').match(/\/remote-jobs\/([^/?#]+)/);
  return m ? m[1] : (u || '');
}

// ── SUPABASE REST HELPERS ─────────────────────────────────────────────────────

function sbHeaders(env) {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${env.supabaseServiceKey}`,
    'apikey': env.supabaseServiceKey,
  };
}

async function sbGet(env, table, query) {
  // Reads are idempotent GETs → safe to retry. This matters for the dedup
  // pre-load (sbGetAll over discovered_jobs): a transient 504 there would
  // otherwise return [] and silently disable (company+title) role-dedup for
  // the whole run (observed 2026-09-12). fetchWithRetry covers 429/502/503/504.
  let res;
  try {
    res = await fetchWithRetry(`${env.supabaseUrl}/rest/v1/${table}?${query}`, {
      headers: sbHeaders(env),
    }, { label: `sbGet ${table}` });
  } catch (e) {
    console.error(`sbGet ${table} failed:`, e.message);
    return [];
  }
  if (!res.ok) { console.error(`sbGet ${table} error: ${res.status}`); return []; }
  return res.json();
}

// PostgREST caps each response at 1000 rows regardless of `limit`. Page through
// the whole table (stable order by id) so callers that need every row — the
// dedup sets — see all of them. Without this, rows past the first 1000 slip the
// pre-check and only get caught by the unique constraint at insert (as 409s).
async function sbGetAll(env, table, select) {
  const pageSize = 1000;
  const out = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await sbGet(env, table, `${select}&order=id.asc&limit=${pageSize}&offset=${offset}`);
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return out;
}

async function sbInsert(env, table, row) {
  const res = await fetch(`${env.supabaseUrl}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...sbHeaders(env), 'Prefer': 'return=representation' },
    body: JSON.stringify(stripNullBytes(row)),
  });
  if (!res.ok) {
    // Unique constraint violation (409) = row already exists — an expected
    // duplicate, not an error. Anything else is a real failure worth logging.
    if (res.status === 409) return { status: 'duplicate', row: null };
    const detail = await res.text();
    console.error(`sbInsert ${table} error: ${res.status}`, detail.slice(0, 200));
    return { status: 'error', row: null };
  }
  const data = await res.json();
  return { status: 'ok', row: Array.isArray(data) ? data[0] : data };
}

// pipeline_runs helpers — record run start/finish so the client can poll for
// completion (toast + auto-refresh Discover) and for v3 run history. Writes only;
// sbFinishRun is a PATCH (kept on raw fetch like other writes).
async function sbStartRun(env, userId, trigger) {
  const ins = await sbInsert(env, 'pipeline_runs', { user_id: userId, trigger, status: 'running' });
  return ins.status === 'ok' && ins.row ? ins.row.id : null;
}

async function sbFinishRun(env, runId, status, summary, detail) {
  if (!runId) return;
  try {
    await fetch(`${env.supabaseUrl}/rest/v1/pipeline_runs?id=eq.${runId}`, {
      method: 'PATCH',
      headers: { ...sbHeaders(env), 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        status,
        summary: summary || null,
        detail: detail || null,
        finished_at: new Date().toISOString(),
      }),
    });
  } catch (e) {
    console.error('sbFinishRun error:', e.message);
  }
}

// Postgres `text` columns reject literal null bytes with error 22P05.
// Job feeds occasionally carry them in scraped HTML — strip recursively so any
// string field on the row gets cleaned before insert.
function stripNullBytes(value) {
  if (typeof value === 'string') return value.replaceAll(String.fromCharCode(0), "");
  if (Array.isArray(value)) return value.map(stripNullBytes);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = stripNullBytes(v);
    return out;
  }
  return value;
}

// ── UTILITIES ─────────────────────────────────────────────────────────────────

export function getEnv() {
  return {
    anthropicKey: Netlify.env.get('ANTHROPIC_API_KEY'),
    adzunaId: Netlify.env.get('ADZUNA_APP_ID'),
    adzunaKey: Netlify.env.get('ADZUNA_APP_KEY'),
    jsearchKey: Netlify.env.get('JSEARCH_API_KEY'),
    supabaseUrl: Netlify.env.get('SUPABASE_URL'),
    supabaseServiceKey: Netlify.env.get('SUPABASE_SERVICE_KEY'),
    scoringPrompt: Netlify.env.get('SCORING_PROMPT'),
    scoringModelNightly: Netlify.env.get('SCORING_MODEL_NIGHTLY') || 'claude-haiku-4-5',
    scoringMaxTokensNightly: parseInt(Netlify.env.get('SCORING_MAX_TOKENS_NIGHTLY'), 10) || 512,
    scoringModelRescore: Netlify.env.get('SCORING_MODEL_RESCORE') || 'claude-sonnet-4-6',
    scoringMaxTokensRescore: parseInt(Netlify.env.get('SCORING_MAX_TOKENS_RESCORE'), 10) || 1024,
    companyExtractModel: Netlify.env.get('COMPANY_EXTRACT_MODEL') || 'claude-haiku-4-5',
  };
}

function pickProvider(company) {
  // Explicit override wins
  if (company.provider && PROVIDERS[company.provider]) return company.provider;
  // Auto-detect from careers_url (alphabetical order for determinism)
  for (const id of Object.keys(PROVIDERS).sort()) {
    if (PROVIDERS[id].detect(company)) return id;
  }
  return null;
}

function passesTitleFilter(title, positive, negative) {
  if (!title) return false;
  const t = title.toLowerCase();
  // Negative match disqualifies immediately
  for (const neg of negative) {
    if (neg && t.includes(neg.toLowerCase())) return false;
  }
  // If positive list is empty, no requirement; otherwise at least one must match
  if (!positive.length) return true;
  for (const pos of positive) {
    if (pos && t.includes(pos.toLowerCase())) return true;
  }
  return false;
}

function roleKey(company, title) {
  const norm = s => (s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
  return `${norm(company)}|${norm(title)}`;
}

function isLocationEligible(job) {
  if (job.remote === 'Remote') return true;
  if (job.remote === 'Hybrid') {
    // Only allow Hybrid if it's commutable from Charlotte, NC
    const loc = (job.location || '').toLowerCase();
    return loc.includes('charlotte') || loc.includes(', nc') || loc.includes('north carolina');
  }
  return false; // drop On-site and unclassified
}

function inferRemote(location, title, description) {
  const s = `${location || ''} ${title || ''} ${(description || '').slice(0, 500)}`.toLowerCase();
  if (s.includes('remote')) return 'Remote';
  if (s.includes('hybrid')) return 'Hybrid';
  return 'On-site';
}

function formatAdzunaComp(min, max) {
  if (!min && !max) return '';
  const fmt = n => n >= 1000 ? `$${Math.round(n / 1000)}K` : `$${n}`;
  if (min && max) return `${fmt(min)}–${fmt(max)}`;
  if (min) return `${fmt(min)}+`;
  return `up to ${fmt(max)}`;
}

const DEFAULT_KEYWORDS = [
  'AI Product Manager',
  'Technical Product Manager',
  'Platform Product Manager',
  'Data Product Manager',
  'Product Operations Manager',
  'Senior Product Manager',
];
