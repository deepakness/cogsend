<script lang="ts">
	import { onMount } from 'svelte';
	import { ChartColumn, X } from '@lucide/svelte';
	import AccountAvatar from '$lib/components/AccountAvatar.svelte';
	import { humanizeError } from '$lib/domain/human-error';
	import { sessionExpiredIfUnauthorized } from '$lib/components/session-expired';
	import { displayHandle, platformName } from '$lib/domain/platforms';
	import { formatRelativeTime } from '$lib/domain/relative-time';

	type Range = 7 | 30 | 90;

	interface Bucket {
		label: string;
		published: number;
		failed: number;
	}

	interface FailureReason {
		label: string;
		count: number;
	}

	interface AccountStat {
		connectionId: string;
		platform: string;
		handle: string | null;
		displayName: string | null;
		avatarUrl: string | null;
		connected: boolean;
		published: number;
		failed: number;
		rate: number | null;
		lastPublishedAt: number | null;
	}

	interface InsightPayload {
		range: { days: Range; spanDays: number; bucket: 'day' | 'week'; buckets: number };
		now: number;
		totals: {
			published: number;
			failed: number;
			rate: number | null;
			scheduled: number;
			nextScheduledAt: number | null;
		};
		previous: { published: number; failed: number; rate: number | null };
		series: { current: Bucket[]; previous: Bucket[] };
		failures: FailureReason[];
		accounts: AccountStat[];
	}

	/**
	 * Every range switch is a fresh request, guarded by a token: a slow
	 * response must never overwrite a newer one. On failure the last good
	 * payload stays on screen (its caption still describes it) with an error
	 * banner above, so a network blip never blanks the page.
	 */
	let range = $state<Range>(30);
	const RANGES: Range[] = [7, 30, 90];
	let style = $state<'cum' | 'bars'>('cum');
	let data = $state<InsightPayload | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let requestToken = 0;

	async function load(next: Range) {
		const token = ++requestToken;
		loading = true;
		error = null;
		try {
			const res = await fetch(`/api/insights?days=${next}`);
			// Same helper the other client-fetching pages use: a 401 means the
			// session is gone, not that the page needs a Retry button that can
			// never succeed.
			if (sessionExpiredIfUnauthorized(res)) return;
			const payload = await res.json().catch(() => ({}));
			if (token !== requestToken) return;
			if (!res.ok) {
				error = humanizeError(payload.error || 'Could not load insights');
				return;
			}
			// A 200 with an unexpected body (proxy page, truncated response)
			// must not reach the template, where every field is dereferenced.
			if (!isInsightPayload(payload)) {
				error = 'Unexpected response from the server — retry.';
				return;
			}
			data = payload;
		} catch {
			if (token === requestToken) {
				error = 'Could not reach the server — check your connection and retry.';
			}
		} finally {
			if (token === requestToken) loading = false;
		}
	}

	function pickRange(next: Range) {
		if (next === range) return;
		range = next;
		void load(next);
	}

	function isInsightPayload(value: unknown): value is InsightPayload {
		if (!value || typeof value !== 'object') return false;
		const candidate = value as Partial<InsightPayload>;
		return (
			!!candidate.range &&
			typeof candidate.range.days === 'number' &&
			!!candidate.totals &&
			typeof candidate.totals.published === 'number' &&
			!!candidate.series &&
			Array.isArray(candidate.series.current) &&
			Array.isArray(candidate.series.previous) &&
			Array.isArray(candidate.failures) &&
			Array.isArray(candidate.accounts)
		);
	}

	onMount(() => {
		void load(range);
	});

	const totalAttempts = $derived((data?.totals.published ?? 0) + (data?.totals.failed ?? 0));
	const hasActivity = $derived(
		totalAttempts > 0 || (data?.totals.scheduled ?? 0) > 0 || (data?.accounts.length ?? 0) > 0
	);

	function countDelta(current: number, previous: number): string {
		const d = current - previous;
		if (d === 0) return '±0 vs previous';
		return `${d > 0 ? '+' : '−'}${Math.abs(d)} vs previous`;
	}

	/** "90 days" only covers whole weeks, so it is described as 13 weeks. */
	function rangeWords(days: Range | undefined): string {
		if (!days) return 'selected period';
		return days === 90 ? '13 weeks' : `${days} days`;
	}

	/* ── Chart ─────────────────────────────────────────────────────────────
	   Buckets are already local days (or weeks) with display labels, so the
	   page only lays them out. Heights compare published only: a taller bar
	   always means more posts, and failures are a marker on top. */
	const buckets = $derived(data?.series.current ?? []);
	const previousBuckets = $derived(data?.series.previous ?? []);
	const chartMax = $derived(
		Math.max(1, ...buckets.map((b) => b.published), ...previousBuckets.map((b) => b.published))
	);

	function barHeight(value: number): string {
		return `${Math.max(2, (value / chartMax) * 100)}%`;
	}

	function showBarLabel(index: number): boolean {
		if (buckets.length <= 7) return true;
		if (buckets.length <= 30) return index % 5 === 0;
		return index % 3 === 0;
	}

	function barTitle(bucket: Bucket, previous: Bucket | undefined, index: number): string {
		const when = bucket.label || `#${index + 1}`;
		const prev = previous ? ` · previous ${previous.published} published` : '';
		return `${when} · this period ${bucket.published} published${prev}`;
	}

	const cumulative = $derived.by(() => {
		const acc = (list: Bucket[]) => {
			let n = 0;
			return list.map((b) => (n += b.published));
		};
		return { current: acc(buckets), previous: acc(previousBuckets) };
	});
	const cumulativeMax = $derived(Math.max(1, ...cumulative.current, ...cumulative.previous));

	const CHART_W = 600;
	const CHART_H = 150;
	const CHART_TOP = 8;
	const CHART_BOTTOM = 4;

	function pointX(index: number, count: number): number {
		return ((index + 0.5) / count) * CHART_W;
	}
	function pointY(value: number): number {
		return CHART_H - CHART_BOTTOM - (value / cumulativeMax) * (CHART_H - CHART_TOP - CHART_BOTTOM);
	}
	function linePath(values: number[]): string {
		return values
			.map(
				(value, i) =>
					`${i ? 'L' : 'M'}${pointX(i, values.length).toFixed(1)},${pointY(value).toFixed(1)}`
			)
			.join(' ');
	}
	const currentLine = $derived(linePath(cumulative.current));
	const previousLine = $derived(linePath(cumulative.previous));
	const areaPath = $derived.by(() => {
		const n = cumulative.current.length;
		if (!n) return '';
		return `${currentLine} L${pointX(n - 1, n).toFixed(1)},${CHART_H - CHART_BOTTOM} L${pointX(
			0,
			n
		).toFixed(1)},${CHART_H - CHART_BOTTOM} Z`;
	});

	/* ── Failures ──────────────────────────────────────────────────────── */
	const reasonSummary = $derived(
		(data?.failures ?? []).map((f) => `${f.label} ×${f.count}`).join(' · ')
	);
	const reasonsCovered = $derived((data?.failures ?? []).reduce((n, f) => n + f.count, 0));
	const reasonsHidden = $derived(Math.max(0, (data?.totals.failed ?? 0) - reasonsCovered));

	/* ── Accounts ──────────────────────────────────────────────────────── */
	const accounts = $derived(data?.accounts ?? []);
	const busiest = $derived(accounts[0] ?? null);

	/** The most recent publish anywhere, for the Last post card. */
	const latestPost = $derived.by(() => {
		let newest: AccountStat | null = null;
		for (const account of accounts) {
			if (!account.lastPublishedAt) continue;
			if (!newest?.lastPublishedAt || account.lastPublishedAt > newest.lastPublishedAt) {
				newest = account;
			}
		}
		if (!newest?.lastPublishedAt) return { text: '—', account: null as AccountStat | null };
		return {
			text: formatRelativeTime(new Date(newest.lastPublishedAt)),
			account: newest as AccountStat
		};
	});

	function lastPost(account: AccountStat): string {
		if (!account.lastPublishedAt) return '—';
		return formatRelativeTime(new Date(account.lastPublishedAt));
	}
