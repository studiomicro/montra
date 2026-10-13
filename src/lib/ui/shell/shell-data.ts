import type { Plan } from '#lib/shared/billing/plans';

/** What the (app) layout passes to the shell: display only, never an authorization input. */
export interface ShellData {
	space: { name: string; kind: 'personal' | 'shared'; role: 'owner' | 'member' } | null;
	account: { name: string; email: string } | null;
	/**
	 * FN-46: the plan in force (hooks.server.ts `locals.plan`, Gratis when signed out), for the Pro look only —
	 * the badge, crowned Koko and Beranda's hero frame. Every plan-gated action still checks on the server.
	 */
	plan: Plan;
}
