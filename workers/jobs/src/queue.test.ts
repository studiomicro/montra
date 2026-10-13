import { describe, expect, it, vi } from 'vitest';
import { RetryLaterError, type JobMessage } from '#lib/shared/jobs';
import { handleBatch, type JobDeps, type QueueMessageLike } from './queue';

function message(
	body: unknown,
	attempts = 1
): QueueMessageLike & { acked: boolean; retried: boolean; delaySeconds?: number } {
	const m: QueueMessageLike & { acked: boolean; retried: boolean; delaySeconds?: number } = {
		body,
		attempts,
		acked: false,
		retried: false,
		ack() {
			m.acked = true;
		},
		retry(options) {
			m.retried = true;
			m.delaySeconds = options?.delaySeconds;
		}
	};
	return m;
}

const ID = '0f8e4a52-6f43-4d61-9a1b-6c1f9d0c2b11';

function deps(over: Partial<JobDeps> = {}) {
	const enqueued: JobMessage[] = [];
	const d: JobDeps = {
		recordPing: vi.fn(async () => {}),
		budgetCheck: vi.fn(async () => []),
		billCheck: vi.fn(async () => []),
		dailyNudge: vi.fn(async () => []),
		closeReminder: vi.fn(async () => []),
		budgetStreakSnapshot: vi.fn(async () => {}),
		weeklySummary: vi.fn(async () => []),
		sendPush: vi.fn(async () => {}),
		recurringCheck: vi.fn(async () => {}),
		fileSweep: vi.fn(async () => false),
		inboundRead: vi.fn(async () => {}),
		gmailCheck: vi.fn(async () => {}),
		gmailRead: vi.fn(async () => {}),
		agentRun: vi.fn(async () => {}),
		enqueue: vi.fn(async (messages: JobMessage[]) => {
			enqueued.push(...messages);
		}),
		today: () => '2026-10-08',
		...over
	};
	return { d, enqueued };
}

