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
Guest question rotation is based on that browser's saved history, so guest progress and exact question assignments are device-local. Authenticated daily assignments come from the shared Supabase challenge.

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
5. In **SQL Editor**, apply the migrations in the staged order below. For a fresh project, run [`20261123120000_phase2_auth_and_game_results.sql`](./supabase/migrations/20261123120000_phase2_auth_and_game_results.sql), then [`20261123131400_fix_rpc_output_column_ambiguity.sql`](./supabase/migrations/20261123131400_fix_rpc_output_column_ambiguity.sql), then Stage A, [`20261124100000_stability_and_question_rotation.sql`](./supabase/migrations/20261124100000_stability_and_question_rotation.sql). If Phase 2 is already installed, do not rerun its migrations; run only Stage A. Do **not** run Stage C yet. These files are not run automatically by the app.
6. Restart the Vite server after editing `.env.local`:

   ```bash
   npm run dev
   ```

### Manual smoke test

- Start a challenge as a guest. Confirm no account is required and refresh mid-game, including after revealing an answer, to confirm progress and the revealed state are restored.
- Register with an email/password. If confirmation is enabled, follow the email link, then sign in.
- Complete all five questions. Confirm each answer is accepted once and the result page reports that the result and streak synchronized.
- In an authenticated challenge, answer one or more questions, refresh, then continue. Repeat with a second tab/device: accepted guesses and scores should resume from server progress, and attempts from both tabs must not replace an already accepted answer.
- Go offline after answering and refresh or continue locally; reconnect and return/focus the tab. Pending local answers should be retried and reconciled with server-accepted answers.
- Wait across Europe/Zagreb midnight with a partially completed challenge. The old progress should remain archived on the original device, and a new daily challenge should be offered.
- Sign out and confirm the account's progress is no longer shown as guest progress; guest data remains stored separately on that device.
- Sign in to the same account in another browser/device. Confirm the completed result and streak appear in Statistics and today's completed result is restored.
- Test password recovery using the link in the sign-in dialog. Confirm the recovery link returns to the same allowed site origin.
- Turn off the network while playing as a guest. The current guest experience should continue using local storage.

### Staged stability rollout

Run the stability changes as separate stages; do not apply every SQL file in one batch:

Use the Supabase SQL Editor for this staged rollout. A CLI command that applies all pending migrations may also apply Stage C before Stage B has been verified.

1. **Stage A — additive database changes:** apply `20261124100000_stability_and_question_rotation.sql`. This adds answer persistence/progress RPCs and the improved question rotation. It deliberately does not install the result-insert trigger, so the currently deployed frontend can continue using the existing final-result RPC.
2. **Stage B — frontend:** deploy the updated frontend only after Stage A succeeds. Verify sequential answer recording, refresh recovery, and a completed result in a disposable Supabase project. Keep the previous frontend deployment available for rollback while Stage C has not been applied.
3. **Transition window:** ask users to refresh open CIFRA tabs so they load the updated frontend. Keep Stage C unapplied until Stage B is verified and users have had time to refresh or finish their current-day attempts. Inactive old tabs cannot be reliably detected. Old clients continue to have the existing Phase 2 final-result behavior during this window; that is a temporary compatibility period, not an added permanent bypass.
4. **Stage C — strict enforcement:** only after Stage B is verified, manually run [`20261124110000_enforce_sequential_game_results.sql`](./supabase/migrations/20261124110000_enforce_sequential_game_results.sql). It requires all five sequential server-accepted answers before a new result can be inserted. The legacy final-result call without those answer rows will then be rejected.

**Existing user recovery:** existing completed results are not updated or invalidated; the trigger applies only to new inserts. Legacy unfinished attempts have no server answer rows to backfill, and the progress RPC cannot reconstruct them. An unfinished old tab may fail to submit after Stage C. Refresh that same browser into the updated app while the challenge is still current; its locally saved guesses are replayed in order through the answer RPCs, after which result submission can finish. If all five answers had already been accepted by the server before a refresh, the updated app can finalize from that saved progress. Old unsynchronized guesses are device-local and cannot be recovered on another device until uploaded. As before, an unfinished challenge cannot be submitted after its Europe/Zagreb date expires.

**Failure recovery:** Stage A is transactional; if it fails, do not deploy Stage B and resolve the SQL error before retrying. If Stage B fails while Stage C is still unapplied, roll back to the prior frontend; the old result flow remains available. Stage C is a separate transaction and should be applied only after verification. If a defect is found after Stage C commits, prefer a forward frontend/database fix; do not roll back to the legacy frontend, whose result submissions are intentionally blocked by the trigger.

### Security and integrity verification

Run these checks against a disposable Supabase project; do not use a production account or production results for destructive experiments. Apply Stage A before testing its new RPCs. Validate strict result-insert enforcement only after applying Stage C.

