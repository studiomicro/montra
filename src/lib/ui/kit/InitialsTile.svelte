<script lang="ts">
	import { initials, initialsColour } from './initials';

	// Drawn from the name only: no image, no logo (FN-26 owner decision 2).
	/** `round`: an avatar (a space or the account) instead of a service tile. */
	let {
		name,
		size = 40,
		round = false
	}: { name: string; size?: 36 | 40 | 44; round?: boolean } = $props();
	const text = $derived(initials(name));
	const colour = $derived(initialsColour(name));
</script>

<span class="tile s{size} c-{colour}" class:round aria-hidden="true">{text}</span>

<style>
	.tile {
		--c: var(--cat-lain);
		display: grid;
		flex: none;
		place-items: center;
		border-radius: var(--r-s);
		background: color-mix(in srgb, var(--c) 16%, var(--bg));
		color: var(--ink);
		font-weight: 700;
		letter-spacing: -0.01em;
		line-height: 1;
	}
	.round {
		border-radius: var(--r-pill);
	}
	.s44 {
		width: 44px;
		height: 44px;
		font-size: 16px;
	}
	.s40 {
		width: 40px;
		height: 40px;
		font-size: 15px;
	}
	.s36 {
		width: 36px;
		height: 36px;
		font-size: 14px;
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
</style>
