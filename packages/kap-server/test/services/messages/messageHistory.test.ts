/**
 * `services/messages/messageHistory` P0-3 — transcript cache + tail reads.
 *
 * Covers the three performance guarantees:
 *   1. tail read returns the correct page count (absolute indices preserved);
 *   2. blob rehydration loads only the returned page (spy on `loadParts`);
 *   3. the page cache hits when the journal is unchanged and updates
 *      incrementally (only the appended tail bytes) when new messages land.
 *
 * The cache is exercised directly against a temp-dir `wire.jsonl` so the
 * incremental/rewrite/eviction paths are asserted without a full server. The
 * cache's file reads are injected as spies so "only the appended tail bytes
 * were read" is asserted without touching `node:fs` internals.
 */

import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IAgentBlobService,
  IAgentContextMemoryService,
  IWireService,
  type ContextMessage,
  type IAgentScopeHandle,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MessageHistoryCache } from '../../../src/services/messages/messageHistoryCache';
import { loadMessageHistory } from '../../../src/services/messages/messageHistory';

/** One `context.append_message` wire record (the common journal record). */
function appendRecord(text: string, index: number): string {
  return JSON.stringify({
    type: 'context.append_message',
    message: { role: 'user', content: [{ type: 'text', text }], toolCalls: [] },
    time: 1_700_000_000_000 + index,
  });
}

/** Write a fresh wire journal for one session and return its path. */
async function writeJournal(
  root: string,
  sessionId: string,
  records: readonly string[],
): Promise<string> {
  const agentDir = join(root, 'sessions', 'wd', sessionId, 'agents', 'main');
  await mkdir(agentDir, { recursive: true });
  const wirePath = join(agentDir, 'wire.jsonl');
  await writeFile(wirePath, records.join('\n') + '\n', 'utf8');
  return wirePath;
}

function fakeAgent(): { agent: IAgentScopeHandle; loadParts: ReturnType<typeof vi.fn> } {
  const loadParts = vi.fn(async (parts: ContextMessage['content']) => parts);
  const agent = {
    accessor: {
      get<T>(id: unknown): T {
        if (id === IWireService) return { flush: async () => {} } as T;
        if (id === IAgentContextMemoryService) return { get: () => [] } as T;
        if (id === IAgentBlobService) return { loadParts } as T;
        throw new Error(`unexpected service request: ${String(id)}`);
      },
    },
  };
  return { agent: agent as unknown as IAgentScopeHandle, loadParts };
}

