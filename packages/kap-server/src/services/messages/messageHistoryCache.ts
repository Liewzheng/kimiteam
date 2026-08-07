/**
 * `MessageHistoryCache` — per-session folded-transcript cache for the message
 * history loader (`services/messages/messageHistory`).
 *
 * The message routes serve history from the main agent's `wire.jsonl` journal.
 * For a large session (≈1M-token journal, 5–20MB of JSONL) re-reading + folding
 * the whole journal on every request is the server-side main cost of session
 * switching. This cache makes the steady-state read O(1) in disk and folds the
 * journal incrementally:
 *
 *   - **Cache key**: the absolute `wire.jsonl` path of the session's main
 *     agent (a session id is unique per wire file, so the path *is* the
 *     (sessionId, agentId) key). Validity is fingerprinted by `stat(size,
 *     mtimeMs)` — an O(1) "did the journal change?" probe, the same signal the
 *     legacy v1 `MessageService` used.
 *   - **Hit**: journal untouched since the last sync → the folded transcript
 *     is served from memory, no file bytes are read, no fold re-runs.
 *   - **Grow-only append**: the file got longer → only the appended tail bytes
 *     (`[lastSize, size)`, read via a byte-range open) are parsed and fed to
 *     the live `ContextTranscriptReducer`, so re-folding stays O(Δ) instead of
 *     O(全量). This is the "tail read" — new records come from the journal
 *     tail, never a re-read of the whole file.
 *   - **Rewrite / regression**: a rewritten journal (migration healing, fork)
 *     can shrink or re-lay the file; a byte range that starts mid-record fails
 *     JSON.parse → the whole file is re-folded from scratch. Size regression
 *     and a same-size content change are caught by the stat fingerprint. The
 *     incremental path only ever commits when the parsed tail is self-delimiting
 *     valid JSONL, so it cannot silently serve a stale fold.
 *
 * Bounds: LRU by entry count (`maxEntries`, default 128) plus an idle TTL
 * (`ttlMs`, default 10 min) — dead sessions free their reducer memory, active
 * ones are refreshed on every hit. Reads are serialized per key so concurrent
 * requests never interleave reducer feeds.
 *
 * Read-side only: nothing here pushes to clients; it is a pure cache behind
 * the existing wire-journal semantics (consume events via WS, then read).
 */

import { open, readFile, stat } from 'node:fs/promises';

import {
  createContextTranscriptReducer,
  type ContextTranscript,
  type ContextTranscriptReducer,
  type WireRecord,
} from '@moonshot-ai/agent-core-v2';

export interface CachedTranscriptResult {
  readonly transcript: ContextTranscript;
  /** True when the journal was untouched and the folded transcript came from memory. */
  readonly fromCache: boolean;
  /** True when only the appended journal tail bytes were read + folded. */
  readonly incremental: boolean;
}

interface CacheEntry {
  readonly wirePath: string;
  /** Live fold — kept alive so appends extend it instead of re-folding the journal. */
  reducer: ContextTranscriptReducer;
  /** Last `reducer.result()` snapshot. */
  transcript: ContextTranscript;
  size: number;
  mtimeMs: number;
  syncedAt: number;
}

export interface MessageHistoryCacheOptions {
  /** LRU entry cap; oldest entries evict beyond this. Default 128. */
  readonly maxEntries?: number;
  /** Idle TTL in ms; entries untouched this long are evicted on the next access. Default 10 min. */
  readonly ttlMs?: number;
  /** Test seam — whole-file text read. Defaults to `node:fs/promises` `readFile`. */
  readonly readWhole?: (path: string) => Promise<string>;
  /** Test seam — byte-range read. Defaults to `open` + positioned `read`. */
  readonly readRange?: (path: string, start: number, end: number) => Promise<Buffer>;
}

