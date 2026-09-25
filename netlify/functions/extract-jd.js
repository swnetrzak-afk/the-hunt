// Netlify Function: POST /extract-jd
// Body: { jd: "<pasted job description text>", url?: "<source url>", sourceCompany?: "<name from listing source>" }
// Returns: { title, company, remote, comp, url, summary, requirements }
//
// Company name is extracted from the JD text itself. The listing's source name
// (sourceCompany) is only a fallback used when extraction isn't confident —
// source-API names are often abbreviated, parent-company, or missing, which also
// hurts the (company + title) dedup check on the nightly pipeline.
//
// Requires Netlify env vars: ANTHROPIC_API_KEY, plus SUPABASE_URL +
// SUPABASE_SERVICE_KEY for caller auth (lib/auth.js).
// (Set in Netlify dashboard → Site settings → Environment variables.)

import { fetchWithRetry } from "./lib/http.js";
import { authorize } from "./lib/auth.js";

const SYSTEM_PROMPT = `You extract structured fields from job descriptions for a personal job tracker.

Return ONLY a single JSON object, no prose, no markdown fencing. Schema:

{
  "title":        string,    // exact job title from the JD
  "company":      string,    // company name, or "" if not found
  "remote":       "Remote" | "Hybrid" | "On-site" | "",  // infer from location language; "" if unclear
  "comp":         string,    // salary/range/OTE as written, or "" if not listed
  "url":          string,    // echo back the URL the user provided if any, else ""
  "summary":      string,    // 3-5 bullet lines, each prefixed with "• ", separated by \\n.
                             // What the role does: scope, level, ownership, key cross-functional ties.
                             // Skip boilerplate ("collaborative culture", "fast-paced").
  "requirements": string     // 3-5 bullet lines, each prefixed with "• ", separated by \\n.
                             // What they're screening for: years/domain, specific skills/tools,
                             // hard differentiators. Skip filler ("strong communication").
}

If a field cannot be determined, use "" (empty string). Do not guess or fabricate.
Bullets must be concise — one clear thought each, no run-ons.`;

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const auth = await authorize(req, {
    supabaseUrl: Netlify.env.get("SUPABASE_URL"),
    supabaseServiceKey: Netlify.env.get("SUPABASE_SERVICE_KEY"),
  });
  if (!auth.ok) return json({ error: auth.error }, auth.status);

  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return json({ error: "ANTHROPIC_API_KEY not configured" }, 500);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const jd = (body.jd || "").trim();
  const sourceUrl = (body.url || "").trim();
  const sourceCompany = (body.sourceCompany || "").trim();
  if (!jd) return json({ error: "Missing 'jd' field" }, 400);
  if (jd.length > 25000) return json({ error: "JD too long (>25k chars)" }, 400);

  const userMessage = sourceUrl
    ? `Source URL: ${sourceUrl}\n\n---\n\n${jd}`
    : jd;

  let claudeRes;
  try {
    claudeRes = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
    }, { allowNonGet: true, retryStatuses: [429, 503, 529], label: "extract-jd" });
  } catch (e) {
    return json({ error: "Failed to reach Claude API", detail: String(e) }, 502);
  }

  if (!claudeRes.ok) {
    const detail = await claudeRes.text();
    return json({ error: "Claude API error", status: claudeRes.status, detail }, 502);
  }

  const data = await claudeRes.json();
  // Take the LAST text block, not content[0] — a response can lead with a
  // non-text block (e.g. a thinking block on Sonnet 5), which would leave
  // content[0].text undefined and break parsing.
  const textBlocks = (data?.content || []).filter(b => b.type === "text");
  const text = textBlocks[textBlocks.length - 1]?.text || "";

  // Tolerate accidental fencing or whitespace, then parse.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  let extract;
  try {
    extract = JSON.parse(cleaned);
  } catch {
    return json({ error: "Claude returned non-JSON", raw: text, stop_reason: data?.stop_reason }, 502);
  }

  // Company name: prefer the JD-extracted value when it's confident; otherwise
  // fall back to the listing's source name. "Confident" = a non-empty string that
  // isn't a generic placeholder the model emits when it couldn't find a real name.
  if (!isConfidentCompany(extract.company) && sourceCompany) {
    extract.company = sourceCompany;
  }

  return json(extract, 200);
};

const COMPANY_PLACEHOLDERS = new Set([
  "", "the company", "company", "n/a", "na", "unknown", "not specified",
  "not found", "not listed", "none", "employer", "the employer", "confidential",
]);
function isConfidentCompany(name) {
  const n = (name || "").trim().toLowerCase();
  return n.length > 0 && !COMPANY_PLACEHOLDERS.has(n);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
