// apps/kimi-web/src/lib/teamRows.ts
// Pure team-roster helpers — no Vue, no i18n imports. Status derivation, roster
// aggregation and display-row ordering live here so TeamPanel stays a thin
// renderer and the logic is unit-testable. The component resolves i18n labels
// from the `key` field returned by teamStatusMeta (`team.status.<key>`).
//
// The four lifecycle statuses match the TUI exactly
// (apps/kimi-code/src/tui/commands/team.ts):
//   working 工作 · resting 休息 · on-duty 上班 · off-duty 下班

export type TeamMemberStatus = 'working' | 'resting' | 'on-duty' | 'off-duty';

export interface TeamStatusMeta {
  /** Badge variant from the design system (ui/Badge.vue). Follows the TUI
   *  colouring: working = accent (info), resting = warning (yellow rest
   *  window), on-duty = ready (success), off-duty = archived (neutral grey). */
  variant: 'info' | 'success' | 'warning' | 'neutral';
  /** i18n suffix — resolve `team.status.<key>` in the component. */
  key: TeamMemberStatus;
  /** Whether the member currently occupies a turn slot (drives roster busy
   *  counts: only `working` consumes concurrency). */
  busy: boolean;
}

/** Display order follows the TUI lifecycle: working → resting → on-duty →
 *  off-duty. */
const STATUS_ORDER: Record<TeamMemberStatus, number> = {
  working: 0,
  resting: 1,
  'on-duty': 2,
  'off-duty': 3,
};

/** Derive the design-system badge variant + i18n key for a member status. */
export function teamStatusMeta(status: TeamMemberStatus): TeamStatusMeta {
  switch (status) {
    case 'working':
      return { variant: 'info', key: 'working', busy: true };
    case 'resting':
      return { variant: 'warning', key: 'resting', busy: false };
    case 'on-duty':
      return { variant: 'success', key: 'on-duty', busy: false };
    case 'off-duty':
      return { variant: 'neutral', key: 'off-duty', busy: false };
  }
}

export interface TeamRosterSummary {
  total: number;
  /** Members with a live working instance (occupy a turn slot). */
  working: number;
  /** Employed members ready to take work — on the roster, spawns on demand. */
  onDuty: number;
  /** Employed members inside a rest window. */
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
  let onDuty = 0;
  let offDuty = 0;
  for (const member of members) {
    switch (member.status) {
      case 'working':
        working++;
        break;
      case 'resting':
        resting++;
        break;
      case 'on-duty':
        onDuty++;
        break;
      case 'off-duty':
        offDuty++;
        break;
    }
  }
  return { total: members.length, working, onDuty, resting, offDuty };
}

/** Renderable average score: a 1-decimal string, or null when the member has
 *  no scores yet (average null or count <= 0). */
export function averageScoreLabel(score: { average: number | null; count: number }): string | null {
  if (score.average === null || score.count <= 0) return null;
  const rounded = Math.round(score.average * 10) / 10;
  return String(rounded);
}

// ---------------------------------------------------------------------------
// TeamStatusPanel card view-model
// ---------------------------------------------------------------------------

/** The four display rows of a team-member card in TeamStatusPanel:
 *  `Name (status)` / `Title` / `Model` / `Score`. Pure derivation so the card
 *  structure is unit-testable; the component resolves the `statusKey` i18n
 *  label (`team.status.<statusKey>`) and renders `scoreLabel` (null → the
 *  `team.scoreNone` empty state). */
export interface TeamMemberCard {
  name: string;
  statusKey: TeamMemberStatus;
  /** The card's "Title" row — the member's role/职位 field. */
  title: string;
  model: string;
  scoreLabel: string | null;
}

/** One card per member (1:1 — no filtering or limiting, so a roster of N
 *  members always renders exactly N cards). */
export function toMemberCard(member: {
  name: string;
  role: string;
  model: string;
  status: TeamMemberStatus;
  score: { average: number | null; count: number };
}): TeamMemberCard {
  return {
    name: member.name,
    statusKey: member.status,
    title: member.role,
    model: member.model,
    scoreLabel: averageScoreLabel(member.score),
  };
}

/** Build the card view-model for a whole roster (preserves input order). */
export function toMemberCards(
  members: ReadonlyArray<Parameters<typeof toMemberCard>[0]>,
): TeamMemberCard[] {
  return members.map(toMemberCard);
}

/** Stable roster order: working → resting → on-duty → off-duty; ties broken by
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
