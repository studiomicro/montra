<script lang="ts">
	import { PLAN_CATALOGUE, PLAN_FEATURES, PLANS, type Plan } from '#lib/shared/billing/plans';
	import { msg } from '#lib/shared/i18n';
	import { formatMoney } from '#lib/shared/money-format';
	import { appName } from '#lib/shared/sanity';
	import { localizedSitePath } from '#lib/shared/site-locale';
	import Icon from '#lib/ui/Icon.svelte';
	import type { IconName } from '#lib/ui/icons';
	import { useI18n } from '#lib/ui/i18n-context';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import SiteHead from '#lib/ui/site/SiteHead.svelte';

	const { tr, trf, locale } = useI18n();
	const href = (path: string) => localizedSitePath(locale, path);

	/** One card per capture path. `soon`: not active for accounts yet (its provider key is an owner item). */
	const CAPTURE: { icon: IconName; title: string; text: string; soon: boolean }[] = [
		{
			icon: 'mail',
			title: msg('Email bukti bayar'),
			text: msg(
				'Hubungkan Gmail dengan izin hanya baca. Bukti bayar QRIS, transfer dan tagihan menjadi transaksi sendiri.'
			),
			soon: true
		},
		{
			icon: 'mic',
			title: msg('Suara'),
			text: msg('Ucapkan "kopi 25 ribu, parkir 5 ribu" dan beberapa transaksi tercatat sekaligus.'),
			soon: false
		},
		{
			icon: 'receipt',
			title: msg('Foto struk'),
			text: msg(
				'Potret struknya; tokonya, tanggal dan totalnya terbaca. Kamu memeriksa sebelum menyimpan.'
			),
			soon: true
		},
		{
			icon: 'file',
			title: msg('Mutasi bank'),
			text: msg(
				'Impor file CSV dari bank atau dompet digital, periksa barisnya, lalu simpan sekaligus.'
			),
			soon: false
		}
	];

	const FEATURES: { icon: IconName; title: string; text: string; soon: boolean }[] = [
		{
			icon: 'home',
			title: msg('Satu angka di Beranda'),
			text: msg(
				'Pengeluaran bulan ini lebih dulu, lalu berapa yang masih aman dibelanjakan per hari.'
			),
			soon: false
		},
		{
			icon: 'chart',
			title: msg('Anggaran dan laporan bulanan'),
			text: msg('Batas per kategori, perbandingan dengan bulan lalu dalam rupiah, bukan persen.'),
			soon: false
		},
		{
			icon: 'wallet',
			title: msg('Kekayaan bersih'),
			text: msg('Dompet, rekening, aset dan utang dalam satu angka yang ikut bergerak.'),
			soon: false
		},
		{
			icon: 'people',
			title: msg('Ruang bersama'),
			text: msg(
				'Catat keuangan rumah tangga bersama sampai lima orang, dengan peran Pemilik dan Anggota.'
			),
			soon: false
		},
		{
			icon: 'repeat',
			title: msg('Langganan dan tagihan'),
			text: msg('Lihat langganan yang berjalan dan dapat pengingat sebelum tagihan jatuh tempo.'),
			soon: false
		},
		{
			icon: 'sparkle',
			title: msg('Tanya catatanmu'),
			text: msg('Asisten yang menjawab dari catatanmu sendiri, bukan dari tebakan.'),
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
	title={trf('{app} — catat uang tanpa repot', { app: appName() })}
	description={tr(
		'Pencatat keuangan untuk Indonesia yang mengisi dirinya sendiri dari email bukti bayar, suara, foto struk dan mutasi bank.'
	)}
	path="/"
/>

<section class="hero" aria-labelledby="hero-title">
	<p class="eyebrow">{tr('Pencatat keuangan untuk Indonesia')}</p>
	<h1 id="hero-title">{tr('Catat uang tanpa repot')}</h1>
	<p class="lead">
		{tr('Pembayaranmu tercatat sendiri dari email, suara, struk dan mutasi bank.')}
	</p>
	<div class="actions">
		<a class="btn primary" href={href('/mulai')}>{tr('Mulai gratis')}</a>
		<a class="btn secondary" href={href('/pasang')}>{tr('Cara memasang')}</a>
	</div>

	<figure class="mock" aria-label={tr('Contoh tampilan Beranda')}>
		<div class="phone">
			<p class="mock-label">{tr('Pengeluaran bulan ini')}</p>
			<p class="mock-num num">{formatMoney(348_200_000)}</p>
			<p class="mock-pill">{tr('Sisa aman dibelanjakan per hari')}</p>
			<ul class="mock-rows">
				<li>
					<span>{tr('Kopi')}</span><span class="num">{formatMoney(-2_500_000)}</span>
				</li>
				<li>
					<span>{tr('Transportasi')}</span><span class="num">{formatMoney(-1_800_000)}</span>
				</li>
				<li>
					<span>{tr('Belanja Harian')}</span><span class="num">{formatMoney(-12_450_000)}</span>
				</li>
			</ul>
		</div>
		<figcaption><Badge>{tr('Contoh, bukan data sungguhan')}</Badge></figcaption>
	</figure>
</section>

<section class="band" aria-labelledby="how-title">
	<h2 id="how-title">{tr('Cara kerjanya')}</h2>
	<p class="section-lead">
		{tr('Empat jalan masuk, satu catatan. Pilih yang paling cepat untuk setiap pembayaran.')}
	</p>
	<ul class="cards">
		{#each CAPTURE as card, i (i)}
			<li class="card">
				<span class="icon"><Icon name={card.icon} size={22} /></span>
				<h3>{tr(card.title)}</h3>
				<p>{tr(card.text)}</p>
				{#if card.soon}<Badge>{tr('Segera hadir')}</Badge>{/if}
			</li>
		{/each}
	</ul>
</section>

<section class="band" aria-labelledby="features-title">
	<h2 id="features-title">{tr('Semua uangmu, satu tempat')}</h2>
	<ul class="cards">
		{#each FEATURES as card, i (i)}
			<li class="card">
				<span class="icon"><Icon name={card.icon} size={22} /></span>
				<h3>{tr(card.title)}</h3>
				<p>{tr(card.text)}</p>
				{#if card.soon}<Badge>{tr('Segera hadir')}</Badge>{/if}
			</li>
		{/each}
	</ul>
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
	.mock {
		margin: 56px auto 0;
		max-width: 340px;
	}
	.phone {
		padding: 28px 20px 20px;
		border-radius: var(--r-xl);
		background: var(--bg);
		box-shadow: var(--shadow-card);
		border: 1px solid var(--line);
		text-align: center;
	}
	.mock-label {
		margin: 0;
		color: var(--muted);
		font-size: 14px;
	}
	.mock-num {
		margin: 4px 0 0;
		font-size: 40px;
		font-weight: 700;
		letter-spacing: -0.045em;
		line-height: 1.05;
	}
	.mock-pill {
		display: inline-block;
		margin: 12px 0 0;
		padding: 6px 12px;
		border-radius: var(--r-pill);
		background: var(--panel);
		color: var(--ink-2);
		font-size: 13px;
	}
	.mock-rows {
		margin: 20px 0 0;
		padding: 4px 16px;
		list-style: none;
		border-radius: var(--r-group);
		background: var(--panel);
		text-align: left;
	}
	.mock-rows li {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 0;
		font-size: 15px;
		font-weight: 600;
	}
	.mock-rows li + li {
		border-top: 1px solid var(--line);
	}
	figcaption {
		margin-top: 12px;
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
	.section-lead {
		max-width: 52ch;
		margin: 16px 0 0;
		color: var(--muted);
		font-size: 18px;
	}
	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 16px;
		margin: 32px 0 0;
		padding: 0;
		list-style: none;
	}
	.card {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 8px;
		padding: 24px;
		border-radius: var(--r-l);
		background: var(--panel);
	}
	.card h3 {
		margin: 4px 0 0;
		font-size: 19px;
		font-weight: 600;
		letter-spacing: -0.012em;
	}
	.card p {
		margin: 0;
		color: var(--ink-2);
		font-size: 16px;
	}
	.icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 44px;
		height: 44px;
		border-radius: 50%;
		background: var(--bg);
		color: var(--ink);
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
</style>
