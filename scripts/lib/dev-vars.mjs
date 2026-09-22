/**
 * `.dev.vars` reading, shared by every script that touches it.
 *
 * Two scripts uploaded from that file with different parsers: `setup.mjs`
 * trimmed, stripped a trailing comment and unquoted the value, while
 * `put-secrets.mjs` took everything after the first `=`. For a line like
 *
 *     APP_ENCRYPTION_KEY="abc" # rotate after the migration
 *
 * they disagreed — `abc` against `"abc" # rotate after the migration` — and
 * whichever ran last won. The value cannot be read back from Cloudflare, so a
 * mismatch silently orphans every stored credential. One parser, one answer.
 */
import { existsSync, readFileSync } from 'node:fs';

/** Values that ship with the repo and must never reach a deployment. Kept
 *  identical to PLACEHOLDER_SECRETS in src/lib/server/env.ts by a test that
 *  imports both lists. */
export const PLACEHOLDER_VALUES = new Set([
	'change-me',
	// Current .dev.vars.example values.
	'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
	'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
	// Earlier example values: still listed so a stale .dev.vars, or a deploy
	// that copied one, keeps being rejected after the rename.
	'dev-auth-secret-change-me',
	'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
]);

/** The example admin address, which is not a secret but is just as wrong to
 *  keep: the account it creates is one an attacker already knows. */
export const PLACEHOLDER_EMAIL = 'admin@example.com';

/**
 * Parse dotenv-style text the way the Worker's own loader does: `KEY=value`,
 * with an optional trailing `# comment` and optional surrounding quotes.
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseDevVars(text) {
	const values = new Map();
	for (const line of String(text ?? '').split('\n')) {
		const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
		if (!match) continue;
		let raw = match[2].trim();
		// Strip a trailing comment first, then unquote: dotenv accepts
		// `KEY="value" # comment`, and the value is the quoted part.
		const comment = raw.search(/\s+#/);
		if (comment !== -1) raw = raw.slice(0, comment).trim();
		if (/^".*"$/.test(raw) || /^'.*'$/.test(raw)) raw = raw.slice(1, -1);
		values.set(match[1], raw);
	}
	return values;
}

/**
 * Read a `.dev.vars` file. Missing file means no values, not an error — every
 * caller treats absence as "nothing to upload".
 * @param {string} [file]
 * @returns {Map<string, string>}
 */
export function readDevVars(file = '.dev.vars') {
	if (!existsSync(file)) return new Map();
	return parseDevVars(readFileSync(file, 'utf8'));
}

/** @param {string | undefined | null} value */
export function isPlaceholderValue(value) {
	return value === undefined || value === null || PLACEHOLDER_VALUES.has(value.trim());
}
