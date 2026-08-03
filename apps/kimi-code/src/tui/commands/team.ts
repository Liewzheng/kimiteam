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

/**
 * Four-state member lifecycle status, confirmed with product.
 * See `deriveMemberStatus` for the exact derivation rules.
 */
export type MemberStatus = 'working' | 'resting' | 'on-duty' | 'off-duty';

/** One entry of `runtime-status.json` — a profile's live engine lifecycle state. */
export interface RuntimeStatusEntry {
  readonly state: 'working' | 'resting';
  readonly agentId?: string;
  readonly updatedAt?: string;
  /** ISO-8601 timestamp; present while `state === 'resting'` (rest window). */
  readonly restExpiresAt?: string;
}

/**
 * Parsed shape of `<dataDir>/agents/runtime-status.json`, keyed by profile name.
 * The file may be absent (v1 engine / team mode never ran) — treat as empty.
 */
export interface RuntimeStatusData {
  readonly [profileName: string]: RuntimeStatusEntry | undefined;
}

export interface TeamMemberRow {
  readonly name: string;
  /** Lifecycle status — 工作 / 休息 / 上班 / 下班. */
  readonly status: MemberStatus;
  readonly role: string;
  readonly model: string;
  /** True when model comes from the latest shift's `model` field (last-used). */
  readonly modelFromLastUse?: boolean;
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
 * Parse the raw content of `runtime-status.json` (engine-written, team mode).
 * Returns null if JSON is invalid or not an object. Malformed entries are
 * dropped per-key rather than failing the whole parse, so a future engine
 * state can never crash the panel.
 */
export function parseRuntimeStatusData(raw: string): RuntimeStatusData | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const result: Record<string, RuntimeStatusEntry> = {};
    for (const [name, rawEntry] of Object.entries(parsed)) {
      if (typeof rawEntry !== 'object' || rawEntry === null) continue;
      const entry = rawEntry as Record<string, unknown>;
      const state = entry['state'];
      if (state !== 'working' && state !== 'resting') continue;
      result[name] = {
        state,
        agentId: typeof entry['agentId'] === 'string' ? entry['agentId'] : undefined,
        updatedAt: typeof entry['updatedAt'] === 'string' ? entry['updatedAt'] : undefined,
        restExpiresAt:
          typeof entry['restExpiresAt'] === 'string' ? entry['restExpiresAt'] : undefined,
      };
    }
    return result as RuntimeStatusData;
  } catch {
    return null;
  }
}

/**
 * Derive the four-state lifecycle status for one member.
 *
 * Rules (by instance lifecycle):
 *  - 工作 working:  profile exists && status.state === 'working'
 *  - 休息 resting:  profile exists && status.state === 'resting'
 *                    && rest window (`restExpiresAt`) has not expired
 *  - 上班 on-duty:  profile exists && (no status entry || resting expired)
 *                    — employed, no live instance, spawns on demand
 *  - 下班 off-duty: no profile file, but performance history exists
 *                    (fired / archived)
 *
 * `now` is injected so callers can freeze time for the rest-window check.
 */
