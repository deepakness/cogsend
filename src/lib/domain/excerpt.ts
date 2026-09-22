/** One-line preview of a draft body for list views. Grapheme-safe. */
// Singleton: constructing Intl.Segmenter per card (N x per search keystroke)
// dominated Posts list renders. One shared instance is safe (stateless read).
let graphemeSegmenter: Intl.Segmenter | null = null;
function getGraphemeSegmenter(): Intl.Segmenter | null {
	if (graphemeSegmenter) return graphemeSegmenter;
	try {
		graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
		return graphemeSegmenter;
	} catch {
		return null;
	}
}
function segmentGraphemes(text: string): string[] {
	const seg = getGraphemeSegmenter();
	if (!seg) {
		// Very old runtimes without Intl.Segmenter: code points (splits ZWJ).
		return [...text];
	}
	return [...seg.segment(text)].map((s) => s.segment);
}

export function draftExcerpt(body: string | null | undefined, max = 120): string {
	// Thread delimiters read as noise in one-line lists: render as a separator.
	const text = (body || '')
		.replace(/\s*---\s*/g, ' · ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!text) return 'Empty draft';
	// Grapheme clusters (not code points): family emoji / flags / skin tones
	// must never split mid-joiner.
	const chars = segmentGraphemes(text);
	if (chars.length <= max) return text;
	return chars.slice(0, max).join('').trimEnd() + '…';
}
