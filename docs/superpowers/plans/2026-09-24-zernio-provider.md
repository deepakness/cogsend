# Zernio Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a CogSend instance publish to X, Threads, LinkedIn and Bluesky through a Zernio account, imported or connected from the Accounts page, with no developer app of its own.

**Architecture:** A Zernio-backed account is an ordinary `connections` row with its real platform plus a `provider: 'zernio'` marker in `meta_json`; `providerFor(conn)` routes it to a Zernio provider that wraps the direct provider's validation and publishes through `POST /api/v1/posts` with `publishNow`, checkpoints the Zernio post id, and polls until the platform entry settles. Four session-only routes handle listing, importing, connecting through Zernio's hosted flow and its callback; the Accounts dialog gets a Zernio entry.

**Tech Stack:** SvelteKit 2 / Svelte 5 on Cloudflare Workers, D1 via Drizzle (no migration needed), vitest with an in-memory libsql database and stubbed `fetch`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-24-zernio-provider-design.md`

## Global Constraints

- No new runtime dependencies. Zernio is called with `fetch` through the existing `providerFetch`.
- No schema migration: the marker lives in `meta_json`, the key in `credentials_encrypted`.
- Comments explain why, never what (AGENTS.md). No section banners, no restated lines.
- Server code (`src/lib/server/**`, `+server.ts`) never touches the DOM.
- Tests assert behaviour, not spies. Every test file uses `expect` at least once per test (`requireAssertions` is on).
- `npm run lint`, `npm run check`, `npm test`, `npm run build` must pass before a task is done. `npm run format` fixes prettier (tabs, single quotes, 100 columns).
- One-line conventional commits (`feat(zernio): …`). Do not push.
- Zernio API base: `https://zernio.com/api`. Zernio calls X `twitter`; CogSend calls it `x`. Mastodon is never offered through Zernio.
- Every outbound Zernio link in UI or docs goes through `zernioLink()` with `utm_source=cogsend`, `utm_medium=sponsorship`, `utm_campaign=cogsend-integration`, `utm_content=<placement>`.
- Direct connections and their routes are not modified beyond `providerFor` and the verify branch.

## Review Focus

1. A direct X row and a Zernio X row with the same handle: importing must never overwrite the direct row (Task 5 test "never touches a direct connection with the same handle").
2. A crash between Zernio accepting the post and the checkpoint write: the retry carries the same `x-request-id`, Zernio replays the original post, and the poll finds it published rather than creating a second post (Task 4 test "a create replay is polled, not re-created").
3. Zernio's 24-hour duplicate rejection (HTTP 409): must park as failed with a readable reason, never retry on backoff (Task 3 test "409 is a permanent refusal").
4. A Zernio post that fails after the poll window closed: the next attempt resumes by polling, sees `failed`, and the parked message carries Zernio's `errorMessage` (Task 4 test "a resumed poll that finds failed parks with Zernio's reason").
5. An API key that is read-only or lacks the `publishing` group: the dialog must say so in words, not echo a 403 (Task 6 test "a key missing a resource group is explained").

---

### Task 1: Domain helpers (platform mapping, marker, request id, links)

**Files:**

- Create: `src/lib/domain/zernio.ts`
- Create: `src/lib/domain/zernio-links.ts`
- Test: `tests/zernio-domain.test.ts`
- Test: `tests/zernio-links.test.ts`

**Interfaces:**

- Produces: `ZERNIO_API_BASE`, `ZERNIO_PENDING_MARKER`, `ZERNIO_API_KEYS_URL`, `toZernioPlatform(platform: string): string | null`, `fromZernioPlatform(platform: string): PlatformId | null`, `isZernioConnection(meta: string | Record<string, unknown> | null | undefined): boolean`, `zernioRequestId(key: string): string`, `zernioLink({ path?, placement }): string`.

- [ ] **Step 1: Write the failing tests**

`tests/zernio-domain.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	fromZernioPlatform,
	isZernioConnection,
	toZernioPlatform,
	zernioRequestId
} from '$lib/domain/zernio';

describe('zernio platform mapping', () => {
	it('maps the four supported platforms both ways and refuses the rest', () => {
		expect(toZernioPlatform('x')).toBe('twitter');
		expect(toZernioPlatform('threads')).toBe('threads');
		expect(toZernioPlatform('linkedin')).toBe('linkedin');
		expect(toZernioPlatform('bluesky')).toBe('bluesky');
		expect(toZernioPlatform('mastodon')).toBeNull();
		expect(fromZernioPlatform('twitter')).toBe('x');
		expect(fromZernioPlatform('bluesky')).toBe('bluesky');
		// Zernio also does Instagram, TikTok, …: CogSend has no editor for them.
		expect(fromZernioPlatform('instagram')).toBeNull();
	});

	it('reads the provider marker from a JSON string or a parsed object', () => {
		expect(isZernioConnection('{"provider":"zernio"}')).toBe(true);
		expect(isZernioConnection({ provider: 'zernio' })).toBe(true);
		expect(isZernioConnection('{}')).toBe(false);
		expect(isZernioConnection('{"did":"did:plc:x"}')).toBe(false);
		expect(isZernioConnection(null)).toBe(false);
		expect(isZernioConnection('not json')).toBe(false);
	});

	it('turns the pipeline idempotency key into something Zernio accepts', () => {
		// Zernio validates x-request-id against /^[\w.-]{1,128}$/; the pipeline's
		// key is `${targetId}:${segmentIndex}`.
		const id = zernioRequestId('7b6c1d1e-1111-4222-8333-444455556666:0');
		expect(id).toMatch(/^[\w.-]{1,128}$/);
		expect(zernioRequestId('a:0')).not.toBe(zernioRequestId('a:1'));
		expect(zernioRequestId('a:0')).toBe(zernioRequestId('a:0'));
	});
});
```

`tests/zernio-links.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { zernioLink } from '$lib/domain/zernio-links';

describe('zernioLink', () => {
	it('tags every link with the sponsorship UTMs and the placement', () => {
		const url = new URL(zernioLink({ placement: 'readme-sponsor' }));
		expect(url.protocol).toBe('https:');
		expect(url.searchParams.get('utm_source')).toBe('cogsend');
		expect(url.searchParams.get('utm_medium')).toBe('sponsorship');
		expect(url.searchParams.get('utm_campaign')).toBe('cogsend-integration');
		expect(url.searchParams.get('utm_content')).toBe('readme-sponsor');
	});

	it('keeps the path and only ever points at Zernio', () => {
		expect(new URL(zernioLink({ path: '/pricing', placement: 'docs' })).pathname).toMatch(
			/\/pricing$/
		);
		expect(() => zernioLink({ path: 'https://evil.example', placement: 'x' })).toThrow();
		expect(() => zernioLink({ path: '//evil.example/x', placement: 'x' })).toThrow();
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/zernio-domain.test.ts tests/zernio-links.test.ts`
Expected: FAIL, cannot resolve `$lib/domain/zernio`.

- [ ] **Step 3: Write the domain module**

`src/lib/domain/zernio.ts`:

```ts
import type { PlatformId } from './platforms';

export const ZERNIO_API_BASE = 'https://zernio.com/api';
export const ZERNIO_API_KEYS_URL = 'https://zernio.com/dashboard/api-keys';
/** `oauth_pending.instance_url` value that marks a Zernio connect attempt. */
export const ZERNIO_PENDING_MARKER = 'zernio';

/** CogSend id → Zernio id. Mastodon is absent: Zernio does not support it. */
const TO_ZERNIO: Partial<Record<PlatformId, string>> = {
	x: 'twitter',
	threads: 'threads',
	linkedin: 'linkedin',
	bluesky: 'bluesky'
};

const FROM_ZERNIO: Record<string, PlatformId> = Object.fromEntries(
	Object.entries(TO_ZERNIO).map(([ours, theirs]) => [theirs, ours as PlatformId])
);

export function toZernioPlatform(platform: string): string | null {
	return TO_ZERNIO[platform as PlatformId] ?? null;
}

export function fromZernioPlatform(platform: string): PlatformId | null {
	return FROM_ZERNIO[platform] ?? null;
}

export function isZernioConnection(
	meta: string | Record<string, unknown> | null | undefined
): boolean {
	if (!meta) return false;
	let parsed: unknown = meta;
	if (typeof meta === 'string') {
		try {
			parsed = JSON.parse(meta);
		} catch {
			return false;
		}
	}
	return (
		typeof parsed === 'object' &&
		parsed !== null &&
		(parsed as { provider?: unknown }).provider === 'zernio'
	);
}

/** Zernio validates `x-request-id` as /^[\w.-]{1,128}$/; the pipeline key has a colon. */
export function zernioRequestId(key: string): string {
	return key.replace(/[^\w.-]/g, '-').slice(0, 128);
}
```

`src/lib/domain/zernio-links.ts`:

```ts
/** Swapped for the maintainer's affiliate URL once it exists; nothing else changes. */
const ZERNIO_LINK_BASE = 'https://zernio.com';

const ZERNIO_HOSTS = ['zernio.com', 'zernio.link', 'docs.zernio.com'];

export function zernioLink({
	path = '/',
	placement
}: {
	path?: string;
	placement: string;
}): string {
	if (/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/\/)/.test(path)) throw new Error('Expected a Zernio path');
	const url = new URL(path.replace(/^\/+/, ''), `${ZERNIO_LINK_BASE}/`);
	if (url.protocol !== 'https:' || !ZERNIO_HOSTS.includes(url.hostname)) {
		throw new Error('Expected a Zernio destination');
	}
	url.searchParams.set('utm_source', 'cogsend');
	url.searchParams.set('utm_medium', 'sponsorship');
	url.searchParams.set('utm_campaign', 'cogsend-integration');
	url.searchParams.set('utm_content', placement);
	return url.toString();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/zernio-domain.test.ts tests/zernio-links.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/domain/zernio.ts src/lib/domain/zernio-links.ts tests/zernio-domain.test.ts tests/zernio-links.test.ts
git commit -m "feat(zernio): platform mapping, connection marker and link helper"
```

---

### Task 2: Credential and meta fields on the provider types

**Files:**

- Modify: `src/lib/server/providers/types.ts:226-263`

**Interfaces:**

- Produces: `ConnectionCredentials.zernioApiKey?: string`, `ConnectionCredentials.zernioAccountId?: string`, `ConnectionMeta.provider?: 'zernio'`, `ConnectionMeta.zernioAccountId?: string`, `ConnectionMeta.zernioProfileId?: string`.

- [ ] **Step 1: Add the fields**

In `ConnectionCredentials`, after `xUsername?: string;`:

```ts
	/** Zernio-backed accounts: the API key and the Zernio SocialAccount id. */
	zernioApiKey?: string;
	zernioAccountId?: string;
```

In `ConnectionMeta`, after `xUserId?: string;`:

```ts
	provider?: 'zernio';
	zernioAccountId?: string;
	zernioProfileId?: string;
```

- [ ] **Step 2: Type-check**

Run: `npm run check`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/server/providers/types.ts
git commit -m "feat(zernio): credential and meta fields for Zernio-backed connections"
```

---

### Task 3: Zernio API client

**Files:**

- Create: `src/lib/server/zernio.ts`
- Test: `tests/zernio-client.test.ts`

**Interfaces:**

- Consumes: `ZERNIO_API_BASE` (Task 1), `ProviderError`, `FetchLike`, `providerFetch`.
- Produces:
  - `interface ZernioProfile { _id: string; name: string; isDefault?: boolean }`
  - `interface ZernioAccount { _id: string; platform: string; profileId: string | { _id: string; name?: string }; username?: string; displayName?: string; profilePicture?: string | null; profileUrl?: string; isActive?: boolean; needsReconnection?: boolean; enabled?: boolean }`
  - `interface ZernioPlatformEntry { platform: string; accountId: string | { _id: string }; status?: string; platformPostId?: string; platformPostUrl?: string; errorMessage?: string; errorCategory?: string }`
  - `interface ZernioPost { _id: string; status?: string; platforms?: ZernioPlatformEntry[] }`
  - `zernioProfileId(account: ZernioAccount): string`
  - `listProfiles({ apiKey, fetchImpl? }): Promise<ZernioProfile[]>`
  - `listAccounts({ apiKey, profileId?, platform?, fetchImpl? }): Promise<ZernioAccount[]>`
  - `connectUrl({ apiKey, platform, profileId, redirectUrl, fetchImpl? }): Promise<string>`
  - `createPost({ apiKey, body, requestId, fetchImpl? }): Promise<ZernioPost>`
  - `getPost({ apiKey, postId, fetchImpl? }): Promise<ZernioPost>`
  - `zernioHttpError(prefix: string, status: number, body: string): ProviderError`
  - `zernioApiMessage(err: unknown): string` — Zernio's own `error` sentence when the failure carried one, else the error's message.

- [ ] **Step 1: Write the failing tests**

