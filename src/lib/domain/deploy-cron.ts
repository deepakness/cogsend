/**
 * What the last deploy did with the cron trigger.
 *
 * Written by `scripts/wrangler.mjs` into `app_settings.cron_state`, read by the
 * Settings page and `npm run doctor`. It exists because the app cannot ask
 * Cloudflare about its own schedules: without this, a deployment whose trigger
 * was refused is indistinguishable from one that simply has not ticked yet.
 */
export type DeployCronStatus = 'attached' | 'disabled' | 'unavailable';

export interface DeployCronState {
	status: DeployCronStatus;
	/** The Cloudflare error code, when there is one (`10072`). */
	code: string | null;
	updatedAt: Date | null;
}

/**
 * Parse a stored value: `attached`, `disabled`, or `unavailable:<code>`.
 * Anything unrecognised reads as "nothing recorded", never as a status.
 */
export function parseDeployCronState(
	raw: string | null | undefined
): { status: DeployCronStatus; code: string | null } | null {
	const trimmed = raw?.trim();
	if (!trimmed) return null;
	const [name, code] = trimmed.split(':');
	if (name !== 'attached' && name !== 'disabled' && name !== 'unavailable') return null;
	return { status: name, code: code?.trim() ? code.trim() : null };
}
