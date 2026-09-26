import { describe, expect, it } from 'vitest';
import { zernioLink } from '$lib/domain/zernio-links';

describe('zernioLink', () => {
	it('tags every link with the sponsorship UTMs and the placement', () => {
		const url = new URL(zernioLink({ placement: 'readme-sponsor' }));
		expect(url.protocol).toBe('https:');
		expect(url.searchParams.get('utm_source')).toBe('cogsend');
		expect(url.searchParams.get('utm_medium')).toBe('sponsorship');
		expect(url.searchParams.get('utm_campaign')).toBe('cogsend-integration');
		expect(url.searchParams.get('utm_content')).toBe('readme-sponsor');
	});

	it('keeps the path and only ever points at Zernio', () => {
		expect(new URL(zernioLink({ path: '/pricing', placement: 'docs' })).pathname).toMatch(
			/\/pricing$/
		);
		expect(() => zernioLink({ path: 'https://evil.example', placement: 'x' })).toThrow();
		expect(() => zernioLink({ path: '//evil.example/x', placement: 'x' })).toThrow();
	});
});
