import { isHttpError } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signUp } from '#lib/server/auth/accounts';
import { deleteAccount } from '#lib/server/auth/delete-account';
import { signInWithPassword } from '#lib/server/auth/password';
import { getDb, type Db } from '#lib/server/db';
import {
	MAX_SPACE_MEMBERS,
	requireSpaceAccess,
	resolveCurrentSpace
} from '#lib/server/spaces/access';
import {
	acceptInvite,
	createInvite,
	INVITE_TTL_MS,
	liveInvite,
	resolveInvite,
	revokeInvite
} from '#lib/server/spaces/invites';
import {
	createSharedSpace,
	leaveSpace,
	listMembers,
	listSpaces,
	removeMember
} from '#lib/server/spaces/spaces';
import { sha256Hex } from '#lib/server/util';
import { openLocalD1 } from '../helpers/d1';

let d1: D1Database;
let db: Db;
let dispose: () => Promise<void>;
const PASSWORD = 'kopi-pagi-2026';
const NOW = 1_800_000_000_000;

beforeAll(async () => {
	({ db: d1, dispose } = await openLocalD1());
	db = getDb(d1);
});
afterAll(() => dispose());

let seq = 0;
/** A signed-up user and their personal space id. */
async function account(name = 'Uji') {
	const email = `ruang${++seq}@contoh.id`;
	const r = await signUp(
		db,
		{ name, email, password: PASSWORD, adultConfirmed: true, consentAccepted: true },
		NOW
	);
	if (!r.ok) throw new Error('setup failed');
	const personal = await d1
		.prepare('select space_id as id from space_members where user_id = ?')
		.bind(r.userId)
		.first<{ id: string }>();
	return { id: r.userId, email, personalId: personal!.id };
}

const count = async (q: string, ...binds: unknown[]) =>
	(await d1
		.prepare(`select count(*) as n from ${q}`)
		.bind(...binds)
		.first<{ n: number }>())!.n;
const audits = (spaceId: string, action: string) =>
	count('audit_events where space_id = ? and action = ?', spaceId, action);
const liveMembers = (spaceId: string) =>
	count('space_members where space_id = ? and deleted_at is null', spaceId);

/** What a call threw, as status + body, or 'ok'. */
async function outcome(fn: () => Promise<unknown>) {
	try {
		await fn();
		return 'ok';
	} catch (e) {
		if (isHttpError(e)) return { status: e.status, body: e.body };
		throw e;
	}
}

/** A shared space owned by a new user, plus a live invite token. */
async function sharedWithInvite() {
	const owner = await account('Pemilik');
	const spaceId = (await createSharedSpace(db, owner.id, 'Keluarga', NOW))!;
	const invite = (await createInvite(db, { spaceId, userId: owner.id, replaces: '' }, NOW))!;
	return { owner, spaceId, token: invite.token };
}

