<script lang="ts">
	const origin = typeof window !== 'undefined' ? window.location.origin : '';

	const snippets = [
		{
			title: 'List drafts',
			code: `curl ${origin}/api/drafts \\
  -H "Authorization: Bearer $COGSEND_API_KEY"`
		},
		{
			title: 'Create a draft and publish it now',
			code: `DRAFT=$(curl -s ${origin}/api/drafts \\
  -H "Authorization: Bearer $COGSEND_API_KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{"baseBody":"Hello from the API"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["draft"]["id"])')
CONNS=$(curl -s ${origin}/api/connections \\
  -H "Authorization: Bearer $COGSEND_API_KEY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["connections"][0]["id"])')
curl ${origin}/api/drafts/$DRAFT/publish \\
  -H "Authorization: Bearer $COGSEND_API_KEY" \\
  -H 'Content-Type: application/json' \\
  -d "{\\"connectionIds\\":[\\"$CONNS\\"]}"`
		},
		{
			title: 'Schedule for later',
			code: `curl ${origin}/api/drafts/$DRAFT/schedule \\
  -H "Authorization: Bearer $COGSEND_API_KEY" \\
  -H 'Content-Type: application/json' \\
  -d '{"connectionIds":["<connection-id>"],"runAt":"2030-01-01T09:00:00Z"}'`
		},
		{
			title: 'Check the queue',
			code: `curl ${origin}/api/queue \\
  -H "Authorization: Bearer $COGSEND_API_KEY"`
		}
	];

	async function copy(text: string, btn: HTMLButtonElement) {
		try {
			await navigator.clipboard.writeText(text);
			const prev = btn.textContent;
			btn.textContent = 'Copied';
			btn.setAttribute('aria-live', 'polite');
			setTimeout(() => (btn.textContent = prev), 1500);
		} catch {
			// clipboard unavailable; the snippet is selectable
		}
	}
</script>

