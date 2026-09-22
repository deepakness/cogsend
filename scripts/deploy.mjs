#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { syncMigrations } from './lib/migration-sync.mjs';

function run(cmd, args, opts = {}) {
	console.log(`\n$ ${cmd} ${args.join(' ')}`);
	const result = spawnSync(cmd, args, {
		stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
		encoding: 'utf8'
	});
	if (result.status !== 0) {
		if (opts.capture) {
			if (result.stdout) process.stdout.write(result.stdout);
			if (result.stderr) process.stderr.write(result.stderr);
		}
		process.exit(result.status ?? 1);
	}
	return result;
}

function d1Json(sql) {
	const result = spawnSync(
		'node',
		['scripts/wrangler.mjs', 'd1', 'execute', 'DB', '--remote', '--json', '--command', sql],
		{ encoding: 'utf8' }
	);
	if (result.status !== 0) {
		process.stderr.write(result.stderr || result.stdout || 'd1 execute failed\n');
		process.exit(result.status ?? 1);
	}
	const parsed = JSON.parse(result.stdout);
	return parsed[0]?.results ?? [];
}

run('npx', ['vitest', 'run']);

// A database the app bootstrapped has the schema but no migration history, so
// record what it already satisfies before wrangler replays anything. Shared
// with `npm run db:migrate:remote` and `db:seed:local` so the three cannot
// drift apart; see scripts/lib/migration-sync.mjs.
await syncMigrations({
	exec: async (sql) => {
		d1Json(sql);
	},
	query: async (sql) => d1Json(sql),
	log: (line) => console.log(line)
});

run('node', ['scripts/wrangler.mjs', 'd1', 'migrations', 'apply', 'DB', '--remote']);
run('npm', ['run', 'build']);
run('node', ['scripts/wrangler.mjs', 'deploy']);

console.log('\nDeploy finished.');
console.log('Set a script token if you have not already: npm run secrets:put -- API_TOKEN');
console.log('Scheduled posts tick from the Worker cron trigger (wrangler.jsonc → triggers).');
console.log('If the cron trigger could not be attached, the deploy above said so; Settings →');
console.log('Scheduled publishing then has the tick URL and a token for an external cron.');
