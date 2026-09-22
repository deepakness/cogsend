import { and, desc, eq, ne } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { parseProfileSettings } from '$lib/domain/profile-settings';
import { batchQueries } from '$lib/server/db/client';
import { connections, users } from '$lib/server/db/schema';
import { requireUser } from '$lib/server/require';
import { serializeConnection } from '$lib/server/serialize';

// Server-render the account list with the document so the editor paints
// accounts on first paint instead of waiting for a client round trip.
export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals.user);
	const [rows, userRows] = (await batchQueries(locals.db, [
		locals.db
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
			// Archive tombstones are not selectable destinations.
			.where(and(eq(connections.userId, user.id), ne(connections.status, 'disconnected')))
			.orderBy(desc(connections.createdAt)),
		locals.db
			.select({ settingsJson: users.settingsJson, displayName: users.displayName })
			.from(users)
			.where(eq(users.id, user.id))
	])) as [
		Array<{
			id: string;
			platform: string;
			displayName: string | null;
			handle: string | null;
			avatarUrl: string | null;
			instanceUrl: string | null;
			status: string;
			metaJson: string;
			createdAt: Date;
		}>,
		{ settingsJson: string | null; displayName: string | null }[]
	];
	return {
		connections: rows.map(serializeConnection),
		settings: parseProfileSettings(userRows[0]?.settingsJson ?? null),
		displayName: userRows[0]?.displayName ?? null,
		// In-progress feature flag; the editor only mirrors it for the picker.
		videoEnabled: locals.env.videoUploadEnabled
	};
};
