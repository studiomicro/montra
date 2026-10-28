<script lang="ts">
	import { PLAN_CATALOGUE, PLAN_FEATURES, PLANS, type Plan } from '#lib/shared/billing/plans';
	import { msg } from '#lib/shared/i18n';
	import { formatMoney } from '#lib/shared/money-format';
	import { appName } from '#lib/shared/sanity';
	import { localizedSitePath } from '#lib/shared/site-locale';
	import Icon from '#lib/ui/Icon.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Illustration from '#lib/ui/kit/Illustration.svelte';
	import type { IllustrationName } from '#lib/ui/kit/illustrations';
	import Mascot from '#lib/ui/kit/Mascot.svelte';
	import SiteHead from '#lib/ui/site/SiteHead.svelte';

	const { tr, trf, locale } = useI18n();
	const href = (path: string) => localizedSitePath(locale, path);

	/**
	 * The module tree: every part of the app branches from one account. `soon`: not active for accounts yet (its
	 * provider key is an owner item), on a whole module or on one of its items. `ask`: the item is the assistant.
	 */
	const MODULES: {
		id: string;
		branch: string;
		title: string;
		path: string;
		scene: IllustrationName;
		text: string;
		items: { label: string; soon?: boolean; ask?: boolean }[];
		soon: boolean;
	}[] = [
		{
			id: 'catat',
			branch: msg('Mencatat'),
			title: msg('Catat'),
			path: '/kotak-masuk',
			scene: 'inbox',
			text: msg(
				'Ucapkan, impor atau teruskan: setiap pembayaran masuk ke satu catatan yang kamu periksa.'
			),
			items: [
				{ label: msg('Suara') },
				{ label: msg('Mutasi bank') },
				{ label: msg('Spreadsheet') },
				{ label: msg('Email bukti bayar'), soon: true },
				{ label: msg('Foto struk'), soon: true }
			],
			soon: false
		},
		{
			id: 'lihat',
			branch: msg('Melihat'),
			title: msg('Beranda dan Laporan'),
			path: '/laporan',
			scene: 'welcome',
			text: msg('Satu angka besar lebih dulu, lalu ke mana uangnya pergi bulan ini, dalam rupiah.'),
			items: [
				{ label: msg('Pengeluaran bulan ini') },
				{ label: msg('Sisa aman dibelanjakan per hari') },
				{ label: msg('Laporan bulanan') },
				{ label: msg('Alur uang') },
				{ label: msg('Hari beruntun') }
			],
			soon: false
		},
		{
			id: 'atur',
			branch: msg('Mengatur'),
			title: msg('Anggaran dan Langganan'),
			path: '/anggaran',
			scene: 'budget',
			text: msg(
				'Batas per kategori, langganan yang berjalan dan pengingat sebelum tagihan jatuh tempo.'
			),
			items: [
				{ label: msg('Anggaran per kategori') },
				{ label: msg('Langganan') },
				{ label: msg('Transaksi berulang') },
				{ label: msg('Kalender') }
			],
			soon: false
		},
		{
			id: 'miliki',
			branch: msg('Memiliki'),
			title: msg('Kekayaan'),
			path: '/kekayaan',
			scene: 'growth',
			text: msg('Total aset dikurangi utang, termasuk barang dan koleksi yang kamu simpan.'),
			items: [
				{ label: msg('Dompet dan rekening') },
				{ label: msg('Kekayaan bersih') },
				{ label: msg('Utang') },
				{ label: msg('Barang') },
				{ label: msg('Koleksi') }
			],
			soon: false
		},
		{
			id: 'bagi',
			branch: msg('Berbagi'),
			title: msg('Ruang dan Patungan'),
			path: '/ruang',
			scene: 'people',
			text: msg(
				'Ruang pribadi untukmu, ruang bersama sampai lima orang, dan patungan yang tercatat sampai lunas.'
			),
			items: [
				{ label: msg('Ruang pribadi') },
				{ label: msg('Ruang bersama') },
				{ label: msg('Pemilik dan Anggota') },
				{ label: msg('Patungan') }
			],
			soon: false
		},
		{
			id: 'tanya',
			branch: msg('Bertanya'),
			title: msg('Tanya dan Agen'),
			path: '/tanya',
			scene: 'ask',
			text: msg(
				'Asisten yang menjawab dari catatanmu sendiri, dan agen yang menyusun laporan untukmu.'
			),
			items: [{ label: msg('Laporan agen') }, { label: msg('Tanya catatanmu'), ask: true }],
			soon: true
		}
	];

	const SECURITY = [
		msg('File yang kamu unggah untuk dibaca diproses di memori dan tidak pernah disimpan.'),
		msg('Hasil bacaannya disegel dengan kunci akunmu sebelum disimpan.'),
		msg('Gmail hanya dibaca, tidak pernah diubah; isi email dihapus setelah dibaca.'),
		msg('Tanpa iklan, tanpa pelacak pihak ketiga, dan datamu tidak pernah dijual.'),
		msg('Data kotak masukmu tidak pernah dipakai untuk iklan, penilaian kredit atau pinjaman.'),
		msg('Nomor rekening dan kartu dipotong menjadi empat digit terakhir.')
	];

	// FN-30's catalogue is the only source of plan prices; every price is a placeholder, badged as such.
	const periodLabel = (plan: Plan) =>
		PLAN_CATALOGUE[plan].billingPeriod === 'weekly' ? tr('/minggu') : tr('/bulan');

	const FAQ = [
		{
			q: msg('Super app berarti bisa membayar dari sini?'),
			a: msg(
				'Tidak. Semua urusan mencatat uang ada dalam satu aplikasi: mencatat, anggaran, kekayaan, ruang bersama dan asisten. Pembayaran tetap kamu lakukan di bank atau dompet digitalmu; kami tidak pernah memindahkan uang.'
			)
		},
		{
			q: msg('Apakah ini bank atau dompet digital?'),
			a: msg(
				'Bukan. Kami hanya mencatat. Kami tidak menyimpan dana, tidak memindahkan uang, dan tidak pernah meminta login bank, PIN, kata sandi atau OTP.'
			)
		},
		{
			q: msg('Apakah aman menghubungkan Gmail?'),
			a: msg(
				'Akses yang diminta hanya baca. Yang diproses hanya email pembayaran; isi email dihapus setelah transaksinya diambil, dan email lain hanya disimpan penanda dan tanggalnya.'
			)
		},
		{
			q: msg('Apakah mutasi rekeningku disimpan?'),
			a: msg(
				'Tidak. File mutasi, tangkapan layar dan foto struk dibaca di memori lalu dilupakan. Yang tersimpan hanya transaksi yang kamu setujui.'
			)
		},
		{
			q: msg('Bisa dipakai bersama keluarga?'),
			a: msg(
				'Bisa. Selain ruang pribadi, kamu bisa membuat ruang bersama untuk sampai lima orang. Setiap catatan milik tepat satu ruang.'
			)
		},
		{
			q: msg('Perlu mengunduh dari toko aplikasi?'),
			a: msg(
				'Tidak. Aplikasinya dipasang langsung dari browser ke layar utama dan diperbarui sendiri.'
			)
		},
		{
			q: msg('Bagaimana cara menghapus akun?'),
			a: msg(
				'Dari Pengaturan › Akun di aplikasi. Akun, ruang pribadi dan semua sesi langsung dihapus. Tidak bisa masuk? Lihat halaman Hapus akun.'
			)
		}
	];
