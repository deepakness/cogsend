# Deploying CogSend

One way to deploy: your terminal, `wrangler`, and `npm run setup`. It creates the
D1 database, the R2 bucket, the secrets and the account, applies the migrations,
deploys, and then signs in once against the live Worker to prove it works.

Everything here assumes a Cloudflare account with Workers, D1 and R2 available;
R2 asks for a payment method on file even on the free tier.

## One command

```sh
git clone --depth 1 https://github.com/deepakness/cogsend.git cogsend
cd cogsend && npm install && npm run setup
```

`setup` runs `wrangler login`, creates the D1 database and the R2 bucket if they
are missing, generates `APP_ENCRYPTION_KEY` (written to `.dev.vars` and to the
Worker), applies migrations, **creates the account** (email plus a password it
generates or you type; only the PBKDF2 hash is stored), deploys and sets
`APP_URL`. The account exists before the URL answers its first request, so there
is nothing to claim and no window in which someone else could get there first.

It is safe to re-run: resources that exist, secrets that are already set, and an
account that already exists are all left alone, because rotating
`APP_ENCRYPTION_KEY` orphans every stored credential and signs every session out.
`main` is the branch these docs are tested against, and release tags are cut
from it. See [Updating](#updating-and-rolling-back) for tags and rolling back.

Its flags, for the cases the defaults deliberately avoid:

```sh
npm run setup -- --dry-run          # read-only: checks auth, prints the plan
npm run setup -- --yes --admin-email you@example.com   # no prompts: secrets and password printed once
npm run setup -- --skip-deploy      # everything except the deploy
npm run setup -- --rotate-secrets   # also overwrite APP_ENCRYPTION_KEY
npm run setup -- --reset-login      # also give the account a new password and revoke every session
npm run setup -- --name my-cogsend --db my-cogsend --bucket my-cogsend-media
npm run setup -- --admin-email you@example.com --admin-password '…'
```

The last two are for a second instance on the same account (your own names in
`wrangler.personal.jsonc`) and for answering the account questions without a
prompt. Forgot the password later? `npm run admin:reset`, described in
[Configuration](configuration.md).

No GitHub App, no Workers Builds, and nothing to configure in a browser beyond
the `wrangler login` that `setup` starts.

## What `setup` does, command by command

Needs Node 22.12+, a Cloudflare account (`npx wrangler login`), and R2 enabled —
Cloudflare asks for a payment method on file even for free-tier usage. Every
command goes through `scripts/wrangler.mjs`, which applies your
`wrangler.personal.jsonc` and `WRANGLER_PROFILE`; plain `npx wrangler …` would
use the generic config in the repo.

```sh
# The one required secret. Keep secrets out of `vars`: a deploy overwrites those.
node scripts/wrangler.mjs secret put APP_ENCRYPTION_KEY   # openssl rand -hex 32

# Build and upload. The first deploy creates the D1 database and the R2 bucket.
npm run build && npm run deploy
```

The account is the one thing a manual deploy cannot make for you: nothing at
runtime creates one, which is what keeps a fresh deployment from being claimable
by whoever finds its URL first. After that deploy, run `npm run setup` once — it
finds the database and bucket you just made, uploads the secrets and creates the
account. `npm run deploy:release` runs tests, migrations, build and deploy in one
go.

A fresh database needs no migration step — the schema bootstraps itself on the
first request; an older one gets new migrations with `npm run db:migrate:remote`.

To choose a location, or to reuse a database or bucket you already have, create
them first: `node scripts/wrangler.mjs d1 create cogsend` prints an id for
`wrangler.personal.jsonc`, and `node scripts/wrangler.mjs r2 bucket create
cogsend-media` makes the bucket. Otherwise the deploy creates both.

Optional secrets — `API_TOKEN` for scripts, `SCHEDULER_SECRET` for an external
pinger, the OAuth client ids, Resend for failure emails, `MEDIA_PUBLIC_BASE_URL`
for Meta's crawler — are listed under [Configuration](configuration.md#secrets). Upload them in one go
with `npm run secrets:put`.

Keep using `scripts/wrangler.mjs` instead of plain `npx wrangler` so your
`wrangler.personal.jsonc` and `WRANGLER_PROFILE` apply — that is what the
commands above already do.

### Push-to-deploy, without Workers Builds

Optional, and for updates only: the account has to exist first (run `npm run
setup` once locally). Copy `.github/workflows/deploy.yml.example` to
`.github/workflows/deploy.yml` and add two repository secrets —
`CLOUDFLARE_API_TOKEN` (Workers Scripts, D1 and R2 edit permissions) and
`CLOUDFLARE_ACCOUNT_ID`. Pushes to `main` then build, migrate and deploy from
GitHub's runners. The workflow skips itself when the secrets are missing, so a
fork that has not set them up stays green.

## After the first deploy

1. Open the Worker URL and sign in with the email and password `setup` created.
   The first sign-in asks for an authenticator app: scan the QR and save the
   backup codes it shows.
2. Connect accounts under **Accounts**. Mastodon works immediately; LinkedIn,
   Threads and X need an OAuth app each, with the redirect URI built from your
   deployed URL ([OAuth apps](oauth-apps.md)).
3. Scheduled posts publish themselves through the cron trigger in
   `wrangler.jsonc`. Nothing to set up — unless the account had no trigger slot
   left, in which case the deploy says so and **Settings → Scheduled publishing**
   has the tick URL and a token for an external cron.
4. Optional: `RESEND_API_KEY` + `NOTIFY_EMAIL` for failure digests, and the
   instance name under **Settings → Instance**.

## Check it worked

```sh
npm run doctor
npm run doctor -- --app-url https://your-worker.workers.dev
```

Read-only: it verifies your Cloudflare login, that the D1 database and R2 bucket
exist, that `APP_ENCRYPTION_KEY` is set, whether migrations are pending, and
whether the Worker has a deployment. With `--app-url` it also asks the running
app: that `/api/health` answers, whether an account exists yet and whether 2FA is
set up, whether the scheduler is actually ticking (and why not, when it is not),
and whether a newer release is out (with the update command for your install
shape). Every failure prints the exact command that fixes it. It never changes
anything.

## Troubleshooting

### The R2 step says the bucket name already exists

R2 bucket names are unique across all Cloudflare accounts, so `cogsend-media`
is only a starting point. Set `bucket_name` in `wrangler.personal.jsonc` (or pass
`--bucket my-cogsend-media` to `setup`) and deploy again. R2 also refuses to create anything until the account has a payment
method on file, even for free-tier usage.

### The deploy complains about cron triggers (10072)

```
✘ [ERROR] Trigger configuration for "…" was only partially updated:
    - This account has reached the Workers Free limit of 5 cron triggers per account … [code: 10072]
Failed: error occurred while running deploy command
```

The Worker and its assets were uploaded — only the schedule was refused. This is
an **account** limit, not a per-Worker one: five cron triggers in total on the
free plan, across every Worker you run, and a fresh project cannot get a sixth
slot.

`npm run deploy` handles this for you: it retries once with the trigger removed
(`"crons": []`) and exits 0, printing the same explanation, so the build is not
marked failed and the app is live. Publishing now works; only scheduled posts
need a tick. Set `COGSEND_STRICT_CRON=1` to get the plain failure instead.

Pick one of these:

1. **Free a slot.** Cloudflare → **Workers & Pages** → the _other_ Worker →
   **Settings → Trigger events → Cron triggers** → delete a schedule you no
   longer need.
2. **Upgrade** the account to Workers Paid (hundreds of triggers).
3. **Use an external cron** and leave the Worker without a trigger. Settings →
   **Scheduled publishing** shows the tick URL and can generate a token; paste
   both into any cron service:

   ```sh
   curl -X POST https://your-worker.workers.dev/api/internal/tick \
     -H "Authorization: Bearer <tick token>"
   ```

   cron-job.org runs a job once a minute on its free plan, UptimeRobot's free
   plan every five minutes, and the repository ships a GitHub Actions workflow
   (`.github/workflows/scheduler-tick.yml`) that needs repository secrets
   `APP_URL` and `SCHEDULER_SECRET`. Ticks are idempotent, so a duplicated or
   delayed caller is harmless. To go trigger-less by choice, delete the
   `triggers` block from your config (or set `"crons": []`).

   Using the env secret instead of the generated token works too: set
   `SCHEDULER_SECRET` and keep the Worker secret and the caller in sync.

`npm run doctor -- --app-url https://your-worker.workers.dev` reports which of
these you are in: ticks arriving, no trigger configured, or a refused trigger.

### The app answers 503: "must not be an example value"

The deployment is running on the example secrets from `.dev.vars.example`. Set
real ones and redeploy:

```sh
node scripts/wrangler.mjs secret put APP_ENCRYPTION_KEY   # openssl rand -hex 32
npm run deploy
```

`npm run doctor -- --app-url <url>` reports this case directly.

### Which URL is my instance on?

Cloudflare dashboard → **Workers & Pages** → your Worker → the URL on the
overview page, or **Settings → Domains & Routes**. `npm run setup` prints it
too, and stores it as `APP_URL`.

### A custom domain

Add it under **Settings → Domains & Routes → Add → Custom Domain**. Nothing else
is needed: the app uses the origin each request arrives on, and OAuth callbacks
are built from it. If you previously pinned `APP_URL` to the `workers.dev`
address, update or delete that secret so the new hostname is used.

### Scheduled posts never fire

Open **Settings → Scheduled publishing** in the app: it says whether a tick has
ever arrived, why one is missing when the last deploy could not attach the
trigger, and offers both a token and a "Tick now" button.

Behind it: the tick runs every minute from the cron trigger in `wrangler.jsonc`
(Cloudflare → **Settings → Trigger events**), or from an external cron calling
`POST /api/internal/tick` with a bearer credential. The built-in cron derives
its own credential from `APP_ENCRYPTION_KEY`; external callers use the token
from that Settings card, or the env `SCHEDULER_SECRET` / `API_TOKEN`. Read-only
check:

```sh
npm run doctor -- --app-url <url>   # reports the scheduler line
```

### Missing migrations

After pulling new code:

```sh
npm run db:migrate:remote
npm run deploy
```

or `npm run deploy:release`, which runs tests, migrations, build and deploy in
one go.

### Two instances in one Cloudflare account

Give the second instance its own names, or it will adopt the first one's
resources: D1 provisioning matches on `database_name`, and R2 bucket names are
global. `npm run setup -- --name my-cogsend --db my-cogsend --bucket my-cogsend-media`
writes them into `wrangler.personal.jsonc` (gitignored) — the Worker name, the
database's name _and_ its id, and the bucket — so the deploy output, `wrangler
d1 …` and `npm run doctor` all name the instance you think they do.

## Updating, and rolling back

Settings → Instance and `npm run doctor` both tell you when a newer release is
out. One command updates everything — tests, remote D1 migrations, build, deploy:

```sh
git pull                     # or check out a release tag
npm ci
npm run deploy:release
```

Cloned `main`? Pull it, or move to a release tag (`git tag` lists them) — those
are the states the docs and the setup script are tested against.

Your data is never in the repository: D1, R2, the Worker secrets and the app
settings live in your Cloudflare account, so a pull cannot touch them. The one
local file that matters is `wrangler.personal.jsonc`, which replaces the
committed config — a config change upstream therefore does not reach you, and
`npm run doctor` says so when the two disagree.

**Migrations.** The app repairs missing tables and columns on the first request
after an update, so most updates need nothing. When a release ships a real
migration, run `npm run db:migrate:remote` — `deploy:release` above already does
it.

**Rolling back.** Workers & Pages → your Worker → **Deployments → Roll back**
reverts code only (or `npx wrangler rollback`), and migrations stay applied, so
rolling back across a schema change can break things.

## Starting over

Worker, D1 database and R2 bucket can be deleted from the dashboard; the
`wrangler.personal.jsonc` and `.dev.vars` files hold the only local state. A
fresh clone plus `npm run setup` then rebuilds everything.

## Still stuck?

Open an issue with the output of `npm run doctor` and the version shown in
**Settings → Instance**.
