// Greenhouse provider — pulls full JDs via the public boards-api JSON endpoint.
// Auto-detects from careers_url pattern `job-boards.greenhouse.io/{slug}`,
// or accepts an explicit api: URL override.

import { fetchWithRetry } from '../lib/http.js';

const ALLOWED_HOSTS = new Set([
  'boards-api.greenhouse.io',
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'job-boards.eu.greenhouse.io',
]);

function assertGreenhouseUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error(`greenhouse: URL must use HTTPS: ${url}`);
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`greenhouse: untrusted hostname "${parsed.hostname}"`);
  }
  return url;
}

function resolveApiUrl(entry) {
  if (entry.api) return assertGreenhouseUrl(entry.api);
  const match = (entry.careers_url || '').match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (match) return `https://boards-api.greenhouse.io/v1/boards/${match[1]}/jobs`;
  return null;
}

export function detectGreenhouse(entry) {
  return !!resolveApiUrl(entry);
}

// `quiet` suppresses miss/error logging — used when probing guessed slugs during
// company discovery, where non-200s are expected and would otherwise spam logs.
export async function fetchGreenhouse(entry, { quiet = false } = {}) {
  const baseUrl = resolveApiUrl(entry);
  if (!baseUrl) throw new Error(`greenhouse: cannot derive API URL for ${entry.name}`);
  // ?content=true asks Greenhouse to include the full JD inline
  const url = baseUrl + (baseUrl.includes('?') ? '&' : '?') + 'content=true';

  let res;
  try {
    res = await fetchWithRetry(url, { redirect: 'error' }, { label: `greenhouse ${entry.name}`, tries: quiet ? 1 : 3 });
  } catch (e) {
    if (!quiet) console.error(`greenhouse: fetch failed for ${entry.name}:`, e.message);
    return [];
  }
  if (!res.ok) {
    if (!quiet) console.error(`greenhouse: HTTP ${res.status} for ${entry.name}`);
    return [];
  }

  const json = await res.json();
  const jobs = Array.isArray(json?.jobs) ? json.jobs : [];

  return jobs.filter(j => j.absolute_url).map(j => ({
    source: 'greenhouse',
    external_id: String(j.id),
    title: (j.title || '').trim(),
    company: entry.name,
    location: j.location?.name || '',
    remote: inferRemote(j.location?.name, j.title, j.content),
    comp: '',  // Greenhouse rarely exposes comp structurally
    url: j.absolute_url,
    jd: stripHtmlAndEntities(j.content || ''),
    posted_at: j.updated_at ? j.updated_at.split('T')[0] : null,
  }));
}

function inferRemote(location, title, description) {
  const s = `${location || ''} ${title || ''} ${(description || '').slice(0, 500)}`.toLowerCase();
  if (s.includes('remote')) return 'Remote';
  if (s.includes('hybrid')) return 'Hybrid';
  return 'On-site';
}

function stripHtmlAndEntities(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&rsquo;/g, "'").replace(/&lsquo;/g, "'")
    .replace(/&rdquo;/g, '"').replace(/&ldquo;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
