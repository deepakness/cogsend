/**
 * The two prompts the terminal scripts share.
 *
 * Both fall back to their default when there is no terminal to ask — a piped or
 * `--yes` run must never hang — and `askSecret` keeps the answer out of the
 * terminal's scrollback, which is the difference that matters for a password.
 */
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

/**
 * @param {string} question
 * @param {string} fallback
 * @param {{ interactive?: boolean }} [options]
 * @returns {Promise<string>}
 */
export async function ask(question, fallback, { interactive = process.stdin.isTTY } = {}) {
	if (!interactive) return fallback;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = (await rl.question(`  ${question}${fallback ? ` [${fallback}]` : ''}: `)).trim();
		return answer || fallback;
	} finally {
		rl.close();
	}
}

/**
 * @param {string} question
 * @param {{ interactive?: boolean }} [options]
 * @returns {Promise<string>} the typed answer, or '' when nothing was typed
 */
export async function askSecret(question, { interactive = process.stdin.isTTY } = {}) {
	if (!interactive) return '';
	process.stdout.write(`  ${question}: `);
	const muted = new Writable({
		write(_chunk, _encoding, callback) {
			callback();
		}
	});
	const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
	try {
		return (await rl.question('')).trim();
	} finally {
		rl.close();
		muted.end();
		process.stdout.write('\n');
	}
}
