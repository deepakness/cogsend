# Driving cogsend from an AI agent

Cogsend ships a `SKILL.md` plus a compact API reference under `skills/cogsend/`
so a coding agent (Claude Code, Codex, Hermes, Pi, OpenCode, or anything that
reads skills) can draft, schedule, publish and read the queue through the REST
API, with curl only.

What an agent can do with it: list connected accounts, create and edit drafts
(with per-platform variants and media), publish now, schedule, inspect the
queue, and cancel, reschedule or retry individual targets.

What it can never do with the key: connect, re-verify or disconnect accounts,
and create, rotate or revoke keys. Those stay in the browser session, so an
agent holding the key cannot lock you out of your own instance.

## Setup

Generate a personal API key in the app under **Settings → API access**. It is
shown once; only its hash is stored.

```sh
export APP_URL=https://cogsend.<account>.workers.dev
export COGSEND_API_KEY=cog_...
```

The agent reads both from the environment. `X-API-Key` works as an alternative
header; the key never goes in a URL.

## Install per agent

### Claude Code

```sh
/plugin marketplace add deepakness/cogsend
/plugin install cogsend
```

Or copy `skills/cogsend/` from this repository into `~/.claude/skills/cogsend/`
for a user-level install (or `.claude/skills/` in a project).

### Codex

Copy `skills/cogsend/` into `$CODEX_HOME/skills/cogsend/` (usually
`~/.codex/skills/cogsend/`), or install it as a plugin where your Codex setup
supports that.

### Hermes

```sh
cp -r skills/cogsend ~/.hermes/skills/cogsend
```

Hermes picks it up on the next session; `hermes skills` lists it.

### Pi

Drop `skills/cogsend/` into the project or your Pi config directory. The `.pi`
extension auto-discovers `skills/` folders.

### OpenCode

Install as an `.opencode` plugin, or copy `skills/cogsend/` into the project's
`.opencode/skill/cogsend/` (or the global equivalent).

### Cursor, Gemini, anything else

No installer needed: point the agent at `skills/cogsend/SKILL.md` (or this
repository's `AGENTS.md`, which references it). The whole workflow is curl and
JSON, so any agent that can run shell commands can drive it.

## Verify it works

```sh
curl -s "$APP_URL/api/connections" -H "Authorization: Bearer $COGSEND_API_KEY"
```

A good answer is `{"connections":[...],"configured":{...},"appUrl":"..."}`.
`401` means the key is wrong or has been revoked. Generate a fresh one under
**Settings → API access**.

Then ask the agent to list your accounts. If it comes back with their handles
and platforms, the skill is wired up.

## Security notes

- The key acts as you on drafts, variants, media, publish, schedule, queue,
  settings and reads. Treat it like a password: environment variable or secret
  store, never committed, never in a URL.
- Revocation is instant and non-destructive: **Settings → API access → Revoke**
  kills the key without touching the scheduler or your sessions. Rotate gives
  you a new key and retires the old one in the same step.
- The legacy `API_TOKEN` Worker secret also works as a bearer on the same
  routes. Prefer the personal key for agents: it is revocable without touching
  the deployment.
- If every connection the agent sees is `needs_reconnect` or missing, that is
  a browser-side fix. The key cannot do it by design.

## Reference

- [API overview](api.md): auth, limits and publishing behaviour.
- `skills/cogsend/references/api.md`: the endpoint table the agent works from.
- The in-app `/api` page: worked examples against your live instance.
