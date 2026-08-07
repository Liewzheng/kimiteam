// apps/kimi-web/src/lib/teamRows.ts
// Pure team-roster helpers — no Vue, no i18n imports. Status derivation, roster
// aggregation and display-row ordering live here so TeamPanel stays a thin
// renderer and the logic is unit-testable. The component resolves i18n labels
// from the `key` field returned by teamStatusMeta (`team.status.<key>`).
//
// The web displays THREE lifecycle states. The wire still carries the TUI's
// four (working / resting / on-duty / off-duty); the mapper folds `on-duty`
// (employed, available, never worked this session) into `off-duty` — product
// semantics: a member who hasn't worked reads as 下班, not 休息.
//   working 工作 · resting 休息 · off-duty 下班

export type TeamMemberStatus = 'working' | 'resting' | 'off-duty';

export interface TeamStatusMeta {
  /** Badge variant from the design system (ui/Badge.vue). Follows the TUI
   *  colouring: working = accent (info), resting = warning (yellow rest
   *  window), off-duty = archived (neutral grey). */
  variant: 'info' | 'warning' | 'neutral';
  /** i18n suffix — resolve `team.status.<key>` in the component. */
  key: TeamMemberStatus;
  /** Whether the member currently occupies a turn slot (drives roster busy
   *  counts: only `working` consumes concurrency). */
  busy: boolean;
}

/** Display order follows the lifecycle: working → resting → off-duty. */
const STATUS_ORDER: Record<TeamMemberStatus, number> = {
  working: 0,
  resting: 1,
  'off-duty': 2,
};

/** Derive the design-system badge variant + i18n key for a member status. */
export function teamStatusMeta(status: TeamMemberStatus): TeamStatusMeta {
  switch (status) {
    case 'working':
      return { variant: 'info', key: 'working', busy: true };
    case 'resting':
      return { variant: 'warning', key: 'resting', busy: false };
    case 'off-duty':
      return { variant: 'neutral', key: 'off-duty', busy: false };
  }
}

export interface TeamRosterSummary {
  total: number;
  /** Members with a live working instance (occupy a turn slot). */
  working: number;
  /** Employed members on the roster inside a live rest window (context kept —
   *  they can continue the working conversation). `on-duty` folds into
   *  off-duty, not here. */
  resting: number;
  /** Archived / fired members (performance history only). */
  offDuty: number;
}

/** Aggregate a member list into the roster-header counts (one per status). */
export function summarizeTeam(
  members: ReadonlyArray<{ status: TeamMemberStatus }>,
): TeamRosterSummary {
  let working = 0;
  let resting = 0;
  let offDuty = 0;
  for (const member of members) {
    switch (member.status) {
      case 'working':
        working++;
        break;
      case 'resting':
        resting++;
        break;
      case 'off-duty':
        offDuty++;
        break;
    }
  }
  return { total: members.length, working, resting, offDuty };
}

/** Renderable average score: a 1-decimal string, or null when the member has
 *  no scores yet (average null or count <= 0). */
export function averageScoreLabel(score: { average: number | null; count: number }): string | null {
  if (score.average === null || score.count <= 0) return null;
  const rounded = Math.round(score.average * 10) / 10;
  return String(rounded);
}

// ---------------------------------------------------------------------------
// Think-mode options — the member card / detail form's reasoning-effort set.
// The engine's ThinkingEffort is an open union ('off' | 'on' | string, with
// per-model `supportEfforts`), so the web ships the product-agreed set. Display
// capitalizes each level (off → Off, max → Max).
// ---------------------------------------------------------------------------
export const THINK_MODE_OPTIONS: readonly string[] = ['off', 'low', 'high', 'max'];

/** Display a think-mode value capitalized (off → Off, max → Max). */
export function thinkModeLabel(mode: string): string {
  return mode.length > 0 ? mode.charAt(0).toUpperCase() + mode.slice(1) : mode;
}

// ---------------------------------------------------------------------------
// TeamStatusPanel card view-model
// ---------------------------------------------------------------------------

/** The four display rows of a team-member card in TeamStatusPanel:
 *  `Name (status)` / `Title` / `Model` / `Score`. Pure derivation so the card
 *  structure is unit-testable; the component resolves the `statusKey` i18n
 *  label (`team.status.<statusKey>`) and renders `scoreLabel` (null → the
 *  `team.scoreNone` empty state). `duty` drives the blue-tinted card
 *  background + the 值守 badge (see TeamStatusPanel). */
