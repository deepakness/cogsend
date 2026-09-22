import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET as linkPreviewGET } from '../src/routes/api/link-preview/+server';

/**
 * The one endpoint that makes the Worker fetch a URL the caller chose. The host
 * blocklist is unit-tested; this covers the route around it: the scope gate and
 * the shapes it accepts.
 */
function call(query: string, scopes: string[] | null) {
	return linkPreviewGET({
		url: new URL(`http://localhost/api/link-preview?${query}`),
		locals: {
			user: {
				id: 'u1',
				email: 'preview@localhost',
				timezone: 'UTC',
				totpEnabled: true,
				mfaVerified: true
			},
			apiKeyScopes: scopes
		}
	} as never) as Promise<Response>;
}

describe('GET /api/link-preview', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('refuses a read-scoped key', async () => {
		// Egress needs `write`: a leaked read key must not proxy requests.
		const res = await call('url=https://example.com', ['read']);
		expect(res.status).toBe(403);
	});

	it('requires a url', async () => {
		const res = await call('', ['write']);
		expect(res.status).toBe(400);
	});

	it('refuses a private or blocked host without fetching it', async () => {
		const fetched = vi.fn();
		vi.stubGlobal('fetch', fetched);
		for (const url of [
			'http://127.0.0.1/x',
			'http://169.254.169.254/latest/meta-data/',
			'http://x.internal/'
		]) {
			const res = await call(`url=${encodeURIComponent(url)}`, ['write']);
			expect(res.status).toBeGreaterThanOrEqual(400);
		}
		expect(fetched).not.toHaveBeenCalled();
	});

	it('returns parsed metadata for an allowed host', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						'<html><head><meta property="og:title" content="Hello there"><meta property="og:description" content="A page"></head></html>',
						{ status: 200, headers: { 'Content-Type': 'text/html' } }
					)
			)
		);
		const res = await call('url=example.com%2Fpost', ['write']);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { title?: string; description?: string; url?: string };
		expect(body.title).toBe('Hello there');
		expect(body.description).toBe('A page');
		// A bare paste is completed to https before fetching.
		expect(body.url ?? '').toContain('example.com');
	});
});
