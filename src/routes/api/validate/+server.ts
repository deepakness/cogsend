import type { RequestHandler } from './$types';
import {
	countGraphemes,
	mastodonWeightedLength,
	validateBlueskyText,
	validateLinkedinText,
	validateMastodonText,
	validateThreadsText,
	validateXText
} from '$lib/domain/validation/text';
import { fail, handleError, ok } from '$lib/server/http';
import { getProvider, isPlatformId, type PlatformId } from '$lib/server/providers';
import { requireScope, requireUser } from '$lib/server/require';
/** Five validators and a grapheme scan run over this text. */
const MAX_VALIDATE_LENGTH = 200_000;

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		requireUser(locals.user);
		requireScope(locals, 'read');
		const body = await request.json().catch(() => null);
		if (!body || typeof body !== 'object') return fail('Invalid JSON body', 400);
		const text = String(body.text || '');
		// Grapheme counting and five validators run over this: an unbounded body
		// is free CPU pressure for any read-scoped key.
		if (text.length > MAX_VALIDATE_LENGTH) {
			return fail(`text must be ${MAX_VALIDATE_LENGTH} characters or fewer`, 413);
		}
		const platform = body.platform as PlatformId | undefined;
		const maxCharacters = body.maxCharacters as number | undefined;
		const bluesky = validateBlueskyText(text);
		const mastodon = validateMastodonText(text, maxCharacters ?? 500);
		const linkedin = validateLinkedinText(text);
		const threads = validateThreadsText(text);
		const x = validateXText(text);
		let issues: { message: string; code?: string }[] = [];
		if (platform && isPlatformId(platform)) {
			issues = getProvider(platform).validate({ text }, { maxCharacters: maxCharacters ?? 500 });
		}
		return ok({
			graphemes: countGraphemes(text),
			mastodonLength: mastodonWeightedLength(text),
			bluesky,
			mastodon,
			linkedin,
			threads,
			x,
			issues
		});
	} catch (err) {
		return handleError(err);
	}
};