describe('handleBatch', () => {
	it('FN-19: inbound_read passes the row id and this delivery’s attempt count; a transient failure retries later', async () => {
		const { d } = deps();
		const m = message({ type: 'inbound_read', mailId: ID }, 2);
		await handleBatch({ messages: [m] }, d);
		expect(d.inboundRead).toHaveBeenCalledWith(ID, 2);
		expect(m.acked).toBe(true);
		const failing = deps({
			inboundRead: vi.fn(async () => {
				throw new RetryLaterError('provider down', 60);
			})
		});
		const f = message({ type: 'inbound_read', mailId: ID });
		await handleBatch({ messages: [f] }, failing.d);
		expect(f.retried).toBe(true);
		expect(f.delaySeconds).toBe(60);
		// Anything but the id is dropped by the schema: only (mailId, attempts) reaches the reader.
		const text = message({ type: 'inbound_read', mailId: ID, text: 'Rp 28.000' });
		await handleBatch({ messages: [text] }, d);
		expect(d.inboundRead).toHaveBeenLastCalledWith(ID, 1);
	});

	it('FN-23: agent_run passes the run id and the attempt count only; bad payloads and RetryLaterError retry', async () => {
		const { d } = deps();
		const m = message({ type: 'agent_run', runId: ID, spaceId: 'x', text: 'Rp 1' }, 2);
		await handleBatch({ messages: [m] }, d);
		expect(d.agentRun).toHaveBeenCalledWith(ID, 2);
		expect(m.acked).toBe(true);
		for (const bad of [{ type: 'agent_run' }, { type: 'agent_run', runId: 'x'.repeat(65) }]) {
			const b = message(bad);
			await handleBatch({ messages: [b] }, d);
			expect(b.retried).toBe(true);
		}
		const failing = deps({
			agentRun: vi.fn(async () => {
				throw new RetryLaterError('provider down', 60);
			})
		});
		const f = message({ type: 'agent_run', runId: ID });
		await handleBatch({ messages: [f] }, failing.d);
		expect([f.retried, f.delaySeconds]).toEqual([true, 60]);
	});

	it('FN-19 Gmail: gmail_check and gmail_read carry ids only; replay, bad payload and RetryLaterError', async () => {
		const { d } = deps();
		const check = message(
			{ type: 'gmail_check', connectionId: ID, kind: 'hourly', window: '2026-10-08T06', page: 3 },
			2
		);
		const read = message({ type: 'gmail_read', mailId: ID }, 1);
		const replay = message({ type: 'gmail_read', mailId: ID }, 2);
		await handleBatch({ messages: [check, read, replay] }, d);
		expect(d.gmailCheck).toHaveBeenCalledWith(
			{ connectionId: ID, kind: 'hourly', window: '2026-10-08T06', page: 3 },
			2
		);
		expect(d.gmailRead).toHaveBeenNthCalledWith(1, ID, 1);
		expect(d.gmailRead).toHaveBeenNthCalledWith(2, ID, 2);
		expect([check, read, replay].every((m) => m.acked)).toBe(true);
		for (const bad of [
			{ type: 'gmail_check', connectionId: ID, kind: 'monthly', window: 'w', page: 0 },
			{ type: 'gmail_check', connectionId: ID, kind: 'hourly', window: 'w', page: 21 },
			{ type: 'gmail_check', connectionId: ID, kind: 'hourly', window: '', page: 0 },
			{ type: 'gmail_read' },
			{ type: 'gmail_read', mailId: 'x'.repeat(65) }
		]) {
			const m = message(bad);
			await handleBatch({ messages: [m] }, d);
			expect(m.retried, JSON.stringify(bad)).toBe(true);
		}
		// Text never travels: anything but the id is dropped by the schema.
		const withText = message({ type: 'gmail_read', mailId: ID, text: 'Rp 28.000' });
		await handleBatch({ messages: [withText] }, d);
		expect(d.gmailRead).toHaveBeenLastCalledWith(ID, 1);
		const throttled = deps({
			gmailRead: vi.fn(async () => {
				throw new RetryLaterError('rate limited', 4);
			})
		});
		const t = message({ type: 'gmail_read', mailId: ID });
		await handleBatch({ messages: [t] }, throttled.d);
		expect(t.retried).toBe(true);
		expect(t.delaySeconds).toBe(4);
	});

	it('records and acks a ping', async () => {
		const { d } = deps();
		const m = message({ type: 'ping', id: 'abc' });
		await handleBatch({ messages: [m] }, d);
		expect(d.recordPing).toHaveBeenCalledWith('abc');
		expect(m.acked).toBe(true);
		expect(m.retried).toBe(false);
	});

	it('FN-26: bill_check runs the space’s bill reminders and enqueues send_push for new rows only', async () => {
		const { d, enqueued } = deps({
			billCheck: vi.fn(async () => [
				{ id: 'n1', created: true },
				{ id: 'n2', created: false }
			])
		});
		const m = message({ type: 'bill_check', spaceId: ID });
		await handleBatch({ messages: [m] }, d);
		expect(d.billCheck).toHaveBeenCalledWith(ID);
		expect(enqueued).toEqual([{ type: 'send_push', notificationId: 'n1' }]);
		expect(m.acked).toBe(true);
	});

	it('FN-36: recurring_check runs the space’s due series for its date and acks; a failure is retried (then the DLQ)', async () => {
		const { d, enqueued } = deps({ recurringCheck: vi.fn(async () => false) });
		const m = message({ type: 'recurring_check', spaceId: ID, date: '2026-10-08' });
		await handleBatch({ messages: [m] }, d);
		expect(d.recurringCheck).toHaveBeenCalledWith(ID, '2026-10-08');
		expect(m.acked).toBe(true);
		expect(enqueued).toEqual([]);
		const failing = deps({
			recurringCheck: vi.fn(async () => {
				throw new Error('d1 down');
			})
		});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const r = message({ type: 'recurring_check', spaceId: ID, date: '2026-10-08' }, 2);
		await handleBatch({ messages: [r] }, failing.d);
		expect(r.retried).toBe(true);
		expect(r.acked).toBe(false);
		expect(failing.enqueued).toEqual([]);
		// No space id or no date → refused at the schema, never run.
		const bad = [
			message({ type: 'recurring_check', date: '2026-10-08' }),
			message({ type: 'recurring_check', spaceId: ID }),
			message({ type: 'recurring_check', spaceId: ID, date: '2026-02-30' })
		];
		await handleBatch({ messages: bad }, d);
		vi.restoreAllMocks();
		expect(bad.every((b) => b.retried && !b.acked)).toBe(true);
		expect(d.recurringCheck).toHaveBeenCalledTimes(1);
	});

	it('FN-36 L1: a delayed message runs for the tick’s WIB date, never the processing date; a future date is clamped', async () => {
		const { d } = deps({ recurringCheck: vi.fn(async () => false), today: () => '2026-10-09' });
		// Enqueued at the 23:00 WIB tick on the 8th, processed after midnight WIB.
		await handleBatch(
			{ messages: [message({ type: 'recurring_check', spaceId: ID, date: '2026-10-08' })] },
			d
		);
		expect(d.recurringCheck).toHaveBeenLastCalledWith(ID, '2026-10-08');
		await handleBatch(
			{ messages: [message({ type: 'recurring_check', spaceId: ID, date: '2026-10-10' })] },
			d
		);
		expect(d.recurringCheck).toHaveBeenLastCalledWith(ID, '2026-10-09');
	});

	it('FN-36 M1: work left over is acked and continued by one fresh message with the same date', async () => {
		const { d, enqueued } = deps({ recurringCheck: vi.fn(async () => true) });
		const m = message({ type: 'recurring_check', spaceId: ID, date: '2026-10-07' }, 3);
		await handleBatch({ messages: [m] }, d);
		expect(m.acked).toBe(true);
		expect(m.retried).toBe(false);
		expect(enqueued).toEqual([{ type: 'recurring_check', spaceId: ID, date: '2026-10-07' }]);
	});

	it('FN-36 M1: recurring_check messages run after every other job of the batch', async () => {
		const order: string[] = [];
		const { d } = deps({
			recurringCheck: vi.fn(async () => {
				order.push('recurring');
				return false;
			}),
			budgetCheck: vi.fn(async () => {
				order.push('budget');
				return [];
			}),
			sendPush: vi.fn(async () => {
				order.push('push');
			})
		});
		const r = { type: 'recurring_check', spaceId: ID, date: '2026-10-08' };
		await handleBatch(
			{
				messages: [
					message(r),
					message({ type: 'budget_check', spaceId: ID }),
					message(r),
					message({ type: 'send_push', notificationId: ID })
				]
			},
			d
		);
		expect(order).toEqual(['budget', 'push', 'recurring', 'recurring']);
	});

	it('retries an unknown type without throwing', async () => {
		const m = message({ type: 'mystery' });
		await handleBatch({ messages: [m] }, deps().d);
		expect(m.retried).toBe(true);
		expect(m.acked).toBe(false);
	});

	it('retries invalid bodies (null, string, oversized id, bad date) without throwing', async () => {
		const bad = [
			message(null),
			message('ping'),
			message({ type: 'ping', id: 'x'.repeat(65) }),
			message({ type: 'daily_nudge', userId: ID, date: '2026-02-30' }),
			message({ type: 'budget_check' })
		];
		await handleBatch({ messages: bad }, deps().d);
		expect(bad.every((m) => m.retried && !m.acked)).toBe(true);
	});

	it('retries when the dependency fails and still handles the next message', async () => {
		const recordPing = vi
			.fn<(id: string) => Promise<void>>()
			.mockRejectedValueOnce(new Error('db down'))
			.mockResolvedValueOnce(undefined);
		const a = message({ type: 'ping', id: 'a' });
		const b = message({ type: 'ping', id: 'b' });
		await handleBatch({ messages: [a, b] }, deps({ recordPing }).d);
		expect(a.retried).toBe(true);
		expect(b.acked).toBe(true);
	});
});

