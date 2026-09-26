#!/usr/bin/env node
/**
 * Apply pending migrations, remote or local, to a database the app may have
 * bootstrapped itself.
 *
 * `wrangler d1 migrations apply` alone cannot do that: the app creates its own
 * schema on the first request, so a database deployed that way already has
 * every table and no history — and replaying 0001 (`CREATE TABLE users`) or
 * 0013 (`ALTER TABLE sessions ADD COLUMN`) aborts. This records the migrations
 * whose postconditions already hold, then lets wrangler run the rest.
 *
 * Usage:
 *   npm run db:migrate:remote                       # your deployed database
 *   npm run db:migrate:local                        # the local one
 *   npm run db:migrate:local -- --persist-to .wrangler/e2e-state
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ui from './lib/cli.mjs';
import { syncMigrations } from './lib/migration-sync.mjs';
import { guardTarget } from './lib/target-account.mjs';
import { runWrangler, wranglerOutput } from './lib/wrangler-run.mjs';

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));

const argv = process.argv.slice(2);
const local = argv.includes('--local');
const passthrough = argv.filter((arg) => arg !== '--local' && arg !== '--remote');
const scope = local ? '--local' : '--remote';

/** Through the repo wrapper, so `wrangler.personal.jsonc` and WRANGLER_PROFILE
 *  apply as they do everywhere else. */
function wrangler(args) {
	return runWrangler(args, {
		onRetry: () => ui.note('Cloudflare login was just refreshed, retrying…')
	});
}

/** Both streams: the wrapper's command line is on stderr, Cloudflare's error on stdout. */
function fail(result, what) {
	process.stderr.write(`${ui.stripToolNoise(wranglerOutput(result))}\n`);
	ui.error(`${what} failed (${local ? 'local' : 'remote'} database).`);
	process.exit(result.status ?? 1);
}

function d1Json(sql) {
	const result = wrangler([
		'd1',
		'execute',
		'DB',
		scope,
		...passthrough,
		'--json',
		'--command',
		sql
	]);
	if (result.status !== 0) fail(result, 'checking the database');
	const parsed = JSON.parse(result.stdout);
	return parsed[0]?.results ?? [];
}

if (!local) {
	guardTarget({
		args: passthrough,
		print: (headline, notes, verdict) => {
			(verdict === 'unknown' ? ui.warn : ui.ok)(headline);
			for (const line of notes) ui.note(line);
		},
		refuse: (headline, notes) => {
			ui.error(`${headline}\n`);
			for (const line of notes) ui.note(line);
			process.exit(1);
		}
	});
}

const { recorded } = await syncMigrations({
	exec: async (sql) => {
		const result = wrangler(['d1', 'execute', 'DB', scope, ...passthrough, '--command', sql]);
		if (result.status !== 0) fail(result, 'recording migrations');
	},
	query: async (sql) => d1Json(sql),
	log: () => {}
});

// Captured: wrangler reprints its whole table after every migration applied, so
// a first run is ~300 lines of box drawing. The summary is the news.
const applied = wrangler(['d1', 'migrations', 'apply', 'DB', scope, ...passthrough]);
const text = wranglerOutput(applied);
if (applied.status !== 0) fail(applied, 'applying migrations');
if (ui.isVerbose()) process.stdout.write(`${ui.stripToolNoise(text)}\n`);
ui.ok(ui.migrationsSummary(text) ?? `${local ? 'local' : 'remote'} database up to date`);
if (recorded.length) ui.note(`${recorded.length} already present, recorded as applied`);
process.exit(0);
