# OAuth apps and platform limits

Mastodon and Bluesky connect with what you already have. LinkedIn, Threads and X
need an app registered at the provider first, because they issue the client id
and secret the Worker uses.

## OAuth app setup

Mastodon (per instance) and Bluesky (app password) need no setup. LinkedIn, Threads, and X need apps:

- **LinkedIn**: create an app at the LinkedIn Developer Portal, enable the "Share on LinkedIn" product, add redirect `{APP_URL}/api/connections/linkedin/callback`, then set Worker secrets `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET`.
- **Threads**: create a Meta app with the Threads use case, add redirect `{APP_URL}/api/connections/threads/callback`, then set Worker secrets `THREADS_APP_ID` / `THREADS_APP_SECRET`.
- **X**: create a Project + App at the X Developer Console, enable OAuth 2.0 with type "Web App", add redirect `{APP_URL}/api/connections/x/callback`, then set Worker secrets `X_CLIENT_ID` / `X_CLIENT_SECRET`. Posting uses pay-per-use API credits — fund a small balance in the console first.

Without these, those three platforms are listed in the accounts dialog with a **Needs setup**
badge. Picking one shows that platform's own steps — the redirect URI to register and the
Worker secrets to set — instead of a connect attempt that cannot succeed. Mastodon and
Bluesky keep working either way.

## Platforms

| Platform | Auth                                                                     | Text                       | Images                                 | Threads                      |
| -------- | ------------------------------------------------------------------------ | -------------------------- | -------------------------------------- | ---------------------------- |
| Mastodon | OAuth (per instance)                                                     | instance max (default 500) | 4, 16MB                                | yes                          |
| Bluesky  | handle + app password                                                    | 300                        | 4, 1MB                                 | yes                          |
| LinkedIn | OAuth (`openid profile email w_member_social`)                           | 3000                       | 4, 8MB (no WebP)                       | no — flattened into one post |
| Threads  | OAuth (`threads_basic threads_content_publish` `threads_manage_replies`) | 500, max 5 links           | 4 uploadable, 10 allowed, 8MB JPEG/PNG | yes                          |
| X        | OAuth 2.0 + PKCE                                                         | 280, max 1 cashtag         | 4, 5MB (15MB GIF)                      | yes                          |

Threads images are served to Meta via short-lived signed URLs (2h expiry, never linked publicly). Meta's crawler intermittently fails to fetch a URL that works moments later (subcode 2207052), so media containers retry with a freshly signed URL and the failure stays retryable; a custom public media origin can be configured with `MEDIA_PUBLIC_BASE_URL` (for example an R2 custom domain behind Cloudflare's cache) to skip the Worker hop entirely. That path is a trade-off: those URLs are not signed and never expire, protected only by the randomness in the object key, so keep the origin unlisted and treat a leaked URL as permanent — remove the variable to go back to signed URLs. LinkedIn rejects WebP at publish time — upload JPEG/PNG/GIF.

Video is off unless you set `ENABLE_VIDEO_UPLOAD=1` as a Worker secret or var:
LinkedIn takes one MP4 per post, with no images mixed in. The upload path is wired
but has not been verified end to end against LinkedIn's live API, which is why it
ships disabled — the file picker hides video until it is on, and the API refuses
video files.
