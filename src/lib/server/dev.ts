/** /dev/ui and /api/v1/dev/* exist only in `vite dev` or when the local-only var DEV_ROUTES is exactly "1". */
export function devRoutesEnabled(
	env: { DEV_ROUTES?: string } | undefined,
	isDev: boolean
): boolean {
	return isDev || env?.DEV_ROUTES === '1';
}