export interface TeamMemberCard {
  /** English profile id (`gu-wanqing`) — stable unique key + tooltip fallback. */
  name: string;
  /** Human display name shown on the card: the profile's `display_name`
   *  frontmatter field when the server ships it, else the English profile id.
   *  (Web-side contract: `AppTeamMember.displayName` ← wire `display_name`;
   *  inert until the server populates it.) */
  displayName: string;
  statusKey: TeamMemberStatus;
  /** True when the profile declares 值守 (duty) — a card background on top of
   *  the four-state grey, blue-tinted so duty members stand out at a glance. */
  duty: boolean;
  /** The card's "Title" row — the member's role/职位 field. */
  title: string;
  model: string;
  /** Reasoning-effort level (off/low/high/max) for the card's meta row. */
  thinkMode?: string;
  /** Sampling temperature (0–2) for the card's meta row. */
  temperature?: number;
  scoreLabel: string | null;
}

/** Resolve a member's display name: the profile `display_name` (when the
 *  server ships it), else the English profile id as the fallback. */
export function memberDisplayName(member: { name: string; displayName?: string }): string {
  const display = member.displayName?.trim();
  return display !== undefined && display.length > 0 ? display : member.name;
}

/** One card per member (1:1 — no filtering or limiting, so a roster of N
 *  members always renders exactly N cards). */
export function toMemberCard(member: {
  name: string;
  role: string;
  model: string;
  displayName?: string;
  status: TeamMemberStatus;
  duty?: boolean;
  thinkMode?: string;
  temperature?: number;
  score: { average: number | null; count: number };
}): TeamMemberCard {
  return {
    name: member.name,
    displayName: memberDisplayName(member),
    statusKey: member.status,
    duty: member.duty === true,
    title: member.role,
    model: member.model,
    thinkMode: member.thinkMode,
    temperature: member.temperature,
    scoreLabel: averageScoreLabel(member.score),
  };
}

/** Build the card view-model for a whole roster (preserves input order). */
export function toMemberCards(
  members: ReadonlyArray<Parameters<typeof toMemberCard>[0]>,
): TeamMemberCard[] {
  return members.map(toMemberCard);
}

/** Stable roster order: working → resting → off-duty; ties broken by
 *  name. Returns a new array (input is not mutated). */
export function sortTeamMembers<T extends { name: string; status: TeamMemberStatus }>(
  members: ReadonlyArray<T>,
): T[] {
  return [...members].sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (byStatus !== 0) return byStatus;
    return a.name.localeCompare(b.name);
  });
}

export interface TeamTabState {
  /** Emphasize the tab while any member is working — accent, mirroring the TUI
   *  footer's primary `[N agent working]` badge. */
  hot: boolean;
  /** No active session → the tab click is a no-op (guarded in App). */
  disabled: boolean;
}

/** Derived UI state for the chat dock's team tab. Pure so the highlight /
 *  disabled decisions are unit-testable (the component only binds the result).
 *  `hot` also requires at least one member, so an empty roster never looks
 *  "busy" with a phantom working count. */
export function teamTabState(opts: { working: number; total: number; hasSession: boolean }): TeamTabState {
  return {
    hot: opts.working > 0 && opts.total > 0,
    disabled: !opts.hasSession,
  };
}

// ---------------------------------------------------------------------------
// Built-in default profiles — hidden from the team roster
// ---------------------------------------------------------------------------

/** Engine built-in default agent profiles, registered in agent-core-v2
 *  (`session/agentLifecycle/profile/profiles.ts` agent/coder/explore and
 *  `agent/plan/profile/plan.ts` plan). They have NO user profile file
 *  (`~/.kimi-code/agents/<name>.md`), so the team roster only ever surfaces
 *  them as off-duty archive rows derived from dispatched-run shift records —
 *  with no role/model/description. The team panel hides them so it only shows
 *  user-created members (TeamHire'd / hand-written profiles). */
export const BUILTIN_TEAM_PROFILE_NAMES: readonly string[] = [
  'agent',
  'coder',
  'explore',
  'plan',
];

/** True when `name` is an engine built-in default profile (not a user-created
 *  team member). */
export function isBuiltinTeamProfileName(name: string): boolean {
  return BUILTIN_TEAM_PROFILE_NAMES.includes(name);
}

/** Drop engine built-in default profiles from a roster array (non-mutating).
 *  User-created members — including archive (off-duty) rows for fired members —
 *  are preserved. */
export function filterUserTeamMembers<T extends { name: string }>(
  members: ReadonlyArray<T>,
): T[] {
  return members.filter((m) => !isBuiltinTeamProfileName(m.name));
}

// ---------------------------------------------------------------------------
// Member lookup + roster replacement (drill-in detail + edit realtime)
// ---------------------------------------------------------------------------

/** Find a member by name across global then project scope, or null. Generic
 *  over the member/roster shapes so callers keep their concrete types (e.g.
 *  AppTeamMember) instead of a structural slice. */
export function findTeamMember<T extends AppTeamMemberLike>(
  members: { global: T[]; project: T[] } | null,
  name: string,
): T | null {
  if (!members) return null;
  return (
    members.global.find((m) => m.name === name) ??
    members.project.find((m) => m.name === name) ??
    null
  );
}

