/** A LockManager with exclusive locks and `ifAvailable`, as navigator.locks behaves within one origin. */
export function fakeLocks() {
	const held = new Set<string>();
	return {
		request: async (
			name: string,
			_opts: { ifAvailable: boolean },
			cb: (lock: { name: string } | null) => Promise<boolean>
		) => {
			if (held.has(name)) return cb(null);
			held.add(name);
			try {
				return await cb({ name });
			} finally {
				held.delete(name);
			}
		}
	} as unknown as Pick<LockManager, 'request'>;
}
