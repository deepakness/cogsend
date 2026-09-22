# Development

Local setup, the checks that must pass, and what the code expects.

## Getting set up

```sh
git clone https://github.com/deepakness/cogsend.git   # or your fork
cd cogsend
npm install
cp .dev.vars.example .dev.vars   # then generate a real APP_ENCRYPTION_KEY
npm run db:seed:local            # applies the migrations and creates a local account
npm run dev                      # http://localhost:5173
```

`.dev.vars` needs `APP_ENCRYPTION_KEY` (`openssl rand -hex 32`) — the only secret
the app requires. `AUTH_SECRET` and `SCHEDULER_SECRET` are derived from it unless
you set them, and `APP_URL` is taken from the request when it is unset.

Local development needs an account too, and the app will not create one: the
single account is written into D1 by `npm run setup` on a real deployment, and by
`npm run db:seed:local` for your local database. Run it once, then sign in at
http://localhost:5173 with the credentials it prints (`--password` gives you one
you can remember; `--reset` replaces an existing local account). It applies the
local migrations first, so `npm run db:migrate:local` is only needed on its own
when you add a migration.

The first sign-in asks you to enrol an authenticator (Google Authenticator or any
TOTP app); save the backup codes. Set `SKIP_TOTP=1` in `.dev.vars` to skip that
while developing — it is honored only while the instance resolves to a localhost
URL, so it can never weaken a deployment. Remove it and restart to go back to
real 2FA.

`npm run dev` ticks due posts every 30 seconds automatically, and
`npm run doctor` reports what it finds — locally or against a deployment — with
what to do about it.

## Checks

```sh
npm test          # vitest unit + integration tests
npx playwright install chromium   # once: the e2e suite drives a real browser
npm run test:e2e  # Playwright suite against a local build of the Worker
npm run test:e2e:totp  # the same suite with 2FA required (CI runs this too)
npm run check     # svelte-check
npm run lint      # prettier --check + eslint
npm run build     # production worker + wrapped scheduled handler
```

All of these must pass. CI runs the same list, plus `npm audit --audit-level=high` —
a newly published advisory can fail a build that passes locally, so run it before
pushing a dependency change. `npm run format` fixes formatting.

The e2e suite keeps to itself: its D1/R2 state lives in `.wrangler/e2e-state`, so
your `npm run dev` data is never touched, and it creates its own account there
(`scripts/seed-local.mjs`, run by the Playwright config) rather than borrowing
yours. If you have no `.dev.vars`, it seeds one from
`tests/e2e/fixtures/dev.vars`; an existing file is used as-is, so put
`SKIP_TOTP=1` in yours to match the path CI takes.

The suite is one serial journey, not independent tests: the first spec signs in
and later ones rely on what it left behind. So `npx playwright test -g "<a later
spec>"` fails on its own — no session, no seeded account — and a `-g` run proves
nothing about that spec. Run the whole file (`npx playwright test
tests/e2e/smoke.e2e.ts`) before believing a failure or a pass.

## Code expectations

- **Comments explain why, not what.** The existing files are a good reference: comment the protocol quirk, the retry rule, or the failure mode you are working around — not the syntax.
- **Keep provider code inside `src/lib/server/providers/`** behind the shared `Provider` interface, so a new platform cannot drift from the others.
- **Server code stays on the server.** Everything under `src/lib/server/` and every `+server.ts` runs in a Worker, where the DOM does not exist: lint rejects `window`, `document`, `localStorage` and friends there, so take what you need from `event.locals` instead.
- **No new dependencies without a reason.** The runtime dependency list is deliberately small.
- **Tests for behavior, not for mocks.** Assert what the app does, not that a spy was called.
