#!/usr/bin/env node
// One-command setup for a self-hosted instance: Cloudflare resources, secrets,
// migrations and the first deploy — in the order that actually works.
//
// Safe by default. It creates only what is missing, and it will not change a
// value a running deployment already has:
//
//   * resources that exist are reused, and an existing `database_id` in your
//     config is never replaced;
//   * a secret that is already set on the Worker is left alone, because
//     rotating APP_ENCRYPTION_KEY orphans every stored credential and signs
//     every session out. `--rotate-secrets` is how you say you mean it;
//   * an account that already exists is left alone. `--reset-login` gives it a
//     new password and revokes every session instead.
//
// The account is created in D1 from here, before the Worker is reachable, which
// is why the app has nothing to claim and no public window in which a stranger
// could claim it. The password never reaches a Worker secret: only its PBKDF2
// hash is written, and nothing but the hash is stored.
//
// Usage:
//   npm run setup                       # interactive
//   npm run setup -- --dry-run          # read-only: checks auth, prints the plan
//   npm run setup -- --yes              # no prompts: generates the secrets and the password, prints them once
//   npm run setup -- --skip-deploy      # everything except the deploy
//   npm run setup -- --rotate-secrets   # also overwrite APP_ENCRYPTION_KEY (rotates the derived secrets too)
//   npm run setup -- --reset-login      # also replace the account's password (revokes every session)
//   npm run setup -- --name my-cogsend --bucket my-cogsend-media --db my-cogsend
//   npm run setup -- --admin-email you@example.com --admin-password '…'
//
// This is the only way to install: no browser flow can create the account, which
// is what makes the claim window impossible rather than merely unlikely. It can
// also pin APP_URL to the URL it just deployed to.
//
// Everything it writes to your Cloudflare account: one D1 database, one R2
// bucket, the Worker, its secrets, its migrations, and the account row that
// owns it. Everything it writes locally: `wrangler.personal.jsonc` (gitignored)
// and `.dev.vars` (gitignored).

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	KDF_ITERATIONS,
	PASSWORD_MIN,
	emailProblem,
	generatePassword,
	normalizeEmail,
	passwordProblem,
	readAccount,
	resetAccount,
	seedAccount
} from './lib/account.mjs';
import { PLACEHOLDER_EMAIL, isPlaceholderValue, readDevVars } from './lib/dev-vars.mjs';
import { readWorkerSecrets } from './lib/worker-secrets.mjs';
import { syncMigrations } from './lib/migration-sync.mjs';
import { ask as promptAsk, askSecret as promptAskSecret } from './lib/prompt.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const value = (name, fallback) => {
	const i = argv.indexOf(name);
	const next = argv[i + 1];
	return i >= 0 && next && !next.startsWith('--') ? next : fallback;
};

const DRY = has('--dry-run');
const ASSUME_YES = has('--yes');
const SKIP_DEPLOY = has('--skip-deploy');
const ROTATE_SECRETS = has('--rotate-secrets');
const RESET_LOGIN = has('--reset-login');

// Removed because workerd rejects PBKDF2 counts above 100,000: the old 600k
// option wrote a hash the Worker could never verify. Fail loudly rather than
// silently ignoring a flag an operator script may still pass.
if (has('--strong-kdf')) {
	fail('--strong-kdf was removed: Workers cannot verify PBKDF2 counts above 100,000');
}

const PERSONAL_CONFIG = 'wrangler.personal.jsonc';
const COMMITTED_CONFIG = 'wrangler.jsonc';
const DEV_VARS = '.dev.vars';
const DEV_VARS_EXAMPLE = '.dev.vars.example';

/** Minimum lengths the app's own env schema enforces. */
const MIN_LENGTH = {
	APP_ENCRYPTION_KEY: 32
};

const info = (message) => console.log(`  ${message}`);
const warn = (message) => console.log(`  ! ${message}`);

/** Reports an action that happened; silent in a dry run, where nothing did. */
const did = (message) => {
	if (!DRY) info(message);
};
/** Reports an action that would happen; only shown in a dry run. */
const would = (message) => {
	if (DRY) info(message);
};

