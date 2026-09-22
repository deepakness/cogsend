<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { Plus, X } from '@lucide/svelte';
	import { fade, fly } from 'svelte/transition';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import AccountAvatar from '$lib/components/AccountAvatar.svelte';
	import SocialIcon from '$lib/components/SocialIcon.svelte';
	import { accountLabel, displayHost, platformName, platformRank } from '$lib/domain/platforms';
	import { humanizeError } from '$lib/domain/human-error';
	import {
		PLATFORM_SETUP,
		SETUP_GUIDE_URL,
		callbackUri,
		emptyStateSentence,
		isOAuthPlatform,
		needsSetup,
		secretsPutCommand,
		type OAuthPlatformId
	} from '$lib/domain/platform-setup';
	import { sessionExpiredIfUnauthorized } from '$lib/components/session-expired';
	import { dialogFocus } from '$lib/components/dialog-focus';

	type Connection = {
		id: string;
		platform: string;
		handle: string | null;
		displayName: string | null;
		avatarUrl?: string | null;
		instanceUrl: string | null;
		status: string;
	};

	let connections = $state<Connection[]>([]);
	let configured = $state<{ linkedin: boolean; threads: boolean; x: boolean }>({
		linkedin: true,
		threads: true,
		x: true
	});
	let handle = $state('');
	let appPassword = $state('');
	let instanceUrl = $state('');
	let msg = $state<string | null>(null);
	let err = $state<string | null>(null);
	let loading = $state(false);
	// First-load flag: while true show skeleton rows instead of the
	// "No accounts yet" empty state (avoids flash on every visit).
	let initialLoading = $state(true);
	// Distinguishes "the list is empty" from "the list never arrived": the
	// former gets the connect prompt, the latter must not.
	let loadFailed = $state(false);
	let verifying = $state<string | null>(null);
	let pendingDisconnect = $state<{ id: string; label: string } | null>(null);
	let disconnectBusy = $state(false);
	let showConnectDialog = $state(false);
	let modalForm = $state<'none' | 'bluesky' | 'mastodon'>('none');
	// Set when the picked platform has no credentials on this deployment: the
	// dialog shows its setup steps instead of a request that can only fail.
	let setupPanel = $state<OAuthPlatformId | null>(null);
	// The deployment's own APP_URL, for the redirect URI the provider needs.
	let appUrl = $state('');
	let connectCloseBtn: HTMLButtonElement | null = $state(null);

	const availablePlatforms = [
		{
			id: 'x',
			name: 'X',
			description: 'Post with the X API (uses pay-per-use credits)',
			form: null
		},
		{
			id: 'threads',
			name: 'Threads',
			description: 'Connect your Threads account',
			form: null
		},
		{
			id: 'linkedin',
			name: 'LinkedIn',
			description: 'Connect your personal or company page',
			form: null
		},
		{
			id: 'mastodon',
			name: 'Mastodon',
			description: 'Connect via your instance',
			form: 'mastodon' as const
		},
		{
			id: 'bluesky',
			name: 'Bluesky',
			description: 'Connect with handle + app password',
			form: 'bluesky' as const
		}
	];

	async function load() {
		initialLoading = true;
		loadFailed = false;
		try {
			const res = await fetch('/api/connections');
			if (sessionExpiredIfUnauthorized(res)) {
				loadFailed = true;
				return;
			}
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) {
				loadFailed = true;
				err = humanizeError(payload.error || 'Could not load accounts');
				return;
			}
			connections = [...(payload.connections || [])].sort(
				(a: Connection, b: Connection) => platformRank(a.platform) - platformRank(b.platform)
			);
			if (typeof payload.appUrl === 'string') appUrl = payload.appUrl;
			if (payload.configured && typeof payload.configured === 'object') {
				configured = {
					linkedin: payload.configured.linkedin !== false,
					threads: payload.configured.threads !== false,
					x: payload.configured.x !== false
				};
			}
		} catch (e) {
			loadFailed = true;
			err = humanizeError(e instanceof Error ? e.message : 'Could not load accounts');
		} finally {
			initialLoading = false;
		}
	}

	async function connectBluesky(e: Event) {
		e.preventDefault();
		loading = true;
		err = null;
		msg = null;
		try {
			const res = await fetch('/api/connections/bluesky', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ handle, appPassword })
			});
			const payload = await res.json();
			if (!res.ok) throw new Error(payload.error || 'Failed');
			msg = `Connected Bluesky as ${payload.connection.handle}`;
			appPassword = '';
			closeConnectDialog();
			await load();
		} catch (e) {
			err = humanizeError(e instanceof Error ? e.message : 'Failed');
		} finally {
			loading = false;
		}
	}

	async function connectOAuth(
		platform: 'mastodon' | 'linkedin' | 'threads' | 'x',
		body: Record<string, string>
	) {
		loading = true;
		err = null;
		try {
			const res = await fetch(`/api/connections/${platform}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) {
				// The secrets can be missing even when `configured` said otherwise
				// (a deployment that lost them, or this page still loading). The
				// route answers with a code, so this opens the setup steps instead
				// of a red banner naming environment variables.
				if (payload.code === 'platform_not_configured' && isOAuthPlatform(platform)) {
					showSetupPanel(platform);
					loading = false;
					return;
				}
				throw new Error(payload.error || 'Failed');
			}
			window.location.href = payload.authorizeUrl;
		} catch (e) {
			err = humanizeError(e instanceof Error ? e.message : 'Failed');
			loading = false;
		}
	}

	async function connectMastodon(e: Event) {
		e.preventDefault();
		loading = true;
		err = null;
		await connectOAuth('mastodon', { instanceUrl });
	}

	function pickPlatform(id: string) {
		const found = availablePlatforms.find((p) => p.id === id);
		if (!found) return;
		if (found.form) {
			modalForm = found.form;
			return;
		}
		// A platform this deployment has no credentials for cannot be connected,
		// so say what it needs instead of requesting an authorize URL.
		if (needsSetup(id, configured)) {
			showSetupPanel(id as OAuthPlatformId);
			return;
		}
		if (isOAuthPlatform(id)) void connectOAuth(id, {});
	}

	function openConnectDialog() {
		// A new attempt supersedes whatever the last one reported.
		err = null;
		modalForm = 'none';
		setupPanel = null;
		showConnectDialog = true;
	}

	function showSetupPanel(platform: OAuthPlatformId) {
		err = null;
		modalForm = 'none';
		setupPanel = platform;
		showConnectDialog = true;
	}

	function closeConnectDialog() {
		showConnectDialog = false;
		modalForm = 'none';
		setupPanel = null;
	}

	function backToPlatforms() {
		modalForm = 'none';
		setupPanel = null;
	}

	async function confirmDisconnect() {
		if (!pendingDisconnect) return;
		disconnectBusy = true;
		err = null;
		try {
			const res = await fetch(`/api/connections/${pendingDisconnect.id}`, {
				method: 'DELETE'
			});
			const payload = await res.json().catch(() => ({}));
			if (!res.ok) {
				throw new Error(payload.error || 'Could not disconnect');
			}
			const removed = Number(payload.removed ?? 0);
			const archived = Number(payload.archived ?? 0);
			const details = [
				removed ? `${removed} scheduled post${removed === 1 ? '' : 's'} removed` : '',
				archived ? `${archived} published post${archived === 1 ? '' : 's'} kept` : ''
			].filter(Boolean);
			msg = `Disconnected ${pendingDisconnect.label}${details.length ? ` — ${details.join(' · ')}` : ''}`;
			await load();
		} catch (e) {
			err = humanizeError(e instanceof Error ? e.message : 'Could not disconnect');
		} finally {
			disconnectBusy = false;
			pendingDisconnect = null;
		}
	}

	// Re-enter the OAuth flow for a dead connection. Server callbacks upsert
	// by (user, platform, handle) and flip status back to active, so targets
	// stay attached to the same connection row. Bluesky is credential-based:
	// open its dialog prefilled instead.
	function reconnectAccount(account: Connection) {
		err = null;
		if (account.platform === 'bluesky') {
			handle = account.handle ?? '';
			appPassword = '';
			openConnectDialog();
			modalForm = 'bluesky';
			return;
		}
		if (account.platform === 'mastodon') {
			if (!account.instanceUrl) {
				err = 'Missing instance URL — disconnect and connect again';
				return;
			}
			void connectOAuth('mastodon', { instanceUrl: account.instanceUrl });
			return;
		}
		if (
			account.platform === 'linkedin' ||
			account.platform === 'threads' ||
			account.platform === 'x'
		) {
			if (needsSetup(account.platform, configured)) {
				showSetupPanel(account.platform);
				return;
			}
			void connectOAuth(account.platform, {});
			return;
		}
		void verify(account.id);
	}

	async function verify(id: string) {
		verifying = id;
		err = null;
		try {
			const res = await fetch(`/api/connections/${id}/verify`, { method: 'POST' });
			const payload = await res.json();
			if (!res.ok) throw new Error(payload.error || 'Could not verify');
			msg = 'Account is active again';
			await load();
		} catch (e) {
			err = humanizeError(e instanceof Error ? e.message : 'Could not verify');
		} finally {
			verifying = null;
		}
	}

	onMount(() => {
		void load();
		const params = page.url.searchParams;
		if (params.get('connected')) msg = `Connected ${params.get('connected')}`;
		if (params.get('error')) err = humanizeError(params.get('error'));
	});
</script>

<div class="mx-auto flex w-full max-w-2xl flex-1 flex-col">
	<div class="mb-8 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
		<div>
			<p class="text-[11px] font-bold tracking-widest text-stone-500 uppercase">Integrations</p>
			<h1 class="mt-2 text-3xl font-extrabold tracking-tight text-stone-900">Connected Accounts</h1>
		</div>
		<button
			type="button"
			onclick={openConnectDialog}
			class="inline-flex items-center gap-2 rounded-full bg-stone-900 px-5 py-2.5 text-[13px] font-bold text-white shadow-md transition-all hover:bg-stone-800"
		>
			<Plus class="h-4 w-4" />
			<span>Connect new</span>
		</button>
	</div>

	{#if msg || err}
		<div
			class="mb-4 rounded-xl px-3 py-2 text-sm {err
				? 'bg-red-50 text-red-700'
				: 'bg-emerald-50 text-emerald-800'}"
			role="alert"
		>
			{err || msg}
		</div>
	{/if}

	<div
		class="overflow-hidden rounded-[2rem] border border-stone-200/80 bg-white shadow-[0_8px_30px_-12px_rgb(28_25_23/0.06)]"
	>
		{#if initialLoading && connections.length === 0}
			<div class="animate-pulse" aria-hidden="true">
				{#each [0, 1, 2] as i (i)}
					<div class="flex items-center gap-4 p-4 sm:px-6 sm:py-4">
						<div class="h-11 w-11 shrink-0 rounded-full bg-stone-100"></div>
						<div class="flex-1">
							<div class="h-4 w-32 rounded bg-stone-100"></div>
							<div class="mt-2 h-3 w-48 rounded bg-stone-100"></div>
						</div>
						<div class="h-5 w-16 rounded bg-stone-100"></div>
					</div>
				{/each}
			</div>
		{:else if loadFailed && connections.length === 0}
			<p class="p-6 text-sm font-medium text-stone-500">
				Accounts could not be loaded. The message above says why — retry in a moment.
			</p>
		{:else if connections.length === 0}
			<p class="p-6 text-sm font-medium text-stone-500">{emptyStateSentence(configured)}</p>
		{:else}
			{#each connections as account, index (account.id)}
				{@const needsReconnect = account.status !== 'active'}
				<div
					class="group flex flex-col justify-between gap-4 p-4 transition-colors hover:bg-stone-50/50 sm:flex-row sm:items-center sm:px-6 sm:py-4 {index !==
					connections.length - 1
						? 'border-b border-stone-100'
						: ''}"
				>
					<div class="flex items-center gap-4">
						<AccountAvatar
							platform={account.platform}
							handle={account.handle}
							displayName={account.displayName}
							avatarUrl={account.avatarUrl}
							size={44}
							title={accountLabel(account.displayName, account.handle, account.instanceUrl) ||
								undefined}
						/>
						<div>
							<h3 class="text-[15px] leading-tight font-extrabold tracking-tight text-stone-900">
								{platformName(account.platform)}
							</h3>
							<p
								class="mt-0.5 text-[13px] font-medium text-stone-500"
								title={accountLabel(account.displayName, account.handle, account.instanceUrl) ||
									undefined}
							>
								{#if account.platform === 'linkedin' && account.displayName}
									{account.displayName}
								{:else}
									{accountLabel(account.displayName, account.handle)}
								{/if}
								{account.instanceUrl ? ` · ${displayHost(account.instanceUrl)}` : ''}
							</p>
						</div>
					</div>
					<div class="mt-2 flex items-center justify-between gap-3 sm:mt-0 sm:justify-end">
						{#if needsReconnect}
							<span
								class="rounded bg-amber-50 px-2 py-0.5 text-[10px] font-bold tracking-widest text-amber-700 uppercase"
							>
								{account.status}
							</span>
							<button
								type="button"
								onclick={() => reconnectAccount(account)}
								disabled={verifying === account.id || loading}
								class="text-xs font-bold text-stone-900 underline">Reconnect</button
							>
							<button
								type="button"
								onclick={() => verify(account.id)}
								disabled={verifying === account.id}
								class="text-xs font-bold text-stone-500 underline"
								>{verifying === account.id ? 'Checking…' : 'Check'}</button
							>
						{:else}
							<span
								class="rounded bg-emerald-50 px-2 py-0.5 text-[10px] font-bold tracking-widest text-emerald-700 uppercase shadow-sm"
							>
								Connected
							</span>
						{/if}
						<button
							type="button"
							onclick={() =>
								(pendingDisconnect = {
									id: account.id,
									label:
										accountLabel(account.displayName, account.handle, account.instanceUrl) ||
										account.platform
								})}
							class="flex h-8 w-8 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-red-50 hover:text-red-600"
							aria-label={`Disconnect ${accountLabel(account.displayName, account.handle, account.instanceUrl) || platformName(account.platform)}`}
							title={`Disconnect ${accountLabel(account.displayName, account.handle, account.instanceUrl) || platformName(account.platform)}`}
						>
							<X class="h-4 w-4" />
						</button>
					</div>
				</div>
			{/each}
		{/if}
	</div>
</div>

{#if showConnectDialog}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
		transition:fade={{ duration: 150 }}
		role="presentation"
	>
		<div
			class="absolute inset-0 bg-stone-900/20 backdrop-blur-sm"
			onclick={closeConnectDialog}
			aria-hidden="true"
		></div>

		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby="connect-dialog-title"
			class="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-[2rem] border border-stone-200/80 bg-white p-6 shadow-[0_16px_40px_-12px_rgb(28_25_23/0.15)] sm:p-8"
			transition:fly={{ y: 20, duration: 250, opacity: 0 }}
			use:dialogFocus={{
				onEscape: () => {
					if (!loading) closeConnectDialog();
				}
			}}
		>
			<div class="mb-8 flex items-start justify-between">
				<div>
					<h2
						id="connect-dialog-title"
						class="text-2xl font-extrabold tracking-tight text-stone-900"
					>
						Add Integration
					</h2>
					<p class="mt-1.5 text-[13px] font-medium text-stone-500">
						Select a platform to connect to your workspace.
					</p>
				</div>
				<button
					type="button"
					bind:this={connectCloseBtn}
					onclick={closeConnectDialog}
					class="ml-4 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-stone-50 text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-900"
					aria-label="Close add integration dialog"
				>
					<X class="h-5 w-5" />
				</button>
			</div>

			{#if setupPanel}
				{@const setup = PLATFORM_SETUP[setupPanel]}
				<div class="space-y-4" data-testid="platform-setup-panel">
					<button
						type="button"
						onclick={backToPlatforms}
						class="text-[13px] font-bold text-stone-500 hover:text-stone-900"
						>← All platforms</button
					>
					<h3 class="text-[17px] font-extrabold tracking-tight text-stone-900">
						{platformName(setupPanel)} isn't enabled yet
					</h3>
					<p class="text-xs font-medium text-stone-500">
						This deployment has no {platformName(setupPanel)} app credentials yet. They are Worker secrets,
						so whoever deployed it adds them once.
					</p>
					<div class="space-y-3 rounded-2xl bg-stone-50 p-4">
						<ol class="list-decimal space-y-2 pl-4 text-xs font-medium text-stone-600">
							<li>
								Create an app for {platformName(setupPanel)} in the provider's developer console and register
								this redirect URI:
								<code
									class="mt-1 block font-mono text-[11px] break-all text-stone-900"
									data-testid="setup-callback-uri"
									>{callbackUri(setupPanel, appUrl || page.url.origin)}</code
								>
							</li>
							<li>
								Add
								{#each setup.secrets as secret, index (secret)}{index > 0 ? ' and ' : ''}<code
										class="font-mono text-[11px] text-stone-900">{secret}</code
									>{/each}{#if setup.optionalSecrets}, plus
									{#each setup.optionalSecrets as secret, index (secret)}{index > 0
											? ' and '
											: ''}<code class="font-mono text-[11px] text-stone-900">{secret}</code>{/each}
									for a confidential app{/if}, to
								<code class="font-mono text-[11px] text-stone-900">.dev.vars</code>, then run
								<code
									class="mt-1 block font-mono text-[11px] break-words text-stone-900"
									data-testid="setup-command">{secretsPutCommand(setupPanel)}</code
								>
								and <code class="font-mono text-[11px] text-stone-900">npm run deploy</code>.
							</li>
							<li>Reload this page — the platform connects normally once the secrets are there.</li>
						</ol>
						{#if setup.note}
							<p class="text-xs font-medium text-stone-500">{setup.note}</p>
						{/if}
					</div>
					<a
						href={SETUP_GUIDE_URL}
						target="_blank"
						rel="noreferrer"
						class="inline-block text-[13px] font-bold text-stone-900 underline"
						>Step-by-step guide</a
					>
				</div>
			{:else if modalForm === 'none'}
				<div class="grid gap-3">
					{#each availablePlatforms as platform (platform.id)}
						<button
							type="button"
							class="group flex items-center justify-between rounded-[1.5rem] border border-stone-200/80 bg-white p-4 text-left shadow-sm transition-all hover:border-stone-300 hover:shadow-md"
							onclick={() => pickPlatform(platform.id)}
						>
							<div class="flex items-center gap-4">
								<span
									class="flex h-12 w-12 items-center justify-center rounded-[1rem] bg-stone-100 font-bold text-stone-600 shadow-sm transition-colors group-hover:bg-stone-200/50 group-hover:text-stone-900"
								>
									<SocialIcon platform={platform.id} className="h-5 w-5" />
								</span>
								<div>
									<h3 class="text-[15px] font-extrabold tracking-tight text-stone-900">
										{platform.name}
									</h3>
									<p class="mt-0.5 text-[13px] font-medium text-stone-500">
										{platform.description}
									</p>
								</div>
							</div>
							{#if needsSetup(platform.id, configured)}
								<span
									class="shrink-0 rounded-full border border-stone-200 bg-stone-50 px-3 py-1 text-[11px] font-bold tracking-tight text-stone-500"
									data-testid="needs-setup-{platform.id}">Needs setup</span
								>
							{:else}
								<div
									class="flex h-8 w-8 items-center justify-center rounded-full border border-stone-200 bg-stone-50 text-stone-500 transition-all group-hover:border-stone-900 group-hover:bg-stone-900 group-hover:text-white"
								>
									<Plus class="h-4 w-4" />
								</div>
							{/if}
						</button>
					{/each}
				</div>
			{:else if modalForm === 'bluesky'}
				<form onsubmit={connectBluesky} class="space-y-3">
					<button
						type="button"
						onclick={backToPlatforms}
						class="text-[13px] font-bold text-stone-500 hover:text-stone-900"
						>← All platforms</button
					>
					<h3 class="text-[17px] font-extrabold tracking-tight text-stone-900">Bluesky</h3>
					<ol class="list-decimal space-y-1 pl-4 text-xs font-medium text-stone-500">
						<li>
							Open
							<a
								href="https://bsky.app/settings/app-passwords"
								target="_blank"
								rel="noreferrer"
								class="underline">bsky.app → Settings → App passwords</a
							>
						</li>
						<li>Create an app password. Never use your main password.</li>
						<li>Paste handle + the xxxx-xxxx-xxxx-xxxx code below.</li>
					</ol>
					<input
						type="text"
						placeholder="handle.bsky.social"
						aria-label="Bluesky handle"
						bind:value={handle}
						class="w-full rounded-xl border border-stone-200/80 bg-stone-50 px-3 py-2.5 text-sm font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none"
						required
					/>
					<input
						type="password"
						placeholder="App password (xxxx-xxxx-xxxx-xxxx)"
						aria-label="Bluesky app password"
						bind:value={appPassword}
						class="w-full rounded-xl border border-stone-200/80 bg-stone-50 px-3 py-2.5 text-sm font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none"
						required
						autocomplete="off"
					/>
					{#if err}
						<p class="text-sm text-red-600">{err}</p>
					{/if}
					<button
						type="submit"
						disabled={loading}
						class="w-full rounded-full bg-stone-900 py-2.5 text-[13px] font-bold text-white transition-all hover:bg-stone-800 disabled:opacity-50"
						>{loading ? 'Connecting…' : 'Connect Bluesky'}</button
					>
				</form>
			{:else}
				<form onsubmit={connectMastodon} class="space-y-3">
					<button
						type="button"
						onclick={backToPlatforms}
						class="text-[13px] font-bold text-stone-500 hover:text-stone-900"
						>← All platforms</button
					>
					<h3 class="text-[17px] font-extrabold tracking-tight text-stone-900">Mastodon</h3>
					<p class="text-xs font-medium text-stone-500">
						Enter your instance (mastodon.social, hachyderm.io, …). You'll authorize on that site.
					</p>
					<input
						type="text"
						placeholder="https://mastodon.social"
						aria-label="Mastodon instance URL"
						bind:value={instanceUrl}
						class="w-full rounded-xl border border-stone-200/80 bg-stone-50 px-3 py-2.5 text-sm font-bold text-stone-900 focus:border-stone-400 focus:bg-white focus:outline-none"
						required
					/>
					{#if err}
						<p class="text-sm text-red-600">{err}</p>
					{/if}
					<button
						type="submit"
						disabled={loading}
						class="w-full rounded-full bg-stone-900 py-2.5 text-[13px] font-bold text-white transition-all hover:bg-stone-800 disabled:opacity-50"
						>{loading ? 'Redirecting…' : 'Connect Mastodon'}</button
					>
				</form>
			{/if}
		</div>
	</div>
{/if}

<ConfirmDialog
	open={pendingDisconnect !== null}
	idPrefix="disconnect-dialog"
	title={`Disconnect ${pendingDisconnect?.label ?? 'account'}?`}
	body="Scheduled posts are removed — any drafts still waiting come back to your Drafts tab. Published history stays in Posts, and reconnecting restores the same account."
	confirmLabel="Disconnect"
	busy={disconnectBusy}
	onConfirm={() => void confirmDisconnect()}
	onCancel={() => (pendingDisconnect = null)}
/>
