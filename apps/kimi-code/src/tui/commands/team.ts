/**
 * Team command (`/team`) — toggle team mode or open the team panel.
 *
 * Architecture
 * ------------
 * Pure data functions are at the module top so they can be unit-tested without
 * a TUI harness. File I/O wrappers stay thin; the panel is a Container +
 * Focusable following the HelpPanel pattern.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

import {
  Container,
  matchesKey,
  Key,
  decodeKittyPrintable,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';
import { currentTheme } from '#/tui/theme';
import { getDataDir } from '#/utils/paths';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Public API — exported for dispatch.ts
// ---------------------------------------------------------------------------

export async function handleTeamCommand(host: SlashCommandHost, args: string): Promise<void> {
  const subcmd = args.trim().toLowerCase();

  if (subcmd === 'on' || subcmd === 'off') {
    const enabled = subcmd === 'on';
    await applyTeamMode(host, enabled);
    return;
  }

  if (subcmd.length === 0) {
    await showTeamPanel(host);
    return;
  }

  host.showError('Usage: /team [on|off] — toggle team mode or open the team panel.');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentProfile {
  readonly name: string;
  readonly description: string;
  readonly role?: string;
  readonly modelPreference?: string;
  readonly duty?: string;
  readonly whenToUse?: string;
}

export interface PerformanceEntry {
  readonly profileName: string;
  /** ISO-8601 timestamp string, as written by the engine's performance service. */
  readonly ts: string;
  readonly score: number;
  readonly note?: string;
  readonly model?: string;
  readonly agentId?: string;
  readonly sessionId?: string;
}

export interface PerformanceShift {
  /** ISO-8601 timestamp strings, as written by the engine's performance service. */
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly workSummary: string;
  readonly model?: string;
  readonly concurrency?: number;
  readonly agentId?: string;
  readonly sessionId?: string;
}

export interface PerformanceData {
  readonly [profileName: string]: {
    readonly entries?: readonly PerformanceEntry[];
    readonly shifts?: readonly PerformanceShift[];
  };
}

export interface TeamMemberRow {
  readonly name: string;
  readonly role: string;
  readonly model: string;
  readonly avgScore: number | null;
  readonly scoreCount: number;
  readonly avgDurationMs: number | null;
  readonly shiftCount: number;
}

// ---------------------------------------------------------------------------
// Pure data helpers (independently testable)
// ---------------------------------------------------------------------------

/**
 * Parse a single agent `.md` file's YAML frontmatter.
 * Reads content between `---` markers and extracts `key: value` lines.
 * Handles single-quoted values. Returns null if no valid frontmatter.
 */
export function parseAgentFrontmatter(content: string): AgentProfile | null {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (match === null || match[1] === undefined) return null;

  const raw = match[1];
  const fields: Record<string, string> = {};

  for (const line of raw.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if (value.length === 0) continue;
    // Strip surrounding single quotes
    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }

  if (!fields['name'] || !fields['description']) return null;
  return {
    name: fields['name'],
    description: fields['description'],
    role: fields['role'],
    modelPreference: fields['model_preference'],
    duty: fields['duty'],
    whenToUse: fields['whenToUse'],
  };
}

/**
 * Parse the raw content of `performance.json`.
 * Returns null if JSON is invalid or not an object.
 */
export function parsePerformanceData(raw: string): PerformanceData | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    // Validate shape: each key should have optional entries / shifts arrays
    for (const val of Object.values(parsed)) {
      if (typeof val !== 'object' || val === null) continue;
      const section = val as Record<string, unknown>;
      if (section['entries'] !== undefined && !Array.isArray(section['entries'])) return null;
      if (section['shifts'] !== undefined && !Array.isArray(section['shifts'])) return null;
    }
    return parsed as PerformanceData;
  } catch {
    return null;
  }
}

/**
 * Format a duration in milliseconds to "Xm Ys" or "Xs" for short durations.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds === 0) return '0s';
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

/**
 * Aggregate agent profiles with performance data into display rows.
 * Pure function — no I/O, no side effects.
 */
