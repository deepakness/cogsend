import { base32Decode, base32Encode } from './base32';
import { randomBytes } from './bytes';

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD = 30;
export const TOTP_WINDOW = 1;
export const TOTP_ISSUER = 'CogSend';

export function generateTotpSecret(): { bytes: Uint8Array; base32: string } {
	const bytes = randomBytes(20);
	return { bytes, base32: base32Encode(bytes) };
}

export function totpCounter(unixSeconds: number, period = TOTP_PERIOD): number {
	return Math.floor(unixSeconds / period);
}

export async function hotp(
	secret: Uint8Array,
	counter: number,
	digits = TOTP_DIGITS
): Promise<string> {
	const buf = new Uint8Array(8);
	let c = counter;
	for (let i = 7; i >= 0; i--) {
		buf[i] = c & 0xff;
		c = Math.floor(c / 256);
	}
	const key = await crypto.subtle.importKey(
		'raw',
		secret as BufferSource,
		{ name: 'HMAC', hash: 'SHA-1' },
		false,
		['sign']
	);
	const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf as BufferSource));
	const offset = sig[sig.length - 1] & 0x0f;
	const bin =
		((sig[offset] & 0x7f) << 24) |
		((sig[offset + 1] & 0xff) << 16) |
		((sig[offset + 2] & 0xff) << 8) |
		(sig[offset + 3] & 0xff);
	const otp = bin % 10 ** digits;
	return String(otp).padStart(digits, '0');
}

export async function totpAt(
	secret: Uint8Array,
	unixSeconds: number,
	digits = TOTP_DIGITS,
	period = TOTP_PERIOD
) {
	return hotp(secret, totpCounter(unixSeconds, period), digits);
}

export function normalizeTotpInput(raw: string): string | null {
	const digits = raw.replace(/\s+/g, '');
	if (!/^\d{6}$/.test(digits)) return null;
	return digits;
}

export async function verifyTotp(
	secret: Uint8Array,
	code: string,
	opts: { now?: Date; lastStep?: number | null; window?: number; period?: number } = {}
): Promise<{ ok: true; step: number } | { ok: false }> {
	const normalized = normalizeTotpInput(code);
	if (!normalized) return { ok: false };
	const period = opts.period ?? TOTP_PERIOD;
	const window = opts.window ?? TOTP_WINDOW;
	const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000);
	const center = totpCounter(nowSec, period);
	for (let delta = -window; delta <= window; delta++) {
		const step = center + delta;
		if (opts.lastStep != null && step <= opts.lastStep) continue;
		const expected = await hotp(secret, step);
		if (expected === normalized) return { ok: true, step };
	}
	return { ok: false };
}

export function buildOtpauthUrl(opts: {
	email: string;
	secretBase32: string;
	issuer?: string;
}): string {
	const issuer = opts.issuer ?? TOTP_ISSUER;
	const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(opts.email)}`;
	const q = new URLSearchParams({
		secret: opts.secretBase32.replace(/\s+/g, ''),
		issuer,
		algorithm: 'SHA1',
		digits: String(TOTP_DIGITS),
		period: String(TOTP_PERIOD)
	});
	return `otpauth://totp/${label}?${q.toString()}`;
}

export function secretFromBase32(base32: string): Uint8Array {
	return base32Decode(base32);
}
