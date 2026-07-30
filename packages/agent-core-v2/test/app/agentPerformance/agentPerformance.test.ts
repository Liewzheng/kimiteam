/**
 * `agentPerformance` domain (L2) — unit / integration tests.
 *
 * Exercises AgentPerformanceServiceImpl through InMemoryStorageService, and
 * validates the TeamScoreToolInputSchema zod boundary at runtime.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';

// IAgentPerformanceService is imported from the interface source so we get the full
// decorator value + interface (verbatimModuleSyntax allows importing a const directly).
import { IAgentPerformanceService } from '#/app/agentPerformance/agentPerformance';
import type { ProfilePerformanceEntry } from '#/app/agentPerformance/agentPerformance';
import { AgentPerformanceServiceImpl } from '#/app/agentPerformance/agentPerformanceService';
import { TeamScoreToolInputSchema } from '#/agent/tools/team-score/team-score';

// ---------------------------------------------------------------------------
// Build helper — creates a service backed by *isolated* InMemoryStorageService.
// Each call gets fresh storage; no state leaks across test calls.
// ---------------------------------------------------------------------------

function buildAgentPerformanceService(): IAgentPerformanceService {
  const storage = new InMemoryStorageService();
  const docStore = new JsonAtomicDocumentStore(storage);
  const logStub: any = {
    error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, child: () => logStub,
    setLevel: () => {}, level: 'debug' as const, flush: async () => {}, _serviceBrand: undefined,
  };

  return new AgentPerformanceServiceImpl(docStore, logStub);
}

function findProfileName(list: ProfilePerformanceEntry[], name: string): number {
  const idx = list.findIndex((e) => e.profileName === name);
  return idx;
}

// ---------------------------------------------------------------------------
// Test suite
// -----------------------------------------------------------------------

describe('AgentPerformanceServiceImpl', () => {
  const disposables = new DisposableStore();
  afterEach(() => disposables.dispose());

  // record + summary round-trip

  it('records a score and returns correct summary', async () => {
    const svc = buildAgentPerformanceService();
    await svc.record({
      ts: '2025-01-01T00:00:00.0Z',
      score: 80,
      note: 'good work',
      profileName: 'tester',
    });

    const sum = await svc.summary('tester');
    expect(sum.average).toBe(80);
    expect(sum.last).toBe(80);
    expect(sum.count).toBe(1);
  });

  it('list returns a single profile after one record', async () => {
    const svc = buildAgentPerformanceService();
    await svc.record({ ts: '2025-01-01T00:00:00.0Z', score: 70, note: 'ok', profileName: 'coder' });

    const list = await svc.list();
    expect(list).toHaveLength(1);
    expect(findProfileName(list, 'coder')).toBe(0);
    expect(list.at(0)!.summary.count).toBe(1);
  });

  // Multiple scores

  it('averages two scores (exact)', async () => {
    const svc = buildAgentPerformanceService();
    await svc.record({ ts: '2025-01-01T00:00:00.0Z', score: 70, note: 'n1', profileName: 'coder' });
    await svc.record({ ts: '2025-01-02T00:00:00.0Z', score: 90, note: 'n2', profileName: 'coder' });

    const sum = await svc.summary('coder');
    expect(sum.average).toBe(80);
    expect(sum.count).toBe(2);
  });

  it('averages three scores (exact)', async () => {
    const svc = buildAgentPerformanceService();
    await svc.record({ ts: '2025-01-01T00:00:00.0Z', score: 62, note: 'n1', profileName: 'coder' });
    await svc.record({ ts: '2025-01-02T00:00:00.0Z', score: 73, note: 'n2', profileName: 'coder' });
    await svc.record({ ts: '2025-01-03T00:00:00.0Z', score: 45, note: 'n3', profileName: 'coder' });

    const sum = await svc.summary('coder');
    expect(sum.average).toBe(60);
    expect(sum.last).toBe(45);
    expect(sum.count).toBe(3);
  });

  it('averages produce correct rounding for non-roundable averages', async () => {
    const svc = buildAgentPerformanceService();
    await svc.record({ ts: '2025-01-01T00:00:00.0Z', score: 90, note: 'n1', profileName: 'x' });
    await svc.record({ ts: '2025-01-02T00:00:00.0Z', score: 85, note: 'n2', profileName: 'x' });

    const sum = await svc.summary('x');
    expect(sum.average).toBe(87.5);
  });

  // FIFO eviction at 50 entries

  it('evicts oldest entries when a single profile exceeds 50', async () => {
    const svc = buildAgentPerformanceService();
    for (let i = 0; i < 60; i++) {
      await svc.record({ ts: `2025-01-${String(i).padStart(2, '0')}T06:00:00.0Z`, score: i, note: `${i}`, profileName: 'tester' });
    }

    const list = await svc.list();
    const entry = list.find((e) => e.profileName === 'tester');
    expect(entry!.summary.count).toBe(50);
  });

  it('FIFO keeps most recent 50 entries for summary math', async () => {
    const svc = buildAgentPerformanceService();
    for (let i = 0; i < 60; i++) {
      await svc.record({ ts: `2025-01-01T${String(i).padStart(2, '0')}:00:00.0Z`, score: i, note: `${i}`, profileName: 'coder' });
    }

    const sum = await svc.summary('coder');
    expect(sum.count).toBe(50);
    expect(sum.last).toBe(59);
  });

  // Corrupt / unknown data degradation

  it('summary on unknown profile returns { count: 0 }', async () => {
    const svc = buildAgentPerformanceService();
    const sum = await svc.summary('nonexistent');
    expect(sum.count).toBe(0);
    expect(sum.last).toBeUndefined();
    expect(sum.average).toBeUndefined();
  });

  it('list is empty on first use (no stored document)', async () => {
    const svc = buildAgentPerformanceService();
    const list = await svc.list();
    expect(list).toHaveLength(0);
  });

  // Optional fields: agentId and sessionId preserved

  it('record preserves optional agentId on each entry', async () => {
    const storage2 = new InMemoryStorageService();
    const docStore2 = new JsonAtomicDocumentStore(storage2);
    const logStub2: any = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {},
      child: () => logStub2, setLevel: () => {}, level: 'debug' as const, flush: async () => {}, _serviceBrand: undefined };
    const svc = new AgentPerformanceServiceImpl(docStore2, logStub2);

    await svc.record({ ts: '2025-03-10T15:00:00.0Z', score: 95, note: 'test entry with ids', profileName: 'tester', agentId: 'agent_abc789' });

    const raw = JSON.parse(new TextDecoder().decode(await storage2.read('agents', 'performance.json')!));
    expect(raw.tester.entries[0].profileName).toBe('tester');
    expect(raw.tester.entries[0].agentId).toBe('agent_abc789');
  });

  // Multiple profiles in list()

  it('list returns each profile separately', async () => {
    const svc = buildAgentPerformanceService();
    await svc.record({ ts: '2025-01-01T00:00:00.0Z', score: 80, note: 'a', profileName: 'coder' });
    await svc.record({ ts: '2025-01-01T00:00:00.0Z', score: 60, note: 'b', profileName: 'tester' });

    const list = await svc.list();
    expect(list).toHaveLength(2);
    const coder = list.filter((e) => e.profileName === 'coder');
    const tester = list.filter((e) => e.profileName === 'tester');
    expect(coder.length).toBe(1);
    expect(tester.length).toBe(1);
  });

  // Zod input boundary (TeamScoreToolInputSchema)

  it('rejects score < 0', async () => {
    const result = TeamScoreToolInputSchema.safeParse({ profile: 'a', score: -1, note: 'b' });
    expect(result.success).toBe(false);
  });

  it('rejects score > 100', async () => {
    const result = await TeamScoreToolInputSchema.safeParseAsync({ profile: 'a', score: 101, note: 'b' });
    expect(result.success).toBe(false);
  });

  it('rejects empty string for profile (trim → min(1))', async () => {
    const result = await TeamScoreToolInputSchema.safeParseAsync({ profile: '   ', score: 50, note: 'b' });
    expect(result.success).toBe(false);
  });

  it('trims and accepts valid input', async () => {
    const parsed = await TeamScoreToolInputSchema.safeParseAsync({ profile: ' coder ', score: 80, note: ' nice one ' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.profile).toBe('coder');
      expect(parsed.data.note).toBe('nice one');
    }
  });

  it('agent_id is optional at schema level (field absent)', async () => {
    const parsed = await TeamScoreToolInputSchema.safeParseAsync({ profile: 'a', score: 50, note: 'b' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.agent_id).toBeUndefined();
    }
  });

  it('agent_id accepts a string when provided', async () => {
    const parsed = await TeamScoreToolInputSchema.safeParseAsync({ profile: 'a', score: 50, note: 'b', agent_id: 'agent_123' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.agent_id).toBe('agent_123');
    }
  });

  it('creates correct document structure in store', async () => {
    const svc = buildAgentPerformanceService();
    await svc.record({ ts: '2025-04-01T12:30:00.0Z', score: 100, note: 'perfect', profileName: 'reviewer' });

    const sum = await svc.summary('reviewer');
    expect(sum.count).toBe(1);
    expect(sum.last).toBe(100);
    expect(sum.average).toBe(100);
  });
});
