/**
 * v1-compatible message history — the loader behind
 * `GET /api/v1/sessions/{sid}/messages[/{mid}]`, served from the server layer
 * on top of the engine's native services (moved out of the engine's deleted
 * `messageLegacy` edge adapter).
 *
 * History is streamed from the main agent's append log after its pending wire
 * writes are flushed. The journal is folded incrementally by the shared
 * transcript reducer, keeping full history across compactions (inserting a
 * summary marker instead of folding) — unlike the live
 * `IAgentContextMemoryService.get()`, whose folded context collapses into
 * `[...keptUserMessages, compaction_summary]` and would lose the prefix.
 * `foldedLength` is what the live history length WOULD be from the journal's
 * records; because the journal can trail the live context by a record within a
 * single dispatch, anything beyond it is appended as the unflushed tail.
 * Pagination, id derivation, and the role filter mirror the legacy v1
 * semantics.
 *
 * Performance (P0-3): the journal is folded through a per-session
 * `MessageHistoryCache` keyed on the `wire.jsonl` stat fingerprint. Repeat
 * reads (session switching back and forth, page turns) hit the cache and never
 * re-read the journal; appends extend the fold by the journal tail bytes only;
 * blob rehydration (`rehydrate`) runs on the returned page, never the full
 * history. See `messageHistoryCache.ts` for the cache contract.
 */

import {
  AGENT_WIRE_RECORD_KEY,
  IAgentBlobService,
  IAgentContextMemoryService,
  ISessionContext,
  ISessionIndex,
  IWireService,
  MAIN_AGENT_ID,
  ensureMainAgent,
  resumeSessionById,
  type ContextMessage,
  type ContextTranscript,
  type IAgentScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { join } from 'node:path';

import type { Message, MessageRole } from '../../protocol/message';
import { deriveMessageId, toProtocolMessage } from './messageProjection';
import { messageHistoryCache } from './messageHistoryCache';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/** Sentinel — the route maps it to 40401. */
export class SessionNotFoundError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`session ${sessionId} does not exist`);
    this.name = 'SessionNotFoundError';
    this.sessionId = sessionId;
  }
}

/** Sentinel — the route maps it to 40403. */
export class MessageNotFoundError extends Error {
  readonly sessionId: string;
  readonly messageId: string;
  constructor(sessionId: string, messageId: string) {
    super(`message ${messageId} does not exist in session ${sessionId}`);
    this.name = 'MessageNotFoundError';
    this.sessionId = sessionId;
    this.messageId = messageId;
  }
}

export interface MessageListQuery {
  readonly before_id?: string | undefined;
  readonly after_id?: string | undefined;
  readonly page_size?: number | undefined;
  readonly role?: MessageRole | undefined;
}

export interface PageResponse<T> {
  items: T[];
  has_more: boolean;
}

export async function listMessages(
  core: Scope,
  sessionId: string,
  query: MessageListQuery,
): Promise<PageResponse<Message>> {
  const index = await loadHistoryIndex(core, sessionId);
  if (index === undefined) return { items: [], has_more: false };

  const { entries, agent, sessionCreatedAtMs } = index;
  const desc = [...entries].reverse();

  let pivotIndex = -1;
  if (query.before_id !== undefined) {
    pivotIndex = desc.findIndex((entry) => messageIdOf(sessionId, entry) === query.before_id);
  } else if (query.after_id !== undefined) {
    pivotIndex = desc.findIndex((entry) => messageIdOf(sessionId, entry) === query.after_id);
  }

  let slice: readonly HistoryEntry[];
  if (query.before_id !== undefined && pivotIndex >= 0) {
    slice = desc.slice(pivotIndex + 1);
  } else if (query.after_id !== undefined && pivotIndex >= 0) {
    slice = desc.slice(0, pivotIndex);
  } else {
    slice = desc;
  }

  const requestedSize = query.page_size ?? DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE);
  const page = slice.slice(0, pageSize);
  const hasMore = slice.length > pageSize;

  const filtered =
    query.role !== undefined ? page.filter((entry) => entry.message.role === query.role) : page;

  // Blob rehydration runs only on the returned page, never the full history.
  const rehydrated = await rehydrate(agent, filtered.map((entry) => entry.message));
  return {
    items: filtered.map((entry, i) =>
      toProtocolMessage(sessionId, entry.index, rehydrated[i]!, sessionCreatedAtMs, entry.createdAtMs),
    ),
    has_more: hasMore,
  };
}

