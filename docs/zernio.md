# Connect through Zernio

[Zernio](https://zernio.com/?utm_source=cogsend&utm_medium=sponsorship&utm_campaign=cogsend-integration&utm_content=provider-guide) is an optional publishing provider with a free plan, and a sponsor of CogSend. It holds approved developer apps for X, Threads, LinkedIn and Bluesky, so an account connected through it publishes without an app of your own: no LinkedIn app review, no Meta app, no X developer project or API credits. CogSend still writes, schedules, retries and records everything; Zernio only carries the publish.

Direct connections stay the default. Nothing here changes an account you connected with your own app, and the two kinds sit side by side on the Accounts page (Zernio-backed rows say **via Zernio**).

[Pricing](https://zernio.com/pricing?utm_source=cogsend&utm_medium=sponsorship&utm_campaign=cogsend-integration&utm_content=provider-guide-pricing) · [Use your own apps instead](oauth-apps.md)

## What you need

- A Zernio account with a profile, and an API key from **zernio.com → API keys**. A key restricted to the **publishing** and **accounts** groups is enough; it must be read-write. Keys limited to other profiles cannot see the accounts you want to import.
- A deployed CogSend, or a local one for import only: Zernio fetches your images from the instance's public media URL, so a `localhost` instance can import and post text, but not media.

## Import accounts you already have in Zernio

1. **Accounts → Connect new → Zernio.** Paste the key and press **Show my Zernio accounts**.
2. Tick the accounts to import and press **Import**. Each becomes an ordinary account here: it gets its platform's editor tab, limits and marks, and shows **via Zernio**.
3. The key is stored encrypted on each imported row. Opening the Zernio dialog again reuses it; paste a new key to replace it on the next import.

## Connect a new account through Zernio

In the same dialog, pick the platform and the Zernio profile under **Connect a new account through Zernio** and press **Connect**. You authorize on the platform, Zernio records the account, and you land back on Accounts with it imported.

**Reconnect** on a Zernio-backed row starts the same flow; **Check** asks Zernio whether the account still has a live token.

Bluesky is the exception: connect or reconnect it in Zernio's own dashboard, then import it (or press **Check**) here. Zernio's hosted Bluesky page cannot yet hand the account back to CogSend.

## What works the same, and what differs

| Feature                  | Through Zernio                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Compose, schedule, queue | Unchanged. CogSend's scheduler publishes at the scheduled minute by asking Zernio to publish now.                                            |
| Threads                  | X, Threads and Bluesky threads publish as threads. LinkedIn gets one post with the segments joined, as with a direct connection.             |
| Images and video         | Sent to Zernio as URLs on your instance, fetched at publish time. Platform size and format limits still apply.                               |
| Posts, retries, Insights | Unchanged. A publish is confirmed against Zernio before it is marked published; failures carry Zernio's reason.                              |
| Duplicates               | Zernio refuses the same text to the same account within 24 hours. The post parks as failed with that reason.                                 |
| Tokens                   | Zernio holds them and refreshes them. When a platform revokes one, the account shows **expired** here and **Reconnect** goes through Zernio. |
| Mastodon                 | Not available through Zernio: connect it directly.                                                                                           |

## Troubleshooting

- **"Zernio rejected this API key"**: the key is wrong, revoked or expired. Create a new one and import again.
- **"This Zernio API key cannot be used here"**: the key is read-only or lacks the publishing or accounts group.
- **A post parks with a Zernio reason**: read it in Posts. Content limits and platform refusals are the same ones a direct connection meets.
- **Media fails on a local instance**: Zernio cannot reach `localhost`. Deploy, or set `MEDIA_PUBLIC_BASE_URL` to a public origin.

Disconnecting an account here does not remove it from Zernio. Manage it there separately.
