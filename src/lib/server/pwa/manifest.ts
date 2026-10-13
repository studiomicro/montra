import type { Plan } from '#lib/shared/billing/plans';
import { hasProLook, PRO_MANIFEST_ICONS } from '#lib/shared/pro-look';
import GRATIS_MANIFEST from './manifest.webmanifest?raw';

/**
 * The Web App Manifest (FN-13, FN-13b), served by src/routes/manifest.webmanifest/+server.ts instead of as a
 * static file so its icons can follow the account's plan (FN-46 Part 3). A browser reads it when the app is
 * installed; an already-installed icon never changes. Signed out and on Gratis the body is exactly this file's
 * bytes; the Pro look swaps the two "any" icons for the crowned Koko and keeps everything else.
 */
export function manifestBody(plan: Plan): string {
	if (!hasProLook(plan)) return GRATIS_MANIFEST;
	const manifest = JSON.parse(GRATIS_MANIFEST) as { icons: { src: string }[] };
	manifest.icons = manifest.icons.map((icon) => ({
		...icon,
		src: PRO_MANIFEST_ICONS[icon.src] ?? icon.src
	}));
	return `${JSON.stringify(manifest, null, '\t')}\n`;
}

export const MANIFEST_CONTENT_TYPE = 'application/manifest+json';
