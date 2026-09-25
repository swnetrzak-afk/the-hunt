// Ashby provider — pulls full JDs via the public posting-api endpoint.
// Auto-detects from careers_url pattern `jobs.ashbyhq.com/{slug}`.

import { fetchWithRetry } from '../lib/http.js';

function resolveApiUrl(entry) {
  const match = (entry.careers_url || '').match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (!match) return null;
  return `https://api.ashbyhq.com/posting-api/job-board/${match[1]}?includeCompensation=true`;
}

export function detectAshby(entry) {
  return !!resolveApiUrl(entry);
}

// `quiet` suppresses miss/error logging — used when probing guessed slugs during
// company discovery, where non-200s are expected and would otherwise spam logs.
export async function fetchAshby(entry, { quiet = false } = {}) {
  const url = resolveApiUrl(entry);
  if (!url) throw new Error(`ashby: cannot derive API URL for ${entry.name}`);

  let res;
  try {
    res = await fetchWithRetry(url, {}, { label: `ashby ${entry.name}`, tries: quiet ? 1 : 3 });
  } catch (e) {
    if (!quiet) console.error(`ashby: fetch failed for ${entry.name}:`, e.message);
    return [];
  }
  if (!res.ok) {
    if (!quiet) console.error(`ashby: HTTP ${res.status} for ${entry.name}`);
    return [];
  }

  const json = await res.json();
  const jobs = Array.isArray(json?.jobs) ? json.jobs : [];

  return jobs.map(j => ({
    source: 'ashby',
    external_id: String(j.id),
    title: (j.title || '').trim(),
    company: entry.name,
    location: j.location || '',
    remote: j.isRemote ? 'Remote' : inferRemote(j.location, j.title, j.descriptionPlain),
    comp: formatAshbyComp(j.compensation),
    url: j.jobUrl || j.applyUrl || '',
    jd: j.descriptionPlain || stripHtml(j.descriptionHtml || ''),
    posted_at: j.publishedAt ? new Date(j.publishedAt).toISOString().split('T')[0] : null,
  }));
}

function formatAshbyComp(comp) {
  if (!comp) return '';
  // Ashby compensation shape varies; try common fields
  const tiers = comp.compensationTierSummary || comp.summary || comp.tiers?.[0]?.summary || '';
  return tiers || '';
}

function inferRemote(location, title, description) {
  const s = `${location || ''} ${title || ''} ${(description || '').slice(0, 500)}`.toLowerCase();
  if (s.includes('remote')) return 'Remote';
  if (s.includes('hybrid')) return 'Hybrid';
  return 'On-site';
}

function stripHtml(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
