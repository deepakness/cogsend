import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { validatePollConfig } from '$lib/domain/poll';
import {
	MAX_VARIANT_OPTIONS_LENGTH,
	parseSegmentBody,
	parseThreadSegments
} from '$lib/domain/validation/draft-fields';
import { first, newId } from '$lib/server/db/client';
import { drafts, draftVariants, publishTargets } from '$lib/server/db/schema';
import { fail, handleError, ok } from '$lib/server/http';
import { draftHasInFlightPublish } from '$lib/server/publish-plan';
import { requireScope, requireUser } from '$lib/server/require';

const VISIBILITIES = new Set(['public', 'unlisted', 'private', 'direct']);

// Fail fast at write time. Options that reach the database unchecked are only
// discovered at publish, where the failure is a provider error with no pointer
// to the field that caused it. Mirrors provider.validate rules.
function validateVariantOptions(options: unknown): string | null {
	if (options === undefined) return null;
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		return 'options must be an object';
	}
	const o = options as Record<string, unknown>;
	if (o.visibility !== undefined && !VISIBILITIES.has(String(o.visibility))) {
		return 'Invalid visibility';
	}
	if (o.poll !== undefined && o.poll !== null) {
		const poll = validatePollConfig(o.poll);
		if (!poll.ok) return poll.error;
	}
	if (o.threadSegments !== undefined) {
		if (!Array.isArray(o.threadSegments) || o.threadSegments.some((s) => typeof s !== 'string')) {
			return 'threadSegments must be an array of strings';
		}
	}
	return null;
}

async function rejectIfPublishing(db: App.Locals['db'], draftId: string) {
	const targets = await db.select().from(publishTargets).where(eq(publishTargets.draftId, draftId));
	if (draftHasInFlightPublish(targets)) {
		return fail('Publishing in progress — try again shortly', 409);
	}
	return null;
}
import { serializeVariant } from '$lib/server/serialize';

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const draft = await first(
			locals.db
				.select()
				.from(drafts)
				.where(and(eq(drafts.id, params.id), eq(drafts.userId, user.id)))
		);
		if (!draft) return fail('Not found', 404);
		const busy = await rejectIfPublishing(locals.db, params.id);
		if (busy) return busy;
		const body = await request.json().catch(() => null);
		if (!body || typeof body !== 'object') return fail('Invalid JSON body', 400);
		const optionsError = validateVariantOptions(body.options);
		if (optionsError) return fail(optionsError);
		const segments = parseThreadSegments(body.options?.threadSegments ?? []);
		if (!segments.ok) return fail(segments.error, 400);
		if (body.body !== undefined) {
			const text = parseSegmentBody(body.body);
			if (!text.ok) return fail(text.error, 400);
		}
		const platform = String(body.platform || '');
		if (
			platform !== 'mastodon' &&
			platform !== 'bluesky' &&
			platform !== 'linkedin' &&
			platform !== 'threads' &&
			platform !== 'x'
		) {
			return fail('platform must be mastodon, bluesky, linkedin, threads, or x');
		}
		const existing = await first(
			locals.db
				.select()
				.from(draftVariants)
				.where(and(eq(draftVariants.draftId, params.id), eq(draftVariants.platform, platform)))
		);
		const now = new Date();
		const optionsJson =
			body.options !== undefined
				? JSON.stringify(body.options ?? {})
				: (existing?.optionsJson ?? '{}');
		// Bounds the column, not just each field: `threadSegments` is an array of
		// full-length posts, and a 10MB statement is a driver error, not a 400.
		if (optionsJson.length > MAX_VARIANT_OPTIONS_LENGTH) {
			return fail(
				`Variant options are too large to save (${optionsJson.length} characters, max ${MAX_VARIANT_OPTIONS_LENGTH})`,
				400
			);
		}
		const variant = existing
			? (
					await locals.db
						.update(draftVariants)
						.set({
							body: body.body !== undefined ? body.body : existing.body,
							optionsJson,
							updatedAt: now
						})
						.where(eq(draftVariants.id, existing.id))
						.returning()
				)[0]
			: (
					await locals.db
						.insert(draftVariants)
						.values({
							id: newId(),
							draftId: params.id,
							platform,
							body: body.body ?? null,
							optionsJson,
							createdAt: now,
							updatedAt: now
						})
						.returning()
				)[0];
		return ok({ variant: serializeVariant(variant) });
	} catch (err) {
		return handleError(err);
	}
};

export const DELETE: RequestHandler = async ({ params, url, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const draft = await first(
			locals.db
				.select()
				.from(drafts)
				.where(and(eq(drafts.id, params.id), eq(drafts.userId, user.id)))
		);
		if (!draft) return fail('Not found', 404);
		const busy = await rejectIfPublishing(locals.db, params.id);
		if (busy) return busy;
		const platform = url.searchParams.get('platform');
		if (!platform) return fail('platform required');
		await locals.db
			.delete(draftVariants)
			.where(and(eq(draftVariants.draftId, params.id), eq(draftVariants.platform, platform)));
		return ok({ ok: true });
	} catch (err) {
		return handleError(err);
	}
};
