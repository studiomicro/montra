/**
 * D1's per-invocation query cap on Workers Paid (1,000; 50 on Free:
 * https://developers.cloudflare.com/d1/platform/limits/, checked 2026-10-08). The jobs Worker's budgets
 * (recurring checks, net-worth snapshots) are shares of it, counted with `countStatements`.
 */
export const D1_STATEMENTS_PER_INVOCATION = 1_000;

/**
 * A D1 binding that counts the statements prepared through it: every query and every statement of a
 * `db.batch` is prepared once (Drizzle prepares fresh for each run), so this is what one Worker invocation
 * spent against D1's per-invocation query cap, counted conservatively (a batch counts as all its statements).
 */
export function countStatements(d1: D1Database): { d1: D1Database; statements: () => number } {
	let statements = 0;
	const counted = new Proxy(d1, {
		get(target, prop) {
			if (prop === 'prepare')
				return (query: string) => {
					statements++;
					return target.prepare(query);
				};
			const value = Reflect.get(target, prop) as unknown;
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
	return { d1: counted, statements: () => statements };
}
