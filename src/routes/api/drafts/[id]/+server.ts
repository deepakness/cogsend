import { and, eq, inArray, type InferSelectModel } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { parseDraftBody, parseDraftTitle } from '$lib/domain/validation/draft-fields';
import { batchQueries, first } from '$lib/server/db/client';
import {
	connections,
	draftMedia,
	drafts,
	draftVariants,
	publishTargets
} from '$lib/server/db/schema';
import { fail, handleError, ok } from '$lib/server/http';
import { draftHasInFlightPublish } from '$lib/server/publish-plan';
import { requireScope, requireUser } from '$lib/server/require';
import { serializeDraft } from '$lib/server/serialize';
import { normalizeSelectedConnectionIds } from '$lib/domain/request-limits';

async function loadDraft(locals: App.Locals, id: string, userId: string) {
	type TargetRow = InferSelectModel<typeof publishTargets>;
	// Draft + relations in one round trip; connection lookups in a second.
	const [draftRows, variants, media, targets] = (await batchQueries(locals.db, [
		locals.db
			.select()
			.from(drafts)
			.where(and(eq(drafts.id, id), eq(drafts.userId, userId))),
		locals.db.select().from(draftVariants).where(eq(draftVariants.draftId, id)),
		locals.db.select().from(draftMedia).where(eq(draftMedia.draftId, id)),
		locals.db.select().from(publishTargets).where(eq(publishTargets.draftId, id))
	])) as [
		InferSelectModel<typeof drafts>[],
		InferSelectModel<typeof draftVariants>[],
		InferSelectModel<typeof draftMedia>[],
		TargetRow[]
	];
	const draft = draftRows[0];
	if (!draft) return null;
	media.sort((a, b) => a.sortOrder - b.sortOrder);
	const connIds = [...new Set(targets.map((t) => t.connectionId))];
	type ConnRow = {
		id: string;
		platform: string;
		handle: string | null;
		displayName: string | null;
	};
	const connRows: ConnRow[] = connIds.length
		? (
				(await batchQueries(locals.db, [
					locals.db
						.select({
							id: connections.id,
							platform: connections.platform,
							handle: connections.handle,
							displayName: connections.displayName
						})
						.from(connections)
						.where(inArray(connections.id, connIds))
				])) as ConnRow[][]
			)[0]
		: [];
	const connById = new Map(connRows.map((c) => [c.id, c]));
	const withConn = targets.map((t) => ({ ...t, connection: connById.get(t.connectionId) }));
	return serializeDraft(draft, { variants, media, targets: withConn });
}

export const GET: RequestHandler = async ({ params, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');
		const draft = await loadDraft(locals, params.id, user.id);
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
			return fail('Publishing in progress — try again shortly', 409);
		}
		const body = await request.json().catch(() => null);
		if (!body || typeof body !== 'object') return fail('Invalid JSON body', 400);
		const selection = normalizeSelectedConnectionIds(body.selectedConnectionIds);
		if (!selection.ok) return fail(selection.error, 400);
		// Validate before the UPDATE: a non-string reaches the driver as a 500,
		// and an unbounded string is stored as-is.
		const patch: { title?: string | null; baseBody?: string; selectedConnectionIds?: string } = {};
		if (body.title !== undefined) {
			const title = parseDraftTitle(body.title);
			if (!title.ok) return fail(title.error, 400);
			patch.title = title.value;
		}
		if (body.baseBody !== undefined) {
			const text = parseDraftBody(body.baseBody);
			if (!text.ok) return fail(text.error, 400);
			patch.baseBody = text.value;
		}
		if (selection.value !== undefined) patch.selectedConnectionIds = selection.value;
		await locals.db
			.update(drafts)
			.set({
				...patch,
				updatedAt: new Date()
			})
			.where(eq(drafts.id, params.id));
		// Autosave only needs an acknowledgement; the client already holds the
		// saved state, so skip the full reload the GET performs.
		return ok({ ok: true });
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
		for (const f of files) await locals.media.delete(f.storageKey);
		await locals.db.delete(drafts).where(eq(drafts.id, params.id));
		return ok({ ok: true });
	} catch (err) {
		return handleError(err);
	}
};
