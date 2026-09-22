import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { randomHex } from '$lib/domain/bytes';
import { validateImageUpload, validateVideoUpload } from '$lib/domain/media-limits';
import { first, newId } from '$lib/server/db/client';
import { draftMedia, drafts, draftVariants } from '$lib/server/db/schema';
import { fail, handleError, ok } from '$lib/server/http';
import { assertSafeStorageKey } from '$lib/server/media';
import { requireScope, requireUser } from '$lib/server/require';
import { serializeDraft } from '$lib/server/serialize';

// Keep the same shape saveMediaBytes mints; anything else would fail the
// serving route's key check.
const ALLOWED_EXT = new Set(['jpg', 'png', 'webp', 'gif', 'mp4']);
// 11 bound parameters per media row; D1 caps a query at 100.
const MEDIA_INSERT_CHUNK = 8;

/**
 * Copy a draft ("Post again" / "Duplicate"). Media bytes are copied to new
 * R2 keys: the draft DELETE path removes objects unconditionally, so sharing
 * keys would let deleting either copy destroy the other's images.
 *
 * Publish state is history, not content, so targets are never copied — the
 * clone starts as a plain draft.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
	let createdDraftId: string | null = null;
	const savedKeys: string[] = [];
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const source = await first(
			locals.db
				.select()
				.from(drafts)
				.where(and(eq(drafts.id, params.id), eq(drafts.userId, user.id)))
		);
		if (!source) return fail('Not found', 404);

		const variants = await locals.db
			.select()
			.from(draftVariants)
			.where(eq(draftVariants.draftId, source.id));
		const media = await locals.db
			.select()
			.from(draftMedia)
			.where(eq(draftMedia.draftId, source.id));

		const now = new Date();
		const newDraftId = newId();
		createdDraftId = newDraftId;
		const [draft] = await locals.db
			.insert(drafts)
			.values({
				id: newDraftId,
				userId: user.id,
				title: source.title,
				baseBody: source.baseBody,
				selectedConnectionIds: source.selectedConnectionIds,
				status: 'draft',
				createdAt: now,
				updatedAt: now
			})
			.returning();

		const newVariants = variants.length
			? await locals.db
					.insert(draftVariants)
					.values(
						variants.map((v) => ({
							id: newId(),
							draftId: newDraftId,
							platform: v.platform,
							body: v.body,
							optionsJson: v.optionsJson,
							createdAt: now,
							updatedAt: now
						}))
					)
					.returning()
			: [];

		// Bytes first, rows after: a missing object skips that attachment
		// instead of failing the whole copy (draft_media rows can outlive a
		// lost R2 object after a partial outage).
		const mediaValues: Array<typeof draftMedia.$inferInsert> = [];
		for (const m of media) {
			const bytes = await locals.media.get(m.storageKey);
			if (!bytes) continue;
			// Defense in depth: the row is not trusted. The key must still match
			// the shape saveMediaBytes mints (no traversal), and the bytes must
			// still sniff as the media they are declared to be.
			let ext: string;
			try {
				ext = assertSafeStorageKey(m.storageKey).split('.').pop() ?? '';
			} catch {
				continue;
			}
			if (!ALLOWED_EXT.has(ext)) continue;
			const validated = (m.mime || '').toLowerCase().startsWith('video/')
				? validateVideoUpload({ mime: m.mime, size: bytes.length, bytes })
				: validateImageUpload({ mime: m.mime, size: bytes.length, bytes });
			if (!validated.ok) continue;
			const storageKey = `${Date.now()}-${randomHex(8)}.${ext}`;
			await locals.media.put(storageKey, bytes, validated.mime);
			savedKeys.push(storageKey);
			mediaValues.push({
				id: newId(),
				draftId: newDraftId,
				storageKey,
				mime: validated.mime,
				size: bytes.length,
				width: m.width,
				height: m.height,
				altText: m.altText,
				sortOrder: m.sortOrder,
				segmentIndex: m.segmentIndex,
				createdAt: now
			});
		}
		const newMedia = [];
		for (let i = 0; i < mediaValues.length; i += MEDIA_INSERT_CHUNK) {
			newMedia.push(
				...(await locals.db
					.insert(draftMedia)
					.values(mediaValues.slice(i, i + MEDIA_INSERT_CHUNK))
					.returning())
			);
		}
		return ok(
			{ draft: serializeDraft(draft, { variants: newVariants, media: newMedia, targets: [] }) },
			201
		);
	} catch (err) {
		// Never leak half a copy: remove the objects we wrote and the draft
		// row (its variants/media cascade).
		for (const key of savedKeys) await locals.media.delete(key).catch(() => {});
		if (createdDraftId) {
			await locals.db
				.delete(drafts)
				.where(eq(drafts.id, createdDraftId))
				.catch(() => {});
		}
		return handleError(err);
	}
};
