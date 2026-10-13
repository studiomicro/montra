<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { formatDateTimeWib, formatShortDate } from '#lib/shared/dates';
	import {
		CONSENT_KINDS,
		CONSENT_LABELS,
		CONSENT_VERSIONS,
		EXPORT_REFUSALS,
		isExportRefusal,
		type ConsentKind
	} from '#lib/shared/privacy';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import Toggle from '#lib/ui/kit/Toggle.svelte';
	import IconRow from '#lib/ui/shell/IconRow.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data, form } = $props();
	const { tr, trf, locale } = useI18n();

	// ---- Statistik pemakaian: the switch shows the server's state; a flip submits and shows the stored value.
	let shownStats = $derived(data.statsEnabled);
	let savingStats = $state(false);
	let statsError = $state('');
	let refreshing = $state(false);
	let hydrated = $state(false);
	onMount(() => (hydrated = true));

	const saveStats: SubmitFunction = () => {
		shownStats = data.statsEnabled;
		savingStats = true;
		statsError = '';
		return async ({ result, update }) => {
			if (result.type === 'error' || result.type === 'failure')
				statsError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
			else await update({ reset: false });
			savingStats = false;
		};
	};
	const statsSaved = $derived(!savingStats && form && 'savedStats' in form && form.savedStats);

	async function retry() {
		refreshing = true;
		try {
			await invalidateAll();
		} finally {
			refreshing = false;
		}
	}

	// ---- Ekspor data: with JavaScript the ZIP is fetched, then saved; "selesai" only once all of it arrived.
	let exporting = $state(false);
	let exportError = $state('');
	let exportDone = $state(false);
	const exportRefusal = $derived(exportError || (data.exportError ? tr(data.exportError) : ''));

	function fileNameOf(response: Response): string {
		const match = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '');
		return match?.[1] ?? 'montra-ekspor.zip';
	}

	async function exportAll(event: SubmitEvent) {
		event.preventDefault();
		if (exporting) return;
		exporting = true;
		exportError = '';
		exportDone = false;
		try {
			const response = await fetch('/pengaturan/privasi/ekspor', {
				method: 'POST',
				body: new URLSearchParams()
			});
			if (response.redirected) {
				// A refusal comes back as the page with `?ekspor=<reason>`.
				const code = new URL(response.url).searchParams.get('ekspor');
				exportError = tr(
					isExportRefusal(code)
						? EXPORT_REFUSALS[code]
						: 'Ekspor gagal. Periksa koneksi lalu coba lagi.'
				);
				return;
			}
			if (!response.ok || response.headers.get('content-type') !== 'application/zip')
				throw new Error(`export ${response.status}`);
			const blob = await response.blob();
			const url = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = url;
			link.download = fileNameOf(response);
			link.click();
			setTimeout(() => URL.revokeObjectURL(url), 60_000);
			exportDone = true;
		} catch (e) {
			console.warn('privasi: export failed', e instanceof Error ? e.message : 'unknown');
			exportError = tr('Ekspor gagal. Periksa koneksi lalu coba lagi.');
		} finally {
			exporting = false;
		}
	}

	// ---- Persetujuan: the latest record of each kind.
	const latest = $derived(
		CONSENT_KINDS.flatMap((kind) => {
			const record = data.consent.findLast((c) => c.kind === kind);
			return record ? [{ ...record, kind: kind as ConsentKind }] : [];
		})
	);
	const versionLabel = (version: string) =>
		/^\d{4}-\d{2}-\d{2}$/.test(version) ? formatShortDate(version, locale) : version;
</script>