export function deriveMemberStatus(
  hasProfile: boolean,
  entry: RuntimeStatusEntry | undefined,
  now: number,
): MemberStatus {
  if (!hasProfile) return 'off-duty';
  if (entry?.state === 'working') return 'working';
  if (entry?.state === 'resting' && entry.restExpiresAt !== undefined) {
    const expiresAt = Date.parse(entry.restExpiresAt);
    // Unparseable timestamps count as expired → the member is on-duty.
    if (Number.isFinite(expiresAt) && expiresAt > now) return 'resting';
  }
  return 'on-duty';
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
  /**
   * Last-used model ID per profile name (from the latest shift's `model` field).
   * Takes priority over `resolvedModels`.
   */
  lastUsedModels?: Readonly<Record<string, string>>,
  /**
   * Real model id behind the `[secondary_model]` recipe (`secondaryModel.model`).
   * The engine records the derived alias `__secondary__` in shift `model`
   * fields; display resolves that alias to this id. When the id is unavailable,
   * an unresolved `__secondary__` falls through to the normal fallback chain
   * (resolved → profile default → '—').
   */
  secondaryModelId?: string,
  /**
   * Parsed `<dataDir>/agents/runtime-status.json` (live engine lifecycle
   * state). Absent file / null → every existing profile is on-duty; perf-only
   * names are still listed as off-duty archives.
   */
  runtimeStatus?: RuntimeStatusData | null,
  /**
   * Reference "now" for the rest-window expiry check; injected so tests can
   * freeze time. Defaults to the real clock.
   */
  now: number = Date.now(),
): TeamMemberRow[] {
  const rows: TeamMemberRow[] = [];
  const activeNames = new Set<string>();

  for (const profile of profiles) {
    activeNames.add(profile.name);
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

    // Last-used model from the latest shift wins, then resolvedModels, then profile default
    const lastUsed = lastUsedModels?.[profile.name];
    // `__secondary__` is an engine-internal derived alias recorded in shift
    // `model` fields — never a user-visible id. Resolve it to the real
    // secondary model id for display; when that id is missing, drop the
    // last-used entry so the normal fallback chain applies.
    const lastUsedForDisplay =
      lastUsed !== '__secondary__'
        ? lastUsed
        : secondaryModelId !== undefined && secondaryModelId.length > 0
          ? secondaryModelId
          : undefined;
    const resolved = resolvedModels?.[profile.name] ?? profile.modelPreference ?? '—';
    const model = lastUsedForDisplay ?? resolved;

    rows.push({
      name: profile.name,
      status: deriveMemberStatus(true, runtimeStatus?.[profile.name], now),
      role: profile.role ?? '—',
      model,
      modelFromLastUse: lastUsedForDisplay !== undefined ? true : undefined,
      avgScore,
      scoreCount,
      avgDurationMs,
      shiftCount,
    });
  }

  // Archived members: names with performance history but no profile file
  // (fired / dismissed → 下班). Off-duty rows keep their score & duration
  // history but have no role/model; they render dimmed as a greyed archive.
  if (perf !== null) {
    for (const name of Object.keys(perf)) {
      if (activeNames.has(name)) continue;
      const profileData = perf[name];
      const entries = profileData?.entries ?? [];
      const shifts = profileData?.shifts ?? [];
      // A key with neither entries nor shifts carries no 绩效/工时历史 — not a member.
      if (entries.length === 0 && shifts.length === 0) continue;
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
      rows.push({
        name,
        status: 'off-duty',
        role: '—',
        model: '—',
        avgScore,
        scoreCount,
        avgDurationMs,
        shiftCount,
      });
    }
  }

  return rows;
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

/**
 * Read and parse runtime-status.json from the data-dir agents folder.
 * Absent file (v1 engine / team mode never ran) → null, treated as empty —
 * never an error.
 */
export function readRuntimeStatusData(dataDir: string): RuntimeStatusData | null {
  const filePath = join(dataDir, 'agents', 'runtime-status.json');
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return parseRuntimeStatusData(raw);
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
  /**
   * Invoked when the user presses Ctrl+C while the panel has focus. Wired (in
   * showTeamPanel) to the same streaming-cancel path as the editor's Ctrl+C,
   * so opening the panel mid-turn never strands the user unable to interrupt.
   */
  readonly onCancel?: () => void;
  readonly maxVisible?: number;
}

/** Status column copy — the four lifecycle states (Chinese, target audience). */
const STATUS_LABELS: Record<MemberStatus, string> = {
  working: '工作',
  resting: '休息',
  'on-duty': '上班',
  'off-duty': '下班',
};

export class TeamPanelComponent extends Container implements Focusable {
  focused = false;
  private opts: TeamPanelOptions;
  private scrollTop = 0;

  constructor(opts: TeamPanelOptions) {
    super();
    this.opts = opts;
  }

  /**
   * Replace the displayed data in place (used by the periodic re-read while
   * the panel stays open). Callbacks are preserved.
   */
  update(data: Pick<TeamPanelOptions, 'teamMode' | 'members' | 'loadError'>): void {
    this.opts = { ...this.opts, ...data };
  }

  handleInput(data: string): void {
    const printable = decodeKittyPrintable(data) ?? data;
    if (matchesKey(data, Key.ctrl('c'))) {
      // Forward Ctrl+C to the injected streaming-cancel path instead of
      // swallowing it — otherwise opening the panel during a turn creates a
      // dead zone where the user must Esc back to the editor to interrupt.
      this.opts.onCancel?.();
      return;
    }
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
    const hasDimmedModel = this.opts.members.some((m) => !m.modelFromLastUse);
    const colDefs = [
      { label: 'Name', width: 18 },
      { label: '职位', width: 10 },
      { label: '职能', width: 14 },
      { label: 'Status', width: 6 },
      { label: hasDimmedModel ? 'Model*' : 'Model', width: 20 },
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
      // Role is `职位·职能` (U+00B7 separator); split on the first separator so
      // each column gets its own CJK-aligned width. Roles without a separator
      // render entirely in the position column, leaving the focus column blank.
      const sepIdx = member.role.indexOf('·');
      const position = sepIdx === -1 ? member.role : member.role.slice(0, sepIdx);
      const focus = sepIdx === -1 ? '' : member.role.slice(sepIdx + 1);
      const positionDisplay = truncateToWidth(position, 10, '…');
      const focusDisplay = truncateToWidth(focus, 14, '…');
      const nameDisplay = truncateToWidth(member.name, 18, '…');
      const modelText = truncateToWidth(member.model, 20, '…');
      // Last-used model is shown directly; resolution-fallback gets a dim style
      const modelDisplay = member.modelFromLastUse
        ? modelText
        : dim(modelText);
      // Status colour: 工作 = primary (the "running badge" token), 休息 =
      // warning (yellow, the rest window). 上班 / 下班 stay uncoloured — 上班
      // inherits the row dim, 下班 rows are muted at row level (greyed archive).
      const statusLabel = STATUS_LABELS[member.status];
      const statusDisplay =
        member.status === 'working'
          ? accent(statusLabel)
          : member.status === 'resting'
            ? warning(statusLabel)
            : statusLabel;
      const cells = [
        padToVisibleWidth(nameDisplay, 18),
        padToVisibleWidth(positionDisplay, 10),
        padToVisibleWidth(focusDisplay, 14),
        padToVisibleWidth(statusDisplay, 6),
        padToVisibleWidth(modelDisplay, 20),
        padStartVisible(scoreStr, 6) + ' ',
        padStartVisible(String(member.scoreCount), 3) + ' ',
        padStartVisible(durationStr, 9) + ' ',
        padStartVisible(String(member.shiftCount), 3),
      ];
      // Active rows render in the usual dim; archived (下班) rows drop a step
      // fainter to textMuted so the whole line reads as a greyed-out record.
      const rowStyle = member.status === 'off-duty' ? muted : dim;
      lines.push(`  ${rowStyle(cells.join(' '))}`);
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

/**
 * How often the open team panel re-reads agent profiles / performance /
 * runtime-status data so scores, models and lifecycle states stay current
 * while the agent keeps working underneath (ms). File reads are cheap and the
 * panel is short-lived; 2.5s keeps the view fresh without hammering the disk.
 */
export const TEAM_PANEL_REFRESH_INTERVAL_MS = 2_500;

export interface TeamPanelData {
  readonly teamMode: boolean;
  readonly members: readonly TeamMemberRow[];
  readonly loadError?: string;
}

/**
 * Read the full panel snapshot: config (teamMode + model resolution), agent
 * profiles, and performance data. Failures degrade to defaults / a loadError
 * message rather than throwing — a transient read error while the panel is
 * open must never crash the UI.
 */
async function loadTeamPanelData(host: SlashCommandHost): Promise<TeamPanelData> {
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
    // Live engine lifecycle state. Missing file → null → every profile with no
    // status entry is on-duty; perf-only names still list as off-duty archives.
    const runtimeStatus = readRuntimeStatusData(dataDir);

    // Resolve effective model for each profile.
    // `fullConfig.secondaryModel` is available on both v1 and v2 engines now.
    const resolvedModels: Record<string, string> = {};
    for (const p of profiles) {
      resolvedModels[p.name] = resolveModelForProfile(
        p.name,
        p.modelPreference,
        fullConfig,
      );
    }

    // Compute last-used model for each profile from the latest shift
    const lastUsedModels: Record<string, string> = {};
    if (perf !== null) {
      for (const [profileName, data] of Object.entries(perf)) {
        const shifts = data?.shifts;
        if (shifts !== undefined && shifts.length > 0 && typeof shifts[shifts.length - 1]?.model === 'string') {
          const model = (shifts[shifts.length - 1] as { model?: string }).model;
          if (model !== undefined && model.length > 0) {
            lastUsedModels[profileName] = model;
          }
        }
      }
    }

    // Real id behind the `[secondary_model]` recipe (`secondaryModel.model`).
    // The engine records the derived alias `__secondary__` in shift `model`
    // fields; the panel resolves that alias to this id for display. When the
    // config lacks it, the display-side resolution simply falls back.
    const secondaryModelId: string | undefined =
      typeof fullConfig?.secondaryModel?.model === 'string'
        ? fullConfig.secondaryModel.model
        : undefined;

    members = aggregateMemberRows(
      profiles,
      perf,
      resolvedModels,
      lastUsedModels,
      secondaryModelId,
      runtimeStatus,
    );
  } catch (error) {
    loadError = `Could not load team data: ${formatErrorMessage(error)}`;
  }

  return { teamMode, members, loadError };
}

async function showTeamPanel(host: SlashCommandHost): Promise<void> {
  const initial = await loadTeamPanelData(host);

  // Refresh timer lives in the host-facing closure (not the component), so the
  // panel stays a dumb view. It is cleared when the panel closes — the only
  // exit is onClose (Esc / Enter / q), so clearing there covers unmount.
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  const panel = new TeamPanelComponent({
    teamMode: initial.teamMode,
    members: initial.members,
    loadError: initial.loadError,
    onCancel: () => {
      // Same streaming-cancel path as the editor's Ctrl+C (editor-keyboard):
      // interrupt the in-flight agent turn through the session handle.
      void host.session?.cancel();
    },
    onClose: () => {
      if (refreshTimer !== undefined) clearInterval(refreshTimer);
      host.restoreEditor();
    },
  });

  refreshTimer = setInterval(() => {
    void loadTeamPanelData(host).then((data) => {
      panel.update(data);
      host.state.ui.requestRender();
    });
  }, TEAM_PANEL_REFRESH_INTERVAL_MS);

  host.mountEditorReplacement(panel);
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
