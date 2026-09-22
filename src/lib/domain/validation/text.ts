import { utf8ByteLength } from '../bytes';

export function countGraphemes(text: string): number {
	if (!text) return 0;
	try {
		const Seg = Intl.Segmenter;
		if (Seg) {
			const seg = new Seg(undefined, { granularity: 'grapheme' });
			return [...seg.segment(text)].length;
		}
	} catch {
		/* fall through */
	}
	return [...text].length;
}

export function mastodonWeightedLength(text: string, options: { urlLength?: number } = {}): number {
	const urlLength = options.urlLength ?? 23;
	if (!text) return 0;
	const re = /https?:\/\/[^\s]+/gi;
	let weighted = 0;
	let lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		weighted += countGraphemes(text.slice(lastIndex, match.index));
		weighted += urlLength;
		lastIndex = match.index + match[0].length;
	}
	weighted += countGraphemes(text.slice(lastIndex));
	return weighted;
}

function tooLong(length: number, max: number, label: string) {
	return {
		ok: false as const,
		length,
		max,
		message: `${length} / ${max} characters (${label})`
	};
}

export function validateBlueskyText(
	text: string,
	maxGraphemes = 300
): { ok: boolean; length: number; max: number; message?: string } {
	const length = countGraphemes(text);
	if (length > maxGraphemes) {
		return {
			ok: false,
			length,
			max: maxGraphemes,
			message: `${length} graphemes — over by ${length - maxGraphemes} (max ${maxGraphemes})`
		};
	}
	const bytes = utf8ByteLength(text);
	if (bytes > 3000) {
		return {
			ok: false,
			length,
			max: maxGraphemes,
			message: `Text exceeds 3000 UTF-8 bytes (${bytes})`
		};
	}
	return { ok: true, length, max: maxGraphemes };
}

export function validateMastodonText(
	text: string,
	maxChars = 500
): { ok: boolean; length: number; max: number; message?: string } {
	const length = mastodonWeightedLength(text);
	if (length > maxChars) {
		return {
			ok: false,
			length,
			max: maxChars,
			message: `${length} / ${maxChars} characters on this instance`
		};
	}
	return { ok: true, length, max: maxChars };
}

export const LINKEDIN_MAX_CHARS = 3000;
export const THREADS_MAX_CHARS = 500;
export const X_MAX_CHARS = 280;

export function validateLinkedinText(
	text: string,
	maxChars = LINKEDIN_MAX_CHARS
): { ok: boolean; length: number; max: number; message?: string } {
	const length = countGraphemes(text);
	if (length > maxChars) return tooLong(length, maxChars, 'LinkedIn max 3000');
	return { ok: true, length, max: maxChars };
}

export function validateThreadsText(
	text: string,
	maxChars = THREADS_MAX_CHARS
): { ok: boolean; length: number; max: number; message?: string } {
	const length = countGraphemes(text);
	if (length > maxChars) return tooLong(length, maxChars, 'Threads max 500');
	return { ok: true, length, max: maxChars };
}

export function validateXText(
	text: string,
	maxChars = X_MAX_CHARS
): { ok: boolean; length: number; max: number; message?: string } {
	const length = countGraphemes(text);
	if (length > maxChars) return tooLong(length, maxChars, 'X max 280');
	return { ok: true, length, max: maxChars };
}
