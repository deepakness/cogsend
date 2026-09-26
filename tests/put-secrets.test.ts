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
 *
 * Two more answers it has to get right: a skip says which line it looked at,
 * because a value typed after the `=` on a commented example line is the
 * mistake `.dev.vars.example` invites; and an upload is confirmed against the
 * Worker's own secret list, because wrangler exiting 0 only says something
 * accepted the request.
 */
describe('npm run secrets:put', () => {
	let dir: string | null = null;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = null;
	});

	/**
	 * Run the real script in a scratch checkout with a fake `node` that records
	 * the key it was asked to put and the value it received on stdin.
	 *
	 * `secretList` is what the fake answers the script's verification pass with
	 * (`secret list`); the default leaves that unreadable, which must stay a
	 * warning rather than a failure.
	 */
	function run(
		devVars: string,
		args: string[] = [],
		{
			secretList = null,
			account = null,
			deployedTo = null
		}: { secretList?: string[] | null; account?: string | null; deployedTo?: string | null } = {}
	) {
		const created = mkdtempSync(join(tmpdir(), 'cogsend-secrets-'));
		dir = created;
		writeFileSync(join(created, '.dev.vars'), devVars);
		if (deployedTo) {
			writeFileSync(join(created, 'wrangler.jsonc'), JSON.stringify({ name: 'cogsend' }));
			mkdirSync(join(created, '.wrangler'));
			writeFileSync(
				join(created, '.wrangler', 'deployed-accounts.json'),
				JSON.stringify({ cogsend: { accountId: deployedTo } })
			);
		}
		const bin = join(created, 'bin');
		mkdirSync(bin);
		const listJson = secretList
			? JSON.stringify(secretList.map((name) => ({ name, type: 'secret_text' })))
			: null;
		writeFileSync(
			join(bin, 'node'),
			// Absolute shebang: `env node` would find this same file on PATH and
			// re-run it until the argument list overflows.
			`#!${process.execPath}
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
const list = ${JSON.stringify(listJson)};
const account = ${JSON.stringify(account)};
if (args.includes('list') && process.env.WRANGLER_LOG === 'debug') {
	if (account) process.stderr.write('GET https://api.cloudflare.com/client/v4/accounts/' + account + '/workers/scripts/cogsend/secrets\\n');
	process.exit(1);
}
if (args.includes('list')) {
	if (list) process.stdout.write(list);
	process.exit(0);
}
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
		// `secret list` calls are recorded too; only the puts say what was uploaded.
		const puts = calls.filter((call) => call.args[2] === 'put');
		return { result, calls, puts };
	}

	it('uploads the parsed value, not the raw line', () => {
		const { result, puts } = run(
			[
				'APP_ENCRYPTION_KEY="abc123" # rotate after the migration',
				"API_TOKEN='tok_value'",
				'NOTIFY_EMAIL=me@example.com'
			].join('\n')
		);
		expect(result.status).toBe(0);
		const byKey = new Map(puts.map((c) => [c.args.at(-1), c.input]));
		expect(byKey.get('APP_ENCRYPTION_KEY')).toBe('abc123');
		expect(byKey.get('API_TOKEN')).toBe('tok_value');
		expect(byKey.get('NOTIFY_EMAIL')).toBe('me@example.com');
	});

	it('refuses an example value instead of shipping it', () => {
		const { result, puts } = run(
			[
				'APP_ENCRYPTION_KEY=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
				'API_TOKEN=real-token'
			].join('\n')
		);
		expect(result.status).toBe(0);
		expect(result.stderr).toContain('skip APP_ENCRYPTION_KEY: still an example value');
		expect(puts.map((c) => c.args.at(-1))).toEqual(['API_TOKEN']);
	});

	it('uploads the optional secrets the app reads, including the Resend trio', () => {
		const { puts } = run(
			[
				'RESEND_API_KEY=re_123',
				'NOTIFY_EMAIL=alerts@example.com',
				'NOTIFY_FROM=CogSend <sent@example.com>',
				'ENABLE_VIDEO_UPLOAD=1'
			].join('\n')
		);
		expect(puts.map((c) => c.args.at(-1))).toEqual([
			'RESEND_API_KEY',
			'NOTIFY_EMAIL',
			'NOTIFY_FROM',
			'ENABLE_VIDEO_UPLOAD'
		]);
	});

	it('skips a localhost APP_URL and a missing SKIP_TOTP', () => {
		const { result, puts } = run(
			['APP_URL=http://localhost:5173', 'SKIP_TOTP=1', 'API_TOKEN=real'].join('\n')
		);
		expect(result.stderr).toContain('skip APP_URL: local .dev.vars points at localhost');
		// SKIP_TOTP is a local flag: it is not in the upload list at all.
		expect(puts.map((c) => c.args.at(-1))).toEqual(['API_TOKEN']);
	});

	it('names the commented line instead of saying the value is missing', () => {
		const { result, puts } = run('# LINKEDIN_CLIENT_ID=abc123\n', ['LINKEDIN_CLIENT_ID']);
		expect(result.stderr).toContain('.dev.vars:1 has it commented out — remove the leading "#"');
		expect(puts).toEqual([]);
		// A key named on the command line that uploaded nothing is a failure.
		expect(result.status).toBe(1);
	});

	it('separates an empty line from a key that is not in the file', () => {
		const { result } = run('LINKEDIN_CLIENT_ID=\n', ['LINKEDIN_CLIENT_ID', 'THREADS_APP_ID']);
		expect(result.stderr).toContain('.dev.vars:1 has no value after the "="');
		expect(result.stderr).toContain('not in .dev.vars — add a line: THREADS_APP_ID=<value>');
		expect(result.status).toBe(1);
	});

	it('reports the Worker list as the proof the upload landed', () => {
		const { result } = run('API_TOKEN=real-token', [], { secretList: ['API_TOKEN'] });
		expect(result.stdout).toContain('verified: 1 secret on the Worker');
		expect(result.status).toBe(0);
	});

	it('fails when the Worker list does not show the uploaded key', () => {
		const { result } = run('API_TOKEN=real-token', [], { secretList: [] });
		expect(result.stderr).toContain('still missing on the Worker: API_TOKEN');
		expect(result.status).toBe(1);
	});

	it('only warns when the Worker list cannot be read', () => {
		const { result } = run('API_TOKEN=real-token');
		expect(result.stderr).toContain('could not verify against the Worker');
		expect(result.stdout).toMatch(/uploaded 1 of \d+/);
		expect(result.status).toBe(0);
	});

	it('summarises what it uploaded and skipped', () => {
		const { result } = run('API_TOKEN=real-token\nNOTIFY_EMAIL=');
		expect(result.stdout).toMatch(/uploaded 1 of \d+, skipped \d+/);
		expect(result.status).toBe(0);
	});

	it('uploads from a file saved with CRLF line endings', () => {
		const { result, puts } = run('API_TOKEN=real-token\r\nLINKEDIN_CLIENT_ID=abc\r\n');
		expect(puts.map((c) => c.args.at(-1))).toEqual(['API_TOKEN', 'LINKEDIN_CLIENT_ID']);
		// The two keys in the file are read; the other defaults are still absent.
		expect(result.stderr).not.toContain('skip API_TOKEN');
		expect(result.stderr).not.toContain('skip LINKEDIN_CLIENT_ID');
	});

	it('names the keys a named run did not upload', () => {
		const { result } = run('LINKEDIN_CLIENT_ID=abc\n', [
			'LINKEDIN_CLIENT_ID',
			'LINKEDIN_CLIENT_SECRET'
		]);
		expect(result.stderr).toContain('not uploaded: LINKEDIN_CLIENT_SECRET');
		expect(result.status).toBe(1);
	});

	it('refuses to upload to another account than the one deployed to', () => {
		const { result, puts } = run('THREADS_APP_ID=123', ['THREADS_APP_ID'], {
			account: 'fedcba9876543210fedcba9876543210',
			deployedTo: '0123456789abcdef0123456789abcdef'
		});
		expect(result.stderr).toContain(
			'refusing: this checkout deployed cogsend to account 0123456789abcdef0123456789abcdef'
		);
		expect(result.stderr).toContain('nothing was uploaded');
		expect(puts).toEqual([]);
		expect(result.status).toBe(1);
	});

	it('names the account it uploads to', () => {
		const { result, puts } = run('THREADS_APP_ID=123', ['THREADS_APP_ID'], {
			account: '0123456789abcdef0123456789abcdef',
			deployedTo: '0123456789abcdef0123456789abcdef'
		});
		expect(result.stdout).toContain('target: cogsend on 0123456789abcdef0123456789abcdef');
		expect(puts.map((c) => c.args.at(-1))).toEqual(['THREADS_APP_ID']);
	});

	it('uploads a repeated key once, not once per mention', () => {
		const { result, puts } = run('API_TOKEN=real-token', ['API_TOKEN', 'API_TOKEN']);
		expect(puts).toHaveLength(1);
		expect(result.status).toBe(0);
	});
});