export function aggregateMemberRows(
  profiles: readonly AgentProfile[],
  perf: PerformanceData | null,
  /**
   * Pre-resolved model ID per profile name, keyed by `profileName`.
   * When omitted, falls back to `profile.modelPreference ?? '—'`.
   */
  resolvedModels?: Readonly<Record<string, string>>,
): TeamMemberRow[] {
  return profiles.map((profile) => {
    const profileData = perf?.[profile.name];
    const entries = profileData?.entries ?? [];
    const shifts = profileData?.shifts ?? [];

    const scoreCount = entries.length;
    const avgScore =
      scoreCount > 0
        ? entries.reduce((sum, e) => sum + e.score, 0) / scoreCount
        : null;

    const shiftCount = shifts.length;
    const avgDurationMs =
      shiftCount > 0
        ? shifts.reduce((sum, s) => sum + s.durationMs, 0) / shiftCount
        : null;

    return {
      name: profile.name,
      role: profile.role ?? '—',
      model: resolvedModels?.[profile.name] ?? profile.modelPreference ?? '—',
      avgScore,
      scoreCount,
      avgDurationMs,
      shiftCount,
    };
  });
}

/**
 * Resolve the effective model ID for an agent profile.
 *
 * Precedence (highest first):
 *  1. `[subagent.model_overrides][<profileName>]` in config.toml
 *  2. Profile frontmatter `model_preference`
 *  3. If resolved value is `"secondary"` → `[secondary_model].model`
 *     (falls back to `"secondary"` if unset)
 *  4. If resolved value is `"primary"` → `defaultModel`
 *     (falls back to `"primary"` if unset)
 *  5. Otherwise use the resolved value as-is
 *
 * When `config` is null (unavailable), falls back to raw `modelPreference`
 * or `'—'` — same as the pre-resolution behaviour.
 */
export function resolveModelForProfile(
  profileName: string,
  modelPreference: string | undefined,
  config: {
    readonly defaultModel?: string;
    readonly subagent?: { readonly modelOverrides?: Record<string, string> };
    readonly secondaryModel?: { readonly model?: string };
  } | null,
): string {
  if (config === null) return modelPreference ?? '—';

  // 1) Per-profile override from [subagent.model_overrides]
  const override = config.subagent?.modelOverrides?.[profileName];
  if (override !== undefined && override.length > 0) return override;

  // 2) Profile frontmatter model_preference
  const preference = modelPreference;
  if (preference === undefined || preference.length === 0) return '—';

  // 3) Resolve the "secondary" shortcut
  if (preference === 'secondary') {
    return config.secondaryModel?.model ?? 'secondary';
  }

  // 4) Resolve the "primary" shortcut
  if (preference === 'primary') {
    return config.defaultModel ?? 'primary';
  }

  // 5) Literal model id
  return preference;
}

// ---------------------------------------------------------------------------
// File I/O wrappers
// ---------------------------------------------------------------------------

/** Discover agent `.md` files from both data-dir and cwd agent directories. */
export function readAgentProfiles(dataDir: string, cwd: string): AgentProfile[] {
  // Keyed by file name; the cwd scan runs second so project-local files win.
  const byFile = new Map<string, string>();

  const scanDir = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (extname(entry) !== '.md') continue;
      try {
        byFile.set(entry, readFileSync(join(dir, entry), 'utf-8'));
      } catch {
        // skip unreadable files
      }
    }
  };

  scanDir(join(dataDir, 'agents'));
  scanDir(join(cwd, '.kimi-code', 'agents'));

  const profiles: AgentProfile[] = [];
  for (const content of byFile.values()) {
    const profile = parseAgentFrontmatter(content);
    if (profile !== null) {
      profiles.push(profile);
    }
  }
  return profiles;
}

