import { parseJson } from './db/client';
import type { InferSelectModel } from 'drizzle-orm';
import type { connections, draftMedia, drafts, draftVariants, publishTargets } from './db/schema';

type Connection = InferSelectModel<typeof connections>;
type Draft = InferSelectModel<typeof drafts>;
type Variant = InferSelectModel<typeof draftVariants>;
type Media = InferSelectModel<typeof draftMedia>;
type Target = InferSelectModel<typeof publishTargets>;

type ConnectionSlim = Pick<
	Connection,
	| 'id'
	| 'platform'
	| 'displayName'
	| 'handle'
	| 'avatarUrl'
	| 'instanceUrl'
	| 'status'
	| 'metaJson'
	| 'createdAt'
>;
export function serializeConnection(c: ConnectionSlim) {
	return {
		id: c.id,
		platform: c.platform,
		displayName: c.displayName,
		handle: c.handle,
		avatarUrl: c.avatarUrl,
		instanceUrl: c.instanceUrl,
		status: c.status,
		metaJson: parseJson(c.metaJson, {}),
		createdAt: c.createdAt
	};
}

export function serializeMedia(m: Media) {
	return {
		id: m.id,
		draftId: m.draftId,
		storageKey: m.storageKey,
		mime: m.mime,
		size: m.size,
		width: m.width,
		height: m.height,
		altText: m.altText,
		sortOrder: m.sortOrder,
		segmentIndex: m.segmentIndex,
		createdAt: m.createdAt
	};
}

export function serializeVariant(v: Variant) {
	return {
		id: v.id,
		draftId: v.draftId,
		platform: v.platform,
		body: v.body,
		optionsJson: parseJson(v.optionsJson, {}),
		createdAt: v.createdAt,
		updatedAt: v.updatedAt
	};
}

export function serializeDraft(
	d: Draft,
	extras: {
		variants?: Variant[];
		media?: Media[];
		targets?: Array<
			Target & {
				connection?: {
					id: string;
					platform: string;
					handle: string | null;
					displayName?: string | null;
				};
			}
		>;
	} = {}
) {
	return {
		id: d.id,
		userId: d.userId,
		title: d.title,
		baseBody: d.baseBody,
		selectedConnectionIds: parseSelectedConnectionIds(d.selectedConnectionIds),
		status: d.status,
		createdAt: d.createdAt,
		updatedAt: d.updatedAt,
		variants: extras.variants?.map(serializeVariant) ?? [],
		media: extras.media?.map(serializeMedia) ?? [],
		targets: extras.targets ?? []
	};
}

/**
 * Stored selection: NULL means the draft never saved one (callers fall back
 * to publish targets or defaults); an array — including an empty one — is
 * authoritative. Anything malformed degrades to NULL.
 */
function parseSelectedConnectionIds(raw: string | null): string[] | null {
	const parsed = parseJson<unknown>(raw, null);
	if (!Array.isArray(parsed)) return null;
	return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
}