export async function getMessage(
  core: Scope,
  sessionId: string,
  messageId: string,
): Promise<Message> {
  const index = await loadHistoryIndex(core, sessionId);
  if (index === undefined) throw new MessageNotFoundError(sessionId, messageId);
  const entry = index.entries.find((candidate) => messageIdOf(sessionId, candidate) === messageId);
  if (entry === undefined) throw new MessageNotFoundError(sessionId, messageId);
  const rehydrated = await rehydrate(index.agent, [entry.message]);
  return toProtocolMessage(
    sessionId,
    entry.index,
    rehydrated[0]!,
    index.sessionCreatedAtMs,
    entry.createdAtMs,
  );
}

/**
 * One agent's folded, projected message history — the shared loader behind the
 * `snapshot` route. Returns the most recent `limit` messages (or the full
 * history when no limit) with their absolute full-history indices and the total
 * folded count, so callers keep the message-id and `created_at` contracts
 * identical to a full load. Blob rehydration is scoped to the returned items.
 */
export interface LoadMessageHistoryOptions {
  /** Absolute session directory — locates the main agent's wire journal. */
  readonly sessionDir: string;
  /** Cap the returned items to the most recent `limit` messages (tail read). */
  readonly limit?: number;
}

export async function loadMessageHistory(
  agent: IAgentScopeHandle,
  sessionId: string,
  sessionCreatedAtMs: number,
  options: LoadMessageHistoryOptions,
): Promise<{ items: Message[]; total: number }> {
  const merged = await loadMergedHistory(agent, options.sessionDir);
  const createdAts = clampCreatedAts(merged, sessionCreatedAtMs);

  const start =
    options.limit === undefined ? 0 : Math.max(0, merged.messages.length - options.limit);
  const page = merged.messages.slice(start);

  // Blob rehydration runs only on the returned page, never the full history.
  const rehydrated = await rehydrate(agent, page);
  return {
    items: page.map((msg, i) =>
      toProtocolMessage(sessionId, start + i, rehydrated[i]!, sessionCreatedAtMs, createdAts[start + i]!),
    ),
    total: merged.messages.length,
  };
}

/**
 * Folded history entry with everything the protocol projection needs without
 * touching blob storage: the absolute index (message-id derivation base) and
 * the strictly-increasing clamped timestamp (`created_at` base).
 */
interface HistoryEntry {
  readonly message: ContextMessage;
  readonly index: number;
  readonly createdAtMs: number;
}

/** Folded history index plus the handles needed to project a page. */
interface HistoryIndex {
  readonly entries: readonly HistoryEntry[];
  readonly agent: IAgentScopeHandle;
  readonly sessionCreatedAtMs: number;
}

/**
 * Fold the session's full message history once (through the cache) and compute
 * the clamp chain over the merged list. Blob rehydration is deliberately NOT
 * performed here — callers rehydrate only the page they return.
 */
