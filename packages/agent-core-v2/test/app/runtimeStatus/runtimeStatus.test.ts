/**
 * `runtimeStatus` domain (L2) — unit tests.
 *
 * Exercises RuntimeStatusService through InMemoryStorageService: the
 * working → resting → removed transition, latest-entry-wins per session,
 * per-session isolation (two sessions tracking the same profile never
 * clobber each other), the per-session write-order guard (a stale resting
 * settle from a superseded instance is dropped), legacy bare-key handling,
 * and write-failure tolerance (a failing store must never reject the
 * caller and is logged).
 */

import { describe, expect, it, vi } from 'vitest';

import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { RuntimeStatusService } from '#/app/runtimeStatus/runtimeStatusService';
import {
  buildRosterSnapshot,
  deriveRosterStatus,
  type RuntimeStatusRaw,
  type RosterSnapshot,
} from '#/app/runtimeStatus/runtimeStatus';

// ---------------------------------------------------------------------------
// Build helpers
// ---------------------------------------------------------------------------

function logStub(
  warn: ReturnType<typeof vi.fn> = vi.fn(),
  debug: ReturnType<typeof vi.fn> = vi.fn(),
): any {
  return {
    error: vi.fn(),
    warn,
    info: vi.fn(),
    debug,
    child: () => logStub(warn, debug),
    setLevel: vi.fn(),
    level: 'debug' as const,
    flush: async () => {},
    _serviceBrand: undefined,
  };
}

function buildRuntimeStatusService(): {
  storage: InMemoryStorageService;
  service: RuntimeStatusService;
  warn: ReturnType<typeof vi.fn>;
} {
  const storage = new InMemoryStorageService();
  const docStore = new JsonAtomicDocumentStore(storage);
  const warn = vi.fn();
  const service = new RuntimeStatusService(docStore, logStub(warn));
  return { storage, service, warn };
}

async function readRaw(storage: InMemoryStorageService): Promise<RuntimeStatusRaw | undefined> {
  const bytes = await storage.read('agents', 'runtime-status.json');
  if (bytes === undefined) return undefined;
  return JSON.parse(new TextDecoder().decode(bytes)) as RuntimeStatusRaw;
}

const SESSION_A = 'session-a';
const SESSION_B = 'session-b';

