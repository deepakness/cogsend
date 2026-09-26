export type EncodeStep = { width: number; height: number; type: string; quality?: number };

export type ImageCodec = {
	decode(file: File): Promise<{ width: number; height: number; close(): void } | null>;
	encode(image: { width: number; height: number }, step: EncodeStep): Promise<Blob | null>;
};

// Long edges to try, largest first. 2560 keeps a retina screenshot's text
// legible; Bluesky's own app serves images at 2000px, so going smaller only
// happens when a busy photo will not fit otherwise.
const EDGES = [2560, 2048, 1600];
const JPEG_QUALITIES = [0.9, 0.8, 0.7];

/**
 * Encodings to try, cheapest loss first. A PNG screenshot is first tried as a
 * smaller PNG, because JPEG smears text; everything then falls back to JPEG,
 * the one format every platform accepts (LinkedIn refuses WebP, Threads takes
 * only JPEG and PNG).
 */
export function shrinkSteps(width: number, height: number, mime: string): EncodeStep[] {
	const steps: EncodeStep[] = [];
	const seen = new Set<string>();
	for (const edge of EDGES) {
		const scale = Math.min(1, edge / Math.max(width, height));
		const w = Math.max(1, Math.round(width * scale));
		const h = Math.max(1, Math.round(height * scale));
		if (seen.has(`${w}x${h}`)) continue;
		seen.add(`${w}x${h}`);
		if (mime === 'image/png' && scale < 1) steps.push({ width: w, height: h, type: 'image/png' });
		for (const quality of JPEG_QUALITIES)
			steps.push({ width: w, height: h, type: 'image/jpeg', quality });
	}
	return steps;
}

async function isAnimatedWebp(file: File): Promise<boolean> {
	const head = new Uint8Array(await file.slice(0, 21).arrayBuffer());
	const chunk = String.fromCharCode(...head.slice(12, 16));
	return chunk === 'VP8X' && (head[20] & 0x02) !== 0;
}

function renamed(name: string, type: string): string {
	const ext = type === 'image/png' ? 'png' : 'jpg';
	const base = name.replace(/\.[^./\\]+$/, '') || 'image';
	return `${base}.${ext}`;
}

const canvasCodec: ImageCodec = {
	async decode(file) {
		if (typeof createImageBitmap !== 'function') return null;
		return createImageBitmap(file);
	},
	async encode(image, step) {
		const bitmap = image as ImageBitmap;
		const paint = (ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D) => {
			// JPEG has no alpha: without a fill, transparent pixels turn black.
			if (step.type === 'image/jpeg') {
				ctx.fillStyle = '#fff';
				ctx.fillRect(0, 0, step.width, step.height);
			}
			ctx.imageSmoothingQuality = 'high';
			ctx.drawImage(bitmap, 0, 0, step.width, step.height);
		};
		// Safari before 16.4 has no OffscreenCanvas.
		if (typeof OffscreenCanvas === 'function') {
			const canvas = new OffscreenCanvas(step.width, step.height);
			const ctx = canvas.getContext('2d');
			if (!ctx) return null;
			paint(ctx);
			return canvas.convertToBlob({ type: step.type, quality: step.quality });
		}
		const canvas = document.createElement('canvas');
		canvas.width = step.width;
		canvas.height = step.height;
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		paint(ctx);
		return new Promise((resolve) => canvas.toBlob(resolve, step.type, step.quality));
	}
};

/**
 * Re-encode an image in the browser until it fits `maxBytes`, so a pasted
 * screenshot uploads at a size every platform takes. Files already under the
 * cap, GIFs and animated WebP pass through untouched: re-encoding would drop
 * the animation. When nothing fits, the smallest result is kept if it beats
 * the original, and the composer's size checks report the rest.
 */
export async function shrinkToFit(
	file: File,
	maxBytes: number,
	codec: ImageCodec = canvasCodec
): Promise<File> {
	const type = file.type.toLowerCase();
	if (file.size <= maxBytes) return file;
	if (type !== 'image/png' && type !== 'image/jpeg' && type !== 'image/webp') return file;
	try {
		if (type === 'image/webp' && (await isAnimatedWebp(file))) return file;
		const image = await codec.decode(file);
		if (!image) return file;
		try {
			let best: Blob | null = null;
			let bestType = '';
			for (const step of shrinkSteps(image.width, image.height, type)) {
				const blob = await codec.encode(image, step);
				if (!blob || blob.size === 0) continue;
				if (!best || blob.size < best.size) {
					best = blob;
					bestType = step.type;
				}
				if (blob.size <= maxBytes) break;
			}
			if (!best || best.size >= file.size) return file;
			return new File([best], renamed(file.name, bestType), {
				type: bestType,
				lastModified: file.lastModified
			});
		} finally {
			image.close();
		}
	} catch {
		// A browser that cannot decode or encode this image still uploads the
		// original; the size checks explain what will not take it.
		return file;
	}
}
