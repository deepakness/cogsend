import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	PLATFORM_SETUP,
	SETUP_GUIDE_URL,
	callbackUri,
	connectableNames,
	emptyStateSentence,
	isOAuthPlatform,
	joinPlatformNames,
	needsSetup,
	secretsPutCommand,
	setupFor,
	type PlatformConfigured
} from '$lib/domain/platform-setup';

/**
 * The accounts dialog shows a "Needs setup" chip and setup steps for the
 * platforms this deployment has no app credentials for. Everything it claims
 * there — which secrets, which redirect URI — is data in this module, so it is
 * checked here; the connect routes are checked against the same data in
 * tests/connections-connect.test.ts.
 */
const all: PlatformConfigured = { linkedin: true, threads: true, x: true };
const none: PlatformConfigured = { linkedin: false, threads: false, x: false };

describe('platform setup data', () => {
	it('knows the three platforms that need an app, and only those', () => {
		for (const id of ['linkedin', 'threads', 'x']) expect(isOAuthPlatform(id)).toBe(true);
		// Mastodon registers its app per instance and Bluesky takes an app
		// password: neither can be blocked on missing credentials.
		for (const id of ['mastodon', 'bluesky', 'instagram', '']) {
			expect(isOAuthPlatform(id)).toBe(false);
			expect(setupFor(id)).toBeNull();
			expect(needsSetup(id, none)).toBe(false);
		}
		expect(Object.keys(PLATFORM_SETUP)).toEqual(['linkedin', 'threads', 'x']);
	});

	it('only asks for a platform when the deployment lacks it', () => {
		for (const id of ['linkedin', 'threads', 'x'] as const) {
			expect(needsSetup(id, all)).toBe(false);
			expect(needsSetup(id, none)).toBe(true);
			expect(needsSetup(id, { ...all, [id]: false })).toBe(true);
		}
	});

	it('points every redirect URI at a callback route that exists', () => {
		for (const id of ['linkedin', 'threads', 'x'] as const) {
			const uri = callbackUri(id, 'https://social.example');
			expect(uri.startsWith('https://social.example/api/connections/')).toBe(true);
			const path = new URL(uri).pathname;
			expect(existsSync(`src/routes${path}/+server.ts`)).toBe(true);
		}
		// A trailing slash (or two) must not produce a doubled slash, because the
		// provider compares the registered URI character by character.
		for (const appUrl of ['https://social.example', 'https://social.example/', 'https://a.b//']) {
			expect(callbackUri('x', appUrl)).toBe(
				`${appUrl.replace(/\/+$/, '')}/api/connections/x/callback`
			);
		}
	});

	it('documents the steps it points at, in the repository', () => {
		const anchor = SETUP_GUIDE_URL.split('#')[1];
		expect(anchor).toBeTruthy();
		expect(SETUP_GUIDE_URL).toContain('/blob/main/docs/oauth-apps.md');
		const doc = readFileSync('docs/oauth-apps.md', 'utf8');
		const heading = doc
			.split('\n')
			.filter((line) => line.startsWith('#'))
			.map((line) =>
				line
					.replace(/^#+\s*/, '')
					.toLowerCase()
					.replace(/[^a-z0-9 -]/g, '')
					.replace(/ /g, '-')
			)
			.includes(anchor);
		expect(heading).toBe(true);
	});

	it('spells out one paste-ready command per platform', () => {
		expect(secretsPutCommand('linkedin')).toBe(
			'npm run secrets:put LINKEDIN_CLIENT_ID LINKEDIN_CLIENT_SECRET'
		);
		expect(secretsPutCommand('threads')).toBe(
			'npm run secrets:put THREADS_APP_ID THREADS_APP_SECRET'
		);
		// X reads its secret when present, so the command offers it even though
		// `secrets:put` skips a name with no local value.
		expect(secretsPutCommand('x')).toBe('npm run secrets:put X_CLIENT_ID X_CLIENT_SECRET');
		expect(PLATFORM_SETUP.x.optionalSecrets).toEqual(['X_CLIENT_SECRET']);
		// Nothing optional anywhere else: those secrets are required.
		expect(PLATFORM_SETUP.linkedin.optionalSecrets).toBeUndefined();
		expect(PLATFORM_SETUP.threads.optionalSecrets).toBeUndefined();
	});
});

describe('empty-state sentence', () => {
	it('lists only the platforms that can be connected', () => {
		expect(emptyStateSentence(all)).toBe(
			'No accounts yet. Connect Bluesky, Mastodon, LinkedIn, Threads, or X to start posting.'
		);
		// The case behind the change: no app credentials anywhere, so naming
		// LinkedIn, Threads or X would offer something this deployment cannot do.
		expect(emptyStateSentence(none)).toBe(
			'No accounts yet. Connect Bluesky or Mastodon to start posting.'
		);
		expect(emptyStateSentence({ ...none, linkedin: true })).toBe(
			'No accounts yet. Connect Bluesky, Mastodon, or LinkedIn to start posting.'
		);
		expect(connectableNames(none)).toEqual(['Bluesky', 'Mastodon']);
	});

	it('joins names the way the sentence reads', () => {
		expect(joinPlatformNames([])).toBe('');
		expect(joinPlatformNames(['Bluesky'])).toBe('Bluesky');
		expect(joinPlatformNames(['Bluesky', 'Mastodon'])).toBe('Bluesky or Mastodon');
		expect(joinPlatformNames(['Bluesky', 'Mastodon', 'X'])).toBe('Bluesky, Mastodon, or X');
	});
});
