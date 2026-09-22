# Script / app API

The browser UI uses the `cog_session` cookie after TOTP. Scripts, Shortcuts, and cron use a personal API key instead — no login, no cookies. Manage it in **Settings → API access** (generate, rotate, revoke); the raw key is shown once and only its hash is stored. Worked examples for the common calls live in-app at `/api`.

```sh
export APP_URL=https://cogsend.<account>.workers.dev
export COGSEND_API_KEY=cog_...   # from Settings → API access

curl -s "$APP_URL/api/connections" -H "Authorization: Bearer $COGSEND_API_KEY"
curl -s -X POST "$APP_URL/api/drafts" \
  -H "Authorization: Bearer $COGSEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"Hello","baseBody":"from a script"}'
curl -s -X POST "$APP_URL/api/drafts/DRAFT_ID/publish" \
  -H "Authorization: Bearer $COGSEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"connectionIds":["CONN_ID"]}'
```

`X-API-Key` works as an alternative header; never put the key in the URL. The key acts as you on drafts, variants, media, publish, schedule, queue, settings, and reads — but it can never connect, re-verify or disconnect accounts, or create, rotate, or revoke keys (those stay in the browser session). The global `API_TOKEN` Worker secret still works as a bearer for backwards compatibility, on exactly the same routes as a personal key — it cannot reach the session-only ones either — but prefer the personal key for scripts: it is revocable without touching the scheduler.

A body is capped at 100,000 characters, and a variant may carry at most 100 explicit `threadSegments`. Each platform's own text and media limits are checked again at publish, so what the API accepts is not necessarily what a platform will take.

Publishing the same draft and account twice reuses the row. Already-published accounts come back `skipped: true`. A publish that is still running on that account answers **409** with `inFlight` (the connection ids) — wait, then try again.

A retried segment carries the same platform-side id as its first attempt, so a thread that failed half-way does not double-post what already went out (Mastodon remembers the id for an hour, Bluesky refuses to overwrite the record).

Sending several connection ids in one request publishes them in order. If the request runs out of its per-invocation budget (Workers Free allows 50 database statements), it answers `200` with `stopped: true`, `stoppedError`, and the results it did get — the accounts after the last entry were not completed and are still due (a target the failure interrupted is left retryable, never `publishing`), so send those ids again. A `500` means nothing was recorded; check the draft before retrying. Do not call `/api/targets/:id/retry` unless the row is `failed` (or a stuck `publishing` older than 15 minutes).

Schedule returns **409** if that account is already published or still publishing. Check `error`, `alreadyPublished`, and `inFlight` instead of treating HTTP 200 as "it was scheduled".
