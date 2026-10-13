<script lang="ts">
	import { PHOTO_MAX_BYTES } from '#lib/shared/photos';
	import { useI18n } from '#lib/ui/i18n-context';
	import PhotoPicker from './PhotoPicker.svelte';

	/**
	 * The photo field of an item form (FN-27 belongings, FN-28 collectibles): the shared picker (FN-45: camera or
	 * gallery, a large photo re-encoded on the device first), the size named before sending (the server checks
	 * everything again), and "Hapus foto" when the item has one.
	 */
	let {
		id,
		hasPhoto,
		serverError
	}: {
		id: string;
		/** The item already has a photo: the input replaces it, and it can be removed. */
		hasPhoto: boolean;
		/** The server's refusal, already translated. */
		serverError?: string;
	} = $props();

	const { tr } = useI18n();
	let picker = $state<PhotoPicker>();
	let localError = $state('');
	const photoError = $derived(localError || serverError);

	/** The 8 MB check runs on the file that is actually sent (after the picker prepared it). */
	function onpick(file: File) {
		localError = '';
		if (file.size > PHOTO_MAX_BYTES) {
			picker?.clear();
			localError = tr('Foto terlalu besar. Paling besar 8 MB.');
		}
	}
</script>

<div class="field">
	<PhotoPicker
		bind:this={picker}
		{id}
		name="photo"
		label={hasPhoto ? tr('Ganti foto') : tr('Foto (opsional)')}
		prepare="downscale"
		invalid={Boolean(photoError)}
		describedby="{id}-hint{photoError ? ` ${id}-error` : ''}"
		{onpick}
	/>
	<p id="{id}-hint" class="meta">
		{tr('JPEG, PNG atau WebP, paling besar 8 MB. Lokasi dan data kamera dihapus sebelum disimpan.')}
	</p>
	{#if photoError}<p id="{id}-error" class="error">{photoError}</p>{/if}
	{#if hasPhoto}
		<label class="check">
			<input type="checkbox" name="removePhoto" />
			<span>{tr('Hapus foto')}</span>
		</label>
	{/if}
</div>

<style>
	.field {
		display: grid;
		gap: 6px;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 44px;
		font-size: 15px;
		cursor: pointer;
	}
	.check input {
		width: 20px;
		height: 20px;
		margin: 0;
		accent-color: var(--ink);
	}
	.meta {
		margin: 0;
		font-size: 14px;
		color: var(--muted);
	}
	.error {
		margin: 0;
		font-size: 13px;
		color: var(--money-up);
	}
</style>