- **Concurrent daily challenge creation:** before the first authenticated call for a Zagreb date, issue several simultaneous `get_today_challenge` RPC calls from separate authenticated clients. All successful responses should contain the same challenge ID and the same five question IDs. Confirm the database has exactly five `challenge_questions` rows at positions 1–5 for that challenge, and that it is published only after those rows and price snapshots exist. The function takes a transaction-scoped advisory lock for initialization; later reads do not need that lock.
- **Price snapshot immutability:** record the five `actual_price_snapshot` values, then change an assigned row's `questions.actual_price` in the disposable database. A result submitted afterward should still use the recorded snapshots. Direct changes to assignments of a published challenge should fail. Restore or discard the disposable project afterward.
- **Scoring and single submission:** start a challenge through the app and submit all five answers. Compare the returned per-question scores with the existing exponential scoring rule (`round(1000 * exp(-4 * relative_error))`, capped at 1,000). Repeat the exact `submit_daily_result` RPC with the same date, guesses, and attempt token: it should return the original result with `duplicate = true`, without changing statistics. A different token or a second attempt/result for that user and challenge must not create another result.
- **Attempt checks:** try submitting with no token, a modified token, malformed or non-five-element guesses, more than two decimal places, and a guess above the allowed maximum; each must fail. A valid attempt submitted within 10 seconds should fail with the too-soon error and may be retried with the same token after the wait. Attempts expire 24 hours after first creation (and only accept that Zagreb day's result). Reopening issues an additional token for the existing attempt; it does not invalidate tokens held by another tab or device, and does not reset the attempt start time.
- **Refresh, tabs, and devices:** begin an authenticated challenge, answer part of it, and reload the same tab; accepted answers should be restored from the database, and a valid token should be available or renewed. Open a second tab/device and sign in; it should restore accepted progress. Submit the same answer concurrently from two tabs with different guesses: only the first accepted answer should be retained, and the other tab should reconcile to it. Complete from either context; duplicate result submission must not double-count.
- **Sequential answer validation:** on a disposable account, attempt question positions out of order, change a previously accepted guess, and submit a result before all five answers are recorded; each invalid attempt should fail. A same-position retry with the same guess should be idempotent and return the saved score.
- **Question rotation:** inspect several consecutive published days and confirm each has five distinct questions, prioritizes never-used questions, avoids yesterday's questions when alternatives exist, then prefers least-recently-used questions with appearance count as a tie-breaker, while retaining category diversity.
- **Actual question generation:** run [`daily_question_rotation_generation.sql`](./supabase/tests/daily_question_rotation_generation.sql) in a fresh disposable project with all migrations applied and no challenge for today or the previous four Zagreb dates. Run it once in `demo` mode and again in `verified` mode by changing the mode setting at the top. It calls the real `get_today_challenge()` function and rolls back all fixtures.
- **Security and result integrity:** replace the two example UUIDs in [`database_security_result_integrity.sql`](./supabase/tests/database_security_result_integrity.sql) with IDs of fresh disposable Auth users, then run it in `cifra-test`. It rolls back attempts, tokens, answers, results, and statistics. It checks catalog privileges, RLS configuration, cross-user progress through the RPC, answer ordering/immutability, Stage C enforcement, and duplicate statistics. Because SQL Editor runs as the database owner, also perform the manual REST-client checks below with real anonymous and authenticated sessions.
- **Access restrictions:** from an anonymous client, confirm the challenge, attempt, progress, answer, and result RPCs are denied. From an authenticated client, confirm direct reads/writes of `questions`, `daily_challenges`, `challenge_questions`, `challenge_attempts`, `challenge_attempt_tokens`, and `challenge_attempt_answers` are denied; reads of profiles, results, and statistics should return only the signed-in user's rows. The security-definer RPCs should be executable only by `authenticated`.
- **Live role isolation:** SQL Editor claim settings do not equal an actual Supabase JWT. In a separate browser session signed out, call each protected RPC and attempt a protected-table write; both should be denied. Sign in as test user A, submit one answer, then sign in as test user B in another private window and call `get_daily_attempt_progress(today)`; it should return no answers from A. A direct query to A's results/statistics must return no rows for B.

**Anti-cheat limitation:** each token is server-generated and hashed at rest; multiple unexpired tokens can coexist for the same attempt, so opening the challenge in another tab/device does not invalidate a token already in use. The attempt also has a minimum elapsed time, expiry, atomic consumption, and duplicate protection. After Stage C, the server requires ordered, server-recorded answers and idempotent retries, but this proves only that an authenticated client submitted the RPCs—not that a human answered each question in the UI. A determined account owner can automate them, and the current React bundle contains illustrative question data and prices for guest play, so a technically capable player can inspect them. These protections do not make results cheat-proof. Hiding prices would require changing the shared guest-data architecture and still cannot fully prevent automation by a user controlling their own browser.

**Unfinished-day policy:** the database accepts attempts only for the current Europe/Zagreb challenge date. The app preserves expired unfinished progress in the local archive and starts the next day's challenge at midnight, but it does not offer a way to resume or submit yesterday's archived attempt. Do not assume unfinished progress can be carried across days or devices.

### Cloudflare Pages

After local testing, add `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in the Cloudflare Pages project's **Settings → Environment variables** for Production and, if you use branch previews, Preview. These `VITE_` values are included in the public browser bundle, so use only the project URL and publishable key—never a secret or `service_role` key. Build with `npm run build` and use `dist` as the output directory. Save variable changes and trigger a new build; Vite reads them at build time.

Do not deploy until the migration and authentication settings have been manually configured and the local smoke tests pass. No database migration or deployment is performed by this repository's build.

## Deployment

The project can be deployed to Cloudflare Pages or another static-hosting provider. Build command: `npm run build`. Output directory: `dist`.