const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class MessageHistoryCache {
  private readonly entries = new Map<string, CacheEntry>();
  /** Per-key serialization: the in-flight (or queued) sync for each wire path. */
  private readonly tails = new Map<string, Promise<CachedTranscriptResult>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly readWhole: (path: string) => Promise<string>;
  private readonly readRange: (path: string, start: number, end: number) => Promise<Buffer>;

  constructor(opts: MessageHistoryCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.readWhole = opts.readWhole ?? ((path) => readFile(path, 'utf8'));
    this.readRange = opts.readRange ?? readFileRange;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.tails.clear();
  }

  /**
   * Read + fold a session agent's `wire.jsonl`, serving the cached transcript
   * when the journal is unchanged, extending the fold by the appended tail
   * bytes when it grew, and re-folding from scratch on first read / rewrite.
   */
  async read(wirePath: string): Promise<CachedTranscriptResult> {
    const prev = this.tails.get(wirePath) ?? Promise.resolve();
    const run = prev.then(
      () => this.sync(wirePath),
      () => this.sync(wirePath),
    );
    this.tails.set(wirePath, run);
    try {
      return await run;
    } finally {
      if (this.tails.get(wirePath) === run) this.tails.delete(wirePath);
    }
  }

  private async sync(wirePath: string): Promise<CachedTranscriptResult> {
    this.sweepExpired();
    const info = await safeStat(wirePath);
    const entry = this.entries.get(wirePath);

    // Untouched since the last sync → serve the folded transcript from memory.
    if (
      entry !== undefined &&
      info !== undefined &&
      entry.size === info.size &&
      entry.mtimeMs === info.mtimeMs
    ) {
      this.touch(wirePath);
      return { transcript: entry.transcript, fromCache: true, incremental: false };
    }

    // The journal does not exist (a fresh session before its first flush):
    // an empty transcript, cached with a zero fingerprint so a later file
    // creation is detected by stat.
    if (info === undefined) {
      if (entry !== undefined) this.entries.delete(wirePath);
      const reducer = createContextTranscriptReducer();
      const fresh: CacheEntry = {
        wirePath,
        reducer,
        transcript: reducer.result(),
        size: 0,
        mtimeMs: 0,
        syncedAt: Date.now(),
      };
      this.set(wirePath, fresh);
      return { transcript: fresh.transcript, fromCache: false, incremental: false };
    }

    // Grow-only: the file got longer → fold only the appended tail bytes.
    // `tryIncremental` returns false when the byte range starts mid-record
    // (a rewrite re-laid the file) → fall through to a full re-fold.
    if (entry !== undefined && info.size > entry.size) {
      const ok = await this.tryIncremental(entry, info.size);
      if (ok) {
        entry.size = info.size;
        entry.mtimeMs = info.mtimeMs;
        entry.syncedAt = Date.now();
        this.touch(wirePath);
        return { transcript: entry.transcript, fromCache: false, incremental: true };
      }
    }

    // First read, size regression, or a rewritten file → full re-fold.
    const fresh = await this.fullSync(wirePath);
    this.set(wirePath, fresh);
    return { transcript: fresh.transcript, fromCache: false, incremental: false };
  }

  /**
   * Read `[entry.size, newSize)` and fold the parsed records. Returns `false`
   * (without touching the reducer) when the range does not start on a record
   * boundary — i.e. the journal was rewritten, not appended.
   */
  private async tryIncremental(entry: CacheEntry, newSize: number): Promise<boolean> {
    const buf = await this.readRange(entry.wirePath, entry.size, newSize);
    const records = parseRange(buf.toString('utf8'), entry.wirePath);
    if (records === undefined) return false;
    for (const record of records) entry.reducer.add(record);
    entry.transcript = entry.reducer.result();
    return true;
  }

  private async fullSync(wirePath: string): Promise<CacheEntry> {
    const info = await safeStat(wirePath);
    const reducer = createContextTranscriptReducer();
    if (info !== undefined && info.size > 0) {
      const raw = await this.readWhole(wirePath);
      for (const record of parseWholeFile(raw, wirePath)) reducer.add(record);
    }
    return {
      wirePath,
      reducer,
      transcript: reducer.result(),
      size: info?.size ?? 0,
      mtimeMs: info?.mtimeMs ?? 0,
      syncedAt: Date.now(),
    };
  }

  private set(wirePath: string, entry: CacheEntry): void {
    this.entries.delete(wirePath);
    this.entries.set(wirePath, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  private touch(wirePath: string): void {
    const entry = this.entries.get(wirePath);
    if (entry === undefined) return;
    this.entries.delete(wirePath);
    this.entries.set(wirePath, entry);
  }

  private sweepExpired(): void {
    if (this.ttlMs <= 0) return;
    const cutoff = Date.now() - this.ttlMs;
    for (const [wirePath, entry] of this.entries) {
      if (entry.syncedAt < cutoff) this.entries.delete(wirePath);
    }
  }
}

/** Module-level singleton shared by the message-history loader. */
export const messageHistoryCache = new MessageHistoryCache();

/** `stat` that maps a missing journal to `undefined` (no other error is swallowed). */
async function safeStat(
  wirePath: string,
): Promise<{ size: number; mtimeMs: number } | undefined> {
  try {
    const info = await stat(wirePath);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readFileRange(path: string, start: number, end: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const length = end - start;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Parse JSONL records from a byte range read at a record boundary.
 *
 * Returns `undefined` when the FIRST line does not parse — the offset landed
 * mid-record, so the file was rewritten and a full re-fold is required.
 * A torn final line (crash mid-flush) is dropped; corruption anywhere else
 * throws, mirroring the append-log store's read semantics.
 */
function parseRange(text: string, wirePath: string): WireRecord[] | undefined {
  const lines = text.split('\n');
  const records: WireRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line) as WireRecord);
    } catch (parseError) {
      if (i === 0) return undefined;
      if (i === lines.length - 1) break;
      throw new Error(
        `wire.jsonl: corrupted line ${i + 1} in ${wirePath}: ${String(parseError)}`,
        { cause: parseError },
      );
    }
  }
  return records;
}

/**
 * Parse a whole `wire.jsonl` file. A torn final line (crash mid-flush) is
 * dropped; corruption anywhere else throws — the same semantics as the
 * append-log store's `read` (and `readWireRecords`), so a corrupt journal
 * surfaces as a 50001 instead of a silent empty page.
 */
function parseWholeFile(text: string, wirePath: string): WireRecord[] {
  const lines = text.split('\n');
  const records: WireRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line) as WireRecord);
    } catch (parseError) {
      if (i === lines.length - 1) break;
      throw new Error(
        `wire.jsonl: corrupted line ${i + 1} in ${wirePath}: ${String(parseError)}`,
        { cause: parseError },
      );
    }
  }
  return records;
}
