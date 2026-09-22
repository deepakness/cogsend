import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
	NO_CRON_CONFIG_NAME,
	configArg,
	cronCount,
	cronFallbackWarning,
	cronStateValue,
	isCronQuotaError,
	parseJsonc,
	withoutConfigArg,
	withoutCronTriggers
} from '../scripts/lib/wrangler-config.mjs';

/** The real error, as Cloudflare returns it (the account id is redacted). */
const QUOTA_ERROR = `✘ [ERROR] Trigger configuration for "cogsend-demo" was only partially updated:

    Cron schedules:
      - A request to the Cloudflare API (/accounts/0123456789abcdef0123456789abcdef/workers/scripts/cogsend-demo/schedules) failed.
        - This account has reached the Workers Free limit of 5 cron triggers per account. Upgrade to Workers Paid to increase this limit to 1,000: https://dash.cloudflare.com/0123456789abcdef0123456789abcdef/workers/plans [code: 10072]
  To learn more about this error, visit: https://developers.cloudflare.com/workers/platform/limits/#account-plan-limits

  Successful trigger changes were not rolled back.`;

describe('cron quota detection', () => {
	it('recognises the real 10072 failure', () => {
		expect(isCronQuotaError(QUOTA_ERROR)).toBe(true);
	});

	it('ignores other failures, and other codes', () => {
		expect(
			isCronQuotaError('✘ [ERROR] A request to the Cloudflare API failed. [code: 10000]')
		).toBe(false);
		expect(isCronQuotaError('Error: Failed to publish your Worker. [code: 10072]')).toBe(false);
		expect(isCronQuotaError('✘ [ERROR] Uploading worker failed')).toBe(false);
		expect(isCronQuotaError('')).toBe(false);
	});
});

describe('jsonc parsing', () => {
	it('keeps urls, escapes and comments apart', () => {
		const text = `{
	// a comment with a "quote" and a / slash
	"name": "cogsend", /* block
	   comment */
	"main": "./x.js",
	"url": "https://example.com//path",
	"escaped": "a\\"b // not a comment",
	"trailing": [1, 2,],
}`;
		expect(parseJsonc(text)).toEqual({
			name: 'cogsend',
			main: './x.js',
			url: 'https://example.com//path',
			escaped: 'a"b // not a comment',
			trailing: [1, 2]
		});
	});

	it('throws on genuinely broken input instead of guessing', () => {
		expect(() => parseJsonc('{ "name": }')).toThrow();
	});
});

describe('trigger removal', () => {
	const config = {
		name: 'cogsend',
		compatibility_date: '2026-08-17',
		triggers: { crons: ['* * * * *'] },
		d1_databases: [{ binding: 'DB' }]
	};

	it('empties the trigger list and leaves everything else alone', () => {
		expect(withoutCronTriggers(config)).toEqual({
			...config,
			triggers: { crons: [] }
		});
		// The input is not mutated: the caller may still read the original.
		expect(config.triggers.crons).toEqual(['* * * * *']);
	});

	it('adds an explicit empty trigger list when there was none', () => {
		expect(withoutCronTriggers({ name: 'cogsend' })).toEqual({
			name: 'cogsend',
			triggers: { crons: [] }
		});
	});

	it('keeps sibling trigger keys', () => {
		expect(withoutCronTriggers({ triggers: { crons: ['0 * * * *'], routes: [] } })).toEqual({
			triggers: { crons: [], routes: [] }
		});
	});

	it('counts crons defensively', () => {
		expect(cronCount(config)).toBe(1);
		expect(cronCount({ triggers: { crons: [] } })).toBe(0);
		expect(cronCount({})).toBe(0);
		expect(cronCount(null)).toBe(0);
		expect(cronCount({ triggers: { crons: 'nope' } })).toBe(0);
	});
});

describe('recorded state', () => {
	it('names the three outcomes', () => {
		expect(cronStateValue({ fallback: true, crons: 1 })).toBe('unavailable:10072');
		expect(cronStateValue({ fallback: false, crons: 1 })).toBe('attached');
		expect(cronStateValue({ fallback: false, crons: 0 })).toBe('disabled');
	});

	it('points at a real doc section', () => {
		expect(cronFallbackWarning()).toContain('docs/deploy.md');
		expect(cronFallbackWarning()).toContain('10072');
	});
});

