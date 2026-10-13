import { getContext, setContext } from 'svelte';

/**
 * FN-46: whether this page shows the Pro look (crowned Koko), set once by the (app) layout from `shell.plan`
 * (hooks.server.ts `locals.plan`), so every Koko below it — EmptyState, the loading walk, success moments — follows
 * the one server-derived plan without a lookup of its own. Outside the (app) layout (sign-in, the public site)
 * there is no context and Koko wears no crown.
 */
const KEY = Symbol('pro-look');

export function setProLook(get: () => boolean): void {
	setContext(KEY, get);
}

/** The layout's getter, or undefined outside it. Call during component initialisation. */
export function proLookGetter(): (() => boolean) | undefined {
	return getContext<(() => boolean) | undefined>(KEY);
}
