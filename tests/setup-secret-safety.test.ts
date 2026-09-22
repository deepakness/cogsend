import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readWorkerSecrets } from '../scripts/lib/worker-secrets.mjs';

/**
 * `npm run setup` decides whether APP_ENCRYPTION_KEY is uploaded again, and
 * uploading a new one orphans every stored provider credential. It used to ask
 * `wrangler secret list --json`, which wrangler 4.x rejects outright ("Unknown
 * argument: json") — and a failed read was treated as "no secrets are set", so a
 * re-run would have quietly rotated the key the README promises it leaves alone.
 *
 * The first block pins the reader, the second runs the real script in a scratch
 * checkout with a recording `npx` on PATH, which is the only way to see what it
 * would actually upload.
 */
describe('reading the Worker secret list', () => {
	it('takes the list from the bare command', () => {
		const seen: string[][] = [];
		const result = readWorkerSecrets({
			run: (args) => {
				seen.push(args);
				return { status: 0, stdout: JSON.stringify([{ name: 'APP_ENCRYPTION_KEY' }]) };
			}
		});
		expect(result).toEqual({ ok: true, names: ['APP_ENCRYPTION_KEY'] });
		// One call: the modern spelling works, so the fallbacks never run.
		expect(seen).toEqual([['secret', 'list']]);
	});

	it('falls back to --format json and then to the legacy --json', () => {
		const refused = { status: 1, stderr: 'Unknown argument: json' };
		const legacy = readWorkerSecrets({
			run: (args) =>
				args.includes('--json')
					? { status: 0, stdout: JSON.stringify([{ name: 'API_TOKEN' }]) }
					: refused
		});
		expect(legacy).toEqual({ ok: true, names: ['API_TOKEN'] });

		const modern = readWorkerSecrets({
			run: (args) =>
				args.includes('--format')
					? { status: 0, stdout: JSON.stringify([{ name: 'APP_URL' }]) }
					: refused
		});
		expect(modern).toEqual({ ok: true, names: ['APP_URL'] });
	});

	it('reports a Worker that does not exist yet as "no secrets", not as a failure', () => {
		const result = readWorkerSecrets({
			run: () => ({
				status: 1,
				stderr:
					'ERROR Worker "cogsend" not found.\n\n  If this is a new Worker, run `wrangler deploy` first to create it.'
			})
		});
		expect(result.ok).toBe(true);
		expect(result.missingWorker).toBe(true);
		expect(result.names).toEqual([]);
	});

	it('refuses to guess when the list cannot be read', () => {
		const result = readWorkerSecrets({
			run: () => ({ status: 1, stderr: 'ERROR could not reach the Cloudflare API' })
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toContain('could not reach the Cloudflare API');
	});
});

describe('npm run setup, with a secret list it cannot read', () => {
	let dir: string | null = null;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = null;
	});

	/**
	 * A scratch checkout: setup resolves its root from its own path and chdirs
	 * there, so copying `scripts/` and the config next to a fake `npx` is enough
	 * to run the real thing without touching this repository.
	 */
	function scratch(npxBody: string) {
		const created = mkdtempSync(join(tmpdir(), 'cogsend-setup-'));
		dir = created;
		cpSync(join(process.cwd(), 'scripts'), join(created, 'scripts'), { recursive: true });
		cpSync(join(process.cwd(), 'wrangler.jsonc'), join(created, 'wrangler.jsonc'));
		writeFileSync(
			join(created, 'package.json'),
			'{\n\t"name": "cogsend",\n\t"version": "0.0.0"\n}\n'
		);
		writeFileSync(
			join(created, '.dev.vars'),
			'APP_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n'
		);
		const bin = join(created, 'bin');
		mkdirSync(bin);
		writeFileSync(
			join(bin, 'npx'),
			`#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(created, 'calls.log'))}, JSON.stringify(args) + '\\n');
${npxBody}
`
		);
		chmodSync(join(bin, 'npx'), 0o755);
		return { root: created, bin };
	}

	function runSetup(root: string, bin: string, args: string[] = []) {
		return spawnSync(process.execPath, [join(root, 'scripts/setup.mjs'), '--yes', ...args], {
			cwd: root,
			encoding: 'utf8',
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }
		});
	}

	const calls = (root: string) =>
		readFileSync(join(root, 'calls.log'), 'utf8')
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as string[]);

	const ACCOUNT_JSON = JSON.stringify({
		loggedIn: true,
		email: 'me@example.com',
		accounts: [{ name: 'Acme' }]
	});

	it('stops instead of uploading a new key', () => {
		const { root, bin } = scratch(`
if (args.includes('whoami')) { console.log(${JSON.stringify(ACCOUNT_JSON)}); process.exit(0); }
if (args.includes('d1') && args.includes('list')) { console.log(JSON.stringify([{ name: 'cogsend', uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }])); process.exit(0); }
if (args.includes('secret') && args.includes('list')) { console.error('ERROR could not reach the Cloudflare API'); process.exit(1); }
process.exit(0);
`);
		const result = runSetup(root, bin);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('could not read the Worker secret list');
		// The decisive part: no key was ever written.
		const puts = calls(root).filter((args) => args.includes('secret') && args.includes('put'));
		expect(puts).toEqual([]);
	});

	it('leaves an existing key alone on a re-run', () => {
		const { root, bin } = scratch(`
if (args.includes('whoami')) { console.log(${JSON.stringify(ACCOUNT_JSON)}); process.exit(0); }
if (args.includes('secret') && args.includes('list')) { console.log(JSON.stringify([{ name: 'APP_ENCRYPTION_KEY' }])); process.exit(0); }
if (args.includes('d1') && args.includes('list')) { console.log(JSON.stringify([{ name: 'cogsend', uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }])); process.exit(0); }
if (args.includes('d1') && args.includes('execute')) { console.log(JSON.stringify([{ results: [{ email: 'me@example.com' }], success: true, meta: {} }])); process.exit(0); }
process.exit(0);
`);
		const result = runSetup(root, bin, ['--skip-deploy']);
		const puts = calls(root).filter((args) => args.includes('secret') && args.includes('put'));
		expect(puts.map((args) => args[args.indexOf('put') + 1])).toEqual([]);
		expect(result.stdout).toContain('APP_ENCRYPTION_KEY is already set on the Worker — left alone');
	});

	it('records the database id and name even when the database already exists', () => {
		const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
		const { root, bin } = scratch(`
if (args.includes('whoami')) { console.log(${JSON.stringify(ACCOUNT_JSON)}); process.exit(0); }
if (args.includes('secret') && args.includes('list')) { console.log(JSON.stringify([{ name: 'APP_ENCRYPTION_KEY' }])); process.exit(0); }
if (args.includes('d1') && args.includes('list')) { console.log(JSON.stringify([{ name: 'cogsend-demo', uuid: '${uuid}' }])); process.exit(0); }
if (args.includes('d1') && args.includes('execute')) { console.log(JSON.stringify([{ results: [{ email: 'me@example.com' }], success: true, meta: {} }])); process.exit(0); }
process.exit(0);
`);
		runSetup(root, bin, ['--skip-deploy', '--db', 'cogsend-demo']);
		const config = readFileSync(join(root, 'wrangler.personal.jsonc'), 'utf8');
		// Both, and they agree: the id binds the database, the name is what every
		// command's output shows.
		expect(config).toContain(`"database_name": "cogsend-demo"`);
		expect(config).toContain(`"database_id": "${uuid}"`);
	});
});
