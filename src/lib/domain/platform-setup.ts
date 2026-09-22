import { platformName } from '$lib/domain/platforms';

/**
 * The three platforms whose client credentials belong to whoever runs the
 * deployment: LinkedIn issues them to an app owner, Meta to a Threads app, X to
 * a developer project. Only that person can create them, so a deployment
 * without them cannot connect the account at all.
 *
 * Mastodon is absent on purpose — it registers its app on the instance itself —
 * and Bluesky takes an app password, so both are self-serve.
 */
export type OAuthPlatformId = 'linkedin' | 'threads' | 'x';

export type PlatformSetup = {
	/** Worker secrets the connect route requires: it answers "not enabled"
	 * while any of them is missing. */
	secrets: readonly string[];
	/** Secrets the route reads only when present, with a working fallback. */
	optionalSecrets?: readonly string[];
	/** Callback path to register with the provider; the origin is the deployment's. */
	callbackPath: string;
	/** What the provider charges or requires beyond setup. */
	note?: string;
};

export const PLATFORM_SETUP: Record<OAuthPlatformId, PlatformSetup> = {
	linkedin: {
		secrets: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
		callbackPath: '/api/connections/linkedin/callback'
	},
	threads: {
		secrets: ['THREADS_APP_ID', 'THREADS_APP_SECRET'],
		callbackPath: '/api/connections/threads/callback'
	},
	x: {
		// PKCE alone completes the exchange, so the secret is read (as HTTP
		// Basic auth) only for a confidential "Web App" client.
		secrets: ['X_CLIENT_ID'],
		optionalSecrets: ['X_CLIENT_SECRET'],
		callbackPath: '/api/connections/x/callback',
		note: 'Posting uses pay-per-use API credits.'
	}
};

export type PlatformConfigured = Record<OAuthPlatformId, boolean>;

/** Setup guide for the three platforms above, in the repository's docs. */
export const SETUP_GUIDE_URL =
	'https://github.com/deepakness/cogsend/blob/main/docs/oauth-apps.md#oauth-app-setup';

export function isOAuthPlatform(id: string): id is OAuthPlatformId {
	return Object.hasOwn(PLATFORM_SETUP, id);
}

export function setupFor(id: string): PlatformSetup | null {
	return isOAuthPlatform(id) ? PLATFORM_SETUP[id] : null;
}

/**
 * True when the platform exists but this deployment cannot connect it yet.
 * `configured` reports presence, not validity: a wrong id still counts as
 * configured, and the provider rejects it during the connect attempt.
 */
export function needsSetup(id: string, configured: PlatformConfigured): boolean {
	return isOAuthPlatform(id) && !configured[id];
}

export function secretsPutCommand(id: OAuthPlatformId): string {
	const { secrets, optionalSecrets = [] } = PLATFORM_SETUP[id];
	return `npm run secrets:put ${[...secrets, ...optionalSecrets].join(' ')}`;
}

/** Must equal what the connect route sends the provider, so it takes the
 * deployment's APP_URL rather than the browser's current origin. */
export function callbackUri(id: OAuthPlatformId, appUrl: string): string {
	return `${appUrl.replace(/\/+$/, '')}${PLATFORM_SETUP[id].callbackPath}`;
}

/**
 * Self-serve platforms first, then the ones that may need server setup — the
 * order the accounts empty state lists them in.
 */
const CONNECT_ORDER = ['bluesky', 'mastodon', 'linkedin', 'threads', 'x'] as const;

/** "Bluesky", "Bluesky or Mastodon", "Bluesky, Mastodon, or LinkedIn". */
export function joinPlatformNames(names: readonly string[]): string {
	if (names.length <= 1) return names[0] ?? '';
	if (names.length === 2) return `${names[0]} or ${names[1]}`;
	return `${names.slice(0, -1).join(', ')}, or ${names[names.length - 1]}`;
}

export function connectableNames(configured: PlatformConfigured): string[] {
	return CONNECT_ORDER.filter((id) => !needsSetup(id, configured)).map((id) => platformName(id));
}

/** Promises only what the visitor can actually do from here. */
export function emptyStateSentence(configured: PlatformConfigured): string {
	const names = connectableNames(configured);
	if (!names.length) return 'No accounts yet.';
	return `No accounts yet. Connect ${joinPlatformNames(names)} to start posting.`;
}
