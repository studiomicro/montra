/**
 * Optional vars of the inbound Worker (FN-19; docs/RUNBOOK.md › E-mail forwarding). Unset INBOUND_EMAIL_DOMAIN →
 * every mail is refused ("Unknown recipient"); unset INBOUND_AUTHSERV_ID → every mail is `unverified` (still a
 * draft for review); unset AI_GATEWAY_* → a mail no parser reads is `unreadable/ai_unconfigured`, text not kept.
 */
interface Env {
	INBOUND_EMAIL_DOMAIN?: string;
	INBOUND_AUTHSERV_ID?: string;
	AI_GATEWAY_ACCOUNT_ID?: string;
	AI_GATEWAY_ID?: string;
}
