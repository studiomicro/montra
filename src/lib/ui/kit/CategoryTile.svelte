<script lang="ts">
	import { CATEGORIES, type CategoryKey } from './category';
	let { category, size = 40 }: { category: CategoryKey; size?: 36 | 40 } = $props();
</script>

<span class="tile emoji s{size} c-{category}" aria-hidden="true">{CATEGORIES[category].emoji}</span>

<style>
	.tile {
		--c: var(--cat-lain);
		display: grid;
		flex: none;
		place-items: center;
		border-radius: var(--r-pill);
		background: color-mix(in srgb, var(--c) 16%, var(--bg));
	}
	.s40 {
		width: 40px;
		height: 40px;
		font-size: 20px;
	}
	.s36 {
		width: 36px;
		height: 36px;
		font-size: 18px;
	}
	.c-kopi {
		--c: var(--cat-kopi);
	}
	.c-makan {
		--c: var(--cat-makan);
	}
	.c-belanja-harian {
		--c: var(--cat-belanja-harian);
	}
	.c-belanja {
		--c: var(--cat-belanja);
	}
	.c-transportasi {
		--c: var(--cat-transportasi);
	}
	.c-ojek-online {
		--c: var(--cat-ojek-online);
	}
	.c-pesan-antar-makanan {
		--c: var(--cat-pesan-antar-makanan);
	}
	.c-tagihan {
		--c: var(--cat-tagihan);
	}
	.c-hiburan {
		--c: var(--cat-hiburan);
	}
	.c-kesehatan {
		--c: var(--cat-kesehatan);
	}
	.c-pendidikan {
		--c: var(--cat-pendidikan);
	}
	.c-tempat-tinggal {
		--c: var(--cat-tempat-tinggal);
	}
	.c-biaya-bank {
		--c: var(--cat-biaya-bank);
	}
	.c-pajak {
		--c: var(--cat-pajak);
	}
	.c-tarik-tunai {
		--c: var(--cat-tarik-tunai);
	}
	.c-kartu-kredit {
		--c: var(--cat-kartu-kredit);
	}
	.c-transfer {
		--c: var(--cat-transfer);
	}
	.c-bunga {
		--c: var(--cat-bunga);
	}
	.c-gaji {
		--c: var(--cat-gaji);
	}
	.c-bonus {
		--c: var(--cat-bonus);
	}
	.c-freelance {
		--c: var(--cat-freelance);
	}
	.c-hadiah {
		--c: var(--cat-hadiah);
	}
	.c-lain {
		--c: var(--cat-lain);
	}
</style>
