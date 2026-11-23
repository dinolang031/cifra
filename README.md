# CIFRA

CIFRA is a Croatian daily price-guessing game built with React, TypeScript and Vite.

## Development

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
npm run preview
```

## Question database

Illustrative questions are maintained in `src/data/questions.ts`. Replace demo prices with verified sources before publishing an official challenge.

## Optional Supabase account and result sync

Guest play remains available without Supabase. Email accounts synchronize completed results and streaks across devices. The app does not use a Supabase service-role key or a database password in the browser. The existing question prices are seeded as illustrative demo data, not verified prices.

### Configure a local app

1. Create a Supabase project. In its Dashboard, copy the **Project URL** from **Project Settings → API** and the **publishable key** from **Project Settings → API Keys** (or the project's Connect/API details page).
2. Copy `.env.example` to `.env.local` in the project root and replace both placeholders:

   ```dotenv
   VITE_SUPABASE_URL=https://your-project-ref.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=your-supabase-publishable-key
   ```

   These are browser-safe project settings. Never use a database password, secret API key, or `service_role` key in a `VITE_` variable. `.env.local` is ignored by Git.
3. In Supabase **Authentication → Providers → Email**, enable email/password sign-in. Email confirmation is recommended; if enabled, users must confirm their address before they can sign in.
4. In **Authentication → URL Configuration**, set the Site URL to the deployed CIFRA URL. Add exact callback URLs to the Redirect URLs allowlist, including `http://localhost:5173/` for local development and `https://cifra-52e.pages.dev/` for production. Add the corresponding URL for any custom production domain. The app builds the callback URL from the current origin and targets `/`, so it does not hardcode a development or production host.
5. In **SQL Editor**, open and run the complete single migration file [`20261123120000_phase2_auth_and_game_results.sql`](./supabase/migrations/20261123120000_phase2_auth_and_game_results.sql). It creates the tables and policies, seeds the current questions as unverified/illustrative demo rows, and installs server-side challenge/result functions with attempt and replay checks. It is not run automatically by this project.
   If you already ran that migration before the RPC column-qualification fix, run only the follow-up [`20261123131400_fix_rpc_output_column_ambiguity.sql`](./supabase/migrations/20261123131400_fix_rpc_output_column_ambiguity.sql) in the SQL Editor. Do not rerun the original migration on that database.
6. Restart the Vite server after editing `.env.local`:

   ```bash
   npm run dev
   ```

### Manual smoke test

- Start a challenge as a guest. Confirm no account is required and refresh mid-game to confirm local progress is restored.
- Register with an email/password. If confirmation is enabled, follow the email link, then sign in.
- Complete all five questions. Confirm the result page reports that the result and streak synchronized.
- Sign out and confirm the account's progress is no longer shown as guest progress; guest data remains stored separately on that device.
- Sign in to the same account in another browser/device. Confirm the completed result and streak appear in Statistics and today's completed result is restored.
- Test password recovery using the link in the sign-in dialog. Confirm the recovery link returns to the same allowed site origin.
- Turn off the network while playing as a guest. The current guest experience should continue using local storage; cloud sync errors can be retried from the result screen.

### Security and integrity verification

Run these checks against a disposable Supabase project after manually applying the migration; do not use a production account or production results for destructive experiments.

- **Concurrent daily challenge creation:** before the first authenticated call for a Zagreb date, issue several simultaneous `get_today_challenge` RPC calls from separate authenticated clients. All successful responses should contain the same challenge ID and the same five question IDs. Confirm the database has exactly five `challenge_questions` rows at positions 1–5 for that challenge, and that it is published only after those rows and price snapshots exist. The function takes a transaction-scoped advisory lock for initialization; later reads do not need that lock.
- **Price snapshot immutability:** record the five `actual_price_snapshot` values, then change an assigned row's `questions.actual_price` in the disposable database. A result submitted afterward should still use the recorded snapshots. Direct changes to assignments of a published challenge should fail. Restore or discard the disposable project afterward.
- **Scoring and single submission:** start a challenge through the app and submit all five answers. Compare the returned per-question scores with the existing exponential scoring rule (`round(1000 * exp(-4 * relative_error))`, capped at 1,000). Repeat the exact `submit_daily_result` RPC with the same date, guesses, and attempt token: it should return the original result with `duplicate = true`, without changing statistics. A different token or a second attempt/result for that user and challenge must not create another result.
- **Attempt checks:** try submitting with no token, a modified token, malformed or non-five-element guesses, more than two decimal places, and a guess above the allowed maximum; each must fail. A valid attempt submitted within 10 seconds should fail with the too-soon error and may be retried with the same token after the wait. Attempts expire 24 hours after first creation (and only accept that Zagreb day's result). Reopening issues an additional token for the existing attempt; it does not invalidate tokens held by another tab or device, and does not reset the attempt start time.
- **Refresh, tabs, and devices:** begin an authenticated challenge, answer part of it, and reload the same tab; local answers and that tab's token should remain available. Open a second tab or device, sign in, and start the same challenge; finishing from either context should still submit, and submitting from another context afterward should return the existing result rather than double-counting it. Partial guesses themselves remain local to the device and are not transferred; on a second device, begin the same daily challenge again and answer all five there.
- **Access restrictions:** from an anonymous client, confirm the challenge/result RPCs are denied. From an authenticated client, confirm direct reads/writes of `questions`, `daily_challenges`, `challenge_questions`, `challenge_attempts`, and `challenge_attempt_tokens` are denied; reads of profiles, results, and statistics should return only the signed-in user's rows. The security-definer RPCs should be executable only by `authenticated`.

**Anti-cheat limitation:** each token is server-generated and hashed at rest; multiple unexpired tokens can coexist for the same attempt, so opening the challenge in another tab/device does not invalidate a token already in use. The attempt also has a minimum elapsed time, expiry, atomic consumption, and duplicate protection. This proves an authenticated client opened an attempt, not that a human answered each question in the UI. A determined account owner can automate the RPC calls, and the current React bundle contains illustrative question data and prices for guest play, so a technically capable player can inspect them. These checks reduce accidental replay and trivial one-shot submissions; they do not make results cheat-proof. Stronger assurance would require keeping answer prices out of the browser and validating a server-tracked, sequential per-question interaction, and still cannot fully prevent automation by a user controlling their own browser.

### Cloudflare Pages

After local testing, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in the Cloudflare Pages project's **Settings → Environment variables** for Production and, if you use branch previews, Preview. These `VITE_` values are included in the public browser bundle, so use only the project URL and publishable key—never a secret or `service_role` key. Build with `npm run build` and use `dist` as the output directory. Save variable changes and trigger a new build; Vite reads them at build time.

Do not deploy until the migration and authentication settings have been manually configured and the local smoke tests pass. No database migration or deployment is performed by this repository's build.

## Deployment

The project can be deployed to Cloudflare Pages or another static-hosting provider. Build command: `npm run build`. Output directory: `dist`.
