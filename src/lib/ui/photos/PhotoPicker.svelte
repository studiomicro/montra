<script lang="ts">
	import { onMount } from 'svelte';
	import {
		HEIF_SNIFF_BYTES,
		isHeifBytes,
		PHOTO_ACCEPT,
		PHOTO_JPEG_QUALITY,
		PHOTO_MAX_BYTES,
		PHOTO_UPLOAD_MAX_SIDE
	} from '#lib/shared/photos';
	import { useI18n } from '#lib/ui/i18n-context';
	import Icon from '#lib/ui/Icon.svelte';
	import { baseName, dropDecision, firstFile, pickerMode, type PickerMode } from './picker-mode';
	import { reencodePhoto } from './reencode';

	/**
	 * The one file-picking control for photos (FN-45). Server-rendered (and without JavaScript) it is one plain
	 * file input with the caller's field name, so the form posts exactly as before. After hydration it offers
	 * "Kamera" (an input with capture="environment") and "Galeri" on touch devices, or "Pilih foto" and a drop
	 * zone on fine-pointer-only devices, and both when unsure. Whichever input took the latest pick holds the
	 * field name; the other loses it and is cleared, so the form sends exactly one file.
	 *
	 * Every pick: the first file only (with a notice when there were several), HEIC/HEIF detected from the bytes
	 * (decoded and re-encoded where the browser can, refused with how to fix it where it cannot), then for
	 * `prepare="downscale"` a re-encode when the photo is over PHOTO_MAX_BYTES or PHOTO_UPLOAD_MAX_SIDE.
	 */
	let {
		id,
		name = 'photo',
		label,
		describedby,
		required = false,
		invalid = false,
		prepare = 'none',
		onpick
	}: {
		id: string;
		name?: string;
		/** The field's visible label (also the name of the actions' group). */
		label: string;
		/** The caller's hint (and error) ids. */
		describedby?: string;
		required?: boolean;
		/** The caller shows an error for this field. */
		invalid?: boolean;
		/** 'none': the caller prepares the file itself (Struk); 'downscale': item photos (Owner decision 3). */
		prepare?: 'none' | 'downscale';
		/** The one prepared file, as the form will send it. */
		onpick?: (file: File) => void;
	} = $props();

	const { tr, trf } = useI18n();
	const accept = PHOTO_ACCEPT;

	/** null: server render, before hydration and without JavaScript (the plain input). */
	let mode = $state<PickerMode | null>(null);
	let owner = $state<'gallery' | 'camera'>('gallery');
	let preparing = $state(false);
	let status = $state('');
	let notice = $state('');
	let error = $state('');
	let dragging = $state(false);
	let gallery = $state<HTMLInputElement>();
	let camera = $state<HTMLInputElement>();
	let firstAction = $state<HTMLButtonElement>();

	const enhanced = $derived(mode !== null);
	const withCamera = $derived(mode === 'phone' || mode === 'both');
	const errorId = $derived(`${id}-pick-error`);
	const described = $derived(
		[describedby, error ? errorId : ''].filter(Boolean).join(' ') || undefined
	);
	const markInvalid = $derived(invalid || error !== '' ? 'true' : undefined);

	onMount(() => {
		mode = pickerMode(
			typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : undefined
		);
	});

	/** Empties both inputs and the status lines; the gallery input holds the field name again. */
	export function clear() {
		if (gallery) gallery.value = '';
		if (camera) camera.value = '';
		owner = 'gallery';
		status = '';
		notice = '';
		error = '';
	}

	/** Puts `file` into `input` as its only file; false where the browser does not allow assigning files. */
	function assign(input: HTMLInputElement, file: File): boolean {
		try {
			const transfer = new DataTransfer();
			transfer.items.add(file);
			input.files = transfer.files;
			const held = input.files?.[0];
			return input.files?.length === 1 && held?.name === file.name && held.size === file.size;
		} catch {
			return false;
		}
	}

	/** Disables the form's submit controls while the photo is prepared; returns the undo. */
	function lockSubmit(form: HTMLFormElement | null): () => void {
		if (!form) return () => {};
		const controls = [
			...form.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
				'button[type="submit"], button:not([type]), input[type="submit"]'
			)
		].filter((control) => !control.disabled);
		for (const control of controls) control.disabled = true;
		return () => {
			for (const control of controls) control.disabled = false;
		};
	}

	/** The file to send, or null for HEIF this browser cannot decode (nothing is sent). */
	async function prepared(file: File): Promise<File | null> {
		const head = new Uint8Array(await file.slice(0, HEIF_SNIFF_BYTES).arrayBuffer());
		const options = {
			maxSide: PHOTO_UPLOAD_MAX_SIDE,
			quality: PHOTO_JPEG_QUALITY,
			name: 'foto.jpg'
		};
		if (isHeifBytes(head)) {
			const encoded = await reencodePhoto(file, options);
			return encoded.decoded ? encoded.file : null;
		}
		if (prepare !== 'downscale') return file;
		// A photo within both limits goes as picked (PNG/WebP keep their quality; the server keeps the
		// orientation tag). A file the browser cannot decode also goes as picked: the size check and the
		// server decide.
		const encoded = await reencodePhoto(file, {
			...options,
			when: (width, height) =>
				file.size > PHOTO_MAX_BYTES || Math.max(width, height) > PHOTO_UPLOAD_MAX_SIDE
		});
		return encoded.file;
	}

	async function take(files: FileList | null, source: 'gallery' | 'camera') {
		const input = source === 'gallery' ? gallery : camera;
		const other = source === 'gallery' ? camera : gallery;
		const file = firstFile(files);
		error = '';
		if (!input || !file || !files) return;
		owner = source;
		if (other) other.value = '';
		notice =
			files.length > 1
				? trf('{n} foto dipilih — hanya foto pertama yang dipakai.', { n: files.length })
				: '';
		status = trf('Foto dipilih: {name}', { name: baseName(file.name) });
		preparing = true;
		const unlock = lockSubmit(input.form);
		let ready: File | null;
		try {
			ready = await prepared(file);
		} catch {
			ready = file;
		} finally {
			preparing = false;
			unlock();
		}
		if (!ready) {
			input.value = '';
			status = '';
			notice = '';
			error = tr(
				'Foto HEIC/HEIF belum bisa dipakai. Ambil foto lewat tombol Kamera, atau ubah format kamera ke JPEG (Android: Kamera › Setelan › Format gambar; iPhone: Pengaturan › Kamera › Format › Paling Kompatibel), lalu pilih lagi.'
			);
			return;
		}
		// The input sends the prepared file; where files cannot be assigned it keeps the original.
		const sent =
			(ready === file && files.length === 1) || assign(input, ready)
				? ready
				: (input.files?.[0] ?? file);
		onpick?.(sent);
	}

	function onchange(
		event: Event & { currentTarget: HTMLInputElement },
		source: 'gallery' | 'camera'
	) {
		void take(event.currentTarget.files, source);
	}

	/** The required check fired on a hidden input: the first action takes focus instead. */
	function oninvalid() {
		if (enhanced) setTimeout(() => firstAction?.focus(), 0);
	}

	/** True from a drop until its bytes are read, so a second drop in that moment is ignored too. */
	let dropping = false;

	/**
	 * A dropped photo goes into the gallery input (the Impor pattern), so the form posts it as if picked. Red team
	 * (FN-45) 1–3: a file that is not a photo by its bytes is refused at once; only the first file is put into the
	 * input, so a failed assignment never leaves several files to post; a drop while a photo is still being
	 * prepared is ignored.
	 */
	async function ondrop(event: DragEvent) {
		event.preventDefault();
		dragging = false;
		const files = event.dataTransfer?.files ?? null;
		const first = firstFile(files);
		if (dropping || preparing || !gallery) return;
		dropping = true;
		let head: Uint8Array | null;
		try {
			head = first ? new Uint8Array(await first.slice(0, HEIF_SNIFF_BYTES).arrayBuffer()) : null;
		} catch {
			head = new Uint8Array();
		} finally {
			dropping = false;
		}
		const decision = dropDecision({ preparing, count: files?.length ?? 0, head });
		if (decision === 'busy' || decision === 'empty' || !files || !first) return;
		if (decision === 'not_photo') {
			error = tr('Foto harus berupa JPEG, PNG atau WebP.');
			return;
		}
		if (!assign(gallery, first)) {
			gallery.value = '';
			error = tr('Foto yang ditarik tidak bisa dipakai di peramban ini. Pilih lewat tombol.');
			return;
		}
		void take(files, 'gallery');
	}
