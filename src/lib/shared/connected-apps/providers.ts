import { msg } from '../i18n.ts';

/**
 * Connected apps (FN-29): the five apps a space may connect once a provider app exists. Names are the
 * providers' own product names (never translated, no logos). This pass none can be connected: there is no
 * OAuth client or app for any of them, so every row reads "Belum dikonfigurasi".
 */
export const CONNECTED_APP_PROVIDERS = [
	'gmail',
	'google_sheets',
	'google_calendar',
	'notion',
	'slack'
] as const;
export type ConnectedAppProvider = (typeof CONNECTED_APP_PROVIDERS)[number];

/** A live connection row is `connected`; its content-free tombstone is `disconnected`. */
export const CONNECTED_APP_STATUSES = ['connected', 'disconnected'] as const;

export function isConnectedAppProvider(value: string): value is ConnectedAppProvider {
	return (CONNECTED_APP_PROVIDERS as readonly string[]).includes(value);
}

/** What each app would read or write once it can be connected (future tense: nothing is claimed as working). */
export const CONNECTED_APP_INFO: Readonly<
	Record<ConnectedAppProvider, { name: string; description: string }>
> = {
	gmail: {
		name: 'Gmail',
		description: msg(
			'Nantinya membaca e-mail bukti pembayaran (hanya baca) dan menjadikannya draf di Kotak masuk.'
		)
	},
	google_sheets: {
		name: 'Google Sheets',
		description: msg('Nantinya menambahkan transaksi ke spreadsheet yang kamu pilih.')
	},
	google_calendar: {
		name: 'Google Calendar',
		description: msg('Nantinya menambahkan pengingat tagihan ke kalender yang kamu pilih.')
	},
	notion: {
		name: 'Notion',
		description: msg('Nantinya menulis ringkasan bulanan ke halaman Notion yang kamu pilih.')
	},
	slack: {
		name: 'Slack',
		description: msg(
			'Nantinya mengubah pesan seperti "kopi 25rb" di kanal yang kamu pilih menjadi draf di Kotak masuk.'
		)
	}
};

/** A stored connection as the page may see it: never its token, nonce, key id or scopes. */
export interface ConnectionView {
	id: string;
	provider: ConnectedAppProvider;
	externalLabel: string | null;
	isDemo: boolean;
	updatedAt: number;
	/** The viewer made this connection or owns the space (red team L3): only then is "Putuskan" offered. */
	canDisconnect: boolean;
}

export interface AppRow {
	provider: ConnectedAppProvider;
	/**
	 * `connected` only for a live row while the server holds a well-formed encryption key; otherwise
	 * `not_configured` ("Belum dikonfigurasi"), whatever is stored.
	 */
	state: 'connected' | 'not_configured';
	/** The live row, if any: it can always be disconnected (deleting a token never needs the key). */
	connection: ConnectionView | null;
}

/** One row per provider, in CONNECTED_APP_PROVIDERS order, from the space's live connections. */
export function appRows(connections: readonly ConnectionView[], configured: boolean): AppRow[] {
	return CONNECTED_APP_PROVIDERS.map((provider) => {
		const connection = connections.find((c) => c.provider === provider) ?? null;
		return {
			provider,
			state: configured && connection ? 'connected' : 'not_configured',
			connection
		};
	});
}
