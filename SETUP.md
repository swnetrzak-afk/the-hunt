# the hunt — setup

One-time setup for the full system: the Tracker, the Discover pipeline, and Triage. Plan on about an hour. Most of that is clicking through dashboards and writing your profile and prompts, which is the part that actually matters.

This is a **single-user system**. Every server-side function reads the first `user_profile` row, so one deploy serves one person. Don't share a deploy.

---

## What you need

| Account | Why | Cost |
|---|---|---|
| [Supabase](https://supabase.com) | Postgres database + magic-link auth | Free tier |
| [Netlify](https://netlify.com) | Hosting, serverless functions, the nightly schedule | Personal plan (~$9/mo). The nightly background run outgrows the free tier's function runtime. |
| [Anthropic](https://console.anthropic.com) | JD extraction, scoring, company scans, company discovery | Pay-as-you-go |
| [Adzuna](https://developer.adzuna.com) | Keyword job search | Free tier. Optional. |
| [JSearch](https://app.openwebninja.com) | Keyword job search | Free tier. Optional. |

The Muse, Himalayas, We Work Remotely, Built In, and the Greenhouse / Lever / Ashby feeds need no keys. If you skip Adzuna or JSearch, the pipeline logs a warning and skips those sources.

You'll also need your own copy of this repo (fork it, or clone it and push it to a new repo) so Netlify can deploy from it.

---

## 1. Create the Supabase project

1. Create a new project in Supabase. Any region works.
2. **Project Settings → API**. Note three values:
   - **Project URL** (`https://<project-ref>.supabase.co`)
   - **Publishable (anon) key**, which goes in the HTML and is safe to expose
   - **Secret (service_role) key**, which goes **only** into Netlify env vars and never into the repo or the browser

## 2. Run the migrations

Open **SQL Editor → New query** and run every file in `supabase/migrations/` **one at a time, in numeric order** (`001` through `013`). Each file is safe to re-run.

What to expect on a fresh project:

- **`003_tracked_companies.sql`** ends with an optional example seed. It prints the notice *"No user_profile row found"* and skips, because you haven't signed in yet. That's expected. You'll add companies from the app instead (step 7).
- **`006`, `008`, `011`** are data backfills from the system's history. On an empty database they do nothing.
- **`009`** drops columns that later migrations replaced. On a fresh install there's no data to lose.

To check it worked, open **Table Editor**. You should see `jobs`, `discovered_jobs`, `job_scores`, `tracked_companies`, `company_scans`, `user_profile`, and `pipeline_runs`, each with RLS enabled, plus the `discovered_jobs_scored` view.

`supabase/scripts/duplicate_report.sql` is not a migration. It's an optional read-only query for reviewing cross-board duplicates later.

## 3. Point the app at your project

In `index.html`, find the config near the top of the main `<script>` block and replace both placeholders with the values from step 1:

```js
const SUPABASE_URL  = 'https://YOUR-PROJECT-REF.supabase.co';
const SUPABASE_KEY = 'YOUR_SUPABASE_PUBLISHABLE_KEY';
```

Commit and push. The publishable key is meant to be public, because Row Level Security is what protects your data. `netlify.toml` already excludes `index.html` from Netlify's secrets scanner so this doesn't trip a false positive.

## 4. Deploy on Netlify

1. **Add new site → Import an existing project** → pick your repo.
2. There's no build step. `netlify.toml` already sets the publish directory (`.`), the functions directory, the URL rewrites, and the nightly schedule, so leave the build command empty.
3. Deploy, then note the site URL (`https://<your-site>.netlify.app`).
4. Upgrade the site's team to the **Personal** plan before relying on the nightly run.

## 5. Set the environment variables

**Site configuration → Environment variables.** Prompts and models live here rather than in code, so you can change them without a deploy.

**Required:**

| Var | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic key (`sk-ant-...`) |
| `SUPABASE_URL` | Project URL from step 1 |
| `SUPABASE_SERVICE_KEY` | Secret (service_role) key from step 1. It bypasses RLS, so keep it server-side only. |
| `SCORING_PROMPT` | Your scoring system prompt (see [Writing the prompts](#writing-the-prompts)). Runs fail with an error if it's unset. |
| `COMPANY_SCAN_PROMPT` | Your company-scan system prompt. Triage fails with an error if it's unset. |

**Job sources (optional):**

| Var | Value |
|---|---|
| `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` | From developer.adzuna.com |
| `JSEARCH_API_KEY` | From app.openwebninja.com |

**Tuning (optional, with the defaults shown):**

| Var | Default |
|---|---|
| `SCORING_MODEL_NIGHTLY` | `claude-haiku-4-5` |
| `SCORING_MODEL_RESCORE` | `claude-sonnet-4-6` |
| `SCORING_MAX_TOKENS_NIGHTLY` | `512` |
| `SCORING_MAX_TOKENS_RESCORE` | `1024` |
| `COMPANY_DISCOVER_PROMPT` | A built-in default (the logs say `[discover][config-fallback]` when it's used) |
| `COMPANY_DISCOVER_MODEL` | `claude-sonnet-4-6` |
| `COMPANY_EXTRACT_MODEL` | `claude-haiku-4-5` |

Functions read these on every call, so edits to prompts or models apply to the next call without a deploy. If the site was deployed before you set the variables and something still reports a variable as missing, trigger a redeploy (**Deploys → Trigger deploy**).

## 6. Configure Supabase auth

1. **Authentication → Sign In / Providers → Email**: make sure the Email provider is on.
2. **Authentication → URL Configuration**:
   - **Site URL**: your Netlify URL.
   - **Redirect URLs**: add your Netlify URL. If you'll run locally, add `http://localhost:8888` too. The magic link returns you to the page you signed in from, so every origin you use must be listed.
3. Open your site, enter your email, and click the magic link.
4. **Once you're signed in, turn off new signups** (**Authentication → Sign In / Providers → Allow new users to sign up**). The system is single-user, so nobody else should be able to create an account.

Supabase's built-in email sender is rate-limited to a few emails an hour. That's plenty for one person. If links stop arriving, check spam or wait before retrying.

## 7. Set up your profile

Open **Settings** in the app. Nothing gets scored until the profile is saved: until then, runs finish immediately and report "profile empty."

- **Candidate profile**: the most important input in the system. The README's [Your profile](README.md#your-profile) section covers what makes one work.
- **Comp floor**: annual USD. Used to compute `comp_ok` in code.
- **Search keywords**: queries for the keyword sources (Adzuna, JSearch, Built In, Himalayas). The Muse and We Work Remotely don't use keywords. They pull fixed Product categories, set in `netlify/functions/lib/run-fetch.js`, so change those if you're searching for a different kind of role.
- **Title filter**: *Required* keywords (at least one must appear in a title) and *Excluded* keywords (any one disqualifies it). This runs before scoring, so filtered titles cost nothing.
- **Dismiss reasons**: the reason list for dismissing jobs in Discover.
- **Tracked companies**: add them by name + careers URL (`https://job-boards.greenhouse.io/<slug>`, `https://jobs.lever.co/<slug>`, or `https://jobs.ashbyhq.com/<slug>`), or use **Company Discovery** to find a company's ATS for you. Discovered companies arrive disabled so you can review them first.

Optional: after adding tracked companies, re-run `006_seed_company_scans.sql`. It marks them as pre-vetted, so Triage skips the company scan for companies you've already chosen.

## 8. First run

1. In **Discover**, click **Fetch now**. It returns immediately and the run continues in the background, for up to 15 minutes. A toast appears and the list refreshes when it finishes.
2. Check **Netlify → Logs → Functions → `fetch-jobs-background`** for the per-source counts, the number of titles filtered out, and scoring errors.
3. From then on, `nightly-fetch` runs automatically at 9am UTC. To change the time, edit `schedule` under `[functions."nightly-fetch"]` in `netlify.toml`. Never add a schedule to `fetch-jobs-background`: Netlify silently skips a function that is both scheduled and background.

---

## Writing the prompts

Two prompts are yours to write. The code expects specific JSON back from each, and anything else fails to parse. Tell the model to return **only** a JSON object with no prose. Code fences are tolerated.

### `SCORING_PROMPT`

The system prompt for every scoring call, nightly and re-score. Each call's user message contains your candidate profile, then one job: title, company, location, remote type, posted comp, annualized comp with your floor and a pre-computed comp verdict, and the JD. The prompt should define how to judge fit, and it must end by requiring this shape:

```json
{
  "score": 7,
  "reason": "Two or three sentences on why.",
  "archetype": "Which of your target role types this is",
  "ramp_cost": "low"
}
```

- `score`: integer 1–10 (clamped to that range).
- `ramp_cost`: exactly `"high"`, `"low"`, or `"n/a"`. Any other value is stored as null.
- `comp_ok` is **not** asked of the model. The code computes it from the posted comp and your floor.

### `COMPANY_SCAN_PROMPT`

The system prompt for Triage's company go/no-go. The model gets the company name and up to two web searches. It must return:

```json
{
  "verdict": "thumbs_up",
  "bottom_line": "One-sentence summary of the call.",
  "what_they_do": "…",
  "financial_health": "…",
  "remote_culture": "…",
  "red_flags": "…"
}
```

- `verdict` must be exactly `"thumbs_up"` or `"thumbs_down"`, or the scan is rejected.
- The other fields are shown in the scan panel. Leave one out and it's just blank.

Company scans use Anthropic's web search tool. If scans fail with a web-search error, check that web search is enabled for your organization in the Anthropic Console.

`COMPANY_DISCOVER_PROMPT` is optional. The built-in default is a reasonable start.

---

## Local development

```bash
npm install -g netlify-cli
```

```bash
netlify dev
```

This serves the app at `http://localhost:8888` and runs the functions locally (the scheduled trigger doesn't fire locally; use **Fetch now**). Create a `.env` at the repo root with the same variables as step 5. Multi-line prompts need to be quoted. `.env` is listed in `.gitignore`; keep it that way.

A local run writes to the same Supabase project as production. There is no separate dev database unless you create one.

---

## Security notes

- **RLS** limits the browser to your own rows. The publishable key being public is by design.
- **The service key** lives only in Netlify env vars. Server-side functions use it and set `user_id` explicitly on every insert.
- **Disable signups** after your first sign-in (step 6).

---

## When setup goes wrong

| Symptom | Likely cause |
|---|---|
| Magic link never arrives | Spam folder, or Supabase's email rate limit. Wait and retry. |
| Magic link lands on an error page | That origin isn't in Supabase's **Redirect URLs** (step 6). |
| Signed in, but nothing loads | `SUPABASE_URL` / `SUPABASE_KEY` in `index.html` still hold placeholders or point at the wrong project. Check the browser console. |
| Migration fails with "relation does not exist" | Files were run out of order. Re-run from `001`; every file is safe to re-run. |
| Fetch now completes instantly with nothing new | The profile text is empty (the run records "profile empty"), or `SCORING_PROMPT` is unset. Check the function logs. |
| Jobs appear but have no scores | The model didn't return the JSON shape above. The logs show `score JSON parse failed` with the raw response. |
| Triage scan returns an error | `COMPANY_SCAN_PROMPT` is unset, the model returned an invalid `verdict`, or web search isn't enabled for your Anthropic organization. |
| A function reports an env var as missing after you set it | Trigger a redeploy (step 5). |

For day-to-day troubleshooting and how to change things once you're running, see the README's [When something breaks](README.md#when-something-breaks) and [How to change things](README.md#how-to-change-things).
