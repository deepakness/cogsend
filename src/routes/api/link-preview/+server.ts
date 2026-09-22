import type { RequestHandler } from './$types';
import { extractFirstUrl } from '$lib/domain/links';
import { handleError, ok, fail } from '$lib/server/http';
import { fetchOpenGraph } from '$lib/server/opengraph';
import { providerFetch } from '$lib/server/providers/timed-fetch';
import { requireScope, requireUser } from '$lib/server/require';

/**
 * GET /api/link-preview?url=… → { url, title, description, image, siteName }
 *
 * Composer preview for the standard link-card flow: first URL per segment,
 * suppressed client-side when that segment has media. Publish re-fetches the
 * same OG server-side (Bluesky external, LinkedIn article); Mastodon/Threads
 * unfurl server-side and need no payload.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	try {
		requireUser(locals.user);
		// `write`, not `read`: this is the one endpoint that makes the server
		// fetch a caller-supplied URL. Host validation, redirect re-checking and
		// size caps bound it, but a least-privileged key should not be able to
		// use the Worker as an egress proxy.
		requireScope(locals, 'write');
		const raw = (url.searchParams.get('url') || '').trim();
		if (!raw) return fail('url required');
		// Accept bare pastes (`example.com/x`) as well as full URLs.
		const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
		const first = extractFirstUrl(candidate) ?? candidate;
		if (first.length > 2048) return fail('url too long');
		const og = await fetchOpenGraph(first, providerFetch);
		return ok(og);
	} catch (err) {
		return handleError(err);
	}
};