`tests/zernio-client.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	connectUrl,
	createPost,
	getPost,
	listAccounts,
	listProfiles,
	zernioApiMessage,
	zernioHttpError
} from '$lib/server/zernio';
import { ProviderError, type FetchLike } from '$lib/server/providers/types';

function mockFetch(
	handlers: Record<string, (req: Request) => Response | Promise<Response>>,
	seen: Request[] = []
): FetchLike {
	return async (input, init) => {
		const url =
			typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		const req = new Request(url, init);
		seen.push(req);
		for (const [key, handler] of Object.entries(handlers)) {
			if (url.includes(key)) return handler(req);
		}
		return new Response(`unmocked ${url}`, { status: 404 });
	};
}

describe('zernio client', () => {
	it('sends the key as a bearer token and unwraps list envelopes', async () => {
		const seen: Request[] = [];
		const fetchImpl = mockFetch(
			{
				'/v1/profiles': () => Response.json({ profiles: [{ _id: 'p1', name: 'Brand' }] }),
				'/v1/accounts?': () =>
					Response.json({ accounts: [{ _id: 'a1', platform: 'twitter', profileId: 'p1' }] })
			},
			seen
		);
		expect(await listProfiles({ apiKey: 'zk_1', fetchImpl })).toEqual([
			{ _id: 'p1', name: 'Brand' }
		]);
		const accounts = await listAccounts({
			apiKey: 'zk_1',
			profileId: 'p1',
			platform: 'twitter',
			fetchImpl
		});
		expect(accounts.map((a) => a._id)).toEqual(['a1']);
		expect(seen.every((r) => r.headers.get('authorization') === 'Bearer zk_1')).toBe(true);
		const accountsUrl = new URL(seen[1].url);
		expect(accountsUrl.searchParams.get('profileId')).toBe('p1');
		expect(accountsUrl.searchParams.get('platform')).toBe('twitter');
	});

	it('asks for a connect URL with the redirect and returns Zernio’s authUrl', async () => {
		const seen: Request[] = [];
		const fetchImpl = mockFetch(
			{ '/v1/connect/twitter': () => Response.json({ authUrl: 'https://x.com/oauth?x=1' }) },
			seen
		);
		const url = await connectUrl({
			apiKey: 'zk_1',
			platform: 'twitter',
			profileId: 'p1',
			redirectUrl: 'https://cog.example/api/connections/zernio/callback?pending=abc.def',
			fetchImpl
		});
		expect(url).toBe('https://x.com/oauth?x=1');
		const asked = new URL(seen[0].url);
		expect(asked.searchParams.get('profileId')).toBe('p1');
		expect(asked.searchParams.get('redirect_url')).toBe(
			'https://cog.example/api/connections/zernio/callback?pending=abc.def'
		);
	});

	it('creates a post with the request id and reads one back', async () => {
		const seen: Request[] = [];
		const fetchImpl = mockFetch(
			{
				'/v1/posts/post-1': () => Response.json({ post: { _id: 'post-1', status: 'published' } }),
				'/v1/posts': () => Response.json({ post: { _id: 'post-1', status: 'publishing' } })
			},
			seen
		);
		const created = await createPost({
			apiKey: 'zk_1',
			body: { content: 'hi', platforms: [], publishNow: true },
			requestId: 'target-0',
			fetchImpl
		});
		expect(created._id).toBe('post-1');
		expect(seen[0].method).toBe('POST');
		expect(seen[0].headers.get('x-request-id')).toBe('target-0');
		expect(await seen[0].json()).toEqual({ content: 'hi', platforms: [], publishNow: true });
		expect((await getPost({ apiKey: 'zk_1', postId: 'post-1', fetchImpl })).status).toBe(
			'published'
		);
	});

	it('accepts a bare post object as well as a { post } envelope', async () => {
		const fetchImpl = mockFetch({
			'/v1/posts/bare': () => Response.json({ _id: 'bare', status: 'failed' })
		});
		expect((await getPost({ apiKey: 'zk_1', postId: 'bare', fetchImpl })).status).toBe('failed');
	});

	it('classifies HTTP failures so publish.ts can decide expiry and retry', () => {
		const body = JSON.stringify({ error: 'Invalid API key', type: 'authentication_error' });
		const auth = zernioHttpError('create post', 401, body);
		expect(auth).toBeInstanceOf(ProviderError);
		expect(auth.code).toBe('auth');
		expect(auth.retryable).toBe(false);
		expect(zernioHttpError('create post', 429, '{}').code).toBe('rate_limited');
		expect(zernioHttpError('create post', 503, 'down').code).toBe('upstream');
		expect(zernioHttpError('create post', 503, 'down').retryable).toBe(true);
		// 409 is a permanent refusal: Zernio saw this exact content on this
		// account in the last 24 hours. Retrying cannot change that.
		const dup = zernioHttpError('create post', 409, JSON.stringify({ error: 'Duplicate post' }));
		expect(dup.code).toBe('forbidden');
		expect(dup.retryable).toBe(false);
		expect(dup.message).toContain('Duplicate post');
		for (const status of [400, 402, 403, 404]) {
			expect(zernioHttpError('create post', status, '{}').retryable).toBe(false);
		}
	});

	it('surfaces Zernio’s own sentence for the dialog', () => {
		const err = zernioHttpError(
			'list accounts',
			403,
			JSON.stringify({ error: 'This key cannot access accounts', code: 'insufficient_permissions' })
		);
		expect(zernioApiMessage(err)).toBe('This key cannot access accounts');
		expect(zernioApiMessage(new Error('boom'))).toBe('boom');
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/zernio-client.test.ts`
Expected: FAIL, cannot resolve `$lib/server/zernio`.

- [ ] **Step 3: Write the client**

`src/lib/server/zernio.ts`:

```ts
import { ZERNIO_API_BASE } from '$lib/domain/zernio';
import { ProviderError, type FetchLike } from './providers/types';
import { providerFetch } from './providers/timed-fetch';

export interface ZernioProfile {
	_id: string;
	name: string;
	isDefault?: boolean;
}

export interface ZernioAccount {
	_id: string;
	platform: string;
	profileId: string | { _id: string; name?: string };
	username?: string;
	displayName?: string;
	profilePicture?: string | null;
	profileUrl?: string;
	isActive?: boolean;
	needsReconnection?: boolean;
	enabled?: boolean;
}

export interface ZernioPlatformEntry {
	platform: string;
	accountId: string | { _id: string };
	status?: string;
	platformPostId?: string;
	platformPostUrl?: string;
	errorMessage?: string;
	errorCategory?: string;
}

export interface ZernioPost {
	_id: string;
	status?: string;
	platforms?: ZernioPlatformEntry[];
}

export function zernioProfileId(account: ZernioAccount): string {
	return typeof account.profileId === 'string' ? account.profileId : account.profileId._id;
}

export function zernioEntryAccountId(entry: ZernioPlatformEntry): string {
	return typeof entry.accountId === 'string' ? entry.accountId : entry.accountId._id;
}

function apiMessageFrom(body: string): string | null {
	try {
		const parsed = JSON.parse(body) as { error?: unknown };
		return typeof parsed.error === 'string' && parsed.error ? parsed.error : null;
	} catch {
		return null;
	}
}

/**
 * 401 is the key: expire the connection. 429 and 5xx come back later. Every
 * other 4xx (validation, the billing gate, a missing permission, the 24-hour
 * duplicate rejection) is a refusal the same request cannot get past, so it is
 * non-retryable without expiring the connection: `forbidden` is the code that
 * carries exactly that pair of decisions through publish.ts.
 */
export function zernioHttpError(prefix: string, status: number, body: string): ProviderError {
	const message = `Zernio ${prefix} failed (${status}): ${apiMessageFrom(body) ?? body.slice(0, 300)}`;
	const detail = body.slice(0, 2000);
	if (status === 401) return new ProviderError(message, { status, code: 'auth', detail });
	if (status === 429) return new ProviderError(message, { status, code: 'rate_limited', detail });
	if (status >= 500) return new ProviderError(message, { status, code: 'upstream', detail });
	return new ProviderError(message, { status, code: 'forbidden', detail });
}

export function zernioApiMessage(err: unknown): string {
	if (err instanceof ProviderError && err.detail) {
		const own = apiMessageFrom(err.detail);
		if (own) return own;
	}
	return err instanceof Error ? err.message : String(err);
}

async function request<T>(opts: {
	apiKey: string;
	path: string;
	method?: 'GET' | 'POST';
	body?: unknown;
	headers?: Record<string, string>;
	prefix: string;
	fetchImpl?: FetchLike;
}): Promise<T> {
	const fetchImpl = opts.fetchImpl ?? providerFetch;
	const res = await fetchImpl(`${ZERNIO_API_BASE}${opts.path}`, {
		method: opts.method ?? 'GET',
		headers: {
			Authorization: `Bearer ${opts.apiKey}`,
			Accept: 'application/json',
			...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
			...(opts.headers ?? {})
		},
		...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) })
	});
	if (!res.ok) throw zernioHttpError(opts.prefix, res.status, await res.text());
	return (await res.json()) as T;
}

export async function listProfiles(opts: {
	apiKey: string;
	fetchImpl?: FetchLike;
}): Promise<ZernioProfile[]> {
	const data = await request<{ profiles?: ZernioProfile[] }>({
		...opts,
		path: '/v1/profiles',
		prefix: 'list profiles'
	});
	return data.profiles ?? [];
}

export async function listAccounts(opts: {
	apiKey: string;
	profileId?: string;
	platform?: string;
	fetchImpl?: FetchLike;
}): Promise<ZernioAccount[]> {
	const params = new URLSearchParams({ limit: '200' });
	if (opts.profileId) params.set('profileId', opts.profileId);
	if (opts.platform) params.set('platform', opts.platform);
	const data = await request<{ accounts?: ZernioAccount[] }>({
		apiKey: opts.apiKey,
		fetchImpl: opts.fetchImpl,
		path: `/v1/accounts?${params}`,
		prefix: 'list accounts'
	});
	return data.accounts ?? [];
}

export async function connectUrl(opts: {
	apiKey: string;
	platform: string;
	profileId: string;
	redirectUrl: string;
	fetchImpl?: FetchLike;
}): Promise<string> {
	const params = new URLSearchParams({ profileId: opts.profileId, redirect_url: opts.redirectUrl });
	const data = await request<{ authUrl?: string }>({
		apiKey: opts.apiKey,
		fetchImpl: opts.fetchImpl,
		path: `/v1/connect/${encodeURIComponent(opts.platform)}?${params}`,
		prefix: 'connect'
	});
	if (!data.authUrl) throw new ProviderError('Zernio connect returned no authorization URL');
	return data.authUrl;
}

function unwrapPost(data: { post?: ZernioPost } | ZernioPost): ZernioPost {
	const post = 'post' in data && data.post ? data.post : (data as ZernioPost);
	if (!post || typeof post._id !== 'string') throw new ProviderError('Zernio returned no post');
	return post;
}

export async function createPost(opts: {
	apiKey: string;
	body: Record<string, unknown>;
	requestId: string;
	fetchImpl?: FetchLike;
}): Promise<ZernioPost> {
	return unwrapPost(
		await request({
			apiKey: opts.apiKey,
			fetchImpl: opts.fetchImpl,
			path: '/v1/posts',
			method: 'POST',
			body: opts.body,
			headers: { 'x-request-id': opts.requestId },
			prefix: 'create post'
		})
	);
}

export async function getPost(opts: {
	apiKey: string;
	postId: string;
	fetchImpl?: FetchLike;
}): Promise<ZernioPost> {
	return unwrapPost(
		await request({
			apiKey: opts.apiKey,
			fetchImpl: opts.fetchImpl,
			path: `/v1/posts/${encodeURIComponent(opts.postId)}`,
			prefix: 'read post'
		})
	);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/zernio-client.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Lint, check, commit**

Run: `npm run lint && npm run check`
Expected: clean.

```bash
git add src/lib/server/zernio.ts tests/zernio-client.test.ts
git commit -m "feat(zernio): API client with typed failure classification"
```

---

### Task 4: The Zernio provider and provider routing

**Files:**

- Create: `src/lib/server/providers/zernio.ts`
- Modify: `src/lib/server/providers/index.ts`
- Modify: `src/lib/server/publish.ts:634-682` (`publishCallEstimate`), `:731-745` (pre-check), `:776-789` (estimate), `:900-946` (provider + refresh)
- Test: `tests/zernio-provider.test.ts`
- Test: `tests/publish.test.ts` (append a describe block)

**Interfaces:**

- Consumes: Task 1 helpers, Task 3 client.
- Produces:
  - `zernioProviderFor(platform: PlatformId, opts?: { pollIntervalMs?: number; maxPolls?: number }): PlatformProvider`
  - `buildZernioPostBody({ platform, accountId, content, mediaUrlFor }): Promise<Record<string, unknown>>`
  - `ZERNIO_MAX_POLLS = 8`, `ZERNIO_POLL_INTERVAL_MS = 3000`
  - `providerFor(conn: { platform: string; metaJson?: string | null }): PlatformProvider` in `providers/index.ts`
  - `estimateKeyFor(conn: { platform: string; metaJson?: string | null }): string` in `providers/index.ts` (`'zernio'` or the platform)

- [ ] **Step 1: Write the failing provider tests**

`tests/zernio-provider.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
	buildZernioPostBody,
	ZERNIO_MAX_POLLS,
	zernioProviderFor
} from '$lib/server/providers/zernio';
import { providerFor, estimateKeyFor } from '$lib/server/providers';
import { ProviderError, PublishPartialError, type FetchLike } from '$lib/server/providers/types';

function mockFetch(
	handlers: Record<string, (req: Request) => Response | Promise<Response>>,
	seen: Request[] = []
): FetchLike {
	return async (input, init) => {
		const url =
			typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		const req = new Request(url, init);
		seen.push(req);
		for (const [key, handler] of Object.entries(handlers)) {
			if (url.includes(key)) return handler(req);
		}
		return new Response(`unmocked ${url}`, { status: 404 });
	};
}

const creds = { zernioApiKey: 'zk_1', zernioAccountId: 'acc-1' };
const mediaUrlFor = (key: string) => `https://media.example/${key}`;
const fast = { pollIntervalMs: 0, maxPolls: 3 };

