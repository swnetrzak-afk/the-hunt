// Shared company-name resolver for the nightly pipeline (v2.6.1) and the one-time
// backfill. JSearch fills `company` from employer_name, which for nested-board
// listings is the JOB BOARD (e.g. "vmysmartpros"), not the employer ("Chainalysis").
// The real name is in the JD text, so the same role from two boards gets two
// different (company + title) dedup keys and shows up multiple times.
//
// resolveCompanyFromJd() makes one cheap Haiku call to pull the real hiring
// company from the JD, with guardrails so it can only help, never hurt:
//   - only override when the model is confident (not a placeholder),
//   - the extracted name must actually appear in the JD text (kills hallucinations),
//   - normalize legal suffixes so "Chainalysis" and "Chainalysis, Inc." collapse
//     to the same dedup key,
//   - on ANY failure, return the fallback (source) name unchanged.
//
// Env fields consumed: anthropicKey, companyExtractModel (optional).

import { fetchWithRetry } from "./http.js";

const SYSTEM_PROMPT = `You identify the real hiring company from a job description.

Return ONLY the company's short brand name and nothing else.
- Short brand form: "Chainalysis", NOT "Chainalysis, Inc." or "Chainalysis Labs, LLC".
- The posting may come from a staffing agency, aggregator, or job board (e.g. "Jobright", "vMySmartPros", "Dice"). If the actual employer is named anywhere in the text, return the EMPLOYER, never the board or agency.
- If you cannot confidently determine the real hiring company from the text, return exactly: NONE

No preamble, no quotes, no punctuation beyond what's in the name itself.`;

// Placeholders the model emits when it can't find a real name. Mirrors the guard
// in extract-jd.js (kept local to avoid coupling a shared lib to a function handler).
const COMPANY_PLACEHOLDERS = new Set([
  "", "none", "the company", "company", "n/a", "na", "unknown", "not specified",
  "not found", "not listed", "employer", "the employer", "confidential", "undisclosed",
]);

// Trailing legal suffix, optionally comma/period-separated (", Inc.", " LLC", " Corp").
const SUFFIX_RE = /[,\s]+(inc|incorporated|llc|l\.l\.c\.|ltd|limited|corp|corporation|company|co|gmbh|plc|s\.a\.|sa|pllc|lp|llp|pvt|pte)\.?$/i;

export function isConfidentCompany(name) {
  const n = (name || "").trim().toLowerCase();
  return n.length > 0 && !COMPANY_PLACEHOLDERS.has(n);
}

// Strip a trailing legal suffix; run twice to catch stacked forms ("Foo Co, Inc.").
export function normalizeCompanyName(name) {
  let n = (name || "").trim();
  n = n.replace(SUFFIX_RE, "").trim();
  n = n.replace(SUFFIX_RE, "").trim();
  return n;
}

// True if `name` appears in the JD text, comparing on alphanumeric-only, lowercased
// forms (so "Allstate Insurance Co." matches "...Allstate Insurance..."). Legal
// suffix is stripped first. Names under 3 chars are treated as no-match to avoid
// coincidental substring hits. Conservative by design: a false positive just keeps
// the source name (safe), never corrupts it.
export function jdMentions(jd, name) {
  const n = normalizeCompanyName(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (n.length < 3) return false;
  const j = (jd || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return j.includes(n);
}

// Resolve the company to store + dedup on. Returns { company, changed, extracted }.
// `changed` is true only when the resolved name differs from `fallback` (normalized,
// case-insensitive) — useful for backfill reporting.
export async function resolveCompanyFromJd(env, jd, fallback) {
  const fallbackName = (fallback || "").trim();
  const text = (jd || "").trim();
  if (!text) return { company: fallbackName, changed: false, extracted: null };

  // Precision guard: a real employer's name appears in its own JD; board /
  // aggregator junk names (e.g. "careersprint", "vmysmartpros", a railway.app
  // URL) do not. If the current name is already present in the JD, trust it as
  // the real employer — keep it and skip the LLM. This stops the extractor from
  // "correcting" an already-correct company to some other company merely
  // mentioned in the posting (a partner, competitor, or customer example).
  if (fallbackName && jdMentions(text, fallbackName)) {
    return { company: fallbackName, changed: false, extracted: null };
  }

  let extracted;
  try {
    extracted = await callExtract(env, text);
  } catch (e) {
    console.error("resolveCompanyFromJd: extract failed:", e.message);
    return { company: fallbackName, changed: false, extracted: null };
  }

  if (!isConfidentCompany(extracted)) {
    return { company: fallbackName, changed: false, extracted: null };
  }

  const clean = normalizeCompanyName(extracted);
  // Hallucination guard: the resolved brand must appear verbatim in the JD text.
  if (!clean || !text.toLowerCase().includes(clean.toLowerCase())) {
    return { company: fallbackName, changed: false, extracted };
  }

  const changed = normalizeCompanyName(fallbackName).toLowerCase() !== clean.toLowerCase();
  return { company: clean, changed, extracted };
}

async function callExtract(env, jd) {
  const model = env.companyExtractModel || "claude-haiku-4-5";
  const res = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 30,
      system: SYSTEM_PROMPT,
      // First ~6k chars is plenty — the hiring company is named early (title,
      // "About {company}", intro). Keeps the call cheap.
      messages: [{ role: "user", content: jd.slice(0, 6000) }],
    }),
  }, { allowNonGet: true, retryStatuses: [429, 503, 529], label: 'anthropic company-extract' });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${body ? " — " + body.slice(0, 150) : ""}`);
  }
  const data = await res.json();
  // Last text block, not content[0] — tolerate a leading non-text block
  // (e.g. a thinking block) if this model is ever switched to a reasoning one.
  const textBlocks = (data?.content || []).filter(b => b.type === "text");
  const text = (textBlocks[textBlocks.length - 1]?.text || "").trim();
  // Strip any stray wrapping quotes the model may add.
  return text.replace(/^["'\s]+|["'\s]+$/g, "");
}
