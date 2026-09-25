import {
	and,
	asc,
	desc,
	eq,
	inArray,
	isNull,
	lte,
	ne,
	or,
	sql,
	type InferSelectModel
} from 'drizzle-orm';
import {
	countGraphemes,
	mastodonWeightedLength,
	validateBlueskyText,
	validateLinkedinText,
	validateMastodonText,
	validateThreadsText,
	validateXText
} from '$lib/domain/validation/text';
import { getProvider, isPlatformId, type PlatformId } from '$lib/server/providers';
import {
	connections,
	drafts,
	draftMedia,
	draftVariants,
	publishTargets
} from '$lib/server/db/schema';
import { batchQueries, chunkIds, first, newId } from '$lib/server/db/client';
import {
	serializeConnection,
	serializeDraft,
	serializeMedia,
	serializeVariant
} from '$lib/server/serialize';
import {
	MAX_VARIANT_OPTIONS_LENGTH,
	parseDraftBody,
	parseDraftTitle,
	parseSegmentBody,
	parseThreadSegments
} from '$lib/domain/validation/draft-fields';
import {
	normalizeSelectedConnectionIds,
	normalizeConnectionIds,
	connectionIdsOverflow,
	runAtError
} from '$lib/domain/request-limits';
import {
	classifyConnections,
	ensureTargets,
	refuseInFlightOrPublished,
	draftHasInFlightPublish
} from '$lib/server/publish-plan';
import { refreshDraftStatus, publishTarget } from '$lib/server/publish';
import { humanizedCause } from '$lib/domain/human-error';
import type { SubrequestBudget } from '$lib/server/budget';
import { randomHex } from '$lib/domain/bytes';
import { validateImageUpload, validateVideoUpload } from '$lib/domain/media-limits';
import { validatePollConfig } from '$lib/domain/poll';
import { assertSafeStorageKey } from '$lib/server/media';
import { STALE_CLAIM_MS } from '$lib/domain/due-jobs';
import { ApiOperationError } from '$lib/server/api/operation-error';
export type OperationContext = Pick<App.Locals, 'db' | 'env' | 'media'> & {
	budget?: SubrequestBudget;
	waitUntil?: (promise: Promise<unknown>) => void;
};
function invalid(message: string, status = 400, details?: Record<string, unknown>): never {
	throw new ApiOperationError(message, status, details);
}