async function loadHistoryIndex(core: Scope, sessionId: string): Promise<HistoryIndex | undefined> {
  const summary = await core.accessor.get(ISessionIndex).get(sessionId);
  if (summary === undefined) {
    throw new SessionNotFoundError(sessionId);
  }

  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) return undefined;
  const agent = await ensureMainAgent(session);
  const sessionDir = session.accessor.get(ISessionContext).sessionDir;

  const merged = await loadMergedHistory(agent, sessionDir);
  const createdAts = clampCreatedAts(merged, summary.createdAt);
  const entries: HistoryEntry[] = new Array(merged.messages.length);
  for (let i = 0; i < merged.messages.length; i++) {
    entries[i] = { message: merged.messages[i]!, index: i, createdAtMs: createdAts[i]! };
  }
  return { entries, agent, sessionCreatedAtMs: summary.createdAt };
}

interface MergedHistory {
  readonly messages: readonly ContextMessage[];
  readonly times: readonly (number | undefined)[];
}

async function loadMergedHistory(
  agent: IAgentScopeHandle,
  sessionDir: string,
): Promise<MergedHistory> {
  const transcript = await readTranscript(agent, sessionDir);
  const contextMessages = agent.accessor.get(IAgentContextMemoryService).get();
  return mergeLiveTail(transcript, contextMessages);
}

/**
 * Strictly-increasing `created_at` clamp over the full merged history — a cheap
 * numeric pass over the in-memory fold that keeps the tail's timestamps
 * byte-identical to a full-history projection.
 */
function clampCreatedAts(merged: MergedHistory, sessionCreatedAtMs: number): number[] {
  const createdAts: number[] = new Array(merged.messages.length);
  let previousMs = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < merged.messages.length; i++) {
    const baseMs = merged.times[i] ?? sessionCreatedAtMs + i;
    const createdAtMs = Math.max(previousMs + 1, baseMs);
    createdAts[i] = createdAtMs;
    previousMs = createdAtMs;
  }
  return createdAts;
}

/**
 * The protocol message id of a history entry: an explicit id wins, otherwise
 * it is derived from the absolute index (`msg_<sid>_<padded index>`).
 */
function messageIdOf(sessionId: string, entry: HistoryEntry): string {
  return entry.message.id ?? deriveMessageId(sessionId, entry.index);
}

/**
 * Read + fold the main agent's persisted wire journal through the
 * `MessageHistoryCache`. The journal is flushed first so unflushed appends are
 * visible to the cache's stat fingerprint (and, on a miss, are read as the
 * appended tail). Cold sessions get the full fold once; steady-state reads and
 * appends are served from the cache.
 */
async function readTranscript(agent: IAgentScopeHandle, sessionDir: string): Promise<ContextTranscript> {
  await agent.accessor.get(IWireService).flush();
  const wirePath = join(sessionDir, 'agents', MAIN_AGENT_ID, AGENT_WIRE_RECORD_KEY);
  return (await messageHistoryCache.read(wirePath)).transcript;
}

/**
 * Replace `blobref:` media URLs with `data:` URIs read from the agent's
 * blob store (v1's `rehydrateBlobRefs`); unresolvable refs become the
 * `[media missing]` placeholder, same as v1 and live replay. Callers pass only
 * the page they are about to return, never the full history.
 */
async function rehydrate(
  agent: IAgentScopeHandle,
  messages: readonly ContextMessage[],
): Promise<readonly ContextMessage[]> {
  const blobs = agent.accessor.get(IAgentBlobService);
  let changed = false;
  const out: ContextMessage[] = [];
  for (const msg of messages) {
    const content = await blobs.loadParts(msg.content);
    if (content === msg.content) {
      out.push(msg);
      continue;
    }
    changed = true;
    out.push({ ...msg, content: [...content] });
  }
  return changed ? out : messages;
}

function mergeLiveTail(
  transcript: ContextTranscript,
  contextMessages: readonly ContextMessage[],
): MergedHistory {
  if (contextMessages.length <= transcript.foldedLength) {
    return { messages: transcript.entries, times: transcript.times };
  }
  const tail = contextMessages.slice(transcript.foldedLength);
  return {
    messages: [...transcript.entries, ...tail],
    times: [...transcript.times, ...tail.map(() => undefined)],
  };
}
