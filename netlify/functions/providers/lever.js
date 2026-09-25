// Lever provider — pulls full JDs via the public postings endpoint.
// Auto-detects from careers_url pattern `jobs.lever.co/{slug}`.

import { normalizeComp } from '../lib/comp.js';
import { fetchWithRetry } from '../lib/http.js';

function resolveApiUrl(entry) {
  const match = (entry.careers_url || '').match(/jobs\.lever\.co\/([^/?#]+)/);
  if (!match) return null;
  return `https://api.lever.co/v0/postings/${match[1]}?mode=json`;
}

export function detectLever(entry) {
  return !!resolveApiUrl(entry);
}

// `quiet` suppresses miss/error logging — used when probing guessed slugs during
// company discovery, where non-200s are expected and would otherwise spam logs.
export async function fetchLever(entry, { quiet = false } = {}) {
  const url = resolveApiUrl(entry);
  if (!url) throw new Error(`lever: cannot derive API URL for ${entry.name}`);

  let res;
  try {
    res = await fetchWithRetry(url, {}, { label: `lever ${entry.name}`, tries: quiet ? 1 : 3 });
  } catch (e) {
    if (!quiet) console.error(`lever: fetch failed for ${entry.name}:`, e.message);
    return [];
  }
  if (!res.ok) {
    if (!quiet) console.error(`lever: HTTP ${res.status} for ${entry.name}`);
    return [];
  }

  const json = await res.json();
  if (!Array.isArray(json)) return [];

  return json.map(j => {
    // Lever returns description fields as HTML; concatenate the structured pieces
    const jdParts = [
      j.descriptionPlain || stripHtml(j.description || ''),
      ...(Array.isArray(j.lists) ? j.lists.map(l => `${l.text || ''}\n${stripHtml(l.content || '')}`) : []),
      j.additionalPlain || stripHtml(j.additional || ''),
    ].filter(Boolean);

    return {
      source: 'lever',
      external_id: String(j.id),
      title: (j.text || '').trim(),
      company: entry.name,
      location: j.categories?.location || '',
      remote: inferRemote(j.categories?.location, j.text, jdParts.join(' ')),
      comp: j.salaryRange ? formatLeverComp(j.salaryRange) : '',
      ...(j.salaryRange ? normalizeComp(j.salaryRange.min, j.salaryRange.max, j.salaryRange.interval, j.salaryRange.currency) : {}),
      url: j.hostedUrl || j.applyUrl || '',
      jd: jdParts.join('\n\n'),
      posted_at: j.createdAt ? new Date(j.createdAt).toISOString().split('T')[0] : null,
    };
  });
}

function formatLeverComp(range) {
  const fmt = n => n >= 1000 ? `$${Math.round(n / 1000)}K` : `$${n}`;
  if (range.min && range.max) return `${fmt(range.min)}–${fmt(range.max)}`;
  if (range.min) return `${fmt(range.min)}+`;
  if (range.max) return `up to ${fmt(range.max)}`;
  return '';
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
