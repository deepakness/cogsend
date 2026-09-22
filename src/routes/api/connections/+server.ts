import { and, desc, eq, ne } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { connections } from '$lib/server/db/schema';
import { handleError, ok } from '$lib/server/http';
import { requireScope, requireUser } from '$lib/server/require';
import { serializeConnection } from '$lib/server/serialize';

export const GET: RequestHandler = async ({ locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');
		// Slim select: never ship credentialsEncrypted/userId/updatedAt to the
		// client (serializeConnection drops them anyway). Saves D1 bytes on
		// every Accounts/Composer load.
		const rows = await locals.db
			.select({
				id: connections.id,
				platform: connections.platform,
				displayName: connections.displayName,
				handle: connections.handle,
				avatarUrl: connections.avatarUrl,
				instanceUrl: connections.instanceUrl,
				status: connections.status,
				metaJson: connections.metaJson,
				createdAt: connections.createdAt
			})
			.from(connections)
			// Disconnected rows are archive tombstones (published posts keep
			// referencing them); they are not connectable accounts and must
			// not render as expired accounts waiting for a reconnect.
			.where(and(eq(connections.userId, user.id), ne(connections.status, 'disconnected')))
			.orderBy(desc(connections.createdAt));
		// OAuth platforms needing server-side app credentials: the accounts
		// dialog renders its setup panel from this without a failed POST.
		// Presence only — a wrong id still counts and fails at the provider.
		const configured = {
			linkedin: Boolean(locals.env.LINKEDIN_CLIENT_ID && locals.env.LINKEDIN_CLIENT_SECRET),
			threads: Boolean(locals.env.THREADS_APP_ID && locals.env.THREADS_APP_SECRET),
			x: Boolean(locals.env.X_CLIENT_ID)
		};
		// The setup panel has to show the redirect URI the connect routes will
		// actually send, which is the deployment's APP_URL, not necessarily the
		// origin the browser is on.
		return ok({
			connections: rows.map(serializeConnection),
			configured,
			appUrl: locals.env.APP_URL
		});
	} catch (err) {
		return handleError(err);
	}
};