<svelte:head><title>{tr('Privasi')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/pengaturan', label: tr('Kembali ke Pengaturan') }}
	title={tr('Privasi')}
/>

<p class="intro">
	{tr(
		'Tanpa iklan, tanpa pelacak pihak ketiga, dan datamu tidak dijual. Di sini kamu bisa mengatur statistik, mengunduh semua datamu, dan melihat persetujuanmu.'
	)}
</p>

{#if refreshing}
	<Skeleton rows={4} />
{:else if data.loadError}
	<ErrorState text={tr(data.loadError)} onretry={retry} />
{:else}
	<section class="block" aria-labelledby="stats-title">
		<h2 id="stats-title">{tr('Statistik pemakaian')}</h2>
		<p class="text">
			{tr(
				'Yang dihitung: layar yang dibuka dan tombol yang ditekan (dari daftar tetap), jenis perangkat (iOS, Android atau lainnya), bahasa aplikasi, dan negara. Tidak pernah: akun, e-mail, jumlah uang, teks yang kamu ketik, atau alamat IP. Disimpan di Cloudflare, tidak dibagikan ke siapa pun.'
			)}
		</p>
		{#if statsSaved}<p class="ok" role="status">{tr('Perubahan disimpan.')}</p>{/if}
		<FormBanner message={statsError || undefined} />
		<GroupList>
			<GroupRow>
				<form method="POST" action="?/setStats" class="row-form" use:enhance={saveStats}>
					<Toggle
						name="enabled"
						label={tr('Kirim statistik pemakaian')}
						hint={savingStats
							? tr('Menyimpan…')
							: shownStats
								? tr('Aktif untuk akunmu')
								: tr('Mati untuk akunmu')}
						bind:checked={() => shownStats, (v) => (shownStats = v)}
						disabled={savingStats}
						onchange={(event) => event.currentTarget.form?.requestSubmit()}
					/>
					{#if !hydrated}
						<Button type="submit" variant="secondary" size="sm">{tr('Simpan')}</Button>
					{/if}
				</form>
			</GroupRow>
		</GroupList>
	</section>

	<section class="block" id="ekspor" aria-labelledby="export-title">
		<h2 id="export-title">{tr('Ekspor data')}</h2>
		<p class="text">
			{tr(
				'Satu file ZIP berisi semua datamu: transaksi setiap ruang (CSV, format yang sama dengan Ekspor CSV), data lain setiap ruang dan akunmu (JSON), serta foto barang dan koleksi.'
			)}
		</p>
		<FormBanner message={exportRefusal || undefined} />
		{#if exportDone}
			<p class="ok" role="status">{tr('Ekspor selesai. File sudah diunduh.')}</p>
		{/if}
		<form method="POST" action="/pengaturan/privasi/ekspor" onsubmit={exportAll}>
			<Button type="submit" variant="secondary" disabled={exporting}>
				{exporting ? tr('Menyiapkan ekspor…') : tr('Ekspor semua data')}
			</Button>
		</form>
	</section>

	<section class="block" aria-labelledby="consent-title">
		<h2 id="consent-title">{tr('Persetujuan')}</h2>
		{#if latest.length === 0}
			<p class="text">
				{tr('Belum ada catatan persetujuan. Akun ini dibuat sebelum persetujuan dicatat.')}
			</p>
		{:else}
			<GroupList>
				{#each latest as record (record.kind)}
					<GroupRow>
						<span class="consent">
							<span class="title">{tr(CONSENT_LABELS[record.kind])}</span>
							<span class="hint">
								{trf('Versi {version}, disetujui {date}', {
									version: versionLabel(record.version),
									date: formatDateTimeWib(record.acceptedAt, locale)
								})}
							</span>
							{#if record.version !== CONSENT_VERSIONS[record.kind]}
								<span class="hint">
									{trf('Versi yang berlaku sekarang: {version}', {
										version: versionLabel(CONSENT_VERSIONS[record.kind])
									})}
								</span>
							{/if}
						</span>
					</GroupRow>
				{/each}
			</GroupList>
		{/if}
		<p class="text">
			{tr(
				'Teks ketentuan, kebijakan privasi dan pemberitahuan pemrosesan di luar Indonesia masih draf, menunggu tinjauan hukum.'
			)}
		</p>
		{#if data.siteOrigin}
			<GroupList>
				<IconRow icon="lock" title={tr('Kebijakan privasi')} href="{data.siteOrigin}/privasi" />
				<IconRow icon="file" title={tr('Ketentuan layanan')} href="{data.siteOrigin}/ketentuan" />
			</GroupList>
		{/if}
	</section>

	<section class="block" aria-labelledby="delete-title">
		<h2 id="delete-title">{tr('Hapus akun')}</h2>
		<p class="text">
			{tr(
				'Hapus akun dan semua datamu dari Pengaturan › Akun. Tanpa masuk, cara menghapus juga dijelaskan di halaman publik Hapus akun.'
			)}
		</p>
		<GroupList>
			<IconRow icon="user" title={tr('Buka Pengaturan › Akun')} href="/pengaturan/akun" />
			{#if data.siteOrigin}
				<IconRow
					icon="link"
					title={tr('Halaman publik Hapus akun')}
					href="{data.siteOrigin}/hapus-akun"
				/>
			{/if}
		</GroupList>
	</section>
{/if}

<style>
	.intro {
		margin: 4px 0 16px;
		color: var(--muted);
		font-size: 15px;
	}
	.block {
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
	.text {
		margin: 0;
		color: var(--muted);
		font-size: 15px;
	}
	.row-form {
		display: flex;
		flex: 1;
		align-items: center;
		gap: 12px;
		min-width: 0;
	}
	.ok {
		margin: 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--money-in);
	}
	.consent {
		display: flex;
		flex-direction: column;
		min-width: 0;
		padding: 6px 0;
	}
	.title {
		font-size: 15px;
		font-weight: 600;
	}
	.hint {
		font-size: 13px;
		color: var(--muted);
	}
</style>
