// Shared HTTP helper — one retry policy for every outbound call in the pipeline.
//
// Transient upstream failures (Adzuna 503, JSearch 504, Anthropic 529, network
// blips) were previously swallowed per-source with no retry, so a momentary hiccup
// cost a whole source for the night. fetchWithRetry centralizes the policy:
// retry only genuinely transient signals, with exponential backoff + jitter.
//
// Idempotency guard: retries are enabled by default ONLY for GET/HEAD, so this
// can never accidentally replay a write (POST/PUT/PATCH/DELETE). Non-GET callers
// that ARE safe to retry (e.g. the Anthropic Messages API — same input, we just
// want one result) must opt in explicitly with { allowNonGet: true }.
//
// Returns the final Response (which may be !ok — the caller still handles
// non-retryable statuses like 400/401/404 itself). Throws only if a network
// error persists past the last attempt.

const DEFAULT_RETRY_STATUSES = [429, 502, 503, 504];
const MAX_RETRY_AFTER_MS = 10_000;   // ignore absurd Retry-After values

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function fetchWithRetry(url, opts = {}, cfg = {}) {
  const {
    tries = 3,
    baseDelay = 500,
    retryStatuses = DEFAULT_RETRY_STATUSES,
    allowNonGet = false,
    label = '',
  } = cfg;

  const method = (opts.method || 'GET').toUpperCase();
  const retriable = allowNonGet || method === 'GET' || method === 'HEAD';

  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, opts);
      if (res.ok) return res;
      // Non-retryable status (4xx, or anything not in the transient list), or
      // we've used our last attempt → hand the response back for the caller to log.
      if (!retriable || !retryStatuses.includes(res.status) || attempt === tries) {
        return res;
      }
      const delay = retryAfterMs(res) ?? backoffMs(baseDelay, attempt);
      console.warn(`${label || url}: HTTP ${res.status}, retry ${attempt}/${tries - 1} in ${delay}ms`);
      await sleep(delay);
    } catch (e) {
      lastErr = e;
      if (!retriable || attempt === tries) throw e;
      const delay = backoffMs(baseDelay, attempt);
      console.warn(`${label || url}: ${e.message}, retry ${attempt}/${tries - 1} in ${delay}ms`);
      await sleep(delay);
    }
  }
  // Unreachable in practice (loop either returns or throws), but satisfies control flow.
  throw lastErr;
}

// Exponential backoff with additive jitter: ~base, ~2×base, ~4×base (+0–base random).
function backoffMs(base, attempt) {
  return Math.round(base * 2 ** (attempt - 1) + Math.random() * base);
}

// Honor a Retry-After header on 429s (integer seconds only; capped). Returns ms or null.
function retryAfterMs(res) {
  const h = res.headers?.get?.('retry-after');
  if (!h) return null;
  const secs = Number(h);
  if (!Number.isFinite(secs) || secs < 0) return null;
  return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
}
