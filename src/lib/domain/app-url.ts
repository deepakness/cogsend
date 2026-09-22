/**
 * Is this instance running on a local address?
 *
 * Used as the single "local instance" signal for local-only affordances:
 * tolerating example secrets, skipping 2FA when SKIP_TOTP is set, and allowing
 * OAuth/SSRF targets on localhost or private hosts.
 *
 * A build flag is deliberately NOT used for this: `wrangler dev` serves a
 * production build locally, so `import.meta.env.PROD` is true on a developer's
 * machine. The resolved URL is what actually distinguishes a local instance
 * from a deployed one.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

export function isLocalAppUrl(url: string | undefined | null): boolean {
	try {
		return LOCAL_HOSTS.has(new URL(String(url)).hostname);
	} catch {
		return false;
	}
}

/** Hosts that can only be reached from the machine running the server. */
const PRIVATE_HOST =
	/^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

export function isLocalRequestHost(host: string | undefined | null): boolean {
	let h = String(host ?? '')
		.toLowerCase()
		.trim();
	if (!h) return false;
	// Accept a `host:port` form. Bracketed IPv6 keeps its brackets; a bare IPv6
	// literal has several colons and must not be sliced.
	if (h.startsWith('[')) {
		const end = h.indexOf(']');
		if (end !== -1) h = h.slice(0, end + 1);
	} else {
		const parts = h.split(':');
		if (parts.length === 2) h = parts[0];
	}
	if (LOCAL_HOSTS.has(h) || h.endsWith('.localhost')) return true;
	// A dev server reached from a phone or another machine on the same network.
	return PRIVATE_HOST.test(h);
}

/**
 * Requests `scripts/wrap-worker.mjs` makes to itself (the `scheduled` and
 * `queue` handlers) carry this host. It is not a public origin and must never
 * be adopted as the instance's URL.
 */
export const INTERNAL_REQUEST_HOST = 'cogsend.internal';

/** The origin of a URL string, or null when it does not parse. */
export function requestOrigin(url: string | undefined | null): string | null {
	try {
		return new URL(String(url)).origin;
	} catch {
		return null;
	}
}

/** A configured APP_URL the deployment is pinned to, as opposed to a leftover
 *  localhost value or nothing at all. */
export function isPinnedAppUrl(value: string | undefined | null): boolean {
	const origin = requestOrigin(String(value ?? '').trim());
	return origin !== null && !isLocalAppUrl(origin);
}

export type AppUrlSource = 'configured' | 'request' | 'stored' | 'none';

export interface ResolvedAppUrl {
	url: string;
	source: AppUrlSource;
}

/**
 * Where the instance's public URL comes from.
 *
 * A pinned APP_URL always wins: a self-hoster who set a custom domain, or put
 * the Worker behind something else, gets exactly that value. Otherwise the
 * origin of the request being served is adopted — that is what makes "deploy,
 * then open it" work with no second deploy, because the URL does not exist
 * until the Worker does.
 *
 * `stored` is what a scheduled or queue invocation has instead of a request:
 * the origin recorded from the first authenticated visit (see app-settings.ts).
 * It is the last resort, and the only source that can be empty — in which case
 * context-free callers degrade (relative links) instead of crashing.
 */
export function resolveAppUrl(input: {
	configured?: string | null;
	requestUrl?: string | null;
	stored?: string | null;
}): ResolvedAppUrl {
	// 1. A pinned APP_URL — a custom domain, or any deliberate public origin.
	const configuredOrigin = requestOrigin(normalize(input.configured));
	if (configuredOrigin && !isLocalAppUrl(configuredOrigin)) {
		return { url: configuredOrigin, source: 'configured' };
	}

	const requested = requestOrigins(input.requestUrl);
	// 2. The public host this visitor actually reached.
	if (requested.public) return { url: requested.public, source: 'request' };
	// 3. An explicit localhost value, for local development.
	if (configuredOrigin) return { url: configuredOrigin, source: 'configured' };
	// 4. A loopback request of our own, with nothing configured.
	if (requested.loopback) return { url: requested.loopback, source: 'request' };

	// 5. No request to learn from — a scheduled or queue invocation: the origin
	// recorded by the first authenticated visit is all there is. It may be local
	// (a dev machine) or public (a deployment), which is why it is last.
	const storedOrigin = requestOrigin(normalize(input.stored));
	if (storedOrigin) return { url: storedOrigin, source: 'stored' };
	// 6. Nothing is known yet: no absolute links, rather than an invented origin.
	return { url: '', source: 'none' };
}

function normalize(value: string | undefined | null): string {
	return String(value ?? '')
		.trim()
		.replace(/\/+$/, '');
}

/**
 * What a request can contribute. `public` is a host a visitor reached and the
 * instance may claim as its own; `loopback` is the machine a dev server runs on.
 *
 * The wrapper's internal host contributes nothing (nobody can visit it), and
 * neither does a private LAN address: a dev server opened from a phone keeps its
 * configured URL, and a public deployment cannot be reached on a private address
 * at all — treating one as local would let a spoofed Host header switch off the
 * guards that keep example secrets out of a deployment.
 */
function requestOrigins(url: string | undefined | null): {
	public: string | null;
	loopback: string | null;
} {
	const origin = requestOrigin(url);
	if (!origin) return { public: null, loopback: null };
	const { hostname } = new URL(origin);
	if (hostname === INTERNAL_REQUEST_HOST) return { public: null, loopback: null };
	if (isLocalAppUrl(origin)) return { public: null, loopback: origin };
	if (isLocalRequestHost(hostname)) return { public: null, loopback: null };
	return { public: origin, loopback: null };
}