</script>

<div class="photo-picker" class:enhanced>
	<label for={id} class="label">{label}</label>
	<input
		bind:this={gallery}
		{id}
		name={owner === 'gallery' ? name : undefined}
		type="file"
		{accept}
		required={required && owner === 'gallery'}
		class:offscreen={enhanced}
		tabindex={enhanced ? -1 : undefined}
		aria-invalid={markInvalid}
		aria-describedby={described}
		onchange={(event) => onchange(event, 'gallery')}
		{oninvalid}
	/>
	{#if withCamera}
		<input
			bind:this={camera}
			name={owner === 'camera' ? name : undefined}
			type="file"
			{accept}
			capture="environment"
			required={required && owner === 'camera'}
			class="offscreen"
			tabindex="-1"
			aria-hidden="true"
			onchange={(event) => onchange(event, 'camera')}
			{oninvalid}
		/>
		<fieldset class="actions" disabled={preparing}>
			<legend class="offscreen">{label}</legend>
			<button
				bind:this={firstAction}
				type="button"
				class="action"
				aria-label={tr('Ambil foto dengan kamera')}
				aria-describedby={described}
				onclick={() => camera?.click()}
			>
				<Icon name="camera" size={20} />
				<span>{tr('Kamera')}</span>
			</button>
			<button
				type="button"
				class="action"
				aria-label={tr('Pilih foto dari galeri')}
				aria-describedby={described}
				onclick={() => gallery?.click()}
			>
				<Icon name="image" size={20} />
				<span>{tr('Galeri')}</span>
			</button>
		</fieldset>
	{:else if mode === 'desktop'}
		<fieldset
			class="drop"
			class:dragging
			disabled={preparing}
			ondragover={(event) => {
				event.preventDefault();
				dragging = true;
			}}
			ondragleave={() => (dragging = false)}
			{ondrop}
		>
			<legend class="offscreen">{label}</legend>
			<button
				bind:this={firstAction}
				type="button"
				class="action"
				aria-describedby={described}
				onclick={() => gallery?.click()}
			>
				<Icon name="image" size={20} />
				<span>{tr('Pilih foto')}</span>
			</button>
			<span class="drop-text">{tr('atau tarik foto ke sini')}</span>
		</fieldset>
	{/if}
	{#if enhanced}
		<p class="meta" role="status">
			{preparing ? tr('Menyiapkan foto…') : [status, notice].filter(Boolean).join(' ')}
		</p>
	{/if}
	{#if error}<p id={errorId} class="error" role="alert">{error}</p>{/if}
</div>

<style>
	.photo-picker {
		display: grid;
		gap: 6px;
	}
	.label {
		font-size: 15px;
		font-weight: 600;
	}
	input[type='file'] {
		min-height: 48px;
		padding: 10px 0;
		color: var(--ink);
		font: inherit;
		font-size: 15px;
	}
	input[type='file'][aria-invalid='true'] {
		color: var(--money-up);
	}
	/* Hydrated: the native inputs stay in the page for form posts and the required check; the actions are their face. */
	.offscreen {
		position: absolute;
		width: 1px;
		height: 1px;
		min-height: 0;
		padding: 0;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}
	fieldset {
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}
	.actions {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}
	/* The look of Button `secondary` (§ 3a: a panel pill), at least 48 px tall. */
	.action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		min-width: 44px;
		min-height: 48px;
		padding: 0 20px;
		border: 0;
		border-radius: var(--r-pill);
		background: var(--panel);
		color: var(--ink);
		font: inherit;
		font-size: 15px;
		font-weight: 600;
		white-space: nowrap;
		cursor: pointer;
		transition:
			transform 0.15s var(--ease),
			background 0.2s var(--ease),
			opacity 0.2s var(--ease);
	}
	.action:hover:not(:disabled) {
		background: var(--panel-2);
	}
	.action:active:not(:disabled) {
		transform: scale(var(--press-scale));
	}
	.action:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.drop {
		display: grid;
		justify-items: center;
		gap: 8px;
		padding: 20px 16px;
		border: 2px dashed var(--faint);
		border-radius: var(--r-group);
		background: var(--bg);
		text-align: center;
	}
	.drop.dragging {
		border-color: var(--ink);
	}
	.drop-text {
		font-size: 14px;
		color: var(--muted);
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
