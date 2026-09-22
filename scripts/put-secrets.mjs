#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isPlaceholderValue, readDevVars } from './lib/dev-vars.mjs';

const keys = process.argv.slice(2);
// The app derives AUTH_SECRET and SCHEDULER_SECRET from APP_ENCRYPTION_KEY and
// takes APP_URL from the request, so those three are only uploaded when they are
// deliberately set locally (the loop below skips anything absent). The login
// itself is not a secret: `npm run setup` writes it into D1 as a PBKDF2 hash.
// Everything the app reads from the environment and that belongs in a secret.
// APP_NAME is a `[vars]` entry, and SKIP_TOTP is a local-development flag that
// must never travel — both are deliberately absent.
const wanted = keys.length
	? keys
	: [
			'APP_ENCRYPTION_KEY',
			'AUTH_SECRET',
			'APP_URL',
			'API_TOKEN',
			'SCHEDULER_SECRET',
			'LINKEDIN_CLIENT_ID',
			'LINKEDIN_CLIENT_SECRET',
			'THREADS_APP_ID',
			'THREADS_APP_SECRET',
			'X_CLIENT_ID',
			'X_CLIENT_SECRET',
			'MEDIA_PUBLIC_BASE_URL',
			'RESEND_API_KEY',
			'NOTIFY_EMAIL',
			'NOTIFY_FROM',
			'ENABLE_VIDEO_UPLOAD'
		];

function valueFromDevVars(key) {
	return readDevVars().get(key) ?? null;
}

function valueFromApiTokenFile() {
	try {
		return readFileSync('.api-token', 'utf8').trim();
	} catch {
		return null;
	}
}

function isLocalAppUrl(value) {
	try {
		const host = new URL(value).hostname.toLowerCase();
		return host === 'localhost' || host === '127.0.0.1' || host === '::1';
	} catch {
		return true;
	}
}

for (const key of wanted) {
	const value =
		key === 'API_TOKEN' ? valueFromApiTokenFile() || valueFromDevVars(key) : valueFromDevVars(key);
	if (!value) {
		console.error(`skip ${key}: no local value`);
		continue;
	}
	// The same refusal `setup` and the app's own boot guard apply: an example
	// value is not a configuration, and uploading one either breaks the deploy
	// (the app refuses to boot on it) or, for a longer list, hides the fact that
	// the real value is missing.
	if (isPlaceholderValue(value)) {
		console.error(`skip ${key}: still an example value`);
		continue;
	}
	if (key === 'APP_URL' && isLocalAppUrl(value)) {
		console.error('skip APP_URL: local .dev.vars points at localhost. Set production with:');
		console.error('  node scripts/wrangler.mjs secret put APP_URL');
		console.error('  (your production URL, e.g. https://cogsend.<account>.workers.dev)');
		continue;
	}
	console.log(`uploading ${key}`);
	const result = spawnSync('node', ['scripts/wrangler.mjs', 'secret', 'put', key], {
		input: value,
		stdio: ['pipe', 'inherit', 'inherit']
	});
	if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log('done');