/** Replace a member in place (by name) within whichever scope holds it, and
 *  return a NEW roster object (spread-preserving any extra fields such as
 *  teamMode) — the source of truth (useTeamRoster.data) is patched this way so
 *  an edit reflects immediately without waiting for the 2.5s poll. Members not
 *  present in either scope leave the roster unchanged. */
export function replaceTeamMember<
  M extends { global: AppTeamMemberLike[]; project: AppTeamMemberLike[] },
  T extends AppTeamMemberLike,
>(members: M | null, updated: T): M | null {
  if (!members) return members;
  const inGlobal = members.global.some((m) => m.name === updated.name);
  const inProject = members.project.some((m) => m.name === updated.name);
  if (!inGlobal && !inProject) return members;
  return {
    ...members,
    global: inGlobal
      ? members.global.map((m) => (m.name === updated.name ? updated : m))
      : members.global,
    project: inProject
      ? members.project.map((m) => (m.name === updated.name ? updated : m))
      : members.project,
  };
}

/** Structural slice of a roster member used by the lookup helpers (kept local
 *  so the lib stays free of api/types imports — the wire and app shapes both
 *  satisfy it). */
interface AppTeamMemberLike {
  name: string;
}

// ---------------------------------------------------------------------------
// Member → live subagent task (workflow half of the member detail)
// ---------------------------------------------------------------------------

/** A live subagent task whose profile name matches the member name. The
 *  subagent's `subagentType` IS the profile name it was spawned from, so a
 *  roster member ("code-reviewer") joins to its running instance this way.
 *  Returns the first match (realistically 0 or 1 live instance per member). */
export function findMemberTask<T extends { kind: string; subagentType?: string }>(
  tasks: ReadonlyArray<T>,
  name: string,
): T | undefined {
  return tasks.find((task) => task.kind === 'subagent' && task.subagentType === name);
}

// ---------------------------------------------------------------------------
// Member-model dropdown (TeamMemberDetailPanel edit form)
// ---------------------------------------------------------------------------

/** One selectable model in the member-model dropdown. `id` is the value sent on
 *  save (and the <option> value); `label` is what the <option> shows
 *  (displayName ?? model). */
export interface MemberModelOption {
  id: string;
  label: string;
  /** Provider id — catalog options render under a provider <optgroup>. Empty
   *  for synthesized options (a model the catalog doesn't know). */
  provider: string;
  /** Recorded usage this session → rendered in the pinned "recently used"
   *  group at the top of the dropdown. */
  recent: boolean;
}

/** The dropdown's two ordered sections. `recent` is pinned above the catalog;
 *  the catalog renders grouped by provider (see the component's grouping). */
export interface MemberModelOptionGroups {
  recent: MemberModelOption[];
  catalog: MemberModelOption[];
}

/** Build the member-model dropdown options: models with recorded usage this
 *  session first (最近调用, pinned), then the full catalog minus the recent
 *  ids, in catalog order (grouped by provider on render). The current member
 *  model is guaranteed present so the <select> never shows a blank value —
 *  when it is not in the catalog or the recent list, a synthesized option is
 *  prepended to the catalog section (provider '' → rendered under a
 *  localizable "other" optgroup). Unknown recent ids synthesize too, so a
 *  model the catalog hasn't loaded yet stays selectable. */
export function memberModelOptions(opts: {
  models: ReadonlyArray<{ id: string; provider: string; model: string; displayName?: string }>;
  recentModelIds: ReadonlyArray<string>;
  currentId?: string;
}): MemberModelOptionGroups {
  const toOption = (m: { id: string; provider: string; model: string; displayName?: string }): MemberModelOption => ({
    id: m.id,
    label: m.displayName ?? m.model,
    provider: m.provider,
    recent: false,
  });

  const catalogById = new Map(opts.models.map((m) => [m.id, toOption(m)]));

  // Recent ids, deduped, preserving order.
  const seenRecent = new Set<string>();
  const recent: MemberModelOption[] = [];
  for (const id of opts.recentModelIds) {
    if (seenRecent.has(id)) continue;
    seenRecent.add(id);
    const known = catalogById.get(id);
    recent.push(
      known ? { ...known, recent: true } : { id, label: id, provider: '', recent: true },
    );
  }

  // Catalog minus recent ids, original order preserved.
  const catalog = opts.models.map(toOption).filter((opt) => !seenRecent.has(opt.id));

  // Guarantee the current selection is representable (avoids a blank <select>).
  const currentId = opts.currentId?.trim() ?? '';
  if (currentId.length > 0 && !seenRecent.has(currentId) && !catalogById.has(currentId)) {
    catalog.unshift({ id: currentId, label: currentId, provider: '', recent: false });
  }

  return { recent, catalog };
}
