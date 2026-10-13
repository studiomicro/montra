import { msg } from './i18n.ts';

/**
 * The modules a user can hide from their own navigation (FN-12). Per user, never per space: hiding one is a
 * display preference and never changes what a route shows or what any total adds up to. Fixed order (the
 * settings rows follow it); adding a module needs a migration (the `feature_flags.module` check constraint).
 */
export const MODULES = ['kekayaan', 'langganan', 'barang', 'koleksi', 'ruang', 'patungan'] as const;
export type Module = (typeof MODULES)[number];

export const MODULE_LABELS: Record<Module, string> = {
	kekayaan: msg('Kekayaan'),
	langganan: msg('Langganan'),
	barang: msg('Barang'),
	koleksi: msg('Koleksi'),
	ruang: msg('Ruang bersama'),
	patungan: msg('Patungan')
};

export function isModule(value: string): value is Module {
	return (MODULES as readonly string[]).includes(value);
}

/** Every module enabled unless a stored row says otherwise (default-on, owner decision B). */
export function flagsFrom(
	rows: readonly { module: string; enabled: boolean }[]
): Record<Module, boolean> {
	const flags = Object.fromEntries(MODULES.map((m) => [m, true])) as Record<Module, boolean>;
	for (const row of rows) if (isModule(row.module)) flags[row.module] = row.enabled;
	return flags;
}

export function hiddenModules(flags: Record<Module, boolean>): Module[] {
	return MODULES.filter((m) => !flags[m]);
}
