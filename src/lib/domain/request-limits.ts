export const MAX_TARGET_CONNECTION_IDS = 10;
export const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60_000;
export const SCHEDULE_PAST_GRACE_MS = 5000;

export function normalizeConnectionIds(input: unknown): string[] {
	if (!Array.isArray(input)) return [];
	const seen = new Set<string>();
	for (const v of input) {
		if (typeof v !== 'string') continue;
		const id = v.trim();
		if (!id) continue;
		if (!seen.has(id)) seen.add(id);
		if (seen.size >= MAX_TARGET_CONNECTION_IDS) break;
	}
	return [...seen];
}

export function connectionIdsOverflow(input: unknown): boolean {
	if (!Array.isArray(input)) return false;
	return (
		new Set(input.filter((v): v is string => typeof v === 'string' && v.trim() !== '')).size >
		MAX_TARGET_CONNECTION_IDS
	);
}

/**
 * Draft/editor account selection, stored as JSON on the draft. `undefined`
 * means the request did not include the field (leave the stored value
 * alone); an empty array is meaningful and must survive as `[]` so an
 * explicitly cleared selection does not fall back to defaults on reload.
 *
 * The bound is deliberately higher than the publish cap: autosaving a
 * selection must never fail just because it has more destinations than one
 * publish may target (publish/schedule report that themselves).
 */
export const MAX_DRAFT_SELECTION_IDS = 50;

export function normalizeSelectedConnectionIds(
	input: unknown
): { ok: true; value: string | undefined } | { ok: false; error: string } {
	if (input === undefined) return { ok: true, value: undefined };
	if (!Array.isArray(input)) {
		return { ok: false, error: 'selectedConnectionIds must be an array of strings' };
	}
	if (input.some((v) => typeof v !== 'string')) {
		return { ok: false, error: 'selectedConnectionIds must be an array of strings' };
	}
	const ids = new Set<string>();
	for (const v of input) {
		const id = v.trim();
		if (!id) continue;
		ids.add(id);
		if (ids.size > MAX_DRAFT_SELECTION_IDS) {
			return { ok: false, error: `Too many connections (max ${MAX_DRAFT_SELECTION_IDS})` };
		}
	}
	return { ok: true, value: JSON.stringify([...ids]) };
}

export function runAtError(value: unknown, now: Date = new Date()): string | null {
	const runAt = value instanceof Date ? value : new Date(String(value ?? ''));
	if (!value || Number.isNaN(runAt.getTime())) return 'runAt required (ISO date)';
	if (runAt.getTime() < now.getTime() - SCHEDULE_PAST_GRACE_MS)
		return 'runAt must be in the future';
	if (runAt.getTime() - now.getTime() > MAX_SCHEDULE_AHEAD_MS)
		return 'runAt must be within the next year';
	return null;
}