describe('handleBatch: notifications (FN-24)', () => {
	it('budget_check enqueues one send_push per new notification only', async () => {
		const { d, enqueued } = deps({
			budgetCheck: vi.fn(async () => [
				{ id: 'n1', created: true },
				{ id: 'n2', created: false }
			])
		});
		const m = message({ type: 'budget_check', spaceId: ID });
		await handleBatch({ messages: [m] }, d);
		expect(d.budgetCheck).toHaveBeenCalledWith(ID);
		expect(enqueued).toEqual([{ type: 'send_push', notificationId: 'n1' }]);
		expect(m.acked).toBe(true);
	});

	it('nothing new → nothing enqueued (a repeated cron tick stays silent)', async () => {
		const { d } = deps({ budgetCheck: vi.fn(async () => [{ id: 'n1', created: false }]) });
		await handleBatch({ messages: [message({ type: 'budget_check', spaceId: ID })] }, d);
		expect(d.enqueue).not.toHaveBeenCalled();
	});

	it('a redelivered message re-enqueues rows it found (first try may have failed before enqueueing)', async () => {
		const { d, enqueued } = deps({
			weeklySummary: vi.fn(async () => [{ id: 'n9', created: false }])
		});
		const m = message({ type: 'weekly_summary', userId: ID, weekStart: '2026-10-12' }, 2);
		await handleBatch({ messages: [m] }, d);
		expect(enqueued).toEqual([{ type: 'send_push', notificationId: 'n9' }]);
	});

	it('a daily nudge for another day than today is dropped (acked, nothing created)', async () => {
		const { d } = deps();
		const stale = message({ type: 'daily_nudge', userId: ID, date: '2026-10-07' });
		const fresh = message({ type: 'daily_nudge', userId: ID, date: '2026-10-08' });
		await handleBatch({ messages: [stale, fresh] }, d);
		expect(d.dailyNudge).toHaveBeenCalledTimes(1);
		expect(d.dailyNudge).toHaveBeenCalledWith(ID, '2026-10-08');
		expect(stale.acked && fresh.acked).toBe(true);
	});

	it('send_push failure is retried (the queue moves it to the DLQ after max_retries)', async () => {
		const { d } = deps({ sendPush: vi.fn(async () => Promise.reject(new Error('503'))) });
		const m = message({ type: 'send_push', notificationId: 'n1' });
		await handleBatch({ messages: [m] }, d);
		expect(m.retried).toBe(true);
		expect(m.acked).toBe(false);
	});

	it('a RetryLaterError retries with its delay (a device claimed by another attempt)', async () => {
		const { d } = deps({
			sendPush: vi.fn(async () => Promise.reject(new RetryLaterError('busy', 360)))
		});
		const m = message({ type: 'send_push', notificationId: 'n1' });
		await handleBatch({ messages: [m] }, d);
		expect(m).toMatchObject({ retried: true, acked: false, delaySeconds: 360 });
	});

	it('an enqueue failure retries the trigger message', async () => {
		const { d } = deps({
			budgetCheck: vi.fn(async () => [{ id: 'n1', created: true }]),
			enqueue: vi.fn(async () => Promise.reject(new Error('queue down')))
		});
		const m = message({ type: 'budget_check', spaceId: ID });
		await handleBatch({ messages: [m] }, d);
		expect(m.retried).toBe(true);
	});

	it('never logs a message body', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { d } = deps({ sendPush: vi.fn(async () => Promise.reject(new Error('x'))) });
		await handleBatch(
			{ messages: [message({ type: 'send_push', notificationId: 'secret-id' })] },
			d
		);
		expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-id');
		warn.mockRestore();
	});
});

