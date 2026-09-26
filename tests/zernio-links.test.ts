import { describe, expect, it } from 'vitest';
import { zernioLink } from '$lib/domain/zernio-links';

describe('zernioLink', () => {
	it('sends a plain Zernio link through the maintainer’s affiliate link, with the UTMs', () => {
		const url = new URL(zernioLink({ placement: 'readme-sponsor' }));
		expect(url.origin + url.pathname).toBe('https://zernio.link/deepak-kumar');
		expect(url.searchParams.get('utm_source')).toBe('cogsend');
		expect(url.searchParams.get('utm_medium')).toBe('sponsorship');
		expect(url.searchParams.get('utm_campaign')).toBe('cogsend-integration');
		expect(url.searchParams.get('utm_content')).toBe('readme-sponsor');
	});

	it('keeps attribution on a deep link, which the short link cannot carry', () => {
		// zernio.link/<slug>/pricing does not redirect; zernio.com reads ?via=
		// through its analytics script instead.
		const url = new URL(zernioLink({ path: '/pricing', placement: 'docs' }));
		expect(url.origin + url.pathname).toBe('https://zernio.com/pricing');
		expect(url.searchParams.get('via')).toBe('deepak-kumar');
		expect(url.searchParams.get('utm_content')).toBe('docs');
	});

	it('only ever points at Zernio', () => {
		expect(() => zernioLink({ path: 'https://evil.example', placement: 'x' })).toThrow();
		expect(() => zernioLink({ path: '//evil.example/x', placement: 'x' })).toThrow();
	});
});