describe('buildZernioPostBody', () => {
	it('sends a single post with its media as public URLs', async () => {
		const body = await buildZernioPostBody({
			platform: 'x',
			accountId: 'acc-1',
			content: {
				text: 'hello',
				media: [
					{ storageKey: 'k1', mime: 'image/png', alt: 'a cat' },
					{ storageKey: 'k2', mime: 'image/gif' },
					{ storageKey: 'k3', mime: 'video/mp4' }
				]
			},
			mediaUrlFor
		});
		expect(body).toEqual({
			content: 'hello',
			mediaItems: [
				{ type: 'image', url: 'https://media.example/k1', mimeType: 'image/png', altText: 'a cat' },
				{ type: 'gif', url: 'https://media.example/k2', mimeType: 'image/gif' },
				{ type: 'video', url: 'https://media.example/k3', mimeType: 'video/mp4' }
			],
			platforms: [{ platform: 'twitter', accountId: 'acc-1' }],
			publishNow: true
		});
	});

	it('sends a thread as threadItems on X, Threads and Bluesky', async () => {
		for (const [platform, zernio] of [
			['x', 'twitter'],
			['threads', 'threads'],
			['bluesky', 'bluesky']
		] as const) {
			const body = await buildZernioPostBody({
				platform,
				accountId: 'acc-1',
				content: {
					text: 'one',
					thread: [
						{ text: 'one' },
						{ text: 'two', media: [{ storageKey: 'k', mime: 'image/jpeg' }] }
					]
				},
				mediaUrlFor
			});
			expect(body.content).toBe('one');
			expect(body).not.toHaveProperty('mediaItems');
			expect(body.platforms).toEqual([
				{
					platform: zernio,
					accountId: 'acc-1',
					platformSpecificData: {
						threadItems: [
							{ content: 'one', mediaItems: [] },
							{
								content: 'two',
								mediaItems: [
									{ type: 'image', url: 'https://media.example/k', mimeType: 'image/jpeg' }
								]
							}
						]
					}
				}
			]);
		}
	});

	it('flattens a thread into one LinkedIn post, like the direct provider', async () => {
		const body = await buildZernioPostBody({
			platform: 'linkedin',
			accountId: 'acc-1',
			content: {
				text: 'one',
				thread: [
					{ text: 'one', media: [{ storageKey: 'k1', mime: 'image/png' }] },
					{ text: 'two', media: [{ storageKey: 'k2', mime: 'image/png' }] }
				]
			},
			mediaUrlFor
		});
		expect(body.content).toBe('one\n\ntwo');
		expect((body.mediaItems as unknown[]).length).toBe(2);
		expect(body.platforms).toEqual([{ platform: 'linkedin', accountId: 'acc-1' }]);
	});

	it('refuses to build without a media signer, like Threads', async () => {
		await expect(
			buildZernioPostBody({
				platform: 'x',
				accountId: 'acc-1',
				content: { text: 'x', media: [{ storageKey: 'k', mime: 'image/png' }] }
			})
		).rejects.toThrow(/media/i);
	});
});

describe('zernioProviderFor', () => {
	it('keeps the direct platform’s id, capabilities and validation', () => {
		const x = zernioProviderFor('x');
		expect(x.id).toBe('x');
		expect(x.capabilities.supportsThreads).toBe(true);
		expect(x.validate({ text: 'a'.repeat(281) }).some((i) => i.code === 'max_length')).toBe(true);
		expect(zernioProviderFor('linkedin').capabilities.supportsThreads).toBe(false);
		expect(zernioProviderFor('x')).toBe(zernioProviderFor('x'));
	});

	it('creates, checkpoints the Zernio post id, polls to published', async () => {
		const seen: Request[] = [];
		let polls = 0;
		const fetchImpl = mockFetch(
			{
				'/v1/posts/post-1': () => {
					polls += 1;
					return Response.json({
						post: {
							_id: 'post-1',
							platforms: [
								polls < 2
									? { platform: 'twitter', accountId: 'acc-1', status: 'publishing' }
									: {
											platform: 'twitter',
											accountId: 'acc-1',
											status: 'published',
											platformPostId: '1234',
											platformPostUrl: 'https://x.com/u/status/1234'
										}
							]
						}
					});
				},
				'/v1/posts': () =>
					Response.json({
						post: {
							_id: 'post-1',
							platforms: [{ platform: 'twitter', accountId: 'acc-1', status: 'pending' }]
						}
					})
			},
			seen
		);
		const checkpoints: unknown[] = [];
		const result = await zernioProviderFor('x', fast).publish(
			{ text: 'hello' },
			creds,
			undefined,
			fetchImpl,
			{
				mediaUrlFor,
				checkpoint: (state) => {
					checkpoints.push(state);
				},
				idempotencyKey: (i) => `target-1:${i}`
			}
		);
		expect(seen[0].headers.get('x-request-id')).toBe('target-1-0');
		expect(checkpoints[0]).toEqual({ segmentIds: ['post-1'], remoteUrl: null });
		expect(result).toEqual({
			remotePostId: '1234',
			remoteUrl: 'https://x.com/u/status/1234',
			segmentIds: ['post-1']
		});
	});

	it('gives up after the poll window with a partial error carrying the post id', async () => {
		let polls = 0;
		const fetchImpl = mockFetch({
			'/v1/posts/post-1': () => {
				polls += 1;
				return Response.json({
					post: {
						_id: 'post-1',
						platforms: [{ platform: 'twitter', accountId: 'acc-1', status: 'publishing' }]
					}
				});
			},
			'/v1/posts': () => Response.json({ post: { _id: 'post-1', platforms: [] } })
		});
		const err = await zernioProviderFor('x', fast)
			.publish({ text: 'hello' }, creds, undefined, fetchImpl, { mediaUrlFor })
			.catch((e) => e);
		expect(err).toBeInstanceOf(PublishPartialError);
		expect((err as PublishPartialError).segmentIds).toEqual(['post-1']);
		expect(polls).toBe(fast.maxPolls);
		expect(ZERNIO_MAX_POLLS).toBe(8);
	});

	it('a create replay is polled, not re-created: resume skips the create', async () => {
		const seen: Request[] = [];
		const fetchImpl = mockFetch(
			{
				'/v1/posts/post-1': () =>
					Response.json({
						post: {
							_id: 'post-1',
							platforms: [
								{
									platform: 'twitter',
									accountId: 'acc-1',
									status: 'published',
									platformPostId: '99',
									platformPostUrl: 'https://x.com/u/status/99'
								}
							]
						}
					})
			},
			seen
		);
		const result = await zernioProviderFor('x', fast).publish(
			{ text: 'hello' },
			creds,
			undefined,
			fetchImpl,
			{ mediaUrlFor, resume: { segmentIds: ['post-1'] } }
		);
		expect(seen.every((r) => r.method === 'GET')).toBe(true);
		expect(result.remotePostId).toBe('99');
	});

	it('a resumed poll that finds failed parks with Zernio’s reason', async () => {
		const fetchImpl = mockFetch({
			'/v1/posts/post-1': () =>
				Response.json({
					post: {
						_id: 'post-1',
						platforms: [
							{
								platform: 'twitter',
								accountId: 'acc-1',
								status: 'failed',
								errorMessage: 'Tweet text is too long',
								errorCategory: 'user_content'
							}
						]
					}
				})
		});
		const err = await zernioProviderFor('x', fast)
			.publish({ text: 'hello' }, creds, undefined, fetchImpl, {
				mediaUrlFor,
				resume: { segmentIds: ['post-1'] }
			})
			.catch((e) => e);
		expect(err).toBeInstanceOf(ProviderError);
		expect((err as ProviderError).message).toContain('Tweet text is too long');
		expect((err as ProviderError).code).toBe('forbidden');
		expect((err as ProviderError).retryable).toBe(false);
	});

	it('maps Zernio failure categories onto expiry and retry decisions', async () => {
		const attempt = async (errorCategory: string) => {
			const fetchImpl = mockFetch({
				'/v1/posts/post-1': () =>
					Response.json({
						post: {
							_id: 'post-1',
							platforms: [
								{ platform: 'twitter', accountId: 'acc-1', status: 'failed', errorCategory }
							]
						}
					})
			});
			return zernioProviderFor('x', fast)
				.publish({ text: 'hello' }, creds, undefined, fetchImpl, {
					mediaUrlFor,
					resume: { segmentIds: ['post-1'] }
				})
				.catch((e) => e as ProviderError);
		};
		expect((await attempt('auth_expired')).code).toBe('auth');
		expect((await attempt('platform_error')).code).toBe('upstream');
		expect((await attempt('system_error')).retryable).toBe(true);
		expect((await attempt('user_abuse')).retryable).toBe(false);
	});

	it('requires the Zernio credentials on the row', async () => {
		await expect(
			zernioProviderFor('x', fast).publish({ text: 'hello' }, {}, undefined, mockFetch({}), {
				mediaUrlFor
			})
		).rejects.toMatchObject({ code: 'auth' });
	});
});

