# CIFRA Phase 2 Security Review

## Scope and status

This document summarizes the Phase 2 database/client protections and the checks performed; it is not a full security audit. The project owner reports that the initial Supabase migration and subsequent RPC fixes were manually applied, and that the main authenticated game flow was successfully played with the result saved in `game_results`. No production deployment status is asserted here.

## Findings and remediation

| Severity | Finding | Remediation |
|---|---|---|
| High | Scoring read the mutable `questions.actual_price`, so later edits could change a published challenge's effective answer. | `challenge_questions` now stores price, currency, demo status, and verification-status snapshots. Result scoring reads only those snapshots. Published assignments and challenge metadata are protected from modification. |
| Medium | Concurrent first requests could race while creating and assigning a daily challenge. | `get_today_challenge()` takes a transaction-scoped advisory lock when initialization is needed, rechecks after acquiring it, assigns all five snapshots in the same transaction, and publishes only after validation. A database trigger also requires exactly five valid snapshots before publication. |
| Medium | A signed-in caller could submit arbitrary guesses directly or replay a request; server-side score recomputation alone did not represent a started attempt. | A server-only `challenge_attempts` row tracks one attempt per user and day. `challenge_attempt_tokens` stores hashes of multiple valid tokens, so a new token from another tab/device does not invalidate an existing one. Submission validates a token, locks the attempt row, enforces an elapsed-time minimum and expiry, marks the attempt submitted atomically, and returns the original result for an idempotent retry. Unique result constraints prevent a second daily result. |
| Low | Authenticated clients could directly set the profile `updated_at` value. | Direct update permission for that column was removed; a database trigger maintains it. |

## Access controls reviewed

- `profiles`, `game_results`, and `user_statistics` are readable only by the authenticated owner under RLS. Profile updates are column-limited; result/statistics writes are revoked from clients.
- `questions`, `daily_challenges`, `challenge_questions`, `challenge_attempts`, and `challenge_attempt_tokens` have no client table grants. RLS is enabled, with no public read policy.
- `get_today_challenge`, `start_daily_attempt`, and `submit_daily_result` are `SECURITY DEFINER`, pin their search path, require `auth.uid()`, revoke default/public execution, and grant execution only to `authenticated`.
- The auth-user trigger function also pins its search path and has direct execution revoked.
- Constraints bind results and attempts to the matching challenge date, enforce five ordered answers/scores, and prevent duplicate user/day results.
- All 51 bundled question rows remain marked `is_demo = true`, `verification_status = 'unverified'`, and `price_type = 'illustrative'`.

## Remaining anti-cheat limitation

These controls provide server-side scoring, hashed authenticated attempt tokens that coexist across tabs/devices, basic timing and replay protection, and immutable challenge answers. They do **not** prove that a human answered each question in the UI. A determined account owner can automate the RPCs, and question prices remain inspectable in the React bundle because guest play uses the same bundled question data. Stronger assurance would require keeping answer prices out of the browser and validating a server-tracked, sequential per-question flow; even that cannot prevent all automation by a user controlling their client.

## Verification performed

- **Functional verification reported by the project owner:** the migration and RPC fixes were applied manually in Supabase; the main authenticated game flow completed, and its result was saved in `game_results`. This is a reported application-level test, not independent verification of every database behavior.
- `npm run build` and `npm run lint` — passed locally.
- Vite runtime smoke checks for the app and updated RPC modules — passed.
- Static migration-contract checks — passed for concurrency lock, five-snapshot publication, immutable scoring source, hashed attempts, expiry/time gate, idempotent replay, explicit function grants, and matching client RPC types. These checks do not execute SQL.
- **Not independently verified:** actual PostgreSQL behavior under concurrency; RLS and grants using separate anonymous/authenticated roles; token expiry, replay, and duplicate handling under live database calls; and challenge snapshot immutability. Use the documented disposable-project checks in the README for those scenarios.
- No full security audit is claimed. No deployment was performed or independently checked.