function say(message) {
	console.log(`\n${message}`);
}

function fail(message) {
	console.error(`\n✘ ${message}`);
	process.exit(1);
}

/**
 * Run a command. `readOnly` marks the few calls that are also safe in a dry
 * run; everything else is printed but skipped.
 */
function run(cmd, cmdArgs, opts = {}) {
	if (DRY && !opts.readOnly) {
		console.log(`  $ ${cmd} ${cmdArgs.join(' ')}   (skipped: dry run)`);
		return { status: 0, stdout: '', stderr: '' };
	}
	console.log(`  $ ${cmd} ${cmdArgs.join(' ')}`);
	// Always captured (some callers parse it) and always echoed, unless the
	// output is machine-readable noise.
	const result = spawnSync(cmd, cmdArgs, { encoding: 'utf8', input: opts.input });
	const stdout = result.stdout ?? '';
	const stderr = result.stderr ?? '';
	if (stdout.trim() && !opts.quiet) console.log(stdout.trimEnd());
	if (stderr.trim() && !opts.quiet) console.error(stderr.trimEnd());
	if (result.status !== 0 && !opts.allowFailure) {
		fail(`${cmd} ${cmdArgs.join(' ')} failed.`);
	}
	return { status: result.status ?? 0, stdout, stderr };
}

/** One `d1 execute --json` round-trip against the deployed database. */
function d1Json(sql) {
	const result = wrangler(['d1', 'execute', 'DB', '--remote', '--json', '--command', sql], {
		readOnly: true,
		quiet: true
	});
	if (result.status !== 0) {
		fail(`could not read the database schema:\n${result.stderr || result.stdout}`);
	}
	try {
		return JSON.parse(result.stdout)[0]?.results ?? [];
	} catch {
		fail('could not parse `wrangler d1 execute --json` output.');
	}
}

/** Always through the repo wrapper, so `wrangler.personal.jsonc` and
 *  `WRANGLER_PROFILE` apply exactly as they do for the npm scripts. */
const wrangler = (cmdArgs, opts) => run('node', ['scripts/wrangler.mjs', ...cmdArgs], opts);

/** `wrangler d1 list --json`, or [] when it cannot be read. */
function listDatabases() {
	const list = wrangler(['d1', 'list', '--json'], { readOnly: true, quiet: true });
	if (list.status !== 0) {
		warn('could not read the database list; will try to create it');
		return [];
	}
	try {
		const parsed = JSON.parse(list.stdout);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		warn('could not read the database list; will try to create it');
		return [];
	}
}

/** Minimal JSONC reader: the configs carry comments. */
function readJsonc(file) {
	const text = readFileSync(file, 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/.*$/gm, '$1')
		.replace(/,(\s*[}\]])/g, '$1');
	return JSON.parse(text);
}

/** Prompts answer themselves when there is nothing to prompt: a dry run, `--yes`
 *  or a piped invocation all fall back to the default instead of hanging. */
const interactive = () => !DRY && !ASSUME_YES && Boolean(process.stdin.isTTY);
const ask = (question, fallback) => promptAsk(question, fallback, { interactive: interactive() });
const askSecret = (question) => promptAskSecret(question, { interactive: interactive() });

const generateHex = (bytes = 32) => randomBytes(bytes).toString('hex');

/**
 * Prove that the deployment really accepts the account: one password round trip
 * against the live Worker. A 200 means the row, the uploaded secrets and the
 * PBKDF2 count all work on this plan. The authenticator is deliberately not
 * exercised, because that would spend a one-time code the operator needs for
 * their own first sign-in.
 */
async function verifyLogin(siteUrl, email, password) {
	let lastError = '';
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const res = await fetch(`${siteUrl}/api/auth/login`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ email, password, remember: false })
			});
			const text = await res.text();
			if (res.ok) {
				let body = null;
				try {
					body = JSON.parse(text);
				} catch {
					// A 200 with an unreadable body is still a 200.
				}
				return { ok: true, totp: Boolean(body?.needTotp ?? body?.needEnroll) };
			}
			lastError = `${res.status} ${text.slice(0, 200)}`;
		} catch (err) {
			lastError = err?.message ?? String(err);
		}
		if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
	}
	return { ok: false, error: lastError };
}

