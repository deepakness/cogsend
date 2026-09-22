/**
 * Bounds for the free-text fields a client writes into a draft.
 *
 * Without them any JSON value was bound straight into D1: an object produced a
 * driver error (500 instead of 400) and a multi-megabyte string was stored
 * happily. These are the numbers a single request can store: 100 posts of
 * 100,000 characters is the worst case, so the ceiling is 10MB per draft —
 * generous for text, and small enough that a runaway client cannot use the
 * endpoint as free storage. The media route clamps a segment index to 100 for
 * the same reason.
 */
export const DRAFT_TITLE_MAX_LENGTH = 200;
export const DRAFT_BODY_MAX_LENGTH = 100_000;
/**
 * The editor grows a thread on demand, so this is a sanity bound rather than a
 * product limit: far above any thread a person would write, and the same
 * ceiling the media routes use for a segment index.
 */
export const MAX_THREAD_SEGMENTS = 100;

/**
 * A variant's options are stored as one JSON column, so this bounds the whole
 * serialized object — `threadSegments` alone allows 100 posts of 100,000
 * characters, and D1 refuses a statement anywhere near that size. Same ceiling
 * as one post body: one column, one statement.
 */
export const MAX_VARIANT_OPTIONS_LENGTH = 100_000;

export type FieldResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** `null` clears the title; a non-string is rejected. */
export function parseDraftTitle(value: unknown): FieldResult<string | null> {
	if (value === null) return { ok: true, value: null };
	if (typeof value !== 'string') return { ok: false, error: 'title must be a string' };
	const title = value.trim();
	if (title.length > DRAFT_TITLE_MAX_LENGTH) {
		return { ok: false, error: `Title must be ${DRAFT_TITLE_MAX_LENGTH} characters or fewer` };
	}
	return { ok: true, value: title || null };
}

export function parseDraftBody(value: unknown): FieldResult<string> {
	if (typeof value !== 'string') return { ok: false, error: 'baseBody must be a string' };
	if (value.length > DRAFT_BODY_MAX_LENGTH) {
		return {
			ok: false,
			error: `This post is too long to save (${value.length} characters, max ${DRAFT_BODY_MAX_LENGTH})`
		};
	}
	return { ok: true, value };
}

/**
 * Per-platform body override for a thread segment. `null` is meaningful — the
 * editor sends it to clear an override while keeping the platform's options —
 * so it is accepted, unlike an object or a number.
 */
export function parseSegmentBody(value: unknown): FieldResult<string | null> {
	if (value === null) return { ok: true, value: null };
	if (typeof value !== 'string') return { ok: false, error: 'body must be a string' };
	if (value.length > DRAFT_BODY_MAX_LENGTH) {
		return {
			ok: false,
			error: `This post is too long to save (${value.length} characters, max ${DRAFT_BODY_MAX_LENGTH})`
		};
	}
	return { ok: true, value };
}

export function parseThreadSegments(value: unknown): FieldResult<string[]> {
	if (!Array.isArray(value) || value.some((s) => typeof s !== 'string')) {
		return { ok: false, error: 'threadSegments must be an array of strings' };
	}
	if (value.length > MAX_THREAD_SEGMENTS) {
		return { ok: false, error: `A thread can have at most ${MAX_THREAD_SEGMENTS} posts` };
	}
	if (value.some((s) => (s as string).length > DRAFT_BODY_MAX_LENGTH)) {
		return {
			ok: false,
			error: `A post in this thread is too long to save (max ${DRAFT_BODY_MAX_LENGTH} characters)`
		};
	}
	return { ok: true, value: value as string[] };
}
