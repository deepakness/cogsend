import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { first } from '$lib/server/db/client';
import { draftMedia, drafts } from '$lib/server/db/schema';
import { fail, handleError } from '$lib/server/http';
import { assertSafeStorageKey, serveMediaBytes } from '$lib/server/media';
import { requireScope, requireUser } from '$lib/server/require';

export const GET: RequestHandler = async ({ params, locals, request }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');
		const key = assertSafeStorageKey(params.key);
		const media = await first(
			locals.db.select().from(draftMedia).where(eq(draftMedia.storageKey, key))
		);
		if (!media) return fail('Not found', 404);
		const draft = await first(
			locals.db
				.select()
				.from(drafts)
				.where(and(eq(drafts.id, media.draftId), eq(drafts.userId, user.id)))
		);
		if (!draft) return fail('Not found', 404);
		return await serveMediaBytes(locals.media, key, request, {
			mime: media.mime,
			cacheControl: 'private, max-age=3600'
		});
	} catch (err) {
		return handleError(err);
	}
};
