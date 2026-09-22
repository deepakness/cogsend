import { desc, eq, inArray, type InferSelectModel } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { parseDraftBody, parseDraftTitle } from '$lib/domain/validation/draft-fields';
import { batchQueries, chunkIds, newId } from '$lib/server/db/client';
import {
	connections,
	draftMedia,
	drafts,
	draftVariants,
	publishTargets
} from '$lib/server/db/schema';
import { fail, handleError, ok } from '$lib/server/http';
import { requireScope, requireUser } from '$lib/server/require';
import { serializeDraft } from '$lib/server/serialize';
import { normalizeSelectedConnectionIds } from '$lib/domain/request-limits';

// Route-local: SvelteKit only allows specific named exports from +server
// modules, so these stay module-private.
const DRAFTS_LIST_LIMIT = 200;
const DRAFTS_LIST_MAX_LIMIT = 500;

export const GET: RequestHandler = async ({ locals, url }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');
		const requested = parseInt(url?.searchParams.get('limit') ?? '', 10);
		const limit = Number.isFinite(requested)
			? Math.min(DRAFTS_LIST_MAX_LIMIT, Math.max(1, Math.floor(requested)))
			: DRAFTS_LIST_LIMIT;
		// One extra row tells the client a longer history exists without a
		// second count query.
		const rows = await locals.db
			.select()
			.from(drafts)
			.where(eq(drafts.userId, user.id))
			.orderBy(desc(drafts.updatedAt))
			.limit(limit + 1);
		type VariantRow = InferSelectModel<typeof draftVariants>;
		type MediaRow = InferSelectModel<typeof draftMedia>;
		type TargetRow = InferSelectModel<typeof publishTargets>;
		const hasMore = rows.length > limit;
		const page = hasMore ? rows.slice(0, limit) : rows;
		// Batched relations, IN-lists chunked for D1's bound-variable limit.
		const ids = page.map((d) => d.id);
		const emptyVariants: VariantRow[] = [];
		const emptyMedia: MediaRow[] = [];
		const emptyTargets: TargetRow[] = [];
		const allVariants: VariantRow[] = [...emptyVariants];
		const allMedia: MediaRow[] = [...emptyMedia];
		const allTargets: TargetRow[] = [...emptyTargets];
		for (const chunk of chunkIds(ids)) {
			const [v, m, tg] = (await batchQueries(locals.db, [
				locals.db.select().from(draftVariants).where(inArray(draftVariants.draftId, chunk)),
				locals.db.select().from(draftMedia).where(inArray(draftMedia.draftId, chunk)),
				locals.db.select().from(publishTargets).where(inArray(publishTargets.draftId, chunk))
			])) as [VariantRow[], MediaRow[], TargetRow[]];
			allVariants.push(...v);
			allMedia.push(...m);
			allTargets.push(...tg);
		}
		const connIds = [...new Set(allTargets.map((t) => t.connectionId))];
		const conns: {
			id: string;
			platform: string;
			handle: string | null;
			displayName: string | null;
		}[] = [];
		for (const chunk of chunkIds(connIds)) {
			conns.push(
				...(await locals.db
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
		const connById = new Map(conns.map((c) => [c.id, c]));
		const variantsByDraft = new Map<string, VariantRow[]>();
		const mediaByDraft = new Map<string, MediaRow[]>();
		const targetsByDraft = new Map<
			string,
			Array<
				TargetRow & {
					connection?: {
						id: string;
						platform: string;
						handle: string | null;
						displayName: string | null;
					};
				}
			>
		>();
		for (const v of allVariants) {
			const list = variantsByDraft.get(v.draftId) ?? [];
			list.push(v);
			variantsByDraft.set(v.draftId, list);
		}
		for (const m of allMedia) {
			const list = mediaByDraft.get(m.draftId) ?? [];
			list.push(m);
			mediaByDraft.set(m.draftId, list);
		}
		for (const t of allTargets) {
			const list = targetsByDraft.get(t.draftId) ?? [];
			list.push({ ...t, connection: connById.get(t.connectionId) });
			targetsByDraft.set(t.draftId, list);
		}
		const result = page.map((d) =>
			serializeDraft(d, {
				variants: variantsByDraft.get(d.id) ?? [],
				media: mediaByDraft.get(d.id) ?? [],
				targets: targetsByDraft.get(d.id) ?? []
			})
		);
		return ok({ drafts: result, hasMore });
	} catch (err) {
		return handleError(err);
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		// Every field here is optional, so an empty body is a legitimate
		// "create a draft with defaults" (that is what this did before the
		// guard). Malformed JSON is still a 400 rather than a 500.
		const raw = await request.text().catch(() => '');
		let body: unknown = {};
		if (raw.trim()) {
			try {
				body = JSON.parse(raw);
			} catch {
				return fail('Invalid JSON body', 400);
			}
		}
		if (!body || typeof body !== 'object') return fail('Invalid JSON body', 400);
		const fields = body as Record<string, unknown>;
		const selection = normalizeSelectedConnectionIds(fields.selectedConnectionIds);
		if (!selection.ok) return fail(selection.error, 400);
		const title = parseDraftTitle(fields.title ?? null);
		if (!title.ok) return fail(title.error, 400);
		const text = parseDraftBody(fields.baseBody ?? '');
		if (!text.ok) return fail(text.error, 400);
		const now = new Date();
		const [draft] = await locals.db
			.insert(drafts)
			.values({
				id: newId(),
				userId: user.id,
				title: title.value,
				baseBody: text.value,
				...(selection.value !== undefined ? { selectedConnectionIds: selection.value } : {}),
				status: 'draft',
				createdAt: now,
				updatedAt: now
			})
			.returning();
		return ok({ draft: serializeDraft(draft, { variants: [], media: [], targets: [] }) }, 201);
	} catch (err) {
		return handleError(err);
	}
};
