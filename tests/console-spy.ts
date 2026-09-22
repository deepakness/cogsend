import { afterEach, vi } from 'vitest';

/**
 * Take the console output a test expects, instead of letting it print.
 *
 * Several tests exercise failure paths on purpose — a database that hits its
 * query budget, a provider that answers without an id, a missing table — and
 * the code under test logs them. Printed, a passing run fills up with stack
 * traces (`npm run deploy:release` then looks like it failed, which is exactly
 * how it reads to anyone who did not write these tests), so the test takes the
 * call and asserts it. The returned spy is the assertion: if the path stops
 * logging, the test fails.
 *
 * Restored automatically after each test, including when the test fails.
 */
const captured: Array<{ mockRestore(): void }> = [];

afterEach(() => {
	for (const spy of captured) spy.mockRestore();
	captured.length = 0;
});

export function captureConsole(method: 'error' | 'warn' | 'log' = 'error') {
	const spy = vi.spyOn(console, method).mockImplementation(() => {});
	captured.push(spy);
	return spy;
}

/** Everything a captured call wrote, flattened into one line per call. */
export function loggedLines(spy: { mock: { calls: unknown[][] } }): string[] {
	return spy.mock.calls.map((call) =>
		call
			.map((part) =>
				part instanceof Error
					? `${part.name}: ${part.message}`
					: typeof part === 'string'
						? part
						: JSON.stringify(part)
			)
			.join(' ')
	);
}
