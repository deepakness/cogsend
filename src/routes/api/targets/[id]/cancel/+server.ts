import { and, eq, inArray, lte, or } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { STALE_CLAIM_MS } from '$lib/domain/due-jobs';
import { first } from '$lib/server/db/client';
import { drafts, publishTargets } from '$lib/server/db/schema';
import { fail, handleError, ok } from '$lib/server/http';
import { refreshDraftStatus } from '$lib/server/publish';
import { refuseInFlightOrPublished } from '$lib/server/publish-plan';
import { requireScope, requireUser } from '$lib/server/require';

export const POST: RequestHandler = async ({ params, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const target = await first(
			locals.db.select().from(publishTargets).where(eq(publishTargets.id, params.id))
		);
		if (!target) return fail('Not found', 404);
		const draft = await first(locals.db.select().from(drafts).where(eq(drafts.id, target.draftId)));
		if (!draft || draft.userId !== user.id) return fail('Not found', 404);
		if (target.status === 'published' || target.remotePostId) return fail('Already published');
		if (target.status === 'cancelled') return ok({ target });
		const now = new Date();
		const blocked = refuseInFlightOrPublished(target, now);
		if (blocked) return fail(blocked, 409);

		const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
		const [updated] = await locals.db
			.update(publishTargets)
			.set({ status: 'cancelled', jobId: null, scheduledFor: null, updatedAt: now })
			.where(
				and(
					eq(publishTargets.id, params.id),
					or(
						inArray(publishTargets.status, ['pending', 'scheduled', 'failed']),
						and(eq(publishTargets.status, 'publishing'), lte(publishTargets.updatedAt, staleBefore))
					)
				)
			)
			.returning();
		if (!updated) {
			const latest = await first(
				locals.db.select().from(publishTargets).where(eq(publishTargets.id, params.id))
			);
			if (latest?.status === 'cancelled') return ok({ target: latest });
			if (latest?.remotePostId || latest?.status === 'published') return fail('Already published');
			return fail('Already publishing', 409);
		}
		await refreshDraftStatus(locals.db, target.draftId);
		return ok({ target: updated });
	} catch (err) {
		return handleError(err);
	}
};
