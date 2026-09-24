# Zernio provider

Optional way to publish to X, Threads, LinkedIn and Bluesky through [Zernio](https://zernio.com)'s API instead of the operator's own developer apps. Direct connections stay the default and are not touched.

## Why

LinkedIn, Threads and X only connect once the operator has registered an app at the provider and put its client credentials on the Worker. That is the step most people never finish. Zernio holds approved apps for those platforms, so an account connected through it publishes without any app of its own. Zernio sponsors CogSend for this; the branding that comes with the sponsorship is separable from the provider (see Branding).

## Decisions

- **Zernio is a transport, not a platform.** An account imported from Zernio is an ordinary `connections` row with its real platform (`x`, `threads`, `linkedin`, `bluesky`), so the editor tabs, per-platform limits, marks, Insights and disconnect keep working unchanged. A `provider: 'zernio'` marker in `meta_json` routes publishing to the Zernio provider. No schema change.
- **CogSend stays the scheduler.** Posts are created in Zernio with `publishNow` at the moment CogSend's own tick decides to publish. Zernio's scheduler, queue and dashboard are not used, so Posts, cancel, retry and Insights remain the single source of truth.
- **Publishes are confirmed by polling, and a retry resumes by polling.** Zernio publishes asynchronously. The provider checkpoints the Zernio post id the moment it is created, polls until the platform entry reaches `published` or `failed`, and on a poll timeout throws a partial error carrying that id so the retry polls it instead of creating a second post.
- **The API key lives on each connection, encrypted**, the way the Bluesky app password does. Disconnect wipes it. The server reuses a key already stored on any Zernio connection when a request omits one, so the key is pasted once.
- **Both ways in: import existing accounts, and connect a new account through Zernio.** Everything Zernio supports among CogSend's platforms is offered (Mastodon is not, and stays direct-only).

## Data model

One row per imported account in `connections`:

| Column                  | Value                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `platform`              | CogSend id: `x`, `threads`, `linkedin`, `bluesky` (Zernio calls X `twitter`)            |
| `handle`                | Zernio `username` without a leading `@`, or null                                        |
| `display_name`          | Zernio `displayName`, falling back to the handle                                        |
| `avatar_url`            | Zernio `profilePicture`                                                                 |
| `credentials_encrypted` | `{ zernioApiKey, zernioAccountId }`                                                     |
| `meta_json`             | `{ provider: 'zernio', zernioAccountId, zernioProfileId }`                              |
| `status`                | `active`, or `expired` when Zernio reports `needsReconnection` or rejects the key       |

`ConnectionCredentials` gains `zernioApiKey?` and `zernioAccountId?`; `ConnectionMeta` gains `provider?` and `zernioAccountId?`. `isZernioConnection(meta)` in `$lib/domain/zernio.ts` is the one place that reads the marker.

Reconnect matching: the candidate set is the user's rows on that platform whose meta has `provider === 'zernio'`, matched on `zernioAccountId` only. There is no handle fallback: a direct-X row and a Zernio-X row for the same handle are different connections and must never overwrite each other.

## Provider

`src/lib/server/providers/zernio.ts` exports `zernioProviderFor(platform)` (memoised per platform), returning a `PlatformProvider` whose `id` and `capabilities` are the underlying direct provider's and whose `validate` delegates to it, so a Zernio-backed X account is held to X's limits in the composer. `providerFor(conn)` in `providers/index.ts` picks the Zernio provider when the connection's meta carries the marker; `publish.ts` and the verify route call it instead of `getProvider(conn.platform)`.

`publish(content, creds, meta, fetchImpl, opts)`:

1. If `opts.resume.segmentIds[0]` is set, skip creation and poll that Zernio post id.
2. Otherwise `POST https://zernio.com/api/v1/posts` with `Authorization: Bearer <zernioApiKey>` and `x-request-id: <opts.idempotencyKey(0) with ':' replaced by '-'>` (Zernio accepts `[\w.-]{1,128}` and replays the original response for five minutes). Body:
   - `platforms: [{ platform, accountId, platformSpecificData? }]`, `publishNow: true`.
   - One segment: `content` and top-level `mediaItems`.
   - Several segments on X, Threads or Bluesky: `content` is the first segment and `platformSpecificData.threadItems` carries every segment as `{ content, mediaItems }`.
   - LinkedIn: segments are flattened into one post (text joined with a blank line, media combined), the same as the direct LinkedIn provider.
   - A media item is `{ type: 'image' | 'gif' | 'video', url, altText?, mimeType }` where `url` is `opts.mediaUrlFor(storageKey)`, the same public URL the Threads provider hands Meta (signed Worker route, two-hour lifetime, or `MEDIA_PUBLIC_BASE_URL`). Absent `mediaUrlFor` is an error, as for Threads. No bytes are uploaded to Zernio.
3. Checkpoint `{ segmentIds: [postId], remoteUrl: null }` immediately.
4. Poll `GET /v1/posts/{postId}` every 3 s, up to 8 times. The platform entry decides: `published` returns `{ remotePostId: platformPostId ?? postId, remoteUrl: platformPostUrl, segmentIds: [postId] }`; `failed` throws (below). After the last poll, throw `PublishPartialError('Zernio is still publishing this post', { segmentIds: [postId] })`: it is retryable by the existing classification, the scheduler retries on backoff, and the resume path polls.

Errors map onto `ProviderError` codes so `publish.ts` decides expiry and retry without message matching:

| Zernio answer                                                                 | Code           | Effect                                     |
| ----------------------------------------------------------------------------- | -------------- | ------------------------------------------ |
| HTTP 401                                                                      | `auth`         | connection `expired`, not retried          |
| HTTP 429                                                                      | `rate_limited` | retried on backoff                         |
| HTTP 5xx, network failure                                                     | `upstream`     | retried on backoff                         |
| HTTP 400, 402, 403, 404, 409 (validation, billing gate, permission, dedup)    | `forbidden`    | parked as failed, connection stays active  |
| platform entry `failed` with `errorCategory: auth_expired`                    | `auth`         | connection `expired`                       |
| platform entry `failed` with `platform_error` or `system_error`               | `upstream`     | retried; the checkpoint is discarded by `markFailed`, so the retry creates a new post |
| platform entry `failed`, any other category                                   | `forbidden`    | parked as failed                           |

Messages are prefixed `Zernio …` and carry Zernio's `error` or `errorMessage` text so the Posts tab shows why. The capped response body goes in `detail`. Zernio's 24-hour content-hash dedup (409) is the one that will surprise people: the message says the same content was posted to this account in the last 24 hours.

`publishCallEstimate` gets a `zernio` case (one create, up to eight polls, no storage reads for media). `publish.ts` derives the estimate key from the connection, not the platform column.

No `refreshIfNeeded`, `alignCredentials` or `refreshImpossibleReason`: Zernio owns the platform tokens.

## Zernio client

`src/lib/server/zernio.ts`: a thin fetch wrapper around the calls the feature needs (`listProfiles`, `listAccounts`, `connectUrl`, `createPost`, `getPost`), each taking `{ apiKey, fetchImpl }`, translating non-2xx answers into `ProviderError` via the table above, and mapping platform ids both ways (`toZernioPlatform`, `fromZernioPlatform`, both in `$lib/domain/zernio.ts` because the UI needs them too). Base URL `https://zernio.com/api`. No SDK, no new dependency.

## Connect flows

All routes are session-only (`requireSession`), like the other connect routes. Every Zernio call from these routes is made with the key from the request body or, when omitted, the key stored on any of the user's Zernio connections.

**List** `POST /api/connections/zernio/accounts` `{ apiKey? }` → `{ profiles: [{ id, name }], accounts: [{ id, platform, profileId, handle, displayName, avatarUrl, needsReconnection, imported }] }`. Accounts are filtered to the four supported platforms and `enabled !== false`; `imported` says whether a row with that `zernioAccountId` already exists. A 401 from Zernio becomes a 400 "Zernio rejected this API key"; a 403 `insufficient_permissions` names the resource group the key is missing.

**Import** `POST /api/connections/zernio/import` `{ apiKey?, accountIds: string[] }` → upserts one row per id (fetched again from Zernio, never trusted from the browser), returns `{ connections }`. Importing an account that is already imported refreshes its name, avatar, key and status.

**Connect a new account** `POST /api/connections/zernio/connect` `{ apiKey?, profileId, platform }` → stores an `oauth_pending` row (`instance_url: 'zernio'`, `client_id: profileId`, `client_secret_enc`: the encrypted key), binds its id to the session with `bindOAuthState`, asks Zernio for `GET /v1/connect/{zernioPlatform}?profileId&redirect_url=<APP_URL>/api/connections/zernio/callback?pending=<bound state>` and returns `{ authorizeUrl }`. Zernio hosts its own selection UI (LinkedIn pages, and so on) and then redirects to that URL with `connected`, `profileId`, `accountId` and `username` on success or `error`, `platform` and `error_message` on failure; query parameters already on the redirect URL are preserved.

**Callback** `GET /api/connections/zernio/callback` (public path, like the other callbacks) verifies the state against the pending row the way `createOAuthCallback` does, imports the account named by `accountId` with the pending row's key, deletes the pending row and redirects to `/accounts?connected=<platform>`, or `/accounts?error=<message>` on failure.

**Reconnect** on a Zernio row starts the connect flow for that platform with the stored key and profile; the account comes back matched on its `zernioAccountId`, so the row revives in place.

**Verify** on a Zernio row lists the account through Zernio: found and not `needsReconnection` → `active`; `needsReconnection` → `expired` with "Reconnect this account in Zernio"; 401 → `expired` with "Zernio rejected the stored API key"; anything else keeps the status and answers 502, like the Mastodon branch.

## Accounts page

- The connect dialog lists **Zernio** after the direct platforms: "Post through Zernio's API, no developer app needed. Paid service and sponsor of CogSend." Picking it opens a form: API key field (with a link to where keys are created), then the account list from the list route with a checkbox per account (already imported ones checked and disabled), an **Import** button, and a **Connect a new account through Zernio** row with a platform picker and profile select that starts the connect flow. When a key is already stored, the field is optional and the list loads on open.
- Account rows carry a small **via Zernio** tag next to the platform name when the connection's meta says so. Reconnect and Check on such rows follow the flows above.
- The `Connection` type on the page gains `metaJson?: { provider?: string }` (the API already sends it).
- Copy for every Zernio mention in the UI is the maintainer's to rewrite; the PR ships plain, factual sentences.

## Branding and links

- `src/lib/domain/zernio-links.ts` mirrors OpenReply's helper: `zernioLink({ path, placement })` builds every outbound link from one base URL with `utm_source=cogsend`, `utm_medium=sponsorship`, `utm_campaign=cogsend-integration`, `utm_content=<placement>`, and refuses non-Zernio destinations. The base is `https://zernio.com` until the maintainer's affiliate URL exists; swapping it is a one-line change.
- README: a short "Supported by Zernio" note under the intro and a row in the Documentation table pointing at `docs/zernio.md`. The maintainer writes the final copy; the PR text is a placeholder for tone, not for facts.
- `docs/zernio.md`: what Zernio is, the paid-and-sponsor disclosure, the key to create (a restricted key with only `publishing` and `accounts` enabled is enough), import and connect steps, a feature table (threads on X/Threads/Bluesky, single post on LinkedIn, media as public URLs, Zernio's 24-hour duplicate rejection, no Mastodon, no local-dev media because Zernio must reach the URL), troubleshooting, and that disconnecting in CogSend does not delete the account in Zernio.
- `docs/oauth-apps.md` intro gets one sentence pointing at `docs/zernio.md` as the alternative to registering apps.
- Branding lives in its own commit (README note, table row, the two link placements) so that ending the sponsorship is one revert. The provider, its docs page and the dialog entry stay.
- The landing page is not in this repository.

## Testing

Unit and integration tests in the existing style (real SQLite test database, stubbed `fetch`, assertions on behaviour):

- `tests/zernio-provider.test.ts`: request bodies for single post, thread, LinkedIn flatten and media mapping; `x-request-id` derivation; polling to `published`; `failed` with each category; poll timeout throws the partial error with the post id; resume polls without creating; HTTP status classification.
- `tests/zernio-connect.test.ts`: session-only; account listing with platform mapping, filtering and the `imported` flag; stored-key reuse; import upserts only Zernio rows and never a direct row with the same handle; connect stores the pending row and returns Zernio's auth URL; callback verifies state, imports, redirects.
- `tests/publish.test.ts`: `publishTarget` through a Zernio connection end to end: published with permalink; timeout → `scheduled` with backoff → next attempt resumes by polling and never re-creates; Zernio `auth_expired` expires the connection.
- `tests/verify-route.test.ts`: the Zernio branch.
- `tests/zernio-links.test.ts`: UTMs, placement, refusal of foreign hosts.
- `tests/platform-setup.test.ts` and the e2e journey stay untouched; the dialog entry is not exercised by the browser suite.

Before the PR opens, the whole flow is exercised against a real Zernio team account (import, connect-through, one publish per platform, one thread, one image post, verify, reconnect), and the maintainer gets the same test key to repeat it.

## Out of scope

- Zernio's own scheduling, queues, analytics, inbox.
- Migrating an existing direct connection to Zernio or back.
- Mastodon through Zernio (unsupported upstream).
- Landing page changes (outside the repository).
