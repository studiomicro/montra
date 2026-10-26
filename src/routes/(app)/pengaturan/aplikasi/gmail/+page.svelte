<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { formatDateTimeWib } from '#lib/shared/dates';
	import { GMAIL_SCAN_MAX_IDS } from '#lib/shared/gmail/ledger';
	import { LOOKBACK_DAYS, LOOKBACK_LABELS } from '#lib/shared/gmail/lookback';
	import { msg } from '#lib/shared/i18n';
	import FormBanner from '#lib/ui/auth/FormBanner.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Button from '#lib/ui/kit/Button.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import GroupRow from '#lib/ui/kit/GroupRow.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data, form } = $props();
	const { tr, trf, locale } = useI18n();

	// Every write is a plain form post (works without JavaScript); with it, the page shows progress and reloads its
	// data from the server. Success is shown only once the server confirmed the write. "Hubungkan" answers with the
	// Google address as a plain link ("Lanjut ke Google"); with JavaScript the page follows it at once.
	let busy = $state('');
	let actionError = $state('');
	let refreshing = $state(false);

	const track =
		(name: string): SubmitFunction =>
		() => {
			busy = name;
			actionError = '';
			return async ({ result, update }) => {
				if (result.type === 'error')
					actionError = tr('Tidak bisa menyimpan. Periksa koneksi lalu coba lagi.');
				else if (result.type === 'success' && typeof result.data?.authUrl === 'string') {
					await update({ reset: false });
					window.location.assign(result.data.authUrl);
					return;
				} else {
					await update();
					if (result.type === 'failure' && (result.status === 404 || result.status === 409))
						await invalidateAll();
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
		disconnected: msg(
			'Gmail diputus. Data e-mail dihapus; transaksi yang sudah tersimpan tetap ada.'
		),
		disconnected_local: msg(
			'Data e-mail dihapus dari Montra, tetapi akses di Google belum bisa dicabut. Cabut sendiri di myaccount.google.com/permissions.'
		),
		moved: msg('Ruang tujuan disimpan.'),
		auto_on: msg('Periksa otomatis dinyalakan.'),
		auto_off: msg('Periksa otomatis dimatikan.'),
		checking: msg('Pemeriksaan dimulai. Pembayaran yang ditemukan masuk ke Kotak masuk.'),
		scanning: msg('Pemindaian dimulai. Kemajuannya tampil di bawah.'),
		stopped: msg('Pemindaian dihentikan.'),
		rereading: msg('E-mail yang tertunda dibaca ulang.')
	};
	const done = $derived(
		form && 'done' in form && typeof form.done === 'string' && Object.hasOwn(doneText, form.done)
			? tr(doneText[form.done] as string)
			: ''
	);
	const authUrl = $derived(
		form && 'authUrl' in form && typeof form.authUrl === 'string' ? form.authUrl : null
	);
	const serverError = $derived(form && 'error' in form && form.error ? tr(form.error) : '');
	const banner = $derived(actionError || serverError || undefined);
	const when = (ms: number) => formatDateTimeWib(ms, locale);
	const spaceLabel = (s: { kind: string; name: string }) =>
		s.kind === 'personal' ? tr('Pribadi') : s.name;
	const personal = $derived(data.spaces.find((s) => s.kind === 'personal') ?? data.spaces[0]);
	const reconnectText: Record<string, string> = {
		revoked: msg(
			'Google tidak lagi memberi akses (izin dicabut, atau masa uji 7 hari habis). Hubungkan ulang untuk melanjutkan.'
		),
		key: msg('Sambungan tidak bisa dibuka lagi di server. Hubungkan ulang untuk melanjutkan.')
	};
</script>

<svelte:head><title>{tr('Gmail')}</title></svelte:head>
<ScreenTitle
	back={{ href: '/pengaturan/aplikasi', label: tr('Kembali ke Aplikasi terhubung') }}
	title={tr('Gmail')}
	subtitle={tr('Catat pembayaran dari e-mail bank dan QRIS otomatis')}
/>

{#if data.result}
	<p class={data.resultOk ? 'ok' : 'notice-line'} role="status">{tr(data.result)}</p>
{/if}
{#if done}<p class="ok" role="status">{done}</p>{/if}
<FormBanner message={banner} />

{#snippet connectForm(label: string, selected: string | undefined)}
	{#if authUrl}
		<div class="stack">
			<p class="meta">{tr('Lanjutkan di Google untuk memberi izin baca e-mail.')}</p>
			<Button href={authUrl} variant="primary" full>{tr('Lanjut ke Google')}</Button>
		</div>
	{:else}
		<form method="POST" action="?/connect" class="stack" use:enhance={track('connect')}>
			<label class="field">
				<span>{tr('Dicatat ke')}</span>
				<select name="spaceId">
					{#each data.spaces as space (space.id)}
						<option value={space.id} selected={space.id === selected}>{spaceLabel(space)}</option>
					{/each}
				</select>
			</label>
			<Button type="submit" variant="primary" full disabled={busy !== ''}>
				{busy === 'connect' ? tr('Membuka Google…') : label}
			</Button>
		</form>
	{/if}
{/snippet}

{#snippet disconnectForm(connectionId: string, updatedAt: number)}
	<details class="confirm">
		<summary class="danger">{tr('Putuskan Gmail')}</summary>
		<form method="POST" action="?/disconnect" use:enhance={track('disconnect')}>
			<input type="hidden" name="connectionId" value={connectionId} />
			<input type="hidden" name="updatedAt" value={updatedAt} />
			<p>
				{tr(
					'Akses di Google dicabut dan semua data e-mail dihapus dari Montra. Draf yang belum ditinjau ikut dibuang; transaksi yang sudah tersimpan tetap ada.'
				)}
			</p>
			<Button type="submit" variant="destructive" size="sm" disabled={busy !== ''}>
				{busy === 'disconnect' ? tr('Memproses…') : tr('Ya, putuskan')}
			</Button>
		</form>
	</details>
{/snippet}

{#if refreshing}
	<Skeleton rows={5} />
{:else if data.loadError}
	<ErrorState text={tr(data.loadError)} onretry={retry} />
{:else if !data.configured && !data.connection}
	<section class="notice" aria-labelledby="not-configured-title">
		<h2 id="not-configured-title">{tr('Belum dikonfigurasi')}</h2>
		<p>{tr('Sambungan Gmail belum disiapkan di server ini:')}</p>
		<ul>
			{#each data.missing as reason, i (i)}<li>{tr(reason)}</li>{/each}
		</ul>
		<p>
			{tr('Sementara itu, kamu bisa meneruskan e-mail ke alamat penerusan.')}
		</p>
		<a class="link" href="/pengaturan/aplikasi/email">{tr('Teruskan e-mail')}</a>
	</section>
{:else if !data.connection}
	<section class="group" aria-labelledby="explain-title">
		<h2 id="explain-title">{tr('Sebelum menghubungkan')}</h2>
		<ul class="explain">
			<li>
				{tr(
					'Yang dibaca: hanya e-mail yang tampak seperti pembayaran (pengirim bank, QRIS, dompet digital, toko dan langganan, atau subjek seperti “QRIS”, “struk”, “tagihan”, “bukti pembayaran”). Tab Promosi dan Sosial dilewati, lampiran tidak pernah dibuka, dan e-mail tanpa nominal rupiah tidak dibaca lebih lanjut.'
				)}
			</li>
			<li>
				{tr(
					'Ke mana teksnya: dibaca di Montra. Bila tidak ada pembaca yang cocok, teks yang sudah dibersihkan dan disamarkan (paling banyak 6.000 karakter) dikirim ke Anthropic dengan kunci milikmu sendiri lewat AI Gateway, hanya untuk e-mail pembayaran yang berisi nominal. Tidak ada yang dikirim ke pihak lain; tidak untuk iklan, penilaian kredit atau pinjaman.'
				)}
			</li>
			<li>
				{tr(
					'Yang disimpan: nominal, penjual, tanggal, referensi yang disamarkan, domain pengirim dan subjek e-mail pembayaran. Untuk e-mail lain hanya ID Gmail dan tanggalnya. Teks e-mail dihapus setelah dibaca.'
				)}
			</li>
			<li>
				{tr(
					'Akses hanya baca dan bisa dicabut kapan saja di sini atau di myaccount.google.com/permissions.'
				)}
			</li>
			{#if data.testing}
				<li>
					{tr(
						'Montra masih dalam tahap uji di Google: peringatan “aplikasi belum diverifikasi” wajar muncul, dan akses berakhir setiap 7 hari sehingga perlu dihubungkan ulang.'
					)}
				</li>
			{/if}
			<li>
				{tr(
					'Semua pembayaran masuk ke Kotak masuk sebagai draf; tidak ada yang tersimpan sebelum kamu periksa.'
				)}
				<a class="link" href="/privasi">{tr('Kebijakan privasi')}</a>
			</li>
		</ul>
		{@render connectForm(tr('Hubungkan'), personal?.id)}
	</section>
{:else}
	{@const c = data.connection}
	{#if !data.configured}
		<section class="notice" aria-labelledby="unconfigured-title">
			<h2 id="unconfigured-title">{tr('Belum dikonfigurasi')}</h2>
			<p>
				{tr(
					'Pemeriksaan berhenti sampai server disiapkan lagi. Kamu tetap bisa memutus sambungan.'
				)}
			</p>
		</section>
	{/if}
	{#if c.status === 'needs_reconnect'}
		<section class="group" aria-labelledby="reconnect-title">
			<h2 id="reconnect-title">{tr('Perlu dihubungkan ulang')}</h2>
			<p class="meta bad">{tr(reconnectText[c.reconnectReason ?? 'revoked'] as string)}</p>
			<p class="meta">{tr('Draf yang sudah masuk tetap ada.')}</p>
			{#if data.configured}{@render connectForm(tr('Hubungkan ulang'), c.spaceId)}{/if}
			{@render disconnectForm(c.id, c.updatedAt)}
		</section>
	{:else}
		<section class="group" aria-labelledby="status-title">
			<h2 id="status-title">{tr('Terhubung')}</h2>
			<GroupList>
				<GroupRow>
					<div class="rows">
						{#if c.googleAddress}<code class="email">{c.googleAddress}</code>{/if}
						<span class="meta">
							{c.lastCheckedAt
								? trf('Terakhir diperiksa {waktu}', { waktu: when(c.lastCheckedAt) })
								: tr('Belum pernah diperiksa')}
						</span>
						<span class="meta">
							{trf('7 hari terakhir: {dibaca} e-mail dibaca, {draf} draf dibuat', {
								dibaca: c.read7d,
								draf: c.drafted7d
							})}
						</span>
					</div>
				</GroupRow>
			</GroupList>
			{#if data.testing}
				<p class="meta">
					{tr(
						'Masa uji Google: akses berakhir 7 hari setelah kamu memberi izin, lalu perlu dihubungkan ulang.'
					)}
				</p>
			{/if}
			{#if c.pausedReason === 'space_lost' || c.spaceName === null}
				<p class="meta bad">
					{tr('Ruang tujuan tidak tersedia lagi; pemeriksaan berhenti. Pilih ruang lain.')}
				</p>
			{/if}

			<form method="POST" action="?/target" class="stack" use:enhance={track('target')}>
				<input type="hidden" name="connectionId" value={c.id} />
				<input type="hidden" name="updatedAt" value={c.updatedAt} />
				<label class="field">
					<span>{tr('Dicatat ke')}</span>
					<select name="spaceId">
						{#each data.spaces as space (space.id)}
							<option value={space.id} selected={space.id === c.spaceId}>{spaceLabel(space)}</option
							>
						{/each}
					</select>
				</label>
				<Button type="submit" variant="secondary" full disabled={busy !== ''}>
					{busy === 'target' ? tr('Menyimpan…') : tr('Simpan ruang tujuan')}
				</Button>
			</form>

			<form method="POST" action="?/autoCheck" class="stack" use:enhance={track('autoCheck')}>
				<input type="hidden" name="connectionId" value={c.id} />
				<input type="hidden" name="updatedAt" value={c.updatedAt} />
				<input type="hidden" name="on" value={c.autoCheck ? '0' : '1'} />
				<p class="meta">
					{c.autoCheck
						? tr('Periksa otomatis: nyala (setiap jam, 06.00–23.00 WIB)')
						: tr('Periksa otomatis: mati')}
				</p>
				<Button
					type="submit"
					variant="secondary"
					full
					disabled={busy !== '' || (!c.autoCheck && c.pausedReason !== null)}
				>
					{busy === 'autoCheck'
						? tr('Menyimpan…')
						: c.autoCheck
							? tr('Matikan periksa otomatis')
							: tr('Nyalakan periksa otomatis')}
				</Button>
			</form>

			<form method="POST" action="?/checkNow" class="stack" use:enhance={track('checkNow')}>
				<input type="hidden" name="connectionId" value={c.id} />
				<Button type="submit" variant="secondary" full disabled={busy !== '' || !data.configured}>
					{busy === 'checkNow' ? tr('Memulai…') : tr('Periksa sekarang')}
				</Button>
			</form>
			<a class="link" href="/kotak-masuk">{tr('Buka Kotak masuk')}</a>
		</section>

		<section class="group" aria-labelledby="lookback-title">
			<h2 id="lookback-title">{tr('Lihat ke belakang')}</h2>
			<p class="meta">
				{trf(
					'Pindai e-mail lama sekali jalan, paling banyak {n} e-mail per pemindaian. Hasilnya masuk ke Kotak masuk sebagai draf.',
					{
						n: GMAIL_SCAN_MAX_IDS.toLocaleString('id-ID')
					}
				)}
			</p>
			{#if c.lookback}
				{@const scan = c.lookback}
				<GroupList>
					<GroupRow>
						<div class="rows" role="status">
							<span class="name">
								{scan.status === 'running'
									? tr('Sedang memindai…')
									: scan.status === 'done'
										? tr('Pemindaian selesai')
										: scan.status === 'cancelled'
											? tr('Pemindaian dihentikan')
											: tr('Pemindaian gagal')}
							</span>
							<span class="meta">
								{trf('{ditemukan} ditemukan · {dibaca} dibaca · {draf} draf', {
									ditemukan: scan.listed,
									dibaca: scan.read,
									draf: scan.drafted
								})}
							</span>
						</div>
					</GroupRow>
				</GroupList>
				{#if scan.status === 'running'}
					<form method="POST" action="?/stopLookback" use:enhance={track('stopLookback')}>
						<input type="hidden" name="scanId" value={scan.id} />
						<Button type="submit" variant="secondary" full disabled={busy !== ''}>
							{busy === 'stopLookback' ? tr('Memproses…') : tr('Hentikan')}
						</Button>
					</form>
				{/if}
			{/if}
			{#if c.lookback?.status !== 'running'}
				<form method="POST" action="?/lookback" class="stack" use:enhance={track('lookback')}>
					<input type="hidden" name="connectionId" value={c.id} />
					<label class="field">
						<span>{tr('Rentang')}</span>
						<select name="days">
							{#each LOOKBACK_DAYS as days (days)}
								<option value={days} disabled={days > data.lookbackMax}>
									{days > data.lookbackMax
										? `${tr(LOOKBACK_LABELS[days])} · ${tr('Tersedia di paket Pro')}`
										: tr(LOOKBACK_LABELS[days])}
								</option>
							{/each}
						</select>
					</label>
					<Button type="submit" variant="secondary" full disabled={busy !== '' || !data.configured}>
						{busy === 'lookback' ? tr('Memulai…') : tr('Pindai sekarang')}
					</Button>
				</form>
			{/if}
		</section>

		{#if c.rereadable > 0}
			<section class="group" aria-labelledby="reread-title">
				<h2 id="reread-title">{tr('Tertunda')}</h2>
				<p class="meta">
					{trf(
						'{n} e-mail pembayaran belum terbaca karena kunci Anthropic atau pembacaan AI belum siap.',
						{
							n: c.rereadable
						}
					)}
				</p>
				<a class="link" href="/pengaturan/integrasi">{tr('Tambahkan kunci Anthropic')}</a>
				<form method="POST" action="?/reread" use:enhance={track('reread')}>
					<Button type="submit" variant="secondary" full disabled={busy !== '' || !data.configured}>
						{busy === 'reread' ? tr('Memulai…') : tr('Baca ulang yang tertunda')}
					</Button>
				</form>
			</section>
		{/if}

		<section class="group" aria-labelledby="disconnect-title">
			<h2 id="disconnect-title" class="sr-only">{tr('Putuskan Gmail')}</h2>
			{@render disconnectForm(c.id, c.updatedAt)}
		</section>
	{/if}
{/if}

<style>
	.group {
		display: grid;
		gap: 8px;
		margin-top: 24px;
	}
	h2 {
		margin: 0;
		font-size: 20px;
		font-weight: 700;
		letter-spacing: -0.015em;
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
	.notice {
		display: grid;
		gap: 4px;
		margin-top: 16px;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
	}
	.notice h2 {
		font-size: 15px;
	}
	.notice p,
	.notice ul {
		margin: 0;
		font-size: 14px;
		color: var(--muted);
	}
	.notice ul {
		padding-left: 20px;
	}
	.explain {
		display: grid;
		gap: 8px;
		margin: 0;
		padding-left: 20px;
		font-size: 14px;
	}
	.stack {
		display: grid;
		gap: 8px;
		margin-top: 8px;
	}
	.field {
		display: grid;
		gap: 6px;
		font-size: 15px;
		font-weight: 600;
	}
	.field select {
		min-height: 48px;
		padding: 0 12px;
		border: 0;
		border-radius: var(--r-s);
		background: var(--panel);
		color: var(--ink);
		font: inherit;
		font-weight: 400;
	}
	.rows {
		display: grid;
		flex: 1;
		gap: 2px;
		min-width: 0;
		padding: 4px 0;
	}
	.email {
		font-family: var(--font-mono);
		font-size: 14px;
		overflow-wrap: anywhere;
	}
	.name {
		font-size: 15px;
		font-weight: 600;
	}
	.meta {
		margin: 0;
		font-size: 13px;
		color: var(--muted);
		overflow-wrap: anywhere;
	}
	.bad {
		color: var(--money-up);
		font-weight: 600;
	}
	/* A block row of its own (never inline in a sentence: a 44 px inline box blows up the line height). */
	.link {
		display: flex;
		align-items: center;
		width: fit-content;
		min-height: 44px;
		/* The app's one standalone text link (app.css .text-link): ink, underlined, never blue or bold. */
		color: var(--ink-2);
		font-size: 15px;
		font-weight: 500;
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.confirm summary {
		display: flex;
		align-items: center;
		min-height: 44px;
		font-weight: 600;
		cursor: pointer;
		list-style: none;
	}
	.confirm summary.danger {
		color: var(--money-up);
	}
	.confirm summary::-webkit-details-marker {
		display: none;
	}
	.confirm form {
		display: grid;
		gap: 8px;
		padding: 0 0 8px;
	}
	.confirm p {
		margin: 0;
		font-size: 14px;
	}
	.ok,
	.notice-line {
		margin: 16px 0 0;
		padding: 12px 14px;
		border-radius: var(--r-s);
		background: var(--panel);
	}
	.ok {
		color: var(--money-in);
	}
</style>
