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

  // ---------------------------------------------------------------------------
  // recordShift
  // ---------------------------------------------------------------------------

  it('recordShift records a shift and summary includes avgDurationMs', async () => {
    const svc = buildAgentPerformanceService();
    await svc.recordShift('coder', {
      startedAt: '2025-06-01T08:00:00.0Z',
      endedAt: '2025-06-01T10:00:00.0Z',
      durationMs: 7_200_000,
      workSummary: 'Reviewed 3 PRs',
      model: 'claude-3-opus',
    });

    // No entries yet → count is 0, but shift aggregates are still reported.
    const sum = await svc.summary('coder');
    expect(sum.count).toBe(0);
    expect(sum.avgDurationMs).toBe(7_200_000);
    // Model with shifts but no scores: counted, but no score average.
    expect(sum.byModel).toEqual({ 'claude-3-opus': { count: 1, average: undefined } });
  });

  it('recordShift FIFO caps at 50 shifts', async () => {
    const svc = buildAgentPerformanceService();
    // First record an entry so the profile exists and doesn't return { count: 0 }
    await svc.record({ ts: '2025-01-01T00:00:00.0Z', score: 80, note: 'seed', profileName: 'coder' });

    for (let i = 0; i < 60; i++) {
      await svc.recordShift('coder', {
        startedAt: `2025-06-01T${String(i).padStart(2, '0')}:00:00.0Z`,
        endedAt: `2025-06-01T${String(i).padStart(2, '0')}:30:00.0Z`,
        durationMs: 1_800_000,
        workSummary: `shift ${i}`,
      });
    }

    // Summary avgDurationMs should be based on 50 shifts
    const sum = await svc.summary('coder');
    expect(sum.count).toBe(1); // 1 entry (the seed)
    expect(sum.avgDurationMs).toBe(1_800_000);
  });

  it('recordShift co-exists with entries on the same profile', async () => {
    const svc = buildAgentPerformanceService();
    await svc.record({ ts: '2025-01-01T00:00:00.0Z', score: 70, note: 'entry-1', profileName: 'tester', model: 'gpt-4' });
    await svc.record({ ts: '2025-01-02T00:00:00.0Z', score: 90, note: 'entry-2', profileName: 'tester', model: 'gpt-4' });
    await svc.recordShift('tester', {
      startedAt: '2025-06-01T08:00:00.0Z',
      endedAt: '2025-06-01T10:00:00.0Z',
      durationMs: 7_200_000,
      workSummary: 'Morning review',
      model: 'gpt-4',
    });

    const sum = await svc.summary('tester');
    expect(sum.count).toBe(2);
    expect(sum.average).toBe(80);
    expect(sum.avgDurationMs).toBe(7_200_000);
    expect(sum.byModel).toBeDefined();
    const gpt4 = sum.byModel!['gpt-4']!;
    expect(gpt4.count).toBe(3);
    // average from entries only: (70+90)/2 = 80
    expect(gpt4.average).toBe(80);
  });

  // ---------------------------------------------------------------------------
  // Old-data compatibility — bucket without shifts
  // ---------------------------------------------------------------------------

  it('handles old buckets without shifts property', async () => {
    const storage = new InMemoryStorageService();
    const docStore = new JsonAtomicDocumentStore(storage);
    const logStub: any = {
      error: () => {}, warn: () => {}, info: () => {}, debug: () => {},
      child: () => logStub, setLevel: () => {}, level: 'debug' as const, flush: async () => {}, _serviceBrand: undefined,
    };
    const svc = new AgentPerformanceServiceImpl(docStore, logStub);

    // Manually inject a bucket without shifts (old format)
    await storage.write('agents', 'performance.json', new TextEncoder().encode(JSON.stringify({
      'tester': { entries: [{ profileName: 'tester', ts: '2025-01-01T00:00:00.0Z', score: 85, note: 'old entry' }] },
    })));

    const sum = await svc.summary('tester');
    expect(sum.count).toBe(1);
    expect(sum.average).toBe(85);
    expect(sum.avgDurationMs).toBeUndefined();
    expect(sum.byModel).toBeUndefined();

    // Now add a shift to the old bucket
    await svc.recordShift('tester', {
      startedAt: '2025-06-01T08:00:00.0Z',
      endedAt: '2025-06-01T10:00:00.0Z',
      durationMs: 7_200_000,
      workSummary: 'after-migration shift',
    });

    const sum2 = await svc.summary('tester');
    expect(sum2.count).toBe(1);
    expect(sum2.avgDurationMs).toBe(7_200_000);
  });

  // ---------------------------------------------------------------------------
  // avgDurationMs computation
  // ---------------------------------------------------------------------------

  it('avgDurationMs is correct from multiple shifts', async () => {
    const svc = buildAgentPerformanceService();
    await svc.record({ ts: '2025-01-01T00:00:00.0Z', score: 80, note: 's', profileName: 'p' });

    await svc.recordShift('p', {
      startedAt: 'a', endedAt: 'b', durationMs: 10_000, workSummary: 's1',
    });
    await svc.recordShift('p', {
      startedAt: 'c', endedAt: 'd', durationMs: 20_000, workSummary: 's2',
    });

    const sum = await svc.summary('p');
    expect(sum.avgDurationMs).toBe(15_000);
  });

  // recentShiftDurationMs — read-only "recent shift duration" for load-weighted
  // member selection (doctrine: "load (recent shift duration + concurrency)").

  it('recentShiftDurationMs returns undefined for a profile with no shifts', async () => {
    const svc = buildAgentPerformanceService();
    expect(await svc.recentShiftDurationMs('p')).toBeUndefined();
    await svc.record({ ts: '2025-01-01T00:00:00.0Z', score: 80, note: 's', profileName: 'p' });
    // Scores alone never fabricate a shift duration.
    expect(await svc.recentShiftDurationMs('p')).toBeUndefined();
  });

  it('recentShiftDurationMs returns the most recent shift duration (newest last)', async () => {
    const svc = buildAgentPerformanceService();
    await svc.recordShift('p', {
      startedAt: 'a', endedAt: 'b', durationMs: 10_000, workSummary: 's1',
    });
    await svc.recordShift('p', {
      startedAt: 'c', endedAt: 'd', durationMs: 20_000, workSummary: 's2',
    });
    await svc.recordShift('p', {
      startedAt: 'e', endedAt: 'f', durationMs: 35_000, workSummary: 's3',
    });
    // The FIFO bucket is trimmed oldest-first, so the tail is the most recent.
    expect(await svc.recentShiftDurationMs('p')).toBe(35_000);
  });

  it('recentShiftDurationMs stays correct after the FIFO trim', async () => {
    const svc = buildAgentPerformanceService();
    for (let i = 0; i < 55; i++) {
      await svc.recordShift('p', {
        startedAt: String(i), endedAt: String(i), durationMs: 1000 + i, workSummary: `s${i}`,
      });
    }
    // After the 50-shift trim the latest recorded shift is still the newest.
    expect(await svc.recentShiftDurationMs('p')).toBe(1000 + 54);
  });

  // ---------------------------------------------------------------------------
  // byModel aggregation
  // ---------------------------------------------------------------------------

  it('byModel groups entries and shifts by model correctly', async () => {
    const svc = buildAgentPerformanceService();
    await svc.record({ ts: '2025-01-01T00:00:00.0Z', score: 80, note: 'a', profileName: 'p', model: 'gpt-4' });
    await svc.record({ ts: '2025-01-02T00:00:00.0Z', score: 60, note: 'b', profileName: 'p', model: 'gpt-4' });
    await svc.record({ ts: '2025-01-03T00:00:00.0Z', score: 90, note: 'c', profileName: 'p', model: 'claude-3' });

    await svc.recordShift('p', {
      startedAt: 'a', endedAt: 'b', durationMs: 1000, workSummary: 'x', model: 'gpt-4',
    });
    await svc.recordShift('p', {
      startedAt: 'c', endedAt: 'd', durationMs: 2000, workSummary: 'y', model: 'claude-3',
    });

    const sum = await svc.summary('p');
    expect(sum.byModel).toBeDefined();
    const gpt4 = sum.byModel!['gpt-4']!;
    const claude = sum.byModel!['claude-3']!;
    // gpt-4: 2 entries + 1 shift, average = (80+60)/2 = 70
    expect(gpt4.count).toBe(3);
    expect(gpt4.average).toBe(70);
    // claude-3: 1 entry + 1 shift, average = 90/1 = 90
    expect(claude.count).toBe(2);
    expect(claude.average).toBe(90);
  });

  it('byModel is undefined when no entries or shifts have model', async () => {
    const svc = buildAgentPerformanceService();
    await svc.record({ ts: '2025-01-01T00:00:00.0Z', score: 80, note: 'a', profileName: 'p' });
    await svc.recordShift('p', {
      startedAt: 'a', endedAt: 'b', durationMs: 1000, workSummary: 'x',
    });

    const sum = await svc.summary('p');
    expect(sum.byModel).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // model field preservation in raw storage
  // ---------------------------------------------------------------------------

  it('record preserves model on each entry in raw storage', async () => {
    const storage2 = new InMemoryStorageService();
    const docStore2 = new JsonAtomicDocumentStore(storage2);
    const logStub2: any = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {},
      child: () => logStub2, setLevel: () => {}, level: 'debug' as const, flush: async () => {}, _serviceBrand: undefined };
    const svc = new AgentPerformanceServiceImpl(docStore2, logStub2);

    await svc.record({
      ts: '2025-06-01T00:00:00.0Z', score: 90, note: 'good',
      profileName: 'tester', model: 'claude-3-opus', agentId: 'agent_abc',
    });

    const raw = JSON.parse(new TextDecoder().decode(await storage2.read('agents', 'performance.json')!));
    expect(raw.tester.entries[0].model).toBe('claude-3-opus');
    expect(raw.tester.entries[0].agentId).toBe('agent_abc');
  });

  it('recordShift preserves shift fields in raw storage', async () => {
    const storage2 = new InMemoryStorageService();
    const docStore2 = new JsonAtomicDocumentStore(storage2);
    const logStub2: any = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {},
      child: () => logStub2, setLevel: () => {}, level: 'debug' as const, flush: async () => {}, _serviceBrand: undefined };
    const svc = new AgentPerformanceServiceImpl(docStore2, logStub2);

    await svc.recordShift('tester', {
      startedAt: '2025-06-01T08:00:00.0Z',
      endedAt: '2025-06-01T10:00:00.0Z',
      durationMs: 7_200_000,
      workSummary: 'Reviewed PRs',
      model: 'gpt-4',
      concurrency: 3,
      agentId: 'agent_xyz',
      sessionId: 'sess_001',
    });

    const raw = JSON.parse(new TextDecoder().decode(await storage2.read('agents', 'performance.json')!));
    expect(raw.tester.shifts).toHaveLength(1);
    expect(raw.tester.shifts[0].startedAt).toBe('2025-06-01T08:00:00.0Z');
    expect(raw.tester.shifts[0].durationMs).toBe(7_200_000);
    expect(raw.tester.shifts[0].workSummary).toBe('Reviewed PRs');
    expect(raw.tester.shifts[0].model).toBe('gpt-4');
    expect(raw.tester.shifts[0].concurrency).toBe(3);
    expect(raw.tester.shifts[0].agentId).toBe('agent_xyz');
    expect(raw.tester.shifts[0].sessionId).toBe('sess_001');
  });

  // ---------------------------------------------------------------------------
  // TeamScore schema — model field
  // ---------------------------------------------------------------------------

  it('model is optional at TeamScore schema level (field absent)', async () => {
    const parsed = await TeamScoreToolInputSchema.safeParseAsync({ profile: 'a', score: 50, note: 'b' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.model).toBeUndefined();
    }
  });

  it('model accepts a string when provided in TeamScore schema', async () => {
    const parsed = await TeamScoreToolInputSchema.safeParseAsync({ profile: 'a', score: 50, note: 'b', model: 'claude-3-opus' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.model).toBe('claude-3-opus');
    }
  });

  // ---------------------------------------------------------------------------
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
