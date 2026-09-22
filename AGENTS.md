# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

cogsend is a single-tenant social scheduler for Mastodon, Bluesky, LinkedIn, Threads and X.
It is a SvelteKit app deployed on Cloudflare Workers, with D1 (SQLite) for storage and R2
for media. One admin account, self-hosted on the operator's own Cloudflare account, with
the operator's own provider credentials.

## Commands

| Command                | Purpose                                  |
| ---------------------- | ---------------------------------------- |
| npm run dev            | Start the Vite dev server                |
| npm run check          | svelte-kit sync + svelte-check typecheck |
| npm run lint           | prettier --check + eslint                |
| npm run test           | Run unit tests once (vitest run)         |
| npm run test:e2e       | Prepare and run Playwright e2e tests     |
| npm run setup          | Interactive first-run setup script       |
| npm run deploy:release | Build and deploy a release to Cloudflare |
| npm run doctor         | Environment and config diagnostics       |

Node 22.12 or newer is required. See docs/development.md for the full workflow.

## Repo layout

| Path           | Contents                                              |
| -------------- | ----------------------------------------------------- |
| src/           | SvelteKit app (routes, components, server code)       |
| drizzle/       | D1 schema and migrations                              |
| scripts/       | Setup, deploy, migrate, doctor and e2e helper scripts |
| static/        | Static assets                                         |
| tests/         | Unit and e2e tests                                    |
| docs/          | Operator and API documentation                        |
| skills/        | Agent skills (see skills/cogsend/SKILL.md)            |
| wrangler.jsonc | Cloudflare Workers configuration                      |

## Pull request rules

- Use conventional-commit PR titles (feat:, fix:, docs:, chore:, refactor:, test:).
- One logical change per PR. Do not mix refactors with feature work.
- Update docs when behavior, config, or API surface changes.
- Run npm run check and npm run lint before opening a PR; run npm run test for
  code changes and npm run test:e2e when touching routes or auth flows.

## Driving an instance from an agent

To operate a running cogsend instance (draft, schedule, publish, list posts) use the
skill at skills/cogsend/SKILL.md and the API contract in docs/agents.md.

The instance is driven through two environment variables:

| Variable        | Meaning                                                                    |
| --------------- | -------------------------------------------------------------------------- |
| APP_URL         | Base URL of the deployed instance, for example https://cogsend.example.com |
| COGSEND_API_KEY | API key issued by the instance admin                                       |

Both must be set before invoking any API endpoint. See docs/api.md for endpoint details.
