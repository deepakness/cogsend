# CogSend

[![CI](https://github.com/deepakness/cogsend/actions/workflows/ci.yml/badge.svg)](https://github.com/deepakness/cogsend/actions/workflows/ci.yml)

Minimal social scheduler for Mastodon, Bluesky, LinkedIn, Threads, and X. Write a
draft, optionally customize it per platform, then publish it now or schedule it.
Bring your own credentials: single-tenant by design, one admin account on your
own Cloudflare account.

## Install

One way to install: a terminal, `wrangler`, and `npm run setup`. It creates the D1
database, the R2 bucket, the secrets and your account, applies the migrations,
deploys, and signs in once against the live Worker to prove it works. Node 22.12+
and a Cloudflare account are all it needs — R2 asks for a payment method on file,
even on the free tier.

```sh
git clone --depth 1 https://github.com/deepakness/cogsend.git cogsend
cd cogsend && npm install && npm run setup
```

`setup` is a guided run: it signs in through `wrangler login`, asks for an admin
email and a password (generated and shown once, or one you type), and prints the
URL when it is done. Then open that URL, sign in, and scan the QR shown there
with an authenticator app. Save the backup codes.

The account is written into D1 before the Worker can answer its first request, so
there is nothing to claim and no window in which someone else could get there
first — and only a PBKDF2 hash is stored, never the password itself.

Safe by default: re-running `setup` reuses what exists, leaves the secrets and the
account alone, and `npm run setup -- --dry-run` prints the plan without changing
anything. Every command it runs is in
[docs/deploy.md](docs/deploy.md#what-setup-does-command-by-command).

## Updating

```sh
git pull && npm ci && npm run deploy:release   # tests, migrations, build, deploy
```

Settings → Instance and `npm run doctor` both say when a newer release is out.
[docs/deploy.md → Updating](docs/deploy.md#updating-and-rolling-back) has the
details, including rolling back.

## Docs

| Page                                   | What is in it                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [Deploying](docs/deploy.md)            | the install, what it does command by command, updating and rolling back, troubleshooting         |
| [Configuration](docs/configuration.md) | secrets, the instance name, `APP_URL`, keeping your deployment separate from upstream, the login |
| [Scheduling](docs/scheduling.md)       | the cron trigger, the free-plan trigger limit, external pingers, failure emails                  |
| [OAuth apps](docs/oauth-apps.md)       | LinkedIn, Threads and X app setup, and what each platform allows                                 |
| [API](docs/api.md)                     | personal API keys and worked examples (the reference lives in-app at `/api`)                     |
| [Cloudflare Access](docs/access.md)    | putting an extra gate in front of an instance                                                    |
| [Development](docs/development.md)     | local setup, the checks that must pass, code expectations                                        |

## Features

- Thread editor: one card per post, images with alt text, a Main tab plus per-platform tabs
- Publish now (per-destination results and retry) or schedule; cancel, reschedule and retry from Posts
- Retryable failures back off on their own — five attempts, then they park as Failed
- Disconnecting an account keeps its published history and returns waiting drafts
- Credentials encrypted at rest (AES-256-GCM), with 2FA on the single admin account
- Personal API key for scripts, Shortcuts and cron jobs (`Settings → API access`)
- Settings shows the running version, whether the scheduler is ticking, and when a newer release is out

## Stack

SvelteKit 2 + Svelte 5 on Cloudflare Workers with Static Assets, D1 (SQLite) via
Drizzle, R2 for images, and a per-minute cron trigger — or any external cron
calling `/api/internal/tick`.

## Contributing

[docs/development.md](docs/development.md) has local setup and the checks that
must pass; [CONTRIBUTING.md](CONTRIBUTING.md) has the pull-request rules.
Security issues: [SECURITY.md](SECURITY.md) — please report them privately.
