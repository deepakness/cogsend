# Connecting accounts

**Accounts** lists every connected account and how to add another. **Connect new**
opens the platform picker.

## Mastodon and Bluesky

These two connect with what you already have:

- **Mastodon** — enter your instance's address and approve CogSend on your
  instance. The app registers itself there; there is nothing to create first.
- **Bluesky** — enter your handle and an **app password**, which you create in
  Bluesky under Settings → Privacy and security → App passwords. Never use your
  main password.

## LinkedIn, Threads and X

These three need a developer app of your own before they can connect, because the
platform issues the client id and secret the Worker uses. Until one is set up, the
picker shows the platform with a **Needs setup** badge, and choosing it shows that
platform's steps — the redirect URI to register and the Worker secrets to set —
instead of a connect attempt that cannot succeed. The full steps are in
[OAuth apps](oauth-apps.md).

Once the secrets are on the Worker, reload the page and connect as usual.

If you would rather not set up an app, you can connect these through
[Zernio](zernio.md) instead.

## When an account needs reconnecting

A token that stops working marks the account as needing a reconnect, both here and
in the composer's account list; **Reconnect** starts the same flow again and keeps
the account's history. The usual cause is LinkedIn: a self-created LinkedIn app
gets a 60-day token and nothing to renew it with, so it has to be reconnected every
60 days ([why](oauth-apps.md#linkedin)).

## Disconnecting

Disconnecting an account removes its scheduled posts, returns drafts that were
still waiting, and keeps what it already published — the confirmation says how many
of each. A disconnected account's history stays in [Insights](posts.md#insights),
marked **Archived**.
