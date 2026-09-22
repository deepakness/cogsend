# cogsend API reference

Base URL is `$APP_URL` (for example `https://cogsend.<account>.workers.dev`).
All routes below are relative to it. JSON in, JSON out unless noted.

## Auth

Personal API key from **Settings → API access**. Send it as:

```
Authorization: Bearer $COGSEND_API_KEY
```

or `X-API-Key: $COGSEND_API_KEY`. Never in the URL. The key can do everything
except connect, re-verify or disconnect accounts, and create, rotate or revoke
keys (those are browser-session only). The legacy `API_TOKEN` Worker secret
works as a bearer on the same routes.

Errors are JSON: `{"error":"message"}` with an appropriate status. `401` bad or
revoked key, `400` bad input, `404` not found (or not yours), `409` conflict
(already publishing / already published), `413` too large, `500` nothing
recorded.

## Endpoints

| Method | Path                          | Body / params                                                  | Notes                                                                                                                                                                                                                                                            |
| ------ | ----------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/connections`            |                                                                | `{connections:[{id,platform,handle,displayName,status,...}], configured, appUrl}`. Only `status:"active"` accepts publishes.                                                                                                                                     |
| GET    | `/api/drafts`                 | `?limit=` (default 200, max 500)                               | `{drafts:[...], hasMore}`. Each draft embeds `variants`, `media`, `targets`.                                                                                                                                                                                     |
| POST   | `/api/drafts`                 | `{title?, baseBody?, selectedConnectionIds?}`                  | All optional. `201 {draft}`. `baseBody` ≤100,000 chars; blank lines split it into thread segments.                                                                                                                                                               |
| GET    | `/api/drafts/:id`             |                                                                | `{draft}` with variants, media, targets. `404`.                                                                                                                                                                                                                  |
| PATCH  | `/api/drafts/:id`             | `{title?, baseBody?, selectedConnectionIds?}`                  | `{ok:true}`. `409` while a publish is in flight.                                                                                                                                                                                                                 |
| DELETE | `/api/drafts/:id`             |                                                                | Deletes the draft and its R2 media. `409` while publishing.                                                                                                                                                                                                      |
| POST   | `/api/drafts/:id/duplicate`   |                                                                | `201 {draft}`. Copies variants and media bytes; publish history is not copied.                                                                                                                                                                                   |
| PUT    | `/api/drafts/:id/variants`    | `{platform, body?, options?}`                                  | Per-platform override. `platform` one of `mastodon, bluesky, linkedin, threads, x`. `options.threadSegments` is an array of post strings (≤100). `options.visibility`: `public, unlisted, private, direct`. `options.poll`: poll config. `409` while publishing. |
| DELETE | `/api/drafts/:id/variants`    | `?platform=`                                                   | Removes the per-platform override.                                                                                                                                                                                                                               |
| POST   | `/api/drafts/:id/media`       | multipart: `files`/`file`, `segmentIndex`, `altText`           | `201 {media, items}`. Image ≤16MB, video ≤95MB (video needs `ENABLE_VIDEO_UPLOAD`), ≤4 images per segment, 1 video per segment, no image+video mix, ≤32 files per draft, ≤1000 per account. `413` over limits, `409` while publishing.                           |
| PATCH  | `/api/drafts/:id/media`       | `{mediaId, altText?, segmentIndex?}`                           | Update alt text or move between segments. Same video/mixing rules.                                                                                                                                                                                               |
| DELETE | `/api/drafts/:id/media`       | `?mediaId=`                                                    | Removes the row and the R2 object.                                                                                                                                                                                                                               |
| GET    | `/api/media/:key`             |                                                                | Streams draft media bytes. `404` for foreign or missing keys.                                                                                                                                                                                                    |
| POST   | `/api/drafts/:id/publish`     | `{connectionIds:[..]}` (≤10)                                   | Publishes in order. `200 {results:[{targetId,connectionId,platform,status,permalink,error,skipped}], draft}`. `409 {inFlight:[ids]}` if already publishing. `400` unknown/inactive ids or >10 ids.                                                               |
| POST   | `/api/drafts/:id/schedule`    | `{connectionIds:[..], runAt}`                                  | `runAt` ISO timestamp, future. `200 {targets, scheduledFor}`. `409 {alreadyPublished?, inFlight?}`.                                                                                                                                                              |
| GET    | `/api/queue`                  | `?limit=` (default 100, max 500)                               | `{targets:[...], hasMore}`. Upcoming first, then history. Each target carries `draft` and `connection`.                                                                                                                                                          |
| POST   | `/api/targets/:id/cancel`     |                                                                | Cancel a `pending`/`scheduled`/`failed` target, or `publishing` stale >15 min. `409` if live-publishing; `400` if already published. Idempotent on `cancelled`.                                                                                                  |
| POST   | `/api/targets/:id/reschedule` | `{runAt}`                                                      | New ISO time. `409` already published/publishing; `400` cancelled (retry instead) or past time.                                                                                                                                                                  |
| POST   | `/api/targets/:id/retry`      |                                                                | Resets and publishes inline. Only for `failed` (or `publishing` stale >15 min). `200` with the publish outcome; `409` in flight / needs reconnect. Already-published returns `{status:"published", skipped:true}`.                                               |
| POST   | `/api/targets/bulk`           | `{op:"cancel"\|"retry"\|"reschedule", ids:[..] (≤10), runAt?}` | Same semantics per id. `200 {results:[{id,ok,status?,error?}], failed:[..]}`.                                                                                                                                                                                    |
| GET    | `/api/settings`               |                                                                | `{settings, displayName, instanceName}`.                                                                                                                                                                                                                         |
| PATCH  | `/api/settings`               | profile fields, `displayName?`, `instanceName?`                | Updates profile settings and/or instance name.                                                                                                                                                                                                                   |
| GET    | `/api/scheduler/health`       |                                                                | `{ok, error, stuckPublishing, overdue, lastTickAt, neverTicked, deployCron, message}`. Check before blaming a scheduled post that did not fire.                                                                                                                  |
| GET    | `/api/release`                | `?refresh=1`                                                   | `{latest, ...}` whether a newer cogsend release exists.                                                                                                                                                                                                          |
| POST   | `/api/validate`               | `{text, platform?, maxCharacters?}`                            | `{graphemes, mastodonLength, bluesky, mastodon, linkedin, threads, x, issues}`. `platform` narrows `issues` to one provider. `413` over 200,000 chars.                                                                                                           |
| GET    | `/api/link-preview`           | `?url=`                                                        | `{url,title,description,image,siteName}` OpenGraph card. Requires write scope (server fetches the URL).                                                                                                                                                          |

## Limits

- `baseBody` / variant `body`: 100,000 characters.
- `options.threadSegments`: at most 100 explicit segments per variant.
- Publish and bulk calls: at most 10 ids each.
- Media: 4 images per segment, 16MB per image, one 95MB video per segment, no
  image+video mix on a segment, 32 files per draft, 1000 per account, 100MB per
  upload request.
- Per-platform text and media limits are re-checked at publish time. What the
  API accepts is not necessarily what a platform accepts; use `/api/validate`
  first when it matters.

## Publish semantics

- Publishing the same draft + account twice reuses the target row. Already
  published accounts return `skipped: true` with their `permalink`.
- `409 {inFlight}`: a publish is running on those accounts. Wait a few seconds
  and resend. Do not retry in a tight loop.
- `200` with `stopped: true` + `stoppedError`: the request ran out of its
  per-invocation D1 budget (Workers Free allows 50 statements). Entries after
  the last `results` item were not attempted and are still due. Resend those
  connection ids. A target interrupted mid-publish is left retryable, never
  stuck in `publishing`.
- `500` means nothing was recorded. Check the draft before retrying.
- A retried segment reuses its platform-side id, so a thread that failed
  half-way does not double-post (Mastodon remembers the id for an hour;
  Bluesky refuses to overwrite the record).

## Per-platform quirks

- **Mastodon**: character counting is URL-weighted (`mastodonLength` in
  `/api/validate`); default limit 500, overridable per instance via
  `maxCharacters`. Supports `options.visibility` and polls.
- **Bluesky**: 300 graphemes. Link cards are built server-side from OpenGraph
  at publish.
- **LinkedIn**: text limit per its API; one video per post and no image+video
  mixing is enforced at upload.
- **Threads**: 500 chars; unfurls links server-side.
- **X**: 280 weighted chars. Needs an OAuth app configured on the instance or
  the connection cannot be created (browser-side only).
- Connecting, re-verifying and disconnecting accounts is never possible via
  API key. If a connection is not `active`, the fix is in the browser.