describe('requireSpaceAccess', () => {
	it('returns the space and role of a live membership', async () => {
		const owner = await account();
		const spaceId = (await createSharedSpace(db, owner.id, 'Rumah', NOW))!;
		expect(await requireSpaceAccess(db, owner.id, spaceId)).toEqual({
			space: { id: spaceId, kind: 'shared', name: 'Rumah' },
			role: 'owner'
		});
		expect((await requireSpaceAccess(db, owner.id, owner.personalId)).space.kind).toBe('personal');
	});

	it('answers missing, not-a-member, removed member and over-long ids with one identical 404', async () => {
		const { owner, spaceId, token } = await sharedWithInvite();
		const stranger = await account();
		const removed = await account();
		await acceptInvite(db, token, removed.id, NOW);
		const [membership] = await listMembers(db, spaceId, owner.id).then((m) =>
			m.filter((x) => !x.isYou)
		);
		expect(
			await removeMember(db, { spaceId, actorUserId: owner.id, memberId: membership!.id }, NOW)
		).toBe('removed');

		const missing = await outcome(() => requireSpaceAccess(db, stranger.id, crypto.randomUUID()));
		const notMine = await outcome(() => requireSpaceAccess(db, stranger.id, spaceId));
		const wasMine = await outcome(() => requireSpaceAccess(db, removed.id, spaceId));
		const long = await outcome(() => requireSpaceAccess(db, stranger.id, 'x'.repeat(5000)));
		expect(missing).toEqual({ status: 404, body: { message: 'Not found', status: 404 } });
		expect(notMine).toEqual(missing);
		expect(wasMine).toEqual(missing);
		expect(long).toEqual(missing);
		// Another user's personal space is just as invisible.
		expect(await outcome(() => requireSpaceAccess(db, stranger.id, owner.personalId))).toEqual(
			missing
		);
	});

	it('answers a member asking for an owner-only action with 403, and vice versa', async () => {
		const { owner, spaceId, token } = await sharedWithInvite();
		const member = await account();
		await acceptInvite(db, token, member.id, NOW);
		expect(
			await outcome(() => requireSpaceAccess(db, member.id, spaceId, { role: 'owner' }))
		).toEqual({ status: 403, body: { message: 'Forbidden', status: 403 } });
		expect(
			await outcome(() => requireSpaceAccess(db, owner.id, spaceId, { role: 'member' }))
		).toEqual({ status: 403, body: { message: 'Forbidden', status: 403 } });
		expect(
			await outcome(() => requireSpaceAccess(db, member.id, spaceId, { role: 'member' }))
		).toBe('ok');
	});
});

describe('resolveCurrentSpace', () => {
	it('uses the cookie only while it names a live membership, else the personal space', async () => {
		const { owner, spaceId, token } = await sharedWithInvite();
		const member = await account();
		await acceptInvite(db, token, member.id, NOW);
		expect((await resolveCurrentSpace(db, member.id, spaceId))?.id).toBe(spaceId);
		expect((await resolveCurrentSpace(db, member.id, undefined))?.id).toBe(member.personalId);
		expect((await resolveCurrentSpace(db, member.id, 'sampah'))?.id).toBe(member.personalId);
		expect((await resolveCurrentSpace(db, member.id, 'x'.repeat(500)))?.id).toBe(member.personalId);
		// Someone else's space: never selected.
		expect((await resolveCurrentSpace(db, member.id, owner.personalId))?.id).toBe(
			member.personalId
		);
		await leaveSpace(db, { spaceId, userId: member.id }, NOW);
		expect(await resolveCurrentSpace(db, member.id, spaceId)).toMatchObject({
			id: member.personalId,
			kind: 'personal',
			role: 'owner'
		});
	});
});

describe('createSharedSpace', () => {
	it('writes the space, the owner membership and the audit row together', async () => {
		const owner = await account();
		const spaceId = (await createSharedSpace(db, owner.id, '  Liburan  ', NOW))!;
		expect(await requireSpaceAccess(db, owner.id, spaceId)).toMatchObject({
			space: { kind: 'shared', name: 'Liburan' },
			role: 'owner'
		});
		expect(await audits(spaceId, 'space_created')).toBe(1);
		const spaces = await listSpaces(db, owner.id);
		expect(spaces.map((s) => s.kind)).toEqual(['personal', 'shared']);
	});

	it('strips control and zero-width characters and caps the name; empty is refused', async () => {
		const owner = await account();
		const raw = 'Ru' + String.fromCharCode(0x200b) + 'mah\u0007 ' + 'a'.repeat(200);
		const id = (await createSharedSpace(db, owner.id, raw, NOW))!;
		const { space } = await requireSpaceAccess(db, owner.id, id);
		expect(space.name.startsWith('Rumah a')).toBe(true);
		expect(Array.from(space.name).length).toBe(60);
		expect(await createSharedSpace(db, owner.id, ' ​\u0000 ', NOW)).toBeNull();
	});
});

