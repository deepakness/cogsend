import { timingSafeEqual, utf8Bytes } from './bytes';

export function extractBearerToken(headers: { get(name: string): string | null }): string | null {
	const auth = headers.get('authorization');
	if (auth) {
		const match = /^Bearer\s+(\S+)/i.exec(auth.trim());
		if (match?.[1]) return match[1];
	}
	const alt = headers.get('x-cogsend-token') || headers.get('x-cogsend-scheduler');
	const token = alt?.trim();
	return token ? token : null;
}

export function secretMatches(
	provided: string | null | undefined,
	expected: string | null | undefined
): boolean {
	if (!provided || !expected) return false;
	const a = utf8Bytes(provided);
	const b = utf8Bytes(expected);
	if (a.length !== b.length) {
		timingSafeEqual(b, b);
		return false;
	}
	return timingSafeEqual(a, b);
}

export function anySecretMatches(
	provided: string | null | undefined,
	secrets: Array<string | null | undefined>
): boolean {
	let matched = false;
	for (const secret of secrets) {
		if (secretMatches(provided, secret)) matched = true;
	}
	return matched;
}

export function isInternalApiPath(path: string): boolean {
	return path === '/api/internal/tick' || path === '/api/internal/publish';
}

/**
 * CSRF guard for cookie-session mutations. Same-origin fetch sends Origin
 * (and usually Referer); non-browser API clients send neither. The rule is
 * strict about what a caller asserts: an `Origin` that is present must match
 * this request's origin, full stop, and only its absence falls back to
 * `Referer`. Falling through to `Referer` after a mismatched `Origin` — which
 * is what this used to do — let `Origin: evil` pass whenever a matching
 * `Referer` came with it, the opposite of what the header is for. Absent
 * origin headers (curl, GH Actions) are allowed through to auth.
 */
export function hasAllowedMutationOrigin(
	request: { headers: { get(name: string): string | null } },
	url: URL
): boolean {
	const origin = request.headers.get('origin')?.trim();
	const referer = request.headers.get('referer')?.trim();
	if (!origin && !referer) return true;
	try {
		if (origin) return new URL(origin).origin === url.origin;
		return new URL(referer as string).origin === url.origin;
	} catch {
		// An origin that will not parse is not a match, and is not a reason to
		// look at the next header either.
		return false;
	}
}
