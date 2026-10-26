/**
 * A D1 binding that meters what a handler costs: `trips` counts round trips to D1 (each statement run and each
 * `batch` is one request from the Worker), `statements` counts statements prepared (a batch counts all of its
 * statements). Every round trip waits `latencyMs` first, standing in for the network hop of a deployed Worker, so
 * queries awaited one after another add up while queries in one `Promise.all` overlap; `depth` counts the
 * longest chain of such sequential round trips.
 */
export function meteredD1(d1: D1Database, latencyMs: number) {
	const counts = { trips: 0, statements: 0, depth: 0, done: 0 };
	const inner = new WeakMap<object, D1PreparedStatement>();
	const wait = () => new Promise((resolve) => setTimeout(resolve, latencyMs));
	const trip = async <T>(run: () => Promise<T>): Promise<T> => {
		counts.trips++;
		// This trip waited for every trip that finished before it started: one level deeper than the deepest.
		const depth = counts.done + 1;
		counts.depth = Math.max(counts.depth, depth);
		await wait();
		try {
			return await run();
		} finally {
			counts.done = Math.max(counts.done, depth);
		}
	};
	const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
		const wrapped = {
			bind: (...values: unknown[]) => wrap(stmt.bind(...values)),
			first: (column?: string) =>
				trip(() => (column === undefined ? stmt.first() : stmt.first(column))),
			all: () => trip(() => stmt.all()),
			run: () => trip(() => stmt.run()),
			raw: (options?: { columnNames?: boolean }) =>
				trip(() => (options?.columnNames ? stmt.raw({ columnNames: true }) : stmt.raw()))
		} as unknown as D1PreparedStatement;
		inner.set(wrapped, stmt);
		return wrapped;
	};
	const metered = new Proxy(d1, {
		get(target, prop) {
			if (prop === 'prepare')
				return (query: string) => {
					counts.statements++;
					return wrap(target.prepare(query));
				};
			if (prop === 'batch')
				return (stmts: D1PreparedStatement[]) =>
					trip(() => target.batch(stmts.map((s) => inner.get(s) ?? s)));
			const value = Reflect.get(target, prop) as unknown;
			return typeof value === 'function' ? value.bind(target) : value;
		}
	});
	return {
		d1: metered,
		/**
		 * Runs `fn` from zeroed counters. `depth`: the longest chain of round trips each started after the one
		 * before it finished (trips in one `Promise.all` share a level); `ms`: wall time.
		 */
		async measure(fn: () => Promise<unknown>) {
			counts.trips = 0;
			counts.statements = 0;
			counts.depth = 0;
			counts.done = 0;
			const started = performance.now();
			await fn();
			const ms = performance.now() - started;
			return {
				trips: counts.trips,
				statements: counts.statements,
				depth: counts.depth,
				ms: Math.round(ms)
			};
		}
	};
}