describe('invites', () => {
	it('stores only the token hash, expires in 7 days, and shows no token afterwards', async () => {
		const { spaceId, token } = await sharedWithInvite();
		const row = await d1
			.prepare('select token_hash, expires_at from space_invites where space_id = ?')
			.bind(spaceId)
			.first<{ token_hash: string; expires_at: number }>();
		expect(row?.token_hash).toBe(await sha256Hex(token));
		expect(row?.expires_at).toBe(NOW + INVITE_TTL_MS);
		expect(JSON.stringify(await liveInvite(db, spaceId))).not.toContain(token);
		expect(await audits(spaceId, 'invite_created')).toBe(1);
	});

	it('a new link revokes the one it replaces; a stale form changes nothing', async () => {
		const { owner, spaceId, token } = await sharedWithInvite();
		const first = (await liveInvite(db, spaceId))!;
		const second = await createInvite(db, { spaceId, userId: owner.id, replaces: first.id }, NOW);
		expect(second).not.toBeNull();
		expect(await resolveInvite(db, token, owner.id, NOW)).toBeNull();
		expect(await count('space_invites where space_id = ? and deleted_at is null', spaceId)).toBe(1);
		// Another tab still shows the first invite (or none): refused, the live link stays.
		expect(
			await createInvite(db, { spaceId, userId: owner.id, replaces: first.id }, NOW)
		).toBeNull();
		expect(await createInvite(db, { spaceId, userId: owner.id, replaces: '' }, NOW)).toBeNull();
		expect(await resolveInvite(db, second!.token, owner.id, NOW)).not.toBeNull();
	});

	it('two (or ten) concurrent creates leave exactly one usable link', async () => {
		const owner = await account();
		const spaceId = (await createSharedSpace(db, owner.id, 'Balapan', NOW))!;
		const results = await Promise.all(
			Array.from({ length: 10 }, () =>
				createInvite(db, { spaceId, userId: owner.id, replaces: '' }, NOW)
			)
		);
		const made = results.filter((r) => r !== null);
		expect(made).toHaveLength(1);
		expect(await count('space_invites where space_id = ? and deleted_at is null', spaceId)).toBe(1);
		let usable = 0;
		for (const r of results) if (r && (await resolveInvite(db, r.token, owner.id, NOW))) usable++;
		expect(usable).toBe(1);
	});

	it('only the owner of a shared space can create or revoke, even bypassing the route', async () => {
		const { owner, spaceId, token } = await sharedWithInvite();
		const member = await account();
		await acceptInvite(db, token, member.id, NOW);
		const live = (await liveInvite(db, spaceId))!;
		expect(
			await createInvite(db, { spaceId, userId: member.id, replaces: live.id }, NOW)
		).toBeNull();
		expect(await revokeInvite(db, { spaceId, userId: member.id, inviteId: live.id }, NOW)).toBe(
			false
		);
		expect(
			await createInvite(db, { spaceId: owner.personalId, userId: owner.id, replaces: '' }, NOW)
		).toBeNull();
		expect((await liveInvite(db, spaceId))?.id).toBe(live.id);
		expect(await audits(spaceId, 'invite_revoked')).toBe(0);
	});

	it('revoking tombstones the link, writes the audit row, and the old link stops working', async () => {
		const { owner, spaceId, token } = await sharedWithInvite();
		const live = (await liveInvite(db, spaceId))!;
		expect(await revokeInvite(db, { spaceId, userId: owner.id, inviteId: live.id }, NOW)).toBe(
			true
		);
		expect(await liveInvite(db, spaceId)).toBeNull();
		expect(await audits(spaceId, 'invite_revoked')).toBe(1);
		const late = await account();
		expect(await acceptInvite(db, token, late.id, NOW)).toEqual({ status: 'invalid' });
		// A second revoke (stale tab) is a no-op.
		expect(await revokeInvite(db, { spaceId, userId: owner.id, inviteId: live.id }, NOW)).toBe(
			false
		);
		expect(await audits(spaceId, 'invite_revoked')).toBe(1);
	});

	it('unknown, malformed, expired and revoked tokens are all just null', async () => {
		const { owner, spaceId, token } = await sharedWithInvite();
		const viewer = await account();
		expect(await resolveInvite(db, token, viewer.id, NOW)).not.toBeNull();
		expect(await resolveInvite(db, token, viewer.id, NOW + INVITE_TTL_MS)).toBeNull();
		for (const bad of [
			'',
			'a',
			'x'.repeat(43),
			'../../etc',
			'%00',
			'ä'.repeat(43),
			'y'.repeat(9000)
		])
			expect(await resolveInvite(db, bad, viewer.id, NOW)).toBeNull();
		const live = (await liveInvite(db, spaceId))!;
		await revokeInvite(db, { spaceId, userId: owner.id, inviteId: live.id }, NOW);
		expect(await resolveInvite(db, token, viewer.id, NOW)).toBeNull();
	});
});

