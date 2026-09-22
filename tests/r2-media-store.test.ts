import { describe, expect, it } from 'vitest';
import { r2MediaStore } from '$lib/server/media';

/**
 * `r2MediaStore` is the production store — every upload, media serve and
 * provider hand-off goes through it — and no test executed a line of it; the
 * suite only ever used the in-memory stand-in. These exercise it against a
 * minimal R2 stand-in so the two stores cannot drift.
 */
function fakeBucket() {
	const objects = new Map<string, { bytes: Uint8Array; mime?: string }>();
	const bucket = {
		async get(key: string, opts?: { range?: { offset: number; length: number } }) {
			const entry = objects.get(key);
			if (!entry) return null;
			const bytes = opts?.range
				? entry.bytes.slice(opts.range.offset, opts.range.offset + opts.range.length)
				: entry.bytes;
			return {
				arrayBuffer: async () =>
					bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
			};
		},
		async head(key: string) {
			const entry = objects.get(key);
			return entry ? { size: entry.bytes.length } : null;
		},
		async put(key: string, bytes: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
			objects.set(key, { bytes, mime: opts?.httpMetadata?.contentType });
		},
		async delete(key: string) {
			objects.delete(key);
		}
	};
	return { bucket, objects };
}

describe('r2MediaStore', () => {
	it('round-trips bytes and records the content type', async () => {
		const { bucket, objects } = fakeBucket();
		const store = r2MediaStore(bucket as unknown as R2Bucket);
		const bytes = new Uint8Array([1, 2, 3, 4, 5]);

		await store.put('media/one.png', bytes, 'image/png');

		expect(await store.size!('media/one.png')).toBe(5);
		expect(await store.get('media/one.png')).toEqual(bytes);
		expect(objects.get('media/one.png')?.mime).toBe('image/png');
	});

	it('serves a byte range without the whole object', async () => {
		const { bucket } = fakeBucket();
		const store = r2MediaStore(bucket as unknown as R2Bucket);
		await store.put('media/video.mp4', new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]), 'video/mp4');

		expect(await store.getRange!('media/video.mp4', 2, 4)).toEqual(new Uint8Array([2, 3, 4]));
	});

	it('returns null for a missing key on every read path', async () => {
		const { bucket } = fakeBucket();
		const store = r2MediaStore(bucket as unknown as R2Bucket);

		expect(await store.get('nope')).toBeNull();
		expect(await store.getRange!('nope', 0, 10)).toBeNull();
		expect(await store.size!('nope')).toBeNull();
	});

	it('deletes', async () => {
		const { bucket } = fakeBucket();
		const store = r2MediaStore(bucket as unknown as R2Bucket);
		await store.put('media/two.png', new Uint8Array([9]), 'image/png');

		await store.delete('media/two.png');

		expect(await store.get('media/two.png')).toBeNull();
		// Deleting a missing key is a no-op, not an error.
		await expect(store.delete('media/two.png')).resolves.toBeUndefined();
	});
});
