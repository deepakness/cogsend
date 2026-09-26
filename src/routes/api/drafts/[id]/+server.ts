import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { updateDraft } from '$lib/server/api/operations';
import { first } from '$lib/server/db/client';
import { draftMedia, drafts, publishTargets } from '$lib/server/db/schema';
import { loadOwnedDraft } from '$lib/server/draft-record';
import { deleteMediaObjects } from '$lib/server/media';
import { fail, handleError, ok } from '$lib/server/http';
import { draftHasInFlightPublish } from '$lib/server/publish-plan';
import { requireScope, requireUser } from '$lib/server/require';

export const GET: RequestHandler = async ({ params, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');
		const draft = await loadOwnedDraft(locals.db, params.id, user.id);
		if (!draft) return fail('Not found', 404);
		return ok({ draft });
	} catch (err) {
		return handleError(err);
	}
};

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const body = await request.json().catch(() => null);
		return ok(await updateDraft(locals, user.id, params.id, body));
	} catch (err) {
		return handleError(err);
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const existing = await first(
			locals.db
				.select()
				.from(drafts)
				.where(and(eq(drafts.id, params.id), eq(drafts.userId, user.id)))
		);
		if (!existing) return fail('Not found', 404);
		const liveTargets = await locals.db
			.select()
			.from(publishTargets)
			.where(eq(publishTargets.draftId, params.id));
		if (draftHasInFlightPublish(liveTargets)) {
			// Deleting mid-publish orphans the remote post (fenced write finds
			// no row → `preempted` with no record) and races media cleanup.
			return fail('Publishing in progress — try again shortly', 409);
		}
		const files = await locals.db
			.select()
			.from(draftMedia)
			.where(eq(draftMedia.draftId, params.id));
		// Delete R2 objects BEFORE the draft row: a crash between the two
		// then leaves rows behind (retryable) instead of orphaned bytes.
		// Object deletes are idempotent, so retrying is safe.
		await deleteMediaObjects(
			locals.media,
			files.map((file) => file.storageKey)
		);
		await locals.db.delete(drafts).where(eq(drafts.id, params.id));
		return ok({ ok: true });
	} catch (err) {
		return handleError(err);
	}
};
