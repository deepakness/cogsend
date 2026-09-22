# Scheduling

Scheduled posts live in D1 and are published by a _tick_: either the Worker's own
cron trigger, which needs no setup, or anything that can POST to the tick
endpoint.

## How a tick works

Scheduled posts save to D1 and are published by a per-minute cron trigger, which `wrangler.jsonc` ships enabled (`"triggers"`). A tick that runs out of the plan's CPU budget leaves the rest due for the next minute.

The trigger is registered the moment the Worker is deployed, but the first tick can take a few minutes to appear — Cloudflare runs a Worker's cron on machines that have spare capacity. Until one arrives, **Settings → Scheduled publishing** says "no tick yet"; that is the normal state for the first few minutes of a fresh install, not a failure. If it still says that an hour later, `npm run doctor -- --app-url <url>` says which of the cases you are in.

**Pick your tick.** The built-in cron needs nothing from you, but the Workers free plan allows only **five cron triggers per account** — and those are shared with every other Worker you run. If your account has none left, `npm run deploy` says so, retries without the trigger, and still ships the app; scheduled posts then wait until something calls the tick endpoint. **Settings → Scheduled publishing** covers both paths: it shows whether ticks are arriving, and can generate a token for an external cron (cron-job.org, UptimeRobot, the bundled GitHub Actions workflow). The token only works for the tick endpoint, unlike `SCHEDULER_SECRET`.

To drive the tick from something else instead — cron-job.org, a Raspberry Pi, a systemd timer, the bundled GitHub Actions workflow, a different cadence on a paid plan — POST to:

```sh
curl -X POST "$APP_URL/api/internal/tick" \
  -H "Authorization: Bearer $SCHEDULER_SECRET" \
  -H "Content-Type: application/json"
```

Both headers matter: the endpoint takes `SCHEDULER_SECRET` (`API_TOKEN` still works as a fallback; `AUTH_SECRET` never does — it signs sessions and is rejected on the wire), and `Content-Type: application/json` is required because SvelteKit's built-in CSRF guard rejects form-encoded POSTs without an `Origin` header (403) before app code ever runs. Clients that default to a form content type must override it.

An external caller needs a bearer it can read. Easiest is the token from **Settings → Scheduled publishing**, which needs no redeploy and cannot reach anything except the tick. The alternative is `SCHEDULER_SECRET` (`openssl rand -hex 32`), which then lives in two places — the Worker secret and the pinger's config — so rotate both together. Without it (and without `API_TOKEN`) an external caller cannot authenticate at all; the built-in cron keeps working either way, because the Worker derives the same value. The bundled GitHub workflow stays off until you set repository secrets `APP_URL` and `SCHEDULER_SECRET`; with the built-in cron running, treat it as a backup rather than the primary tick. It is scheduled every five minutes (GitHub's shortest interval) but GitHub throttles it to roughly one run every two hours. Queue treats a heartbeat older than 6 hours as delayed. You can also run it manually from **Actions → Scheduler tick → Run workflow**.

A tick publishes as many due targets as it can inside D1's per-invocation statement budget (50 on the free plan, which is roughly three or four posts), then stops and leaves the rest due — the next tick picks them up. A backlog therefore drains a few posts per tick rather than all at once, and nothing is lost if a tick dies half-way.

Ticks are idempotent, so an extra caller is safe rather than harmful — but there is no reason to run a per-minute pinger alongside the cron. Keep one primary tick and, at most, the throttled GitHub backup.

To change the cadence, edit `triggers.crons` in `wrangler.jsonc` (`*/5 * * * *` and friends are fine on the free plan too). To use no trigger at all, set `"crons": []` and point a pinger at the endpoint instead — `npm run doctor -- --app-url <url>` confirms which of the two is actually running.

## Failure alerts (optional)

The dashboard shows a "failed to publish" banner linking to the Failed tab. To also get a morning-after email, set `RESEND_API_KEY` and `NOTIFY_EMAIL` as Worker secrets (the app no-ops without them), plus an optional `NOTIFY_FROM` sender on a domain verified in Resend. At most one digest is sent per 24h window, covering failures newer than the last digest. Posts that are still retrying are not emailed.
