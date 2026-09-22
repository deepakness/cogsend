import { describe, expect, it } from 'vitest';
import {
	formatFullLocalWithZone,
	formatLocalDateTime,
	formatLocalDateTimeWithZone,
	localTimezoneShort
} from '$lib/domain/relative-time';

describe('local timezone formatting', () => {
	it('exposes a non-empty local zone abbreviation', () => {
		expect(localTimezoneShort().length).toBeGreaterThan(0);
	});

	it('formats an absolute local date/time', () => {
		const d = new Date(2026, 8, 9, 14, 30, 0, 0);
		const text = formatLocalDateTime(d);
		expect(text).toContain('Sep');
		expect(text).toContain('9');
		expect(text).toContain('30');
	});

	it('appends the zone and never shifts it', () => {
		const d = new Date(2026, 8, 9, 14, 30, 0, 0);
		expect(formatLocalDateTimeWithZone(d)).toBe(
			`${formatLocalDateTime(d)} ${localTimezoneShort()}`
		);
		const full = formatFullLocalWithZone(d);
		expect(full).toContain('2026');
		// Footer label and tooltip must name the SAME zone for one instant.
		expect(full).toContain(localTimezoneShort(d));
		expect(formatLocalDateTimeWithZone(d)).toContain(localTimezoneShort(d));
	});

	it('returns empty strings for invalid dates', () => {
		expect(formatLocalDateTime('not-a-date')).toBe('');
		expect(formatLocalDateTimeWithZone('not-a-date')).toBe('');
		expect(formatFullLocalWithZone('not-a-date')).toBe('');
	});
});