describe('MessageHistoryCache', () => {
  let root: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kimi-msg-history-cache-'));
  });

  afterEach(async () => {
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
      root = undefined;
    }
  });

  it('tail read returns the correct count and absolute indices (limit projection)', async () => {
    const sessionDir = join(root as string, 'sessions', 'wd', 'sess_x');
    await writeJournal(
      root as string,
      'sess_x',
      Array.from({ length: 150 }, (_, i) => appendRecord(`m${i}`, i)),
    );
    const { agent, loadParts } = fakeAgent();

    const { items, total } = await loadMessageHistory(agent, 'sess_x', 1_700_000_000_000, {
      sessionDir,
      limit: 100,
    });

    expect(total).toBe(150);
    expect(items).toHaveLength(100);
    // Newest 100 of the full history → absolute indices 50..149, so the
    // message ids stay stable against a full-history read.
    expect(items[0]!.id).toBe('msg_sess_x_000050');
    expect(items[99]!.id).toBe('msg_sess_x_000149');
    expect(items[0]!.content).toEqual([{ type: 'text', text: 'm50' }]);
    // Blob rehydration touched only the returned page, not the full history.
    expect(loadParts).toHaveBeenCalledTimes(100);
  });

  it('serves the cached fold on an unchanged journal and extends it by the appended tail only', async () => {
    const wirePath = await writeJournal(
      root as string,
      'sess_a',
      Array.from({ length: 3 }, (_, i) => appendRecord(`m${i}`, i)),
    );
    const readWhole = vi.fn(async (path: string) => (await import('node:fs/promises')).readFile(path, 'utf8'));
    const readRange = vi.fn(async (path: string, start: number, end: number) => {
      const { open } = await import('node:fs/promises');
      const handle = await open(path, 'r');
      try {
        const buffer = Buffer.alloc(end - start);
        const { bytesRead } = await handle.read(buffer, 0, end - start, start);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    });
    const cache = new MessageHistoryCache({ readWhole, readRange });

    const first = await cache.read(wirePath);
    expect(first.transcript.foldedLength).toBe(3);
    expect(first.fromCache).toBe(false);
    expect(first.incremental).toBe(false);
    expect(readWhole).toHaveBeenCalledTimes(1);
    expect(readRange).not.toHaveBeenCalled();

    // Unchanged journal → memory hit: neither the whole file nor a range is read.
    const hit = await cache.read(wirePath);
    expect(hit.fromCache).toBe(true);
    expect(hit.transcript.foldedLength).toBe(3);
    expect(readWhole).toHaveBeenCalledTimes(1);
    expect(readRange).not.toHaveBeenCalled();

    // New messages land → the fold is extended by the appended tail bytes only
    // (the whole file is NOT re-read).
    await appendFile(wirePath, appendRecord('m3', 3) + '\n' + appendRecord('m4', 4) + '\n');
    const grown = await cache.read(wirePath);
    expect(grown.incremental).toBe(true);
    expect(grown.fromCache).toBe(false);
    expect(grown.transcript.foldedLength).toBe(5);
    expect(grown.transcript.entries[4]!.content).toEqual([{ type: 'text', text: 'm4' }]);
    expect(readWhole).toHaveBeenCalledTimes(1); // no full re-read
    expect(readRange).toHaveBeenCalledTimes(1); // only the tail bytes

    // And a third read now hits the cache again.
    const again = await cache.read(wirePath);
    expect(again.fromCache).toBe(true);
    expect(again.transcript.foldedLength).toBe(5);
  });

  it('re-folds from scratch when the journal is rewritten (size regression)', async () => {
    const wirePath = await writeJournal(
      root as string,
      'sess_b',
      [appendRecord('m0', 0), appendRecord('m1', 1), appendRecord('m2', 2)],
    );
    const cache = new MessageHistoryCache();
    await cache.read(wirePath);

    // Rewrite (e.g. migration healing) shrinks the journal and changes content.
    await writeFile(wirePath, appendRecord('fresh0', 0) + '\n', 'utf8');
    const after = await cache.read(wirePath);
    expect(after.fromCache).toBe(false);
    expect(after.incremental).toBe(false);
    expect(after.transcript.foldedLength).toBe(1);
    expect(after.transcript.entries[0]!.content).toEqual([{ type: 'text', text: 'fresh0' }]);
  });

  it('re-folds when a rewrite grows the file past the cached size (mid-record tail)', async () => {
    const wirePath = await writeJournal(
      root as string,
      'sess_c',
      [appendRecord('m0', 0), appendRecord('m1', 1)],
    );
    const readWhole = vi.fn(async (path: string) => (await import('node:fs/promises')).readFile(path, 'utf8'));
    const readRange = vi.fn(async (path: string, start: number, end: number) => {
      const { open } = await import('node:fs/promises');
      const handle = await open(path, 'r');
      try {
        const buffer = Buffer.alloc(end - start);
        const { bytesRead } = await handle.read(buffer, 0, end - start, start);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    });
    const cache = new MessageHistoryCache({ readWhole, readRange });
    await cache.read(wirePath);

    // Rewrite that GROWS the file with a different first record long enough to
    // cover the old size: the byte range starting at the old size lands
    // mid-record, so the incremental path must bail to a full re-fold instead
    // of folding garbage.
    await writeFile(
      wirePath,
      [
        appendRecord('x'.repeat(500), 0),
        appendRecord('m1', 1),
        appendRecord('m2', 2),
        appendRecord('m3', 3),
      ].join('\n') + '\n',
      'utf8',
    );
    const after = await cache.read(wirePath);
    expect(after.incremental).toBe(false);
    expect(after.fromCache).toBe(false);
    expect(after.transcript.foldedLength).toBe(4);
    expect(after.transcript.entries[3]!.content).toEqual([{ type: 'text', text: 'm3' }]);
    // The incremental range read was attempted (and rejected), then the whole
    // file was re-read for the full re-fold.
    expect(readRange).toHaveBeenCalledTimes(1);
    expect(readWhole).toHaveBeenCalledTimes(2);
  });

  it('evicts the least-recently-used entry past the LRU cap', async () => {
    const cache = new MessageHistoryCache({ maxEntries: 2 });
    const a = await writeJournal(root as string, 'sess_lru_a', [appendRecord('a', 0)]);
    const b = await writeJournal(root as string, 'sess_lru_b', [appendRecord('b', 0)]);
    const c = await writeJournal(root as string, 'sess_lru_c', [appendRecord('c', 0)]);

    await cache.read(a);
    await cache.read(b);
    await cache.read(a); // refresh a → LRU order [b, a]
    await cache.read(c); // evicts b

    expect(cache.size).toBe(2);
    // a survived the eviction and still serves from memory…
    const aHit = await cache.read(a);
    expect(aHit.fromCache).toBe(true);
    // …while b was evicted and must re-fold (which in turn evicts the oldest, a).
    const bAfter = await cache.read(b);
    expect(bAfter.fromCache).toBe(false);
  });

  it('drops idle entries past the TTL', async () => {
    const cache = new MessageHistoryCache({ ttlMs: 1, maxEntries: 16 });
    const wirePath = await writeJournal(root as string, 'sess_ttl', [appendRecord('m0', 0)]);
    await cache.read(wirePath);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = await cache.read(wirePath);
    expect(after.fromCache).toBe(false);
  });
});
