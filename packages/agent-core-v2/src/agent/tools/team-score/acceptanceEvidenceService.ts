/**
 * `team-score` domain — `IAcceptanceEvidenceService` implementation.
 *
 * Watches the main agent's tool calls (`tool.call.started` → `tool.result`
 * pairing, same as the lead-turn timeout service) and classifies them as
 * acceptance evidence for the TeamScore gate: read-delivery attributed per
 * profile through the main task registry (TaskOutput task id, or Read on
 * `agents/main/tasks/<task_id>/output.log`), and global read-diff /
 * rerun-tests timestamps from Bash commands. Anchors each member's acceptance
 * window at its latest delivery completion via
 * `ISessionSubagentService.onDidRunSettle` — the same run-settle signal that
 * drives the unscored-score reminder — rather than re-deriving completion
 * from turn ids. Evidence is shape detection, never semantic judgment: it
 * blocks "scored with no acceptance at all", not "perfunctory acceptance".
 * Bound at Agent scope; only the main agent's instance collects.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentTaskService } from '#/agent/task/task';
import type { ToolCallStartedEvent, ToolResultEvent } from '#/agent/toolExecutor/toolExecutorEvents';
import { IEventBus } from '#/app/event/eventBus';
import { ISessionSubagentService } from '#/session/subagent/subagent';

import {
  IAcceptanceEvidenceService,
  type AcceptanceGateResult,
} from './acceptanceEvidence';

/**
 * A Read tool path carrying a member's delivery log:
 * `agents/main/tasks/<task_id>/output.log` (forward or backslash separators,
 * absolute or relative). The `<task_id>` segment maps to the profile that
 * delivered it through the main task registry.
 */
const DELIVERY_OUTPUT_LOG_RE = /(?:^|[\\/])agents[\\/]main[\\/]tasks[\\/]([^\\/]+)[\\/]output\.log$/;

/** `git diff` / `git show`, including the `git -C <path> diff` variant. */
const READ_DIFF_RE = /\bgit\s+(?:-C\s+\S+\s+)?(?:diff|show)\b/;

/** Test-rerun commands: vitest, `pnpm [-C <path>] test`, npm test, pytest. */
const RERUN_TESTS_RE =
  /(?:\bvitest\b|\bpnpm\s+(?:-C\s+\S+\s+)?test\b|\bnpm\s+(?:run\s+)?test\b|\bpytest\b)/;

export type GlobalAcceptanceKind = 'read-diff' | 'rerun-tests';

/** Extract the delivery task id from a `TaskOutput` / `Read` tool call. */
export function extractDeliveryTaskId(toolName: string, args: unknown): string | undefined {
  if (toolName === 'TaskOutput') {
    return stringArg(args, 'task_id');
  }
  if (toolName === 'Read') {
    const path = stringArg(args, 'path');
    return path === undefined ? undefined : taskIdFromOutputLogPath(path);
  }
  return undefined;
}

/** Match `agents/main/tasks/<task_id>/output.log` and return the task id. */
export function taskIdFromOutputLogPath(path: string): string | undefined {
  return DELIVERY_OUTPUT_LOG_RE.exec(path)?.[1];
}

/** Classify a `Bash` command as a global acceptance action (shape only). */
export function classifyGlobalBashCommand(
  toolName: string,
  args: unknown,
): GlobalAcceptanceKind | undefined {
  if (toolName !== 'Bash') return undefined;
  const command = stringArg(args, 'command');
  if (command === undefined) return undefined;
  if (READ_DIFF_RE.test(command)) return 'read-diff';
  if (RERUN_TESTS_RE.test(command)) return 'rerun-tests';
  return undefined;
}

/** In-memory acceptance evidence snapshot. */
export interface AcceptanceEvidenceState {
  /** Profile → timestamp of its latest delivery completion (run settle). */
  readonly deliveryCompletedAt: ReadonlyMap<string, number>;
  /** Profiles whose delivery output was read (read-delivery). */
  readonly readDeliveredProfiles: ReadonlySet<string>;
  /** Timestamp of the latest read-diff (global; covers a whole batch). */
  readonly latestDiffAt: number;
  /** Timestamp of the latest rerun-tests (global; covers a whole batch). */
  readonly latestTestsAt: number;
}

/**
 * Evaluate the acceptance gate for one profile. Passes when the profile's
 * delivery was read (attributed per member), or when a global diff review /
 * test rerun happened at or after the profile's latest delivery completion.
 * Shape detection only.
 */
export function evaluateAcceptanceGate(
  state: AcceptanceEvidenceState,
  profileName: string,
): AcceptanceGateResult {
  if (state.readDeliveredProfiles.has(profileName)) return { ok: true };
  const completion = state.deliveryCompletedAt.get(profileName);
  if (completion !== undefined) {
    const latestGlobal = Math.max(state.latestDiffAt, state.latestTestsAt);
    if (latestGlobal >= completion) return { ok: true };
  }
  return { ok: false, message: buildGateFailureMessage(profileName, state) };
}