export async function listConnections(ctx: OperationContext, userId: string) {
	const rows = await ctx.db
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
		.where(and(eq(connections.userId, userId), ne(connections.status, 'disconnected')))
		.orderBy(desc(connections.createdAt));
	return {
		connections: rows.map(serializeConnection),
		configured: {
			linkedin: Boolean(ctx.env.LINKEDIN_CLIENT_ID && ctx.env.LINKEDIN_CLIENT_SECRET),
			threads: Boolean(ctx.env.THREADS_APP_ID && ctx.env.THREADS_APP_SECRET),
			x: Boolean(ctx.env.X_CLIENT_ID)
		},
		appUrl: ctx.env.APP_URL
	};
}
export function validatePost(input: {
	text?: unknown;
	platform?: unknown;
	maxCharacters?: unknown;
}) {
	const text = String(input.text || '');
	if (text.length > 200_000) invalid('text must be 200000 characters or fewer', 413);
	const platform = input.platform as PlatformId | undefined;
	const maxCharacters = input.maxCharacters as number | undefined;
	const bluesky = validateBlueskyText(text),
		mastodon = validateMastodonText(text, maxCharacters ?? 500),
		linkedin = validateLinkedinText(text),
		threads = validateThreadsText(text),
		x = validateXText(text);
	const issues =
		platform && isPlatformId(platform)
			? getProvider(platform).validate({ text }, { maxCharacters: maxCharacters ?? 500 })
			: [];
	return {
		graphemes: countGraphemes(text),
		mastodonLength: mastodonWeightedLength(text),
		bluesky,
		mastodon,
		linkedin,
		threads,
		x,
		issues
	};
}
async function loadDraft(ctx: OperationContext, id: string, userId: string) {
	const [dr, variants, media, targets] = (await batchQueries(ctx.db, [
		ctx.db
			.select()
			.from(drafts)
			.where(and(eq(drafts.id, id), eq(drafts.userId, userId))),
		ctx.db.select().from(draftVariants).where(eq(draftVariants.draftId, id)),
		ctx.db.select().from(draftMedia).where(eq(draftMedia.draftId, id)),
		ctx.db.select().from(publishTargets).where(eq(publishTargets.draftId, id))
	])) as [
		InferSelectModel<typeof drafts>[],
		InferSelectModel<typeof draftVariants>[],
		InferSelectModel<typeof draftMedia>[],
		InferSelectModel<typeof publishTargets>[]
	];
	const draft = dr[0];
	if (!draft) return null;
	media.sort((a, b) => a.sortOrder - b.sortOrder);
	const ids = [...new Set(targets.map((t) => t.connectionId))];
	const conns = ids.length
		? await ctx.db
				.select({
					id: connections.id,
					platform: connections.platform,
					handle: connections.handle,
					displayName: connections.displayName
				})
				.from(connections)
				.where(inArray(connections.id, ids))
		: [];
	const byId = new Map(conns.map((c) => [c.id, c]));
	return serializeDraft(draft, {
		variants,
		media,
		targets: targets.map((t) => ({ ...t, connection: byId.get(t.connectionId) }))
	});
}
export async function getDraft(ctx: OperationContext, userId: string, draftId: string) {
	const draft = await loadDraft(ctx, draftId, userId);
	if (!draft) invalid('Not found', 404);
	return { draft };
}
export async function updateDraft(
	ctx: OperationContext,
	userId: string,
	id: string,
	body: unknown
) {
	const old = await first(
		ctx.db
			.select()
			.from(drafts)
			.where(and(eq(drafts.id, id), eq(drafts.userId, userId)))
	);
	if (!old) invalid('Not found', 404);
	const ts = await ctx.db.select().from(publishTargets).where(eq(publishTargets.draftId, id));
	if (draftHasInFlightPublish(ts)) invalid('Publishing in progress — try again shortly', 409);
	if (!body || typeof body !== 'object') invalid('Invalid JSON body');
	const input = body as Record<string, unknown>;
	const s = normalizeSelectedConnectionIds(input.selectedConnectionIds);
	if (!s.ok) invalid(s.error);
	const patch: { title?: string | null; baseBody?: string; selectedConnectionIds?: string } = {};
	if (input.title !== undefined) {
		const t = parseDraftTitle(input.title);
		if (!t.ok) invalid(t.error);
		patch.title = t.value;
	}
	if (input.baseBody !== undefined) {
		const b = parseDraftBody(input.baseBody);
		if (!b.ok) invalid(b.error);
		patch.baseBody = b.value;
	}
	if (s.value !== undefined) patch.selectedConnectionIds = s.value;
	await ctx.db
		.update(drafts)
		.set({ ...patch, updatedAt: new Date() })
		.where(eq(drafts.id, id));
	return { ok: true as const };
}
export async function deleteDraft(ctx: OperationContext, userId: string, id: string) {
	const old = await first(
		ctx.db
			.select()
			.from(drafts)
			.where(and(eq(drafts.id, id), eq(drafts.userId, userId)))
	);
	if (!old) invalid('Not found', 404);
	const ts = await ctx.db.select().from(publishTargets).where(eq(publishTargets.draftId, id));
	if (draftHasInFlightPublish(ts)) invalid('Publishing in progress — try again shortly', 409);
	const files = await ctx.db.select().from(draftMedia).where(eq(draftMedia.draftId, id));
	for (const f of files) await ctx.media.delete(f.storageKey);
	await ctx.db.delete(drafts).where(eq(drafts.id, id));
	return { ok: true as const };
}

export async function scheduleDraft(
	ctx: OperationContext,
	userId: string,
	draftId: string,
	body: unknown
) {
	const draft = await first(
		ctx.db
			.select()
			.from(drafts)
			.where(and(eq(drafts.id, draftId), eq(drafts.userId, userId)))
	);
	if (!draft) invalid('Not found', 404);
	if (!body || typeof body !== 'object') invalid('Invalid JSON body');
	const input = body as { connectionIds?: unknown; runAt?: unknown };
	const now = new Date();
	if (connectionIdsOverflow(input.connectionIds)) invalid('Too many connections (max 10)');
	const ids = normalizeConnectionIds(input.connectionIds);
	const runAt = input.runAt ? new Date(input.runAt as string) : null;
	if (!ids.length) invalid('connectionIds required');
	const problem = runAtError(input.runAt, now);
	if (problem) invalid(problem);
	if (!runAt) invalid('runAt required (ISO date)');
	const conns = await ctx.db
		.select()
		.from(connections)
		.where(
			and(
				eq(connections.userId, userId),
				inArray(connections.id, ids),
				eq(connections.status, 'active')
			)
		);
	if (conns.length !== ids.length) invalid('One or more connections not found');
	const classified = await classifyConnections(ctx.db, draftId, conns, now);
	const already = classified.filter((i) => i.kind === 'published').map((i) => i.connectionId);
	const flight = classified.filter((i) => i.kind === 'inFlight').map((i) => i.connectionId);
	if (already.length || flight.length)
		invalid(flight.length ? 'Already publishing' : 'Already published', 409, {
			alreadyPublished: already,
			inFlight: flight
		});
	const ensured = await ensureTargets(ctx.db, draftId, conns, 'schedule', runAt, now);
	const blocked = ensured.filter((i) => i.alreadyPublished || i.inFlight);
	if (blocked.length)
		invalid(blocked.some((i) => i.inFlight) ? 'Already publishing' : 'Already published', 409, {
			alreadyPublished: blocked.filter((i) => i.alreadyPublished).map((i) => i.target.connectionId),
			inFlight: blocked.filter((i) => i.inFlight).map((i) => i.target.connectionId)
		});
	await refreshDraftStatus(ctx.db, draftId);
	return { targets: ensured.map((i) => i.target), scheduledFor: runAt.toISOString() };
}