/** Read and parse performance.json from the data-dir agents folder. */
export function readPerformanceData(dataDir: string): PerformanceData | null {
  const filePath = join(dataDir, 'agents', 'performance.json');
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return parsePerformanceData(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Panel component
// ---------------------------------------------------------------------------

/**
 * Pad `text` to exactly `targetWidth` visible (display) columns.
 * Uses `visibleWidth` for CJK-aware measurement. If text already exceeds
 * the target width it is returned as-is (caller should truncate first).
 */
function padToVisibleWidth(text: string, targetWidth: number): string {
  const current = visibleWidth(text);
  if (current >= targetWidth) return text;
  return text + ' '.repeat(targetWidth - current);
}

/** Right-align `text` within a given visible width, prepending spaces. */
function padStartVisible(text: string, targetWidth: number): string {
  const current = visibleWidth(text);
  if (current >= targetWidth) return text;
  return ' '.repeat(targetWidth - current) + text;
}

export interface TeamPanelOptions {
  readonly teamMode: boolean;
  readonly members: readonly TeamMemberRow[];
  /** Error message if data loading failed entirely. */
  readonly loadError?: string;
  readonly onClose: () => void;
  readonly maxVisible?: number;
}

export class TeamPanelComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: TeamPanelOptions;
  private scrollTop = 0;

  constructor(opts: TeamPanelOptions) {
    super();
    this.opts = opts;
  }

  handleInput(data: string): void {
    const printable = decodeKittyPrintable(data) ?? data;
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.enter) ||
      printable === 'q' ||
      printable === 'Q'
    ) {
      this.opts.onClose();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollTop = Math.max(0, this.scrollTop - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollTop += 1;
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollTop = Math.max(0, this.scrollTop - 10);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollTop += 10;
    }
  }

  override render(width: number): string[] {
    const accent = (text: string) => currentTheme.fg('primary', text);
    const dim = (text: string) => currentTheme.fg('textDim', text);
    const muted = (text: string) => currentTheme.fg('textMuted', text);
    const bold = (text: string) => currentTheme.bold(text);
    const boldAccent = (text: string) => currentTheme.boldFg('primary', text);
    const success = (text: string) => currentTheme.fg('success', text);
    const warning = (text: string) => currentTheme.fg('warning', text);

    const lines: string[] = [];

    // Title bar
    const teamModeLabel = this.opts.teamMode ? success('ON') : muted('OFF');
    lines.push(accent('─'.repeat(width)));
    lines.push(
      `  ${boldAccent('Team Panel')} ${muted('·')} Team mode: ${teamModeLabel} ${muted('· Esc / q to close · ↑↓ scroll')}`,
    );
    lines.push('');

    // Team mode off — show guidance
    if (!this.opts.teamMode) {
      lines.push(
        `  ${dim('Team mode is off — /team on enables Team* management tools for the agent.')}`,
      );
      lines.push('');
    }

    // Load error
    if (this.opts.loadError !== undefined) {
      lines.push(`  ${warning(this.opts.loadError)}`);
      lines.push('');
    }

    // Empty state
    if (this.opts.members.length === 0) {
      if (this.opts.teamMode) {
        // Team mode ON, no members — onboarding guidance (Chinese, target audience)
        lines.push(`  ${dim('还没有团队成员')} ${muted('—')} ${dim('对 Kimi 说「组建我的团队」，回答 4 个问题即可定制初始团队')}`);
      } else {
        lines.push(`  ${dim('No team members yet.')}`);
        lines.push(`  ${dim('Use TeamHire to recruit your first member.')}`);
      }
      lines.push('');
      lines.push(accent('─'.repeat(width)));
      return lines.map((line) => truncateToWidth(line, width));
    }

    // Table header
    const colDefs = [
      { label: 'Name', width: 18 },
      { label: 'Role', width: 16 },
      { label: 'Model', width: 20 },
      { label: 'Score', width: 7 },
      { label: '#', width: 4 },
      { label: 'Duration', width: 10 },
      { label: '#', width: 4 },
    ] as const;

    const header = colDefs
      .map((c) => bold(padToVisibleWidth(c.label, c.width)))
      .join(' ');
    lines.push(`  ${dim('─'.repeat(width - 4))}`);
    lines.push(`  ${header}`);

    // Table rows
    for (const member of this.opts.members) {
      const scoreStr =
        member.avgScore !== null ? member.avgScore.toFixed(1) : '—';
      const durationStr =
        member.avgDurationMs !== null
          ? formatDuration(member.avgDurationMs)
          : '—';
      // Role may contain CJK double-width characters; truncate to column
      // width so it never pushes subsequent columns out of alignment.
      const roleDisplay = truncateToWidth(member.role, 16, '…');
      const nameDisplay = truncateToWidth(member.name, 18, '…');
      const modelDisplay = truncateToWidth(member.model, 20, '…');
      const cells = [
        padToVisibleWidth(nameDisplay, 18),
        padToVisibleWidth(roleDisplay, 16),
        padToVisibleWidth(modelDisplay, 20),
        padStartVisible(scoreStr, 6) + ' ',
        padStartVisible(String(member.scoreCount), 3) + ' ',
        padStartVisible(durationStr, 9) + ' ',
        padStartVisible(String(member.shiftCount), 3),
      ];
      lines.push(`  ${dim(cells.join(' '))}`);
    }

    lines.push('');
    lines.push(accent('─'.repeat(width)));

    // Apply scroll windowing — keep borders visible
    const content = lines.slice(1, lines.length - 1);
    const maxVisible = Math.max(5, this.opts.maxVisible ?? 24);
    if (content.length > maxVisible) {
      this.scrollTop = Math.max(0, Math.min(this.scrollTop, content.length - maxVisible));
      const slice = content.slice(this.scrollTop, this.scrollTop + maxVisible);
      const scrollInfo = muted(
        ` showing ${String(this.scrollTop + 1)}-${String(this.scrollTop + slice.length)} of ${String(content.length)}`,
      );
      return [lines[0] ?? '', ...slice, scrollInfo, lines.at(-1) ?? ''].map((line) =>
        truncateToWidth(line, width),
      );
    }

    this.scrollTop = 0;
    return lines.map((line) => truncateToWidth(line, width));
  }
}

