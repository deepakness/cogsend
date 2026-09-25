import { formatLocalDateTimeWithZone, formatRelativeTime } from './relative-time';

export type SchedulePreset = {
	id: string;
	label: string;
	minutes: number;
};

export function toDatetimeLocalValue(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function parseDatetimeLocal(value: string): Date | null {
	if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null;
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return null;
	return d;
}

export function defaultScheduleDatetime(now: Date = new Date(), bufferMinutes = 15): string {
	const t = new Date(now.getTime() + Math.max(1, bufferMinutes) * 60_000);
	t.setSeconds(0, 0);
	if (t.getTime() <= now.getTime()) {
		t.setTime(now.getTime() + 60_000);
		t.setSeconds(0, 0);
	}
	return toDatetimeLocalValue(t);
}

export function minScheduleDatetime(now: Date = new Date()): string {
	const t = new Date(now.getTime() + 60_000);
	t.setSeconds(0, 0);
	return toDatetimeLocalValue(t);
}

export function isFutureScheduleValue(value: string, now: Date = new Date()): boolean {
	const d = parseDatetimeLocal(value);
	if (!d) return false;
	return d.getTime() > now.getTime();
}

export function scheduleFromOffset(minutes: number, now: Date = new Date()): string {
	if (minutes === -1) {
		const t = new Date(now);
		t.setDate(t.getDate() + 1);
		t.setHours(9, 0, 0, 0);
		if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
		return toDatetimeLocalValue(t);
	}
	const t = new Date(now.getTime() + minutes * 60_000);
	t.setSeconds(0, 0);
	return toDatetimeLocalValue(t);
}

export function scheduleValueToIso(value: string, now: Date = new Date()): string | null {
	if (!isFutureScheduleValue(value, now)) return null;
	return parseDatetimeLocal(value)!.toISOString();
}

export const DEFAULT_SCHEDULE_OFFSET = { days: 0, hours: 1, mins: 0 };

/** Sanitize a days/hours/mins offset field: empty/non-numeric goes to 0, negatives to 0. */
export function parseOffsetField(value: string | number | null | undefined): number {
	const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
	if (!Number.isFinite(n)) return 0;
	return Math.min(3650, Math.max(0, Math.floor(n)));
}

/**
 * datetime-local value for now + a days/hours/mins offset, in the browser's
 * local timezone (same basis as the date/time inputs and all displayed
 * times). Seconds zeroed. At least 1 minute out so the result is future.
 */
export function scheduleFromDHM(
	days: string | number | null | undefined,
	hours: string | number | null | undefined,
	mins: string | number | null | undefined,
	now: Date = new Date()
): string {
	const totalMinutes =
		parseOffsetField(days) * 24 * 60 + parseOffsetField(hours) * 60 + parseOffsetField(mins);
	const t = new Date(now.getTime() + Math.max(1, totalMinutes) * 60_000);
	t.setSeconds(0, 0);
	if (t.getTime() <= now.getTime()) {
		t.setTime(now.getTime() + 60_000);
		t.setSeconds(0, 0);
	}
	return toDatetimeLocalValue(t);
}

/**
 * The day/hour/minute fields `scheduleFromDHM` wants, from a "Publish in N
 * <unit>" control. Both schedule popovers (the composer and the posts page) had
 * their own copy of this mapping.
 */
export function offsetToDHM(
	value: string | number | null | undefined,
	unit: 'days' | 'hours' | 'mins'
): { days: string; hours: string; minutes: string } {
	const v = String(value ?? '');
	return {
		days: unit === 'days' ? v : '0',
		hours: unit === 'hours' ? v : '0',
		minutes: unit === 'mins' ? v : '0'
	};
}

/**
 * "Will publish <local time> (<relative>)" for a datetime-local value, or null
 * when it is empty, unparseable, or not in the future. Shared so the composer
 * and the posts page cannot describe the same value differently.
 */
export function schedulePreviewText(value: string, now: Date = new Date()): string | null {
	if (!value || !isFutureScheduleValue(value, now)) return null;
	const date = parseDatetimeLocal(value);
	if (!date) return null;
	return `${formatLocalDateTimeWithZone(date)} (${formatRelativeTime(date)})`;
}

export function listSchedulePresets(): SchedulePreset[] {
	return [
		{ id: '15m', label: '15 min', minutes: 15 },
		{ id: '30m', label: '30 min', minutes: 30 },
		{ id: '1h', label: '1 hour', minutes: 60 },
		{ id: '2h', label: '2 hours', minutes: 120 },
		{ id: 'tmr9', label: 'Tomorrow 9am', minutes: -1 }
	];
}

/**
 * The datetime-local value (browser local zone, minute precision) of the
 * earliest future `scheduledFor` across a draft's publish targets, or null when
 * none is future. Missing, malformed, and past values are skipped, so legacy
 * rows with mixed target times still restore deterministically. A value inside
 * the current minute counts as past: it would truncate to a non-future value.
 */
export function earliestFutureScheduleValue(
	targets: ReadonlyArray<{ scheduledFor?: unknown }> | null | undefined,
	now: Date = new Date()
): string | null {
	let best: { value: string; time: number } | null = null;
	for (const t of targets ?? []) {
		const raw = t?.scheduledFor;
		if (raw === null || raw === undefined || raw === '') continue;
		if (typeof raw !== 'string' && typeof raw !== 'number' && !(raw instanceof Date)) continue;
		const date = new Date(raw);
		if (Number.isNaN(date.getTime())) continue;
		const value = toDatetimeLocalValue(date);
		if (!isFutureScheduleValue(value, now)) continue;
		const time = parseDatetimeLocal(value)!.getTime();
		if (!best || time < best.time) best = { value, time };
	}
	return best?.value ?? null;
}
