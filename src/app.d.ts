import type { Locale } from '#lib/shared/i18n';
import type { ThemePref } from '#lib/server/prefs';
import type { Db } from '#lib/server/db';
import type { SessionUser } from '#lib/server/auth/session';
import type { CurrentSpace } from '#lib/server/spaces/access';
import type { Plan } from '#lib/shared/billing/plans';

declare global {
	namespace App {
		// Cloudflare bindings come from #lib/server/env (Kit 3 sets no Platform).
		interface Locals {
			locale: Locale;
			/** The theme cookie, already narrowed to what the account's plan allows (FN-46). */
			theme: ThemePref;
			/**
			 * The plan in force for `user` (FN-46 Pro look; billing/gate.ts planOf in hooks.server.ts), Gratis when
			 * signed out. Display only: a gated action still asks planOf/planStateOf itself.
			 */
			plan: Plan;
			/** Drizzle over the DB binding (hooks.server.ts, through getEnv()). */
			db: Db;
			/** The signed-in user, or null. Every account query uses this id, never a client-supplied one. */
			user: SessionUser | null;
			/** The session cookie's token while signed in (sign-out revokes exactly this session). */
			sessionToken: string | null;
			/**
			 * The current space of a signed-in (app) request (FN-03: `space` cookie re-validated, else the personal
			 * space); null elsewhere. A default only: an id from the request goes through requireSpaceAccess.
			 */
			space: CurrentSpace | null;
			/** A deployed HTTPS host: `__Host-` cookie name and the Secure flag. */
			secure: boolean;
			/**
			 * Set by sign-out and account deletion: the response then carries `Clear-Site-Data` so this browser
			 * drops its caches, service worker and push subscription (FN-13, shared devices).
			 */
			clearSiteData?: boolean;
		}
	}
	/** Optional var: support address for public account-deletion requests (unset → "Belum dikonfigurasi"). */
	interface Env {
		SUPPORT_EMAIL?: string;
		/** Optional var: public URL of this instance's source code (AGPL-3.0 section 13); unset → "Belum dikonfigurasi". */
		SOURCE_URL?: string;
		/** Optional secrets: Web Push VAPID key set (FN-13); unset → push shows "Belum dikonfigurasi". */
		VAPID_PUBLIC_KEY?: string;
		VAPID_PRIVATE_KEY?: string;
		VAPID_SUBJECT?: string;
		/**
		 * Optional secrets (FN-29): 32 random bytes, base64url, sealing connected-app tokens at rest; the previous
		 * key only during a rotation. Unset or malformed → every connected app shows "Belum dikonfigurasi".
		 */
		CONNECTED_APPS_ENCRYPTION_KEY?: string;
		CONNECTED_APPS_ENCRYPTION_KEY_PREVIOUS?: string;
		/**
		 * FN-30: "1" shows the mock ("mode uji") upgrade and checkout, local and owner-flagged demo/staging only.
		 * Unset → the upgrade UI is absent and the webhook refuses every delivery. Never set in production.
		 */
		BILLING_MOCK_ENABLED?: string;
		/** FN-30 secret: HMAC key of the mock provider's webhook signatures (≥ 32 characters). Never in production. */
		MOCK_PAYMENT_WEBHOOK_SECRET?: string;
		/**
		 * Optional secrets (FN-41): 32 random bytes, base64url, sealing users' own AI keys at rest; the previous key
		 * only during a rotation. Unset or malformed → /pengaturan/integrasi stores nothing ("Belum dikonfigurasi").
		 */
		AI_KEYS_ENCRYPTION_KEY?: string;
		AI_KEYS_ENCRYPTION_KEY_PREVIOUS?: string;
		/** Optional (FN-41): the app's Cloudflare AI Gateway; either unset → "Tes koneksi" is "Belum dikonfigurasi". */
		AI_GATEWAY_ACCOUNT_ID?: string;
		AI_GATEWAY_ID?: string;
		/**
		 * Optional var (FN-19): the domain of the e-mail forwarding addresses (Cloudflare Email Routing → the
		 * montra-inbound Worker). Unset or malformed → /pengaturan/aplikasi/email is "Belum dikonfigurasi" and
		 * Tambah › Otomatis says why.
		 */
		INBOUND_EMAIL_DOMAIN?: string;
		/**
		 * Optional (FN-19 Gmail): Montra's own Google OAuth client (secrets) and the one redirect origin of this
		 * environment (plain var; the callback is origin + /pengaturan/aplikasi/gmail/callback). Any of them, or
		 * CONNECTED_APPS_ENCRYPTION_KEY, unset or malformed → /pengaturan/aplikasi/gmail is "Belum dikonfigurasi"
		 * with the reason. GOOGLE_OAUTH_TESTING=0 hides the 7-day Testing notice (only once Google published the app).
		 */
		GOOGLE_OAUTH_CLIENT_ID?: string;
		GOOGLE_OAUTH_CLIENT_SECRET?: string;
		GOOGLE_OAUTH_REDIRECT_ORIGIN?: string;
		GOOGLE_OAUTH_TESTING?: string;
		/**
		 * Optional secret (FN-41, FN-30 hardening): comma-separated account ids (`users.id`) admitted to
		 * /pengaturan/integrasi/admin; unset → 404 for everyone. Never an e-mail: sign-up does not verify one.
		 */
		ADMIN_ACCOUNT_IDS?: string;
		/**
		 * Optional secrets (FN-30 hardening): 32 random bytes, base64url, keying the HMAC of re-claim markers
		 * (billing/claims.ts); the previous key only during a rotation. Unset or malformed → no marker is written
		 * or checked (starter credits and vouchers granted as before) and the admin page shows "Belum dikonfigurasi".
		 */
		CLAIM_HASH_KEY?: string;
		CLAIM_HASH_KEY_PREVIOUS?: string;
	}
}

export {};
