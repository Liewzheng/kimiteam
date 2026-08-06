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
