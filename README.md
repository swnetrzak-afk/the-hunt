# the hunt — personal job discovery and tracking system

A self-hosted, private job search platform. Built as a single-page app with Supabase for storage, Netlify for hosting and serverless functions, and Claude for JD extraction, job scoring, and company evaluation.

The tracker started as a simple application log. The Discover pipeline was added to surface relevant jobs nightly without manual sourcing. They're two tabs in one app — you can use one without the other, but they're better together.

Designed for personal use — one instance per deploy, configured to your background and preferences. The infrastructure is generic. The configuration is what makes it yours.

<img width="1758" height="1073" alt="the hunt — job tracker-screenshot" src="https://github.com/user-attachments/assets/4981837b-ee1e-411b-881f-87c00a02c588" />

<img width="1758" height="1073" alt="the hunt — job discover-screenshot" src="https://github.com/user-attachments/assets/8bbcb066-d4b5-409e-aa87-13d86149af12" />

---

## Contents

**Using it**
- [What this is](#what-this-is)
- [The Tracker tab](#the-tracker-tab)
- [The Discover tab](#the-discover-tab)
- [The Triage flow](#the-triage-flow)
- [Setup](#setup)

**Making it yours**
- [Your profile](#your-profile)
- [Title filters and comp floor](#title-filters-and-comp-floor)
- [Tracked companies](#tracked-companies)

**Reference**
- [Architecture](#architecture)
- [Files](#files)
- [How auth works](#how-auth-works)
- [How scoring works](#how-scoring-works)
- [Data model](#data-model)
- [Environment variables](#environment-variables)
- [Local development](#local-development)
- [Deployment](#deployment)
- [When something breaks](#when-something-breaks)
- [How to change things](#how-to-change-things)

**About**
- [Design notes](#design-notes)
- [Architecture history](#architecture-history)
- [The simple version](#the-simple-version)

---

## What this is

A private, mobile-accessible web app for running a job search without drowning in manual sourcing. Two tabs: the Tracker, where you manage applications, and Discover, where jobs that match your profile surface nightly from multiple sources, already scored for relevance.

Each tracked role has title, company, status, comp, contact, notes, JD summary, key requirements, and a status history. Pasting a job description auto-fills most fields via Claude. Saved jobs from Discover link back to their source row so the full scoring record travels with them.

The Discover pipeline pulls nightly from six job boards and APIs — keyword search (Adzuna, JSearch), category-based remote boards (The Muse, Himalayas, We Work Remotely), and a Built In scrape — plus direct Greenhouse, Lever, and Ashby feeds for the companies you track. It filters by title and location rules, deduplicates across sources, and scores each role against your candidate profile using Claude. Only jobs above a configurable score threshold are shown. A nightly run you don't have to think about; a morning review that takes minutes.

---

## The Tracker tab

Add, edit, and track applications. Click **+ Add Role** to open the form — paste a JD and hit **Extract ✨** to auto-fill title, company, comp, remote type, a bulleted summary, and key requirements. Anything already typed is preserved. Change status via the edit view; each change appends to the status history automatically.

Company names throughout the Tracker are clickable — one click opens the saved company scan, or runs a fresh one if none exists.

**Header controls:** Triage · Company Scans · Export ▾ · Settings on the left; your email + Sign out on the right.

**Export:** CSV (selectable columns) or JSON backup. Save the JSON to Google Drive occasionally — the Supabase free tier doesn't include point-in-time recovery.

---

## The Discover tab

Jobs from the nightly pipeline plus manual triage entries, sorted by score. Look for ⭐ flagged roles first — those came from your tracked companies list and are the highest signal.

- **Save** moves a job to the Tracker with a link back to its score record.
- **Dismiss with reason** — the reason list is configurable in Settings. Dismissal patterns are worth reviewing periodically to tune your profile or filters.
- **Re-score** runs the job through Sonnet instead of Haiku for a more careful read when a score doesn't match your instinct.
- **Show original scores** in the toolbar compares the Haiku (nightly) and Sonnet (re-score) reads side by side.
- **Fetch now** triggers a manual run. Don't run it repeatedly in quick succession — background functions have runtime limits on the Netlify Personal plan.

A pipeline status indicator shows whether the last run completed, is in progress, or errored. The list auto-refreshes when a manual run finishes.

---

## The Triage flow

For roles you find outside the pipeline — LinkedIn, a referral, a job board you checked manually. Click **Triage** in the header.

1. Paste a company name → get a web-search-backed go/no-go on the company (culture signals, recent news, Glassdoor patterns).
2. Thumbs up → paste the JD → get a score against your profile using the same logic as the nightly run.
3. The result lands in Discover with `entry_source='manual'` alongside pipeline jobs.

The company scan prompt (`COMPANY_SCAN_PROMPT`) is worth customizing — it controls what the model surfaces in each evaluation. What constitutes a green or red flag varies by person; telling the model explicitly what to look for (leadership signals, recent layoff patterns, Glassdoor themes that matter to you, growth trajectory) makes the go/no-go more useful than a generic company overview.

One saved company scan per company. Clicking a company name anywhere in the app opens the existing scan or runs a fresh one.

---

## Setup

One-time setup takes about an hour. See **SETUP.md** for the full walkthrough — Supabase project, schema files (run in order), Netlify deploy, environment variables.
There are more moving parts than the simple tracker version, and scoring won't work until you've set your candidate profile in Settings and your scoring and company-scan prompts in Netlify env vars.

The one ongoing cost: Netlify Personal plan (~$9/mo). The nightly background function runs for several minutes; the free tier runtime limit is easily exceeded in normal daily use. Everything else runs on free tiers or pay-as-you-go at low volume.

---

## Your profile

The profile is the heart of the system. It lives in Settings and is read by the scoring engine on every nightly run and every re-score. It's not just context — it's constraint.

The model's default is generosity. Without explicit guidance, it will find everything adjacent to everything. A role that needs deep domain expertise in field A and a role that needs domain expertise in field B are equally distant from your background — but a generous model will treat both as close enough if you let it. The profile is what fixes that.

**What makes a profile actually work:**

*Target role archetypes.* Not just "PM roles" — the specific shapes you're looking for, and what each one would be buying from you. If you'd frame your background differently for different role types, the profile is where you make that explicit. The scoring engine applies it consistently.

*Hard filters with anti-softening language.* Comp floor, location requirements, role type disqualifiers. The important detail: the model will soften hard requirements unless you tell it not to. "Remote" language in a JD doesn't override a role based in another city or country unless you tell the model that explicitly. Make disqualifying conditions unambiguous, and instruct the model not to let positive signals elsewhere in the JD override them.

*Positive signals.* What to weight toward, not just what to filter out. Green flags — ownership language, small teams with real autonomy, domains you're excited about — need to be named or the scoring becomes just a list of disqualifiers.

*Skills inventory, including what you don't have.* The hard-no list matters as much as the skills you have. Without it, the model will pattern-match around gaps rather than flag them. If a role requires a skill you've never touched, you want a low score — not a generous inference that your adjacent experience probably transfers.

*Your narrative framing.* How you'd actually describe your background for different role types. The model will be consistent with whatever you tell it — so tell it how you actually want to sound, and what you want emphasized or not.

**Format doesn't matter.** Markdown, prose, structured tables — whatever helps you think through the content. The structure serves the content, not the other way around.

**Length and specificity help.** A longer, detailed profile produces sharper scores than a short one. It's also the caching anchor for the nightly run: the scoring system prompt and your profile are sent as a single cached block, so every job in a run is scored against the same you, and the cache prefix is read at a fraction of the cost after the first job. The primary benefit is accuracy. The caching economics are a side effect.

---

## Title filters and comp floor

Set in Settings. Simple but important.

**Required keywords** — at least one must appear in the title. `Product Manager`, `Director of Product`, `Head of Product`, etc. Tune to what you're actually looking for.

**Excluded keywords** — any of these disqualifies the role regardless of other signals. `Program Manager`, `Project Manager`, `Scrum Master` — whatever shows up as noise in your results.

**Comp floor** — one number. Jobs below it score as a hard disqualifier regardless of everything else. The scoring engine normalizes comp ranges from JDs and checks against this floor; the `comp_ok` flag on each job records whether it passed. Jobs without a posted salary are not penalized — they're treated as unknown and passed through rather than scored down.

The title filter runs before scoring, so filtered titles never reach the model. The comp floor is enforced inside the scoring prompt.

---

## Tracked companies

Companies you want to hear from specifically, regardless of whether they surface through the broad keyword sources. The pipeline checks their ATS feeds directly (Greenhouse, Lever, and Ashby are supported) and ⭐ flags any roles from these companies in Discover.

Add tracked companies in Settings — name, careers page URL, and the ATS provider. The **Company Discovery** flow can help you build this list. There are two modes: paste a list of company names and the pipeline probes for their ATS slugs; or use auto-suggest, where Claude generates candidates in your domains — seeded with your existing tracked companies as "more like these" and excluding them — and probes those. Both modes add disabled rows for your review before they go active. The auto-suggest prompt lives in `COMPANY_DISCOVER_PROMPT`.

A tracked company returning zero jobs is usually normal (no open roles right now) or occasionally means the company migrated ATS providers. Check the careers URL if it persists.

---

## Architecture

```
  Browser (any device)
        │
        │  HTTPS
        ▼
  ┌───────────────────────────────────────────┐
  │  Netlify                                  │
  │  ├─ index.html (static)                   │
  │  ├─ /extract-jd     ◄── Netlify Function  │
  │  ├─ /score-job      ◄── Netlify Function  │
  │  ├─ /company-scan   ◄── Netlify Function  │
  │  ├─ /discover-companies ◄ Background      │
  │  ├─ /run-fetch      ◄── Netlify Background│
  │  │      Function (manual "Fetch now")     │
  │  └─ nightly-fetch   ◄── Scheduled (9am)  │
  │         async-fires the background func   │
  │      (every function: authorize() first;  │
  │       all outbound calls: fetchWithRetry) │
  │         │                                 │
  │         │ x-api-key                       │
  │         ▼                                 │
  │      Anthropic API                        │
  │      (Haiku for bulk scoring + caching,   │
  │       Sonnet for re-score & triage,       │
  │       web_search for triage)              │
  └───────────────────────────────────────────┘
        │                          ▲
        │ supabase-js              │ REST (service key)
        │ (REST + auth)            │
        ▼                          │
  ┌───────────────────────────────────────────┐
  │  Supabase                                 │
  │  ├─ auth.users (magic link)               │
  │  ├─ public.jobs                           │
  │  ├─ public.discovered_jobs                │
  │  ├─ public.job_scores                     │
  │  │    └─ view: discovered_jobs_scored     │
  │  ├─ public.tracked_companies              │
  │  ├─ public.company_scans                  │
  │  └─ public.user_profile                   │
  │       └─ RLS: user_id = auth.uid()        │
  └───────────────────────────────────────────┘
        ▲
        │
  Sources → Adzuna · JSearch · Built In · The Muse ·
            Himalayas · We Work Remotely ·
            tracked ATS: Greenhouse · Lever · Ashby
            (auto-expand via /discover-companies)
```

| Service | Role | Cost |
|---|---|---|
| Netlify | Static hosting + serverless functions + scheduled function | Personal plan (~$9/mo) |
| Supabase | Postgres database + auth (magic link) | Free |
| Anthropic | Claude Haiku for bulk scoring, Sonnet for re-score + triage | Pay-as-you-go |
| Adzuna | Job search API (keyword-driven, US endpoint) | Free tier (1K calls/mo) |
| JSearch | Job search API via openwebninja.com | Free tier (~200 req/mo) |
| Built In | HTML scraping + schema.org JobPosting JSON-LD parsing | Free, no auth |
| The Muse | Category-filtered remote board (`Product Management`) | Free, no auth |
| Himalayas | Remote-jobs search API with structured salary data | Free, no auth |
| We Work Remotely | Product-category RSS | Free, no auth |
| Greenhouse / Lever / Ashby | Direct ATS feeds for tracked companies | Free, no auth |

**Why Netlify Personal plan:** The nightly background function runs for several minutes scoring jobs. The free tier has a hard monthly runtime limit easily exceeded in normal daily use.

**Why two models:** Haiku is fast and cheap, suitable for first-pass scoring of hundreds of jobs nightly. Sonnet is used for the Re-score button and triage flow because nuanced role-fit judgment — whether a role's actual scope, culture, and trajectory match what you're looking for, not just whether keywords line up — benefits from more careful reasoning.

**Prompt caching on the nightly path:** The scoring system prompt + candidate profile is sent as a single `cache_control: ephemeral` block. The first job in a run pays a 1.25× write premium; subsequent jobs read the cached prefix at 0.1×. The cost savings on a long run are real; more importantly, caching ensures every job is scored against exactly the same profile and prompt, with no drift across the run.

---

## Files

```
index.html                                          → main app (Tracker + Discover tabs + Triage modal)
supabase/migrations/                                → database schema — run every file in numeric order
  001_tracker_jobs.sql                              → jobs table + RLS policies (the original tracker)
  002_discovery.sql                                 → discovered_jobs + user_profile
  003_tracked_companies.sql                         → tracked companies + title filter + example seed (replace with your own companies)
  004_dismiss_reason.sql                            → dismiss_reason column on discovered_jobs
  005_triage_company_scans.sql                      → tracker_id / ramp_cost / entry_source + company_scans
  006_seed_company_scans.sql                        → marks enabled tracked companies as pre-vetted in company_scans
  007_job_scores.sql                                → job_scores table + discovered_jobs_scored view + RLS
  008_job_scores_backfill.sql                       → backfill pre-v2.5 scores into job_scores (no-op on a fresh install)
  009_drop_legacy_score_columns.sql                 → drop old scoring columns from discovered_jobs
  010_comp_normalization.sql                        → comp_floor + comp_min/comp_max + view
  011_comp_backfill.sql                             → backfill numeric comp bounds (no-op on a fresh install)
  012_dismiss_reasons_config.sql                    → dismiss_reasons config on user_profile
  013_pipeline_runs.sql                             → pipeline_runs table (run status + summary)
supabase/scripts/duplicate_report.sql               → optional read-only query for cross-board duplicate rows
netlify.toml                                        → build / function routing / schedule
netlify/functions/extract-jd.js                     → POST JD → Claude → extracted JSON fields
netlify/functions/score-job.js                      → POST job_id → score via shared lib → job_scores event
netlify/functions/company-scan.js                   → POST company_name → Sonnet + web_search → verdict
netlify/functions/discover-companies-background.js  → paste/auto-suggest → detect ATS → add tracked_companies rows
netlify/functions/fetch-jobs-background.js          → background wrapper → runs lib/run-fetch
netlify/functions/nightly-fetch.js                  → scheduled function (9am UTC) → fires background func
netlify/functions/lib/run-fetch.js                  → fetch + filter + score pipeline
netlify/functions/lib/auth.js                       → authorize(): caller auth for every function endpoint
netlify/functions/lib/http.js                       → shared fetchWithRetry (one retry policy for all sources)
netlify/functions/lib/discover.js                   → company-discovery: ATS slug probe + web_search fallback
netlify/functions/lib/score.js                      → shared scoreJob() + writeJobScore()
netlify/functions/lib/comp.js                       → comp logic: annualize / normalize / computeCompOk
netlify/functions/lib/company.js                    → company-name recovery from JD text (cross-board dedup)
netlify/functions/providers/greenhouse.js           → Greenhouse boards-api adapter
netlify/functions/providers/lever.js                → Lever postings adapter
netlify/functions/providers/ashby.js                → Ashby posting-api adapter
SETUP.md                                            → one-time setup instructions
README.md                                           → this file
```

---

## How auth works

1. Enter email → Supabase emails a magic link.
2. Click link → browser receives a session token, stored in localStorage by `supabase-js`.
3. Token includes your `user_id` (UUID).
4. Every DB query carries the token; Postgres uses RLS policies to filter rows where `user_id = auth.uid()`.

- The "anon" / "publishable" Supabase key is in the HTML and safe to publish — RLS is what actually protects data.
- The `service_role` key is used only by server-side Netlify Functions, never in client code. Set it in Netlify env vars.
- New-user signups should be **disabled** in the Supabase dashboard after you create your account. The login form is then sign-in only.

**Function endpoints are authenticated too.** RLS covers the browser's database queries, but the Netlify Functions use the service key and spend Anthropic credits, so each one calls `authorize()` (`lib/auth.js`) before doing any work:

- **Browser → function:** `apiFetch()` in `index.html` attaches the session token. `authorize` validates it with Supabase Auth, then requires the caller to own the `user_profile` row. That way an account created by mistake still can't drive the system.
- **Nightly trigger → pipeline:** `nightly-fetch` has no user session, so it sends an HMAC token keyed by `SUPABASE_SERVICE_KEY`. That needs no extra env var, and the key itself never goes over the wire. Only `fetch-jobs-background` accepts it.

---

## How scoring works

Each job goes through scoring at two possible points:

**Nightly (Haiku):** The scoring system prompt and your candidate profile are cached at the start of each run. Each job's title, company, JD summary, comp, and location are sent against that cached prefix. The model returns a score (1–10), a `ramp_cost` estimate (how much runway this role would realistically need before meaningful contribution — useful signal for roles that look good on paper but require heavy domain ramp), and a brief rationale. The `comp_ok` flag is computed separately in code: posted comp is normalized and checked against your floor. Jobs without a posted salary pass through rather than being penalized. Jobs below your configured score threshold are hidden in Discover by default.

**Re-score (Sonnet):** On demand, via the Re-score button on any Discover card. Uses the stronger model for cases where the nightly score doesn't match your read. Both scores are kept in `job_scores` with model provenance. The Discover toolbar has a "show original scores" toggle to compare them.

The scoring prompt lives in the Netlify environment variable `SCORING_PROMPT`, not in the codebase. Edit it in the Netlify dashboard and it takes effect on the next run — no deploy needed. The candidate profile lives in Settings, same deal.

---

## Data model

| Table | Purpose |
|---|---|
| `jobs` | Tracked applications — everything in the Tracker tab |
| `discovered_jobs` | Incoming jobs from the nightly pipeline and triage flow |
| `job_scores` | Score events — one row per scoring, with model provenance |
| `tracked_companies` | Companies with direct ATS monitoring |
| `company_scans` | Triage and scan results per company |
| `user_profile` | Settings, candidate profile, keywords, title filter, dismiss reasons |
| `pipeline_runs` | Run status and summary for each nightly or manual fetch |

`discovered_jobs_scored` is a view joining `discovered_jobs` and the latest `job_scores` event — that's what the Discover tab queries.

Saved jobs link back to their `discovered_jobs` row via `tracker_id`, so the full scoring record (source, score, rationale, model) travels with the application through to outcome.

---

## Environment variables

Set in Netlify → Site settings → Environment variables. Never in the repo.

| Var | Used by | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | All functions | `sk-ant-...` |
| `SUPABASE_URL` | All functions | Project URL. Also used for caller auth. |
| `SUPABASE_SERVICE_KEY` | All functions | Secret key. Bypasses RLS for server-side writes, and keys the nightly trigger's internal token. If you rotate it, redeploy. |
| `SCORING_PROMPT` | `fetch-jobs-background`, `score-job` | The scoring system prompt. Multi-line. Edit here to update scoring without a deploy. Fail-hard if unset. |
| `SCORING_MODEL_NIGHTLY` | `fetch-jobs-background` | Optional. Defaults to `claude-haiku-4-5`. |
| `SCORING_MODEL_RESCORE` | `score-job` | Optional. Defaults to `claude-sonnet-4-6`. |
| `SCORING_MAX_TOKENS_NIGHTLY` | `fetch-jobs-background` | Optional. Defaults to `512`. |
| `SCORING_MAX_TOKENS_RESCORE` | `score-job` | Optional. Defaults to `1024`. |
| `COMPANY_SCAN_PROMPT` | `company-scan` | Triage stage-1 system prompt. Multi-line. Fail-hard if unset. |
| `COMPANY_DISCOVER_PROMPT` | `discover-companies-background` | Optional. Built-in default used if unset (logged as `[discover][config-fallback]`). |
| `COMPANY_DISCOVER_MODEL` | `discover-companies-background` | Optional. Defaults to `claude-sonnet-4-6`. |
| `COMPANY_EXTRACT_MODEL` | `fetch-jobs-background` | Optional. Defaults to `claude-haiku-4-5`. |
| `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` | `fetch-jobs-background` | From developer.adzuna.com |
| `JSEARCH_API_KEY` | `fetch-jobs-background` | From app.openwebninja.com |

Built In, Greenhouse, Lever, and Ashby require no API keys — public endpoints. The Supabase URL + publishable (anon) key are set directly in `index.html` (replace the `YOUR-PROJECT-REF` / `YOUR_SUPABASE_PUBLISHABLE_KEY` placeholders) and are safe to commit.

---

## Local development

```bash
npm install -g netlify-cli
netlify dev
```

Serves at `http://localhost:8888` and runs functions locally. Requires a `.env` file at the project root (gitignored) with all env vars above, including the multi-line `SCORING_PROMPT` and `COMPANY_SCAN_PROMPT`.

---

## Deployment

Git push to main → Netlify auto-deploys (~1 min). Function changes take effect on the same push. The scheduled function picks up any changes on the next run.

**Prompt changes don't require a deploy** — `SCORING_PROMPT` and `COMPANY_SCAN_PROMPT` are read at function-invocation time. Edit the env var in Netlify, save, and the next call uses the new prompt.

To roll back: Netlify → Deploys → pick a previous deploy → **Publish deploy**. Note: env var changes are not part of the deploy artifact — rolling back code does not roll back prompt changes.

---

## When something breaks

| Symptom | Likely cause / fix |
|---|---|
| Login email never arrives | Check spam. Verify Supabase Auth → URL Configuration → Site URL matches live URL. |
| Logged in but tracker is empty | RLS sees a different user_id. Sign out and back in with the correct email. |
| Extract button hangs | Netlify Functions → `extract-jd` logs. Usually a missing/expired `ANTHROPIC_API_KEY`. |
| Nightly run returns 500 "SCORING_PROMPT not configured" | Env var is unset or empty. Set it in Netlify → Environment variables. No silent fallback by design. |
| Triage scan returns 500 "COMPANY_SCAN_PROMPT not set" | Same — set the env var. |
| Discover tab empty after fetch | Check that profile text is set in Settings. The function skips scoring if empty. |
| Nightly run all-jobs-unscored | Most likely a rate-limit breach. Check Anthropic console for input-token-per-minute quota. Prompt caching should keep this in check — verify cache is activating (`cache_read_input_tokens > 0` in any run). |
| No Adzuna results | Check `ADZUNA_APP_ID` / `ADZUNA_APP_KEY`. Transient 503s are retried by `fetchWithRetry`; a persistent 503 across all keywords = Adzuna outage, wait it out. |
| Near-zero JSearch results | JSearch relevance degraded (Aug 2026). Volume now comes primarily from The Muse + tracked ATS. Not a config problem. |
| No Built In results | Likely a site structure change on their side. The JSON-LD parser is the most fragile piece. |
| Tracked company returns 404 | Provider likely changed. Check the current careers page and update `careers_url` + `provider` in Settings. |
| Tracked company returns 0 jobs | Usually normal (no open roles) or a provider change. Check `careers_url` is still valid. |
| Title filter too aggressive | Remove keywords from Excluded or add more to Required. Logs show "title-filtered out: N" per run. |
| Too many duplicate jobs | Dedup matches on `(company + title)`. Slight title variation slips through — dismiss manually. |
| Nightly volume near-zero, run finishes in ~100ms | The fetch function is both scheduled and background — an unsupported Netlify combination that silently no-ops the run. The `schedule` must live on `nightly-fetch` only; `fetch-jobs-background` must not have one. |
| "Fetch now" returns 403 Forbidden | Same root cause — the `/run-fetch` rewrite is hitting a scheduled function. HTTP invocation of scheduled functions is forbidden in production. |
| Re-score returns blank "score JSON parse failed" | A thinking-capable model (e.g. Sonnet 5) led with a thinking block, leaving `content[0]` empty. All Claude calls should parse the last text block, not the first. |
| Supabase project paused | Free tier pauses after 7 days idle. Log in → resumes in ~30s. No data loss. |
| Netlify usage limit hit | Avoid repeated manual "Fetch now". Normal daily use stays within the Personal plan. |

---

## How to change things

| Change | Where |
|---|---|
| Tune scoring prompt | Netlify env vars → `SCORING_PROMPT`. No deploy needed. |
| Tune candidate profile | Settings → edit profile text → Save. Next run uses it. |
| Tune company scan prompt | Netlify env vars → `COMPANY_SCAN_PROMPT`. No deploy needed. |
| Switch scoring model | Netlify env vars → `SCORING_MODEL_NIGHTLY` / `SCORING_MODEL_RESCORE`. No deploy needed. |
| Change score display threshold | `index.html` → `<select id="dscoreF">` → change default `<option>`. |
| Add a new tracked company | Settings → Tracked Companies → fill name + URL → Add. |
| Change search keywords or title filter | Settings → edit keywords / Required / Excluded → Save. |
| Add / change a dismiss reason | Settings → Dismiss Reasons. No code, no deploy. |
| Add a new broad job source | `lib/run-fetch.js` → add fetch function + wire into `runFetch`. |
| Add a new ATS provider | Create `providers/{name}.js` exporting `detect` + `fetch`. Register in `PROVIDERS` map. |
| Change the nightly schedule | `netlify.toml` → `[functions."nightly-fetch"]` `schedule`. Never put a `schedule` on `fetch-jobs-background`. |
| Change the 30-day import cutoff | `lib/run-fetch.js` → `DAYS_OLD` constant. |
| Change the 45-day display cutoff | `index.html` → `DISPLAY_CUTOFF_DAYS` constant. |
| Restyle | `<style>` block in `index.html`. |

---

## Design notes

- **Magic-link auth + RLS** is the simplest way to put a personal tool on the internet safely. Auth proves who you are; RLS controls what you see. Two separate layers — the anon key being public is intentional, not a mistake.
- **Serverless functions are the right home for API keys.** Browser code can't be trusted with secrets; functions can.
- **The scheduled/background function split is load-bearing.** Netlify does not support a single function that is both scheduled and background. The schedule lives on `nightly-fetch` only; it fires `fetch-jobs-background`, which does the actual work. Collapsing them back into one silently no-ops the scheduled run and returns 403 on the manual button.
- **Prompt caching is worth the setup.** Scoring hundreds of jobs nightly against the same profile means paying the cache write premium once and reading at 0.1× for the rest of the run. The cost savings are real; the more important property is consistency — every job in a run is scored against exactly the same context.
- **Scoring prompts live in env vars by design.** Being able to tune scoring without a deploy is a real operational benefit. The prompts are the most-iterated part of the system — treating them as configuration rather than code reflects how they're actually used.
- **Two models, one decision:** Haiku for volume, Sonnet for judgment. Nuanced role-fit reasoning — whether the actual scope, culture, and trajectory of a role match what you're looking for — benefits from the stronger model. Nightly first-pass scoring at scale does not.

---

## Architecture history

The system grew in distinct phases, each addressing a real limitation.

**v1 — tracker only.** Single `jobs` table, magic-link auth, JD extraction via Claude. One Netlify function. Runs entirely on free tiers. The simple version is still available as a separate repo — see below.

**v2 — discovery pipeline.** Added the Discover tab with nightly job fetching from Adzuna, JSearch, and Built In. Scoring against a candidate profile using Claude Haiku. Manual triage flow for roles found outside the pipeline, with a company scan stage powered by Sonnet and web search. The scoring prompt moved to Netlify env vars so it could be tuned without a deploy. Ramp cost added to scoring output. Tracked companies added with direct ATS feeds (Greenhouse, Lever, Ashby).

**v2.5 — score history.** The `job_scores` table replaced in-place scoring columns on `discovered_jobs`, keeping every scoring event with model provenance. `scoreJob()` consolidated into a shared lib used by both the nightly path and on-demand re-score. Scoring model configurable via env var. Discover gained a side-by-side score comparison view (Haiku vs. Sonnet).

**v2.6 — UX and configuration.** Dismiss reasons became configurable in Settings — no code, no deploy. Company names throughout the app became clickable (one click to the scan, or run a fresh one inline). Company Scans panel added to the header. Auto-extract on Save to Tracker. Company name recovery from JD text added to fix cross-board deduplication failures caused by board mislabeling.

**Source diversification (Sep 2026).** JSearch relevance collapsed (~80% volume drop). Three changes in response: The Muse added as a category-based remote source that structurally avoids keyword-relevance noise and became the primary broad source. `fetchWithRetry` introduced as a shared retry policy across all sources and Anthropic calls, after transient failures were being swallowed silently. Company Discovery added to auto-detect a company's ATS by probing guessed slugs with web_search fallback, so the tracked company list can grow without manual URL hunting.

**Himalayas + We Work Remotely (Sep 2026).** Himalayas added via its `/jobs/api/search` endpoint, which returns structured salary data enabling real `comp_ok` evaluation. WWR added via Product category RSS as a low-yield supplement. Supabase dedup query moved through `fetchWithRetry` after a 504 was silently disabling deduplication for an entire run.

**Pipeline visibility (Sep 2026).** `pipeline_runs` table added for run status and logging. Client-side polling for run completion with auto-refresh of Discover on finish and toast notifications. Parse fix for thinking-capable models (Sonnet 5) that lead with a non-text content block.

**Operational fix (Aug 2026).** The nightly fetch function was both scheduled and background — an unsupported Netlify combination that silently no-op'd the scheduled run for several days and returned 403 on the manual Fetch now button. Split into `nightly-fetch` (scheduled trigger) → `fetch-jobs-background` (background worker) → `lib/run-fetch` (shared pipeline). No pipeline logic changed.

---

## The simple version

The tracker-only version — no discovery pipeline, no scoring, runs entirely on free tiers — is a separate, simpler repo: **[job-tracker-supabase-netlify](https://github.com/swnetrzak-afk/job-tracker-supabase-netlify)**. If the full pipeline is more than you need, or you want to understand the foundation before adding the discovery layer, start there.