export async function cancelDelivery(ctx: OperationContext, userId: string, id: string) {
	const target = await first(ctx.db.select().from(publishTargets).where(eq(publishTargets.id, id)));
	if (!target) invalid('Not found', 404);
	const draft = await first(ctx.db.select().from(drafts).where(eq(drafts.id, target.draftId)));
	if (!draft || draft.userId !== userId) invalid('Not found', 404);
	if (target.status === 'published' || target.remotePostId) invalid('Already published');
	if (target.status === 'cancelled') return { target };
	const now = new Date();
	const blocked = refuseInFlightOrPublished(target, now);
	if (blocked) invalid(blocked, 409);
	const stale = new Date(now.getTime() - STALE_CLAIM_MS);
	const [updated] = await ctx.db
		.update(publishTargets)
		.set({ status: 'cancelled', jobId: null, scheduledFor: null, updatedAt: now })
		.where(
			and(
				eq(publishTargets.id, id),
				or(
					inArray(publishTargets.status, ['pending', 'scheduled', 'failed']),
					and(eq(publishTargets.status, 'publishing'), lte(publishTargets.updatedAt, stale))
				)
			)
		)
		.returning();
	if (!updated) {
		const latest = await first(
			ctx.db.select().from(publishTargets).where(eq(publishTargets.id, id))
		);
		if (latest?.status === 'cancelled') return { target: latest };
		if (latest?.remotePostId || latest?.status === 'published') invalid('Already published');
		invalid('Already publishing', 409);
	}
	await refreshDraftStatus(ctx.db, target.draftId);
	return { target: updated };
}

export async function retryDelivery(ctx: OperationContext, userId: string, id: string) {
	const target = await first(ctx.db.select().from(publishTargets).where(eq(publishTargets.id, id)));
	if (!target) invalid('Not found', 404);
	const draft = await first(ctx.db.select().from(drafts).where(eq(drafts.id, target.draftId)));
	if (!draft || draft.userId !== userId) invalid('Not found', 404);
	const now = new Date();
	if (target.remotePostId)
		return { status: 'published', remotePostId: target.remotePostId, skipped: true };
	const blocked = refuseInFlightOrPublished(target, now);
	if (blocked) invalid(blocked, 409);
	const conn = await first(
		ctx.db.select().from(connections).where(eq(connections.id, target.connectionId))
	);
	if (!conn || conn.userId !== userId) invalid('Not found', 404);
	if (conn.status !== 'active') invalid('Account needs reconnect', 409);
	const stale = new Date(now.getTime() - STALE_CLAIM_MS);
	const reset = await ctx.db
		.update(publishTargets)
		.set({
			status: 'pending',
			scheduledFor: null,
			errorMessage: null,
			jobId: null,
			attemptCount: 0,
			updatedAt: now
		})
		.where(
			and(
				eq(publishTargets.id, id),
				isNull(publishTargets.remotePostId),
				or(
					inArray(publishTargets.status, ['pending', 'scheduled', 'failed', 'cancelled']),
					and(eq(publishTargets.status, 'publishing'), lte(publishTargets.updatedAt, stale))
				)
			)
		)
		.returning({ id: publishTargets.id });
	if (!reset.length) {
		const latest = await first(
			ctx.db.select().from(publishTargets).where(eq(publishTargets.id, id))
		);
		if (latest?.remotePostId)
			return { status: 'published', remotePostId: latest.remotePostId, skipped: true };
		invalid('Already publishing', 409);
	}
	const task = publishTarget(ctx.db, ctx.env, ctx.media, id, { now });
	ctx.waitUntil?.(task.then(() => undefined).catch(() => undefined));
	return task;
}

