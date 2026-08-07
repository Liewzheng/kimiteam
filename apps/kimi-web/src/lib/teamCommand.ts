// apps/kimi-web/src/lib/teamCommand.ts
// Pure decision for the web `/team` slash command (App.vue handleCommand).
// `/team init` runs the `team-init` skill; `/team on|off` toggles team mode;
// everything else (bare `/team`, TUI-only subcommands like `auto`) opens the
// team panel. The session/workspace branch for `init` is pure here so the
// three-way fallback (activate / new-session / add-workspace) is unit-tested.

export type TeamCommandAction =
  /** Has an active session — activate the skill on it directly. */
  | { type: 'activate-skill' }
  /** No session but a workspace — create a session there and activate. */
  | { type: 'activate-new-session' }
  /** No session and no workspace — the team flow needs a workspace first. */
  | { type: 'add-workspace' }
  /** `/team on|off` — toggle team mode (config-level, no session needed). */
  | { type: 'set-team-mode'; on: boolean }
  /** Bare `/team`, TUI-only subcommands, or anything else — open the panel. */
  | { type: 'open-panel' };

export interface TeamCommandOptions {
  hasSession: boolean;
  hasWorkspace: boolean;
}

/**
 * Map a `/team …` argument to the action the web layer should take. Extra
 * trailing arguments after `init` are ignored (the flow takes no free text).
 */
export function resolveTeamCommand(arg: string, opts: TeamCommandOptions): TeamCommandAction {
  const sub = (arg ?? '').trim().split(/\s+/)[0] ?? '';
  if (sub === 'init') {
    if (opts.hasSession) return { type: 'activate-skill' };
    if (opts.hasWorkspace) return { type: 'activate-new-session' };
    return { type: 'add-workspace' };
  }
  if (sub === 'on') return { type: 'set-team-mode', on: true };
  if (sub === 'off') return { type: 'set-team-mode', on: false };
  return { type: 'open-panel' };
}