/** `.dev.vars` values as dotenv would read them: unquoted, comments stripped. */

/** Upsert the keys we manage, leaving every other line (and its comments) alone. */
function writeDevVars(updates) {
	const original = existsSync(DEV_VARS)
		? readFileSync(DEV_VARS, 'utf8')
		: readFileSync(DEV_VARS_EXAMPLE, 'utf8');
	const pending = new Map(Object.entries(updates));
	const lines = original.split('\n').map((line) => {
		const match = line.match(/^\s*([A-Z0-9_]+)\s*=/);
		if (!match || !pending.has(match[1])) return line;
		const value = pending.get(match[1]);
		pending.delete(match[1]);
		return `${match[1]}=${value}`;
	});
	for (const [key, value] of pending) lines.push(`${key}=${value}`);
	writeFileSync(DEV_VARS, lines.join('\n'));
	// It holds the one key that decrypts every stored credential, and it sits in
	// a checkout: keep it to the operator's account only.
	try {
		chmodSync(DEV_VARS, 0o600);
	} catch {
		// Filesystems without POSIX permissions (Windows) simply skip this.
	}
}

/** Everything the app would reject at boot, caught before it is uploaded. */
function validateSecret(key, value) {
	if (isPlaceholderValue(value)) return 'still an example value';
	if (value.length < (MIN_LENGTH[key] ?? 1)) return `shorter than ${MIN_LENGTH[key]} characters`;
	return null;
}

/** Patch the personal config in place so its comments survive. */
function patchPersonalConfig({ name, databaseName, databaseId, bucket, databaseIdIsSet }) {
	let text = readFileSync(PERSONAL_CONFIG, 'utf8');
	const patch = (pattern, replacement, label) => {
		if (!pattern.test(text)) {
			warn(`could not find ${label} in ${PERSONAL_CONFIG} — set it by hand`);
			return;
		}
		text = text.replace(pattern, replacement);
	};
	if (name) patch(/("name"\s*:\s*)"[^"]*"/, `$1"${name}"`, 'the Worker name');
	// The name is what `wrangler deploy` prints next to the binding, what
	// `wrangler d1 …` resolves by, and what the doctor's binding line shows, so
	// it has to name the database the id below actually points at. Leaving the
	// committed default here is how a second instance ends up looking like the
	// first one in every command's output.
	if (databaseName) {
		patch(/("database_name"\s*:\s*)"[^"]*"/, `$1"${databaseName}"`, 'database_name');
	}
	// Never replace a database id that is already set: it points at the database
	// holding the instance's data.
	if (databaseId && !databaseIdIsSet) {
		patch(/("database_id"\s*:\s*)"[^"]*"/, `$1"${databaseId}"`, 'database_id');
	}
	if (bucket) {
		if (/"bucket_name"\s*:/.test(text)) {
			patch(/("bucket_name"\s*:\s*)"[^"]*"/, `$1"${bucket}"`, 'bucket_name');
		} else {
			patch(
				/(\b"binding"\s*:\s*"MEDIA")/,
				`$1,\n\t\t\t"bucket_name": "${bucket}"`,
				'the R2 binding'
			);
		}
	}
	writeFileSync(PERSONAL_CONFIG, text);
}

