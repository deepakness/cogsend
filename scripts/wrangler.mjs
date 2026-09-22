#!/usr/bin/env node
/**
 * Wrangler wrapper used by every npm script, so a checkout can keep its own
 * deployment details out of version control.
 *
 * 1. Config: if `wrangler.personal.jsonc` exists it is passed via `--config`.
 *    That file is gitignored and holds instance-specific values — your Worker
 *    name, your D1 `database_id`, your R2 bucket — so `wrangler.jsonc` in the
 *    repo can stay generic and upstream-friendly.
 * 2. Profile: when WRANGLER_PROFILE is set, `--profile` is added. Multi-account
 *    users pick an account with `WRANGLER_PROFILE=my-account npm run deploy`
 *    instead of the repo hardcoding a profile name.
 * 3. Cron quota: a deploy that Cloudflare refuses only because the account has
 *    no cron-trigger slot left (free plan: five per account) is retried once
 *    with the trigger removed, so the Worker still ships and the build is not
 *    marked failed. The outcome is recorded in D1 for the app and
 *    `npm run doctor` to read. COGSEND_STRICT_CRON=1 opts out of the retry.
 *
 * Explicit flags always win: passing `--config` or `--profile` yourself
 * disables the corresponding inference.
 *
 * Usage: node scripts/wrangler.mjs <wrangler args...>
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
} from './lib/wrangler-config.mjs';

const PERSONAL_CONFIG = 'wrangler.personal.jsonc';
/** The D1 note is metadata: give it a minute, then carry on regardless. The
 *  environment override exists so a test can shrink it. */
const NOTE_TIMEOUT_MS = Number(process.env.COGSEND_NOTE_TIMEOUT_MS) || 60_000;
const COMMITTED_CONFIG = 'wrangler.jsonc';
const args = process.argv.slice(2);

const hasFlag = (...names) =>
	args.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));

const configArgs =
	!existsSync(PERSONAL_CONFIG) || hasFlag('-c', '--config') ? [] : ['--config', PERSONAL_CONFIG];

const profile = process.env.WRANGLER_PROFILE?.trim();
const profileArgs = !profile || hasFlag('--profile') ? [] : ['--profile', profile];

const overrides = [...profileArgs, ...configArgs];
const fullArgs = [...args, ...overrides];
console.error(`\n$ npx wrangler ${fullArgs.join(' ')}`);
if (overrides.length) {
	console.error(`  (${overrides.join(' ')} applied by scripts/wrangler.mjs)`);
}

/**
 * Run wrangler.
 *
 * `capture` pipes the output so we can read it (and still streams it live, so
 * nothing disappears); everything else inherits our stdio, which keeps the TTY
 * for interactive commands like `dev`, `login` and `secret put` — colours,
 * prompts and progress included. `quiet` keeps a capture to ourselves (used for
 * the D1 note, whose output nobody asked to see).
 *
 * `timeout` bounds a call whose result is optional (the D1 note): a stalled API
 * request must not hold up a deploy that has already succeeded.
 *
 * @param {string[]} wranglerArgs
 * @param {{ capture?: boolean, quiet?: boolean, timeoutMs?: number }} [options]
 * @returns {Promise<{ status: number, output: string }>}
 */
function runWrangler(wranglerArgs, { capture = false, quiet = false, timeoutMs = 0 } = {}) {
	/** Kill a run that overstays, and report it like any other failure. */
	const withTimeout = (child, settle) => {
		if (!timeoutMs) return;
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			settle({ status: 124, output: `timed out after ${timeoutMs}ms` });
		}, timeoutMs);
		child.on('close', () => clearTimeout(timer));
	};

	if (!capture && !quiet) {
		return new Promise((resolve) => {
			const child = spawn('npx', ['wrangler', ...wranglerArgs], { stdio: 'inherit' });
			child.on('error', (err) => {
				process.stderr.write(`could not run wrangler: ${err.message}\n`);
				resolve({ status: 1, output: '' });
			});
			child.on('close', (status) => resolve({ status: status ?? 1, output: '' }));
		});
	}
	return new Promise((resolve) => {
		let settled = false;
		const settle = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const child = spawn('npx', ['wrangler', ...wranglerArgs], {
			stdio: ['inherit', 'pipe', 'pipe']
		});
		withTimeout(child, settle);
		let output = '';
		child.stdout.on('data', (chunk) => {
			output += chunk;
			if (!quiet) process.stdout.write(chunk);
		});
		child.stderr.on('data', (chunk) => {
			output += chunk;
			if (!quiet) process.stderr.write(chunk);
		});
		child.on('error', (err) => {
			process.stderr.write(`could not run wrangler: ${err.message}\n`);
			settle({ status: 1, output });
		});
		child.on('close', (status) => settle({ status: status ?? 1, output }));
	});
}

