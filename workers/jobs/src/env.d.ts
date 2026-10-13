/**
 * Optional secrets: the Web Push VAPID key set (FN-13), shared with the app Worker. Unset → in-app only (FN-24).
 * FN-19: the AI read of forwarded mail runs here unattended, so this Worker also needs the FN-41 key-sealing
 * secret and the AI Gateway ids (docs/RUNBOOK.md › AI keys). Unset → a queued mail ends `unreadable` with the
 * reason, its text deleted; an FN-23 Agen report completes without its AI narrative (`ai_unconfigured`).
 */
interface Env {
	VAPID_PUBLIC_KEY?: string;
	VAPID_PRIVATE_KEY?: string;
	VAPID_SUBJECT?: string;
	AI_KEYS_ENCRYPTION_KEY?: string;
	AI_KEYS_ENCRYPTION_KEY_PREVIOUS?: string;
	AI_GATEWAY_ACCOUNT_ID?: string;
	AI_GATEWAY_ID?: string;
	/**
	 * FN-19 Gmail: the OAuth client (refreshing access tokens unattended) and the key that seals refresh tokens
	 * (the app Worker's CONNECTED_APPS_ENCRYPTION_KEY). Unset → no hourly Gmail check is enqueued and queued reads
	 * wait (docs/RUNBOOK.md › Gmail). Every Gmail capture is `unverified` (owner decision 2026-10-13).
	 */
	GOOGLE_OAUTH_CLIENT_ID?: string;
	GOOGLE_OAUTH_CLIENT_SECRET?: string;
	CONNECTED_APPS_ENCRYPTION_KEY?: string;
	CONNECTED_APPS_ENCRYPTION_KEY_PREVIOUS?: string;
}
