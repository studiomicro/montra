<script lang="ts">
	import { applyAmountsHiddenAtLoad } from '#lib/ui/kit/amounts.svelte';
	import SealDemo from '#lib/ui/account-key/SealDemo.svelte';
	import { useI18n } from '#lib/ui/i18n-context';
	import AmountInput from '#lib/ui/kit/AmountInput.svelte';
	import Badge from '#lib/ui/kit/Badge.svelte';
	import Banner from '#lib/ui/kit/Banner.svelte';
	import BarChart from '#lib/ui/kit/BarChart.svelte';
	import Button from '#lib/ui/kit/Button.svelte';
	import CategoryBar from '#lib/ui/kit/CategoryBar.svelte';
	import Chip from '#lib/ui/kit/Chip.svelte';
	import ComparePill from '#lib/ui/kit/ComparePill.svelte';
	import DayHeader from '#lib/ui/kit/DayHeader.svelte';
	import ErrorState from '#lib/ui/kit/ErrorState.svelte';
	import FloatingCard from '#lib/ui/kit/FloatingCard.svelte';
	import GroupList from '#lib/ui/kit/GroupList.svelte';
	import HeroAmount from '#lib/ui/kit/HeroAmount.svelte';
	import Illustration from '#lib/ui/kit/Illustration.svelte';
	import { SCENES, type IllustrationName } from '#lib/ui/kit/illustrations';
	import Mascot from '#lib/ui/kit/Mascot.svelte';
	import { MASCOT_POSES } from '#lib/ui/kit/mascot/poses';
	import IconButton from '#lib/ui/kit/IconButton.svelte';
	import MonthLines from '#lib/ui/kit/MonthLines.svelte';
	import PeriodStepper from '#lib/ui/kit/PeriodStepper.svelte';
	import PickerSheet from '#lib/ui/kit/PickerSheet.svelte';
	import ProgressBar from '#lib/ui/kit/ProgressBar.svelte';
	import SearchField from '#lib/ui/kit/SearchField.svelte';
	import Segmented from '#lib/ui/kit/Segmented.svelte';
	import Skeleton from '#lib/ui/kit/Skeleton.svelte';
	import StatusTag from '#lib/ui/kit/StatusTag.svelte';
	import TextInput from '#lib/ui/kit/TextInput.svelte';
	import ToggleRow from '#lib/ui/kit/ToggleRow.svelte';
	import TransactionRow from '#lib/ui/kit/TransactionRow.svelte';
	import EmptyState from '#lib/ui/shell/EmptyState.svelte';
	import ScreenTitle from '#lib/ui/shell/ScreenTitle.svelte';

	let { data } = $props();
	// Red team N5: the eye's cookie choice masks every figure of this page from the first server render.
	applyAmountsHiddenAtLoad();
	const { tr } = useI18n();
	let period = $state('bulan');
	let amount: number | null = $state(null);
	let picker = $state(false);
	let wallet = $state('bca');
	let toggled = $state(true);
	let search = $state('');
	// FN-40 motion check: the hero counts between two figures; a 12-row list staggers its first 8 rows.
	let heroMinor = $state(126_400_000);
	const staggerRows = Array.from({ length: 12 }, (_, i) => i + 1);
	const scenes = Object.keys(SCENES) as IllustrationName[];
	const days = Array.from({ length: 14 }, (_, i) => ({
		label: `${i + 1} Okt`,
		tick: String(i + 1),
		minor: [8, 12, 0, 25, 6, 18, 9, 30, 4, 11, 0, 16, 22, 7][i]! * 1_000_000
	}));
</script>

<svelte:head><title>UI kit</title></svelte:head>
<ScreenTitle title="UI kit" />
<p><Badge>{tr('Data demo')}</Badge></p>

<section>
	<h2>Button</h2>
	<div class="row">
		<Button size="lg">{tr('Simpan')}</Button>
		<Button variant="secondary">{tr('Batal')}</Button>
		<Button variant="ghost" size="sm">{tr('Lewati')}</Button>
		<Button variant="destructive">{tr('Hapus')}</Button>
		<Button disabled>{tr('Simpan')}</Button>
		<Button size="sm" icon="plus" href="/dev/ui">{tr('Tambah transaksi')}</Button>
		<IconButton icon="bell" label={tr('Notifikasi')} />
	</div>
</section>

<section>
	<h2>Chip · Segmented · Badge · StatusTag</h2>
	<div class="row">
		<Chip selected count={128}>{tr('Semua')}</Chip>
		<Chip count={121}>{tr('Pengeluaran')}</Chip>
		<Chip count={7}>{tr('Pemasukan')}</Chip>
		<Chip icon="grid" popup onclick={() => (picker = true)}>{tr('Kategori')}</Chip>
	</div>
	<PeriodStepper label="Okt '26" prevHref="/dev/ui" nextHref={null} />
	<Segmented
		label={tr('Periode')}
		bind:value={period}
		options={[
			{ value: 'bulan', label: tr('Bulan ini') },
			{ value: 'periode', label: tr('Periode ini') }
		]}
	/>
	<p><StatusTag>{tr('Tercatat')}</StatusTag></p>
</section>

<section>
	<h2>HeroAmount · ComparePill</h2>
	<HeroAmount label={tr('Pengeluaran Oktober')} amountMinor={heroMinor}>
		<ComparePill currentMinor={50_000_000} diffMinor={-8_000_000} monthName="September" />
	</HeroAmount>
	<div class="row">
		<ComparePill currentMinor={50_000_000} diffMinor={12_000_000} monthName="September" />
		<ComparePill currentMinor={50_000_000} diffMinor={1_000_000} monthName="September" />
	</div>