describe('config argument handling', () => {
	it('finds the config in every accepted spelling', () => {
		expect(configArg(['deploy', '--config', 'wrangler.personal.jsonc'])).toBe(
			'wrangler.personal.jsonc'
		);
		expect(configArg(['deploy', '-c', 'a.jsonc'])).toBe('a.jsonc');
		expect(configArg(['deploy', '--config=b.jsonc'])).toBe('b.jsonc');
		expect(configArg(['deploy', '-c=c.jsonc'])).toBe('c.jsonc');
		expect(configArg(['deploy'])).toBe(null);
	});

	it('strips only the config flag, keeping the rest of the command', () => {
		expect(withoutConfigArg(['deploy', '--config', 'a.jsonc', '--env', 'prod'])).toEqual([
			'deploy',
			'--env',
			'prod'
		]);
		expect(withoutConfigArg(['deploy', '-c', 'a.jsonc'])).toEqual(['deploy']);
		expect(withoutConfigArg(['deploy', '--config=a.jsonc'])).toEqual(['deploy']);
		// The value of another flag is never mistaken for a config value.
		expect(withoutConfigArg(['deploy', '--name', 'cogsend'])).toEqual([
			'deploy',
			'--name',
			'cogsend'
		]);
	});
});

/**
 * The fallback as the operator experiences it: a stubbed `wrangler` that fails
 * with the real error on the first deploy and succeeds on the retry. Runs the
 * actual wrapper, in a throwaway directory, with no network and no Cloudflare.
 */