export async function rescheduleDelivery(
	ctx: OperationContext,
	userId: string,
	id: string,
	body: unknown
) {
	const target = await first(ctx.db.select().from(publishTargets).where(eq(publishTargets.id, id)));
	if (!target) invalid('Not found', 404);
	const draft = await first(ctx.db.select().from(drafts).where(eq(drafts.id, target.draftId)));
	if (!draft || draft.userId !== userId) invalid('Not found', 404);
	const now = new Date();
	const blocked = refuseInFlightOrPublished(target, now);
	if (blocked) invalid(blocked, 409);
	if (target.status === 'cancelled') invalid('Cancelled — retry instead');
	if (!body || typeof body !== 'object') invalid('Invalid JSON body');
	const input = body as { runAt?: unknown };
	const runAt = input.runAt ? new Date(input.runAt as string) : null;
	const problem = runAtError(input.runAt, now);
	if (problem) invalid(problem);
	if (!runAt) invalid('runAt required', 400);
	const conn = await first(
		ctx.db.select().from(connections).where(eq(connections.id, target.connectionId))
	);
	if (!conn || conn.userId !== userId) invalid('Not found', 404);
	if (conn.status !== 'active') invalid('Account needs reconnect', 409);
	const stale = new Date(now.getTime() - STALE_CLAIM_MS);
	const updated = await ctx.db
		.update(publishTargets)
		.set({
			status: 'scheduled',
			scheduledFor: runAt,
			errorMessage: null,
			jobId: null,
			attemptCount: 0,
			updatedAt: now
		})
		.where(
			and(
				eq(publishTargets.id, id),
				isNull(publishTargets.remotePostId),
				or(
					inArray(publishTargets.status, ['pending', 'scheduled', 'failed']),
					and(eq(publishTargets.status, 'publishing'), lte(publishTargets.updatedAt, stale))
				)
			)
		)
		.returning({ id: publishTargets.id });
	if (!updated.length) {
		const latest = await first(
			ctx.db.select().from(publishTargets).where(eq(publishTargets.id, id))
		);
		if (latest?.remotePostId) invalid('Already published', 409);
		invalid('Already publishing', 409);
	}
	await refreshDraftStatus(ctx.db, target.draftId);
	return { ok: true as const, scheduledFor: runAt.toISOString() };
}

const ALLOWED_MEDIA_EXTENSIONS = new Set(['jpg', 'png', 'webp', 'gif', 'mp4']);
const MEDIA_INSERT_CHUNK = 8;
const VARIANT_PLATFORMS = new Set(['mastodon', 'bluesky', 'linkedin', 'threads', 'x']);
const VISIBILITIES = new Set(['public', 'unlisted', 'private', 'direct']);

export async function listDrafts(ctx: OperationContext, userId: string, requestedLimit?: number) {
	const limit = Number.isFinite(requestedLimit)
		? Math.min(500, Math.max(1, Math.floor(requestedLimit!)))
		: 200;
	const rows = await ctx.db
		.select()
		.from(drafts)
		.where(eq(drafts.userId, userId))
		.orderBy(desc(drafts.updatedAt))
		.limit(limit + 1);
	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	type VariantRow = InferSelectModel<typeof draftVariants>;
	type MediaRow = InferSelectModel<typeof draftMedia>;
	type TargetRow = InferSelectModel<typeof publishTargets>;
	const ids = page.map((draft) => draft.id);
	const variants: VariantRow[] = [];
	const media: MediaRow[] = [];
	const targets: TargetRow[] = [];
	for (const chunk of chunkIds(ids)) {
		const [variantRows, mediaRows, targetRows] = (await batchQueries(ctx.db, [
			ctx.db.select().from(draftVariants).where(inArray(draftVariants.draftId, chunk)),
			ctx.db.select().from(draftMedia).where(inArray(draftMedia.draftId, chunk)),
			ctx.db.select().from(publishTargets).where(inArray(publishTargets.draftId, chunk))
		])) as [VariantRow[], MediaRow[], TargetRow[]];
		variants.push(...variantRows);
		media.push(...mediaRows);
		targets.push(...targetRows);
	}
	const connectionIds = [...new Set(targets.map((target) => target.connectionId))];
	const connectionRows: Array<
		Pick<InferSelectModel<typeof connections>, 'id' | 'platform' | 'handle' | 'displayName'>
	> = [];
	for (const chunk of chunkIds(connectionIds)) {
		connectionRows.push(
			...(await ctx.db
				.select({
					id: connections.id,
					platform: connections.platform,
					handle: connections.handle,
					displayName: connections.displayName
				})
				.from(connections)
				.where(inArray(connections.id, chunk)))
		);
	}
	const connectionById = new Map(connectionRows.map((connection) => [connection.id, connection]));
	const variantsByDraft = new Map<string, VariantRow[]>();
	const mediaByDraft = new Map<string, MediaRow[]>();
	const targetsByDraft = new Map<
		string,
		Array<TargetRow & { connection?: (typeof connectionRows)[number] }>
	>();
	for (const variant of variants)
		variantsByDraft.set(variant.draftId, [
			...(variantsByDraft.get(variant.draftId) ?? []),
			variant
		]);
	for (const item of media)
		mediaByDraft.set(item.draftId, [...(mediaByDraft.get(item.draftId) ?? []), item]);
	for (const target of targets)
		targetsByDraft.set(target.draftId, [
			...(targetsByDraft.get(target.draftId) ?? []),
			{ ...target, connection: connectionById.get(target.connectionId) }
		]);
	return {
		drafts: page.map((draft) =>
			serializeDraft(draft, {
				variants: variantsByDraft.get(draft.id) ?? [],
				media: mediaByDraft.get(draft.id) ?? [],
				targets: targetsByDraft.get(draft.id) ?? []
			})
		),
		hasMore
	};
}