<div class="mx-auto flex w-full max-w-2xl flex-1 flex-col py-8 pb-20">
	<div class="mb-12">
		<h1 class="text-3xl font-bold tracking-tight text-stone-900">API Documentation</h1>
		<p class="mt-4 text-[15px] leading-relaxed text-stone-600">
			Manage drafts, upload media, publish posts, schedule deliveries, and read queue status using
			your personal API key. You can generate or revoke your key in
			<a
				href="/settings"
				class="font-medium text-stone-900 underline underline-offset-4 hover:text-stone-600"
				>Settings → API access</a
			>.
		</p>
	</div>

	<div class="flex flex-col gap-12">
		<section>
			<h2 class="mb-4 text-xl font-bold tracking-tight text-stone-900">Authentication</h2>
			<p class="mb-4 text-[15px] leading-relaxed text-stone-600">
				Provide your API key in the headers of every request. You can use the standard
				<code
					class="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[13px] font-medium text-stone-900"
					>Authorization: Bearer &lt;key&gt;</code
				>
				header or the custom
				<code
					class="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[13px] font-medium text-stone-900"
					>X-API-Key: &lt;key&gt;</code
				> header.
			</p>

			<div class="group relative mb-6">
				<pre
					class="overflow-x-auto rounded-xl border border-stone-200/60 bg-stone-50 p-4 font-mono text-[13px] text-stone-900">Authorization: Bearer cog_…</pre>
				<button
					type="button"
					aria-label="Copy authorization header"
					aria-live="polite"
					onclick={(e) => void copy('Authorization: Bearer cog_…', e.currentTarget)}
					class="absolute top-3 right-3 rounded-md border border-stone-200/80 bg-white px-2 py-1 text-xs font-medium text-stone-600 opacity-100 transition-opacity group-hover:opacity-100 hover:bg-stone-100 hover:text-stone-900 focus:opacity-100 focus-visible:opacity-100 sm:opacity-0"
				>
					Copy
				</button>
			</div>

			<ul class="list-disc space-y-2 pl-5 text-[15px] text-stone-600 marker:text-stone-500">
				<li>
					<strong class="font-medium text-stone-900">Capabilities:</strong> The API key can be used to
					manage drafts, upload media, publish posts, schedule deliveries, and read queue status.
				</li>
				<li>
					<strong class="font-medium text-stone-900">Restrictions:</strong> The key cannot be used to
					connect or disconnect social accounts, rotate credentials, or revoke itself. These actions require
					a secure browser session.
				</li>
				<li>
					<strong class="font-medium text-stone-900">Scopes:</strong> Keys carry
					<code class="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[13px]">read</code>
					and/or
					<code class="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[13px]">write</code>
					scopes (<code class="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[13px]">write</code
					>
					implies
					<code class="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[13px]">read</code>). A
					read-only key gets 403 on publishes, schedules, and edits.
				</li>
				<li>
					<strong class="font-medium text-stone-900">Errors:</strong> Failed requests return a JSON
					object with an
					<code class="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[13px]">error</code> property.
				</li>
				<li>
					<strong class="font-medium text-stone-900">Publishing:</strong> Direct publishes return
					per-connection results inline. Reusing a connection within the same draft returns
					<code class="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[13px]">skipped</code>.
					Scheduling a duplicate target returns a 409 Conflict.
				</li>
			</ul>
			<p class="mt-6 text-[14px] font-medium text-stone-500">
				If a key ever touches a log or screenshot, rotate it in Settings — the old one stops working
				immediately.
			</p>
		</section>

		<section>
			<h2 class="mb-6 text-xl font-bold tracking-tight text-stone-900">Endpoints</h2>
			<dl class="space-y-3 font-mono text-[13px] text-stone-600">
				<div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="shrink-0 font-semibold text-stone-900 sm:w-[280px]">GET /api/drafts</dt>
					<dd>list drafts with variants, media, targets</dd>
				</div>
				<div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="shrink-0 font-semibold text-stone-900 sm:w-[280px]">POST /api/drafts</dt>
					<dd>{'{"title?", "baseBody?", "selectedConnectionIds?"} → 201 {draft}'}</dd>
				</div>
				<div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="shrink-0 font-semibold text-stone-900 sm:w-[280px]">PATCH /api/drafts/:id</dt>
					<dd>edit title/body/selectedConnectionIds (409 while publishing)</dd>
				</div>
				<div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="shrink-0 font-semibold text-stone-900 sm:w-[280px]">
						PUT /api/drafts/:id/variants
					</dt>
					<dd>{'{"platform", "body?", "options?"} → the per-platform copy'}</dd>
				</div>
				<div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="shrink-0 font-semibold text-stone-900 sm:w-[280px]">
						POST /api/drafts/:id/media
					</dt>
					<dd>{'multipart: file(s), segmentIndex, altText? → 201 {media}'}</dd>
				</div>
				<div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="shrink-0 font-semibold text-stone-900 sm:w-[280px]">
						POST /api/drafts/:id/duplicate
					</dt>
					<dd>clone a draft (media included) into a new draft</dd>
				</div>
				<div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="shrink-0 font-semibold text-stone-900 sm:w-[280px]">
						POST /api/drafts/:id/publish
					</dt>
					<dd>{'{"connectionIds":[]} → {results[], draft}'}</dd>
				</div>
				<div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="shrink-0 font-semibold text-stone-900 sm:w-[280px]">
						POST /api/drafts/:id/schedule
					</dt>
					<dd>{'{"connectionIds":[],"runAt":ISO} → {targets}'}</dd>
				</div>
				<div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="shrink-0 font-semibold text-stone-900 sm:w-[280px]">GET /api/queue</dt>
					<dd>upcoming + recent delivery targets</dd>
				</div>
				<div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="shrink-0 font-semibold text-stone-900 sm:w-[280px]">
						POST /api/targets/:id/cancel|retry
					</dt>
					<dd>cancel or retry one delivery</dd>
				</div>
				<div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="shrink-0 font-semibold text-stone-900 sm:w-[280px]">POST /api/targets/bulk</dt>
					<dd>cancel, retry, or reschedule several deliveries at once</dd>
				</div>
				<div class="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
					<dt class="shrink-0 font-semibold text-stone-900 sm:w-[280px]">GET /api/connections</dt>
					<dd>account ids, platforms, statuses, and which platforms this deployment can connect</dd>
				</div>
			</dl>
		</section>

		<section>
			<h2 class="mb-6 text-xl font-bold tracking-tight text-stone-900">Examples</h2>
			<div class="flex flex-col gap-8">
				{#each snippets as s (s.title)}
					<div>
						<h3 class="mb-3 text-[15px] font-semibold text-stone-900">{s.title}</h3>
						<div class="group relative">
							<pre
								class="overflow-x-auto rounded-xl border border-stone-200/60 bg-stone-50 p-4 font-mono text-[13px] text-stone-900">{s.code}</pre>
							<button
								type="button"
								aria-label={`Copy ${s.title} snippet`}
								aria-live="polite"
								onclick={(e) => void copy(s.code, e.currentTarget)}
								class="absolute top-3 right-3 rounded-md border border-stone-200/80 bg-white px-2 py-1 text-xs font-medium text-stone-600 opacity-100 transition-opacity group-hover:opacity-100 hover:bg-stone-100 hover:text-stone-900 focus:opacity-100 focus-visible:opacity-100 sm:opacity-0"
							>
								Copy
							</button>
						</div>
					</div>
				{/each}
			</div>
		</section>
	</div>
</div>
