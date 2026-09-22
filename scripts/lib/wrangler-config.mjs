/**
 * Deploy-time helpers for `scripts/wrangler.mjs`.
 *
 * One job: a Cloudflare account that has used all of its cron triggers (five on
 * the free plan) must not fail a deploy that would otherwise succeed. The
 * Worker, its assets and its bindings upload fine — the only thing refused is
 * the schedule, which the app does not need to serve requests. So the wrapper
 * retries once with the trigger removed, tells the operator what that means,
 * and exits 0.
 *
 * Kept dependency-free and side-effect-free so it can be tested directly.
 */

/**
 * JSONC parsing without a dependency. Comment- and string-aware: a naive
 * regex breaks on `"https://…"` and on escaped quotes inside strings.
 *
 * @param {string} text
 * @returns {any}
 */
export function parseJsonc(text) {
	let out = '';
	let inString = false;
	let inLineComment = false;
	let inBlockComment = false;
	for (let i = 0; i < text.length; i += 1) {
		const char = text[i];
		const next = text[i + 1];
		if (inLineComment) {
			if (char === '\n') {
				inLineComment = false;
				out += char;
			}
			continue;
		}
		if (inBlockComment) {
			if (char === '*' && next === '/') {
				inBlockComment = false;
				i += 1;
			}
			continue;
		}
		if (inString) {
			out += char;
			if (char === '\\') {
				// Keep the escaped character verbatim, whatever it is.
				if (next !== undefined) {
					out += next;
					i += 1;
				}
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			out += char;
			continue;
		}
		if (char === '/' && next === '/') {
			inLineComment = true;
			i += 1;
			continue;
		}
		if (char === '/' && next === '*') {
			inBlockComment = true;
			i += 1;
			continue;
		}
		out += char;
	}
	// Trailing commas are legal in JSONC and rejected by JSON.parse.
	return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/**
 * A copy of a parsed config with the cron trigger removed.
 *
 * `crons: []` is the documented way to say "this deploy has no schedule": it
 * also clears any schedule the Worker already had, so a retried deploy leaves
 * deliberate state rather than a half-applied trigger set. Everything else is
 * carried over untouched.
 *
 * @param {any} config
 * @returns {any}
 */
export function withoutCronTriggers(config) {
	const next = { ...config };
	if (next.triggers === undefined || next.triggers === null) {
		next.triggers = { crons: [] };
	} else {
		next.triggers = { ...next.triggers, crons: [] };
	}
	return next;
}

/**
 * How many cron schedules a config asks for.
 *
 * @param {any} config
 * @returns {number}
 */
export function cronCount(config) {
	const crons = config?.triggers?.crons;
	return Array.isArray(crons) ? crons.length : 0;
}

/**
 * Is this output the "account is out of cron triggers" failure?
 *
 * Cloudflare's code 10072 is specific to the cron-trigger account limit, but we
 * also require a trigger-related word in the same output so an unrelated error
 * that happens to print the number cannot trigger the fallback. Missing a
 * reworded error is fine (the deploy just fails as it did before); retrying on
 * the wrong error is not.
 *
 * @param {string} output
 * @returns {boolean}
 */
export function isCronQuotaError(output) {
	if (!/\b10072\b/.test(output)) return false;
	return /(cron|trigger|schedules?)/i.test(output);
}

/**
 * The value recorded for the app/doctor: what the last deploy did with the
 * trigger. `unavailable` means the account refused it, `disabled` means the
 * config never asked for one, `attached` means Cloudflare accepted it.
 *
 * @param {{ fallback: boolean, crons: number }} result
 * @returns {string}
 */
export function cronStateValue({ fallback, crons }) {
	if (fallback) return 'unavailable:10072';
	return crons > 0 ? 'attached' : 'disabled';
}

/**
 * `--config <path>` / `-c <path>` / `--config=<path>` in a wrangler arg list.
 *
 * @param {string[]} args
 * @returns {string | null}
 */
export function configArg(args) {
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === '-c' || arg === '--config') return args[i + 1] ?? null;
		if (arg.startsWith('--config=')) return arg.slice('--config='.length);
		if (arg.startsWith('-c=')) return arg.slice('-c='.length);
	}
	return null;
}

/**
 * The same arg list without our `--config`/`-c` (so a replacement can be added).
 *
 * @param {string[]} args
 * @returns {string[]}
 */
export function withoutConfigArg(args) {
	const out = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === '-c' || arg === '--config') {
			i += 1;
			continue;
		}
		if (arg.startsWith('--config=') || arg.startsWith('-c=')) continue;
		out.push(arg);
	}
	return out;
}

/** The temp config is written next to the config it derives from, because
 *  Wrangler resolves relative paths (`main`, `assets.directory`, migrations)
 *  against the config file's directory. */
export const NO_CRON_CONFIG_NAME = 'wrangler.no-cron.jsonc';

/** The note printed when the fallback ran. */
export function cronFallbackWarning() {
	return [
		'',
		'! Deployed, but the cron trigger was NOT attached.',
		'    Cloudflare refused the schedule: this account has reached the Workers',
		'    free-plan limit of 5 cron triggers per account (error 10072).',
		'',
		'    The Worker, its assets and its bindings are live. Publishing now works;',
		'    only scheduled posts need a tick.',
		'',
		'    Pick one:',
		'      1. Free a cron trigger slot: Workers & Pages -> the other Worker ->',
		'         Settings -> Trigger events -> Cron triggers -> delete one.',
		'      2. Upgrade the account to Workers Paid (many more triggers).',
		'      3. Leave it trigger-less and drive the tick yourself: Settings ->',
		'         Scheduled publishing shows the tick URL and a token to paste into',
		'         any cron service (cron-job.org, UptimeRobot, GitHub Actions).',
		'',
		'    See docs/deploy.md -> "The deploy complains about cron triggers (10072)".',
		''
	].join('\n');
}