describe('providerFor', () => {
	it('routes on the meta marker, not the platform column', () => {
		expect(providerFor({ platform: 'x', metaJson: '{"provider":"zernio"}' })).toBe(
			zernioProviderFor('x')
		);
		expect(providerFor({ platform: 'x', metaJson: '{}' }).id).toBe('x');
		expect(providerFor({ platform: 'x', metaJson: '{}' })).not.toBe(zernioProviderFor('x'));
		expect(estimateKeyFor({ platform: 'x', metaJson: '{"provider":"zernio"}' })).toBe('zernio');
		expect(estimateKeyFor({ platform: 'x', metaJson: null })).toBe('x');
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/zernio-provider.test.ts`
Expected: FAIL, cannot resolve `$lib/server/providers/zernio`.

- [ ] **Step 3: Write the provider**

`src/lib/server/providers/zernio.ts`:

```ts
import { isZernioConnection, toZernioPlatform, zernioRequestId } from '$lib/domain/zernio';
import { platformName } from '$lib/domain/platforms';
import {
	createPost,
	getPost,
	zernioEntryAccountId,
	type ZernioPlatformEntry,
	type ZernioPost
} from '../zernio';
import { getProvider } from './index';
import { providerFetch } from './timed-fetch';
import {
	ProviderError,
	PublishPartialError,
	type ConnectionCredentials,
	type FetchLike,
	type MediaAttachment,
	type NormalizedPost,
	type PlatformId,
	type PlatformProvider,
	type PublishResult
} from './types';

export const ZERNIO_POLL_INTERVAL_MS = 3_000;
export const ZERNIO_MAX_POLLS = 8;

type MediaUrlFor = (storageKey: string) => Promise<string> | string;

async function mediaItemFor(media: MediaAttachment, mediaUrlFor: MediaUrlFor) {
	if (!media.storageKey) throw new Error('Zernio posts need stored media');
	const mime = (media.mime || '').toLowerCase();
	const type = mime.startsWith('video/') ? 'video' : mime === 'image/gif' ? 'gif' : 'image';
	return {
		type,
		url: await mediaUrlFor(media.storageKey),
		mimeType: media.mime,
		...(media.alt ? { altText: media.alt } : {})
	};
}

export async function buildZernioPostBody(opts: {
	platform: PlatformId | string;
	accountId: string;
	content: NormalizedPost;
	mediaUrlFor?: MediaUrlFor;
}): Promise<Record<string, unknown>> {
	const zernioPlatform = toZernioPlatform(opts.platform);
	if (!zernioPlatform) throw new Error(`Zernio does not support ${platformName(opts.platform)}`);
	const segments =
		opts.content.thread && opts.content.thread.length > 0 ? opts.content.thread : [opts.content];
	const hasMedia = segments.some((s) => (s.media?.length ?? 0) > 0);
	if (hasMedia && !opts.mediaUrlFor) throw new Error('Zernio posts need a media signer');
	const items = async (media: MediaAttachment[] | undefined) =>
		Promise.all((media ?? []).map((m) => mediaItemFor(m, opts.mediaUrlFor!)));
	const target: Record<string, unknown> = { platform: zernioPlatform, accountId: opts.accountId };

	// LinkedIn has no threads (the direct provider joins the segments too), and
	// a single segment goes out flat everywhere.
	if (segments.length === 1 || opts.platform === 'linkedin') {
		const text = segments
			.map((s) => s.text || '')
			.filter(Boolean)
			.join('\n\n');
		const mediaItems = await items(segments.flatMap((s) => s.media ?? []));
		return {
			content: text,
			...(mediaItems.length ? { mediaItems } : {}),
			platforms: [target],
			publishNow: true
		};
	}

	const threadItems = [];
	for (const segment of segments) {
		threadItems.push({ content: segment.text || '', mediaItems: await items(segment.media) });
	}
	return {
		content: segments[0].text || '',
		platforms: [{ ...target, platformSpecificData: { threadItems } }],
		publishNow: true
	};
}

function entryFor(post: ZernioPost, accountId: string): ZernioPlatformEntry | undefined {
	const entries = post.platforms ?? [];
	return entries.find((e) => zernioEntryAccountId(e) === accountId) ?? entries[0];
}

/**
 * Zernio already retried the platform before reporting `failed`, and it says
 * why in `errorCategory`. A dead token expires the connection; a platform or
 * Zernio outage is worth another attempt (the checkpoint is dropped with the
 * failure, so that attempt creates a fresh post); anything else is the
 * content or the account, which a retry cannot fix.
 */
function failureError(platform: string, entry: ZernioPlatformEntry): ProviderError {
	const reason = entry.errorMessage || 'no reason given';
	const message = `Zernio could not publish to ${platformName(platform)}: ${reason}`;
	if (entry.errorCategory === 'auth_expired') return new ProviderError(message, { code: 'auth' });
	if (entry.errorCategory === 'platform_error' || entry.errorCategory === 'system_error') {
		return new ProviderError(message, { code: 'upstream' });
	}
	return new ProviderError(message, { code: 'forbidden' });
}

function sleep(ms: number): Promise<void> {
	return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

export function zernioProviderFor(
	platform: PlatformId,
	opts: { pollIntervalMs?: number; maxPolls?: number } = {}
): PlatformProvider {
	const cached = opts.pollIntervalMs === undefined && opts.maxPolls === undefined;
	if (cached && providers.has(platform)) return providers.get(platform)!;
	const direct = getProvider(platform);
	const pollIntervalMs = opts.pollIntervalMs ?? ZERNIO_POLL_INTERVAL_MS;
	const maxPolls = opts.maxPolls ?? ZERNIO_MAX_POLLS;

	const provider: PlatformProvider = {
		id: platform,
		capabilities: direct.capabilities,
		validate: (content, meta) => direct.validate(content, meta),

		async publish(
			content,
			creds,
			_meta,
			fetchImpl = providerFetch,
			publishOpts
		): Promise<PublishResult> {
			const { zernioApiKey: apiKey, zernioAccountId: accountId } = creds;
			if (!apiKey || !accountId) {
				throw new ProviderError('Zernio credentials require zernioApiKey and zernioAccountId', {
					code: 'auth'
				});
			}
			let postId = publishOpts?.resume?.segmentIds?.[0];
			if (!postId) {
				const body = await buildZernioPostBody({
					platform,
					accountId,
					content,
					mediaUrlFor: publishOpts?.mediaUrlFor
				});
				// The same key on a retry makes Zernio replay the original post for
				// five minutes, which covers a crash between the create and the
				// checkpoint below. It also replays a genuinely failed post to the
				// first retries; that costs an attempt, not a duplicate.
				const requestId = zernioRequestId(publishOpts?.idempotencyKey?.(0) ?? crypto.randomUUID());
				const created = await createPost({ apiKey, body, requestId, fetchImpl });
				postId = created._id;
				await publishOpts?.checkpoint?.({ segmentIds: [postId], remoteUrl: null });
			}

			for (let poll = 0; poll < maxPolls; poll++) {
				if (poll > 0) await sleep(pollIntervalMs);
				const post = await getPost({ apiKey, postId, fetchImpl });
				const entry = entryFor(post, accountId);
				const status = entry?.status ?? post.status;
				if (status === 'published') {
					return {
						remotePostId: entry?.platformPostId || postId,
						remoteUrl: entry?.platformPostUrl,
						segmentIds: [postId]
					};
				}
				if (status === 'failed') throw failureError(platform, entry ?? { platform, accountId });
			}
			throw new PublishPartialError('Zernio is still publishing this post', {
				segmentIds: [postId],
				remoteUrl: null
			});
		}
	};
	if (cached) providers.set(platform, provider);
	return provider;
}
```

Declare `const providers = new Map<PlatformId, PlatformProvider>();` above `zernioProviderFor`, and drop the unused `ConnectionCredentials` and `isZernioConnection` imports.

Replace `src/lib/server/providers/index.ts` lines 1-17 (imports, `providers`, `getProvider`) with:

```ts
import { isZernioConnection } from '$lib/domain/zernio';
import { blueskyProvider } from './bluesky';
import { linkedinProvider } from './linkedin';
import { mastodonProvider } from './mastodon';
import { threadsProvider } from './threads';
import { xProvider } from './x';
import { zernioProviderFor } from './zernio';
import type { PlatformId, PlatformProvider } from './types';

const providers: Record<PlatformId, PlatformProvider> = {
	bluesky: blueskyProvider,
	mastodon: mastodonProvider,
	linkedin: linkedinProvider,
	threads: threadsProvider,
	x: xProvider
};

export function getProvider(platform: PlatformId | string): PlatformProvider {
	const p = providers[platform as PlatformId];
	if (!p) throw new Error(`Unknown platform: ${platform}`);
	return p;
}

type ConnectionLike = { platform: string; metaJson?: string | null };

/** The provider a stored connection publishes through: the platform's own, or
 *  Zernio when the row carries the marker. */
export function providerFor(conn: ConnectionLike): PlatformProvider {
	if (isZernioConnection(conn.metaJson)) return zernioProviderFor(conn.platform as PlatformId);
	return getProvider(conn.platform);
}

/** Key for publishCallEstimate: Zernio costs the same whatever the platform. */
export function estimateKeyFor(conn: ConnectionLike): string {
	return isZernioConnection(conn.metaJson) ? 'zernio' : conn.platform;
}
```

and add to the export list at the bottom:

```ts
export { zernioProviderFor, buildZernioPostBody, ZERNIO_MAX_POLLS } from './zernio';
```

Note the circular import `zernio.ts` → `./index` → `./zernio`: `getProvider` is only called inside `zernioProviderFor`, never at module load, so it resolves. Keep it that way.

- [ ] **Step 4: Wire `publish.ts`**

In `publish.ts` imports, replace `getProvider,` with `providerFor,` and add `estimateKeyFor,` in the same import from `'./providers'`; add `import { ZERNIO_MAX_POLLS } from './providers/zernio';`.

In `publishCallEstimate`, add before `default:`:

```ts
		case 'zernio':
			// One create and the status polls; media travels as URLs, so no
			// uploads. Storage reads are still counted above: bytes are hydrated
			// before any provider runs.
			platformCalls += ZERNIO_MAX_POLLS;
			break;
```

In the pre-check block (`let knownPlatform: string | null = null;`), add `let knownEstimateKey: string | null = null;` next to it, and inside `if (preConn) {` set both:

```ts
knownPlatform = preConn.platform;
knownEstimateKey = estimateKeyFor(preConn);
const provider = providerFor(preConn);
```

In the estimate block, replace `publishCallEstimate(knownPlatform, prebuilt)` with `publishCallEstimate(knownEstimateKey ?? knownPlatform, prebuilt)`.

In the main try, replace `const provider = getProvider(conn.platform as PlatformId);` with `const provider = providerFor(conn);`. Remove `PlatformId` from the imports if it is now unused (check with `npm run check`).

- [ ] **Step 5: Run the provider tests**

Run: `npx vitest run tests/zernio-provider.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 6: Write the failing pipeline test**

Append to `tests/publish.test.ts`, inside the top-level `describe('publishTarget integration', …)` after the existing tests (the `db`, `store`, `userId`, `extraDraft` and `mockFetch` helpers are in scope):

```ts
describe('through Zernio', () => {
	async function zernioConnection(overrides: Record<string, unknown> = {}) {
		const id = newId();
		const now = new Date();
		await db.insert(connections).values({
			id,
			userId,
			platform: 'x',
			handle: 'acme',
			credentialsEncrypted: await encryptJson(
				{ zernioApiKey: 'zk_1', zernioAccountId: 'acc-1' },
				TEST_ENV.APP_ENCRYPTION_KEY
			),
			metaJson: JSON.stringify({ provider: 'zernio', zernioAccountId: 'acc-1' }),
			status: 'active',
			createdAt: now,
			updatedAt: now,
			...overrides
		});
		return id;
	}

	async function target(connectionId: string) {
		const id = newId();
		const now = new Date();
		await db.insert(publishTargets).values({
			id,
			draftId: await extraDraft(`zernio ${id}`),
			connectionId,
			status: 'pending',
			attemptCount: 0,
			createdAt: now,
			updatedAt: now
		});
		return id;
	}

	const publishedPost = (postId: string) =>
		Response.json({
			post: {
				_id: postId,
				platforms: [
					{
						platform: 'twitter',
						accountId: 'acc-1',
						status: 'published',
						platformPostId: '555',
						platformPostUrl: 'https://x.com/acme/status/555'
					}
				]
			}
		});

	it('publishes and records the platform permalink', async () => {
		const conn = await zernioConnection();
		const targetId = await target(conn);
		const seen: Request[] = [];
		const fetchImpl = mockFetch({
			'/v1/posts/post-a': () => publishedPost('post-a'),
			'/v1/posts': (req) => {
				seen.push(req);
				return Response.json({ post: { _id: 'post-a', platforms: [] } });
			}
		});
		// The real poll interval is 3 s; the provider is memoised, so the
		// test drives the default and expects the first poll to settle it.
		const result = await publishTarget(db, TEST_ENV, store, targetId, { fetchImpl });
		expect(result.status).toBe('published');
		const row = (await db.select().from(publishTargets).where(eq(publishTargets.id, targetId)))[0];
		expect(row.remotePostId).toBe('555');
		expect(row.remoteUrl).toBe('https://x.com/acme/status/555');
		expect(seen[0].headers.get('authorization')).toBe('Bearer zk_1');
		expect(seen[0].headers.get('x-request-id')).toBe(`${targetId}-0`);
	});

	it('expires the connection when Zernio reports the token dead', async () => {
		const conn = await zernioConnection();
		const targetId = await target(conn);
		const fetchImpl = mockFetch({
			'/v1/posts/post-b': () =>
				Response.json({
					post: {
						_id: 'post-b',
						platforms: [
							{
								platform: 'twitter',
								accountId: 'acc-1',
								status: 'failed',
								errorCategory: 'auth_expired',
								errorMessage: 'Reconnect the account'
							}
						]
					}
				}),
			'/v1/posts': () => Response.json({ post: { _id: 'post-b', platforms: [] } })
		});
		const result = await publishTarget(db, TEST_ENV, store, targetId, { fetchImpl });
		expect(result.status).toBe('failed');
		expect(result.error).toContain('Reconnect the account');
		const row = (await db.select().from(connections).where(eq(connections.id, conn)))[0];
		expect(row.status).toBe('expired');
	});

	it('a rejected key never publishes and expires the connection', async () => {
		const conn = await zernioConnection();
		const targetId = await target(conn);
		const fetchImpl = mockFetch({
			'/v1/posts': () => Response.json({ error: 'Invalid API key' }, { status: 401 })
		});
		const result = await publishTarget(db, TEST_ENV, store, targetId, { fetchImpl });
		expect(result.status).toBe('failed');
		const row = (await db.select().from(connections).where(eq(connections.id, conn)))[0];
		expect(row.status).toBe('expired');
	});
});
```

- [ ] **Step 7: Run the pipeline tests**

Run: `npx vitest run tests/publish.test.ts`
Expected: PASS, including the three new tests. (If the first new test times out, the default poll interval is being hit; the first `getPost` happens before any sleep, so it must not. Investigate rather than raising the timeout.)

- [ ] **Step 8: Lint, check, full suite, commit**

Run: `npm run lint && npm run check && npm test`
Expected: clean, all green.

```bash
git add src/lib/server/providers/zernio.ts src/lib/server/providers/index.ts src/lib/server/publish.ts tests/zernio-provider.test.ts tests/publish.test.ts
git commit -m "feat(zernio): publish through Zernio with checkpointed polling"
```

---

### Task 5: Import service (key resolution and connection upsert)

**Files:**

- Create: `src/lib/server/zernio-import.ts`
- Test: `tests/zernio-import.test.ts`

**Interfaces:**

- Consumes: Task 1 helpers, Task 3 client types, `encryptJson`/`decryptJson`, `connections`, `newId`, `parseJson`.
- Produces:
  - `interface ImportableAccount { id: string; platform: PlatformId; profileId: string; handle: string | null; displayName: string | null; avatarUrl: string | null; needsReconnection: boolean; imported: boolean }`
  - `toImportable(account: ZernioAccount, importedIds: Set<string>): ImportableAccount | null`
  - `storedZernioKey({ db, env, userId }): Promise<string | null>`
  - `resolveZernioKey({ db, env, userId, apiKey }): Promise<string>` (throws `{ status: 400 }` when there is none)
  - `zernioConnectionRows({ db, userId }): Promise<Array<typeof connections.$inferSelect>>`
  - `upsertZernioConnection({ db, env, userId, apiKey, account }): Promise<typeof connections.$inferSelect>`
  - `zernioKeyProblem(err: unknown): Response | null` — a 400 with a sentence for a rejected or under-scoped key, else null. Lives here, not in a route: SvelteKit refuses non-handler exports from `+server.ts`.
  - `zernioCallbackUrl(appUrl: string, boundState: string): string`

- [ ] **Step 1: Write the failing tests**

`tests/zernio-import.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { decryptJson, encryptJson } from '$lib/server/crypto';
import { newId, type AppDb } from '$lib/server/db/client';
import { connections, users } from '$lib/server/db/schema';
import { createTestDb, TEST_ENV } from '$lib/server/db/test';
import {
	resolveZernioKey,
	storedZernioKey,
	toImportable,
	upsertZernioConnection
} from '$lib/server/zernio-import';
import type { ZernioAccount } from '$lib/server/zernio';

const account = (over: Partial<ZernioAccount> = {}): ZernioAccount => ({
	_id: 'acc-1',
	platform: 'twitter',
	profileId: { _id: 'p1', name: 'Brand' },
	username: '@acme',
	displayName: 'Acme',
	profilePicture: 'https://img.example/a.png',
	isActive: true,
	...over
});

describe('zernio import', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		userId = newId();
		const now = new Date();
		await db.insert(users).values({
			id: userId,
			email: 'zernio@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());

	it('describes an account for the dialog and drops what CogSend cannot post to', () => {
		const imported = new Set(['acc-9']);
		expect(toImportable(account(), imported)).toEqual({
			id: 'acc-1',
			platform: 'x',
			profileId: 'p1',
			handle: 'acme',
			displayName: 'Acme',
			avatarUrl: 'https://img.example/a.png',
			needsReconnection: false,
			imported: false
		});
		expect(toImportable(account({ _id: 'acc-9' }), imported)?.imported).toBe(true);
		expect(toImportable(account({ platform: 'instagram' }), imported)).toBeNull();
		// Created as a side effect of an ads connect: Zernio's own UI hides it.
		expect(toImportable(account({ enabled: false }), imported)).toBeNull();
	});

	it('creates a row with the marker, the key and the account id', async () => {
		const row = await upsertZernioConnection({
			db,
			env: TEST_ENV,
			userId,
			apiKey: 'zk_1',
			account: account()
		});
		expect(row.platform).toBe('x');
		expect(row.handle).toBe('acme');
		expect(row.displayName).toBe('Acme');
		expect(row.status).toBe('active');
		expect(JSON.parse(row.metaJson)).toEqual({
			provider: 'zernio',
			zernioAccountId: 'acc-1',
			zernioProfileId: 'p1'
		});
		expect(await decryptJson(row.credentialsEncrypted, TEST_ENV.APP_ENCRYPTION_KEY)).toEqual({
			zernioApiKey: 'zk_1',
			zernioAccountId: 'acc-1'
		});
		expect(await storedZernioKey({ db, env: TEST_ENV, userId })).toBe('zk_1');
	});

	it('re-importing refreshes the same row instead of adding one', async () => {
		const again = await upsertZernioConnection({
			db,
			env: TEST_ENV,
			userId,
			apiKey: 'zk_2',
			account: account({ displayName: 'Acme Inc', needsReconnection: true })
		});
		const rows = await db
			.select()
			.from(connections)
			.where(and(eq(connections.userId, userId), eq(connections.platform, 'x')));
		expect(rows).toHaveLength(1);
		expect(again.id).toBe(rows[0].id);
		expect(again.displayName).toBe('Acme Inc');
		expect(again.status).toBe('expired');
		expect(await storedZernioKey({ db, env: TEST_ENV, userId })).toBe('zk_2');
	});

	it('never touches a direct connection with the same handle', async () => {
		const directId = newId();
		const now = new Date();
		const directCreds = await encryptJson({ accessToken: 'direct' }, TEST_ENV.APP_ENCRYPTION_KEY);
		await db.insert(connections).values({
			id: directId,
			userId,
			platform: 'threads',
			handle: 'acme',
			credentialsEncrypted: directCreds,
			metaJson: JSON.stringify({ threadsUserId: '42' }),
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		const viaZernio = await upsertZernioConnection({
			db,
			env: TEST_ENV,
			userId,
			apiKey: 'zk_2',
			account: account({ _id: 'acc-t', platform: 'threads' })
		});
		expect(viaZernio.id).not.toBe(directId);
		const direct = (await db.select().from(connections).where(eq(connections.id, directId)))[0];
		expect(direct.credentialsEncrypted).toBe(directCreds);
		expect(direct.metaJson).toBe(JSON.stringify({ threadsUserId: '42' }));
	});

	it('resolves the key from the request first, then from a stored row', async () => {
		expect(await resolveZernioKey({ db, env: TEST_ENV, userId, apiKey: ' zk_new ' })).toBe(
			'zk_new'
		);
		expect(await resolveZernioKey({ db, env: TEST_ENV, userId })).toBe('zk_2');
		const stranger = newId();
		await expect(resolveZernioKey({ db, env: TEST_ENV, userId: stranger })).rejects.toMatchObject({
			status: 400
		});
	});

	it('turns a rejected or under-scoped key into a sentence, and leaves the rest alone', async () => {
		const auth = zernioKeyProblem(zernioHttpError('list', 401, '{"error":"Invalid API key"}'));
		expect(auth?.status).toBe(400);
		expect(((await auth!.json()) as { error: string }).error).toBe('Zernio rejected this API key');
		const scoped = zernioKeyProblem(
			zernioHttpError('list', 403, '{"error":"This key cannot access accounts"}')
		);
		expect(((await scoped!.json()) as { error: string }).error).toBe(
			'This Zernio API key cannot be used here: This key cannot access accounts'
		);
		expect(zernioKeyProblem(zernioHttpError('list', 503, 'down'))).toBeNull();
		expect(zernioKeyProblem(new Error('boom'))).toBeNull();
	});

	it('builds the callback URL Zernio redirects to, with the bound state', () => {
		const url = new URL(zernioCallbackUrl('https://cog.example/', 'abc.def'));
		expect(url.origin + url.pathname).toBe('https://cog.example/api/connections/zernio/callback');
		expect(url.searchParams.get('pending')).toBe('abc.def');
	});
});
```

(Add `zernioCallbackUrl`, `zernioKeyProblem` to the `$lib/server/zernio-import` import and `import { zernioHttpError } from '$lib/server/zernio';` at the top of the test file.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/zernio-import.test.ts`
Expected: FAIL, cannot resolve `$lib/server/zernio-import`.

- [ ] **Step 3: Write the service**

`src/lib/server/zernio-import.ts`:

```ts
import { and, desc, eq, ne } from 'drizzle-orm';
import type { PlatformId } from '$lib/domain/platforms';
import { fromZernioPlatform, isZernioConnection } from '$lib/domain/zernio';
import { decryptJson, encryptJson } from './crypto';
import { newId, parseJson, type AppDb } from './db/client';
import { connections } from './db/schema';
import type { AppEnv } from './env';
import type { ConnectionCredentials } from './providers/types';
import { zernioProfileId, type ZernioAccount } from './zernio';

export interface ImportableAccount {
	id: string;
	platform: PlatformId;
	profileId: string;
	handle: string | null;
	displayName: string | null;
	avatarUrl: string | null;
	needsReconnection: boolean;
	imported: boolean;
}

function handleOf(account: ZernioAccount): string | null {
	const handle = (account.username ?? '').replace(/^@/, '').trim();
	return handle || null;
}

export function toImportable(
	account: ZernioAccount,
	importedIds: Set<string>
): ImportableAccount | null {
	const platform = fromZernioPlatform(account.platform);
	if (!platform || account.enabled === false) return null;
	const handle = handleOf(account);
	return {
		id: account._id,
		platform,
		profileId: zernioProfileId(account),
		handle,
		displayName: account.displayName?.trim() || handle,
		avatarUrl: account.profilePicture || null,
		needsReconnection: account.needsReconnection === true,
		imported: importedIds.has(account._id)
	};
}

export async function zernioConnectionRows(opts: { db: AppDb; userId: string }) {
	const rows = await opts.db
		.select()
		.from(connections)
		.where(and(eq(connections.userId, opts.userId), ne(connections.status, 'disconnected')))
		.orderBy(desc(connections.updatedAt));
	return rows.filter((row) => isZernioConnection(row.metaJson));
}

/** The key on the most recently touched Zernio row, so it is pasted once. */
export async function storedZernioKey(opts: {
	db: AppDb;
	env: AppEnv;
	userId: string;
}): Promise<string | null> {
	for (const row of await zernioConnectionRows(opts)) {
		if (!row.credentialsEncrypted) continue;
		try {
			const creds = await decryptJson<ConnectionCredentials>(
				row.credentialsEncrypted,
				opts.env.APP_ENCRYPTION_KEY
			);
			if (creds.zernioApiKey) return creds.zernioApiKey;
		} catch {
			// A row encrypted under an older key is not a reason to fail the
			// dialog; the next row may still carry a usable one.
		}
	}
	return null;
}

export async function resolveZernioKey(opts: {
	db: AppDb;
	env: AppEnv;
	userId: string;
	apiKey?: unknown;
}): Promise<string> {
	const given = typeof opts.apiKey === 'string' ? opts.apiKey.trim() : '';
	if (given) return given;
	const stored = await storedZernioKey(opts);
	if (stored) return stored;
	throw Object.assign(new Error('A Zernio API key is required'), { status: 400 });
}

export async function upsertZernioConnection(opts: {
	db: AppDb;
	env: AppEnv;
	userId: string;
	apiKey: string;
	account: ZernioAccount;
}) {
	const { db, env, userId, apiKey, account } = opts;
	const platform = fromZernioPlatform(account.platform);
	if (!platform)
		throw Object.assign(new Error(`Unsupported platform ${account.platform}`), { status: 400 });
	const handle = handleOf(account);
	const now = new Date();
	const data = {
		displayName: account.displayName?.trim() || handle,
		handle,
		avatarUrl: account.profilePicture || null,
		credentialsEncrypted: await encryptJson(
			{ zernioApiKey: apiKey, zernioAccountId: account._id },
			env.APP_ENCRYPTION_KEY
		),
		metaJson: JSON.stringify({
			provider: 'zernio',
			zernioAccountId: account._id,
			zernioProfileId: zernioProfileId(account)
		}),
		status: account.needsReconnection ? 'expired' : 'active',
		updatedAt: now
	};
	// Only rows that are already Zernio-backed are candidates, matched on the
	// Zernio account id alone: a direct connection to the same handle is a
	// different credential and must never be overwritten by an import.
	const existing = (
		await db
			.select()
			.from(connections)
			.where(and(eq(connections.userId, userId), eq(connections.platform, platform)))
	).find(
		(row) =>
			isZernioConnection(row.metaJson) &&
			parseJson<{ zernioAccountId?: string }>(row.metaJson, {}).zernioAccountId === account._id
	);
	if (existing) {
		return (
			await db.update(connections).set(data).where(eq(connections.id, existing.id)).returning()
		)[0];
	}
	return (
		await db
			.insert(connections)
			.values({ id: newId(), userId, platform, ...data, createdAt: now })
			.returning()
	)[0];
}

/**
 * A key the dialog can act on gets a sentence, not a status code: `humanizeError`
 * reads "401" as a dead account and "403" as a refused post, which is the wrong
 * advice for someone pasting a key.
 */
export function zernioKeyProblem(err: unknown): Response | null {
	if (!(err instanceof ProviderError)) return null;
	if (err.code === 'auth') return fail('Zernio rejected this API key', 400);
	if (err.status === 403) {
		return fail(`This Zernio API key cannot be used here: ${zernioApiMessage(err)}`, 400);
	}
	return null;
}

export function zernioCallbackUrl(appUrl: string, boundState: string): string {
	const url = new URL('/api/connections/zernio/callback', appUrl.replace(/\/+$/, '') + '/');
	url.searchParams.set('pending', boundState);
	return url.toString();
}
```

with these two imports added at the top of the file:

```ts
import { fail } from './http';
import { ProviderError } from './providers/types';
```

and `zernioApiMessage` added to the import from `./zernio`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/zernio-import.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Lint, check, commit**

Run: `npm run lint && npm run check`

```bash
git add src/lib/server/zernio-import.ts tests/zernio-import.test.ts
git commit -m "feat(zernio): import service with key reuse and marker-scoped upsert"
```

---

### Task 6: List and import routes

**Files:**

- Create: `src/routes/api/connections/zernio/accounts/+server.ts`
- Create: `src/routes/api/connections/zernio/import/+server.ts`
- Test: `tests/zernio-routes.test.ts`

**Interfaces:**

- Consumes: Task 3 `listProfiles`, `listAccounts`, `zernioApiMessage`; Task 5 service; `requireSession`, `fail`, `ok`, `handleError`, `serializeConnection`.
- Produces:
  - `POST /api/connections/zernio/accounts` `{ apiKey?: string }` → `{ profiles: [{ id, name }], accounts: ImportableAccount[], hasStoredKey: boolean }`
  - `POST /api/connections/zernio/import` `{ apiKey?: string, accountIds: string[] }` → `{ connections: ReturnType<typeof serializeConnection>[] }`

- [ ] **Step 1: Write the failing tests**

`tests/zernio-routes.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId, type AppDb } from '$lib/server/db/client';
import { connections, users } from '$lib/server/db/schema';
import { createTestDb, TEST_ENV } from '$lib/server/db/test';
import { POST as accountsPOST } from '../src/routes/api/connections/zernio/accounts/+server';
import { POST as importPOST } from '../src/routes/api/connections/zernio/import/+server';

const zernioAccounts = [
	{ _id: 'acc-x', platform: 'twitter', profileId: 'p1', username: '@acme', displayName: 'Acme' },
	{ _id: 'acc-ig', platform: 'instagram', profileId: 'p1', username: 'acme' },
	{ _id: 'acc-li', platform: 'linkedin', profileId: 'p1', displayName: 'Acme Inc' }
];

function stubZernio(overrides: Record<string, (req: Request) => Response> = {}) {
	const seen: Request[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: unknown, init?: RequestInit) => {
			const req = new Request(String(input), init);
			seen.push(req);
			for (const [key, handler] of Object.entries(overrides)) {
				if (req.url.includes(key)) return handler(req);
			}
			if (req.url.includes('/v1/profiles')) {
				return Response.json({ profiles: [{ _id: 'p1', name: 'Brand' }] });
			}
			if (req.url.includes('/v1/accounts')) return Response.json({ accounts: zernioAccounts });
			return new Response('unmocked', { status: 404 });
		})
	);
	return seen;
}

describe('zernio list and import routes', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;

	const locals = (overrides: Record<string, unknown> = {}) => ({
		db,
		env: TEST_ENV,
		user: {
			id: userId,
			email: 'z@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		},
		authMethod: 'session' as const,
		...overrides
	});
	const call = (handler: unknown, body: unknown, overrides: Record<string, unknown> = {}) =>
		(handler as (event: unknown) => Promise<Response>)({
			request: new Request('http://localhost/api/connections/zernio', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			}),
			locals: locals(overrides),
			cookies: { get: () => 'session-token' },
			url: new URL('http://localhost/api/connections/zernio')
		} as never) as Promise<Response>;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		userId = newId();
		const now = new Date();
		await db.insert(users).values({
			id: userId,
			email: 'z@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());
	afterEach(() => vi.unstubAllGlobals());

	it('is session-only', async () => {
		for (const handler of [accountsPOST, importPOST]) {
			const res = await call(handler, { apiKey: 'zk' }, { authMethod: 'bearer' });
			expect(res.status).toBe(401);
		}
	});

	it('needs a key the first time', async () => {
		stubZernio();
		const res = await call(accountsPOST, {});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toMatch(/API key/);
	});

	it('lists the importable accounts with the profiles', async () => {
		const seen = stubZernio();
		const res = await call(accountsPOST, { apiKey: 'zk_1' });
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			profiles: Array<{ id: string; name: string }>;
			accounts: Array<{ id: string; platform: string; imported: boolean }>;
			hasStoredKey: boolean;
		};
		expect(body.profiles).toEqual([{ id: 'p1', name: 'Brand' }]);
		expect(body.accounts.map((a) => [a.id, a.platform, a.imported])).toEqual([
			['acc-x', 'x', false],
			['acc-li', 'linkedin', false]
		]);
		expect(body.hasStoredKey).toBe(false);
		expect(seen.every((r) => r.headers.get('authorization') === 'Bearer zk_1')).toBe(true);
	});

	it('explains a rejected key in words', async () => {
		stubZernio({
			'/v1/profiles': () => Response.json({ error: 'Invalid API key' }, { status: 401 })
		});
		const res = await call(accountsPOST, { apiKey: 'zk_bad' });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('Zernio rejected this API key');
		expect(body.error).not.toMatch(/401/);
	});

	it('a key missing a resource group is explained', async () => {
		stubZernio({
			'/v1/accounts': () =>
				Response.json(
					{ error: 'This key cannot access accounts', code: 'insufficient_permissions' },
					{ status: 403 }
				)
		});
		const res = await call(accountsPOST, { apiKey: 'zk_ro' });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe(
			'This Zernio API key cannot be used here: This key cannot access accounts'
		);
	});

	it('imports the chosen accounts and reuses the stored key afterwards', async () => {
		stubZernio();
		const res = await call(importPOST, { apiKey: 'zk_1', accountIds: ['acc-x', 'acc-li'] });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { connections: Array<{ platform: string; handle: string }> };
		expect(body.connections.map((c) => c.platform).sort()).toEqual(['linkedin', 'x']);
		const rows = await db.select().from(connections).where(eq(connections.userId, userId));
		expect(rows).toHaveLength(2);

		const seen = stubZernio();
		const again = await call(accountsPOST, {});
		expect(again.status).toBe(200);
		const listed = (await again.json()) as {
			accounts: Array<{ id: string; imported: boolean }>;
			hasStoredKey: boolean;
		};
		expect(listed.hasStoredKey).toBe(true);
		expect(listed.accounts.find((a) => a.id === 'acc-x')?.imported).toBe(true);
		expect(seen[0].headers.get('authorization')).toBe('Bearer zk_1');
	});

	it('refuses ids Zernio does not know or CogSend cannot post to', async () => {
		stubZernio();
		const unknown = await call(importPOST, { accountIds: ['nope'] });
		expect(unknown.status).toBe(400);
		expect(((await unknown.json()) as { error: string }).error).toContain('nope');
		const instagram = await call(importPOST, { accountIds: ['acc-ig'] });
		expect(instagram.status).toBe(400);
		const empty = await call(importPOST, { accountIds: [] });
		expect(empty.status).toBe(400);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/zernio-routes.test.ts`
Expected: FAIL, cannot resolve the route modules.

- [ ] **Step 3: Write the routes**

`src/routes/api/connections/zernio/accounts/+server.ts`:

```ts
import type { RequestHandler } from './$types';
import { handleError, ok } from '$lib/server/http';
import { requireSession } from '$lib/server/require';
import { listAccounts, listProfiles } from '$lib/server/zernio';
import {
	resolveZernioKey,
	storedZernioKey,
	toImportable,
	zernioConnectionRows,
	zernioKeyProblem
} from '$lib/server/zernio-import';
import { parseJson } from '$lib/server/db/client';

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const body = (await request.json().catch(() => ({}))) as { apiKey?: unknown };
		const stored = await storedZernioKey({ db: locals.db, env: locals.env, userId: user.id });
		const apiKey = await resolveZernioKey({
			db: locals.db,
			env: locals.env,
			userId: user.id,
			apiKey: body.apiKey
		});
		const [profiles, accounts, rows] = await Promise.all([
			listProfiles({ apiKey }),
			listAccounts({ apiKey }),
			zernioConnectionRows({ db: locals.db, userId: user.id })
		]);
		const importedIds = new Set(
			rows.map(
				(row) => parseJson<{ zernioAccountId?: string }>(row.metaJson, {}).zernioAccountId ?? ''
			)
		);
		return ok({
			profiles: profiles.map((p) => ({ id: p._id, name: p.name })),
			accounts: accounts
				.map((account) => toImportable(account, importedIds))
				.filter((account) => account !== null),
			hasStoredKey: stored !== null
		});
	} catch (err) {
		return zernioKeyProblem(err) ?? handleError(err);
	}
};
```

`src/routes/api/connections/zernio/import/+server.ts`:

```ts
import type { RequestHandler } from './$types';
import { fail, handleError, ok } from '$lib/server/http';
import { requireSession } from '$lib/server/require';
import { serializeConnection } from '$lib/server/serialize';
import { listAccounts } from '$lib/server/zernio';
import {
	resolveZernioKey,
	toImportable,
	upsertZernioConnection,
	zernioKeyProblem
} from '$lib/server/zernio-import';

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const body = (await request.json().catch(() => ({}))) as {
			apiKey?: unknown;
			accountIds?: unknown;
		};
		const ids = Array.isArray(body.accountIds)
			? body.accountIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
			: [];
		if (!ids.length) return fail('Pick at least one account to import');
		const apiKey = await resolveZernioKey({
			db: locals.db,
			env: locals.env,
			userId: user.id,
			apiKey: body.apiKey
		});
		// Fetched again rather than trusted from the browser: the row stores
		// what Zernio says the account is.
		const accounts = await listAccounts({ apiKey });
		const byId = new Map(accounts.map((account) => [account._id, account]));
		const missing = ids.filter((id) => !byId.has(id));
		if (missing.length) return fail(`Zernio has no account ${missing.join(', ')} on this key`);
		const unsupported = ids.filter((id) => toImportable(byId.get(id)!, new Set()) === null);
		if (unsupported.length) {
			return fail(
				`CogSend cannot post to ${unsupported.map((id) => byId.get(id)!.platform).join(', ')}`
			);
		}
		const rows = [];
		for (const id of ids) {
			rows.push(
				await upsertZernioConnection({
					db: locals.db,
					env: locals.env,
					userId: user.id,
					apiKey,
					account: byId.get(id)!
				})
			);
		}
		return ok({ connections: rows.map(serializeConnection) });
	} catch (err) {
		return zernioKeyProblem(err) ?? handleError(err);
	}
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/zernio-routes.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Lint, check, commit**

Run: `npm run lint && npm run check`

```bash
git add src/routes/api/connections/zernio tests/zernio-routes.test.ts
git commit -m "feat(zernio): list and import routes"
```

---

### Task 7: Connect-through and callback routes

**Files:**

- Create: `src/routes/api/connections/zernio/connect/+server.ts`
- Create: `src/routes/api/connections/zernio/callback/+server.ts`
- Modify: `src/hooks.server.ts:994-1004` (`isPublicPath`)
- Test: `tests/zernio-connect.test.ts`

**Interfaces:**

- Consumes: Task 3 `connectUrl`, `listAccounts`; Task 5 `resolveZernioKey`, `upsertZernioConnection`; `bindOAuthState`, `verifyOAuthState`, `splitOAuthState`; `encryptSecret`/`decryptSecret`; `oauthPending`; `OAUTH_PENDING_TTL_MS`; `randomHex`; `ZERNIO_PENDING_MARKER`, `toZernioPlatform`, `fromZernioPlatform`.
- Produces:
  - `POST /api/connections/zernio/connect` `{ apiKey?, profileId: string, platform: string }` → `{ authorizeUrl }`
  - `GET /api/connections/zernio/callback?pending=<state>&connected=<zernio platform>&accountId=…` (or `&error=…&error_message=…`) → 302 to `/accounts?connected=<platform>` or `/accounts?error=<message>`

- [ ] **Step 1: Write the failing tests**

`tests/zernio-connect.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId, type AppDb } from '$lib/server/db/client';
import { connections, oauthPending, users } from '$lib/server/db/schema';
import { createTestDb, TEST_ENV } from '$lib/server/db/test';
import { POST as connectPOST } from '../src/routes/api/connections/zernio/connect/+server';
import { GET as callbackGET } from '../src/routes/api/connections/zernio/callback/+server';
import { isPublicPath } from '../src/hooks.server';

describe('zernio connect-through', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;

	const locals = (overrides: Record<string, unknown> = {}) => ({
		db,
		env: { ...TEST_ENV, APP_URL: 'https://cog.example' },
		user: {
			id: userId,
			email: 'z@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		},
		authMethod: 'session' as const,
		...overrides
	});
	const connect = (body: unknown, overrides: Record<string, unknown> = {}) =>
		(connectPOST as (event: unknown) => Promise<Response>)({
			request: new Request('http://localhost/api/connections/zernio/connect', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			}),
			locals: locals(overrides),
			cookies: { get: () => 'session-token' },
			url: new URL('http://localhost/api/connections/zernio/connect')
		} as never);
	const callback = (query: string, cookie: string | undefined = 'session-token') =>
		(callbackGET as (event: unknown) => Promise<Response>)({
			url: new URL(`https://cog.example/api/connections/zernio/callback?${query}`),
			locals: locals(),
			cookies: { get: () => cookie }
		} as never).catch((e: unknown) => e);
	const redirectOf = (thrown: unknown) => (thrown as { status?: number; location?: string }) ?? {};

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		userId = newId();
		const now = new Date();
		await db.insert(users).values({
			id: userId,
			email: 'z@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());
	afterEach(() => vi.unstubAllGlobals());

	function stubZernio(seen: Request[] = []) {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: unknown, init?: RequestInit) => {
				const req = new Request(String(input), init);
				seen.push(req);
				if (req.url.includes('/v1/connect/twitter')) {
					return Response.json({ authUrl: 'https://x.com/i/oauth2/authorize?state=z' });
				}
				if (req.url.includes('/v1/accounts')) {
					return Response.json({
						accounts: [{ _id: 'acc-new', platform: 'twitter', profileId: 'p1', username: '@fresh' }]
					});
				}
				return new Response('unmocked', { status: 404 });
			})
		);
		return seen;
	}

	it('the callback is reachable without a session, like the other callbacks', () => {
		expect(isPublicPath('/api/connections/zernio/callback')).toBe(true);
		expect(isPublicPath('/api/connections/zernio/connect')).toBe(false);
	});

	it('refuses bearer callers and unsupported platforms', async () => {
		expect(
			(await connect({ apiKey: 'zk', profileId: 'p1', platform: 'x' }, { authMethod: 'bearer' }))
				.status
		).toBe(401);
		expect((await connect({ apiKey: 'zk', profileId: 'p1', platform: 'mastodon' })).status).toBe(
			400
		);
		expect((await connect({ apiKey: 'zk', platform: 'x' })).status).toBe(400);
	});

	it('stores the key on a pending row and sends the visitor to Zernio', async () => {
		const seen = stubZernio();
		const res = await connect({ apiKey: 'zk_1', profileId: 'p1', platform: 'x' });
		expect(res.status).toBe(200);
		expect(((await res.json()) as { authorizeUrl: string }).authorizeUrl).toBe(
			'https://x.com/i/oauth2/authorize?state=z'
		);
		const asked = new URL(seen[0].url);
		expect(asked.searchParams.get('profileId')).toBe('p1');
		const redirect = new URL(asked.searchParams.get('redirect_url')!);
		expect(redirect.origin + redirect.pathname).toBe(
			'https://cog.example/api/connections/zernio/callback'
		);
		const pending = (
			await db.select().from(oauthPending).where(eq(oauthPending.instanceUrl, 'zernio'))
		)[0];
		expect(pending.clientId).toBe('p1');
		expect(pending.clientSecretEnc).not.toContain('zk_1');
		expect(redirect.searchParams.get('pending')).toMatch(new RegExp(`^${pending.id}\\.`));
	});

	it('the callback imports the account Zernio names and revives on reconnect', async () => {
		const seen = stubZernio();
		const res = await connect({ apiKey: 'zk_1', profileId: 'p1', platform: 'x' });
		const asked = new URL(seen[0].url);
		const state = new URL(asked.searchParams.get('redirect_url')!).searchParams.get('pending')!;
		expect(res.status).toBe(200);

		const done = redirectOf(
			await callback(
				`pending=${encodeURIComponent(state)}&connected=twitter&profileId=p1&accountId=acc-new&username=fresh`
			)
		);
		expect(done.status).toBe(302);
		expect(done.location).toBe('https://cog.example/accounts?connected=x');
		const rows = await db.select().from(connections).where(eq(connections.userId, userId));
		expect(rows.map((r) => [r.platform, r.handle, r.status])).toEqual([['x', 'fresh', 'active']]);
		expect(JSON.parse(rows[0].metaJson).zernioAccountId).toBe('acc-new');
		// Single use.
		const again = redirectOf(
			await callback(`pending=${encodeURIComponent(state)}&connected=twitter&accountId=acc-new`)
		);
		expect(again.location).toContain('error=oauth_expired');
	});

	it('a Zernio-side failure comes back as a readable error', async () => {
		stubZernio();
		const seen: Request[] = [];
		stubZernio(seen);
		await connect({ apiKey: 'zk_1', profileId: 'p1', platform: 'x' });
		const state = new URL(new URL(seen[0].url).searchParams.get('redirect_url')!).searchParams.get(
			'pending'
		)!;
		const failed = redirectOf(
			await callback(
				`pending=${encodeURIComponent(state)}&error=access_denied&platform=twitter&error_message=You%20cancelled`
			)
		);
		expect(failed.status).toBe(302);
		expect(failed.location).toBe('https://cog.example/accounts?error=You%20cancelled');
		expect(
			await db.select().from(oauthPending).where(eq(oauthPending.instanceUrl, 'zernio'))
		).toEqual([]);
	});

	it('a state bound to another session is refused', async () => {
		const seen = stubZernio();
		await connect({ apiKey: 'zk_1', profileId: 'p1', platform: 'x' });
		const state = new URL(new URL(seen[0].url).searchParams.get('redirect_url')!).searchParams.get(
			'pending'
		)!;
		const wrong = redirectOf(
			await callback(
				`pending=${encodeURIComponent(state)}&connected=twitter&accountId=acc-new`,
				'someone-else'
			)
		);
		expect(wrong.location).toContain('error=oauth_expired');
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/zernio-connect.test.ts`
Expected: FAIL, cannot resolve the route modules.

- [ ] **Step 3: Write the connect route**

`src/routes/api/connections/zernio/connect/+server.ts`:

```ts
import type { RequestHandler } from './$types';
import { randomHex } from '$lib/domain/bytes';
import { OAUTH_PENDING_TTL_MS } from '$lib/domain/oauth-pending';
import { isPlatformId } from '$lib/domain/platforms';
import { ZERNIO_PENDING_MARKER, toZernioPlatform } from '$lib/domain/zernio';
import { SESSION_COOKIE } from '$lib/server/auth';
import { encryptSecret } from '$lib/server/crypto';
import { oauthPending } from '$lib/server/db/schema';
import { fail, handleError, ok } from '$lib/server/http';
import { bindOAuthState } from '$lib/server/oauth-state';
import { requireSession } from '$lib/server/require';
import { connectUrl } from '$lib/server/zernio';
import { resolveZernioKey, zernioCallbackUrl, zernioKeyProblem } from '$lib/server/zernio-import';

export const POST: RequestHandler = async ({ request, locals, cookies }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const body = (await request.json().catch(() => ({}))) as {
			apiKey?: unknown;
			profileId?: unknown;
			platform?: unknown;
		};
		const platform = typeof body.platform === 'string' ? body.platform : '';
		const zernioPlatform = isPlatformId(platform) ? toZernioPlatform(platform) : null;
		if (!zernioPlatform) return fail('That platform cannot be connected through Zernio');
		const profileId = typeof body.profileId === 'string' ? body.profileId.trim() : '';
		if (!profileId) return fail('Pick the Zernio profile to connect the account to');
		const apiKey = await resolveZernioKey({
			db: locals.db,
			env: locals.env,
			userId: user.id,
			apiKey: body.apiKey
		});

		const pendingId = randomHex(16);
		const sessionId = cookies.get(SESSION_COOKIE) ?? `machine:${user.id}`;
		const bound = await bindOAuthState({
			secret: locals.env.AUTH_SECRET,
			pendingId,
			sessionId
		});
		// The key has to survive the round trip through Zernio and the platform;
		// the pending row's encrypted slot is where the other flows keep theirs.
		await locals.db.insert(oauthPending).values({
			id: pendingId,
			userId: user.id,
			instanceUrl: ZERNIO_PENDING_MARKER,
			clientId: profileId,
			clientSecretEnc: await encryptSecret(apiKey, locals.env.APP_ENCRYPTION_KEY),
			expiresAt: new Date(Date.now() + OAUTH_PENDING_TTL_MS),
			createdAt: new Date()
		});
		const authorizeUrl = await connectUrl({
			apiKey,
			platform: zernioPlatform,
			profileId,
			redirectUrl: zernioCallbackUrl(locals.env.APP_URL, bound)
		});
		return ok({ authorizeUrl });
	} catch (err) {
		return zernioKeyProblem(err) ?? handleError(err);
	}
};
```

- [ ] **Step 4: Write the callback route**

`src/routes/api/connections/zernio/callback/+server.ts`:

```ts
import { isRedirect, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { ZERNIO_PENDING_MARKER, fromZernioPlatform } from '$lib/domain/zernio';
import { SESSION_COOKIE } from '$lib/server/auth';
import { decryptSecret } from '$lib/server/crypto';
import { first } from '$lib/server/db/client';
import { oauthPending } from '$lib/server/db/schema';
import { splitOAuthState, verifyOAuthState } from '$lib/server/oauth-state';
import { listAccounts, zernioApiMessage } from '$lib/server/zernio';
import { upsertZernioConnection } from '$lib/server/zernio-import';

/**
 * Zernio lands here after its hosted flow with `connected`, `profileId`,
 * `accountId` and `username`, or `error`, `platform` and `error_message`.
 * The state check mirrors createOAuthCallback: the pending row must exist,
 * be ours, be unexpired and be bound to the session that started the flow.
 */
export const GET: RequestHandler = async ({ url, locals, cookies }) => {
	const appUrl = locals.env.APP_URL.replace(/\/$/, '');
	const state = url.searchParams.get('pending');
	const candidate = splitOAuthState(state);
	const pending = candidate
		? await first(locals.db.select().from(oauthPending).where(eq(oauthPending.id, candidate)))
		: null;
	const sessionId = cookies.get(SESSION_COOKIE) ?? (pending ? `machine:${pending.userId}` : null);
	const pendingId = await verifyOAuthState({ secret: locals.env.AUTH_SECRET, state, sessionId });
	if (
		!pending ||
		!pendingId ||
		pending.id !== pendingId ||
		pending.expiresAt < new Date() ||
		pending.instanceUrl !== ZERNIO_PENDING_MARKER
	) {
		if (pending) await locals.db.delete(oauthPending).where(eq(oauthPending.id, pending.id));
		redirect(302, `${appUrl}/accounts?error=oauth_expired`);
	}
	await locals.db.delete(oauthPending).where(eq(oauthPending.id, pending.id));

	const failure = url.searchParams.get('error');
	if (failure) {
		const message = url.searchParams.get('error_message') || failure;
		redirect(302, `${appUrl}/accounts?error=${encodeURIComponent(message)}`);
	}
	try {
		const apiKey = await decryptSecret(pending.clientSecretEnc, locals.env.APP_ENCRYPTION_KEY);
		const accountId = url.searchParams.get('accountId') ?? '';
		const account = (await listAccounts({ apiKey, profileId: pending.clientId })).find(
			(a) => a._id === accountId
		);
		if (!account) throw new Error('Zernio did not report the connected account');
		const platform = fromZernioPlatform(account.platform);
		if (!platform) throw new Error(`CogSend cannot post to ${account.platform}`);
		await upsertZernioConnection({
			db: locals.db,
			env: locals.env,
			userId: pending.userId,
			apiKey,
			account
		});
		redirect(302, `${appUrl}/accounts?connected=${platform}`);
	} catch (e) {
		if (isRedirect(e)) throw e;
		redirect(302, `${appUrl}/accounts?error=${encodeURIComponent(zernioApiMessage(e))}`);
	}
};
```

- [ ] **Step 5: Open the callback path**

In `src/hooks.server.ts` `isPublicPath`, add after the X callback line:

```ts
		path.startsWith('/api/connections/zernio/callback') ||
```

(Keep it inside the same `if (…)` chain: `path.startsWith('/api/connections/x/callback') || path.startsWith('/api/connections/zernio/callback')`.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/zernio-connect.test.ts tests/public-paths.test.ts`
Expected: PASS. If `tests/public-paths.test.ts` enumerates the public callbacks, add the Zernio one to its list.

- [ ] **Step 7: Lint, check, full suite, commit**

Run: `npm run lint && npm run check && npm test`

```bash
git add src/routes/api/connections/zernio src/hooks.server.ts tests/zernio-connect.test.ts tests/public-paths.test.ts
git commit -m "feat(zernio): connect a new account through Zernio's hosted flow"
```

---

### Task 8: Verify route branch

**Files:**

- Modify: `src/routes/api/connections/[id]/verify/+server.ts:481-487` (insert a branch before `if (conn.platform === 'bluesky')`)
- Test: `tests/verify-route.test.ts` (append)

**Interfaces:**

- Consumes: `isZernioConnection`, `listAccounts`, `ProviderError`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/verify-route.test.ts` inside the top-level describe (the `db`, `ownerId`, `addConnection`, `verify`, `statusOf` helpers are in scope; `encryptJson` and `TEST_ENV` are imported at the top; add `import { vi, afterEach } from 'vitest'` pieces only if not already imported):

```ts
describe('through Zernio', () => {
	afterEach(() => vi.unstubAllGlobals());

	async function zernioRow(status = 'expired') {
		return addConnection(ownerId, {
			platform: 'x',
			handle: 'acme',
			status,
			credentialsEncrypted: await encryptJson(
				{ zernioApiKey: 'zk_1', zernioAccountId: 'acc-1' },
				TEST_ENV.APP_ENCRYPTION_KEY
			),
			metaJson: JSON.stringify({
				provider: 'zernio',
				zernioAccountId: 'acc-1',
				zernioProfileId: 'p1'
			})
		});
	}
	const stub = (handler: (req: Request) => Response) =>
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: unknown, init?: RequestInit) => handler(new Request(String(input), init)))
		);

	it('marks the row active when Zernio still holds a live token', async () => {
		const id = await zernioRow();
		stub(() =>
			Response.json({
				accounts: [
					{
						_id: 'acc-1',
						platform: 'twitter',
						profileId: 'p1',
						username: '@acme2',
						displayName: 'Acme'
					}
				]
			})
		);
		expect((await verify(id)).status).toBe(200);
		const row = await statusOf(id);
		expect(row.status).toBe('active');
		expect(row.handle).toBe('acme2');
	});

	it('expires the row and says where to reconnect when Zernio reports the token dead', async () => {
		const id = await zernioRow('active');
		stub(() =>
			Response.json({
				accounts: [{ _id: 'acc-1', platform: 'twitter', profileId: 'p1', needsReconnection: true }]
			})
		);
		const res = await verify(id);
		expect(res.status).toBe(401);
		expect(((await res.json()) as { error: string }).error).toMatch(/reconnect .* in Zernio/i);
		expect((await statusOf(id)).status).toBe('expired');
	});

	it('expires the row when the key itself is refused, and keeps it on a blip', async () => {
		const id = await zernioRow('active');
		stub(() => Response.json({ error: 'Invalid API key' }, { status: 401 }));
		expect((await verify(id)).status).toBe(401);
		expect((await statusOf(id)).status).toBe('expired');

		const healthy = await zernioRow('active');
		stub(() => new Response('down', { status: 503 }));
		expect((await verify(healthy)).status).toBe(502);
		expect((await statusOf(healthy)).status).toBe('active');
	});
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/verify-route.test.ts`
Expected: the three new tests FAIL (the route falls through to the `x` branch and calls the X API).

- [ ] **Step 3: Add the branch**

In the verify route, add these imports:

```ts
import { isZernioConnection } from '$lib/domain/zernio';
import { listAccounts } from '$lib/server/zernio';
import { ProviderError } from '$lib/server/providers/types';
```

and insert as the first branch inside the `try`, right after `const creds = await decryptJson…;`:

```ts
if (isZernioConnection(conn.metaJson)) {
	const meta = parseJson<{ zernioAccountId?: string; zernioProfileId?: string }>(conn.metaJson, {});
	let account;
	try {
		account = (
			await listAccounts({
				apiKey: creds.zernioApiKey ?? '',
				profileId: meta.zernioProfileId,
				platform: undefined
			})
		).find((a) => a._id === (creds.zernioAccountId ?? meta.zernioAccountId));
	} catch (err) {
		if (err instanceof ProviderError && err.code === 'auth') {
			await locals.db
				.update(connections)
				.set({ status: 'expired', updatedAt: new Date() })
				.where(owned);
			return fail(
				'Zernio rejected the stored API key — import the account again with a new key',
				401
			);
		}
		// Transient (429/5xx/network): keep the status, like Mastodon.
		return fail('Zernio verify temporarily unavailable', 502);
	}
	if (!account || account.needsReconnection) {
		await locals.db
			.update(connections)
			.set({ status: 'expired', updatedAt: new Date() })
			.where(owned);
		return fail('Reconnect this account in Zernio, then check again', 401);
	}
	const handle = (account.username ?? '').replace(/^@/, '').trim() || conn.handle;
	await locals.db
		.update(connections)
		.set({
			status: 'active',
			handle,
			displayName: account.displayName?.trim() || conn.displayName,
			avatarUrl: account.profilePicture || conn.avatarUrl,
			updatedAt: new Date()
		})
		.where(owned);
	return ok({ ok: true, status: 'active' });
}
```

Add `parseJson` to the existing `$lib/server/db/client` import (`import { first, parseJson } from '$lib/server/db/client';`).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/verify-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, check, commit**

```bash
git add src/routes/api/connections/[id]/verify/+server.ts tests/verify-route.test.ts
git commit -m "feat(zernio): verify a Zernio-backed account against Zernio"
```

---

### Task 9: Accounts page (dialog entry, import list, connect-through, tag)

**Files:**

- Modify: `src/routes/accounts/+page.svelte`

**Interfaces:**

- Consumes: Task 6 and Task 7 routes; `zernioLink`; `ZERNIO_API_KEYS_URL`; `platformName`.

No unit test drives Svelte here (the repo has none); the browser suite is not extended (it needs a live Zernio). Verification is `npm run check`, `npm run lint`, `npm run build`, and the manual pass in Task 11.

- [ ] **Step 1: State and imports**

Add to the imports:

```ts
import { Plug } from '@lucide/svelte';
import { zernioLink } from '$lib/domain/zernio-links';
import { ZERNIO_API_KEYS_URL } from '$lib/domain/zernio';
```

(`Plug` joins the existing `{ ChevronDown, Plus, X }` import from `@lucide/svelte`.)

Extend the `Connection` type:

```ts
		metaJson?: { provider?: string; zernioProfileId?: string } | null;
```

Change `modalForm` to `$state<'none' | 'bluesky' | 'mastodon' | 'zernio'>('none')`.

Add state after `let connectCloseBtn…`:

```ts
type ZernioAccount = {
	id: string;
	platform: string;
	profileId: string;
	handle: string | null;
	displayName: string | null;
	avatarUrl: string | null;
	needsReconnection: boolean;
	imported: boolean;
};
let zernioApiKey = $state('');
let zernioProfiles = $state<Array<{ id: string; name: string }>>([]);
let zernioAccounts = $state<ZernioAccount[] | null>(null);
let zernioSelected = $state<string[]>([]);
let zernioHasStoredKey = $state(false);
let zernioConnectPlatform = $state<'x' | 'threads' | 'linkedin' | 'bluesky'>('x');
let zernioConnectProfile = $state('');
const ZERNIO_PLATFORMS = ['x', 'threads', 'linkedin', 'bluesky'] as const;
const viaZernio = (account: Connection) => account.metaJson?.provider === 'zernio';
```

Add the dialog entry to `availablePlatforms` after Bluesky:

```ts
		{
			id: 'zernio',
			name: 'Zernio',
			description: 'Post through Zernio’s API, no developer app needed · paid service and sponsor',
			form: 'zernio' as const
		}
```

- [ ] **Step 2: Functions**

Add after `connectMastodon`:

```ts
async function loadZernioAccounts(e?: Event) {
	e?.preventDefault();
	loading = true;
	err = null;
	try {
		const res = await fetch('/api/connections/zernio/accounts', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(zernioApiKey ? { apiKey: zernioApiKey } : {})
		});
		const payload = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(payload.error || 'Could not reach Zernio');
		zernioProfiles = payload.profiles ?? [];
		zernioAccounts = payload.accounts ?? [];
		zernioHasStoredKey = payload.hasStoredKey === true || Boolean(zernioApiKey);
		zernioSelected = (zernioAccounts ?? []).filter((a) => !a.imported).map((a) => a.id);
		if (!zernioConnectProfile) zernioConnectProfile = zernioProfiles[0]?.id ?? '';
	} catch (e) {
		err = humanizeError(e instanceof Error ? e.message : 'Could not reach Zernio');
	} finally {
		loading = false;
	}
}

async function importZernioAccounts() {
	loading = true;
	err = null;
	try {
		const res = await fetch('/api/connections/zernio/import', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				...(zernioApiKey ? { apiKey: zernioApiKey } : {}),
				accountIds: zernioSelected
			})
		});
		const payload = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(payload.error || 'Could not import');
		const n = (payload.connections ?? []).length;
		msg = `Imported ${n} account${n === 1 ? '' : 's'} from Zernio`;
		zernioApiKey = '';
		closeConnectDialog();
		await load();
	} catch (e) {
		err = humanizeError(e instanceof Error ? e.message : 'Could not import');
	} finally {
		loading = false;
	}
}