describe('file_sweep (FN-27)', () => {
	it('sweeps once and acks when the batch was not full', async () => {
		const { d, enqueued } = deps();
		const m = message({ type: 'file_sweep' });
		await handleBatch({ messages: [m] }, d);
		expect(d.fileSweep).toHaveBeenCalledTimes(1);
		expect(enqueued).toEqual([]);
		expect(m.acked).toBe(true);
	});

	it('hands the rest to one follow-up message after a full batch', async () => {
		const { d, enqueued } = deps({ fileSweep: vi.fn(async () => true) });
		const m = message({ type: 'file_sweep' });
		await handleBatch({ messages: [m] }, d);
		expect(enqueued).toEqual([{ type: 'file_sweep' }]);
		expect(m.acked).toBe(true);
	});

	it('retries when R2 fails', async () => {
		const { d } = deps({ fileSweep: vi.fn(async () => Promise.reject(new Error('r2 down'))) });
		const m = message({ type: 'file_sweep' });
		await handleBatch({ messages: [m] }, d);
		expect(m.retried).toBe(true);
		expect(m.acked).toBe(false);
	});
	it('FN-34b: close_reminder runs only for today (WIB); a stale one is acked unprocessed; new rows are pushed', async () => {
		const { d, enqueued } = deps({
			closeReminder: vi.fn(async () => [{ id: ID, created: true }])
		});
		const today = message({ type: 'close_reminder', userId: ID, date: '2026-10-08' });
		const stale = message({ type: 'close_reminder', userId: ID, date: '2026-10-07' });
		await handleBatch({ messages: [today, stale] }, d);
		expect(d.closeReminder).toHaveBeenCalledTimes(1);
		expect(d.closeReminder).toHaveBeenCalledWith(ID, '2026-10-08');
		expect(today.acked && stale.acked).toBe(true);
		expect(enqueued).toEqual([{ type: 'send_push', notificationId: ID }]);
	});

	it('FN-34b: budget_streak_snapshot judges only yesterday; today, later and older dates are acked unprocessed', async () => {
		const { d } = deps();
		const msgs = ['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-06'].map((date) =>
			message({ type: 'budget_streak_snapshot', spaceId: ID, date })
		);
		await handleBatch({ messages: msgs }, d);
		expect(d.budgetStreakSnapshot).toHaveBeenCalledTimes(1);
		expect(d.budgetStreakSnapshot).toHaveBeenCalledWith(ID, '2026-10-07');
		expect(msgs.every((m) => m.acked)).toBe(true);
		// A failing write retries (bounded by the queue, then the DLQ).
		const failing = deps({
			budgetStreakSnapshot: vi.fn(async () => {
				throw new Error('d1');
			})
		});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const m = message({ type: 'budget_streak_snapshot', spaceId: ID, date: '2026-10-07' });
		await handleBatch({ messages: [m] }, failing.d);
		expect(m.retried).toBe(true);
		vi.restoreAllMocks();
	});
});
