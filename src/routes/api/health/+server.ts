import { json } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { first } from '$lib/server/db/client';
import { users } from '$lib/server/db/schema';

export const GET: RequestHandler = async ({ locals }) => {
	try {
		await locals.db.run(sql`SELECT 1`);
		// The version is public on purpose: `npm run doctor` compares what is
		// actually deployed with the latest release, and it is already shown in
		// Settings.
		//
		// `account` tells doctor "deployed and ready" apart from "deployed, but
		// nobody has created the account yet", which is otherwise invisible from
		// outside. It discloses nothing a visitor cannot see on the login page:
		// either a form, or a notice saying to run `npm run setup`.
		const account = await first(
			locals.db.select({ totpEnabled: users.totpEnabled }).from(users).limit(1)
		);
		return json({
			ok: true,
			service: 'cogsend',
			version: __APP_VERSION__,
			time: new Date().toISOString(),
			account: { created: Boolean(account), totpEnrolled: Boolean(account?.totpEnabled) }
		});
	} catch (err) {
		// Never leak driver internals on a public endpoint.
		console.error('[health] db probe failed', err);
		return json({ ok: false, error: 'unavailable' }, { status: 503 });
	}
};
