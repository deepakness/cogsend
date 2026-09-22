import { eq } from 'drizzle-orm';
import type { LayoutServerLoad } from './$types';
import { first } from '$lib/server/db/client';
import { users } from '$lib/server/db/schema';
import { parseProfileSettings } from '$lib/domain/profile-settings';
import { readStoredAppName } from '$lib/server/app-settings';

export const load: LayoutServerLoad = async ({ locals }) => {
	let displayName: string | null = null;
	let profilePictureUrl: string | null = null;
	if (locals.user) {
		const row = await first(
			locals.db
				.select({ displayName: users.displayName, settingsJson: users.settingsJson })
				.from(users)
				.where(eq(users.id, locals.user.id))
		).catch(() => null);
		displayName = row?.displayName ?? null;
		profilePictureUrl = parseProfileSettings(row?.settingsJson).profilePictureUrl;
	}
	// The name set in Settings → Instance wins; the APP_NAME var (and the
	// built-in default) is the fallback, and the cached read is per isolate.
	const storedAppName = await readStoredAppName(locals.db);
	return {
		user: locals.user,
		displayName,
		profilePictureUrl,
		appName: storedAppName ?? locals.env.APP_NAME
	};
};
