import { describe, expect, it } from 'vitest';
import { humanizeError } from '$lib/domain/human-error';

describe('humanizeError', () => {
	it('maps auth failures to reconnect copy', () => {
		expect(humanizeError('401 Unauthorized')).toMatch(/reconnect/i);
		expect(humanizeError('createSession failed')).toMatch(/reconnect/i);
		expect(
			humanizeError(
				"Threads container failed (400): Unsupported post request. Object with ID '1' does not exist, cannot be loaded due to missing permissions"
			)
		).toMatch(/reconnect/i);
		expect(
			humanizeError(
				"Threads container failed (400): Unsupported post request. Object with ID '1' does not exist, cannot be loaded due to missing permissions [meta 100.33]"
			)
		).not.toMatch(/reconnect/i);
	});
	it('maps rate limits and network errors', () => {
		expect(
			humanizeError(
				'Threads container failed (400): {"error":{"error_subcode":2207052,"error_user_title":"Media download has failed."}}'
			)
		).toMatch(/could not download the image/i);
		expect(humanizeError('429 rate limit exceeded')).toMatch(/rate limited/i);
		expect(humanizeError('fetch failed')).toMatch(/reach the network/i);
	});
	it('keeps useful media and character errors', () => {
		expect(humanizeError('Image must be 16MB or smaller')).toMatch(/16MB/);
		expect(humanizeError('300 graphemes on this post')).toMatch(/grapheme/);
	});
	it('falls back for empty input', () => {
		expect(humanizeError(null)).toBe('Something went wrong');
	});
	it('maps already-scheduled and reconnect-needed', () => {
		expect(humanizeError('Already scheduled — cancel or reschedule from Posts')).toMatch(
			/scheduled/i
		);
		expect(humanizeError('One or more accounts need reconnect')).toMatch(/reconnect/i);
	});

	it('maps in-flight and already-published conflicts', () => {
		expect(humanizeError('Already publishing')).toMatch(/wait for it to finish/i);
		expect(humanizeError('Already published')).toMatch(/already published/i);
	});
});
