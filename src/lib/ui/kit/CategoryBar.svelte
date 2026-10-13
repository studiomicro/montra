<script lang="ts">
	import type { CategoryKey } from './category';
	import { stackSegments } from './chart-scale';

	let { parts, label }: { parts: { category: CategoryKey; minor: number }[]; label: string } =
		$props();
	const segments = $derived(
		stackSegments(
			parts.map((p) => p.minor),
			100
		)
	);
</script>

<svg class="bar" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label={label}>
	{#each segments as s, i (i)}
		<rect x={s.x} y="0" width={s.width} height="10" class="c-{parts[i]?.category}" />
	{/each}
</svg>

<style>
	.bar {
		display: block;
		width: 100%;
		height: 12px;
		border-radius: var(--r-pill);
		background: var(--chart-track);
	}
	/* FN-51: segments fade in 30 ms apart, the first 8 only (no width animation). */
	@media (prefers-reduced-motion: no-preference) {
		rect:nth-child(-n + 8) {
			animation: seg-in var(--duration-base) var(--ease) backwards;
		}
		rect:nth-child(2) {
			animation-delay: 30ms;
		}
		rect:nth-child(3) {
			animation-delay: 60ms;
		}
		rect:nth-child(4) {
			animation-delay: 90ms;
		}
		rect:nth-child(5) {
			animation-delay: 120ms;
		}
		rect:nth-child(6) {
			animation-delay: 150ms;
		}
		rect:nth-child(7) {
			animation-delay: 180ms;
		}
		rect:nth-child(8) {
			animation-delay: 210ms;
		}
	}
	@keyframes seg-in {
		from {
			opacity: 0;
		}
	}
	.c-kopi {
		fill: var(--cat-kopi);
	}
	.c-makan {
		fill: var(--cat-makan);
	}
	.c-belanja-harian {
		fill: var(--cat-belanja-harian);
	}
	.c-belanja {
		fill: var(--cat-belanja);
	}
	.c-transportasi {
		fill: var(--cat-transportasi);
	}
	.c-ojek-online {
		fill: var(--cat-ojek-online);
	}
	.c-pesan-antar-makanan {
		fill: var(--cat-pesan-antar-makanan);
	}
	.c-tagihan {
		fill: var(--cat-tagihan);
	}
	.c-hiburan {
		fill: var(--cat-hiburan);
	}
	.c-kesehatan {
		fill: var(--cat-kesehatan);
	}
	.c-pendidikan {
		fill: var(--cat-pendidikan);
	}
	.c-tempat-tinggal {
		fill: var(--cat-tempat-tinggal);
	}
	.c-biaya-bank {
		fill: var(--cat-biaya-bank);
	}
	.c-pajak {
		fill: var(--cat-pajak);
	}
	.c-tarik-tunai {
		fill: var(--cat-tarik-tunai);
	}
	.c-kartu-kredit {
		fill: var(--cat-kartu-kredit);
	}
	.c-transfer {
		fill: var(--cat-transfer);
	}
	.c-bunga {
		fill: var(--cat-bunga);
	}
	.c-gaji {
		fill: var(--cat-gaji);
	}
	.c-bonus {
		fill: var(--cat-bonus);
	}
	.c-freelance {
		fill: var(--cat-freelance);
	}
	.c-hadiah {
		fill: var(--cat-hadiah);
	}
	.c-lain {
		fill: var(--cat-lain);
	}
</style>
