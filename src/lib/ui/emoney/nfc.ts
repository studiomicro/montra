import { isReadOnly, normaliseHex, type CardTech } from '#lib/shared/emoney/commands';

/**
 * FN-58: the page side of the Android app's read-only NFC bridge (native/android-app, MontraNfcPlugin.java). The
 * Capacitor shell injects `window.Capacitor`; in a browser it is absent and `nfcBridge()` is null, so every page that
 * reads cards says the reader needs the Android app instead.
 */

/** What the bridge reports when a card is tapped. Never the card's UID, only its length. */
export type CardInfo = {
	techs: string[];
	uidLength: number;
	atqa?: string;
	sak?: number;
	historicalBytes?: string;
	hiLayerResponse?: string;
	systemCode?: string;
	manufacturer?: string;
	error?: string;
};

type Listener = { remove(): Promise<void> };

export type NfcBridge = {
	isAvailable(): Promise<{ available: boolean; enabled: boolean }>;
	startReading(): Promise<void>;
	stopReading(): Promise<void>;
	transceive(options: { tech: CardTech; hex: string }): Promise<{ hex: string }>;
	addListener(event: 'card', callback: (info: CardInfo) => void): Promise<Listener>;
};

type CapacitorGlobal = {
	isPluginAvailable?: (name: string) => boolean;
	Plugins?: Record<string, unknown>;
};

export function nfcBridge(): NfcBridge | null {
	const cap = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
	if (!cap?.isPluginAvailable?.('MontraNfc')) return null;
	return (cap.Plugins?.MontraNfc as NfcBridge | undefined) ?? null;
}

/** The tech a tapped card speaks, or null when it is neither an ISO-DEP nor a FeliCa card. */
export function cardTech(info: CardInfo): CardTech | null {
	if (info.techs.includes('IsoDep')) return 'isodep';
	if (info.techs.includes('NfcF')) return 'nfcf';
	return null;
}

/** Sends one command, refused here first when it is not a read (the bridge refuses it again natively). */
export async function send(bridge: NfcBridge, tech: CardTech, hex: string): Promise<string> {
	const clean = normaliseHex(hex);
	if (!clean || !isReadOnly(tech, clean)) throw new Error('not_read_only');
	return (await bridge.transceive({ tech, hex: clean })).hex;
}