async function connectThroughZernio(platform: string, profileId: string) {
	loading = true;
	err = null;
	try {
		const res = await fetch('/api/connections/zernio/connect', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				...(zernioApiKey ? { apiKey: zernioApiKey } : {}),
				platform,
				profileId
			})
		});
		const payload = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(payload.error || 'Could not start the connection');
		window.location.href = payload.authorizeUrl;
	} catch (e) {
		err = humanizeError(e instanceof Error ? e.message : 'Could not start the connection');
		loading = false;
	}
}

function openZernioForm() {
	openConnectDialog();
	modalForm = 'zernio';
	zernioAccounts = null;
	if (zernioHasStoredKey) void loadZernioAccounts();
}

function toggleZernioAccount(id: string) {
	zernioSelected = zernioSelected.includes(id)
		? zernioSelected.filter((x) => x !== id)
		: [...zernioSelected, id];
}
```

In `pickPlatform`, before `if (found.form) {`:

```ts
if (found.form === 'zernio') {
	openZernioForm();
	return;
}
```

In `load()`, after `connections = …sort(…)`:

```ts
zernioHasStoredKey = connections.some(viaZernio);
```

Also seed it from the initial data, next to the other `$state` initialisers:

```ts
// svelte-ignore state_referenced_locally
zernioHasStoredKey = connections.some(viaZernio);
```

In `reconnectAccount`, as the first check:

```ts
if (viaZernio(account)) {
	const platform = account.platform;
	const profileId = account.metaJson?.zernioProfileId ?? '';
	if (!isZernioPlatform(platform) || !profileId) {
		err = 'This account has no Zernio profile recorded — import it again';
		return;
	}
	void connectThroughZernio(platform, profileId);
	return;
}
```

with the helper next to `viaZernio`:

```ts
const isZernioPlatform = (p: string): p is (typeof ZERNIO_PLATFORMS)[number] =>
	(ZERNIO_PLATFORMS as readonly string[]).includes(p);
```

- [ ] **Step 3: Markup**

In the account row, after the `<h3>` with `{platformName(account.platform)}`, inside the same `<div>`:

```svelte
{#if viaZernio(account)}
	<span
		class="ml-2 rounded bg-stone-100 px-1.5 py-0.5 align-middle text-[10px] font-bold tracking-widest text-stone-500 uppercase"
		>via Zernio</span
	>
{/if}
```

(Put it inside the `<h3>` so it sits on the platform line: `{platformName(account.platform)}{#if viaZernio(account)}…{/if}`.)

In the platform picker `{#each availablePlatforms …}`, replace the `<SocialIcon …/>` line with:

```svelte
{#if platform.id === 'zernio'}
	<Plug class="h-5 w-5" />
{:else}
	<SocialIcon platform={platform.id} className="h-5 w-5" />
{/if}
```

Add a new branch before the final `{:else}` (the Mastodon form): `{:else if modalForm === 'zernio'}`:

```svelte
				{:else if modalForm === 'zernio'}
					<div class="space-y-4">
						<button
							type="button"
							onclick={backToPlatforms}
							class="text-[13px] font-bold text-stone-500 hover:text-stone-900"
							>← All platforms</button
						>
						<h3 class="text-[17px] font-extrabold tracking-tight text-stone-900">Zernio</h3>
						<p class="text-xs font-medium text-stone-500">
							Zernio publishes with its own approved apps, so X, Threads, LinkedIn and Bluesky
							connect without a developer app of your own. It is a paid service and a sponsor of
							CogSend; posts still live and schedule here.
							<a
								href={zernioLink({ placement: 'accounts-dialog' })}
								target="_blank"
								rel="noreferrer"
								class="underline">About Zernio</a
							>
						</p>
						<form onsubmit={loadZernioAccounts} class="space-y-3">
							<input
								type="password"
								placeholder={zernioHasStoredKey ? 'API key (saved — leave blank to reuse)' : 'Zernio API key'}
								aria-label="Zernio API key"
								bind:value={zernioApiKey}
								class="w-full rounded-xl border border-stone-200/80 bg-stone-50 px-3 py-2.5 text-sm font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none"
								required={!zernioHasStoredKey}
								autocomplete="off"
							/>
							<p class="text-[11px] font-medium text-stone-500">
								Create one at <a
									href={ZERNIO_API_KEYS_URL}
									target="_blank"
									rel="noreferrer"
									class="underline">zernio.com → API keys</a
								>. It needs the publishing and accounts groups; a read-only key cannot post.
							</p>
							{#if zernioAccounts === null}
								<button
									type="submit"
									disabled={loading}
									class="w-full rounded-full bg-stone-900 py-2.5 text-[13px] font-bold text-white transition-all hover:bg-stone-800 disabled:opacity-50"
									>{loading ? 'Loading…' : 'Show my Zernio accounts'}</button
								>
							{/if}
						</form>
						{#if zernioAccounts !== null}
							{#if zernioAccounts.length === 0}
								<p class="text-xs font-medium text-stone-500">
									No X, Threads, LinkedIn or Bluesky accounts on this key yet. Connect one below.
								</p>
							{:else}
								<ul class="divide-y divide-stone-200/80 overflow-hidden rounded-xl border border-stone-200/80">
									{#each zernioAccounts as account (account.id)}
										<li class="flex items-center gap-3 p-3 text-sm">
											<input
												type="checkbox"
												id={`zernio-${account.id}`}
												checked={account.imported || zernioSelected.includes(account.id)}
												disabled={account.imported}
												onchange={() => toggleZernioAccount(account.id)}
												class="h-4 w-4"
											/>
											<label for={`zernio-${account.id}`} class="min-w-0 flex-1 cursor-pointer">
												<span class="font-bold text-stone-900">{platformName(account.platform)}</span>
												<span class="ml-2 text-stone-500"
													>{accountLabel(account.displayName, account.handle)}</span
												>
											</label>
											{#if account.imported}
												<span class="text-[10px] font-bold tracking-widest text-emerald-700 uppercase">Imported</span>
											{:else if account.needsReconnection}
												<span class="text-[10px] font-bold tracking-widest text-amber-700 uppercase">Needs reconnect</span>
											{/if}
										</li>
									{/each}
								</ul>
								<button
									type="button"
									onclick={importZernioAccounts}
									disabled={loading || zernioSelected.length === 0}
									class="w-full rounded-full bg-stone-900 py-2.5 text-[13px] font-bold text-white transition-all hover:bg-stone-800 disabled:opacity-50"
									>{loading
										? 'Importing…'
										: `Import ${zernioSelected.length} account${zernioSelected.length === 1 ? '' : 's'}`}</button
								>
							{/if}
							<div class="space-y-2 rounded-xl border border-stone-200/80 bg-stone-50 p-3">
								<p class="text-xs font-bold text-stone-900">Connect a new account through Zernio</p>
								<div class="flex flex-wrap gap-2">
									<select
										aria-label="Platform"
										bind:value={zernioConnectPlatform}
										class="rounded-lg border border-stone-200/80 bg-white px-2 py-1.5 text-xs font-bold text-stone-900"
									>
										{#each ZERNIO_PLATFORMS as id (id)}
											<option value={id}>{platformName(id)}</option>
										{/each}
									</select>
									<select
										aria-label="Zernio profile"
										bind:value={zernioConnectProfile}
										class="rounded-lg border border-stone-200/80 bg-white px-2 py-1.5 text-xs font-bold text-stone-900"
									>
										{#each zernioProfiles as profile (profile.id)}
											<option value={profile.id}>{profile.name}</option>
										{/each}
									</select>
									<button
										type="button"
										disabled={loading || !zernioConnectProfile}
										onclick={() => connectThroughZernio(zernioConnectPlatform, zernioConnectProfile)}
										class="rounded-full border border-stone-300 bg-white px-4 py-1.5 text-[12px] font-bold text-stone-900 transition-colors hover:bg-stone-100 disabled:opacity-50"
										>{loading ? 'Redirecting…' : 'Connect'}</button
									>
								</div>
								<p class="text-[11px] font-medium text-stone-500">
									You authorize on the platform, come back here, and the account is imported.
								</p>
							</div>
						{/if}
						{#if err}
							<p class="text-sm text-red-600">{err}</p>
						{/if}
					</div>
```

- [ ] **Step 4: Check, lint, format, build**

Run: `npm run format && npm run lint && npm run check && npm run build`
Expected: clean. Fix any svelte-check complaint about the `metaJson` type by aligning it with what `serializeConnection` returns (`Record<string, unknown>` parsed JSON; keep the narrow optional shape on the page type, it is a structural subset).

- [ ] **Step 5: Smoke it locally**

Run: `npm run dev` (needs `.dev.vars` with `SKIP_TOTP=1`; `npm run db:seed:local` once). Open Accounts → Connect new → Zernio. With no key, the form asks for one. Enter a Zernio key from the team account: profiles and accounts appear, import one, the row shows "via Zernio". Stop the server.

- [ ] **Step 6: Commit**

```bash
git add src/routes/accounts/+page.svelte
git commit -m "feat(zernio): import and connect Zernio accounts from the Accounts page"
```

---

### Task 10: Documentation and sponsorship placements

**Files:**

- Create: `docs/zernio.md`
- Modify: `README.md` (intro note, Features line, Documentation table row)
- Modify: `docs/oauth-apps.md:1-5` (one sentence)
- Modify: `AGENTS.md:6` (one clause)

Two commits: docs page + oauth-apps + AGENTS first (they stay whatever happens to the sponsorship), then the README placements alone.

- [ ] **Step 1: Write `docs/zernio.md`**

```markdown
# Connect through Zernio

[Zernio](https://zernio.com/?utm_source=cogsend&utm_medium=sponsorship&utm_campaign=cogsend-integration&utm_content=provider-guide) is an optional, paid publishing provider and a sponsor of CogSend. It holds approved developer apps for X, Threads, LinkedIn and Bluesky, so an account connected through it publishes without an app of your own: no LinkedIn app review, no Meta app, no X developer project or API credits. CogSend still writes, schedules, retries and records everything; Zernio only carries the publish.

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

## What works the same, and what differs

| Feature                  | Through Zernio                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Compose, schedule, queue | Unchanged. CogSend's scheduler publishes at the scheduled minute by asking Zernio to publish now.                                            |
| Threads                  | X, Threads and Bluesky threads publish as threads. LinkedIn gets one post with the segments joined, as with a direct connection.             |
| Images and video         | Sent to Zernio as URLs on your instance. Zernio compresses what a platform would reject.                                                     |
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
```

- [ ] **Step 2: One sentence in `docs/oauth-apps.md`**

Replace the first paragraph with:

```markdown
Mastodon and Bluesky connect with what you already have. LinkedIn, Threads and X
need an app registered at the provider first, because they issue the client id
and secret the Worker uses. If you would rather not register apps, the optional
[Zernio provider](zernio.md) publishes to those platforms through Zernio's own.
```

- [ ] **Step 3: `AGENTS.md`**

Change the second paragraph's "with their own provider credentials" to "with their own provider credentials (or, per account, through the optional Zernio provider in `src/lib/server/providers/zernio.ts`)".

- [ ] **Step 4: Prettier and commit the docs**

Run: `npm run format && npm run lint`

```bash
git add docs/zernio.md docs/oauth-apps.md AGENTS.md
git commit -m "docs(zernio): provider guide and pointers from the OAuth guide"
```

- [ ] **Step 5: README placements (own commit)**

Under the `<p align="center">` block with the badges, before the demo video line, add:

```markdown
> **Supported by [Zernio](https://zernio.com/?utm_source=cogsend&utm_medium=sponsorship&utm_campaign=cogsend-integration&utm_content=readme-sponsor).** An optional paid provider that publishes to X, Threads, LinkedIn and Bluesky through Zernio's approved apps, so you skip registering your own. CogSend still runs the editor, schedule and history on your Cloudflare account. [Connect through Zernio](docs/zernio.md), or keep using your own apps.
```

In Features, after the "Personal API key" line:

```markdown
- Optional [Zernio](docs/zernio.md) provider: X, Threads, LinkedIn and Bluesky without a developer app of your own
```

In the Documentation table, after the OAuth apps row:

```markdown
| [Zernio](docs/zernio.md) | connecting through Zernio instead of registering your own apps, what differs, troubleshooting |
```

Run: `npm run format && npm run lint`

```bash
git add README.md
git commit -m "docs(readme): Zernio sponsorship note and provider links"
```

---

### Task 11: End-to-end pass against Zernio and the final gates

**Files:** none new. Uses a real Zernio team account key held outside the repo.

- [ ] **Step 1: Full local gates**

Run: `npm run lint && npm run check && npm test && npm run build`
Expected: all clean, `npm test` green with the new files.

- [ ] **Step 2: Live pass**

With `npm run dev` and a Zernio key from the team account (never committed, never in `.dev.vars`):

1. Import an X, a Threads, a LinkedIn and a Bluesky account. Each shows **via Zernio**.
2. Publish a text post to each. Posts shows **published** with a working permalink.
3. Publish a three-segment thread to X, Threads and Bluesky; one to LinkedIn (single post expected).
4. Deploy (or set `MEDIA_PUBLIC_BASE_URL`) and publish one image post with alt text to X.
5. Publish the same text again to the same account within 24 h: expect **failed** with Zernio's duplicate reason, not a retry loop.
6. **Check** on an imported row → active. Revoke the key in Zernio, **Check** again → expired with the key message. Import again with a new key → active.
7. **Connect a new account through Zernio** for Threads: authorize, land back on `/accounts?connected=threads`, row present.
8. Disconnect a Zernio row: scheduled targets removed, Zernio account untouched.

Record what was run and the outcome (post URLs may be redacted) in the PR description's Validation section.

- [ ] **Step 3: Docs check per AGENTS.md**

Re-read `README.md`, `docs/development.md`, `docs/api.md` and `AGENTS.md` against the change: `docs/api.md` needs no change (the new routes are session-only and undocumented for keys, like the other connect routes).

- [ ] **Step 4: Push the branch and open the PR against `deepakness/cogsend:main`**

Title: `feat(accounts): optional Zernio provider for X, Threads, LinkedIn and Bluesky`

Body (short, per the repo's PR template): why, what (bullets), validation (the live pass), follow-ups (affiliate URL swap in `zernio-links.ts` once the maintainer's link exists; the maintainer rewrites README copy).