export async function createDraft(
	ctx: OperationContext,
	userId: string,
	input: Record<string, unknown>
) {
	const selected = normalizeSelectedConnectionIds(input.selectedConnectionIds);
	if (!selected.ok) invalid(selected.error);
	const title = parseDraftTitle(input.title ?? null);
	if (!title.ok) invalid(title.error);
	const body = parseDraftBody(input.baseBody ?? '');
	if (!body.ok) invalid(body.error);
	const now = new Date();
	const [draft] = await ctx.db
		.insert(drafts)
		.values({
			id: newId(),
			userId,
			title: title.value,
			baseBody: body.value,
			...(selected.value !== undefined ? { selectedConnectionIds: selected.value } : {}),
			status: 'draft',
			createdAt: now,
			updatedAt: now
		})
		.returning();
	return { draft: serializeDraft(draft, { variants: [], media: [], targets: [] }) };
}

export async function duplicateDraft(ctx: OperationContext, userId: string, draftId: string) {
	const source = await first(
		ctx.db
			.select()
			.from(drafts)
			.where(and(eq(drafts.id, draftId), eq(drafts.userId, userId)))
	);
	if (!source) invalid('Not found', 404);
	const variants = await ctx.db
		.select()
		.from(draftVariants)
		.where(eq(draftVariants.draftId, source.id));
	const media = await ctx.db.select().from(draftMedia).where(eq(draftMedia.draftId, source.id));
	const now = new Date();
	const newDraftId = newId();
	const savedKeys: string[] = [];
	try {
		const [draft] = await ctx.db
			.insert(drafts)
			.values({
				id: newDraftId,
				userId,
				title: source.title,
				baseBody: source.baseBody,
				selectedConnectionIds: source.selectedConnectionIds,
				status: 'draft',
				createdAt: now,
				updatedAt: now
			})
			.returning();
		const newVariants = variants.length
			? await ctx.db
					.insert(draftVariants)
					.values(
						variants.map((variant) => ({
							id: newId(),
							draftId: newDraftId,
							platform: variant.platform,
							body: variant.body,
							optionsJson: variant.optionsJson,
							createdAt: now,
							updatedAt: now
						}))
					)
					.returning()
			: [];
		const mediaValues: Array<typeof draftMedia.$inferInsert> = [];
		for (const item of media) {
			const bytes = await ctx.media.get(item.storageKey);
			if (!bytes) continue;
			let extension: string;
			try {
				extension = assertSafeStorageKey(item.storageKey).split('.').pop() ?? '';
			} catch {
				continue;
			}
			if (!ALLOWED_MEDIA_EXTENSIONS.has(extension)) continue;
			const validated = (item.mime || '').toLowerCase().startsWith('video/')
				? validateVideoUpload({ mime: item.mime, size: bytes.length, bytes })
				: validateImageUpload({ mime: item.mime, size: bytes.length, bytes });
			if (!validated.ok) continue;
			const storageKey = `${Date.now()}-${randomHex(8)}.${extension}`;
			await ctx.media.put(storageKey, bytes, validated.mime);
			savedKeys.push(storageKey);
			mediaValues.push({
				id: newId(),
				draftId: newDraftId,
				storageKey,
				mime: validated.mime,
				size: bytes.length,
				width: item.width,
				height: item.height,
				altText: item.altText,
				sortOrder: item.sortOrder,
				segmentIndex: item.segmentIndex,
				createdAt: now
			});
		}
		const newMedia = [];
		for (let index = 0; index < mediaValues.length; index += MEDIA_INSERT_CHUNK) {
			newMedia.push(
				...(await ctx.db
					.insert(draftMedia)
					.values(mediaValues.slice(index, index + MEDIA_INSERT_CHUNK))
					.returning())
			);
		}
		return {
			draft: serializeDraft(draft, { variants: newVariants, media: newMedia, targets: [] })
		};
	} catch (error) {
		for (const key of savedKeys) await ctx.media.delete(key).catch(() => {});
		await ctx.db
			.delete(drafts)
			.where(eq(drafts.id, newDraftId))
			.catch(() => {});
		throw error;
	}
}

