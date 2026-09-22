#!/usr/bin/env node
/**
 * Seed `.dev.vars` for the e2e suite.
 *
 * `wrangler dev` (and so `npm run preview`) reads `.dev.vars`. A fresh clone or
 * a CI runner has none, which used to make the suite fail before the first
 * test. Copy the committed fixture in that case only — an existing `.dev.vars`
 * belongs to the developer and is left exactly as it is.
 *
 * Wired into `npm run test:e2e` ahead of playwright.
 */
import { chmodSync, copyFileSync, existsSync } from 'node:fs';

const TARGET = '.dev.vars';
const FIXTURE = 'tests/e2e/fixtures/dev.vars';

if (existsSync(TARGET)) {
	console.log(`e2e: using the existing ${TARGET}`);
} else {
	copyFileSync(FIXTURE, TARGET);
	try {
		chmodSync(TARGET, 0o600);
	} catch {
		// Filesystems without POSIX permissions simply skip this.
	}
	console.log(`e2e: seeded ${TARGET} from ${FIXTURE}`);
}