// ---------------------------------------------------------------------------
// Internal — panel assembly
// ---------------------------------------------------------------------------

async function showTeamPanel(host: SlashCommandHost): Promise<void> {
  let teamMode = false;
  let loadError: string | undefined;
  let members: TeamMemberRow[] = [];

  // Read full config — used for teamMode toggle AND model resolution
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fullConfig: any = null;

  try {
    fullConfig = await host.harness.getConfig();
    teamMode = fullConfig?.subagent?.teamMode ?? false;
  } catch {
    // defaults remain at initial values
  }

  // Read agent profiles and performance data
  try {
    const dataDir = getDataDir();
    // Use process.cwd() for the workspace — same as the TUI process
    const cwd = process.cwd();
    const profiles = readAgentProfiles(dataDir, cwd);
    const perf = readPerformanceData(dataDir);

    // Resolve effective model for each profile
    const resolvedModels: Record<string, string> = {};
    for (const p of profiles) {
      resolvedModels[p.name] = resolveModelForProfile(
        p.name,
        p.modelPreference,
        fullConfig,
      );
    }

    members = aggregateMemberRows(profiles, perf, resolvedModels);
  } catch (error) {
    loadError = `Could not load team data: ${formatErrorMessage(error)}`;
  }

  host.mountEditorReplacement(
    new TeamPanelComponent({
      teamMode,
      members,
      loadError,
      onClose: () => {
        host.restoreEditor();
      },
    }),
  );
}

async function applyTeamMode(host: SlashCommandHost, enabled: boolean): Promise<void> {
  try {
    await host.harness.setConfig({ subagent: { teamMode: enabled } } as Record<string, unknown>);
  } catch (error) {
    host.showError(`Failed to set team mode: ${formatErrorMessage(error)}`);
    return;
  }

  host.showNotice(`Team mode: ${enabled ? 'ON' : 'OFF'}`);
}
