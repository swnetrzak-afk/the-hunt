// Comp normalization — one home for the deterministic comp logic that used to
// (unreliably) live in the scoring model. Salary is captured as annualized
// numeric bounds at ingest; comp_ok is a pure threshold check computed in code.
//
// All values are treated as annual USD. Non-USD postings return null bounds
// (we don't compare foreign currency to a USD floor) → comp_ok 'unknown'.

// Annualize a value given a pay-period string from any source
// (JSearch 'MONTH', Built In 'HOUR', Lever 'per-hour-wage', etc.).
export function annualize(value, period) {
  const n = Number(value);
  if (value == null || value === '' || !Number.isFinite(n)) return null;
  const p = String(period || '').toLowerCase();
  let mult = 1; // default: assume already annual (year/annual/empty/unknown)
  if (/hour|hourly|hr/.test(p)) mult = 2080;        // 40h × 52wk
  else if (/week|weekly|wk/.test(p)) mult = 52;
  else if (/month|monthly/.test(p)) mult = 12;
  else if (/day|daily/.test(p)) mult = 260;         // ~5 working days × 52wk
  return Math.round(n * mult);
}

// Normalize a source's raw (min, max, period, currency) into annualized USD
// bounds for storage. Either bound may be null.
export function normalizeComp(min, max, period, currency) {
  if (currency && String(currency).toUpperCase() !== 'USD') {
    return { comp_min: null, comp_max: null };
  }
  return { comp_min: annualize(min, period), comp_max: annualize(max, period) };
}

// The deterministic comp_ok verdict. Generous by design: a range whose top
// clears the floor counts as 'yes' (you might land near the top).
export function computeCompOk(min, max, floor) {
  if (floor == null) return 'unknown';
  if (max != null) return max >= floor ? 'yes' : 'no';
  if (min != null) return min >= floor ? 'yes' : 'unknown'; // open-ended "$180K+"
  return 'unknown';
}

// Plain-English note for the scoring model, so it has qualitative comp context
// (e.g. "clears only near the top — limited negotiating room") without doing
// the arithmetic itself.
export function compNote(min, max, floor) {
  if (floor == null) return 'No comp floor set.';
  if (min == null && max == null) return 'No structured comp on this posting.';
  const f = usd(floor);
  if (min != null && max != null) {
    if (floor <= min) return `Entire posted range clears your floor (${f}).`;
    if (floor <= max) return `Clears your floor (${f}) only near the top of the range — limited negotiating room.`;
    return `Below your floor (${f}).`;
  }
  if (max != null) {
    return max >= floor ? `Top of posting (${usd(max)}) clears your floor (${f}).` : `Below your floor (${f}).`;
  }
  return min >= floor
    ? `Open-ended range starting at ${usd(min)} clears your floor (${f}).`
    : `Range starts below your floor (${f}) but is open-ended above (${usd(min)}+).`;
}

function usd(n) {
  return '$' + Number(n).toLocaleString('en-US');
}