/** The persisted document key for one session's profile entry. */
function key(sessionId: string, profileName: string): string {
  return `${sessionId}:${profileName}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RuntimeStatusService', () => {
  it('markWorking writes a working entry without restExpiresAt', async () => {
    const { storage, service } = buildRuntimeStatusService();
    await service.markWorking(SESSION_A, 'coder', 'agent-1');

    const raw = await readRaw(storage);
    expect(raw?.[key(SESSION_A, 'coder')]).toMatchObject({
      state: 'working',
      agentId: 'agent-1',
      updatedAt: expect.any(String),
    });
    expect(raw?.[key(SESSION_A, 'coder')]?.restExpiresAt).toBeUndefined();
  });

  it('markResting writes a resting entry with restExpiresAt', async () => {
    const { storage, service } = buildRuntimeStatusService();
    await service.markResting(SESSION_A, 'coder', 'agent-1', '2025-06-01T10:00:00.000Z');

    const raw = await readRaw(storage);
    expect(raw?.[key(SESSION_A, 'coder')]).toEqual({
      state: 'resting',
      agentId: 'agent-1',
      updatedAt: expect.any(String),
      restExpiresAt: '2025-06-01T10:00:00.000Z',
    });
  });

  it('working → resting → removed transition', async () => {
    const { storage, service } = buildRuntimeStatusService();
    await service.markWorking(SESSION_A, 'coder', 'agent-1');
    expect((await readRaw(storage))?.[key(SESSION_A, 'coder')]?.state).toBe('working');

    await service.markResting(SESSION_A, 'coder', 'agent-1', '2025-06-01T10:00:00.000Z');
    expect((await readRaw(storage))?.[key(SESSION_A, 'coder')]?.state).toBe('resting');

    await service.removeProfile(SESSION_A, 'coder');
    const raw = await readRaw(storage);
    expect(raw?.[key(SESSION_A, 'coder')]).toBeUndefined();
  });

  it('keeps the latest entry per session+profile (latest instance wins)', async () => {
    const { storage, service } = buildRuntimeStatusService();
    await service.markWorking(SESSION_A, 'coder', 'agent-1');
    await service.markWorking(SESSION_A, 'coder', 'agent-2');

    const raw = await readRaw(storage);
    expect(Object.keys(raw ?? {})).toHaveLength(1);
    expect(raw?.[key(SESSION_A, 'coder')]?.agentId).toBe('agent-2');
  });

  it('isolates entries per session: the same profile in two sessions never clobbers', async () => {
    const { storage, service } = buildRuntimeStatusService();
    await service.markWorking(SESSION_A, 'coder', 'agent-a1');
    await service.markWorking(SESSION_B, 'coder', 'agent-b1');

    const raw = await readRaw(storage);
    expect(Object.keys(raw ?? {})).toHaveLength(2);
    expect(raw?.[key(SESSION_A, 'coder')]).toMatchObject({ state: 'working', agentId: 'agent-a1' });
    expect(raw?.[key(SESSION_B, 'coder')]).toMatchObject({ state: 'working', agentId: 'agent-b1' });

    // Session A settling its instance must not touch session B's entry — the
    // pre-isolation bug surfaced a resting state into the other session.
    await service.markResting(SESSION_A, 'coder', 'agent-a1', '2025-06-01T10:00:00.000Z');
    const after = await readRaw(storage);
    expect(after?.[key(SESSION_A, 'coder')]).toMatchObject({ state: 'resting', agentId: 'agent-a1' });
    expect(after?.[key(SESSION_B, 'coder')]).toMatchObject({ state: 'working', agentId: 'agent-b1' });
  });

  it('drops a stale resting write from a superseded instance (cross-instance overlap)', async () => {
    const storage = new InMemoryStorageService();
    const docStore = new JsonAtomicDocumentStore(storage);
    const warn = vi.fn();
    const debug = vi.fn();
    const service = new RuntimeStatusService(docStore, logStub(warn, debug));

    // A newer run on agent-2 takes over the profile while the old agent-1 run
    // is still finishing; then agent-1 settles late (the write-order race).
    await service.markWorking(SESSION_A, 'coder', 'agent-1');
    await service.markWorking(SESSION_A, 'coder', 'agent-2');
    await service.markResting(SESSION_A, 'coder', 'agent-1', '2025-06-01T10:00:00.000Z');

    // The panel must keep showing the live run — not the stale settle.
    const raw = await readRaw(storage);
    expect(raw?.[key(SESSION_A, 'coder')]).toMatchObject({ state: 'working', agentId: 'agent-2' });
    expect(raw?.[key(SESSION_A, 'coder')]?.restExpiresAt).toBeUndefined();
    expect(debug).toHaveBeenCalledWith(
      'runtime-status: stale resting write dropped (superseded by a newer instance)',
      expect.objectContaining({ sessionId: SESSION_A, profileName: 'coder', agentId: 'agent-1', currentAgentId: 'agent-2' }),
    );
  });

  it('applies a resting write when the settling instance still owns the entry (normal settle)', async () => {
    const { storage, service } = buildRuntimeStatusService();
    await service.markWorking(SESSION_A, 'coder', 'agent-1');
    await service.markResting(SESSION_A, 'coder', 'agent-1', '2025-06-01T10:00:00.000Z');

    const raw = await readRaw(storage);
    expect(raw?.[key(SESSION_A, 'coder')]).toEqual({
      state: 'resting',
      agentId: 'agent-1',
      updatedAt: expect.any(String),
      restExpiresAt: '2025-06-01T10:00:00.000Z',
    });
  });

  it('markWorking is idempotent for the already-working same instance (no redundant write)', async () => {
    const storage = new InMemoryStorageService();
    const docStore = new JsonAtomicDocumentStore(storage);
    const setSpy = vi.spyOn(docStore, 'set');
    const service = new RuntimeStatusService(docStore, logStub());

    await service.markWorking(SESSION_A, 'coder', 'agent-1');
    setSpy.mockClear();
    await service.markWorking(SESSION_A, 'coder', 'agent-1');

    expect(setSpy).not.toHaveBeenCalled();
    const after = (await readRaw(storage))![key(SESSION_A, 'coder')]!;
    expect(after).toMatchObject({ state: 'working', agentId: 'agent-1' });
  });

  it('markWorking supersedes a working entry from another instance and a resting entry', async () => {
    const { storage, service } = buildRuntimeStatusService();
    await service.markWorking(SESSION_A, 'coder', 'agent-1');
    await service.markWorking(SESSION_A, 'coder', 'agent-2');
    expect((await readRaw(storage))?.[key(SESSION_A, 'coder')]).toMatchObject({ state: 'working', agentId: 'agent-2' });

    await service.markResting(SESSION_A, 'coder', 'agent-2', '2025-06-01T10:00:00.000Z');
    await service.markWorking(SESSION_A, 'coder', 'agent-3');
    expect((await readRaw(storage))?.[key(SESSION_A, 'coder')]).toMatchObject({ state: 'working', agentId: 'agent-3' });
  });

  it('a stale resting write never downgrades an entry whose owner changed mid-flight', async () => {
    const { storage, service } = buildRuntimeStatusService();
    // Same shape as the panel bug: working(A) → working(B) → resting(A).
    await service.markWorking(SESSION_A, 'coder', 'agent-a');
    await service.markWorking(SESSION_A, 'coder', 'agent-b');
    await service.markResting(SESSION_A, 'coder', 'agent-a', '2025-06-01T10:00:00.000Z');

    const snap = await service.roster(SESSION_A, 900_000, Date.parse('2025-06-01T10:00:00.000Z'));
    expect(snap.working.map((m) => m.profileName)).toEqual(['coder']);
    expect(snap.resting).toHaveLength(0);
    expect(snap.offDuty).toHaveLength(0);
  });

  it('removeProfile leaves other profiles untouched', async () => {
    const { storage, service } = buildRuntimeStatusService();
    await service.markWorking(SESSION_A, 'coder', 'agent-1');
    await service.markWorking(SESSION_A, 'reviewer', 'agent-2');
    await service.removeProfile(SESSION_A, 'coder');

    const raw = await readRaw(storage);
    expect(raw?.[key(SESSION_A, 'coder')]).toBeUndefined();
    expect(raw?.[key(SESSION_A, 'reviewer')]).toMatchObject({ state: 'working', agentId: 'agent-2' });
  });

  it('tolerates a failed write: resolves and logs a warning (never rejects)', async () => {
    const failingStore = {
      get: async () => undefined,
      set: async () => {
        throw new Error('disk full');
      },
      delete: async () => {},
      list: async () => [],
    } as unknown as IAtomicDocumentStore;
    const warn = vi.fn();
    const service = new RuntimeStatusService(failingStore, logStub(warn));

    await expect(service.markWorking(SESSION_A, 'coder', 'agent-1')).resolves.toBeUndefined();
    await expect(service.markResting(SESSION_A, 'coder', 'agent-1', '2025-06-01T10:00:00.000Z')).resolves
      .toBeUndefined();
    await expect(service.removeProfile(SESSION_A, 'coder')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('tolerates a corrupt stored document (degrades to empty, logs a warning)', async () => {
    const storage = new InMemoryStorageService();
    await storage.write(
      'agents',
      'runtime-status.json',
      new TextEncoder().encode('{not json'),
    );
    const docStore = new JsonAtomicDocumentStore(storage);
    const warn = vi.fn();
    const service = new RuntimeStatusService(docStore, logStub(warn));

    await expect(service.markWorking(SESSION_A, 'coder', 'agent-1')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('list returns the current full table (session-prefixed keys) and is a pure read', async () => {
    const { service, storage } = buildRuntimeStatusService();
    expect(await service.list()).toEqual({});

    await service.markWorking(SESSION_A, 'coder', 'agent-1');
    await service.markResting(SESSION_A, 'reviewer', 'agent-2', '2025-06-01T10:00:00.000Z');
    const listed = await service.list();

    expect(listed[key(SESSION_A, 'coder')]).toMatchObject({ state: 'working', agentId: 'agent-1' });
    expect(listed[key(SESSION_A, 'reviewer')]).toMatchObject({
      state: 'resting',
      agentId: 'agent-2',
      restExpiresAt: '2025-06-01T10:00:00.000Z',
    });
    // A read must not mutate the stored document.
    const raw = await readRaw(storage);
    expect(raw).toEqual(listed);
    expect(Object.keys(listed)).toHaveLength(2);
  });

  it('listForSession returns only that session’s entries, profile-keyed', async () => {
    const { service, storage } = buildRuntimeStatusService();
    await service.markWorking(SESSION_A, 'coder', 'agent-a1');
    await service.markResting(SESSION_B, 'coder', 'agent-b1', '2025-06-01T10:00:00.000Z');
    await service.markWorking(SESSION_B, 'reviewer', 'agent-b2');

    const tableA = await service.listForSession(SESSION_A);
    expect(tableA).toEqual({
      coder: expect.objectContaining({ state: 'working', agentId: 'agent-a1' }),
    });
    const tableB = await service.listForSession(SESSION_B);
    expect(Object.keys(tableB).sort()).toEqual(['coder', 'reviewer']);
    expect(tableB['coder']).toMatchObject({ state: 'resting', agentId: 'agent-b1' });

    // Unknown session → empty, never another session's entries.
    expect(await service.listForSession('session-none')).toEqual({});
    // The read must not mutate the stored document.
    expect(Object.keys((await readRaw(storage)) ?? {})).toHaveLength(3);
  });

  it('ignores pre-isolation legacy bare keys in listForSession but keeps them in list', async () => {
    const { service, storage } = buildRuntimeStatusService();
    // Simulate an upgraded document: a legacy bare `profileName` key with no
    // session prefix, plus a session-scoped entry.
    await storage.write(
      'agents',
      'runtime-status.json',
      new TextEncoder().encode(
        JSON.stringify({
          coder: { state: 'resting', agentId: 'agent-old', updatedAt: '2025-06-01T08:00:00.000Z', restExpiresAt: '2025-06-01T20:00:00.000Z' },
          [key(SESSION_A, 'coder')]: { state: 'working', agentId: 'agent-a1', updatedAt: '2025-06-01T09:00:00.000Z' },
        }),
      ),
    );

    // The legacy entry carries no session ownership — never surfaced to any
    // session's panel (would re-introduce cross-session bleed).
    const tableA = await service.listForSession(SESSION_A);
    expect(Object.keys(tableA)).toEqual(['coder']);
    expect(tableA['coder']).toMatchObject({ state: 'working', agentId: 'agent-a1' });

    // The full table still exposes the legacy key for the agent-id cold-resume
    // scan (a globally-unique agentId makes the match exact).
    const full = await service.list();
    expect(full['coder']).toMatchObject({ agentId: 'agent-old' });
    expect(Object.keys(full)).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Derived `standby` state + roster snapshot
  // -------------------------------------------------------------------------

  it('deriveRosterStatus: working stays working, resting settled inside the keepalive window is standby', () => {
    const now = Date.parse('2025-06-01T10:00:00.000Z');
    const window = 900_000; // 15 min

    expect(
      deriveRosterStatus({ state: 'working', agentId: 'a', updatedAt: new Date(now).toISOString() }, now, window),
    ).toBe('working');
    // Settled 8 min ago — within the 15 min window → standby (fresh, warm cache).
    expect(
      deriveRosterStatus(
        { state: 'resting', agentId: 'a', updatedAt: new Date(now - 8 * 60_000).toISOString(), restExpiresAt: new Date(now + 2 * 60 * 60_000).toISOString() },
        now,
        window,
      ),
    ).toBe('standby');
    // Boundary: settled exactly `window` ago is still standby (inclusive).
    expect(
      deriveRosterStatus(
        { state: 'resting', agentId: 'a', updatedAt: new Date(now - window).toISOString(), restExpiresAt: new Date(now + 2 * 60 * 60_000).toISOString() },
        now,
        window,
      ),
    ).toBe('standby');
  });

  it('deriveRosterStatus: resting settled beyond the keepalive window is resting', () => {
    const now = Date.parse('2025-06-01T10:00:00.000Z');
    const window = 900_000;
    // Settled 30 min ago — beyond the 15 min window → plain resting.
    expect(
      deriveRosterStatus(
        { state: 'resting', agentId: 'a', updatedAt: new Date(now - 30 * 60_000).toISOString(), restExpiresAt: new Date(now + 2 * 60 * 60_000).toISOString() },
        now,
        window,
      ),
    ).toBe('resting');
  });

  it('deriveRosterStatus: a zero-length window never derives standby', () => {
    const now = Date.parse('2025-06-01T10:00:00.000Z');
    expect(
      deriveRosterStatus(
        { state: 'resting', agentId: 'a', updatedAt: new Date(now - 60_000).toISOString(), restExpiresAt: new Date(now + 2 * 60 * 60_000).toISOString() },
        now,
        0,
      ),
    ).toBe('resting');
  });

  it('deriveRosterStatus: expired or corrupt resting entries are off-duty', () => {
    const now = Date.parse('2025-06-01T10:00:00.000Z');
    const window = 900_000;
    // Expired horizon → off duty (pending reap); expiry wins over freshness.
    expect(
      deriveRosterStatus(
        { state: 'resting', agentId: 'a', updatedAt: new Date(now - 60_000).toISOString(), restExpiresAt: new Date(now - 60_000).toISOString() },
        now,
        window,
      ),
    ).toBe('off-duty');
    // Settled within the window but already expired → still off duty.
    expect(
      deriveRosterStatus(
        { state: 'resting', agentId: 'a', updatedAt: new Date(now - 60_000).toISOString(), restExpiresAt: new Date(now - 1).toISOString() },
        now,
        window,
      ),
    ).toBe('off-duty');
    // Missing / unparseable restExpiresAt → off duty (malformed resting).
    expect(
      deriveRosterStatus({ state: 'resting', agentId: 'a', updatedAt: new Date(now - 60_000).toISOString() }, now, window),
    ).toBe('off-duty');
    expect(
      deriveRosterStatus({ state: 'resting', agentId: 'a', updatedAt: new Date(now - 60_000).toISOString(), restExpiresAt: 'not-a-date' }, now, window),
    ).toBe('off-duty');
    // Corrupt settle time (unparseable updatedAt) → off duty.
    expect(
      deriveRosterStatus(
        { state: 'resting', agentId: 'a', updatedAt: 'not-a-date', restExpiresAt: new Date(now + 2 * 60 * 60_000).toISOString() },
        now,
        window,
      ),
    ).toBe('off-duty');
    // Absent profile → off duty by absence.
    expect(deriveRosterStatus(undefined, now, window)).toBe('off-duty');
  });

  it('buildRosterSnapshot groups profiles by derived status, profile-name sorted', () => {
    const now = Date.parse('2025-06-01T10:00:00.000Z');
    const window = 900_000;
    const raw: RuntimeStatusRaw = {
      reviewer: { state: 'resting', agentId: 'a2', updatedAt: new Date(now - 30 * 60_000).toISOString(), restExpiresAt: new Date(now + 2 * 60 * 60_000).toISOString() }, // settled beyond window → resting
      coder: { state: 'working', agentId: 'a1', updatedAt: new Date(now - 60_000).toISOString() }, // working
      explorer: { state: 'resting', agentId: 'a3', updatedAt: new Date(now - 5 * 60_000).toISOString(), restExpiresAt: new Date(now + 2 * 60 * 60_000).toISOString() }, // settled within window → standby
      stale: { state: 'resting', agentId: 'a4', updatedAt: new Date(now - 60_000).toISOString(), restExpiresAt: new Date(now - 60_000).toISOString() }, // expired → off-duty
    };

    const snap = buildRosterSnapshot(raw, now, window);
    expect(snap.at).toBe(new Date(now).toISOString());
    expect(snap.standbyKeepaliveMs).toBe(window);
    expect(snap.working.map((m) => m.profileName)).toEqual(['coder']);
    expect(snap.standby.map((m) => m.profileName)).toEqual(['explorer']);
    expect(snap.resting.map((m) => m.profileName)).toEqual(['reviewer']);
    expect(snap.offDuty.map((m) => m.profileName)).toEqual(['stale']);
    // Members + status map cover every present profile, sorted.
    expect(snap.members.map((m) => m.profileName)).toEqual(['coder', 'explorer', 'reviewer', 'stale']);
    expect(snap.statusByProfile).toEqual({
      coder: 'working',
      explorer: 'standby',
      reviewer: 'resting',
      stale: 'off-duty',
    });
    // Each member carries its raw entry.
    expect(snap.standby[0]?.entry?.agentId).toBe('a3');
  });

  it('roster() reads the session table and returns a snapshot without mutating storage', async () => {
    const { service, storage } = buildRuntimeStatusService();
    const now = Date.now();
    await service.markWorking(SESSION_A, 'coder', 'agent-1');
    // markResting writes updatedAt = real now; pass a slightly later roster
    // clock so the freshly settled explorer lands inside the keepalive window.
    await service.markResting(SESSION_A, 'explorer', 'agent-3', new Date(now + 5 * 60_000).toISOString());

    const snap: RosterSnapshot = await service.roster(SESSION_A, 900_000, now + 60_000);
    expect(snap.working.map((m) => m.profileName)).toEqual(['coder']);
    expect(snap.standby.map((m) => m.profileName)).toEqual(['explorer']);
    expect(snap.offDuty).toHaveLength(0);

    // The read must not write/repair the stored document.
    const raw = await readRaw(storage);
    expect(raw?.[key(SESSION_A, 'coder')]).toMatchObject({ state: 'working' });
    expect(raw?.[key(SESSION_A, 'explorer')]).toMatchObject({ state: 'resting' });
  });

  it('roster() is session-scoped: another session’s entries never leak in', async () => {
    const { service } = buildRuntimeStatusService();
    const now = Date.now();
    await service.markWorking(SESSION_A, 'coder', 'agent-a1');
    await service.markResting(SESSION_B, 'coder', 'agent-b1', new Date(now + 5 * 60_000).toISOString());

    const snapA = await service.roster(SESSION_A, 900_000, now + 60_000);
    expect(snapA.working.map((m) => m.profileName)).toEqual(['coder']);
    expect(snapA.offDuty).toHaveLength(0);

    const snapB = await service.roster(SESSION_B, 900_000, now + 60_000);
    // Freshly settled within the keepalive window → derived standby (same as
    // the roster() snapshot test); the point here is isolation, not the
    // standby derivation.
    expect(snapB.standby.map((m) => m.profileName)).toEqual(['coder']);
    expect(snapB.working).toHaveLength(0);

    // A session with no entries derives an empty roster — not a view of others.
    const snapNone = await service.roster('session-none', 900_000, now + 60_000);
    expect(snapNone.members).toEqual([]);
  });

  it('roster() degrades to an empty snapshot when the table is empty', async () => {
    const { service } = buildRuntimeStatusService();
    const snap = await service.roster(SESSION_A, 900_000, Date.parse('2025-06-01T10:00:00.000Z'));
    expect(snap.members).toEqual([]);
    expect(snap.working).toEqual([]);
    expect(snap.standby).toEqual([]);
    expect(snap.resting).toEqual([]);
    expect(snap.offDuty).toEqual([]);
    expect(snap.statusByProfile).toEqual({});
  });
});
