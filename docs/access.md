# Putting it behind Cloudflare Access

Optional. The app has its own login, so Access is an extra gate for an instance only you (or a small team) reach — it does not replace the login, and it does not replace the secrets: `APP_ENCRYPTION_KEY` still encrypts your provider tokens and derives the key that signs the publish-time media URLs, and `AUTH_SECRET` still signs sessions and OAuth state.

If you enable it (Workers → your Worker → **Access**, or the `workers.dev` one-click), three things need exemptions or they break:

- **Media for Meta's crawler.** `/api/media/public/*` must stay reachable without a login, or Threads and Mastodon cannot fetch images. Add a separate Access application for that path with a **Bypass / Include Everyone** policy.
- **Scripts and pingers.** Anything calling the API with a bearer key, or the tick endpoint, needs a **Service Auth** policy and a service token (`CF-Access-Client-Id` / `CF-Access-Client-Secret`) alongside the app's own key. A bypass policy would also work, but it is neither authenticated nor logged.
- **OAuth callbacks.** If a provider redirects back while your Access session has expired, Access intercepts it before the app sees the code. Bypass `/api/connections/*/callback` if that happens.

The cron trigger is unaffected: the scheduled handler calls the Worker in-process, never over HTTP. Access also requires Zero Trust to be enabled, which asks for payment details even on the free plan (50 users; service tokens do not consume seats), and on `workers.dev` it is set up through the Workers dashboard flow because the Zero Trust domain picker only lists domains from a zone. An account-wide "Protect all Workers" setting applies to new deployments too, and needs the same exemptions.
