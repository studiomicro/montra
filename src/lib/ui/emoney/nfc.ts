import { isReadOnly, type CardTech } from '#lib/shared/emoney/commands';
import type { CardInfo } from '#lib/shared/emoney/diagnose';
import { normaliseHex } from '#lib/shared/emoney/hex';

/**
 * FN-58: the page side of the Android app's read-only NFC bridge (native/android-app, MontraNfcPlugin.java). The
 * Capacitor shell injects `window.Capacitor`; in a browser it is absent and `nfcBridge()` is null, so every page that
 * reads cards says the reader needs the Android app instead.
 */

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

/** Sends one command, refused here first when it is not a read (the bridge refuses it again natively). */
export async function send(bridge: NfcBridge, tech: CardTech, hex: string): Promise<string> {
	const clean = normaliseHex(hex);
	if (!clean || !isReadOnly(tech, clean)) throw new Error('not_read_only');
	return (await bridge.transceive({ tech, hex: clean })).hex;
}
