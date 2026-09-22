import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestAdmin, createTestDb, TEST_ADMIN, TEST_ENV } from '$lib/server/db/test';
import type { AppDb } from '$lib/server/db/client';
import { POST as login } from '../src/routes/api/auth/login/+server';

/**
 * The password gate is keyed on the single admin row, so it must only advance
 * for attempts against the real admin identity. Otherwise anyone could lock the
 * owner out of a self-hosted instance with eight guesses at a made-up address.
 */
function attempt(db: AppDb, email: string, password: string) {
	return login({
		request: new Request('http://localhost/api/auth/login', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ email, password })
		}),
		locals: { db, env: TEST_ENV },
		cookies: { set() {}, get: () => undefined, delete() {} },
		url: new URL('http://localhost/api/auth/login')
	} as never) as Promise<Response>;
}

describe('login gate', () => {
	let db: AppDb;
	let close: () => void;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		await createTestAdmin(db);
	});

	afterAll(() => close());

	it('does not let an unknown email lock the admin out', async () => {
		// Ten times, to pass the 8-failure threshold with room to spare.
		for (let i = 0; i < 10; i++) {
			const res = await attempt(db, 'nobody@example.com', 'whatever');
			expect(res.status).toBe(401);
			expect((await res.json()).error).toBe('Invalid credentials');
		}

		// The real credentials still work, i.e. the gate was never advanced.
		const ok = await attempt(db, TEST_ADMIN.email, TEST_ADMIN.password);
		expect(ok.status).toBe(200);
	});

	it('locks after eight wrong passwords for the real admin', async () => {
		for (let i = 0; i < 7; i++) {
			const res = await attempt(db, TEST_ADMIN.email, 'wrong-password');
			expect(res.status).toBe(401);
			expect((await res.json()).error).toBe('Invalid credentials');
		}

		const eighth = await attempt(db, TEST_ADMIN.email, 'wrong-password');
		expect((await eighth.json()).error).toMatch(/Too many attempts/);

		// Even the correct password is refused while the gate is closed.
		const blocked = await attempt(db, TEST_ADMIN.email, TEST_ADMIN.password);
		expect(blocked.status).toBe(401);
		expect((await blocked.json()).error).toMatch(/Too many attempts/);
	});
});
