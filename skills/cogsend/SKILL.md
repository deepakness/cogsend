---
name: cogsend
description: Use when posting, scheduling, or reading drafts and the publish queue on a cogsend instance via its REST API. Covers curl-only workflows for drafts, media, publish, schedule, queue and target retries.
---

# cogsend

Drive a self-hosted cogsend instance (social scheduler for Mastodon, Bluesky,
LinkedIn, Threads, X) over its REST API. Everything below is curl and JSON. No
SDK, no dependencies.

## Setup

You need the instance URL and a personal API key. The key is generated in the
app under **Settings → API access** and shown once.

```sh
export APP_URL=https://cogsend.<account>.workers.dev
export COGSEND_API_KEY=cog_...
```

Verify both work:

```sh
curl -s "$APP_URL/api/connections" -H "Authorization: Bearer $COGSEND_API_KEY"
```

A good key returns `{"connections":[...],"configured":{...},"appUrl":"..."}`.
`401` means the key is wrong or revoked. `X-API-Key: $COGSEND_API_KEY` works as
an alternative header.

## Workflows

### 1. List connected accounts

```sh
curl -s "$APP_URL/api/connections" -H "Authorization: Bearer $COGSEND_API_KEY"
```

Each connection has `id`, `platform` (`mastodon`, `bluesky`, `linkedin`,
`threads`, `x`), `handle`, `displayName`, `status`. Only `status: "active"`
accounts accept publishes. Collect the `id`s you want to post to.

### 2. Create a draft

```sh
curl -s -X POST "$APP_URL/api/drafts" \
  -H "Authorization: Bearer $COGSEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"Launch note","baseBody":"We shipped the thing.","selectedConnectionIds":["CONN_ID"]}'
```

All fields optional. Returns `{"draft":{...}}` with the draft `id` (201).
`baseBody` is shared across platforms; per-platform text goes in variants (see
references/api.md). A blank line splits `baseBody` into thread segments.

### 3. Publish now

```sh
curl -s -X POST "$APP_URL/api/drafts/DRAFT_ID/publish" \
  -H "Authorization: Bearer $COGSEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"connectionIds":["CONN_ID","CONN_ID_2"]}'
```

Returns `{"results":[{targetId, connectionId, platform, status, permalink,
error, skipped}...], "draft":{...}}`. Read `results`, not the HTTP code alone:

- `status: "published"` with `permalink` is a live post.
- `skipped: true` means that account was already published (idempotent replay).
- `409 {"inFlight":[ids]}` means another publish is running on those accounts.
  Wait a few seconds, then resend.
- `200` with `stopped: true` + `stoppedError` means the request hit the Workers
  Free 50-D1-statement budget mid-batch. Entries after the last result were
  not attempted. Resend those connection ids.

### 4. Schedule

```sh
curl -s -X POST "$APP_URL/api/drafts/DRAFT_ID/schedule" \
  -H "Authorization: Bearer $COGSEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"connectionIds":["CONN_ID"],"runAt":"2026-09-25T14:00:00Z"}'
```

`runAt` is an ISO timestamp in the future. `409` with `alreadyPublished` or
`inFlight` lists the connection ids that refused. The cron trigger (or external
pinger) fires it when due.

### 5. Check the queue

```sh
curl -s "$APP_URL/api/queue" -H "Authorization: Bearer $COGSEND_API_KEY"
```

Returns `{"targets":[...],"hasMore":false}`, upcoming first. Each target has
`id`, `status` (`pending`, `scheduled`, `publishing`, `published`, `failed`,
`cancelled`), `scheduledFor`, `remoteUrl`, `errorMessage`, plus the draft and
connection it belongs to. `?limit=N` up to 500.

### 6. Cancel, reschedule, retry a target

```sh
curl -s -X POST "$APP_URL/api/targets/TARGET_ID/cancel" -H "Authorization: Bearer $COGSEND_API_KEY"
curl -s -X POST "$APP_URL/api/targets/TARGET_ID/reschedule" \
  -H "Authorization: Bearer $COGSEND_API_KEY" -H "Content-Type: application/json" \
  -d '{"runAt":"2026-09-26T09:00:00Z"}'
curl -s -X POST "$APP_URL/api/targets/TARGET_ID/retry" -H "Authorization: Bearer $COGSEND_API_KEY"
```

Retry publishes inline and returns the outcome. Only retry `failed` targets, or
`publishing` rows stuck over 15 minutes. A cancelled target cannot be
rescheduled. Retry it instead. For several targets at once use
`POST /api/targets/bulk` with `{"op":"cancel|retry|reschedule","ids":[...],"runAt":...}`.

### 7. Upload media with alt text

```sh
curl -s -X POST "$APP_URL/api/drafts/DRAFT_ID/media" \
  -H "Authorization: Bearer $COGSEND_API_KEY" \
  -F "files=@photo.jpg" \
  -F "segmentIndex=0" \
  -F "altText=A chart of the launch numbers"
```

`segmentIndex` is the thread card the file belongs to (0-based). Max 4 images
per segment, 16MB per image, one video (95MB) per segment, 32 files per draft.
Change alt text or move a file:

```sh
curl -s -X PATCH "$APP_URL/api/drafts/DRAFT_ID/media" \
  -H "Authorization: Bearer $COGSEND_API_KEY" -H "Content-Type: application/json" \
  -d '{"mediaId":"MEDIA_ID","altText":"Better description"}'

curl -s -X DELETE "$APP_URL/api/drafts/DRAFT_ID/media?mediaId=MEDIA_ID" \
  -H "Authorization: Bearer $COGSEND_API_KEY"
```

Fetch bytes back with `GET /api/media/<storageKey>`.

### 8. Validate text before posting

```sh
curl -s -X POST "$APP_URL/api/validate" \
  -H "Authorization: Bearer $COGSEND_API_KEY" -H "Content-Type: application/json" \
  -d '{"text":"Draft body here","platform":"x"}'
```

Returns per-platform verdicts (`bluesky`, `mastodon`, `linkedin`, `threads`,
`x`), `graphemes`, `mastodonLength` (URL-weighted), and `issues` for the
requested platform. Cheaper than a failed publish.

## Hard rules

- Never put the key in the URL or a query param. Header only.
- Publish is idempotent per draft + account. Resending is safe; published
  accounts come back `skipped: true`.
- `409 inFlight` means wait and resend, not retry harder.
- `stopped: true` means resend only the connection ids missing from `results`.
- Retry only `failed` targets (or `publishing` stuck >15 min). Never retry a
  `scheduled` or live `publishing` row.
- Max 10 `connectionIds` (or bulk `ids`) per call.
- The key cannot connect, re-verify or disconnect accounts, and cannot create,
  rotate or revoke keys. Those need the browser session. If every connection is
  `status: "needs_reconnect"` or missing, tell the user to fix it in the app.

## Reference

Full endpoint table, limits and per-platform quirks: [references/api.md](references/api.md).