</script>

<SiteHead
	title={trf('{app} — super app keuangan untuk Indonesia', { app: appName() })}
	description={tr(
		'Catat, lihat, atur, miliki, bagi dan tanya: semua urusan uangmu dalam satu aplikasi. Bukan bank, tidak memindahkan uang.'
	)}
	path="/"
/>

<section class="hero" aria-labelledby="hero-title">
	<p class="eyebrow">{tr('Super app keuangan untuk Indonesia')}</p>
	<h1 id="hero-title">{tr('Semua urusan uangmu, satu aplikasi')}</h1>
	<p class="lead">
		{tr('Catat, lihat, atur, miliki, bagi dan tanya. Enam modul, satu akun, satu catatan.')}
	</p>
	<div class="actions">
		<a class="btn primary" href={href('/mulai')}>{tr('Mulai gratis')}</a>
		<a class="btn secondary" href={href('/pasang')}>{tr('Cara memasang')}</a>
	</div>
</section>

<section class="eco" aria-labelledby="eco-title">
	<div class="eco-inner">
		<div class="eco-head">
			<div class="eco-title">
				<h2 id="eco-title">{tr('Satu aplikasi, semua urusan uang')}</h2>
				<p>{trf('Modul di dalam {app}', { app: appName() })}</p>
			</div>
			<div class="hub">
				<Mascot pose="wave" size={88} />
				<p class="hub-text">
					<strong>Koko</strong>
					<span>{tr('menemanimu di setiap modul')}</span>
				</p>
			</div>
		</div>

		<ul class="tree">
			{#each MODULES as mod (mod.id)}
				<li class="branch" data-testid="site-module-{mod.id}">
					<span class="branch-label">{tr(mod.branch)}</span>
					<article class="module">
						<div class="art"><Illustration name={mod.scene} size={176} /></div>
						<h3>{tr(mod.title)}</h3>
						<p class="meta">
							<code>{mod.path}</code>
							{#if mod.soon}
								<span class="status soon">{tr('Segera')}</span>
							{:else}
								<span class="status live">{tr('Tersedia')}</span>
							{/if}
						</p>
						<p class="text">{tr(mod.text)}</p>
						<ul class="items">
							{#each mod.items as item, i (i)}
								<li class:ask={item.ask}>
									{#if item.ask}<Icon name="sparkle" size={16} />{/if}
									<span>{tr(item.label)}</span>
									{#if item.soon}<span class="later">{tr('segera')}</span>{/if}
								</li>
							{/each}
						</ul>
					</article>
				</li>
			{/each}
		</ul>
	</div>
</section>

<section class="dark" aria-labelledby="security-title">
	<h2 id="security-title">{tr('Datamu tetap milikmu')}</h2>
	<ul class="checks">
		{#each SECURITY as line, i (i)}
			<li><span class="tick"><Icon name="check" size={18} /></span>{tr(line)}</li>
		{/each}
	</ul>
	<a class="dark-link" href={href('/privasi')}>{tr('Baca kebijakan privasi')}</a>
</section>

<section class="band" aria-labelledby="pricing-title">
	<h2 id="pricing-title">{tr('Harga')}</h2>
	<ul class="plans">
		{#each PLANS as plan (plan)}
			{@const entry = PLAN_CATALOGUE[plan]}
			<li class="plan" data-testid="site-plan-{plan}">
				<h3>{tr(entry.label)}</h3>
				<p class="price">
					<span class="num">{formatMoney(entry.priceMinor, entry.currency)}</span><span
						class="period">{periodLabel(plan)}</span
					>
				</p>
				<Badge>{tr('harga sementara')}</Badge>
				<ul>
					{#each PLAN_FEATURES[plan] as feature, i (i)}<li>{tr(feature)}</li>{/each}
				</ul>
			</li>
		{/each}
	</ul>
	<p class="note">
		{tr('Harga di atas sementara dan belum final. Pembayaran sungguhan belum tersedia.')}
	</p>
</section>

<section class="band" aria-labelledby="faq-title">
	<h2 id="faq-title">{tr('Pertanyaan umum')}</h2>
	<div class="faq">
		{#each FAQ as item, i (i)}
			<details>
				<summary>{tr(item.q)}</summary>
				<p>{tr(item.a)}</p>
			</details>
		{/each}
	</div>
</section>

<section class="closing" aria-labelledby="closing-title">
	<h2 id="closing-title">{tr('Mulai dari pembayaran berikutnya')}</h2>
	<div class="actions">
		<a class="btn primary" href={href('/mulai')}>{tr('Mulai gratis')}</a>
		<a class="btn secondary" href={href('/blog')}>{tr('Baca blog')}</a>
	</div>
</section>

<style>
	.hero {
		padding: clamp(56px, 10vw, 128px) 0 48px;
		text-align: center;
	}
	.eyebrow {
		margin: 0 0 16px;
		color: var(--muted);
		font-size: 15px;
		font-weight: 600;
	}
	h1 {
		margin: 0;
		font-size: clamp(44px, 7.2vw, 100px);
		line-height: 1;
		font-weight: 600;
		letter-spacing: -0.044em;
		text-wrap: balance;
	}
	.lead {
		max-width: 36ch;
		margin: 24px auto 0;
		font-size: clamp(18px, 1.55vw, 21px);
		line-height: 1.45;
		color: var(--muted);
		text-wrap: pretty;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 12px;
		margin-top: 32px;
	}
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 52px;
		padding: 0 24px;
		border-radius: var(--r-pill);
		font-size: 16px;
		font-weight: 600;
		text-decoration: none;
	}
	.primary {
		background: var(--ink);
		color: var(--bg);
	}
	.secondary {
		background: var(--panel);
		color: var(--ink);
	}
	.band {
		padding: clamp(56px, 9vw, 120px) 0 0;
	}
	h2 {
		margin: 0;
		font-size: clamp(32px, 5.4vw, 64px);
		line-height: 1.02;
		font-weight: 600;
		letter-spacing: -0.042em;
		text-wrap: balance;
	}
	.dark {
		margin-top: clamp(56px, 9vw, 120px);
		padding: clamp(48px, 8vw, 96px) clamp(20px, 5vw, 64px);
		border-radius: var(--r-xl);
		background: var(--dark);
		color: var(--on-dark);
	}
	.checks {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(260px, 100%), 1fr));
		gap: 16px 32px;
		margin: 32px 0 0;
		padding: 0;
		list-style: none;
	}
	.checks li {
		display: flex;
		gap: 12px;
		color: var(--on-dark);
	}
	.tick {
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: var(--dark-panel-2);
	}
	.dark-link {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		margin-top: 24px;
		color: var(--on-dark);
		font-weight: 600;
	}
	.plans {
		padding: 0;
		list-style: none;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr));
		gap: 16px;
		margin-top: 32px;
	}
	.plan {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 8px;
		padding: 28px 24px;
		border-radius: var(--r-l);
		background: var(--panel);
	}
	.plan h3 {
		margin: 0;
		font-size: 22px;
		font-weight: 600;
	}
	.price {
		margin: 0;
		font-size: 40px;
		font-weight: 700;
		letter-spacing: -0.04em;
	}
	.period {
		margin-left: 4px;
		font-size: 17px;
		font-weight: 500;
		letter-spacing: 0;
		color: var(--muted);
	}
	.plan ul {
		margin: 8px 0 0;
		padding-left: 20px;
		color: var(--ink-2);
	}
	.note {
		margin: 16px 0 0;
		color: var(--muted);
		font-size: 15px;
	}
	.faq {
		margin-top: 24px;
		border-radius: var(--r-group);
		background: var(--panel);
	}
	details + details {
		border-top: 1px solid var(--line);
	}
	summary {
		display: flex;
		align-items: center;
		min-height: 56px;
		padding: 8px 20px;
		font-weight: 600;
		cursor: pointer;
	}
	details p {
		margin: 0;
		padding: 0 20px 20px;
		color: var(--ink-2);
	}
	.closing {
		padding: clamp(56px, 9vw, 120px) 0 0;
		text-align: center;
	}
	/* The module tree (owner request 2026-10-28): one account at the top, every module branching from it. Wider
	 * than the page column, centred on it. */
	.eco {
		/* Negative side margins widen it past the page column, up to 1440 px or the viewport less its gutters. */
		margin: clamp(24px, 4vw, 48px) calc(50% - min(720px, 50vw - var(--gutter))) 0;
		padding: clamp(6px, 1vw, 12px);
		border-radius: var(--r-xl);
		background: var(--panel);
	}
	.eco-inner {
		padding: clamp(20px, 3.2vw, 44px);
		border: 1px solid var(--line);
		border-radius: calc(var(--r-xl) - 8px);
		background: var(--bg-soft);
	}
	.eco-head {
		display: grid;
		gap: 24px;
		justify-items: start;
	}
	.eco-title h2 {
		font-size: clamp(30px, 4vw, 52px);
	}
	.eco-title p {
		margin: 8px 0 0;
		color: var(--muted);
	}
	.hub {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.hub-text {
		display: flex;
		flex-direction: column;
		margin: 0;
	}
	.hub-text strong {
		font-size: 24px;
		font-weight: 600;
		letter-spacing: -0.02em;
	}
	.hub-text span {
		color: var(--muted);
		font-size: 15px;
	}
	.tree {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr));
		gap: 16px;
		margin: 32px 0 0;
		padding: 0;
		list-style: none;
	}
	.branch {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.branch-label {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		color: var(--muted);
		font-size: 14px;
		font-weight: 500;
	}
	.branch-label::before {
		content: '';
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--accent);
	}
	.module {
		display: flex;
		flex: 1;
		flex-direction: column;
		padding: 20px;
		border: 1px solid var(--line);
		border-radius: var(--r-m);
		background: var(--bg);
	}
	.art {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 140px;
		margin-bottom: 12px;
	}
	.module h3 {
		margin: 0;
		font-size: 22px;
		font-weight: 600;
		letter-spacing: -0.02em;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin: 6px 0 0;
	}
	.meta code {
		color: color-mix(in srgb, var(--accent) 70%, var(--ink));
		font-family: var(--font-mono);
		font-size: 13px;
	}
	.status {
		padding: 1px 8px;
		border: 1px solid currentColor;
		border-radius: var(--r-pill);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	.live {
		color: var(--ok);
	}
	.soon {
		color: var(--warn-text);
	}
	.module .text {
		margin: 12px 0 0;
		color: var(--ink-2);
		font-size: 15px;
		line-height: 1.5;
	}
	.items {
		margin: 20px 0 0;
		padding: 0;
		list-style: none;
	}
	.items li {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 40px;
		border-top: 1px solid var(--line);
		font-size: 15px;
	}
	.items li:last-child {
		border-bottom: 1px solid var(--line);
	}
	.later {
		margin-left: auto;
		color: var(--muted);
		font-size: 12px;
	}
	.items .ask {
		color: color-mix(in srgb, var(--accent) 70%, var(--ink));
		font-weight: 600;
	}
	/* Wide screens: the hub on top, a line down to a bar, and a line with an arrow down to every module. */
	@media (min-width: 1280px) {
		.eco-head {
			grid-template-columns: 1fr auto 1fr;
			align-items: end;
		}
		.hub {
			position: relative;
			grid-column: 2;
		}
		.hub-text {
			position: absolute;
			top: 12px;
			left: calc(100% + 12px);
			white-space: nowrap;
		}
		.hub::after {
			content: '';
			position: absolute;
			top: 100%;
			left: 50%;
			height: 40px;
			border-left: 1.5px solid var(--accent);
		}
		.tree {
			position: relative;
			grid-template-columns: repeat(6, minmax(0, 1fr));
			margin-top: 40px;
			padding-top: 64px;
		}
		.tree::before {
			content: '';
			position: absolute;
			top: 0;
			right: calc((100% - 5 * 16px) / 12);
			left: calc((100% - 5 * 16px) / 12);
			border-top: 1.5px solid var(--accent);
		}
		.branch {
			position: relative;
		}
		.branch::before {
			content: '';
			position: absolute;
			top: -64px;
			left: 50%;
			height: 58px;
			border-left: 1.5px solid var(--accent);
		}
		.branch::after {
			content: '';
			position: absolute;
			top: -8px;
			left: calc(50% - 4.25px);
			border-top: 7px solid var(--accent);
			border-right: 5px solid transparent;
			border-left: 5px solid transparent;
		}
		.branch-label {
			position: absolute;
			top: -44px;
			left: calc(50% + 10px);
		}
		.branch-label::before {
			display: none;
		}
		.module {
			padding: 18px;
		}
		.module h3 {
			font-size: 20px;
		}
	}
</style>