function validateVariantOptions(options: unknown): string | null {
	if (options === undefined) return null;
	if (!options || typeof options !== 'object' || Array.isArray(options))
		return 'options must be an object';
	const value = options as Record<string, unknown>;
	if (value.visibility !== undefined && !VISIBILITIES.has(String(value.visibility)))
		return 'Invalid visibility';
	if (value.poll !== undefined && value.poll !== null) {
		const poll = validatePollConfig(value.poll);
		if (!poll.ok) return poll.error;
	}
	if (
		value.threadSegments !== undefined &&
		(!Array.isArray(value.threadSegments) ||
			value.threadSegments.some((segment) => typeof segment !== 'string'))
	)
		return 'threadSegments must be an array of strings';
	return null;
}

async function ensureDraftNotPublishing(ctx: OperationContext, draftId: string) {
	const targets = await ctx.db
		.select()
		.from(publishTargets)
		.where(eq(publishTargets.draftId, draftId));
	if (draftHasInFlightPublish(targets)) invalid('Publishing in progress — try again shortly', 409);
}

export async function setDraftVariant(
	ctx: OperationContext,
	userId: string,
	draftId: string,
	input: unknown
) {
	const draft = await first(
		ctx.db
			.select()
			.from(drafts)
			.where(and(eq(drafts.id, draftId), eq(drafts.userId, userId)))
	);
	if (!draft) invalid('Not found', 404);
	await ensureDraftNotPublishing(ctx, draftId);
	if (!input || typeof input !== 'object') invalid('Invalid JSON body');
	const fields = input as Record<string, unknown>;
	const optionsError = validateVariantOptions(fields.options);
	if (optionsError) invalid(optionsError);
	const options =
		fields.options && typeof fields.options === 'object'
			? (fields.options as Record<string, unknown>)
			: {};
	const segments = parseThreadSegments(options.threadSegments ?? []);
	if (!segments.ok) invalid(segments.error);
	if (fields.body !== undefined) {
		const body = parseSegmentBody(fields.body);
		if (!body.ok) invalid(body.error);
	}
	const platform = String(fields.platform || '');
	if (!VARIANT_PLATFORMS.has(platform))
		invalid('platform must be mastodon, bluesky, linkedin, threads, or x');
	const existing = await first(
		ctx.db
			.select()
			.from(draftVariants)
			.where(and(eq(draftVariants.draftId, draftId), eq(draftVariants.platform, platform)))
	);
	const now = new Date();
	const optionsJson =
		fields.options !== undefined
			? JSON.stringify(fields.options ?? {})
			: (existing?.optionsJson ?? '{}');
	if (optionsJson.length > MAX_VARIANT_OPTIONS_LENGTH)
		invalid(
			`Variant options are too large to save (${optionsJson.length} characters, max ${MAX_VARIANT_OPTIONS_LENGTH})`
		);
	const variant = existing
		? (
				await ctx.db
					.update(draftVariants)
					.set({
						body: fields.body !== undefined ? (fields.body as string | null) : existing.body,
						optionsJson,
						updatedAt: now
					})
					.where(eq(draftVariants.id, existing.id))
					.returning()
			)[0]
		: (
				await ctx.db
					.insert(draftVariants)
					.values({
						id: newId(),
						draftId,
						platform,
						body: (fields.body ?? null) as string | null,
						optionsJson,
						createdAt: now,
						updatedAt: now
					})
					.returning()
			)[0];
	return { variant: serializeVariant(variant) };
}