</script>

<div
	class="mx-auto flex w-full max-w-2xl flex-1 flex-col"
	aria-busy={loading}
	data-testid="insights-page"
>
	<div class="mb-8 flex flex-wrap items-end justify-between gap-4">
		<div class="flex flex-col gap-2">
			<p class="text-[11px] font-bold tracking-widest text-stone-500 uppercase">Analytics</p>
			<h1 class="text-3xl font-extrabold tracking-tight text-stone-900">Insights</h1>
			<p class="text-[13px] font-medium text-stone-500">
				{#if data}
					Delivery stats for the last {rangeWords(data.range.days)}, compared with the previous
					{rangeWords(data.range.days)}.
				{:else}
					Delivery stats, compared with the period before.
				{/if}
			</p>
		</div>
		<div class="inline-flex rounded-2xl bg-stone-200/50 p-1" role="group" aria-label="Date range">
			{#each RANGES as value (value)}
				<button
					type="button"
					aria-pressed={range === value}
					onclick={() => pickRange(value)}
					class="rounded-xl px-3.5 py-1.5 text-[13px] font-bold transition-colors {range === value
						? 'bg-white text-stone-900 shadow-sm'
						: 'text-stone-500 hover:text-stone-900'}"
				>
					{value} days
				</button>
			{/each}
		</div>
	</div>

	{#if loading && !data}
		<span class="sr-only">Loading insights…</span>
	{/if}

	{#if error}
		<div
			class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700"
			role="alert"
		>
			<p class="font-medium">{error}</p>
			<span class="flex items-center gap-3">
				<button
					type="button"
					onclick={() => load(range)}
					class="rounded-full bg-red-600/10 px-3 py-1 text-[12px] font-bold text-red-700 transition-colors hover:bg-red-600/20"
				>
					Retry
				</button>
				<button
					type="button"
					onclick={() => (error = null)}
					aria-label="Dismiss error"
					class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-red-500 transition-colors hover:bg-red-100 hover:text-red-700"
				>
					<X class="h-3.5 w-3.5" />
				</button>
			</span>
		</div>
	{/if}

	{#if !data && loading}
		<!-- First paint only: skeleton in the real layout's shape. -->
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-hidden="true">
			{#each [0, 1, 2] as i (i)}
				<div
					class="animate-pulse rounded-[1.5rem] border border-stone-200/80 bg-white p-4 {i === 2
						? 'col-span-2 sm:col-span-1'
						: ''}"
				>
					<div class="h-6 w-12 rounded bg-stone-100"></div>
					<div class="mt-3 h-3 w-20 rounded bg-stone-100"></div>
				</div>
			{/each}
		</div>
		<div
			class="mt-5 animate-pulse rounded-[2rem] border border-stone-200/80 bg-white p-5"
			aria-hidden="true"
		>
			<div class="h-4 w-32 rounded bg-stone-100"></div>
			<div class="mt-4 h-36 rounded-2xl bg-stone-50"></div>
		</div>
	{:else if data && !hasActivity}
		<div
			class="flex flex-col items-center justify-center rounded-[2rem] border border-dashed border-stone-200/80 bg-white px-4 py-20 text-center"
		>
			<div
				class="mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-stone-100 bg-stone-50 text-stone-500 shadow-sm"
			>
				<ChartColumn class="h-6 w-6" />
			</div>
			<h3 class="mb-2 text-lg font-extrabold tracking-tight text-stone-900">No data yet</h3>
			<p class="max-w-sm text-[13px] leading-relaxed font-medium text-stone-500">
				Publish a few posts and their delivery stats will show up here.
			</p>
		</div>
	{:else if data}
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-3" data-testid="insights-stats">
			<div class="rounded-[1.5rem] border border-stone-200/80 bg-white p-4 shadow-sm">
				<p class="text-2xl font-extrabold tracking-tight text-stone-900">
					{data.totals.published}
				</p>
				<p class="mt-1 text-[11px] font-bold tracking-widest text-stone-500 uppercase">Published</p>
				<p class="mt-1 text-[11px] font-bold text-emerald-700">
					{countDelta(data.totals.published, data.previous.published)}
				</p>
			</div>
			<div class="rounded-[1.5rem] border border-stone-200/80 bg-white p-4 shadow-sm">
				<p class="text-2xl font-extrabold tracking-tight text-stone-900">
					{data.totals.scheduled}
				</p>
				<p class="mt-1 text-[11px] font-bold tracking-widest text-stone-500 uppercase">Scheduled</p>
				<p class="mt-1 text-[11px] font-bold text-stone-500">
					{data.totals.nextScheduledAt
						? `next ${formatRelativeTime(new Date(data.totals.nextScheduledAt))}`
						: data.totals.scheduled > 0
							? 'no time set'
							: 'nothing queued'}
				</p>
			</div>
			<div
				class="col-span-2 rounded-[1.5rem] border border-stone-200/80 bg-white p-4 shadow-sm sm:col-span-1"
			>
				<p class="text-xl font-extrabold tracking-tight text-stone-900 sm:text-2xl">
					{latestPost.text}
				</p>
				<p class="mt-1 text-[11px] font-bold tracking-widest text-stone-500 uppercase">Last post</p>
				<p class="mt-1 truncate text-[11px] font-bold text-stone-500">
					{latestPost.account ? platformName(latestPost.account.platform) : '—'}
				</p>
			</div>
		</div>

		<div class="mt-7 mb-2.5 flex flex-wrap items-center justify-between gap-3">
			<h2 class="text-[15px] font-extrabold tracking-tight text-stone-900">
				{style === 'cum'
					? 'Published, cumulative'
					: data.range.bucket === 'week'
						? 'Posts per week'
						: 'Posts per day'}
			</h2>
			<div class="flex flex-wrap items-center gap-2">
				<p class="text-[12px] font-semibold text-stone-500">
					Last {data.range.days === 90 ? '13 weeks' : `${data.range.days} days`}
				</p>
				<div
					class="ml-2 inline-flex rounded-xl bg-stone-200/50 p-1"
					role="group"
					aria-label="Chart style"
				>
					<button
						type="button"
						aria-pressed={style === 'cum'}
						onclick={() => (style = 'cum')}
						class="rounded-lg px-2.5 py-1 text-[11px] font-bold transition-colors {style === 'cum'
							? 'bg-white text-stone-900 shadow-sm'
							: 'text-stone-500 hover:text-stone-900'}"
					>
						Cumulative
					</button>
					<button
						type="button"
						aria-pressed={style === 'bars'}
						onclick={() => (style = 'bars')}
						class="rounded-lg px-2.5 py-1 text-[11px] font-bold transition-colors {style === 'bars'
							? 'bg-white text-stone-900 shadow-sm'
							: 'text-stone-500 hover:text-stone-900'}"
					>
						Bars
					</button>
				</div>
			</div>
		</div>

		<div
			class="overflow-hidden rounded-[2rem] border border-stone-200/80 bg-white shadow-[0_8px_30px_-12px_rgb(28_25_23/0.06)]"
			data-testid="insights-chart"
		>
			<div class="p-4 pb-3.5 sm:p-5">
				<div class="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
					{#if style === 'bars'}
						<span class="flex items-center gap-1.5 text-[11px] font-bold text-stone-500">
							<span class="inline-block h-2.5 w-2.5 rounded-[3px] bg-stone-900"></span>This period
						</span>
						<span class="flex items-center gap-1.5 text-[11px] font-bold text-stone-500">
							<span class="inline-block h-2.5 w-2.5 rounded-[3px] bg-stone-500"></span>Previous
							period
						</span>
					{:else}
						<span class="flex items-center gap-1.5 text-[11px] font-bold text-stone-500">
							<span class="inline-block h-[3px] w-4 rounded bg-stone-900"></span>This period
						</span>
						<span class="flex items-center gap-1.5 text-[11px] font-bold text-stone-500">
							<span class="inline-block h-[3px] w-4 rounded bg-stone-500"></span>Previous period
						</span>
					{/if}
				</div>

				{#if style === 'bars'}
					<div class="flex h-[150px] items-end gap-1">
						{#each buckets as bucket, i (i)}
							<div
								class="h-full min-w-0 flex-1"
								role="img"
								aria-label={barTitle(bucket, previousBuckets[i], i)}
								title={barTitle(bucket, previousBuckets[i], i)}
							>
								<div class="flex h-full items-end gap-0.5">
									<div
										class="min-w-0 flex-1 rounded-t-[3px] bg-stone-500"
										style="height:{barHeight(previousBuckets[i]?.published ?? 0)}"
									></div>
									<div
										class="relative min-w-0 flex-1 overflow-hidden rounded-t-[3px] bg-stone-900"
										style="height:{barHeight(bucket.published)}"
									></div>
								</div>
							</div>
						{/each}
					</div>
				{:else}
					<div class="h-[150px]">
						<svg
							viewBox="0 0 {CHART_W} {CHART_H}"
							preserveAspectRatio="none"
							class="block h-full w-full"
							role="img"
							aria-label="Cumulative published posts, this period compared with the previous period"
						>
							<defs>
								<linearGradient id="insights-area" x1="0" y1="0" x2="0" y2="1">
									<stop offset="0%" stop-color="#1c1917" stop-opacity="0.13"></stop>
									<stop offset="100%" stop-color="#1c1917" stop-opacity="0"></stop>
								</linearGradient>
							</defs>
							<line
								x1="0"
								y1={CHART_H - CHART_BOTTOM}
								x2={CHART_W}
								y2={CHART_H - CHART_BOTTOM}
								stroke="#e7e5e4"
								stroke-width="1"
								vector-effect="non-scaling-stroke"
							></line>
							<path d={areaPath} fill="url(#insights-area)"></path>
							<path
								d={previousLine}
								fill="none"
								stroke="#78716c"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
								vector-effect="non-scaling-stroke"
							></path>
							<path
								d={currentLine}
								fill="none"
								stroke="#1c1917"
								stroke-width="2.5"
								stroke-linecap="round"
								stroke-linejoin="round"
								vector-effect="non-scaling-stroke"
							></path>
							{#each cumulative.current as value, i (i)}
								<circle
									cx={pointX(i, cumulative.current.length)}
									cy={pointY(value)}
									r="9"
									fill="transparent"
								>
									<title>
										{buckets[i]?.label} · this period {value} published · previous
										{cumulative.previous[i] ?? 0}
									</title>
								</circle>
							{/each}
						</svg>
					</div>
				{/if}

				<div class="mt-2.5 flex gap-1">
					{#each buckets as bucket, i (i)}
						<span
							class="min-w-0 flex-1 text-center text-[10px] font-bold tracking-wider text-stone-500 uppercase"
						>
							{showBarLabel(i) ? bucket.label : ''}
						</span>
					{/each}
				</div>
			</div>
		</div>

		<p
			class="mt-4 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12.5px] font-medium text-stone-600"
			data-testid="insights-failures"
		>
			{#if data.totals.failed === 0}
				<span class="text-stone-500">No failures in this period.</span>
			{:else}
				<strong class="text-[13px] font-extrabold text-stone-900"
					>{data.totals.failed} failed</strong
				>
				<span class="text-stone-500"
					>— {reasonSummary}{#if reasonsHidden > 0}, {reasonsHidden} more{/if}</span
				>
				<a
					href="/posts?tab=failed"
					class="text-[12px] font-extrabold whitespace-nowrap text-stone-900 hover:underline"
				>
					Review in Posts →
				</a>
			{/if}
		</p>

		<div class="mt-7 mb-2.5 flex items-center justify-between gap-3">
			<h2 class="text-[15px] font-extrabold tracking-tight text-stone-900">Accounts</h2>
			<p class="text-[12px] font-semibold text-stone-500">
				{data.range.days === 90 ? '13 weeks' : `${data.range.days} days`} · {accounts.length}
				{accounts.length === 1 ? 'account' : 'accounts'}
			</p>
		</div>
		<div
			class="overflow-hidden rounded-[2rem] border border-stone-200/80 bg-white shadow-[0_8px_30px_-12px_rgb(28_25_23/0.06)]"
			data-testid="insights-accounts"
		>
			{#each accounts as account, index (account.connectionId)}
				<div
					class="flex flex-wrap items-center justify-between gap-3 px-5 py-4 sm:flex-nowrap sm:gap-4 {index !==
					accounts.length - 1
						? 'border-b border-stone-100'
						: ''}"
					data-testid="insight-account"
				>
					<div class="flex min-w-0 items-center gap-3">
						<AccountAvatar
							platform={account.platform}
							handle={account.handle}
							displayName={account.displayName}
							avatarUrl={account.avatarUrl}
							size={40}
						/>
						<div class="min-w-0">
							<h3
								class="truncate text-[14.5px] leading-tight font-extrabold tracking-tight text-stone-900"
							>
								{platformName(account.platform)}
								{#if !account.connected}
									<span
										class="ml-2 rounded bg-stone-100 px-1.5 py-0.5 text-[10px] font-bold tracking-widest text-stone-500 uppercase"
										>Archived</span
									>
								{/if}
							</h3>
							<p class="mt-0.5 truncate text-[12.5px] font-medium text-stone-500">
								{account.displayName || displayHandle(account.handle)}
							</p>
						</div>
					</div>
					<div
						class="flex w-full items-center justify-between gap-3 sm:w-auto sm:justify-end sm:gap-6"
					>
						<div class="text-right">
							<p class="text-[15px] font-extrabold text-stone-900">
								{account.published}
							</p>
							<p class="mt-0.5 text-[10px] font-bold tracking-widest text-stone-500 uppercase">
								Published
							</p>
						</div>
						<div class="min-w-14 text-right">
							<p class="text-[15px] font-extrabold text-stone-900">
								{lastPost(account)}
							</p>
							<p class="mt-0.5 text-[10px] font-bold tracking-widest text-stone-500 uppercase">
								Last post
							</p>
						</div>
					</div>
				</div>
			{/each}
			{#if accounts.length > 0}
				<p
					class="border-t border-stone-100 px-5 py-3 text-[12px] font-semibold text-stone-500"
					data-testid="insights-account-note"
				>
					{#if data.totals.published >= 10 && busiest}
						Most posts: {platformName(busiest.platform)} — {busiest.published} of {data.totals
							.published}.
					{/if}
				</p>
			{/if}
		</div>

		<p class="mt-5 text-[12px] leading-relaxed font-medium text-stone-500">
			From your publish history. Times are local.
		</p>
	{/if}
</div>
