import { describe, expect, it } from 'vitest';
import { POST as validatePOST } from '../src/routes/api/validate/+server';

/**
 * Five validators plus a grapheme scan run over `text` on every call, so the
 * body has to be bounded: this endpoint only needs a read-scoped key.
 */
describe('POST /api/validate limits', () => {
	const locals = {
		user: {
			id: 'u1',
			email: 'validate@localhost',
			timezone: 'UTC',
			totpEnabled: true,
			mfaVerified: true
		},
		apiKeyScopes: ['read']
	} as never;

	function call(body: string) {
		return validatePOST({
			request: new Request('http://localhost/api/validate', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body
			}),
			locals
		} as never) as Promise<Response>;
	}

	it('answers malformed JSON with 400', async () => {
		const res = await call('{"text":');
		expect(res.status).toBe(400);
	});

	it('refuses a body above the analysis cap', async () => {
		const res = await call(JSON.stringify({ text: 'x'.repeat(200_001) }));
		expect(res.status).toBe(413);
	});

	it('still analyses a normal body', async () => {
		const res = await call(JSON.stringify({ text: 'hello' }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { graphemes: number };
		expect(body.graphemes).toBe(5);
	});
});
