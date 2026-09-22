<p align="center">
  <img width="150" alt="CogSend" src="https://github.com/user-attachments/assets/42c2579f-b1f2-4345-980a-01e24c9e027c" />
</p>

<h1 align="center">CogSend</h1>

<p align="center">
  Self-hosted social scheduler for Mastodon, Bluesky, LinkedIn, Threads and X.<br />
  Write a draft, customize it per platform, then publish it now or schedule it.<br />
  Single-tenant: one admin account, on your own Cloudflare account, with your own provider credentials.
</p>

<p align="center">
  <a href="#install">Install</a>
  ·
  <a href="#updating">Updating</a>
  ·
  <a href="#features">Features</a>
  ·
  <a href="#documentation">Documentation</a>
  ·
  <a href="#stack">Stack</a>
  ·
  <a href="docs/deploy.md">Deploy guide</a>
  ·
  <a href="docs/api.md">API</a>
  ·
  <a href="CONTRIBUTING.md">Contributing</a>
  ·
  <a href="SECURITY.md">Security</a>
</p>

<p align="center">
  <a href="https://github.com/deepakness/cogsend/actions/workflows/ci.yml"><img alt="Checks" src="https://img.shields.io/github/actions/workflow/status/deepakness/cogsend/ci.yml?branch=main&label=checks&style=flat-square"></a>
  <a href="https://github.com/deepakness/cogsend/releases"><img alt="Release" src="https://img.shields.io/github/v/release/deepakness/cogsend?style=flat-square"></a>
  <img alt="Node 22.12 or newer" src="https://img.shields.io/badge/Node-22.12%2B-339933?style=flat-square" />
  <img alt="Cloudflare Workers" src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square" />
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-lightgrey?style=flat-square"></a>
</p>

<p align="center">
  <img width="880" alt="CogSend screenshot" src="https://github.com/user-attachments/assets/e701a2f5-0c58-4302-b775-84f1e3a694a7" />
</p>

## Features

- Thread editor: one card per post, images with alt text, a Global tab plus a tab per platform
- Pasting a long draft splits it into a thread that fits the tightest platform you
  selected, counted each platform's own way (graphemes, Mastodon's URL weighting)
- Link preview cards for URLs in a post
- Publish now with per-destination results, or schedule; cancel, reschedule and retry from Posts
- Retryable failures back off on their own — five attempts, then they park in Failed
- Insights: published against failed over 7, 30 or 90 days, per-account stats and why posts failed
- Disconnecting an account removes its scheduled posts, returns drafts that were still waiting, and keeps published history
- Credentials encrypted at rest (AES-256-GCM), with 2FA on the single admin account
- Personal API key for scripts and Shortcuts (`Settings → API access`)
- Agent-ready: ships a SKILL.md plus plugin manifests so Claude Code, Codex,
  Hermes, Pi, OpenCode and friends can draft, schedule and publish through the
  API

## Install

Needs Node 22.12+ and a Cloudflare account with Workers, D1 and R2 available. R2
asks for a payment method on file even on the free tier.

```sh
git clone --depth 1 https://github.com/deepakness/cogsend.git cogsend
cd cogsend && npm install && npm run setup
```

`setup` is the whole install: `wrangler login`, the D1 database and the R2 bucket,
the secrets, your admin account, the migrations, the deploy, then one sign-in
against the live Worker to prove it works. Open the URL it prints, sign in, and
scan the QR with an authenticator app — and save the backup codes.

It is safe to re-run: resources, secrets and the account are reused, not replaced.
`npm run setup -- --dry-run` prints the plan without changing anything, and
[docs/deploy.md](docs/deploy.md#what-setup-does-command-by-command) lists every
command it runs. Lost the password or the authenticator later?
`npm run admin:reset -- --all` from your checkout
([Configuration → The login](docs/configuration.md#the-login)).

## Updating

```sh
git pull && npm ci && npm run deploy:release
```

`deploy:release` runs the tests, applies migrations, builds and deploys. Your data
is in D1 and R2, not in the checkout, so a pull cannot touch it. Settings → Instance
and `npm run doctor` both report the running version and say when a newer release
is out; [docs/deploy.md → Updating](docs/deploy.md#updating-and-rolling-back) covers
release tags and rolling back.

## Documentation

| Page                                   | What is in it                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [Deploying](docs/deploy.md)            | the install, what it does command by command, domains and URLs, updating and rolling back, backups, troubleshooting |
| [Configuration](docs/configuration.md) | secrets, the instance name, `APP_URL`, keeping your deployment separate from upstream, the login and recovery       |
| [OAuth apps](docs/oauth-apps.md)       | LinkedIn, Threads and X app setup, and what each platform allows                                                    |
| [Scheduling](docs/scheduling.md)       | the cron trigger, the free-plan trigger limit, external pingers, failure emails                                     |
| [API](docs/api.md)                     | personal API keys and worked examples (the full reference is in-app at `/api`)                                      |
| [AI agents](docs/agents.md)            | driving an instance from Claude Code, Codex, Hermes, Pi and other agents                                            |
| [Cloudflare Access](docs/access.md)    | putting an extra gate in front of an instance                                                                       |
| [Development](docs/development.md)     | local setup, the checks that must pass, code expectations                                                           |

## Stack

SvelteKit 2 + Svelte 5 on Cloudflare Workers with Static Assets, D1 (SQLite) via
Drizzle, R2 for media, and a per-minute cron trigger — or any external cron
calling `/api/internal/tick`.

## Contributing

[docs/development.md](docs/development.md) has local setup and the checks that
must pass; [CONTRIBUTING.md](CONTRIBUTING.md) has the pull-request rules. Security
issues: [SECURITY.md](SECURITY.md) — report them privately.

## License

MIT — see [LICENSE](LICENSE). Third-party notices are in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