async function main() {
	console.log(`CogSend setup${DRY ? ' (dry run — nothing will be created or changed)' : ''}`);

	// 1. Who are we deploying as?
	say('1. Cloudflare account');
	const who = wrangler(['whoami', '--json'], { readOnly: true, quiet: true });
	if (who.status !== 0) fail('wrangler could not read your account.');
	let account;
	try {
		account = JSON.parse(who.stdout);
	} catch {
		fail('could not parse `wrangler whoami --json`. Update wrangler and try again.');
	}
	if (!account.loggedIn) {
		if (DRY || !process.stdin.isTTY) {
			fail(
				'You are not signed in. Run `npx wrangler login` (an OAuth login — no API token needed).'
			);
		}
		info('not signed in yet — starting the browser login');
		wrangler(['login']);
		const after = wrangler(['whoami', '--json'], { readOnly: true, quiet: true });
		account = JSON.parse(after.stdout || '{}');
		if (!account.loggedIn) fail('Still not signed in. Run `npx wrangler login` and try again.');
	}
	info(`signed in as ${account.email}`);
	const accounts = account.accounts ?? [];
	if (accounts.length === 0) fail('This login has no Cloudflare account.');
	info(`account: ${accounts.map((a) => a.name).join(', ')}`);
	if (accounts.length > 1) {
		warn('several accounts are available; wrangler picks the default one');
		warn('set WRANGLER_PROFILE to choose another (see docs/configuration.md)');
	}

	// 2. Names, from the config that will actually be deployed.
	say('2. Configuration');
	const personalExists = existsSync(PERSONAL_CONFIG);
	// `wrangler.personal.jsonc` wins over the committed config, exactly as the
	// wrapper applies it — reading only the committed file would create a second
	// database next to the one an existing deployment already uses.
	const effective = readJsonc(personalExists ? PERSONAL_CONFIG : COMMITTED_CONFIG);
	const name = value('--name', effective.name);
	const databaseName = value('--db', effective.d1_databases[0].database_name);
	const databaseId = effective.d1_databases[0].database_id || '';
	const bucket = value('--bucket', effective.r2_buckets[0].bucket_name || `${name}-media`);
	info(`config:   ${personalExists ? PERSONAL_CONFIG : COMMITTED_CONFIG}`);
	info(`worker:   ${name}`);
	info(`database: ${databaseName}${databaseId ? ` (${databaseId})` : ' (not created yet)'}`);
	info(`bucket:   ${bucket}`);

	if (!personalExists) {
		would(`would create ${PERSONAL_CONFIG} with those names and your resource ids`);
		if (!DRY) {
			copyFileSync(COMMITTED_CONFIG, PERSONAL_CONFIG);
			patchPersonalConfig({
				name,
				databaseName,
				databaseId,
				bucket,
				databaseIdIsSet: Boolean(databaseId)
			});
			info(`created ${PERSONAL_CONFIG} (gitignored — keeps your names out of upstream)`);
		}
	} else if (!effective.r2_buckets[0].bucket_name && !DRY) {
		// The binding has no bucket name; without this the first deploy would
		// auto-provision its own and leave the bucket below unused.
		patchPersonalConfig({ bucket });
		info(`recorded ${bucket} in ${PERSONAL_CONFIG}`);
	}

	// 3. D1.
	say('3. D1 database');
	let resolvedDatabaseId = databaseId;
	let resolvedDatabaseName = databaseName;
	if (resolvedDatabaseId) {
		info(`${databaseName} is already bound (${resolvedDatabaseId}) — left untouched`);
		// Ask the account what that id is called, in case the name in the config
		// drifted from it (`--db` on a later run, or a copy of the committed
		// file). The id stays authoritative; only the label follows it.
		const actual = listDatabases().find((db) => db.uuid === resolvedDatabaseId)?.name;
		if (actual && actual !== databaseName) {
			resolvedDatabaseName = actual;
			would(`would record the name ${resolvedDatabaseName} for that database id`);
			if (!DRY) {
				patchPersonalConfig({ databaseName: resolvedDatabaseName });
				info(`recorded database_name ${resolvedDatabaseName} in ${PERSONAL_CONFIG}`);
			}
		}
	} else {
		const found = listDatabases().find((db) => db.name === databaseName);
		if (found) {
			resolvedDatabaseId = found.uuid;
			info(`${databaseName} already exists (${resolvedDatabaseId})`);
			// Record the id: a config that leaves it empty makes wrangler
			// provision on every deploy instead of binding the database the
			// account already holds.
			would(`would record database_id ${resolvedDatabaseId} in ${PERSONAL_CONFIG}`);
			if (!DRY) {
				patchPersonalConfig({
					databaseName: resolvedDatabaseName,
					databaseId: resolvedDatabaseId,
					databaseIdIsSet: false
				});
				info(`recorded database_id ${resolvedDatabaseId} in ${PERSONAL_CONFIG}`);
			}
		}
		if (!resolvedDatabaseId) {
			would(`would create the database ${databaseName}`);
			if (!DRY) {
				const created = wrangler(['d1', 'create', databaseName], { allowFailure: true });
				const text = `${created.stdout}${created.stderr}`;
				const found = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
				if (created.status !== 0 || !found) {
					fail(
						`could not create ${databaseName}. If it already exists, put its id in ${PERSONAL_CONFIG} by hand (npx wrangler d1 list).\n${text}`
					);
				}
				resolvedDatabaseId = found[0];
				did(`created ${databaseName} (${resolvedDatabaseId})`);
				patchPersonalConfig({
					databaseName: resolvedDatabaseName,
					databaseId: resolvedDatabaseId,
					databaseIdIsSet: false
				});
			}
		}
	}

	// 4. R2.
	say('4. R2 bucket');
	would(`would create the bucket ${bucket} (an existing bucket is fine)`);
	if (!DRY) {
		// Quiet: an existing bucket is the normal answer on a re-run, and
		// wrangler prints it as a red ERROR block (code 10004) that reads like a
		// failure. The verdict line below is what the operator needs; a real
		// failure still prints wrangler's text, from the fail() call.
		const created = wrangler(['r2', 'bucket', 'create', bucket], {
			allowFailure: true,
			quiet: true
		});
		const text = `${created.stdout}${created.stderr}`;
		if (created.status !== 0 && !/already exists|10004|10073/i.test(text)) {
			fail(`could not create ${bucket}:\n${text}`);
		}
		did(created.status === 0 ? `created ${bucket}` : `${bucket} already exists`);
	}

	// 5. Work out which secrets to upload, and which to leave alone.
	say('5. Secrets');
	const vars = readDevVars();
	const reusable = (key) => {
		const current = vars.get(key);
		return current && !isPlaceholderValue(current) ? current : null;
	};
	const listed = readWorkerSecrets({
		run: (cmdArgs) =>
			// readOnly keeps it running in a dry run, and quiet/allowFailure keep
			// the fallback attempts from printing a wall of CLI errors.
			wrangler(cmdArgs, { readOnly: true, quiet: true, allowFailure: true })
	});
	if (!listed.ok && !listed.missingWorker) {
		// Never guess here. Assuming "no secrets" would upload a new
		// APP_ENCRYPTION_KEY and orphan every stored credential; assuming "they
		// are set" would leave a fresh deployment with no key at all. Neither is
		// a decision this script gets to make silently.
		fail(
			`could not read the Worker secret list (${listed.reason ?? 'unknown error'}).\n` +
				'Re-run with --rotate-secrets if you mean to upload a new APP_ENCRYPTION_KEY,\n' +
				'or check `node scripts/wrangler.mjs secret list` by hand.'
		);
	}
	const existingSecrets = new Set(listed.names);
	const uploads = {};

	for (const [key, fallback] of Object.entries({
		// The only secret this script brings. AUTH_SECRET and SCHEDULER_SECRET are
		// derived from it inside the Worker, and the login lives in D1 (step 7)
		// instead of in a Worker secret, so there is no password to leak here.
		APP_ENCRYPTION_KEY: () => reusable('APP_ENCRYPTION_KEY') ?? generateHex()
	})) {
		if (existingSecrets.has(key) && !ROTATE_SECRETS) {
			// Overwriting APP_ENCRYPTION_KEY orphans every stored credential and
			// rotates the secrets derived from it (sessions sign out). Not a setup
			// step: `--rotate-secrets` is how you ask for it.
			warn(`${key} is already set on the Worker — left alone`);
			continue;
		}
		const candidate = fallback();
		const problem = validateSecret(key, candidate);
		if (problem) {
			const message = `${key} ${problem}. Set it in ${DEV_VARS} before a real run.`;
			if (DRY) {
				warn(message);
				continue;
			}
			fail(message);
		}
		uploads[key] = candidate;
	}

	if (!DRY && Object.keys(uploads).length > 0) {
		writeDevVars(uploads);
		info(`wrote the generated values to ${DEV_VARS}`);
	}
	// 6. Build, then migrations against the real database.
	say('6. Build and migrations');
	if (SKIP_DEPLOY) {
		info('--skip-deploy: stopping before the build');
	} else {
		run('npm', ['run', 'build']);
		// The app bootstraps its own schema on the first request, and the cron
		// trigger makes that request within a minute of any deploy — so a
		// database this script meets is often schema-complete with an empty
		// history, and a plain replay would abort on 0001 ("table `users`
		// already exists"). Record what it already satisfies first, exactly as
		// `deploy:release` and `db:migrate:remote` do.
		if (!DRY) {
			await syncMigrations({
				exec: async (sql) => {
					d1Json(sql);
				},
				query: async (sql) => d1Json(sql),
				log: (line) => console.log(line)
			});
		} else {
			console.log('  $ node scripts/wrangler.mjs d1 execute DB --remote ...   (skipped: dry run)');
		}
		wrangler(['d1', 'migrations', 'apply', 'DB', '--remote']);
	}

	// 7. The account, created before the Worker is reachable. This is what makes
	// the instance safe from its first request: the users table is never empty
	// while anyone could find the URL, so there is nothing to claim.
	say('7. The account');
	let adminPassword = '';
	let accountWritten = false;
	const existingAccount = await readAccount({ wrangler });
	if (!existingAccount.ok) {
		warn(`could not read the users table (${existingAccount.error})`);
		warn('carrying on: the insert below only lands while that table is empty');
	}
	let adminEmail = normalizeEmail(value('--admin-email', null) ?? existingAccount.email ?? '');
	// What the closing "Next" should promise: an account that already has an
	// authenticator is not going to be asked for one again.
	let totpEnrolled = Boolean(existingAccount.totpEnrolled);
	if (SKIP_DEPLOY) {
		info('--skip-deploy: the account is created on the next full run');
	} else if (existingAccount.exists && !RESET_LOGIN) {
		info(`an account already exists (${existingAccount.email}) — left alone`);
		info('pass --reset-login to give it a new password instead');
	} else if (DRY && !adminEmail) {
		// A dry run cannot prompt, and an account with no address is not a plan
		// worth printing: report the step and move on.
		would('would ask for the admin email and a password, then create the account');
	} else {
		if (!adminEmail) adminEmail = normalizeEmail(await ask('Admin email for this instance', ''));
		if (adminEmail === PLACEHOLDER_EMAIL) {
			fail(`${adminEmail} is the example address from the docs — use one you own`);
		}
		const emailIssue = emailProblem(adminEmail);
		if (emailIssue) {
			fail(`${adminEmail || '(empty)'}: ${emailIssue} — pass --admin-email you@example.com`);
		}
		if (existingAccount.email && existingAccount.email !== adminEmail) {
			fail(
				`--reset-login rewrites ${existingAccount.email}, it does not move it to ${adminEmail}.\n` +
					'Sign in and change the address in Settings → Login.'
			);
		}
		adminPassword = value('--admin-password', null) ?? '';
		const iterations = KDF_ITERATIONS;
		if (DRY) {
			would(
				existingAccount.exists
					? `would give ${adminEmail} a new password (PBKDF2-SHA256, ${iterations} iterations) and revoke every session`
					: `would create the account ${adminEmail} (PBKDF2-SHA256, ${iterations} iterations)`
			);
		} else {
			// A password is only invented or asked for on a run that will use it.
			let generatedPassword = false;
			if (!adminPassword) {
				const typed = await askSecret('Admin password (press enter to generate one)');
				adminPassword = typed || generatePassword();
				generatedPassword = !typed;
			}
			const passwordIssue = passwordProblem(adminPassword);
			if (passwordIssue) {
				fail(`${passwordIssue} — pass --admin-password with at least ${PASSWORD_MIN} characters`);
			}
			const seed = { wrangler, email: adminEmail, password: adminPassword, iterations };
			if (existingAccount.exists) await resetAccount(seed);
			else await seedAccount(seed);
			accountWritten = true;
			did(
				existingAccount.exists
					? `password replaced for ${adminEmail}; every session revoked`
					: `account created: ${adminEmail}`
			);
			if (generatedPassword) {
				console.log(`
  Password for ${adminEmail} — shown once, store it in a password manager:

      ${adminPassword}

  Change it later in Settings → Login, or with \`npm run admin:reset\`.`);
			}
		}
	}

	// 8. First deploy: creates the Worker (and provisions anything still missing).
	let siteUrl = '';
	if (!SKIP_DEPLOY) {
		say('8. Deploy');
		const deployed = wrangler(['deploy'], { allowFailure: true });
		const text = `${deployed.stdout}${deployed.stderr}`;
		if (deployed.status !== 0) fail(`deploy failed:\n${text}`);
		const found = text.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i);
		if (found) {
			siteUrl = found[0];
			did(`deployed: ${siteUrl}`);
		} else {
			did('deployed, but the URL was not in the output');
		}
	}

	if (SKIP_DEPLOY) {
		say('Done (--skip-deploy).');
		console.log(`
Next:
  1. Deploy the Worker: npm run deploy
  2. Re-run this script (npm run setup): it skips what already exists, uploads the
     secrets, creates the account and pins APP_URL to the deployed URL.`);
		return;
	}

	// 9. Upload the secrets (the Worker exists now) and set APP_URL.
	say('9. Upload secrets');
	for (const [key, value] of Object.entries(uploads)) {
		wrangler(['secret', 'put', key], { input: `${value}\n` });
		did(`${key} set`);
	}
	if (Object.keys(uploads).length === 0) warn('nothing to upload — every secret already exists');

	if (!siteUrl && !DRY) {
		const answer = await ask(
			'Public URL of this deployment (leave empty to set APP_URL later)',
			''
		);
		siteUrl = answer && /^https:\/\//.test(answer) ? answer.replace(/\/$/, '') : '';
	}
	if (siteUrl) {
		// Pin APP_URL to the URL this run deployed to. Optional — an unset
		// APP_URL follows the host each request arrives on — but pinning makes
		// absolute links and OAuth redirect URIs deterministic from the first
		// scheduled tick, before anyone has opened the app.
		if (!existingSecrets.has('APP_URL')) {
			wrangler(['secret', 'put', 'APP_URL'], { input: `${siteUrl}\n` });
			did(`APP_URL pinned to ${siteUrl}`);
		} else {
			warn(`APP_URL is already set on the Worker — left alone (expected ${siteUrl})`);
		}
	} else {
		info('APP_URL left unset — the app follows the host each request arrives on.');
	}

	// 10. Deploy again so the secrets are live, then prove the login works.
	say('10. Redeploy with the secrets');
	wrangler(['deploy']);
	if (siteUrl && accountWritten && !DRY) {
		say('11. Check the login');
		const check = await verifyLogin(siteUrl, adminEmail, adminPassword);
		if (check.ok) {
			did(
				`the Worker accepted the password${check.totp ? ' and asked for an authenticator code' : ''}`
			);
		} else {
			warn(`the Worker did not accept the sign-in yet: ${check.error}`);
			warn('if the browser login fails too, run `npm run doctor`');
		}
	}

	say(DRY ? 'Dry run finished — nothing was created or changed.' : 'Done.');
	if (!DRY) {
		console.log(`
Next:
  1. Open ${siteUrl || 'your Worker URL'} and sign in as ${adminEmail || 'the account you created'}.
     ${totpEnrolled ? 'The authenticator you enrolled is unchanged.' : 'You will be asked to set up an authenticator app; save the backup codes.'}
  2. Connect accounts (Accounts → Connect new).
  3. Scheduled posts publish themselves: the Worker's cron trigger runs every
     minute; AUTH_SECRET and SCHEDULER_SECRET are derived from APP_ENCRYPTION_KEY.
     If the deploy above could not attach the trigger (an account can hold only
     five on the free plan), Settings → Scheduled publishing has the tick URL and
     a token for an external cron. Setting SCHEDULER_SECRET
     (\`openssl rand -hex 32\`) works too — see docs/scheduling.md.
  4. Local dev uses the same secrets in ${DEV_VARS}; run \`npm run dev\`.`);
	}
}

main().catch((err) => fail(err?.message ?? String(err)));
