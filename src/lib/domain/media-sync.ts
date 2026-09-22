export type MediaMove = { id: string; segmentIndex: number };

export type MediaLayoutResult = { ok: boolean; failed: number };

/**
 * Persist optimistic media-layout changes (segment moves and removals) to the
 * draft media API. The composer applies these locally the moment the user
 * reorders or removes an image, but publish reads the *stored* segmentIndex —
 * so a dropped request nobody notices can attach an image to the wrong thread
 * post. One retry covers a blip; the final failure is reported so the caller
 * can tell the user instead of publishing a layout nobody chose.
 */
export async function persistMediaLayout(change: {
	draftId: string;
	moves?: MediaMove[];
	removals?: string[];
	fetchImpl?: typeof fetch;
	retryDelayMs?: number;
}): Promise<MediaLayoutResult> {
	const { draftId, moves = [], removals = [] } = change;
	const fetchImpl = change.fetchImpl ?? fetch;
	if (!draftId || moves.length + removals.length === 0) return { ok: true, failed: 0 };

	type Op = { kind: 'move'; move: MediaMove } | { kind: 'remove'; id: string };

	const send = async (op: Op): Promise<boolean> => {
		try {
			const res =
				op.kind === 'move'
					? await fetchImpl(`/api/drafts/${draftId}/media`, {
							method: 'PATCH',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ mediaId: op.move.id, segmentIndex: op.move.segmentIndex })
						})
					: await fetchImpl(`/api/drafts/${draftId}/media?mediaId=${encodeURIComponent(op.id)}`, {
							method: 'DELETE'
						});
			return res.ok;
		} catch {
			return false;
		}
	};

	// Only failures are repeated: both verbs are idempotent, but re-sending a
	// request the server already applied wastes a round trip for nothing.
	const runBatch = async (ops: Op[]): Promise<Op[]> => {
		const results = await Promise.all(ops.map(async (op) => ((await send(op)) ? null : op)));
		return results.filter((op): op is Op => op !== null);
	};

	const ops: Op[] = [
		...moves.map((move): Op => ({ kind: 'move', move })),
		...removals.map((id): Op => ({ kind: 'remove', id }))
	];
	let failedOps = await runBatch(ops);
	if (failedOps.length) {
		await new Promise((resolve) => setTimeout(resolve, change.retryDelayMs ?? 400));
		failedOps = await runBatch(failedOps);
	}
	return { ok: failedOps.length === 0, failed: failedOps.length };
}
