# API

The browser UI uses the `cog_session` cookie after TOTP. Scripts, Shortcuts, cron
and MCP clients use a personal API key instead — no login, no cookies. Manage it in
**Settings → API access** (generate, rotate, revoke); the raw key is shown once
and only its hash is stored. Worked examples for the common calls live in-app at
`/api`.

## Authentication

Export your instance URL and a key from **Settings → API access**:

```sh
export APP_URL=https://cogsend.<account>.workers.dev
export COGSEND_API_KEY=cog_...

curl -s "$APP_URL/api/connections" -H "Authorization: Bearer $COGSEND_API_KEY"
```

`X-API-Key` works as an alternative header; never put the key in the URL. The key
acts as you on drafts, variants, media, publish, schedule, queue, settings, and
reads — but it can never connect, re-verify or disconnect accounts, or create,
rotate, or revoke keys (those stay in the browser session). The global
`API_TOKEN` Worker secret still works as a bearer for backwards compatibility, on
exactly the same routes as a personal key — it cannot reach the session-only ones
either — but prefer the personal key for scripts: it is revocable without
touching the scheduler.

None of these alternatives apply to `/api/mcp`, which accepts only a personal
key as a bearer: see [MCP server](#mcp-server).

## MCP server

CogSend exposes a curated Model Context Protocol (MCP) server at
`<instance-origin>/api/mcp`. Tool results include text summaries and structured
JSON data. It uses **stateless Streamable HTTP**: clients send MCP requests over
HTTP POST, receive JSON responses, and do not need a session.
GET and DELETE return 405. CogSend does not provide resumable or server-sent
SSE, browser CORS, or OAuth login for this endpoint.

Authenticate every MCP request with an active CogSend personal key in the
standard header:

```http
Authorization: Bearer $COGSEND_API_KEY
```

MCP does not accept session cookies, `X-API-Key`, the legacy `API_TOKEN`,
scheduler credentials, or query-string credentials. A personal key is still
required if Cloudflare Access also protects the instance.

### Key permissions and tool scopes

The permission selected in **Settings → API access** controls the MCP tools as
well as the REST API. A **Read-only** key can call only the tools marked `read`.
A **Read + write** key can call both `read` and `write` tools (`write` includes
`read`). The mapping is enforced by the server on every tool call.

| Tool                   | Required key scope |
| ---------------------- | ------------------ |
| `list_connections`     | `read`             |
| `list_drafts`          | `read`             |
| `get_draft`            | `read`             |
| `validate_post`        | `read`             |
| `list_queue`           | `read`             |
| `create_draft`         | `write`            |
| `update_draft`         | `write`            |
| `duplicate_draft`      | `write`            |
| `delete_draft`         | `write`            |
| `set_draft_variant`    | `write`            |
| `delete_draft_variant` | `write`            |
| `publish_draft`        | `write`            |
| `schedule_draft`       | `write`            |
| `cancel_delivery`      | `write`            |
| `retry_delivery`       | `write`            |
| `reschedule_delivery`  | `write`            |

`list_drafts` and `list_queue` accept an optional `limit` from 1 to 100
(default 50). `list_connections` is unpaginated. The MCP catalog is not a mirror of every REST
route: it does not expose media operations, settings, insights, account or
provider management, API-key management, scheduler administration, the internal
publish endpoint, arbitrary HTTP requests, prompts, resources, or sampling.

### Approval and external effects

Use an MCP client that asks the operator to approve destructive and
open-world actions before execution. The tools annotated as destructive are
`update_draft`, `set_draft_variant`, `delete_draft`, `delete_draft_variant`,
`publish_draft`, `schedule_draft`, `cancel_delivery`, `retry_delivery`, and
`reschedule_delivery`. `publish_draft` and `retry_delivery` are also annotated
as open-world. Before approving publish, retry, schedule, or reschedule, verify
the content, destination, and timing; publish and retry can send content to an
external social network, while schedule and reschedule determine future posts.
The server marks tool risk with MCP annotations, but annotations are hints:
they do not enforce consent. CogSend v1 has no server-side preview/commit confirmation flow, so do
not assume the server will pause for approval if the client does not.

The current MCP SDK/protocol revision used by CogSend does not implement `ping`.
A client that sends `ping` may receive JSON-RPC `-32601` (method not found) with
HTTP 404. Do not use MCP `ping` as a health check.

### Try it with the official MCP Inspector

1. In **Settings → API access**, generate a personal key with the permissions
   you need. Copy it when it is displayed; CogSend will not show it again.
2. Start the official Inspector with `npx @modelcontextprotocol/inspector`.
3. In the Inspector, choose **Streamable HTTP**, enter
   `<instance-origin>/api/mcp`, and configure the request header
   `Authorization` using your CogSend key. Then connect, list the tools, and try
   a read tool such as `list_connections`.
4. Before calling a destructive or open-world tool, review its arguments and
   invoke it deliberately. Configure agent clients to require your approval.

The Inspector UI does not necessarily expand shell variables typed into a form.
Do not enter the literal text `$COGSEND_API_KEY` there and expect expansion; use
the Inspector's local header setting with the key retrieved securely. The CLI
example below uses normal shell variable expansion and never puts a key in the
URL or command source:

```sh
: "${COGSEND_INSTANCE_URL:?Set this to your instance origin}"
: "${COGSEND_API_KEY:?Load this from a secret manager}"
npx @modelcontextprotocol/inspector --cli \
  "$COGSEND_INSTANCE_URL/api/mcp" \
  --transport http \
  --protocol-era modern \
  --method tools/list \
  --header "Authorization: Bearer $COGSEND_API_KEY"
```

Inspector's CLI calls the Streamable HTTP transport `http`. If the instance is
protected by Cloudflare Access Service Auth, also pass the service-token headers
shown in [Cloudflare Access](access.md); the CogSend key and Access token are
different credentials.

A generic client configuration can be useful in addition to Inspector. This is
a template, not a promise that every client expands shell variables in the same
way. Configure the header through that client's supported environment or secret
store mechanism:

```json
{
	"mcpServers": {
		"cogsend": {
			"type": "http",
			"url": "<instance-origin>/api/mcp",
			"headers": {
				"Authorization": "Bearer $COGSEND_API_KEY"
			}
		}
	}
}
```

## Examples

Create a draft, then publish it to one account:

```sh
curl -s -X POST "$APP_URL/api/drafts" \
  -H "Authorization: Bearer $COGSEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title":"Hello","baseBody":"from a script"}'

curl -s -X POST "$APP_URL/api/drafts/DRAFT_ID/publish" \
  -H "Authorization: Bearer $COGSEND_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"connectionIds":["CONN_ID"]}'
```

## Limits

- A body is capped at 100,000 characters, and a variant may carry at most 100 explicit `threadSegments`.
- Each platform's own text and media limits are checked again at publish, so what the API accepts is not necessarily what a platform will take.

## Publishing behaviour

- Publishing the same draft and account twice reuses the row. Already-published accounts come back `skipped: true`.
- A publish that is still running on that account answers **409** with `inFlight` (the connection ids) — wait, then try again.
- A retried segment carries the same platform-side id as its first attempt, so a thread that failed half-way does not double-post what already went out (Mastodon remembers the id for an hour, Bluesky refuses to overwrite the record).
- Sending several connection ids in one request publishes them in order. The first always runs; each further one runs only if it fits in what is left of the request's Cloudflare call budget (50 on Workers Free, see `SUBREQUEST_LIMIT` in [Configuration](configuration.md#secrets)). The ones that don't fit come back with `status: "pending"` and `deferred: true`. They are already due and go out on the next scheduler tick, so don't send them again. For the fastest results, send one connection id per request. If a request still runs out, it answers `200` with `stopped: true`, `stoppedError`, and the results it did get — the accounts after the last entry were not completed and are still due (a target the failure interrupted is left retryable, never `publishing`), so send those ids again. A `500` means nothing was recorded; check the draft before retrying.
- Do not call `/api/targets/:id/retry` unless the row is `failed` (or a stuck `publishing` older than 15 minutes).
- Schedule returns **409** if that account is already published or still publishing. Check `error`, `alreadyPublished`, and `inFlight` instead of treating HTTP 200 as "it was scheduled".
