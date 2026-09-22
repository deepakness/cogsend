import { expect, test } from '@playwright/test';
import { E2E_ACCOUNT } from './e2e-env';

test.beforeEach(async ({ page }) => {
	await page.goto('/compose');
	if (/\/login$/.test(new URL(page.url()).pathname)) {
		await page.getByLabel('Email').fill(E2E_ACCOUNT.email);
		await page.getByLabel('Password').fill(E2E_ACCOUNT.password);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page).toHaveURL(/\/compose$/, { timeout: 20000 });
	}
});

test('typing keeps focus when first autosave assigns the draft id', async ({ page }) => {
	await page.goto('/compose');
	expect(new URL(page.url()).searchParams.get('id')).toBeNull();
	const box = page.getByTestId('segment-input-0');
	await box.click();
	await box.pressSequentially('hello focus probe', { delay: 20 });
	// First autosave (~1.4s debounce) creates the draft and sets ?id=.
	await expect
		.poll(() => new URL(page.url()).searchParams.get('id'), { timeout: 30000 })
		.toBeTruthy();
	// The reported bug: URL change stole focus and forced a second click.
	await expect(box).toBeFocused();
	await expect(box).toHaveValue('hello focus probe');
});

test('typing during a slow draft load is kept and saved', async ({ page }) => {
	// Save a draft with known content first.
	await page.goto('/compose');
	const box = page.getByTestId('segment-input-0');
	await box.click();
	await box.pressSequentially('saved content', { delay: 10 });
	await expect
		.poll(() => new URL(page.url()).searchParams.get('id'), { timeout: 30000 })
		.toBeTruthy();
	const id = new URL(page.url()).searchParams.get('id')!;
	await expect
		.poll(
			async () => {
				const res = await page.request.get(`/api/drafts/${id}`);
				const body = await res.json();
				return body.draft?.baseBody;
			},
			{ timeout: 30000 }
		)
		.toBe('saved content');

	// Re-open it with a deliberately slow load and type while it is in flight.
	// The stored copy must not replace those keystrokes (and the autosave must
	// not strand them in a second draft).
	await page.route(`**/api/drafts/${id}`, async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 2000));
		await route.continue();
	});
	await page.goto('/posts');
	await page.goto(`/compose?id=${id}`);
	const box2 = page.getByTestId('segment-input-0');
	await box2.click();
	await box2.pressSequentially('typed while loading', { delay: 10 });
	await page.waitForTimeout(3000);
	await expect(box2).toHaveValue('typed while loading');
	await page.unroute(`**/api/drafts/${id}`);
	await expect
		.poll(
			async () => {
				const res = await page.request.get(`/api/drafts/${id}`);
				const body = await res.json();
				return body.draft?.baseBody;
			},
			{ timeout: 30000 }
		)
		.toBe('typed while loading');
});
