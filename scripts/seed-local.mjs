#!/usr/bin/env node
/**
 * Put a login into the *local* database, so `npm run dev` has an account to sign
 * in with.
 *
 * Local development used to rely on the environment-variable login: the app
 * bootstrapped a row from `.dev.vars` on the first request. That mode is gone —
 * the account is created once, in D1, by `npm run setup` — so a local database
 * needs the same treatment, from the same code, against `--local` instead of
 * `--remote`.
 *
 * Idempotent: an existing local account is left alone unless `--reset` is given.
 * The e2e harness runs this too, which is why the defaults are a throwaway
 * account rather than anything an operator would choose.
 *
 * Usage:
 *   npm run db:seed:local                                   # dev@localhost, generated password printed once
 *   npm run db:seed:local -- --password 'devpassword'        # a password you can remember
 *   npm run db:seed:local -- --email me@localhost
 *   npm run db:seed:local -- --reset                         # replace an existing local account
 *   npm run db:seed:local -- --persist-to .wrangler/e2e-state  # a different local state (the e2e suite does this)
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	PASSWORD_MIN,
	emailProblem,
	generatePassword,
	normalizeEmail,
	passwordProblem,
	readAccount,
	resetAccount,
	seedAccount
} from './lib/account.mjs';
import { syncMigrations } from './lib/migration-sync.mjs';

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const value = (name, fallback = null) => {
	const i = argv.indexOf(name);
	const next = argv[i + 1];
	return i >= 0 && next && !next.startsWith('--') ? next : fallback;
};

const DEFAULT_EMAIL = 'dev@localhost';
const RESET = has('--reset');
/** Keeps a caller's local state separate: the e2e suite passes its own. */
const PERSIST_TO = value('--persist-to', null);
const extraArgs = PERSIST_TO ? ['--persist-to', PERSIST_TO] : [];

/** Through the repo wrapper, so `wrangler.personal.jsonc` and `WRANGLER_PROFILE`
 *  apply as they do for every other script. Failures are returned, not fatal:
 *  lib/account.mjs decides what they mean. */
function wrangler(args, opts = {}) {
	if (!opts.quiet) console.log(`  $ node scripts/wrangler.mjs ${args.join(' ')}`);
	const result = spawnSync('node', ['scripts/wrangler.mjs', ...args], { encoding: 'utf8' });
	if (!opts.quiet) {
		if (result.stdout?.trim()) console.log(result.stdout.trimEnd());
		if (result.stderr?.trim()) console.error(result.stderr.trimEnd());
	}
	return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

async function main() {
	console.log('Local account');

	// The local database is created by the first `wrangler dev`/`d1` call, and
	// the tables come from the migrations. Applying them here (idempotently)
	// means the insert below cannot land on a database with no users table.
	// A database `wrangler dev` already bootstrapped has the schema but no
	// history, so record what it satisfies first — otherwise the replay aborts
	// on 0001 (`CREATE TABLE users`). Same helper as `npm run db:migrate:local`.
	try {
		await syncMigrations({
			exec: async (sql) => {
				const result = wrangler(
					['d1', 'execute', 'DB', '--local', ...extraArgs, '--command', sql],
					{ quiet: true }
				);
				if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'd1 failed');
			},
			query: async (sql) => {
				const result = wrangler(
					['d1', 'execute', 'DB', '--local', ...extraArgs, '--json', '--command', sql],
					{ quiet: true }
				);
				if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'd1 failed');
				return JSON.parse(result.stdout)[0]?.results ?? [];
			},
			log: (line) => console.log(line)
		});
	} catch (err) {
		console.log(`  ! could not read the existing schema (${err?.message ?? err}) — continuing`);
	}
	const migrated = wrangler(['d1', 'migrations', 'apply', 'DB', '--local', ...extraArgs], {
		quiet: true
	});
	if (migrated.status !== 0) {
		// eslint-disable-next-line no-control-regex -- terminal colours from wrangler
		const colour = /\u001b\[[0-9;]*m/g;
		const lines = `${migrated.stdout ?? ''}${migrated.stderr ?? ''}`
			.replace(colour, '')
			.split('\n')
			.map((line) => line.trim())
			.filter(Boolean);
		// The banner and the log-file footer are noise; the error line is not.
		const detail = (
			lines.find((line) => /error|already exists|failed/i.test(line)) ??
			lines[0] ??
			''
		).slice(0, 160);
		console.log(`  ! local migrations did not apply (${detail}) — continuing`);
	}

	const account = await readAccount({ wrangler, remote: false, extraArgs });
	if (!account.ok) {
		throw new Error(`could not read the local database: ${account.error}`);
	}
	const email = normalizeEmail(value('--email', account.email ?? DEFAULT_EMAIL));
	const emailIssue = emailProblem(email);
	if (emailIssue) throw new Error(`${email}: ${emailIssue}`);

	if (account.exists && !RESET) {
		console.log(`  ${account.email} already exists locally — left alone`);
		console.log(
			email === account.email
				? '  --reset gives it a new password'
				: `  --reset --email ${email} replaces it; without --reset this database keeps ${account.email}`
		);
		return;
	}

	const password = value('--password', null) ?? generatePassword();
	const passwordIssue = passwordProblem(password);
	if (passwordIssue) throw new Error(`${passwordIssue} — at least ${PASSWORD_MIN} characters`);
	if (account.exists && account.email !== email) {
		throw new Error(`the local account is ${account.email}; --reset rewrites it, not ${email}`);
	}

	try {
		if (account.exists) await resetAccount({ wrangler, email, password, remote: false, extraArgs });
		else await seedAccount({ wrangler, email, password, remote: false, extraArgs });
	} catch (err) {
		const message = err?.message ?? String(err);
		if (/no such table/i.test(message)) {
			throw new Error(
				`${message}\nThe local database has no tables yet: run \`npm run db:migrate:local\` first.`,
				{ cause: err }
			);
		}
		throw err;
	}

	console.log(`
  ${account.exists ? 'Password replaced' : 'Account created'}: ${email}
  Password: ${password}

  Sign in at http://localhost:5173 with those. Set SKIP_TOTP=1 in .dev.vars to
  skip the authenticator prompt while developing (honored on localhost only).`);
}

main().catch((err) => {
	console.error(`\n✘ ${err?.message ?? String(err)}`);
	process.exit(1);
});
