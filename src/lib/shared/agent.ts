import { z } from 'zod';
import { DAY_MS, isMonthString, monthRange } from './dates.ts';
import { msg } from './i18n.ts';

/**
 * Agen (beta) reports (FN-23): types, statuses, steps, limits and the period rules, shared by the page, the app
 * Worker and the jobs Worker. Every figure in a report is computed by code from stored rows; the model only ever
 * writes an optional, guarded narrative.
 */

export const AGENT_TYPES = ['monthly', 'annual', 'spt_assets'] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export const AGENT_STATUSES = ['queued', 'running', 'ready', 'failed'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** `none`: no narrative was asked for or none could be asked; `ai`: stored; `skipped`: asked, not usable. */
export const AGENT_NARRATIVE_STATES = ['none', 'ai', 'skipped'] as const;
export type AgentNarrativeState = (typeof AGENT_NARRATIVE_STATES)[number];

/** Why a run failed (a code, never provider text). */
export const AGENT_FAILURES = ['plan', 'empty', 'access', 'internal'] as const;
export type AgentFailure = (typeof AGENT_FAILURES)[number];

/** Why a run has no narrative (a code, never provider text). */
export const AGENT_NARRATIVE_REASONS = [
	'off',
	'ai_unconfigured',
	'no_key',
	'invalid',
	'quota',
	'refusal',
	'malformed',
	'max_tokens',
	'model_unavailable',
	'network',
	'timeout',
	'guard'
] as const;
export type AgentNarrativeReason = (typeof AGENT_NARRATIVE_REASONS)[number];

export const AGENT_LOCALES = ['id', 'en'] as const;

/** The steps of a run, in order (one queue message each). The asset list has no narrative step. */
export const AGENT_STEPS = {
	monthly: ['read', 'group', 'summary', 'narrate', 'render'],
	annual: ['read', 'group', 'summary', 'narrate', 'render'],
	spt_assets: ['read', 'balances', 'assets', 'render']
} as const satisfies Record<AgentType, readonly string[]>;
export type AgentStep = (typeof AGENT_STEPS)[AgentType][number];

export const stepsOf = (type: AgentType): readonly AgentStep[] => AGENT_STEPS[type];

/** Labels of the steps as the page lists them. */
export const AGENT_STEP_LABELS: Readonly<Record<AgentStep, string>> = {
	read: msg('Membaca catatan'),
	group: msg('Mengelompokkan per kategori'),
	summary: msg('Ringkasan'),
	narrate: msg('Menulis ringkasan AI'),
	balances: msg('Saldo dompet akhir tahun'),
	assets: msg('Daftar aset'),
	render: msg('Menyiapkan file')
};

export const AGENT_TYPE_LABELS: Readonly<Record<AgentType, string>> = {
	monthly: msg('Laporan bulanan'),
	annual: msg('Rekap tahunan'),
	spt_assets: msg('Daftar aset untuk SPT')
};

export const AGENT_STATUS_LABELS: Readonly<Record<AgentStatus, string>> = {
	queued: msg('Antre'),
	running: msg('Berjalan'),
	ready: msg('Siap'),
	failed: msg('Gagal')
};

export const AGENT_FAILURE_LABELS: Readonly<Record<AgentFailure, string>> = {
	plan: msg('Paket Agen berakhir sebelum laporan selesai.'),
	empty: msg('Belum ada catatan di periode ini.'),
	access: msg('Kamu tidak lagi menjadi anggota ruang ini.'),
	internal: msg('Laporan tidak bisa dibuat. Coba lagi.')
};

export const AGENT_NARRATIVE_REASON_LABELS: Readonly<Record<AgentNarrativeReason, string>> = {
	off: msg('tidak diminta'),
	ai_unconfigured: msg('AI belum dikonfigurasi'),
	no_key: msg('belum ada kunci Anthropic'),
	invalid: msg('kunci Anthropic tidak valid'),
	quota: msg('kuota Anthropic habis'),
	refusal: msg('model menolak menulis'),
	malformed: msg('jawaban model tidak bisa dibaca'),
	max_tokens: msg('jawaban model terpotong'),
	model_unavailable: msg('model tidak tersedia'),
	network: msg('Anthropic tidak bisa dihubungi'),
	timeout: msg('model terlalu lama menjawab'),
	guard: msg('teks model tidak lolos pemeriksaan angka')
};

/** Unfinished (queued or running) runs one user may have, across their spaces (owner decision 3). */
export const AGENT_USER_ACTIVE_MAX = 1;
/** Unfinished runs one space may have. */
export const AGENT_SPACE_ACTIVE_MAX = 3;
/** New runs one user may start per rolling AGENT_DAY_MS. */
export const AGENT_USER_DAILY_MAX = 5;
/** New runs one space may start per rolling AGENT_DAY_MS. */
export const AGENT_SPACE_DAILY_MAX = 15;
/** Live reports one user keeps per space (the page lists them all). */
export const AGENT_LIVE_MAX = 20;
export const AGENT_DAY_MS = DAY_MS;
/** A ready report lives 30 days from when it is ready (owner decision 5). */
export const AGENT_READY_TTL_MS = 30 * AGENT_DAY_MS;
/** An unfinished or failed run lives 7 days from when it was created. */
export const AGENT_UNFINISHED_TTL_MS = 7 * AGENT_DAY_MS;
/** Oldest period a report covers (years back from today). */
export const AGENT_MAX_YEARS_BACK = 10;
/** Longest stored narrative (the CHECK of `agent_runs`). */
export const AGENT_NARRATIVE_MAX = 2000;
/** Largest stored `facts_json` in bytes (the CHECK of `agent_runs`). */
export const AGENT_FACTS_MAX_BYTES = 256 * 1024;

const YEAR = /^\d{4}$/;

/**
 * Whether `period` is one the user may ask a report of on `today` (WIB): a month `YYYY-MM` for a monthly
 * report, a year `YYYY` otherwise; never in the future, never older than AGENT_MAX_YEARS_BACK years.
 */
export function isAgentPeriod(type: AgentType, period: string, today: string): boolean {
	const year = Number(today.slice(0, 4));
	const oldest = year - AGENT_MAX_YEARS_BACK;
	if (type === 'monthly') {
		if (!isMonthString(period)) return false;
		return period <= today.slice(0, 7) && period >= `${oldest}-01`;
	}
	if (!YEAR.test(period)) return false;
	const y = Number(period);
	return y <= year && y >= oldest;
}

/** Whether the period is still running on `today`: the current month or year ("sampai {tanggal}"). */
export function isPartialPeriod(type: AgentType, period: string, today: string): boolean {
	return type === 'monthly' ? period === today.slice(0, 7) : period === today.slice(0, 4);
}

/**
 * The WIB date range a report covers on `today`: the whole month or year, cut at `today` for the current one.
 * `period` must already pass `isAgentPeriod`.
 */
export function agentRange(
	type: AgentType,
	period: string,
	today: string
): { from: string; to: string } {
	const whole =
		type === 'monthly' ? monthRange(period) : { from: `${period}-01-01`, to: `${period}-12-31` };
	return { from: whole.from, to: isPartialPeriod(type, period, today) ? today : whole.to };
}

/** The create form as the server reads it; any other field (spaceId, userId, status …) is ignored. */
export const agentForm = z.object({
	type: z.enum(AGENT_TYPES),
	period: z.string().min(4).max(7),
	narrative: z.boolean(),
	requestId: z.string().regex(/^[0-9a-f-]{36}$/)
});

/** A file name piece per type (never user text). */
export const AGENT_FILE_SLUGS: Readonly<Record<AgentType, string>> = {
	monthly: 'laporan-bulanan',
	annual: 'rekap-tahunan',
	spt_assets: 'daftar-aset'
};

export const AGENT_FORMATS = ['csv', 'html'] as const;
export type AgentFormat = (typeof AGENT_FORMATS)[number];