export async function deleteDraftVariant(
	ctx: OperationContext,
	userId: string,
	draftId: string,
	platform: string | null
) {
	const draft = await first(
		ctx.db
			.select()
			.from(drafts)
			.where(and(eq(drafts.id, draftId), eq(drafts.userId, userId)))
	);
	if (!draft) invalid('Not found', 404);
	await ensureDraftNotPublishing(ctx, draftId);
	if (!platform) invalid('platform required');
	await ctx.db
		.delete(draftVariants)
		.where(and(eq(draftVariants.draftId, draftId), eq(draftVariants.platform, platform)));
	return { ok: true as const };
}

export async function publishDraft(
	ctx: OperationContext,
	userId: string,
	draftId: string,
	requestBody: unknown
) {
	const draft = await first(
		ctx.db
			.select()
			.from(drafts)
			.where(and(eq(drafts.id, draftId), eq(drafts.userId, userId)))
	);
	if (!draft) invalid('Not found', 404);
	if (!requestBody || typeof requestBody !== 'object') invalid('Invalid JSON body');
	const connectionIdsInput = (requestBody as Record<string, unknown>).connectionIds;
	if (connectionIdsOverflow(connectionIdsInput)) invalid('Too many connections (max 10)');
	const connectionIds = normalizeConnectionIds(connectionIdsInput);
	if (!connectionIds.length) invalid('connectionIds required');
	const userConnections = await ctx.db
		.select()
		.from(connections)
		.where(
			and(
				eq(connections.userId, userId),
				inArray(connections.id, connectionIds),
				eq(connections.status, 'active')
			)
		);
	if (userConnections.length !== connectionIds.length) invalid('One or more connections not found');
	const now = new Date();
	const classified = await classifyConnections(ctx.db, draftId, userConnections, now);
	const inFlight = classified
		.filter((item) => item.kind === 'inFlight')
		.map((item) => item.connectionId);
	if (inFlight.length) invalid('Already publishing', 409, { inFlight });
	const ensured = await ensureTargets(ctx.db, draftId, userConnections, 'now', null, now);
	const results = [];
	let stopped: string | null = null;
	let deferring = false;
	let attempted = 0;
	for (const item of ensured) {
		const connection = userConnections.find((row) => row.id === item.target.connectionId);
		if (!connection) continue;
		if (item.alreadyPublished) {
			results.push({
				targetId: item.target.id,
				connectionId: connection.id,
				platform: connection.platform,
				handle: connection.handle,
				displayName: connection.displayName,
				status: 'published',
				permalink: item.target.remoteUrl ?? null,
				error: null,
				skipped: true
			});
			continue;
		}
		if (item.inFlight) {
			results.push({
				targetId: item.target.id,
				connectionId: connection.id,
				platform: connection.platform,
				handle: connection.handle,
				displayName: connection.displayName,
				status: 'publishing',
				permalink: null,
				error: null,
				skipped: true,
				inFlight: true
			});
			continue;
		}
		if (deferring) {
			results.push({
				targetId: item.target.id,
				connectionId: connection.id,
				platform: connection.platform,
				handle: connection.handle,
				displayName: connection.displayName,
				status: 'pending',
				permalink: null,
				error: null,
				skipped: true,
				deferred: true
			});
			continue;
		}
		try {
			const task = publishTarget(ctx.db, ctx.env, ctx.media, item.target.id, {
				budget: ctx.budget,
				mustTry: attempted === 0
			});
			ctx.waitUntil?.(task.then(() => undefined).catch(() => undefined));
			const result = await task;
			if (result.deferred) {
				deferring = true;
				results.push({
					targetId: item.target.id,
					connectionId: connection.id,
					platform: connection.platform,
					handle: connection.handle,
					displayName: connection.displayName,
					status: 'pending',
					permalink: null,
					error: null,
					skipped: true,
					deferred: true
				});
				continue;
			}
			attempted += 1;
			const row = await first(
				ctx.db.select().from(publishTargets).where(eq(publishTargets.id, item.target.id))
			);
			results.push({
				targetId: item.target.id,
				connectionId: connection.id,
				platform: connection.platform,
				handle: connection.handle,
				displayName: connection.displayName,
				status: result.status,
				permalink: row?.remoteUrl ?? null,
				error: result.error ?? row?.errorMessage ?? null,
				skipped: result.skipped ?? false
			});
		} catch (error) {
			console.error('[publish] aborted', item.target.id, error);
			stopped =
				humanizedCause(error instanceof Error ? error.message : String(error)) ??
				'Publishing stopped early — try again for the rest';
			break;
		}
	}
	const draftAfter = await first(ctx.db.select().from(drafts).where(eq(drafts.id, draftId)));
	const targets = await ctx.db
		.select()
		.from(publishTargets)
		.where(eq(publishTargets.draftId, draftId));
	return {
		results,
		...(stopped !== null ? { stopped: true, stoppedError: stopped } : {}),
		draft: draftAfter
			? serializeDraft(draftAfter, {
					targets: targets.map((target) => {
						const connection = userConnections.find((row) => row.id === target.connectionId);
						return {
							...target,
							connection: connection
								? { id: connection.id, platform: connection.platform, handle: connection.handle }
								: undefined
						};
					})
				})
			: null
	};
}

