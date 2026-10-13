<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll, replaceState } from '$app/navigation';
	import {
		CONNECTED_APP_INFO,
		CONNECTED_APP_PROVIDERS,
		type AppRow,
		type ConnectedAppProvider
	} from '#lib/shared/connected-apps/providers';
	import { msg } from '#lib/shared/i18n';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Icon from '#lib/ui/Icon.svelte';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import InitialsTile from '#lib/ui/kit/InitialsTile.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';
	import Sheet from '#lib/ui/shell/Sheet.svelte';

	let { data, form } = $props();
	const { tr } = useI18n();

	// With JavaScript a row opens its detail in a sheet; without it `?app=<provider>` renders the same detail
	// inline, so "Putuskan" works as a plain form post.
	let hydrated = $state(false);
	let sheetOpen = $state(false);
	let openProvider = $state<ConnectedAppProvider>('gmail');
	/** The action in flight ('' when none): its button shows progress, every action button is disabled. */
	let busy = $state('');
	let actionError = $state('');
	let refreshing = $state(false);

	const rowOf = (provider: ConnectedAppProvider) =>
		data.apps.find((a) => a.provider === provider) as AppRow;
	const anyConnection = $derived(data.apps.some((a) => a.connection !== null));

	function openSheet(provider: ConnectedAppProvider) {
		openProvider = provider;
		actionError = '';
		sheetOpen = true;
	}

	onMount(() => {
		hydrated = true;
		if (data.open) openSheet(data.open);
	});

	function onSheetClose() {
		const url = new URL(window.location.href);
		if (url.searchParams.has('app')) {
			url.searchParams.delete('app');
			replaceState(url, {});
		}
	}

	/** Success is shown only once the server confirmed; the list is reloaded from the server either way. */
	const track =
		(name: string, closeSheet = false): SubmitFunction =>
		() => {
			busy = name;
			actionError = '';
			return async ({ result, update }) => {
				if (result.type === 'error') {
					actionError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
				} else {
					await update();
					// Gone or changed meanwhile: show the list as it is now.
					if (result.type === 'failure' && (result.status === 404 || result.status === 409))
						await invalidateAll();
					if (result.type === 'success' && closeSheet) sheetOpen = false;
				}
				busy = '';
			};
		};

	async function retry() {
		refreshing = true;
		try {
			await invalidateAll();
		} finally {
			refreshing = false;
		}
	}

	const doneText: Record<string, string> = {
		disconnected: msg('Sambungan diputus. Tokennya sudah dihapus.'),
		seeded: msg('Sambungan contoh ditambahkan.'),
		cleared: msg('Sambungan contoh dihapus.')
	};
	const done = $derived(
		form && 'done' in form && form.done && Object.hasOwn(doneText, form.done)
			? tr(doneText[form.done] as string)
			: ''
	);
	const serverError = $derived(form && 'error' in form && form.error ? tr(form.error) : '');
	const banner = $derived(actionError || serverError || undefined);
	const gmailMeta = $derived(
		!data.gmail.configured
			? tr('Belum dikonfigurasi')
			: data.gmail.status === 'connected'
				? tr('Terhubung')
				: data.gmail.status === 'needs_reconnect'
					? tr('Perlu dihubungkan ulang')
					: tr(
							'Membaca e-mail bukti pembayaran (hanya baca) dan menjadikannya draf di Kotak masuk.'
						)
	);
</script>

