/**
 * A photo as it leaves the device (FN-15 receipts, FN-45 item photos): decoded with its EXIF orientation applied,
 * drawn on a canvas whose longest side is at most `maxSide`, and re-encoded as JPEG. That bounds the upload,
 * bakes in the orientation and drops every metadata block (location included) before a byte is sent.
 *
 * - `decoded`: false when this browser cannot decode the file (HEIC on Chrome, a broken file); the original is
 *   returned and the caller decides (the server's sanitiser, FN-27, stays the backstop).
 * - `when(width, height)`: re-encode only when it answers true; otherwise the original is returned as picked
 *   (`decoded` true).
 * - `preview`: a small JPEG `data:` URL of at most `previewSide` (the CSP's img-src allows `self` and `data:`
 *   only), or null.
 */
export async function reencodePhoto(
	file: File,
	options: {
		maxSide: number;
		quality: number;
		/** Name of the re-encoded file (never the picked file's own name or path). */
		name: string;
		previewSide?: number;
		when?: (width: number, height: number) => boolean;
	}
): Promise<{ file: File; preview: string | null; decoded: boolean }> {
	if (typeof createImageBitmap !== 'function') return { file, preview: null, decoded: false };
	let bitmap: ImageBitmap;
	try {
		bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
	} catch {
		return { file, preview: null, decoded: false };
	}
	try {
		if (options.when && !options.when(bitmap.width, bitmap.height))
			return { file, preview: null, decoded: true };
		const draw = (maxSide: number) => {
			const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
			const canvas = document.createElement('canvas');
			canvas.width = Math.max(1, Math.round(bitmap.width * scale));
			canvas.height = Math.max(1, Math.round(bitmap.height * scale));
			const context = canvas.getContext('2d');
			if (!context) return null;
			// JPEG has no transparency: a transparent PNG or WebP gets white paper, not black.
			context.fillStyle = '#fff';
			context.fillRect(0, 0, canvas.width, canvas.height);
			context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
			return canvas;
		};
		const full = draw(options.maxSide);
		if (!full) return { file, preview: null, decoded: true };
		const blob = await new Promise<Blob | null>((resolve) =>
			full.toBlob(resolve, 'image/jpeg', options.quality)
		);
		const preview = options.previewSide
			? (draw(options.previewSide)?.toDataURL('image/jpeg', 0.7) ?? null)
			: null;
		if (!blob) return { file, preview, decoded: true };
		return {
			file: new File([blob], options.name, { type: 'image/jpeg' }),
			preview,
			decoded: true
		};
	} finally {
		bitmap.close();
	}
}