describe('acceptInvite', () => {
	it('joins once: a membership and an audit row; a second accept writes nothing', async () => {
		const { spaceId, token } = await sharedWithInvite();
		const guest = await account();
		expect(await acceptInvite(db, token, guest.id, NOW)).toEqual({ status: 'joined', spaceId });
		expect(await acceptInvite(db, token, guest.id, NOW)).toEqual({ status: 'member', spaceId });
		expect(await count('space_members where space_id = ? and user_id = ?', spaceId, guest.id)).toBe(
			1
		);
		expect(await audits(spaceId, 'member_joined')).toBe(1);
		expect((await requireSpaceAccess(db, guest.id, spaceId)).role).toBe('member');
	});

	it('the owner opening their own link is already a member', async () => {
		const { owner, spaceId, token } = await sharedWithInvite();
		expect(await acceptInvite(db, token, owner.id, NOW)).toEqual({ status: 'member', spaceId });
		expect(await audits(spaceId, 'member_joined')).toBe(0);
	});

	it(`refuses a sixth person once ${MAX_SPACE_MEMBERS} are in`, async () => {
		const { spaceId, token } = await sharedWithInvite();
		for (let i = 0; i < MAX_SPACE_MEMBERS - 1; i++)
			expect((await acceptInvite(db, token, (await account()).id, NOW)).status).toBe('joined');
		const sixth = await account();
		expect(await acceptInvite(db, token, sixth.id, NOW)).toEqual({ status: 'full' });
		expect(await liveMembers(spaceId)).toBe(MAX_SPACE_MEMBERS);
	});

	it('20 concurrent accepts for the last slot: exactly one joins, 19 see "full"', async () => {
		const { spaceId, token } = await sharedWithInvite();
		for (let i = 0; i < MAX_SPACE_MEMBERS - 2; i++)
			await acceptInvite(db, token, (await account()).id, NOW);
		expect(await liveMembers(spaceId)).toBe(MAX_SPACE_MEMBERS - 1);
		const racers = await Promise.all(Array.from({ length: 20 }, () => account()));
		const results = await Promise.all(racers.map((r) => acceptInvite(db, token, r.id, NOW)));
		expect(results.filter((r) => r.status === 'joined')).toHaveLength(1);
		expect(results.filter((r) => r.status === 'full')).toHaveLength(19);
		expect(await liveMembers(spaceId)).toBe(MAX_SPACE_MEMBERS);
		expect(await count('space_members where space_id = ?', spaceId)).toBe(MAX_SPACE_MEMBERS);
		expect(await audits(spaceId, 'member_joined')).toBe(MAX_SPACE_MEMBERS - 1);
	});

	it('a member who left can rejoin: the old row is revived, never duplicated', async () => {
		const { spaceId, token } = await sharedWithInvite();
		const back = await account();
		await acceptInvite(db, token, back.id, NOW);
		expect(await leaveSpace(db, { spaceId, userId: back.id }, NOW)).toBe(true);
		expect(await acceptInvite(db, token, back.id, NOW + 1)).toEqual({ status: 'joined', spaceId });
		expect(await count('space_members where space_id = ? and user_id = ?', spaceId, back.id)).toBe(
			1
		);
		expect(await audits(spaceId, 'member_joined')).toBe(2);
	});
});

