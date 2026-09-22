import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '../src/routes/layout.css'), 'utf8');

/**
 * Guards the black-box-around-textarea regression: the global :focus-visible
 * ring must stay inside @layer base (bare author CSS beats Tailwind's layered
 * focus:outline-none utilities no matter the specificity) and text-entry
 * fields must be excluded from the ring (browsers match :focus-visible on
 * text inputs even for mouse focus).
 */
describe('global focus ring', () => {
	it('keeps the ring inside @layer base so utilities can override it', () => {
		const layerAt = css.indexOf('@layer base');
		const ringAt = css.indexOf('outline: 2px solid');
		expect(layerAt).toBeGreaterThanOrEqual(0);
		expect(ringAt).toBeGreaterThan(layerAt);
	});

	it('excludes text-entry fields from the ring', () => {
		expect(css).toContain('textarea:focus-visible');
		expect(css).toContain('input:is(');
		expect(css).toContain("[type='datetime-local']");
		expect(css).toContain('input:not([type]):focus-visible');
	});
});
