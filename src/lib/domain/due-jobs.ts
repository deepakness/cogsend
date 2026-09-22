/** Dead-isolate TTL. Not a request timeout. Slow live publishes must finish under this. */
export const STALE_CLAIM_MS = 15 * 60_000;
/**
 * How often a live publish refreshes its claim. Comfortably inside
 * STALE_CLAIM_MS, so an overlapping tick can never reclaim a publish that is
 * still running, while a genuinely slow one costs at most one extra write
 * every five minutes.
 */
export const LEASE_REFRESH_MS = 5 * 60_000;

export type SchedulableTarget = {
	id: string;
	status: string;
	scheduledFor: Date | string | null;
	remotePostId?: string | null;
	updatedAt?: Date | string | null;
};

function asTime(value: Date | string | number | null | undefined): number | null {
	if (value == null) return null;
	if (typeof value === 'number') return Number.isNaN(value) ? null : value;
	const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
	return Number.isNaN(t) ? null : t;
}

/** True while a live isolate still owns the row. Missing updatedAt is treated as stale. */
export function isFreshPublishing(
	target: {
		status: string;
		updatedAt?: Date | string | number | null;
		remotePostId?: string | null;
	},
	now: Date = new Date()
): boolean {
	if (target.remotePostId) return false;
	if (target.status !== 'publishing') return false;
	const updated = asTime(target.updatedAt);
	if (updated == null) return false;
	return now.getTime() - updated < STALE_CLAIM_MS;
}

/** Default grace is 0 — never fire early. Pass a positive window only for catch-up. */
export function selectDueScheduledTargets<T extends SchedulableTarget>(
	targets: T[],
	now: Date = new Date(),
	graceMs = 0
): T[] {
	return targets.filter((t) => {
		// Status first: a published row is never due, even when the provider gave
		// us no id to remember it by.
		if (t.status === 'published' || t.remotePostId) return false;
		const when = asTime(t.scheduledFor);
		if (when != null && when > now.getTime() + graceMs) return false;

		if (t.status === 'publishing') {
			const updated = asTime(t.updatedAt);
			if (updated == null) return false;
			return updated <= now.getTime() - STALE_CLAIM_MS;
		}
		// `pending` with no timestamp is the "publish now" pair written by the
		// publish and retry paths just before their inline attempt. If that
		// attempt never ran (isolate evicted, request aborted, statement budget
		// spent) the row would otherwise be stranded: nothing else reaches it.
		if (t.status === 'pending' && when == null) return true;

		if (!t.scheduledFor || when == null) return false;
		return t.status === 'scheduled' || t.status === 'pending';
	});
}
