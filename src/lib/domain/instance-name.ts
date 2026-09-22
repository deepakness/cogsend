/** Longest accepted instance name, shared by the API and the settings form. */
export const INSTANCE_NAME_MAX = 60;

/**
 * Trimmed instance name, or null when blank (blank means "use the default").
 * Kept in one place so the settings form and the API agree on the rules.
 */
export function parseInstanceName(
	input: unknown
): { ok: true; name: string | null } | { ok: false } {
	if (input === undefined || input === null) return { ok: true, name: null };
	if (typeof input !== 'string') return { ok: false };
	const name = input.trim();
	if (name.length === 0) return { ok: true, name: null };
	if (name.length > INSTANCE_NAME_MAX) return { ok: false };
	return { ok: true, name };
}
