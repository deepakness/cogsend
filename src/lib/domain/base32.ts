const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const REV = new Map([...ALPHABET].map((c, i) => [c, i]));

export function base32Encode(bytes: Uint8Array, { padding = false } = {}): string {
	let bits = 0;
	let value = 0;
	let out = '';
	for (const b of bytes) {
		value = (value << 8) | b;
		bits += 8;
		while (bits >= 5) {
			out += ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
	if (padding) {
		while (out.length % 8 !== 0) out += '=';
	}
	return out;
}

export function base32Decode(input: string): Uint8Array {
	const clean = input.toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const ch of clean) {
		const v = REV.get(ch);
		if (v === undefined) throw new Error('Invalid base32');
		value = (value << 5) | v;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return new Uint8Array(out);
}

export function formatSecretGroups(base32: string): string {
	const compact = base32.replace(/\s+/g, '').toUpperCase();
	return compact.match(/.{1,4}/g)?.join(' ') ?? compact;
}