<svelte:head><title>{tr('Aplikasi terhubung')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/pengaturan', label: tr('Kembali ke Pengaturan') }}
	title={tr('Aplikasi terhubung')}
/>

<p class="intro">
	{tr(
		'Aplikasi lain yang bisa menerima atau mengirim data ruang ini. Sambungan berlaku untuk ruang yang sedang dibuka.'
	)}
</p>

{#snippet detail(app: AppRow)}
	<p class="description">{tr(CONNECTED_APP_INFO[app.provider].description)}</p>
	{#if app.state === 'connected' && app.connection}
		<p class="status">
			<span>{tr('Terhubung')}</span>
			{#if app.connection.externalLabel}<span class="meta">{app.connection.externalLabel}</span
				>{/if}
			{#if app.connection.isDemo}<Badge>{tr('Data demo')}</Badge>{/if}
		</p>
	{/if}
	<div class="connect">
		<Button type="button" variant="primary" disabled>{tr('Hubungkan')}</Button>
		<span class="caption">{tr('Belum dikonfigurasi')}</span>
	</div>
	{#if app.connection?.canDisconnect}
		<details class="confirm">
			<summary>{tr('Putuskan')}</summary>
			<form method="POST" action="?/disconnect" use:enhance={track('disconnect', true)}>
				<input type="hidden" name="connectionId" value={app.connection.id} />
				<p>
					{tr(
						'Sambungan dan tokennya dihapus dari server. Transaksi yang sudah tercatat tetap ada.'
					)}
				</p>
				<Button type="submit" variant="destructive" size="sm" disabled={busy !== ''}>
					{busy === 'disconnect' ? tr('Memproses…') : tr('Ya, putuskan')}
				</Button>
			</form>
		</details>
	{/if}
{/snippet}

{#if done}<p class="ok" role="status">{done}</p>{/if}
{#if !sheetOpen}<FormBanner message={banner} />{/if}

{#if !hydrated && data.open}
	<section class="inline-detail" aria-labelledby="inline-title">
		<h2 id="inline-title">{CONNECTED_APP_INFO[data.open].name}</h2>
		{@render detail(rowOf(data.open))}
		<a class="cancel" href="/pengaturan/aplikasi">{tr('Tutup')}</a>
	</section>
{/if}

<section class="forwarding" aria-labelledby="forwarding-title">
	<h2 id="forwarding-title">{tr('Teruskan e-mail')}</h2>
	<GroupList>
		<GroupRow>
			<a class="open" href="/pengaturan/aplikasi/email">
				<span class="tile" aria-hidden="true"><Icon name="mail" size={20} /></span>
				<span class="text">
					<span class="name">{tr('Alamat penerusan e-mail')}</span>
					<span class="meta">
						{data.forwardingReady
							? tr('Teruskan e-mail bank dan QRIS ke Kotak masuk')
							: tr('Belum dikonfigurasi')}
					</span>
				</span>
				<span class="chevron" aria-hidden="true"><Icon name="chevron-right" size={18} /></span>
			</a>
		</GroupRow>
	</GroupList>
</section>

<h2 class="apps-title">{tr('Tersedia')}</h2>
{#if refreshing}
	<Skeleton rows={5} />
{:else if data.loadError}
	<ErrorState text={tr(data.loadError)} onretry={retry} />
{:else}
	{#if !anyConnection}
		<p class="empty-line">{tr('Belum ada aplikasi yang terhubung.')}</p>
	{/if}
	<GroupList>
		{#each data.apps as app (app.provider)}
			<GroupRow>
				{#if app.provider === 'gmail'}
					<!-- FN-19: Gmail has its own page (the user's own connection, not the space's). -->
					<a class="open" href="/pengaturan/aplikasi/gmail">
						<InitialsTile name="Gmail" size={40} round />
						<span class="text">
							<span class="name">Gmail</span>
							<span class="meta">{gmailMeta}</span>
						</span>
						<span class="chevron" aria-hidden="true"><Icon name="chevron-right" size={18} /></span>
					</a>
				{:else}
					<a
						class="open"
						href="/pengaturan/aplikasi?app={app.provider}"
						onclick={(event) => {
							event.preventDefault();
							openSheet(app.provider);
						}}
					>
						<InitialsTile name={CONNECTED_APP_INFO[app.provider].name} size={40} round />
						<span class="text">
							<span class="name">{CONNECTED_APP_INFO[app.provider].name}</span>
							<span class="meta">
								{app.state === 'connected' ? tr('Terhubung') : tr('Belum dikonfigurasi')}
							</span>
						</span>
						{#if app.connection?.isDemo && app.state === 'connected'}
							<Badge>{tr('Data demo')}</Badge>
						{/if}
						<span class="chevron" aria-hidden="true"><Icon name="chevron-right" size={18} /></span>
					</a>
				{/if}
			</GroupRow>
		{/each}
	</GroupList>
{/if}

<Sheet bind:open={sheetOpen} title={CONNECTED_APP_INFO[openProvider].name} onclose={onSheetClose}>
	{#if sheetOpen}
		<FormBanner message={banner} />
		{@render detail(rowOf(openProvider))}
	{/if}
</Sheet>

{#if data.devTools}
	<section class="dev" aria-labelledby="dev-title">
		<h2 id="dev-title">{tr('Alat pengembang')}</h2>
		<p class="meta">
			{tr('Sambungan contoh untuk uji tampilan. Hanya ada di lingkungan pengembangan.')}
		</p>
		<form
			method="POST"
			action="?/seedDemoConnectedApp"
			class="dev-form"
			use:enhance={track('seed')}
		>
			<label class="field">
				<span>{tr('Aplikasi')}</span>
				<select name="provider">
					{#each CONNECTED_APP_PROVIDERS as provider (provider)}
						<option value={provider}>{CONNECTED_APP_INFO[provider].name}</option>
					{/each}
				</select>
			</label>
			<Button type="submit" variant="secondary" size="sm" disabled={busy !== ''}>
				{busy === 'seed' ? tr('Memproses…') : tr('Tambah sambungan contoh')}
			</Button>
		</form>
		<form method="POST" action="?/clearDemoConnectedApps" use:enhance={track('clear')}>
			<Button type="submit" variant="secondary" size="sm" disabled={busy !== ''}>
				{busy === 'clear' ? tr('Memproses…') : tr('Kosongkan sambungan contoh')}
			</Button>
		</form>
	</section>
{/if}

<style>
	.forwarding {
		display: grid;
		gap: 8px;
		margin: 8px 0 24px;
	}
	.forwarding h2,
	.apps-title {
		margin: 0 0 8px;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	.forwarding h2 {
		margin: 0;
	}
	.empty-line {
		margin: 0 0 12px;
		color: var(--muted);
		font-size: 14px;
	}
	.tile {
		display: grid;
		flex: none;
		place-items: center;
		width: 40px;
		height: 40px;
		border-radius: 50%;
		background: var(--panel-2);
	}
	.intro {
		margin: 4px 0 16px;
		color: var(--muted);
		font-size: 15px;
	}
	.open {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 12px;
		min-width: 0;
		min-height: 44px;
		color: var(--ink);
		text-decoration: none;
	}
	.text {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-width: 0;
	}
	.name {
		font-size: 15px;
		font-weight: 600;
	}
	.meta {
		font-size: 13px;
		color: var(--muted);
	}
	.chevron {
		display: grid;
		flex: none;
		color: var(--faint);
	}
	.description {
		margin: 0 0 12px;
	}
	.status {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin: 0 0 12px;
		font-weight: 600;
	}
	.connect {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px;
	}
	.caption {
		font-size: 14px;
		color: var(--muted);
	}
	.confirm {
		margin-top: 16px;
	}
	.confirm summary {
		display: flex;
		align-items: center;
		min-height: 44px;
		color: var(--money-up);
		font-weight: 600;
		cursor: pointer;
		list-style: none;
	}
	.confirm summary::-webkit-details-marker {
		display: none;
	}
	.confirm form {
		display: grid;
		gap: 8px;
		padding: 8px 0;
	}
	.confirm p {
		margin: 0;
		font-size: 14px;
	}
	.inline-detail {
		margin-bottom: 24px;
		padding: 16px;
		border-radius: var(--r-group);
		background: var(--panel);
	}
	.inline-detail h2 {
		margin: 0 0 12px;
		font-size: 20px;
		font-weight: 700;
	}
	.cancel {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		margin-top: 12px;
		color: var(--ink);
		font-weight: 600;
	}
	.ok {
		margin: 0 0 16px;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
	.dev {
		display: grid;
		gap: 12px;
		margin-top: 32px;
	}
	.dev h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	.dev .meta {
		margin: 0;
	}
	.dev-form {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: 12px;
	}
	.field {
		display: grid;
		gap: 4px;
		font-size: 14px;
	}
	.field select {
		min-height: 48px;
		padding: 0 12px;
		border: 0;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--ink);
		font: inherit;
		font-size: 16px;
	}
</style>