describe('members leaving and being removed', () => {
	it('M1: a removed member cannot rejoin through the link that was live when they were removed', async () => {
		const { owner, spaceId, token } = await sharedWithInvite();
		const b = await account('B');
		expect((await acceptInvite(db, token, b.id, NOW)).status).toBe('joined');
		const row = (await listMembers(db, spaceId, owner.id)).find((m) => m.name === 'B')!;
		expect(
			await removeMember(db, { spaceId, actorUserId: owner.id, memberId: row.id }, NOW + 1)
		).toBe('removed');
		// The exact repro: same token, same user, straight away.
		expect(await acceptInvite(db, token, b.id, NOW + 1)).toEqual({ status: 'invalid' });
		await expect(requireSpaceAccess(db, b.id, spaceId)).rejects.toMatchObject({ status: 404 });
		// Removal reset the link (same batch, audited).
		expect(await liveInvite(db, spaceId)).toBeNull();
		expect(await audits(spaceId, 'invite_revoked')).toBe(1);
		// Even an older link that is somehow still live refuses someone removed after it was made…
		await d1
			.prepare('update space_invites set deleted_at = null where space_id = ?')
			.bind(spaceId)
			.run();
		expect(await resolveInvite(db, token, b.id, NOW + 2)).toBeNull();
		expect(await acceptInvite(db, token, b.id, NOW + 2)).toEqual({ status: 'invalid' });
		// …while still working for anyone else.
		const c = await account();
		expect((await acceptInvite(db, token, c.id, NOW + 2)).status).toBe('joined');
		// A link the owner makes after the removal is the owner's choice to let B back.
		const live = (await liveInvite(db, spaceId))!;
		const fresh = await createInvite(db, { spaceId, userId: owner.id, replaces: live.id }, NOW + 3);
		expect(await acceptInvite(db, fresh!.token, b.id, NOW + 4)).toEqual({
			status: 'joined',
			spaceId
		});
	});

	it('the owner removes a member: tombstone plus an audit row naming them', async () => {
		const { owner, spaceId, token } = await sharedWithInvite();
		const member = await account('Sari');
		await acceptInvite(db, token, member.id, NOW);
		const target = (await listMembers(db, spaceId, owner.id)).find((m) => m.name === 'Sari')!;
		expect(target.role).toBe('member');
		expect(
			await removeMember(db, { spaceId, actorUserId: owner.id, memberId: target.id }, NOW)
		).toBe('removed');
		expect(
			await count(
				'audit_events where space_id = ? and action = ? and target_user_id = ?',
				spaceId,
				'member_removed',
				member.id
			)
		).toBe(1);
		// The same form again (another tab): gone, nothing written.
		expect(
			await removeMember(db, { spaceId, actorUserId: owner.id, memberId: target.id }, NOW)
		).toBe('gone');
		expect(await audits(spaceId, 'member_removed')).toBe(1);
	});

	it('the owner cannot remove themselves; a member cannot remove anyone', async () => {
		const { owner, spaceId, token } = await sharedWithInvite();
		const a = await account('A');
		const b = await account('B');
		await acceptInvite(db, token, a.id, NOW);
		await acceptInvite(db, token, b.id, NOW);
		const members = await listMembers(db, spaceId, owner.id);
		const own = members.find((m) => m.isYou)!;
		expect(await removeMember(db, { spaceId, actorUserId: owner.id, memberId: own.id }, NOW)).toBe(
			'owner'
		);
		const bRow = members.find((m) => m.name === 'B')!;
		expect(await removeMember(db, { spaceId, actorUserId: a.id, memberId: bRow.id }, NOW)).toBe(
			'gone'
		);
		expect(await liveMembers(spaceId)).toBe(3);
		expect(await audits(spaceId, 'member_removed')).toBe(0);
	});

	it('a member leaves (tombstone + audit); the owner has no leave path', async () => {
		const { owner, spaceId, token } = await sharedWithInvite();
		const member = await account();
		await acceptInvite(db, token, member.id, NOW);
		expect(await leaveSpace(db, { spaceId, userId: owner.id }, NOW)).toBe(false);
		expect(await leaveSpace(db, { spaceId, userId: member.id }, NOW)).toBe(true);
		expect(await leaveSpace(db, { spaceId, userId: member.id }, NOW)).toBe(false);
		expect(await audits(spaceId, 'member_left')).toBe(1);
		expect(await liveMembers(spaceId)).toBe(1);
	});
});