/** The config file this run actually deploys. */
function effectiveConfigPath() {
	return configArg(args) ?? (existsSync(PERSONAL_CONFIG) ? PERSONAL_CONFIG : COMMITTED_CONFIG);
}

/** Read the config that will be deployed, or null when it is unreadable. */
function readConfig(path) {
	try {
		return parseJsonc(readFileSync(path, 'utf8'));
	} catch {
		return null;
	}
}

/**
 * Record what happened to the trigger, for the app's Settings page and
 * `npm run doctor`. Best effort by design: a brand-new database has no
 * `app_settings` table until the first request bootstraps it, and a missing
 * note only ever means "the app falls back to its other signals".
 */
async function noteCronState(value) {
	const sql =
		`INSERT INTO app_settings (key, value, updated_at) VALUES ('cron_state', '${value}', ${Date.now()}) ` +
		`ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`;
	await runWrangler(
		[
			...profileArgs,
			'--config',
			effectiveConfigPath(),
			'd1',
			'execute',
			'DB',
			'--remote',
			'--yes',
			'--command',
			sql
		],
		{ quiet: true, timeoutMs: NOTE_TIMEOUT_MS }
	);
}

const isDeploy = args[0] === 'deploy';
const isDryRun = hasFlag('--dry-run');
const strict = ['1', 'true', 'yes'].includes((process.env.COGSEND_STRICT_CRON ?? '').toLowerCase());

const result = await runWrangler(fullArgs, { capture: isDeploy });
let status = result.status;
let fellBack = false;

if (isDeploy && status !== 0 && !strict && isCronQuotaError(result.output)) {
	// The code and assets are already uploaded; only the schedule was refused.
	// Retry with the trigger removed so the deploy finishes cleanly and the
	// schedule state is explicit (`crons: []`) instead of half-applied.
	const source = effectiveConfigPath();
	const config = readConfig(source);
	if (!config) {
		console.error(`could not read ${source} to retry without the cron trigger`);
	} else {
		const tempPath = join(dirname(source), NO_CRON_CONFIG_NAME);
		console.error(cronFallbackWarning());
		console.error(
			`\n$ npx wrangler ${[...withoutConfigArg(args), ...profileArgs, '--config', tempPath].join(' ')}`
		);
		try {
			writeFileSync(tempPath, `${JSON.stringify(withoutCronTriggers(config), null, '\t')}\n`);
			const retried = await runWrangler(
				[...withoutConfigArg(args), ...profileArgs, '--config', tempPath],
				{ capture: true }
			);
			status = retried.status;
			fellBack = retried.status === 0;
		} catch (err) {
			// Never let the fallback turn into a confusing error of its own: the
			// original failure is still on screen and still decides the exit code.
			console.error(`could not retry the deploy without the cron trigger: ${err?.message ?? err}`);
		} finally {
			rmSync(tempPath, { force: true });
		}
	}
}

if (isDeploy && !isDryRun && status === 0) {
	// One extra D1 round trip per deploy buys the app a precise answer instead
	// of "no tick yet": attached / disabled / unavailable. Skipped when the
	// config cannot be read: a wrong note is worse than no note.
	const config = readConfig(effectiveConfigPath());
	if (config) {
		await noteCronState(cronStateValue({ fallback: fellBack, crons: cronCount(config) }));
	}
}

process.exitCode = status;
