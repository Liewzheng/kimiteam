/**
 * Subagent card "business card" metadata — role + performance avgScore.
 *
 * Module-level lazy cache with 60s TTL. Read failures degrade silently to
 * empty metadata (no effect on card rendering).
 *
 * Exports
 * -------
 * `formatBusinessCardSuffix(agentName)` — cached I/O wrapper (sync).
 * `formatBusinessCardSuffixFromMap(agentName, map)` — pure function,
 *   independently testable without mocking the filesystem.
 */

import { getDataDir } from '#/utils/paths';
import {
  readAgentProfiles,
  readPerformanceData,
} from '#/tui/commands/team';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CardMeta {
  readonly role?: string;
  readonly avgScore?: number;
  readonly scoreCount: number;
}

// ---------------------------------------------------------------------------
// Module-level lazy cache (60 s TTL, silent degradation)
// ---------------------------------------------------------------------------

interface CacheEntry {
  readonly map: Map<string, CardMeta>;
  readonly expiresAt: number;
}

let cache: CacheEntry | null = null;
const TTL_MS = 60_000;

function buildMetaMap(): Map<string, CardMeta> {
  const dataDir = getDataDir();
  const cwd = process.cwd();

  const profiles = readAgentProfiles(dataDir, cwd);
  const perfData = readPerformanceData(dataDir);

  const map = new Map<string, CardMeta>();
  for (const profile of profiles) {
    const profileData = perfData?.[profile.name];
    const entries = profileData?.entries ?? [];

    const scoreCount = entries.length;
    let avgScore: number | undefined =
      scoreCount > 0
        ? entries.reduce((sum, e) => sum + e.score, 0) / scoreCount
        : undefined;
    // Reject non-finite or negative scores — treat as no data
    if (avgScore !== undefined && (!Number.isFinite(avgScore) || avgScore < 0)) {
      avgScore = undefined;
    }

    map.set(profile.name, {
      role: profile.role,
      avgScore,
      scoreCount,
    });
  }
  return map;
}

function getMetaMap(): Map<string, CardMeta> {
  const now = Date.now();
  if (cache === null || now >= cache.expiresAt) {
    try {
      cache = { map: buildMetaMap(), expiresAt: now + TTL_MS };
    } catch {
      // Silent degradation — no metadata available
      cache = { map: new Map(), expiresAt: now + TTL_MS };
    }
  }
  return cache.map;
}

// ---------------------------------------------------------------------------
// Pure formatting (no I/O — testable without mocks)
// ---------------------------------------------------------------------------

/**
 * Pure function: given a cached meta-map and an agent name, produce the
 * business-card suffix string.
 *
 * Returns empty string when the agent is unknown or has no data to show.
 */
export function formatBusinessCardSuffixFromMap(
  agentName: string | undefined,
  metaMap: Map<string, CardMeta>,
): string {
  if (agentName === undefined || agentName.length === 0) return '';

  const meta = metaMap.get(agentName);
  if (meta === undefined) return '';

  const parts: string[] = [];
  if (meta.role !== undefined && meta.role.length > 0) {
    parts.push(meta.role);
  }
  // Defensive: reject non-finite or negative scores even if stored
  const validScore =
    meta.avgScore !== undefined &&
    Number.isFinite(meta.avgScore) &&
    meta.avgScore >= 0;
  if (validScore) {
    parts.push(`avg ${Math.round(meta.avgScore)}/100 (${meta.scoreCount})`);
  }

  if (parts.length === 0) return '';
  return ` · ${parts.join(' · ')}`;
}

// ---------------------------------------------------------------------------
// Public API — cached I/O wrapper
// ---------------------------------------------------------------------------

/**
 * Format the business-card suffix for a subagent stats line.
 * Uses the module-level lazy cache (60 s TTL).
 * Returns empty string when no data is available or on I/O errors.
 */
export function formatBusinessCardSuffix(agentName: string | undefined): string {
  return formatBusinessCardSuffixFromMap(agentName, getMetaMap());
}
