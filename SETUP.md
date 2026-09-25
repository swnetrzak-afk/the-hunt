# the hunt — setup

> **⚠️ Being rewritten.** This guide covers the original tracker only (Supabase `jobs` table + JD extraction). It does not yet cover the Discover pipeline — the additional schema files, Netlify env vars (`SCORING_PROMPT`, `COMPANY_SCAN_PROMPT`, source API keys, models), or the scheduled/background functions. See `README.md` for the full architecture in the meantime. Note that `import.html` (steps 3 and 6) has been removed, and `schema.sql` below is now `supabase/migrations/001_tracker_jobs.sql`; a full install runs every file in `supabase/migrations/` in numeric order.

One-time setup to wire everything together. Estimated time: ~30 minutes, mostly clicking.

## What you have

```
index.html                          → the main app (replaces job_tracker.html)
import.html                         → one-time migration from your JSON backup
schema.sql                          → run once in Supabase
netlify.toml                        → Netlify config
netlify/functions/extract-jd.js     → serverless function that calls Claude
job_tracker.html                    → original; safe to delete after migration works
jd-extract.skill                    → original skill; safe to delete (now baked into extract-jd.js)
```

## 1. Supabase — create the table (5 min)

1. Open your Supabase project → **SQL Editor** → **New query**.
2. Paste the contents of `schema.sql`. Click **Run**.
3. Verify: **Table Editor** → you should see a `jobs` table with RLS enabled (lock icon).

## 2. Supabase — enable magic-link email (2 min)

1. **Authentication** → **Providers** → **Email**.
2. Ensure "Enable Email provider" is on. "Confirm email" can stay on (default).
3. **Authentication** → **URL Configuration** → set **Site URL** to your Netlify URL (e.g. `https://hunt-yourname.netlify.app`). Add `http://localhost:8888` to Redirect URLs if you'll run Netlify Dev locally.
4. **Project Settings** → **API**. Copy two values, keep this tab open:
   - **Project URL** (looks like `https://abcdefg.supabase.co`)
   - **anon public** key (long string starting with `eyJ...`)

## 3. Paste config into the HTML (2 min)

Open `index.html` and `import.html`. In each, find these lines near the top of the `<script>` block:

```js
const SUPABASE_URL  = 'PASTE_YOUR_SUPABASE_URL_HERE';
const SUPABASE_ANON = 'PASTE_YOUR_SUPABASE_ANON_KEY_HERE';
```

Replace with the values from step 2. The anon key is safe to commit publicly — Row Level Security is what actually guards your data, and the SQL already turned it on.

## 4. Netlify — add the Anthropic key (2 min)

1. Netlify dashboard → your site → **Site settings** → **Environment variables**.
2. Add `ANTHROPIC_API_KEY` with your Anthropic key (`sk-ant-...`).
3. **Save**. (No redeploy needed yet — happens on next push.)

## 5. Commit & push (5 min)

```
git add index.html import.html schema.sql netlify.toml netlify/functions/extract-jd.js SETUP.md
git commit -m "Migrate to Supabase + Netlify Functions"
git push
```

Netlify auto-deploys. Watch the **Deploys** tab; first deploy installs the function and should finish in 1–2 min. If the function fails to build, check that `netlify/functions/extract-jd.js` is in that exact path.

## 6. Migrate your existing data (5 min)

1. Open `https://your-site.netlify.app/import.html`.
2. Sign in via magic link (check email — first time may go to spam).
3. Pick your most recent `job-tracker-backup-*.json`. Click **Import to Supabase**.
4. Watch the log. Once done, open the main app at `/` and verify your rows are there.

## 7. (Optional) Delete the original files

Once you've confirmed the imported data is correct and the app works end-to-end:
- Delete `job_tracker.html` (or move to an `archive/` folder).
- Delete `jd-extract.skill` — its prompt is baked into the Netlify Function.

## Daily use

- **Add a role**: click "+ add role" → paste JD → **Extract ✨** → review & save.
- **Mobile**: same URL works in any browser, including phone.
- **Backups**: the JSON export button still works — keep using it occasionally for belt-and-suspenders.

## Gotchas

- **Free tier auto-pause**: if you don't use the Supabase project for 7 days it pauses. One login wakes it up (~30s). No data loss.
- **Magic link redirect**: if you ever change your Netlify URL, update **Site URL** in Supabase Auth settings or the magic link will bounce you to the old URL.
- **Function errors**: visit `https://your-site/.netlify/functions/extract-jd` directly in browser — should say "Method not allowed" (it's POST-only). If it 404s, the function didn't deploy. Check Netlify's Functions tab.
- **Cost watch**: each JD extraction is ~1500 input tokens + ~500 output ≈ $0.002 on Haiku. 100 extractions = $0.20. Set a usage alert in the Anthropic console if you want a safety net.
- **Anon key is public — that's fine**: it only grants what RLS policies allow. Do NOT commit the `service_role` key (you won't need it for this app).

## Local development (optional)

If you want to test locally before pushing:

```
npm install -g netlify-cli
netlify dev
```

This serves the site at `http://localhost:8888` AND runs the Function locally. You'll need `ANTHROPIC_API_KEY` in a `.env` file at the project root (gitignored).

## When something breaks

- **Login works but rows don't appear**: open browser devtools console. Most likely the SQL in step 1 didn't run cleanly — re-run `schema.sql`.
- **"Extract" button fails**: check Netlify → Functions → extract-jd logs. Usually a missing env var.
- **Phone shows a cramped table**: known; the original CSS assumes desktop. Once you've used it a bit and know what's awkward on mobile, ask for a responsive-CSS pass.
