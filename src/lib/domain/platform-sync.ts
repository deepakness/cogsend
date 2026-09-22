import { isPlatformId, type PlatformId } from './platforms';

export type { PlatformId };

export type PlatformOverride = {
	body: string | null;
};

export type PlatformOverrideMap = Partial<Record<PlatformId, PlatformOverride>>;

export function isPlatformCustomized(
	overrides: PlatformOverrideMap,
	platform: PlatformId
): boolean {
	const o = overrides[platform];
	return o != null && o.body !== null && o.body !== undefined;
}

export function effectivePlatformBody(
	mainBody: string,
	overrides: PlatformOverrideMap,
	platform: PlatformId
): string {
	if (isPlatformCustomized(overrides, platform)) {
		return overrides[platform]!.body ?? '';
	}
	return mainBody;
}

export function customizePlatformBody(
	overrides: PlatformOverrideMap,
	platform: PlatformId,
	body: string
): PlatformOverrideMap {
	return { ...overrides, [platform]: { body } };
}

export function resetPlatformToFollow(
	overrides: PlatformOverrideMap,
	platform: PlatformId
): PlatformOverrideMap {
	const next = { ...overrides };
	if (next[platform]) next[platform] = { body: null };
	return next;
}

export function customizedBodiesForSave(
	_mainBody: string,
	overrides: PlatformOverrideMap,
	platforms: PlatformId[]
): Partial<Record<PlatformId, string>> {
	const out: Partial<Record<PlatformId, string>> = {};
	for (const p of platforms) {
		if (isPlatformCustomized(overrides, p)) {
			out[p] = overrides[p]!.body ?? '';
		}
	}
	return out;
}

export function overridesFromVariants(
	variants: Array<{ platform: string; body: string | null }>,
	mainBody: string
): PlatformOverrideMap {
	const map: PlatformOverrideMap = {};
	for (const v of variants) {
		if (!isPlatformId(v.platform)) continue;
		if (v.body === null || v.body === undefined || v.body === mainBody) {
			map[v.platform] = { body: null };
		} else {
			map[v.platform] = { body: v.body };
		}
	}
	return map;
}

export function platformsFromConnections(connections: Array<{ platform: string }>): PlatformId[] {
	const set = new Set<PlatformId>();
	for (const c of connections) {
		if (isPlatformId(c.platform)) set.add(c.platform);
	}
	return Array.from(set);
}

/**
 * Decide which connection ids a deep-linked draft should select from its
 * publish targets. Returns null when the draft has no targets (caller keeps
 * its default selection); otherwise the target ids that still exist. Unknown
 * ids (deleted connections) are dropped.
 */
export function resolveRestoredSelection(
	targetIds: Array<string | null | undefined>,
	connections: Array<{ id: string }>
): string[] | null {
	const wanted = targetIds.filter((id): id is string => Boolean(id));
	if (!wanted.length) return null;
	const ids = new Set(connections.map((c) => c.id));
	return wanted.filter((id) => ids.has(id));
}

/**
 * Selection saved on the draft itself, which wins over publish targets when
 * present. Returns null when the draft never stored one (legacy rows) so the
 * caller can fall back; an explicitly empty list stays empty — the user
 * cleared every account and that must survive a reload. Unknown ids
 * (disconnected/deleted connections) are dropped.
 */
export function resolveSavedSelection(
	ids: unknown,
	connections: Array<{ id: string }>
): string[] | null {
	if (!Array.isArray(ids)) return null;
	const known = new Set(connections.map((c) => c.id));
	return ids.filter((id): id is string => typeof id === 'string' && known.has(id));
}
