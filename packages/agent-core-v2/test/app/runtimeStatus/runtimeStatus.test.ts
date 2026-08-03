/**
 * `runtimeStatus` domain (L2) — unit tests.
 *
 * Exercises RuntimeStatusService through InMemoryStorageService: the
 * working → resting → removed transition, latest-entry-wins per profile,
 * and write-failure tolerance (a failing store must never reject the
 * caller and is logged).
 */

import { describe, expect, it, vi } from 'vitest';

import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { RuntimeStatusService } from '#/app/runtimeStatus/runtimeStatusService';
import type { RuntimeStatusRaw } from '#/app/runtimeStatus/runtimeStatus';

// ---------------------------------------------------------------------------
// Build helpers
// ---------------------------------------------------------------------------

function logStub(warn: ReturnType<typeof vi.fn> = vi.fn()): any {
  return {
    error: vi.fn(),
    warn,
    info: vi.fn(),
    debug: vi.fn(),
    child: () => logStub(warn),
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RuntimeStatusService', () => {
  it('markWorking writes a working entry without restExpiresAt', async () => {
    const { storage, service } = buildRuntimeStatusService();
    await service.markWorking('coder', 'agent-1');

    const raw = await readRaw(storage);
    expect(raw?.['coder']).toMatchObject({
      state: 'working',
      agentId: 'agent-1',
      updatedAt: expect.any(String),
    });
    expect(raw?.['coder']?.restExpiresAt).toBeUndefined();
  });

  it('markResting writes a resting entry with restExpiresAt', async () => {
    const { storage, service } = buildRuntimeStatusService();
    await service.markResting('coder', 'agent-1', '2025-06-01T10:00:00.000Z');

    const raw = await readRaw(storage);
    expect(raw?.['coder']).toEqual({
      state: 'resting',
      agentId: 'agent-1',
      updatedAt: expect.any(String),
      restExpiresAt: '2025-06-01T10:00:00.000Z',
    });
  });

  it('working → resting → removed transition', async () => {
    const { storage, service } = buildRuntimeStatusService();
    await service.markWorking('coder', 'agent-1');
    expect((await readRaw(storage))?.['coder']?.state).toBe('working');

    await service.markResting('coder', 'agent-1', '2025-06-01T10:00:00.000Z');
    expect((await readRaw(storage))?.['coder']?.state).toBe('resting');

    await service.removeProfile('coder');
    const raw = await readRaw(storage);
    expect(raw?.['coder']).toBeUndefined();
  });

  it('keeps the latest entry per profile (latest instance wins)', async () => {
    const { storage, service } = buildRuntimeStatusService();
    await service.markWorking('coder', 'agent-1');
    await service.markWorking('coder', 'agent-2');

    const raw = await readRaw(storage);
    expect(Object.keys(raw ?? {})).toHaveLength(1);
    expect(raw?.['coder']?.agentId).toBe('agent-2');
  });

  it('removeProfile leaves other profiles untouched', async () => {
    const { storage, service } = buildRuntimeStatusService();
    await service.markWorking('coder', 'agent-1');
    await service.markWorking('reviewer', 'agent-2');
    await service.removeProfile('coder');

    const raw = await readRaw(storage);
    expect(raw?.['coder']).toBeUndefined();
    expect(raw?.['reviewer']).toMatchObject({ state: 'working', agentId: 'agent-2' });
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

    await expect(service.markWorking('coder', 'agent-1')).resolves.toBeUndefined();
    await expect(service.markResting('coder', 'agent-1', '2025-06-01T10:00:00.000Z')).resolves
      .toBeUndefined();
    await expect(service.removeProfile('coder')).resolves.toBeUndefined();
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

    await expect(service.markWorking('coder', 'agent-1')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('list returns the current table and is a pure read', async () => {
    const { service, storage } = buildRuntimeStatusService();
    expect(await service.list()).toEqual({});

    await service.markWorking('coder', 'agent-1');
    await service.markResting('reviewer', 'agent-2', '2025-06-01T10:00:00.000Z');
    const listed = await service.list();

    expect(listed['coder']).toMatchObject({ state: 'working', agentId: 'agent-1' });
    expect(listed['reviewer']).toMatchObject({
      state: 'resting',
      agentId: 'agent-2',
      restExpiresAt: '2025-06-01T10:00:00.000Z',
    });
    // A read must not mutate the stored document.
    const raw = await readRaw(storage);
    expect(raw).toEqual(listed);
    expect(Object.keys(listed)).toHaveLength(2);
  });
});
