<script lang="ts">
	import { onMount } from 'svelte';
	import type { UpdateCheck } from '#lib/shared/sw-update';
	import { formatShortDate } from '#lib/shared/dates';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import ReleaseNote from '#lib/ui/pwa/ReleaseNote.svelte';
	import UpdateBanner from '#lib/ui/pwa/UpdateBanner.svelte';
	import { checkForUpdate, pwaUpdate } from '#lib/ui/pwa/update.svelte';
	import IconRow from '#lib/ui/shell/IconRow.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	/**
	 * FN-42 "Tentang Montra": the running version, its release date and "Apa yang baru" are server-rendered (they
	 * show without JavaScript); the update controls need the service worker, so they render only once hydrated.
	 */
	let { data } = $props();
	const { tr, trf, locale } = useI18n();

	/** How long "Sudah versi terbaru" (and the other check results) stays before it clears. */
	const RESULT_MS = 5000;

	let hydrated = $state(false);
	let checking = $state(false);
	let result = $state<UpdateCheck | null>(null);
	let clearResult: ReturnType<typeof setTimeout> | undefined;

	onMount(() => {
		hydrated = true;
		return () => clearTimeout(clearResult);
	});

	async function check() {
		checking = true;
		result = null;
		clearTimeout(clearResult);
		try {
			result = await checkForUpdate();
		} finally {
			checking = false;
		}
		clearResult = setTimeout(() => (result = null), RESULT_MS);
	}

	const resultText = $derived(
		result === 'latest'
			? tr('Sudah versi terbaru')
			: result === 'found'
				? tr('Versi baru ditemukan dan sedang diunduh.')
				: result === 'failed'
					? tr('Tidak bisa memeriksa pembaruan. Periksa koneksi lalu coba lagi.')
					: ''
	);
</script>

<svelte:head><title>{tr('Tentang Montra')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/pengaturan', label: tr('Kembali ke Pengaturan') }}
	title={tr('Tentang Montra')}
/>

<section class="hero" aria-label={tr('Versi aplikasi')}>
	<p class="big num" data-testid="app-version">
		{trf('Versi {versi}', { versi: data.version })}
	</p>
	{#if data.releasedOn}
		<p class="meta">
			{tr('Dirilis')}
			<time datetime={data.releasedOn}>{formatShortDate(data.releasedOn, locale)}</time>
		</p>
	{/if}
</section>

{#if hydrated}
	<section class="section" aria-labelledby="update-section">
		<h2 id="update-section">{tr('Pembaruan')}</h2>
		{#if pwaUpdate.available}
			<UpdateBanner />
		{:else if pwaUpdate.registration === 'unavailable'}
			<p class="note">{tr('Pembaruan otomatis tidak tersedia di browser ini.')}</p>
		{:else}
			<p class="note">
				{tr('Versi baru diunduh sendiri; kamu yang memilih kapan memuat ulang.')}
			</p>
			<div class="check">
				<Button
					variant="secondary"
					size="md"
					disabled={checking || pwaUpdate.registration !== 'ready'}
					onclick={check}
				>
					{checking ? tr('Memeriksa…') : tr('Periksa pembaruan')}
				</Button>
			</div>
		{/if}
		<p class="result" role="status">{resultText}</p>
	</section>
{/if}

<section class="section" aria-labelledby="news-title">
	<h2 id="news-title">{tr('Apa yang baru')}</h2>
	{#if data.notes.length === 0}
		<p class="note">{tr('Belum ada catatan rilis.')}</p>
	{:else}
		{#each data.notes as note (note.version)}
			<ReleaseNote {note} level={3} current={note.version === data.version} />
		{/each}
		<GroupList>
			<IconRow
				icon="list"
				title={tr('Semua catatan rilis')}
				href="/pengaturan/tentang/catatan-rilis"
			/>
		</GroupList>
	{/if}
</section>

<section class="section" aria-labelledby="source-title">
	<h2 id="source-title">{tr('Kode sumber')}</h2>
	<GroupList>
		{#if data.sourceUrl}
			<IconRow
				icon="code"
				title={tr('Kode sumber Montra')}
				hint={tr('Perangkat lunak bebas di bawah lisensi AGPL-3.0')}
				href={data.sourceUrl}
			/>
		{:else}
			<IconRow icon="code" title={tr('Kode sumber Montra')} hint={tr('Belum dikonfigurasi')} />
		{/if}
	</GroupList>
</section>

<style>
	/* One big number first (§ 3a): the version stands on the page, no card around it. */
	.hero {
		margin-top: 8px;
	}
	.meta,
	.note {
		margin: 0;
		color: var(--muted);
		font-size: 14px;
	}
	.big {
		margin: 2px 0 4px;
		font-size: 40px;
		line-height: 1.1;
		font-weight: 700;
		letter-spacing: -0.035em;
	}
	.section {
		display: grid;
		gap: 12px;
		margin-top: 32px;
	}
	h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	.result {
		margin: 0;
		font-size: 14px;
	}
</style>
