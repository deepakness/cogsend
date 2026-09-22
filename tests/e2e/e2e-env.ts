import { existsSync, readFileSync } from 'node:fs';
import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Shared harness values for the e2e suite.
 *
 * The preview server (wrangler dev) reads `.dev.vars`, so the specs read the
 * same file for the values that live there (APP_ENCRYPTION_KEY, SKIP_TOTP). On a
 * fresh clone there is no `.dev.vars`: `npm run test:e2e` seeds one from
 * `tests/e2e/fixtures/dev.vars` (scripts/e2e-prepare.mjs) and this helper falls
 * back to that fixture, so the suite never depends on a particular machine.
 *
 * The login is not one of those values: the account is created in D1 before the
 * server starts, by `scripts/seed-local.mjs`, into the suite's own state
 * directory. `E2E_ACCOUNT` is what it writes.
 */
const FIXTURE = 'tests/e2e/fixtures/dev.vars';

function parse(raw: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of raw.split('\n')) {
		const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
		if (m) out[m[1]] = m[2];
	}
	return out;
}

export function e2eVars(): Record<string, string> {
	return parse(readFileSync(existsSync('.dev.vars') ? '.dev.vars' : FIXTURE, 'utf8'));
}

/**
 * Dedicated local D1/R2 state for tests. Using its own directory means a test
 * run never deletes the state a developer uses for `npm run dev`.
 * Keep in sync with playwright.config.ts, which passes the same value to
 * `wrangler dev --persist-to`.
 */
export const E2E_PERSIST_TO = '.wrangler/e2e-state';

/** The account `scripts/seed-local.mjs` puts into that database. Throwaway by
 *  design: it exists only inside `.wrangler/e2e-state`, which every run wipes. */
export const E2E_ACCOUNT = { email: 'e2e@localhost', password: 'e2e-password' };

/** Extra flags for every `wrangler d1 …` call inside a spec. */
export const E2E_D1_FLAGS = `--persist-to ${E2E_PERSIST_TO}`;

/**
 * Click a control and wait for what it opens, retrying the click.
 *
 * Svelte hydrates after the first paint, so a click that lands too early is
 * simply lost — no error, nothing happens — and the failure looks like a broken
 * feature on whichever machine was slowest. Every spec that clicks straight
 * after `goto` has this race; this is the shared answer to it.
 */
/**
 * Type into a field and make sure the value survives hydration.
 *
 * Pages arrive server-rendered and Svelte takes over afterwards; a `fill` that
 * lands in between is overwritten by the value it hydrates with, so the test
 * asserts against an empty composer — which is how "deleting an already-deleted
 * draft keeps the card hidden" failed in CI (no text, no autosave, no draft id
 * in the URL). Slow starts are what expose it: a cold `workerd`, a loaded
 * runner, a delayed bundle. Verified by delaying the client bundle by 5s and
 * filling immediately: the plain fill was gone afterwards, this one stuck.
 *
 * `window.__svelte` appears when Svelte's runtime starts, so wait for it rather
 * than guess with a timeout. Best effort — if a future Svelte stops setting it,
 * the loop below still catches a wipe, just later.
 */
export async function fillUntilKept(field: Locator, value: string) {
	const page = field.page();
	await page
		.waitForFunction(() => '__svelte' in window, undefined, { timeout: 5000 })
		.catch(() => {});
	for (let attempt = 0; attempt < 3; attempt++) {
		await field.fill(value);
		await page.waitForTimeout(150);
		if ((await field.inputValue()) === value) return;
	}
	await expect(field).toHaveValue(value);
}

export async function clickUntilVisible(page: Page, opener: Locator, target: Locator) {
	for (let attempt = 0; attempt < 5; attempt++) {
		await opener.click();
		try {
			await expect(target).toBeVisible({ timeout: 2_000 });
			return;
		} catch {
			// Not hydrated yet (or it closed again): click once more.
		}
	}
	await expect(target).toBeVisible();
}
