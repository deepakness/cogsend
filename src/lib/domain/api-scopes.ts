export const SCOPE_READ = 'read';
export const SCOPE_WRITE = 'write';
export const ALL_SCOPES = [SCOPE_READ, SCOPE_WRITE] as const;
export type ApiScope = (typeof ALL_SCOPES)[number];

/**
 * Parse the stored scopes JSON. Null/missing means a legacy full-access key
 * (minted before scopes existed) — fail open for those rows so rotation, not a
 * migration, is the upgrade path. Anything else malformed fails closed: the app
 * never writes an empty array or a non-array, so granting access on one would
 * turn a corrupted row into a privilege escalation.
 */
export function parseApiScopes(raw: string | null | undefined): ApiScope[] {
	if (raw == null) return [...ALL_SCOPES];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((s): s is ApiScope => s === SCOPE_READ || s === SCOPE_WRITE);
	} catch {
		return [];
	}
}

/** `write` implies `read` (every mutating client also lists state first). */
export function hasApiScope(scopes: ApiScope[] | null | undefined, scope: ApiScope): boolean {
	if (!scopes) return true;
	if (scopes.includes(scope)) return true;
	if (scope === SCOPE_READ && scopes.includes(SCOPE_WRITE)) return true;
	return false;
}

/** Sanitize a rotation request's scopes: unknown entries dropped, empty → full. */
export function normalizeApiScopes(input: unknown): ApiScope[] {
	if (!Array.isArray(input)) return [...ALL_SCOPES];
	const kept = input.filter((s): s is ApiScope => s === SCOPE_READ || s === SCOPE_WRITE);
	return [...new Set(kept)].length ? [...new Set(kept)] : [...ALL_SCOPES];
}
