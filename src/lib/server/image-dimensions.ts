/**
 * Minimal image-dimension decoder (Cloudflare Workers compatible — no native
 * deps like sharp). Supports PNG, JPEG (SOF0/1/2/3, with EXIF-orientation
 * swap), GIF, WebP (VP8/VP8L/VP8X).
 *
 * Returns null when bytes are truncated or the format is unknown — callers
 * must treat that as "omit aspectRatio" (Bluesky docs: leave undefined
 * instead of guessing).
 */

export interface ImageDimensions {
	width: number;
	height: number;
}

function u16be(b: Uint8Array, o: number): number {
	return (b[o]! * 256 + b[o + 1]!) >>> 0;
}

function u16le(b: Uint8Array, o: number): number {
	return (b[o]! + b[o + 1]! * 256) >>> 0;
}

function u24le(b: Uint8Array, o: number): number {
	return b[o]! + b[o + 1]! * 256 + b[o + 2]! * 65536;
}

function u32be(b: Uint8Array, o: number): number {
	return b[o]! * 16777216 + b[o + 1]! * 65536 + b[o + 2]! * 256 + b[o + 3]!;
}

function u32le(b: Uint8Array, o: number): number {
	return (b[o]! + b[o + 1]! * 256 + b[o + 2]! * 65536 + b[o + 3]! * 16777216) >>> 0;
}

function valid(d: { width: number; height: number } | null): d is ImageDimensions {
	return (
		!!d &&
		Number.isInteger(d.width) &&
		Number.isInteger(d.height) &&
		d.width > 0 &&
		d.height > 0 &&
		d.width <= 30000 &&
		d.height <= 30000
	);
}

function decodePng(b: Uint8Array): ImageDimensions | null {
	// 8-byte sig + 4 len + 4 type + 13 IHDR
	if (b.length < 33) return null;
	const type = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!) !== 'IHDR' ? null : 'IHDR';
	if (!type) return null;
	const width = u32be(b, 16);
	const height = u32be(b, 20);
	return valid({ width, height }) ? { width, height } : null;
}

function exifOrientationSwaps(jpeg: Uint8Array, app1Start: number, app1Len: number): boolean {
	// APP1: `Exif\0\0` + TIFF header. Look for tag 0x0112 == orientation 5..8.
	try {
		let o = app1Start;
		const end = Math.min(jpeg.length, app1Start + app1Len);
		if (end - o < 14) return false;
		if (
			jpeg[o] !== 0x45 ||
			jpeg[o + 1] !== 0x78 ||
			jpeg[o + 2] !== 0x69 ||
			jpeg[o + 3] !== 0x66 ||
			jpeg[o + 4] !== 0 ||
			jpeg[o + 5] !== 0
		) {
			return false;
		}
		o += 6;
		const little = jpeg[o] === 0x49 && jpeg[o + 1] === 0x49;
		const big = jpeg[o] === 0x4d && jpeg[o + 1] === 0x4d;
		if (!little && !big) return false;
		const read16 = (p: number) => (little ? u16le(jpeg, p) : u16be(jpeg, p));
		const read32 = (p: number) => (little ? u32le(jpeg, p) : u32be(jpeg, p));
		const ifdOffset = read32(o + 4);
		let p = o + ifdOffset;
		if (p + 2 > end) return false;
		const entries = read16(p);
		p += 2;
		if (entries > 50) return false;
		for (let i = 0; i < entries; i++) {
			if (p + 12 > end) return false;
			const tag = read16(p);
			if (tag === 0x0112) {
				const type = read16(p + 2);
				if (type !== 3) return false;
				const val = read16(p + 8);
				return val >= 5 && val <= 8;
			}
			p += 12;
		}
	} catch {
		// Corrupt EXIF must not break dimension decoding.
	}
	return false;
}