export async function listQueue(ctx: OperationContext, userId: string, requestedLimit?: number) {
	const limit = Number.isFinite(requestedLimit)
		? Math.min(500, Math.max(1, Math.floor(requestedLimit!)))
		: 100;
	const targetsQuery = ctx.db
		.select()
		.from(publishTargets)
		.where(
			and(
				inArray(
					publishTargets.connectionId,
					ctx.db
						.select({ id: connections.id })
						.from(connections)
						.where(eq(connections.userId, userId))
				),
				inArray(publishTargets.status, [
					'scheduled',
					'pending',
					'publishing',
					'failed',
					'published'
				])
			)
		)
		.orderBy(
			sql`${publishTargets.scheduledFor} is null`,
			asc(publishTargets.scheduledFor),
			desc(publishTargets.updatedAt)
		)
		.limit(limit + 1);
	type TargetRow = InferSelectModel<typeof publishTargets>;
	type ConnectionRow = Pick<
		InferSelectModel<typeof connections>,
		'id' | 'platform' | 'handle' | 'displayName' | 'avatarUrl' | 'status'
	>;
	type DraftLite = { id: string; title: string | null; baseBody: string; status: string };
	const [allTargets, ownedConnections] = (await batchQueries(ctx.db, [
		targetsQuery,
		ctx.db
			.select({
				id: connections.id,
				platform: connections.platform,
				handle: connections.handle,
				displayName: connections.displayName,
				avatarUrl: connections.avatarUrl,
				status: connections.status
			})
			.from(connections)
			.where(eq(connections.userId, userId))
	])) as [TargetRow[], ConnectionRow[]];
	const hasMore = allTargets.length > limit;
	const targetRows = hasMore ? allTargets.slice(0, limit) : allTargets;
	const connectionById = new Map(ownedConnections.map((connection) => [connection.id, connection]));
	const draftIds = [...new Set(targetRows.map((target) => target.draftId))];
	const draftRows: DraftLite[] = [];
	for (const chunk of chunkIds(draftIds))
		draftRows.push(
			...(await ctx.db
				.select({
					id: drafts.id,
					title: drafts.title,
					baseBody: drafts.baseBody,
					status: drafts.status
				})
				.from(drafts)
				.where(and(eq(drafts.userId, userId), inArray(drafts.id, chunk))))
		);
	const draftById = new Map(draftRows.map((draft) => [draft.id, draft]));
	const mediaRows: InferSelectModel<typeof draftMedia>[] = [];
	for (const chunk of chunkIds(draftIds.filter((id) => draftById.has(id))))
		mediaRows.push(
			...(await ctx.db.select().from(draftMedia).where(inArray(draftMedia.draftId, chunk)))
		);
	const mediaByDraft = new Map<string, ReturnType<typeof serializeMedia>[]>();
	for (const media of mediaRows) {
		if (!draftById.has(media.draftId)) continue;
		const values = mediaByDraft.get(media.draftId) ?? [];
		values.push(serializeMedia(media));
		mediaByDraft.set(media.draftId, values);
	}
	for (const values of mediaByDraft.values())
		values.sort(
			(a, b) => (a.segmentIndex ?? 0) - (b.segmentIndex ?? 0) || a.sortOrder - b.sortOrder
		);
	const targets = [];
	for (const target of targetRows) {
		const connection = connectionById.get(target.connectionId);
		const draft = draftById.get(target.draftId);
		if (!connection || !draft || (connection.status === 'disconnected' && !target.remotePostId))
			continue;
		targets.push({
			id: target.id,
			status: target.status,
			scheduledFor: target.scheduledFor,
			updatedAt: target.updatedAt,
			remoteUrl: target.remoteUrl,
			errorMessage: target.errorMessage,
			draft: { ...draft, media: mediaByDraft.get(draft.id) ?? [] },
			connection: {
				id: connection.id,
				platform: connection.platform,
				handle: connection.handle,
				displayName: connection.displayName,
				avatarUrl: connection.avatarUrl,
				status: connection.status
			}
		});
	}
	return { targets, hasMore };
}
