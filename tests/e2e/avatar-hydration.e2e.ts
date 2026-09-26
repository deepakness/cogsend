import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { E2E_ACCOUNT, E2E_D1_FLAGS } from './e2e-env';

/**
 * A cached avatar loads before the app's JavaScript does on a real network.
 * Svelte records that early load with an inline `onload`, which the CSP has to
 * admit; blocked, the image stays at opacity 0 over the initials until a hard
 * reload. Holding the bundles back reproduces that order on a local server.
 */
function d1(sql: string) {
	execSync(`node scripts/wrangler.mjs d1 execute DB --local ${E2E_D1_FLAGS} --command "${sql}"`, {
		stdio: 'pipe'
	});
}

test('a cached account avatar shows when the app hydrates late', async ({ page }) => {
	const violations: string[] = [];
	page.on('console', (msg) => {
		if (/content security policy/i.test(msg.text())) violations.push(msg.text());
	});

	await page.goto('/compose');
	if (/\/login$/.test(new URL(page.url()).pathname)) {
		await page.getByLabel('Email').fill(E2E_ACCOUNT.email);
		await page.getByLabel('Password').fill(E2E_ACCOUNT.password);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(/\/compose$/, { timeout: 20000 });
	}

	const me = await page.request.get('/api/auth/me').then((r) => r.json());
	const connId = randomUUID();
	const now = Date.now();
	const avatarUrl = `${new URL(page.url()).origin}/apple-touch-icon.png`;
	d1(
		`INSERT INTO connections (id, user_id, platform, handle, avatar_url, credentials_encrypted, meta_json, status, created_at, updated_at) VALUES ('${connId}', '${me.user.id}', 'bluesky', 'avatar-e2e.bsky.social', '${avatarUrl}', 'enc', '{}', 'active', ${now}, ${now})`
	);
	try {
		const avatar = page.locator('img[src$="/apple-touch-icon.png"]').first();
		await page.goto('/accounts');
		await expect(avatar).toHaveCSS('opacity', '1', { timeout: 15000 });

		// Hold the scripts (not the CSS: an unstyled page never loads a lazy
		// image) until the cached image is in, the order a real network gives.
		let gate: Promise<void> = Promise.resolve();
		let release = () => {};
		await page.route('**/_app/immutable/**/*.js', async (route) => {
			await gate;
			await route.continue();
		});
		for (let visit = 0; visit < 2; visit++) {
			gate = new Promise<void>((resolve) => (release = resolve));
			await page.goto('/accounts', { waitUntil: 'commit' });
			await page.waitForFunction(
				() =>
					(document.querySelector('img[src$="/apple-touch-icon.png"]') as HTMLImageElement | null)
						?.complete === true
			);
			release();
			await page.waitForLoadState('networkidle');
			await expect(avatar).toHaveCSS('opacity', '1', { timeout: 15000 });
		}
		expect(violations).toEqual([]);
	} finally {
		d1(`DELETE FROM connections WHERE id='${connId}'`);
	}
});
