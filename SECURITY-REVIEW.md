# CIFRA Phase 2 Security Review

## Scope and status

This document summarizes the Phase 2 database/client protections and the checks performed; it is not a full security audit. The project owner reports that the initial Supabase migration and subsequent RPC fixes were manually applied, and that the main authenticated game flow was successfully played with the result saved in `game_results`. No production deployment status is asserted here.

The Phase 1 migrations [`20261124100000_stability_and_question_rotation.sql`](./supabase/migrations/20261124100000_stability_and_question_rotation.sql) and [`20261124110000_enforce_sequential_game_results.sql`](./supabase/migrations/20261124110000_enforce_sequential_game_results.sql) are new and have **not** been applied. Stage A adds server-recorded sequential answers, cross-device attempt progress, and historical question rotation without enforcing answer rows on result inserts. Stage C separately adds that enforcement after the updated frontend is deployed and verified. This split avoids breaking the already deployed legacy frontend during Stage A and Stage B. Guest play does not require the database.

## Required rollout order

1. Apply the already-used Phase 2 migration and ambiguity hotfix only for a fresh database; do not rerun them on the existing project.
2. Apply Stage A (`20261124100000_stability_and_question_rotation.sql`).
3. Deploy the updated frontend and verify answer synchronization, refresh recovery, and result submission.
4. Allow old tabs/users to refresh or complete current-day attempts. Legacy clients retain the existing Phase 2 final-result behavior only while Stage C is unapplied; this is a temporary compatibility window.
5. Apply Stage C (`20261124110000_enforce_sequential_game_results.sql`) after Stage B is verified. From then on, new results require five matching server-accepted sequential answers. Old tabs should reload; their locally saved current-day guesses can be synchronized by the updated app. Already completed results are unchanged because the trigger applies only to new inserts.

If Stage A fails, its transaction should roll back and Stage B must not be deployed. If Stage B fails before Stage C, roll back the frontend while the legacy result flow remains available. If a defect is found after Stage C commits, roll forward the frontend/database fix rather than deploying the old frontend. See the README for old-tab and unfinished-attempt recovery steps.

## Findings and remediation

| Severity | Finding | Remediation |
|---|---|---|
| High | Scoring read the mutable `questions.actual_price`, so later edits could change a published challenge's effective answer. | `challenge_questions` now stores price, currency, demo status, and verification-status snapshots. Result scoring reads only those snapshots. Published assignments and challenge metadata are protected from modification. |
| Medium | Concurrent first requests could race while creating and assigning a daily challenge. | `get_today_challenge()` takes a transaction-scoped advisory lock when initialization is needed, rechecks after acquiring it, assigns all five snapshots in the same transaction, and publishes only after validation. A database trigger also requires exactly five valid snapshots before publication. |
| Medium | A signed-in caller could submit arbitrary guesses directly or replay a request; server-side score recomputation alone did not represent a started attempt. | A server-only `challenge_attempts` row tracks one attempt per user and day. `challenge_attempt_tokens` stores hashes of multiple valid tokens, so a new token from another tab/device does not invalidate an existing one. Submission validates a token, locks the attempt row, enforces an elapsed-time minimum and expiry, marks the attempt submitted atomically, and returns the original result for an idempotent retry. Unique result constraints prevent a second daily result. |
| High | Applying sequential-answer enforcement before the updated frontend would reject the legacy frontend's direct final-result submissions, including in-flight attempts. | Split the unapplied Phase 1 migration into additive Stage A and enforcement-only Stage C. Stage A preserves the existing submission flow; Stage C is delayed until after the updated frontend rollout and verification. |
| Low | Authenticated clients could directly set the profile `updated_at` value. | Direct update permission for that column was removed; a database trigger maintains it. |

## Access controls reviewed

- `profiles`, `game_results`, and `user_statistics` are readable only by the authenticated owner under RLS. Profile updates are column-limited; result/statistics writes are revoked from clients.
- `questions`, `daily_challenges`, `challenge_questions`, `challenge_attempts`, and `challenge_attempt_tokens` have no client table grants. RLS is enabled, with no public read policy.
- `get_today_challenge`, `start_daily_attempt`, and `submit_daily_result` are `SECURITY DEFINER`, pin their search path, require `auth.uid()`, revoke default/public execution, and grant execution only to `authenticated`.
- The unapplied Stage A migration also pins the search path and restricts execution of `get_daily_attempt_progress()` and `submit_daily_answer()` to `authenticated`; it keeps answer rows inaccessible through direct client table privileges. Stage C adds the result-insert trigger. These describe the SQL files' intended protections, not an applied or live-verified state.
- The auth-user trigger function also pins its search path and has direct execution revoked.
- Constraints bind results and attempts to the matching challenge date, enforce five ordered answers/scores, and prevent duplicate user/day results.
- All 51 bundled question rows remain marked `is_demo = true`, `verification_status = 'unverified'`, and `price_type = 'illustrative'`.

## Remaining anti-cheat limitation

These controls provide server-side scoring, hashed authenticated attempt tokens that coexist across tabs/devices, basic timing and replay protection, and immutable challenge answers. After Stage C, they also require server-recorded sequential answers, but still do **not** prove that a human answered each question in the UI. A determined account owner can automate the RPCs, and question prices remain inspectable in the React bundle because guest play uses the same bundled question data. Keeping prices out of the browser would require changing the shared guest-data architecture and still cannot prevent all automation by a user controlling their client.

## Verification performed

- **Functional verification reported by the project owner:** the migration and RPC fixes were applied manually in Supabase; the main authenticated game flow completed, and its result was saved in `game_results`. This is a reported application-level test, not independent verification of every database behavior.
- **Local guest-browser verification for this update:** completed all five questions, checked exact, close (`5,49` vs `5,50`), and large-error scoring, Croatian comma and EUR formatting, malformed input rejection, refresh after a revealed answer, duplicate-click protection, result sharing, navigation/modal actions, and responsive overflow at 375, 390, 768, and 1280 pixels. Simulated Europe/Zagreb midnight advanced the date, archived unfinished progress, and showed the new-challenge notice. Utility checks covered streak changes after one/missed days, input bounds, scoring, and a 30-day deterministic question-selection run with no consecutive repeats. This does not exercise authenticated RPCs or real daylight-saving transitions.
- `npm run lint` and `npm run build` — passed locally for the current source; the build emitted Vite's existing large-chunk advisory.
- Static migration-contract inspection — verified the advisory initialization lock, 5-snapshot publication checks, snapshot-based scoring, sequential answer ordering, duplicate answer guard, result trigger validation, client grants, and output-column qualification in the migration source. These checks do not parse or execute PostgreSQL SQL.
- **Not independently verified:** actual PostgreSQL behavior under concurrency; RLS and grants using separate anonymous/authenticated roles; token expiry, replay, and duplicate handling under live database calls; challenge snapshot immutability; cross-device answer synchronization; question rotation against live history; Stage C enforcement; and DST/midnight behavior. Use the documented disposable-project checks in the README for those scenarios. The SQL regression scenario is provided but has not been executed against PostgreSQL.
- No full security audit is claimed. No deployment was performed or independently checked.
