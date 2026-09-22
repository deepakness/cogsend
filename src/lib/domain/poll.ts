export interface PollConfig {
	options: string[];
	expiresIn: number;
	multiple?: boolean;
	hideTotals?: boolean;
}

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 4;
export const POLL_MAX_OPTION_CHARS = 50;
export const POLL_MIN_EXPIRY = 300;
export const POLL_MAX_EXPIRY = 604800;

/** Strict validation for user input. Options are trimmed before checking. */
export function validatePollConfig(
	input: unknown
): { ok: true; config: PollConfig } | { ok: false; error: string } {
	if (!input || typeof input !== 'object') return { ok: false, error: 'Invalid poll' };
	const r = input as Record<string, unknown>;
	if (!Array.isArray(r.options)) return { ok: false, error: 'Poll needs options' };
	const options = r.options.map((o) => (typeof o === 'string' ? o.trim() : '')).filter((o) => o);
	if (options.length < POLL_MIN_OPTIONS)
		return { ok: false, error: 'Poll needs at least 2 options' };
	if (options.length > POLL_MAX_OPTIONS) return { ok: false, error: 'Poll allows max 4 options' };
	if (options.some((o) => o.length > POLL_MAX_OPTION_CHARS)) {
		return { ok: false, error: 'Poll options allow max 50 characters each' };
	}
	if (
		typeof r.expiresIn !== 'number' ||
		!Number.isInteger(r.expiresIn) ||
		r.expiresIn < POLL_MIN_EXPIRY ||
		r.expiresIn > POLL_MAX_EXPIRY
	) {
		return { ok: false, error: 'Poll needs a duration between 5 minutes and 7 days' };
	}
	return {
		ok: true,
		config: {
			options,
			expiresIn: r.expiresIn,
			multiple: r.multiple === true ? true : undefined,
			hideTotals: r.hideTotals === true ? true : undefined
		}
	};
}

/** Lenient parse for stored configs: invalid stored data becomes null. */
export function parsePollConfig(input: unknown): PollConfig | null {
	const v = validatePollConfig(input);
	return v.ok ? v.config : null;
}
