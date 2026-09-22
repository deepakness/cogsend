#!/usr/bin/env node
/**
 * Run the 2FA enrolment spec against an instance that requires 2FA.
 *
 * The fixture sets `SKIP_TOTP=1` so most specs can sign in with a password
 * alone — which also means the enrolment path (scan the QR, confirm a code, save
 * the backup codes) never ran in CI, and it is the one flow a first-time
 * self-hoster cannot get past without. This runs that spec with `SKIP_TOTP`
 * removed, and puts `.dev.vars` back exactly as it was afterwards: a developer's
 * file must not come out of a test run with 2FA switched on.
 *
 * Wired into `npm run test:e2e:totp`.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const TARGET = '.dev.vars';
const FIXTURE = 'tests/e2e/fixtures/dev.vars';
const previous = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : null;

let restored = false;
/** Put the developer's file back. Safe to call twice. */
function restore() {
	if (restored) return;
	restored = true;
	if (previous === null) rmSync(TARGET, { force: true });
	else writeFileSync(TARGET, previous);
}
// An interrupt must not leave a checkout whose e2e suite suddenly needs 2FA:
// the next `npm run test:e2e` would fail in every spec that signs in.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
	process.on(signal, () => {
		restore();
		process.exit(1);
	});
}

try {
	const withoutSkipTotp = readFileSync(FIXTURE, 'utf8')
		.split('\n')
		.filter((line) => !/^\s*SKIP_TOTP\s*=/.test(line))
		.join('\n');
	writeFileSync(TARGET, withoutSkipTotp);
	chmodSync(TARGET, 0o600);
	console.log('e2e: 2FA required for this run (.dev.vars restored afterwards)');

	const result = spawnSync(
		'npx',
		['playwright', 'test', 'tests/e2e/smoke.e2e.ts', '-g', 'signs in and enrolls 2fa'],
		{ stdio: 'inherit' }
	);
	process.exitCode = result.status ?? 1;
} finally {
	restore();
}
