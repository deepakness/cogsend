/**
 * Tests run without the developer's Cloudflare CLI environment.
 *
 * `scripts/wrangler.mjs` appends `--profile <name>` when `WRANGLER_PROFILE` is
 * set, and every spawn in the suite copies `process.env` into the child. So a
 * developer who picks an account the documented way — `WRANGLER_PROFILE=my-account
 * npm test` — changed what the recorded wrapper was asked to run, and the
 * assertion that reads that argv failed on the variable alone. CI has none of
 * these set, which is exactly why it never showed up there.
 *
 * The credentials go too. Nothing in the suite talks to Cloudflare (every test
 * fakes the CLI), so a real token has no business being visible to it: removing
 * it removes the chance that a test which forgets to fake something reaches a
 * live account.
 *
 * The account check's variables go for the same reason: `npm run deploy:release`
 * sets COGSEND_TARGET_CHECKED before it runs this suite, and an operator moving
 * an instance sets COGSEND_ALLOW_ACCOUNT_CHANGE, and either one turns the
 * refusal the suite asserts into a pass.
 *
 * Deleted rather than blanked: an empty string is still a value to anything that
 * asks whether a variable is set.
 */
for (const name of [
	'WRANGLER_PROFILE',
	'CLOUDFLARE_API_TOKEN',
	'CLOUDFLARE_ACCOUNT_ID',
	'COGSEND_TARGET_CHECKED',
	'COGSEND_ALLOW_ACCOUNT_CHANGE'
]) {
	delete process.env[name];
}
