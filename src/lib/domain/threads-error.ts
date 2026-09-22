/**
 * Shared Meta-error helpers for Threads (client + server safe — no imports).
 *
 * Meta permission failures arrive as HTTP 400 with boilerplate text
 * ("... missing permissions ...") that ALSO appears inside unrelated
 * `code: 100` (invalid parameter) envelopes. The numeric `code` is the only
 * reliable signal, so the provider appends a ` [meta <code>[.<subcode>]]`
 * marker to its messages and every matcher below gates on it:
 * - marker present → the code decides (190/200 = auth, anything else = not)
 * - marker absent (legacy rows, unparseable bodies) → fall back to the
 *   Threads-scoped permission-text rule
 */

/** Meta codes that mean the credential itself is rejected. */
export const THREADS_META_AUTH_CODES = [190, 200];

const MARKER_PATTERN = /\[meta (\d+)(?:\.(\d+))?\]/;
const THREADS_MARKER = /threads/i;
const PERMISSION_TEXT = /missing permissions|permission denied|does not have permission/i;

export function formatThreadsMetaMarker(code: number, subcode?: number): string {
	return subcode !== undefined ? ` [meta ${code}.${subcode}]` : ` [meta ${code}]`;
}

export function parseThreadsMetaMarker(message: string): {
	code: number;
	subcode?: number;
} | null {
	const match = MARKER_PATTERN.exec(message);
	if (!match) return null;
	const code = Number(match[1]);
	if (!Number.isInteger(code)) return null;
	const sub = match[2] !== undefined ? Number(match[2]) : undefined;
	return sub !== undefined && Number.isInteger(sub) ? { code, subcode: sub } : { code };
}

export function hasThreadsPermissionText(message: string): boolean {
	return THREADS_MARKER.test(message) && PERMISSION_TEXT.test(message);
}

/**
 * Should this failure expire the connection / prompt reconnect?
 * Marker code wins when present; otherwise the legacy text rule applies.
 */
export function isThreadsAuthFailure(message: string): boolean {
	const marker = parseThreadsMetaMarker(message);
	if (marker) return THREADS_META_AUTH_CODES.includes(marker.code);
	return hasThreadsPermissionText(message);
}

/**
 * Media/container failures that a retry can fix:
 * - subcode 2207052: Meta's crawler intermittently fails to pull an image
 *   URL that works moments later (observed in production: the byte-identical
 *   image posted fine ~40s after this failure).
 * - subcode 4279004 ("Invalid carousel children"): a carousel child was not
 *   FINISHED (or its media download errored) when the CAROUSEL parent was
 *   created. Recreating the children with fresh signed URLs and waiting for
 *   each to finish is the documented recovery, so the failure must stay
 *   retryable rather than parking as permanent content.
 * - subcode 4279009 ("media not found"): reported at publish time and
 *   observed to succeed on retry.
 */
export function isThreadsMediaFetchFailure(message: string): boolean {
	return /media download has failed|could not be fetched from this uri|media could not be fetched|\[meta \d+\.(?:2207052|4279004|4279009)\]/i.test(
		message
	);
}