</section>

<section>
	<h2>Motion</h2>
	<div class="row">
		<Button
			variant="secondary"
			onclick={() => (heroMinor = heroMinor === 126_400_000 ? 98_750_050 : 126_400_000)}
			>Count up</Button
		>
	</div>
	<GroupList label="Stagger">
		{#each staggerRows as n (n)}
			<TransactionRow
				title="Baris {n}"
				meta="Lain · Tunai"
				amountMinor={-n * 100_000}
				category="lain"
			/>
		{/each}
	</GroupList>
</section>

<section>
	<h2>Illustration · EmptyState</h2>
	<div class="scenes">
		{#each scenes as scene (scene)}
			<figure data-scene={scene}>
				<Illustration name={scene} size={144} />
				<figcaption>{scene}</figcaption>
			</figure>
		{/each}
	</div>
	<EmptyState illustration="history" text={tr('Transaksi yang kamu catat muncul di sini.')} />
</section>

<section>
	<h2>Mascot (Koko)</h2>
	<div class="scenes">
		{#each MASCOT_POSES as pose (pose)}
			<figure data-pose={pose}>
				<Mascot {pose} size={96} />
				<figcaption>{pose}</figcaption>
			</figure>
		{/each}
	</div>
	<EmptyState text={tr('Belum ada artikel.')} />
</section>

<section>
	<h2>PickerSheet · ToggleRow · SearchField</h2>
	<SearchField name="q" label={tr('Cari judul atau catatan')} bind:value={search} />
	<div class="row">
		<Button variant="secondary" onclick={() => (picker = true)}>{tr('Dompet')}</Button>
	</div>
	<div class="panel">
		<ToggleRow
			icon="star"
			label={tr('Kekayaan bersih')}
			hint={tr('Aset dikurangi utang')}
			badge="Beta"
			bind:checked={toggled}
		/>
	</div>
</section>

<section>
	<h2>GroupList · DayHeader · TransactionRow</h2>
	<DayHeader label={tr('Hari ini')} inMinor={950_000_000} outMinor={4_000_000} />
	<GroupList>
		<TransactionRow
			title="Kopi susu"
			meta="Kopi · GoPay"
			amountMinor={-2_500_000}
			category="kopi"
			status={tr('Tercatat')}
			href="/riwayat"
		/>
		<TransactionRow
			title="Parkir"
			meta="Transportasi · Tunai"
			amountMinor={-500_000}
			category="transportasi"
		/>
		<TransactionRow
			title="Gaji Oktober"
			meta="Gaji · BCA"
			amountMinor={950_000_000}
			category="gaji"
		/>
	</GroupList>
</section>

<section>
	<h2>Inputs</h2>
	<TextInput label={tr('Catatan')} />
	<AmountInput label={tr('Jumlah')} bind:valueMinor={amount} />
	<p class="num">amount_minor = {amount ?? '—'}</p>
</section>

<section>
	<h2>FloatingCard · Banner · Skeleton · ErrorState</h2>
	<FloatingCard><strong>Kopi susu</strong> −Rp 25.000</FloatingCard>
	<Banner
		icon="mail"
		source="Montra"
		when={tr('baru saja')}
		title={tr('Dicatat dari Gmail')}
		text="QRIS · Kopi susu · Rp 25.000"
	/>
	<!-- The sample stands in for a loading branch (the shimmer is allowed only while a load is outstanding). -->
	<div aria-busy="true"><Skeleton rows={20} /></div>
	<ErrorState text={tr('Terjadi kesalahan. Coba lagi.')} onretry={() => {}} />
	<ProgressBar percent={62} label={tr('Anggaran terpakai')} marker={40} />
</section>

<PickerSheet
	bind:open={picker}
	title={tr('Dompet')}
	value={wallet}
	options={[
		{ value: 'bca', label: 'BCA', hint: tr('Bank') },
		{ value: 'tunai', label: 'Tunai', hint: tr('Tunai') }
	]}
	onselect={(v) => (wallet = v)}
	addHref="/dompet?tambah=1"
	addLabel={tr('Tambah dompet')}
/>

<SealDemo publicKey={data.accountPublicKey} />

<section>
	<h2>Charts</h2>
	<BarChart {days} label={tr('Pengeluaran 14 hari terakhir')} today={13} />
	<CategoryBar
		label={tr('Pengeluaran per kategori')}
		parts={[
			{ category: 'makan', minor: 40 },
			{ category: 'kopi', minor: 15 },
			{ category: 'transportasi', minor: 25 },
			{ category: 'tagihan', minor: 20 }
		]}
	/>
	<MonthLines
		label={tr('Bulan ini dibanding bulan lalu')}
		thisMonth={[0, 8, 20, 45, 51, 70]}
		lastMonth={[0, 12, 25, 31, 55, 62, 80, 95]}
	/>
</section>

<style>
	section {
		display: grid;
		gap: 12px;
		padding: 16px 0;
	}
	.panel {
		border-radius: var(--r-group);
		background: var(--panel);
	}
	h2 {
		margin: 0;
		font-size: 19px;
		font-weight: 600;
	}
	.scenes {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(144px, 1fr));
		gap: 12px;
	}
	figure {
		display: grid;
		justify-items: center;
		gap: 4px;
		margin: 0;
		color: var(--muted);
		font-size: 13px;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
</style>
