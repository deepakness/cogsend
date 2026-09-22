import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `npm run secrets:put` is the documented way to move `.dev.vars` into Worker
 * secrets, and it used to read that file differently from `setup`: it took
 * everything after the first `=`, so `KEY="abc" # note` uploaded the comment
 * too. The value cannot be read back from Cloudflare, and a wrong
 * APP_ENCRYPTION_KEY orphans every stored credential — so what this script
 * uploads is asserted here, by running it with a recording `node` on PATH.
 */
describe('npm run secrets:put', () => {
	let dir: string | null = null;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = null;
	});

	/** Run the real script in a scratch checkout with a fake `node` that records
	 *  the key it was asked to put and the value it received on stdin. */
	function run(devVars: string, args: string[] = []) {
		const created = mkdtempSync(join(tmpdir(), 'cogsend-secrets-'));
		dir = created;
		writeFileSync(join(created, '.dev.vars'), devVars);
		const bin = join(created, 'bin');
		mkdirSync(bin);
		writeFileSync(
			join(bin, 'node'),
			// Absolute shebang: `env node` would find this same file on PATH and
			// re-run it until the argument list overflows.
			`#!${process.execPath}
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
	appendFileSync(${JSON.stringify(join(created, 'calls.log'))}, JSON.stringify({ args, input }) + '\\n');
	process.exit(0);
});
process.stdin.resume();
`
		);
		chmodSync(join(bin, 'node'), 0o755);
		// The real interpreter runs the script; only the script's own `node`
		// lookups (the ones that would call wrangler) see the fake.
		const result = spawnSync(
			process.execPath,
			[join(process.cwd(), 'scripts/put-secrets.mjs'), ...args],
			{
				cwd: created,
				encoding: 'utf8',
				env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }
			}
		);
		const log = join(created, 'calls.log');
		const calls = existsSync(log)
			? readFileSync(log, 'utf8')
					.trim()
					.split('\n')
					.filter(Boolean)
					.map((line) => JSON.parse(line) as { args: string[]; input: string })
			: [];
		return { result, calls };
	}

	it('uploads the parsed value, not the raw line', () => {
		const { result, calls } = run(
			[
				'APP_ENCRYPTION_KEY="abc123" # rotate after the migration',
				"API_TOKEN='tok_value'",
				'NOTIFY_EMAIL=me@example.com'
			].join('\n')
		);
		expect(result.status).toBe(0);
		const byKey = new Map(calls.map((c) => [c.args.at(-1), c.input]));
		expect(byKey.get('APP_ENCRYPTION_KEY')).toBe('abc123');
		expect(byKey.get('API_TOKEN')).toBe('tok_value');
		expect(byKey.get('NOTIFY_EMAIL')).toBe('me@example.com');
	});

	it('refuses an example value instead of shipping it', () => {
		const { result, calls } = run(
			[
				'APP_ENCRYPTION_KEY=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
				'API_TOKEN=real-token'
			].join('\n')
		);
		expect(result.status).toBe(0);
		expect(result.stderr).toContain('skip APP_ENCRYPTION_KEY: still an example value');
		expect(calls.map((c) => c.args.at(-1))).toEqual(['API_TOKEN']);
	});

	it('uploads the optional secrets the app reads, including the Resend trio', () => {
		const { calls } = run(
			[
				'RESEND_API_KEY=re_123',
				'NOTIFY_EMAIL=alerts@example.com',
				'NOTIFY_FROM=CogSend <sent@example.com>',
				'ENABLE_VIDEO_UPLOAD=1'
			].join('\n')
		);
		expect(calls.map((c) => c.args.at(-1))).toEqual([
			'RESEND_API_KEY',
			'NOTIFY_EMAIL',
			'NOTIFY_FROM',
			'ENABLE_VIDEO_UPLOAD'
		]);
	});

	it('skips a localhost APP_URL and a missing SKIP_TOTP', () => {
		const { result, calls } = run(
			['APP_URL=http://localhost:5173', 'SKIP_TOTP=1', 'API_TOKEN=real'].join('\n')
		);
		expect(result.stderr).toContain('skip APP_URL: local .dev.vars points at localhost');
		// SKIP_TOTP is a local flag: it is not in the upload list at all.
		expect(calls.map((c) => c.args.at(-1))).toEqual(['API_TOKEN']);
	});
});