describe('deploy fallback, end to end', () => {
	let dir: string | null = null;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = null;
	});

	function scratch(scriptBody: string, config: string) {
		const created = mkdtempSync(join(tmpdir(), 'cogsend-wrapper-'));
		dir = created;
		writeFileSync(join(created, 'wrangler.jsonc'), config);
		const bin = join(created, 'bin');
		mkdirSync(bin);
		// A fake `npx` that records every call and answers per the stub body.
		writeFileSync(
			join(bin, 'npx'),
			`#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(created, 'calls.log'))}, JSON.stringify(args) + '\\n');
const deploy = args.includes('deploy');
const hasNoCronConfig = args.includes(${JSON.stringify(NO_CRON_CONFIG_NAME)});
${scriptBody}
`
		);
		chmodSync(join(bin, 'npx'), 0o755);
		return { root: created, bin };
	}

	function runWrapper(root: string, bin: string, args: string[] = ['deploy']) {
		return spawnSync('node', [join(process.cwd(), 'scripts/wrangler.mjs'), ...args], {
			cwd: root,
			encoding: 'utf8',
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }
		});
	}

	const calls = (root: string) =>
		readFileSync(join(root, 'calls.log'), 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));

	it('retries without the trigger, warns, and exits 0', () => {
		const { root, bin } = scratch(
			`if (deploy && !hasNoCronConfig) { console.error(${JSON.stringify(QUOTA_ERROR)}); process.exit(1); }
if (deploy) { console.log('Deployed sent'); process.exit(0); }
process.exit(0);`,
			`{\n\t"name": "cogsend",\n\t"triggers": { "crons": ["* * * * *"] }\n}\n`
		);
		const result = runWrapper(root, bin);
		expect(result.status).toBe(0);
		expect(result.stderr).toContain('cron trigger was NOT attached');
		expect(result.stderr).toContain('10072');

		const recorded = calls(root);
		// deploy -> deploy with the temp config -> d1 note
		expect(recorded).toHaveLength(3);
		expect(recorded[0]).toEqual(['wrangler', 'deploy']);
		expect(recorded[1].slice(0, 2)).toEqual(['wrangler', 'deploy']);
		expect(recorded[1]).toContain('--config');
		expect(recorded[1].some((arg: unknown) => String(arg).endsWith(NO_CRON_CONFIG_NAME))).toBe(
			true
		);
		expect(recorded[2]).toContain('d1');
		expect(recorded[2].join(' ')).toContain('unavailable:10072');

		// The temp config is cleaned up, and the committed one is untouched.
		expect(() => readFileSync(join(root, NO_CRON_CONFIG_NAME), 'utf8')).toThrow();
		expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf8')).toContain('* * * * *');
	});

	it('keeps the retry config valid json with the trigger emptied', () => {
		const { root, bin } = scratch(
			`if (deploy && !hasNoCronConfig) { console.error(${JSON.stringify(QUOTA_ERROR)}); process.exit(1); }
if (deploy) {
	const config = JSON.parse(require('node:fs').readFileSync(args[args.indexOf('--config') + 1], 'utf8'));
	console.log(JSON.stringify(config.triggers));
	process.exit(0);
}
process.exit(0);`,
			`{\n\t"name": "cogsend",\n\t// a comment that JSON.parse would choke on\n\t"triggers": { "crons": ["* * * * *"] },\n\t"vars": {}\n}\n`
		);
		const result = runWrapper(root, bin);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('{"crons":[]}');
	});

	it('surfaces the retry failure when the fallback does not help', () => {
		const { root, bin } = scratch(
			`if (deploy) { console.error(${JSON.stringify(QUOTA_ERROR)}); process.exit(1); }
process.exit(0);`,
			`{\n\t"name": "cogsend",\n\t"triggers": { "crons": ["* * * * *"] }\n}\n`
		);
		const result = runWrapper(root, bin);
		expect(result.status).toBe(1);
		// No state was recorded: the deploy never completed.
		expect(calls(root)).toHaveLength(2);
	});

	it('does nothing special for unrelated failures', () => {
		const { root, bin } = scratch(
			`console.error('✘ [ERROR] Worker exceeded the size limit [code: 10027]'); process.exit(1);`,
			`{\n\t"name": "cogsend"\n}\n`
		);
		const result = runWrapper(root, bin);
		expect(result.status).toBe(1);
		expect(result.stderr).not.toContain('cron trigger was NOT attached');
		expect(calls(root)).toHaveLength(1);
	});

	it('records an attached trigger after a normal deploy', () => {
		const { root, bin } = scratch(
			`if (deploy) { console.log('Deployed sent'); process.exit(0); }
process.exit(0);`,
			`{\n\t"name": "cogsend",\n\t"triggers": { "crons": ["* * * * *"] }\n}\n`
		);
		const result = runWrapper(root, bin);
		expect(result.status).toBe(0);
		const recorded = calls(root);
		expect(recorded).toHaveLength(2);
		expect(recorded[1].join(' ')).toContain('attached');
	});

	it('does not let a stalled D1 note hold up a finished deploy', () => {
		// The note is metadata. If D1 never answers, the deploy already
		// succeeded and must still exit 0 within the note's own budget.
		const { root, bin } = scratch(
			`if (deploy) { console.log('Deployed sent'); process.exit(0); }
if (args.includes('d1')) { setTimeout(() => {}, 60_000); }
else process.exit(0);`,
			`{\n\t"name": "cogsend",\n\t"triggers": { "crons": ["* * * * *"] }\n}\n`
		);
		// Shrink the note timeout so the test does not wait a minute: the wrapper
		// reads it from the environment when set.
		const result = spawnSync('node', [join(process.cwd(), 'scripts/wrangler.mjs'), 'deploy'], {
			cwd: root,
			encoding: 'utf8',
			timeout: 30_000,
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				COGSEND_NOTE_TIMEOUT_MS: '1500'
			}
		});
		expect(result.status).toBe(0);
		expect(calls(root)).toHaveLength(2);
	});

	it('records that the config asks for no trigger at all', () => {
		const { root, bin } = scratch(
			`if (deploy) { console.log('Deployed sent'); process.exit(0); }
process.exit(0);`,
			`{\n\t"name": "cogsend",\n\t"triggers": { "crons": [] }\n}\n`
		);
		const result = runWrapper(root, bin);
		expect(result.status).toBe(0);
		expect(calls(root)[1].join(' ')).toContain('disabled');
	});

	it('writes no note for a dry run', () => {
		const { root, bin } = scratch(
			`if (deploy) { console.log('Total Upload: 1 KiB'); process.exit(0); }
process.exit(0);`,
			`{\n\t"name": "cogsend",\n\t"triggers": { "crons": ["* * * * *"] }\n}\n`
		);
		const result = runWrapper(root, bin, ['deploy', '--dry-run']);
		expect(result.status).toBe(0);
		expect(calls(root)).toHaveLength(1);
	});

	it('COGSEND_STRICT_CRON=1 keeps the failure', () => {
		const { root, bin } = scratch(
			`if (deploy) { console.error(${JSON.stringify(QUOTA_ERROR)}); process.exit(1); }
process.exit(0);`,
			`{\n\t"name": "cogsend",\n\t"triggers": { "crons": ["* * * * *"] }\n}\n`
		);
		const result = spawnSync('node', [join(process.cwd(), 'scripts/wrangler.mjs'), 'deploy'], {
			cwd: root,
			encoding: 'utf8',
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, COGSEND_STRICT_CRON: '1' }
		});
		expect(result.status).toBe(1);
		expect(calls(root)).toHaveLength(1);
	});
});
