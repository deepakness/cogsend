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