/** Human-readable, actionable failure: what is missing + how to satisfy it. */
export function buildGateFailureMessage(
  profileName: string,
  state: AcceptanceEvidenceState,
): string {
  const missing: string[] = [];
  if (!state.readDeliveredProfiles.has(profileName)) {
    missing.push(
      `read of "${profileName}"'s delivery output — TaskOutput(task_id=...) or Read on agents/main/tasks/<task_id>/output.log`,
    );
  }
  const completion = state.deliveryCompletedAt.get(profileName);
  const hasGlobalAfter =
    completion !== undefined && Math.max(state.latestDiffAt, state.latestTestsAt) >= completion;
  if (!hasGlobalAfter) {
    const anchor =
      completion === undefined
        ? ' (no delivery completion for this profile was observed this session)'
        : ' after the delivery settled';
    missing.push(
      `a diff review (Bash git diff / git show) or test rerun (vitest / pnpm test / npm test / pytest)${anchor}`,
    );
  }
  return [
    `No acceptance evidence for "${profileName}": TeamScore record requires a detectable acceptance action since the member's delivery completed (any one satisfies):`,
    ...missing.map((line) => `- ${line}`),
  ].join(' ');
}

function stringArg(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export class AcceptanceEvidenceService extends Disposable implements IAcceptanceEvidenceService {
  declare readonly _serviceBrand: undefined;

  private readonly callerAgentId: string;
  private readonly deliveryCompletedAt = new Map<string, number>();
  private readonly readDeliveredProfiles = new Set<string>();
  private latestDiffAt = 0;
  private latestTestsAt = 0;
  /** toolCallId → started-call name + args, for pairing on `tool.result`. */
  private readonly inFlight = new Map<string, { name: string; args: unknown }>();

  constructor(
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IEventBus eventBus: IEventBus,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @ISessionSubagentService subagents: ISessionSubagentService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.callerAgentId = scopeContext.agentId;
    // Evidence is collected only in the tech-lead's (main) Agent scope — a
    // subagent's own scope observes only its own tool events, which are not
    // acceptance actions. Non-main instances stay inert.
    if (this.callerAgentId !== 'main') return;
    this._register(
      eventBus.subscribe('tool.call.started', (event: ToolCallStartedEvent) => {
        this.inFlight.set(event.toolCallId, { name: event.name, args: event.args });
      }),
    );
    this._register(
      eventBus.subscribe('tool.result', (event: ToolResultEvent) => {
        const call = this.inFlight.get(event.toolCallId);
        if (call === undefined) return;
        this.inFlight.delete(event.toolCallId);
        this.onToolResult(call.name, call.args);
      }),
    );
    this._register(
      subagents.onDidRunSettle(({ profileName }) => {
        // Anchor the member's acceptance window at its latest delivery
        // completion — the same run-settle point as the unscored-score
        // reminder and the shift `endedAt`. Wall-clock, not turnId: parallel
        // deliveries in one turn each move their own profile's window, and a
        // global diff/test after them covers the whole batch.
        this.deliveryCompletedAt.set(profileName, Date.now());
      }),
    );
  }

  evaluateRecordGate(profileName: string): AcceptanceGateResult {
    return evaluateAcceptanceGate(this.snapshot(), profileName);
  }

  private snapshot(): AcceptanceEvidenceState {
    return {
      deliveryCompletedAt: this.deliveryCompletedAt,
      readDeliveredProfiles: this.readDeliveredProfiles,
      latestDiffAt: this.latestDiffAt,
      latestTestsAt: this.latestTestsAt,
    };
  }

  private onToolResult(name: string, args: unknown): void {
    const deliveryTaskId = extractDeliveryTaskId(name, args);
    if (deliveryTaskId !== undefined) {
      this.recordDeliveryRead(deliveryTaskId);
      return;
    }
    const global = classifyGlobalBashCommand(name, args);
    if (global === 'read-diff') this.latestDiffAt = Date.now();
    else if (global === 'rerun-tests') this.latestTestsAt = Date.now();
  }

  /**
   * Attribute a delivery read to the profile that delivered it: the dispatch
   * task (kind `agent`) records `subagentType` (the profile) in the main
   * agent's task registry. A task id that cannot be resolved to an agent
   * dispatch (unknown id, or a non-agent task such as a Bash task) records
   * nothing — attribution must never cross members.
   */
  private recordDeliveryRead(taskId: string): void {
    const info = this.tasks.getTask(taskId);
    if (info === undefined || info.kind !== 'agent') return;
    const profileName = info.subagentType;
    if (profileName === undefined) return;
    this.readDeliveredProfiles.add(profileName);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAcceptanceEvidenceService,
  AcceptanceEvidenceService,
  ScopeActivation.OnScopeCreated,
  'acceptanceEvidence',
);
