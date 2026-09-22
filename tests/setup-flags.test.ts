import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * `npm run setup` runs the account write before it touches Cloudflare, so the
 * removed flag has to be refused at the top of the script — this test needs no
 * stub for `npx` and no network.
 */
describe('setup flags', () => {
	it('refuses the removed --strong-kdf flag', () => {
		const result = spawnSync('node', ['scripts/setup.mjs', '--strong-kdf'], { encoding: 'utf8' });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('--strong-kdf was removed');
	});
});
