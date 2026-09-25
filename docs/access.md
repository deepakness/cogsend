# Putting it behind Cloudflare Access

Optional. The app has its own login, so Access is an extra gate for an instance only you (or a small team) reach — it does not replace the login, and it does not replace the secrets: `APP_ENCRYPTION_KEY` still encrypts your provider tokens and derives the key that signs the publish-time media URLs, and `AUTH_SECRET` still signs sessions and OAuth state.

## Turning it on

Workers → your Worker → **Access**, or the `workers.dev` one-click. On `workers.dev` it is set up through that Workers dashboard flow, because the Zero Trust domain picker only lists domains from a zone.

Access requires Zero Trust to be enabled, which asks for payment details even on the free plan (50 users; service tokens do not consume seats). An account-wide "Protect all Workers" setting applies to new deployments too, and needs the same exemptions as below.

## The paths it has to let through

Four things need exemptions or they break:

- **Media for Meta's crawler.** `/api/media/public/*` must stay reachable without a login, or Threads and Mastodon cannot fetch images. Add a separate Access application for that path with a **Bypass / Include Everyone** policy.
- **Scripts and pingers.** Anything calling the API with a bearer key, or the tick endpoint, needs a **Service Auth** policy and a service token (`CF-Access-Client-Id` / `CF-Access-Client-Secret`) alongside the app's own key. A bypass policy would also work, but it is neither authenticated nor logged.
- **MCP clients.** A protected `/api/mcp` request needs the CogSend personal key in `Authorization: Bearer …` and, when the Access policy uses Service Auth, the `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers too. They are separate credentials; keep all of them in your environment or a secret manager, never in a URL or a committed client config. The Inspector CLI takes headers on each request:

  ```sh
  : "${COGSEND_INSTANCE_URL:?Set this to your instance origin}"
  : "${COGSEND_API_KEY:?Load it from a secret manager}"
  : "${CF_ACCESS_CLIENT_ID:?Load it from a secret manager}"
  : "${CF_ACCESS_CLIENT_SECRET:?Load it from a secret manager}"
  npx @modelcontextprotocol/inspector --cli \
    "$COGSEND_INSTANCE_URL/api/mcp" \
    --transport http \
    --protocol-era modern \
    --method tools/list \
    --header "Authorization: Bearer $COGSEND_API_KEY" \
    --header "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
    --header "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
  ```

  If your MCP client cannot send custom headers, use one that supports Service Auth, or bypass Access for `/api/mcp` alone if you accept that Access will not authenticate those requests. The personal key is still required either way. Do not bypass Access for the whole instance.

- **OAuth callbacks.** If a provider redirects back while your Access session has expired, Access intercepts it before the app sees the code. Bypass `/api/connections/*/callback` if that happens.

## What keeps working

The cron trigger is unaffected: the scheduled handler calls the Worker in-process, never over HTTP.
