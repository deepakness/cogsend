export const ALLOWED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export const MAX_IMAGE_BYTES = 16_000_000;
// app.bsky.embed.images raised the blob cap from 1MB to 2MB. The link-card
// thumb (app.bsky.embed.external) is still 1MB, so it keeps its own limit.
export const BLUESKY_MAX_IMAGE_BYTES = 2_000_000;
export const LINKEDIN_MAX_IMAGE_BYTES = 8_000_000;
// LinkedIn combines a flattened thread into one post, so this is a per-post
// cap. The provider imports this, so the two cannot drift.
export const LINKEDIN_MAX_IMAGES = 4;
export const X_MAX_IMAGE_BYTES = 5_000_000;
export const X_MAX_GIF_BYTES = 15_000_000;
export const THREADS_MAX_IMAGE_BYTES = 8_000_000;
export const MAX_IMAGES_PER_SEGMENT = 4;

// LinkedIn video posts: single mp4 per post. 95MB keeps uploads under the
// Worker request body limit.
export const MAX_VIDEO_BYTES = 95_000_000;

function looksLikeMp4(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 12 &&
		bytes[4] === 0x66 &&
		bytes[5] === 0x74 &&
		bytes[6] === 0x79 &&
		bytes[7] === 0x70
	);
}

/** Video validation (mp4 only). Sniffs ftyp when bytes are present. */
export function validateVideoUpload(input: {
	mime: string;
	size: number;
	bytes?: Uint8Array;
}): MediaValidationResult {
	const declared = (input.mime || '').toLowerCase().split(';')[0].trim();
	if (declared !== 'video/mp4') {
		return {
			ok: false,
			message: `Unsupported video type: ${input.mime || 'unknown'} (use MP4)`
		};
	}
	if (input.bytes && input.bytes.length > 0 && !looksLikeMp4(input.bytes)) {
		return { ok: false, message: 'File does not look like an MP4 video' };
	}
	if (input.size <= 0) return { ok: false, message: 'Empty file' };
	if (input.size > MAX_VIDEO_BYTES) {
		return { ok: false, message: 'Video too large (max 95MB)' };
	}
	return { ok: true, mime: 'video/mp4' };
}

export type MediaValidationOk = { ok: true; mime: string };
export type MediaValidationErr = { ok: false; message: string };
export type MediaValidationResult = MediaValidationOk | MediaValidationErr;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const WEBP_RIFF = [0x52, 0x49, 0x46, 0x46];

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
	if (bytes.length < sig.length) return false;
	return sig.every((b, i) => bytes[i] === b);
}

export function detectImageMime(bytes: Uint8Array): string | null {
	if (startsWith(bytes, PNG)) return 'image/png';
	if (startsWith(bytes, JPEG)) return 'image/jpeg';
	if (startsWith(bytes, GIF87) || startsWith(bytes, GIF89)) return 'image/gif';
	if (
		bytes.length >= 12 &&
		startsWith(bytes, WEBP_RIFF) &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return 'image/webp';
	}
	return null;
}

export function validateImageUpload(input: {
	mime: string;
	size: number;
	maxBytes?: number;
	bytes?: Uint8Array;
}): MediaValidationResult {
	const declared = (input.mime || '').toLowerCase().split(';')[0].trim();
	let mime = declared;

	if (input.bytes && input.bytes.length > 0) {
		const sniffed = detectImageMime(input.bytes);
		if (!sniffed) {
			return {
				ok: false,
				message: `Unsupported media type: ${input.mime || 'unknown'} (use PNG, JPEG, WebP, or GIF)`
			};
		}
		mime = sniffed;
	}

	if (!ALLOWED_IMAGE_MIMES.has(mime)) {
		return {
			ok: false,
			message: `Unsupported media type: ${input.mime || 'unknown'} (use PNG, JPEG, WebP, or GIF)`
		};
	}

	const max = input.maxBytes ?? MAX_IMAGE_BYTES;
	if (input.size <= 0) return { ok: false, message: 'Empty file' };
	if (input.size > max) {
		const mb = Math.round(max / 1_000_000);
		return { ok: false, message: `File too large (max ${mb}MB)` };
	}
	return { ok: true, mime };
}

const PLATFORM_LABEL = { bluesky: 'Bluesky', linkedin: 'LinkedIn', threads: 'Threads', x: 'X' };

function imageCap(platform: string, mime: string): number | null {
	if (platform === 'bluesky') return BLUESKY_MAX_IMAGE_BYTES;
	if (platform === 'linkedin') return LINKEDIN_MAX_IMAGE_BYTES;
	if (platform === 'threads') return THREADS_MAX_IMAGE_BYTES;
	if (platform === 'x') return mime === 'image/gif' ? X_MAX_GIF_BYTES : X_MAX_IMAGE_BYTES;
	return null;
}

/**
 * The first attached image a selected platform would refuse for its size, as
 * a message to show before publishing, or null. The providers refuse the same
 * image at publish time; checking here stops a guaranteed failure from being
 * scheduled. Video is left to the providers' own no-video checks.
 */
export function mediaSizeProblem(
	platforms: Iterable<string>,
	media: { mime: string; size?: number }[]
): string | null {
	for (const platform of platforms) {
		for (const m of media) {
			const mime = (m.mime || '').toLowerCase();
			if (mime.startsWith('video/') || m.size === undefined) continue;
			const cap = imageCap(platform, mime);
			if (cap !== null && m.size > cap) {
				const label = PLATFORM_LABEL[platform as keyof typeof PLATFORM_LABEL];
				const mb = cap / 1_000_000;
				return `An image is over ${label}'s ${mb}MB limit — remove it or uncheck ${label}`;
			}
		}
	}
	return null;
}

export function canAttachMoreImages(currentCount: number, max = MAX_IMAGES_PER_SEGMENT): boolean {
	return currentCount < max;
}

export function remapSegmentIndexAfterRemoval(
	segmentIndex: number,
	removedIndex: number
): number | null {
	if (segmentIndex === removedIndex) return null;
	if (segmentIndex > removedIndex) return segmentIndex - 1;
	return segmentIndex;
}

export function groupMediaBySegment<T extends { segmentIndex?: number | null }>(
	items: T[]
): Map<number, T[]> {
	const map = new Map<number, T[]>();
	for (const item of items) {
		const idx = item.segmentIndex ?? 0;
		const list = map.get(idx) ?? [];
		list.push(item);
		map.set(idx, list);
	}
	return map;
}