function decodeJpeg(b: Uint8Array): ImageDimensions | null {
	if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
	let o = 2;
	let swapForOrientation = false;
	while (o + 4 <= b.length) {
		if (b[o] !== 0xff) return null;
		const marker = b[o + 1]!;
		if (marker === 0xd8 || marker === 0xd9) {
			o += 2;
			continue;
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			o += 2;
			continue;
		}
		if (o + 4 > b.length) return null;
		const len = u16be(b, o + 2);
		if (len < 2 || o + 2 + len > b.length) {
			// Truncated segment: stop rather than mis-decode.
			return null;
		}
		if (marker === 0xe1 && !swapForOrientation) {
			swapForOrientation = exifOrientationSwaps(b, o + 4, len - 2);
		}
		const isSof =
			marker === 0xc0 ||
			marker === 0xc1 ||
			marker === 0xc2 ||
			marker === 0xc3 ||
			marker === 0xc5 ||
			marker === 0xc6 ||
			marker === 0xc7 ||
			marker === 0xc9 ||
			marker === 0xca ||
			marker === 0xcb ||
			marker === 0xcd ||
			marker === 0xce ||
			marker === 0xcf;
		if (isSof) {
			if (o + 9 >= b.length) return null;
			const height = u16be(b, o + 5);
			const width = u16be(b, o + 7);
			const dims = swapForOrientation ? { width: height, height: width } : { width, height };
			return valid(dims) ? dims : null;
		}
		// SOS (0xDA) starts the scan — no SOF after this.
		if (marker === 0xda) return null;
		o += 2 + len;
	}
	return null;
}

function decodeGif(b: Uint8Array): ImageDimensions | null {
	if (b.length < 10) return null;
	const width = u16le(b, 6);
	const height = u16le(b, 8);
	return valid({ width, height }) ? { width, height } : null;
}

function decodeWebp(b: Uint8Array): ImageDimensions | null {
	if (b.length < 16) return null;
	// RIFF....WEBP
	if (
		b[0] !== 0x52 ||
		b[1] !== 0x49 ||
		b[2] !== 0x46 ||
		b[3] !== 0x46 ||
		b[8] !== 0x57 ||
		b[9] !== 0x45 ||
		b[10] !== 0x42 ||
		b[11] !== 0x50
	) {
		return null;
	}
	const chunk = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
	if (chunk === 'VP8 ') {
		// 10-byte frame header at 20, then 3-byte start code, then 14-bit dims.
		if (b.length < 30) return null;
		if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
		const w = u16le(b, 26) & 0x3fff;
		const h = u16le(b, 28) & 0x3fff;
		return valid({ width: w, height: h }) ? { width: w, height: h } : null;
	}
	if (chunk === 'VP8L') {
		if (b.length < 25) return null;
		// 1 signature byte + 14 bits w-1 + 14 bits h-1 packed LE.
		const b0 = b[21]!;
		const b1 = b[22]!;
		const b2 = b[23]!;
		const b3 = b[24]!;
		const w = 1 + (((b1 & 0x3f) << 8) | b0);
		const h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
		return valid({ width: w, height: h }) ? { width: w, height: h } : null;
	}
	if (chunk === 'VP8X') {
		if (b.length < 30) return null;
		const w = 1 + u24le(b, 24);
		const h = 1 + u24le(b, 27);
		return valid({ width: w, height: h }) ? { width: w, height: h } : null;
	}
	return null;
}

/** Decode pixel dimensions from raw image bytes. Null = unknown/truncated. */
export function decodeImageDimensions(bytes: Uint8Array): ImageDimensions | null {
	if (!bytes || bytes.length < 10) return null;
	// PNG
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return decodePng(bytes);
	}
	// JPEG
	if (bytes[0] === 0xff && bytes[1] === 0xd8) return decodeJpeg(bytes);
	// GIF
	if (
		bytes.length >= 6 &&
		bytes[0] === 0x47 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x38 &&
		(bytes[4] === 0x37 || bytes[4] === 0x39) &&
		bytes[5] === 0x61
	) {
		return decodeGif(bytes);
	}
	// WebP
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return decodeWebp(bytes);
	}
	return null;
}