describe('account deletion with sharing rows', () => {
	const proof = async (email: string) => {
		const p = await signInWithPassword(db, email, PASSWORD, NOW);
		if (!p.ok) throw new Error('proof failed');
		return p.hash;
	};

	it('an owner who created an invite and audit rows can still delete the account', async () => {
		const { owner, spaceId, token } = await sharedWithInvite();
		const member = await account();
		await acceptInvite(db, token, member.id, NOW);
		expect(await deleteAccount(db, owner.id, await proof(owner.email))).toBe(true);
		expect(await count('users where id = ?', owner.id)).toBe(0);
		// The shared space stays for the member (now its owner); the deleted person is no longer named in its log.
		expect((await requireSpaceAccess(db, member.id, spaceId)).role).toBe('owner');
		expect(await count('space_invites where created_by_user_id = ?', owner.id)).toBe(0);
		expect(await count('audit_events where actor_user_id = ?', owner.id)).toBe(0);
		expect(await audits(spaceId, 'member_joined')).toBe(1);
	});

	it('a member who left and was removed elsewhere can delete the account', async () => {
		const { owner, spaceId, token } = await sharedWithInvite();
		const member = await account();
		await acceptInvite(db, token, member.id, NOW);
		const row = (await listMembers(db, spaceId, owner.id)).find((m) => !m.isYou)!;
		await removeMember(db, { spaceId, actorUserId: owner.id, memberId: row.id }, NOW);
		expect(await deleteAccount(db, member.id, await proof(member.email))).toBe(true);
		expect(await count('audit_events where target_user_id = ?', member.id)).toBe(0);
		expect(await audits(spaceId, 'member_removed')).toBe(1);
	});

	it('ownership passes to the longest-standing live member; the others stay members', async () => {
		const { owner, spaceId, token } = await sharedWithInvite();
		const first = await account();
		const left = await account();
		const second = await account();
		await acceptInvite(db, token, left.id, NOW);
		await acceptInvite(db, token, first.id, NOW + 1);
		await acceptInvite(db, token, second.id, NOW + 2);
		// The earliest joiner left: a tombstoned membership never inherits.
		await leaveSpace(db, { spaceId, userId: left.id }, NOW + 3);
		expect(await deleteAccount(db, owner.id, await proof(owner.email), NOW + 4)).toBe(true);
		expect((await requireSpaceAccess(db, first.id, spaceId)).role).toBe('owner');
		expect((await requireSpaceAccess(db, second.id, spaceId)).role).toBe('member');
		expect(await count("space_members where space_id = ? and role = 'owner'", spaceId)).toBe(1);
		// One audit row in the same batch: the deleted actor is no longer named, the new owner is.
		const handOver = await d1
			.prepare(
				"select actor_user_id as actor, target_user_id as target, created_at as at from audit_events where space_id = ? and action = 'ownership_transferred'"
			)
			.bind(spaceId)
			.all<{ actor: string | null; target: string; at: number }>();
		expect(handOver.results).toEqual([{ actor: null, target: first.id, at: NOW + 4 }]);
		// The old owner's link died with the account; the new owner can make one.
		expect(await liveInvite(db, spaceId)).toBeNull();
		expect(
			await createInvite(db, { spaceId, userId: first.id, replaces: '' }, NOW + 5)
		).not.toBeNull();
	});

	it('a wrong proof hands nothing over', async () => {
		const { owner, spaceId, token } = await sharedWithInvite();
		const member = await account();
		await acceptInvite(db, token, member.id, NOW);
		expect(await deleteAccount(db, owner.id, 'not-the-hash', NOW)).toBe(false);
		expect((await requireSpaceAccess(db, member.id, spaceId)).role).toBe('member');
		expect((await requireSpaceAccess(db, owner.id, spaceId)).role).toBe('owner');
		expect(await audits(spaceId, 'ownership_transferred')).toBe(0);
	});

	it('a shared space whose other members all left is deleted with its last live member (L1)', async () => {
		const { owner, spaceId, token } = await sharedWithInvite();
		const member = await account();
		await acceptInvite(db, token, member.id, NOW);
		await leaveSpace(db, { spaceId, userId: member.id }, NOW);
		expect(await deleteAccount(db, owner.id, await proof(owner.email), NOW + 9)).toBe(true);
		// Nothing of the space is left: no space row, memberships (also the one who left), invites or audit rows.
		expect(await count('spaces where id = ?', spaceId)).toBe(0);
		expect(await count('space_members where space_id = ?', spaceId)).toBe(0);
		expect(await count('space_invites where space_id = ?', spaceId)).toBe(0);
		expect(await count('audit_events where space_id = ?', spaceId)).toBe(0);
		// Nobody reaches it any more, and its invite link is dead.
		const outsider = await account();
		expect(await resolveInvite(db, token, outsider.id, NOW)).toBeNull();
		await expect(requireSpaceAccess(db, member.id, spaceId)).rejects.toMatchObject({ status: 404 });
		// The member who left keeps their own account and personal space.
		expect((await requireSpaceAccess(db, member.id, member.personalId)).role).toBe('owner');
	});

	it('a shared space a non-owner was the last live member of is deleted too (L1)', async () => {
		const { owner, spaceId, token } = await sharedWithInvite();
		const member = await account();
		await acceptInvite(db, token, member.id, NOW);
		expect(await deleteAccount(db, owner.id, await proof(owner.email), NOW + 1)).toBe(true);
		expect((await requireSpaceAccess(db, member.id, spaceId)).role).toBe('owner');
		expect(await deleteAccount(db, member.id, await proof(member.email), NOW + 2)).toBe(true);
		expect(await count('spaces where id = ?', spaceId)).toBe(0);
		expect(await count('audit_events where space_id = ?', spaceId)).toBe(0);
	});

	it('a space someone joined after the deletion read its spaces is kept whole (race)', async () => {
		const { owner, spaceId, token } = await sharedWithInvite();
		const joiner = await account();
		await acceptInvite(db, token, joiner.id, NOW);
		// The pre-read as it was a moment earlier, when the owner was still the only member.
		const stale = vi
			.spyOn(db, 'all')
			.mockResolvedValueOnce([{ id: owner.personalId }, { id: spaceId }] as never);
		try {
			expect(await deleteAccount(db, owner.id, await proof(owner.email), NOW + 1)).toBe(true);
		} finally {
			stale.mockRestore();
		}
		expect(await count('spaces where id = ?', spaceId)).toBe(1);
		expect(await audits(spaceId, 'member_joined')).toBe(1);
		expect((await requireSpaceAccess(db, joiner.id, spaceId)).role).toBe('owner');
		expect(await count('spaces where id = ?', owner.personalId)).toBe(0);
	});

	it('a space someone else is still a live member of is never deleted', async () => {
		const { owner, spaceId, token } = await sharedWithInvite();
		const a = await account();
		const b = await account();
		await acceptInvite(db, token, a.id, NOW);
		await acceptInvite(db, token, b.id, NOW + 1);
		expect(await deleteAccount(db, a.id, await proof(a.email), NOW + 2)).toBe(true);
		expect(await count('spaces where id = ?', spaceId)).toBe(1);
		expect(await liveMembers(spaceId)).toBe(2);
		expect((await requireSpaceAccess(db, owner.id, spaceId)).role).toBe('owner');
		expect(await count('space_invites where space_id = ?', spaceId)).toBe(1);
	});
});
