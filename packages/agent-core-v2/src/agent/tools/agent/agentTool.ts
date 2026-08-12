/**
 * `tools` domain — `SubagentTool` implementation (the `Agent` tool).
 *
 * The LLM-facing wrapper over the `subagent` domain: translates the tool args
 * into a Profile + Model binding, creates (or resumes) an agent through
 * `IAgentLifecycleService`, drives one turn via `ISessionSubagentService.run`,
 * and mirrors the run onto the calling agent's record stream
 * (`mirrorAgentRun`). The tool also owns the JSON schema + description,
 * approval rule, background-task registration (so the LLM can see the run
 * under TaskList/TaskOutput/TaskStop when `run_in_background=true` or after
 * detach), and terminal text formatting.
 *
 * Spawn bindings use an explicit tool choice first, then the target profile's
 * symbolic model preference, before `resolveSubagentBinding` falls back to the
 * configured secondary model or the caller's model. The selected alias is
 * resolved through the model catalog before lifecycle allocation. A resumed
 * agent keeps the model recorded in its own wire journal — with per-subagent
 * models there is no "child follows the parent's current model" invariant to
 * enforce.
 *
 * Team-mode same-profile serialization: when the profile already has a running
 * (or reserved) owned instance, the tool does not create a parallel one — it
 * enqueues a detached task that waits for the busy instance's current run to
 * settle and then reuses the SAME instance (`enqueueBusyWait` /
 * `launchWhenProfileFree`), so dispatches of one profile queue behind each
 * other and preserve context; different profiles stay independent.
 *
 * Registered via the module-level `registerAgentToolService(ISubagentTool,
 * SubagentTool)` at the bottom of this file — the same "import = register"
 * pattern used by every agent tool. The per-profile tool listings in the
 * description read the full contribution table (not the runtime registry,
 * which only holds tools the caller's own Profile activated), plus any
 * dynamically registered tools. Bound at Agent scope.
 */

import type { IAgentScopeHandle } from '#/_base/di/scope';
import {
  isAbortError,
  isUserCancellation,
  userCancellationReason,
} from '#/_base/utils/abort';
import { Error2, ErrorCodes, isError2 } from '#/errors';
import { toInputJsonSchema } from '#/tool/input-schema';
import { matchesGlobRuleSubject } from '#/tool/rule-match';
import {
  IAgentTaskService,
  type RegisterAgentTaskOptions,
} from '#/agent/task/task';
import { IAgentProfileService } from '#/agent/profile/profile';
import {
  isToolActive as evaluateToolActive,
  resolveActiveToolNames,
} from '#/agent/toolPolicy/evaluate';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import {
  getAgentToolContributions,
  registerAgentToolService,
} from '#/agent/toolRegistry/toolContribution';
import { IAgentToolRegistryService, type ToolReference } from '#/agent/toolRegistry/toolRegistry';
import { type AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { applyProfilePromptPrefix } from '#/app/agentProfileCatalog/promptPrefix';
import {
  subagentAllowlistFor,
  subagentTypeNotAllowedMessage,
} from '#/app/agentProfileCatalog/profile-shared';
import { ILogService } from '#/_base/log/log';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IModelCatalog } from '#/kosong/model/catalog';
import {
  IAgentPerformanceService,
  type PerformanceSummary,
} from '#/app/agentPerformance/agentPerformance';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { isSubagentMeta, subagentLabels, subagentParentAgentId } from '#/session/agentLifecycle/subagentMetadata';
import { materializeOwnedSubagent } from '#/session/agentLifecycle/subagentReuse';
import { IDutySchedulerService } from '#/session/duty/duty';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { ISubagentPoolService } from '#/session/subagentPool/subagentPool';
import { ISessionTodoService } from '#/session/todo/sessionTodo';

import { emitAgentRunSpawned, mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';
import {
  ISessionSubagentService,
  type AgentRunHandle,
} from '#/session/subagent/subagent';
import {
  buildSubagentModelDescriptions,
  formatSubagentTimeoutDescription,
  resolveSubagentBinding,
  resolveSubagentTimeoutMs,
  resolveTeamMode,
  stripSubagentModelParameter,
  wrapSubagentModelError,
} from '#/session/subagent/configSection';
import { SECONDARY_MODEL_FLAG_ID } from '#/session/subagent/flag';
import {
  BACKGROUND_AGENT_UNAVAILABLE,
  DEFAULT_PROFILE_NAME,
  ISubagentTool,
  RESUME_WITH_TYPE_UNAVAILABLE,
  RESUMED_LABEL,
  SUBAGENT_STOPPED_MESSAGE,
  SubagentToolInputSchema,
  USER_INTERRUPTED_SUBAGENT_MESSAGE,
  type SubagentToolInput,
} from './agent';
import { SubagentTask, QueuedSubagentTask, type SubagentHandle } from './subagent-task';

import AGENT_BACKGROUND_DISABLED_DESCRIPTION from './agent-background-disabled.md?raw';
import AGENT_BACKGROUND_DESCRIPTION from './agent-background-enabled.md?raw';
import AGENT_BACKGROUND_TEAM_DESCRIPTION from './agent-background-team.md?raw';
import AGENT_TEAM_LEAD_DOCTRINE from './team-lead-doctrine.md?raw';
import AGENT_DESCRIPTION_BASE from './agent.md?raw';

const SUBAGENT_TOOL_PARAMETERS = toInputJsonSchema(SubagentToolInputSchema);
const SUBAGENT_TOOL_PARAMETERS_NO_MODEL = stripSubagentModelParameter(SUBAGENT_TOOL_PARAMETERS);

/**
 * Internal control-flow signal: the team-mode dispatch pick found a
 * same-profile owned instance already running (or reserved by a batch sibling),
 * so the caller must NOT create a parallel instance — it enqueues a detached
 * wait that reuses that SAME instance once its current run settles. Never
 * surfaced to the user; `execution` converts it into the busy-wait task.
 */
class BusyDispatchError extends Error {
  constructor(readonly busyAgentId: string) {
    super(`same-profile instance "${busyAgentId}" is busy`);
    this.name = 'BusyDispatchError';
  }
}

export class SubagentTool implements ISubagentTool {
  declare readonly _serviceBrand: undefined;
  readonly name: string = 'Agent';

  /**
   * The `model` choice only exists while the `secondary-model` experiment is
   * on; off, the advertised schema drops it so the concept never enters the
   * prompt. Read live per request (same as `description`).
   */
  get parameters(): Record<string, unknown> {
    return this.flags.enabled(SECONDARY_MODEL_FLAG_ID)
      ? SUBAGENT_TOOL_PARAMETERS
      : SUBAGENT_TOOL_PARAMETERS_NO_MODEL;
  }

  /** How long to keep a performance cache entry before refreshing it. */
  private static readonly PERF_CACHE_TTL_MS = 60_000;

  private readonly callerAgentId: string;
  private readonly canRunInBackground: () => boolean;

  /**
   * Agent ids claimed for team-mode reuse by in-flight launch attempts (the
   * Agent tool is Agent-scoped, so this is per-supervisor-agent). A claim is
   * made atomically with the duty pick and released once the reused run starts
   * (or fails to start); from then on the instance's own running loop state
   * excludes it from reuse. Busy-wait tasks share this set so concurrent
   * serialized dispatches of one profile cannot double-reuse the same member.
   */
  private readonly reservedForReuse = new Set<string>();

  /** Lazy-loaded profile performance cache (team mode). `undefined` = never loaded. */
  private perfCache: Map<string, PerformanceSummary> | undefined;
  private perfCacheLoadedAt: number = 0;
  /** Non-undefined while an async refresh is in-flight — guards against concurrent duplicate calls. */
  private pendingRefresh: Promise<void> | undefined;

  constructor(
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @ISessionProcessRunner private readonly processRunner: ISessionProcessRunner,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @ILogService private readonly log: ILogService,
    @IAgentPermissionModeService private readonly permissionMode: IAgentPermissionModeService,
    @IConfigService private readonly config: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IAgentPerformanceService private readonly performance: IAgentPerformanceService,
    @IDutySchedulerService private readonly duty: IDutySchedulerService,
    @ISubagentPoolService private readonly pool: ISubagentPoolService,
    @ISessionTodoService private readonly todo: ISessionTodoService,
  ) {
    this.callerAgentId = scopeContext.agentId;
    this.canRunInBackground = () =>
      this.toolPolicy.isToolActive('TaskList') &&
      this.toolPolicy.isToolActive('TaskOutput') &&
      this.toolPolicy.isToolActive('TaskStop');
  }

  /**
   * Resolve the effective `run_in_background` value for a tool call.
   *
   * An explicit value (`true` or `false`) is used as-is. When omitted (`undefined`),
   * team mode + background capability makes it default to `true` (background-first
   * dispatch); otherwise `false` (foreground).
   */
  private resolveRunInBackground(args: SubagentToolInput): boolean {
    return args.run_in_background ?? (resolveTeamMode(this.config) && this.canRunInBackground());
  }

  get description(): string {
    const teamMode = resolveTeamMode(this.config);
    const backgroundDescription = this.canRunInBackground()
      ? teamMode
        ? AGENT_BACKGROUND_TEAM_DESCRIPTION
        : AGENT_BACKGROUND_DESCRIPTION
      : AGENT_BACKGROUND_DISABLED_DESCRIPTION;
    let description = `${AGENT_DESCRIPTION_BASE}\n\n${backgroundDescription}`;
    if (teamMode) {
      description += `\n\n${AGENT_TEAM_LEAD_DOCTRINE}`;
    }
    const allowlist = subagentAllowlistFor(this.catalog, this.profile.data());
    const profiles =
      allowlist === undefined
        ? this.catalog.list()
        : this.catalog.list().filter((profile) => allowlist.includes(profile.name));

    // Team mode: kick off an async perf data refresh if the cache is empty or
    // stale (≥60 s). The current render uses whatever cache is available — the
    // first render may show no scores; subsequent LLM turns will pick them up.
    if (teamMode) {
      void this.refreshPerfCache();
    }

    const typeLines = buildProfileDescriptions(
      profiles,
      this.knownToolReferences(),
      (profile, name, source) =>
        this.toolPolicy.isToolActiveForProfile(profile, name, source),
      this.flags.enabled(SECONDARY_MODEL_FLAG_ID),
      teamMode ? this.perfCache : undefined,
    );
    if (typeLines) {
      description += `\n\nAvailable agent types (pass via subagent_type):\n${typeLines}`;
    }
    const modelLines = buildSubagentModelDescriptions(
      this.config,
      this.flags,
      this.profile.data().modelAlias,
      this.modelCatalog,
    );
    if (modelLines !== undefined) {
      description += `\n\n${modelLines}`;
    }
    return description;
  }

  /**
   * Ensure the performance cache is populated and fresh, resolving once it is
   * usable: immediately when a fresh cache exists, or after an async load.
   * Callers that need the data before acting (e.g. launch-time card injection)
   * await it; the description getter fires it without awaiting. On failure the
   * cache stays as-is (possibly empty Map) and the loaded-at timestamp is
   * bumped so the TTL guard prevents retries for a while.
   *
   * Concurrent calls during an in-flight refresh are deduplicated: only the
   * first one kicks off the request; subsequent ones await the same pending
   * promise.
   */
  private refreshPerfCache(): Promise<void> {
    const now = Date.now();
    if (
      this.perfCache !== undefined &&
      now - this.perfCacheLoadedAt < SubagentTool.PERF_CACHE_TTL_MS
    ) {
      return Promise.resolve(); // cache is fresh enough
    }
    if (this.pendingRefresh !== undefined) {
      return this.pendingRefresh; // piggyback on the in-flight refresh
    }
    const refresh = this.performance
      .list()
      .then((entries) => {
        const map = new Map<string, PerformanceSummary>();
        for (const entry of entries) {
          map.set(entry.profileName, entry.summary);
        }
        this.perfCache = map;
        this.perfCacheLoadedAt = Date.now();
      })
      .catch(() => {
        // On error, set to empty Map so the getter renders no spurious
        // scores. Bump the timestamp too — a failed load also occupies a
        // TTL window before the next retry.
        if (this.perfCache === undefined) {
          this.perfCache = new Map();
        }
        this.perfCacheLoadedAt = Date.now();
      })
      .finally(() => {
        this.pendingRefresh = undefined;
      });
    this.pendingRefresh = refresh;
    return refresh;
  }

  /**
   * Prepend the spawned profile's `<performance_card>` to the child prompt.
   * The card is reference-only data about the profile's own recent scores and
   * team rank; the prompt is returned unchanged when the profile has no scored
   * entries (count 0) — the common case outside team-mode scoring.
   */
  private async withPerformanceCard(profileName: string, prompt: string): Promise<string> {
    await this.refreshPerfCache();
    const card =
      this.perfCache === undefined ? undefined : buildPerformanceCard(profileName, this.perfCache);
    return card === undefined ? prompt : `${card}\n\n${prompt}`;
  }

  private knownToolReferences(): ToolReference[] {
    const refs = new Map<string, ToolReference>();
    for (const contribution of getAgentToolContributions()) {
      refs.set(contribution.options.name, {
        name: contribution.options.name,
        source: contribution.options.source ?? 'builtin',
      });
    }
    for (const ref of this.toolRegistry.listReferences()) {
      if (!refs.has(ref.name)) refs.set(ref.name, ref);
    }
    return [...refs.values()];
  }

  async resolveExecution(args: SubagentToolInput): Promise<ToolExecution> {
    const requestedProfileName = args.subagent_type?.length ? args.subagent_type : undefined;
    const resumeAgentId = args.resume?.trim();

    if (
      resumeAgentId !== undefined &&
      resumeAgentId.length > 0 &&
      requestedProfileName !== undefined
    ) {
      return { output: RESUME_WITH_TYPE_UNAVAILABLE, isError: true };
    }

    const profileNameForDisplay =
      resumeAgentId !== undefined && resumeAgentId.length > 0
        ? this.resumeProfileName(resumeAgentId) ?? RESUMED_LABEL
        : requestedProfileName ?? DEFAULT_PROFILE_NAME;
    const resolvedBg = this.resolveRunInBackground(args);
    const prefix = resolvedBg ? 'Launching background' : 'Launching';
    return {
      description: `${prefix} ${profileNameForDisplay} agent: ${args.description}`,
      accesses: ToolAccesses.none(),
      display: {
        kind: 'agent_call',
        agent_name: profileNameForDisplay,
        prompt: args.prompt,
        background: resolvedBg,
      },
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, profileNameForDisplay),
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private resumeProfileName(agentId: string): string | undefined {
    const target = this.lifecycle.get(agentId);
    if (target === undefined) return undefined;
    return target.accessor.get(IAgentProfileService).data().profileName;
  }

  /**
   * Whether the target profile is an on-duty member (`duty: true` in its
   * agent file): its subagent runs are exempt from the subagent timeout and
   * must be stopped explicitly (TaskStop) when they go off duty.
   */
  private async isDutyProfile(
    requestedProfileName: string | undefined,
    resumeAgentId: string | undefined,
  ): Promise<boolean> {
    await this.catalog.ready;
    const profileName =
      resumeAgentId !== undefined && resumeAgentId.length > 0
        ? this.resumeProfileName(resumeAgentId)
        : (requestedProfileName ?? DEFAULT_PROFILE_NAME);
    if (profileName === undefined) return false;
    return this.catalog.get(profileName)?.duty === true;
  }

  /**
   * Hard dispatch gate: every dispatch must carry a `todo_id` that exists and
   * is not done. Missing / unknown / already-done todos are rejected before
   * anything launches — the same Error2 pattern as the allowlist rejection.
   * Throws (the caller's try/catch turns it into an error result).
   */
  private assertDispatchTodo(todoId: string | undefined): void {
    const id = todoId?.trim();
    if (id === undefined || id.length === 0) {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        '派工必须携带 todo_id（/todo 创建或选择）',
      );
    }
    const todo = this.todo.getTodo(id);
    if (todo === undefined) {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        `Todo "${id}" does not exist — create or select it from /todo / TodoList before dispatching.`,
        { details: { todoId: id } },
      );
    }
    if (todo.status === 'done') {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        `Todo "${id}" is already done — create or select an open todo before dispatching.`,
        { details: { todoId: id } },
      );
    }
  }

  private async launch(
    args: SubagentToolInput,
    toolCallId: string,
    controller: AbortController,
  ): Promise<SubagentHandle> {
    const requester = this.lifecycle.get(this.callerAgentId);
    if (requester === undefined) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_FOUND,
        `Caller agent "${this.callerAgentId}" does not exist`,
        { details: { agentId: this.callerAgentId } },
      );
    }

    const resumeAgentId = args.resume?.trim();
    const isResume = resumeAgentId !== undefined && resumeAgentId.length > 0;

    let agentId: string;
    let profileName: string;
    let promptText = args.prompt;
    if (isResume) {
      let target = this.lifecycle.get(resumeAgentId);
      if (target === undefined) {
        // Cold recovery: after a CLI restart only main is rebuilt — a lost
        // owned subagent is recoverable from the persisted session metadata
        // (wire.jsonl + state.json). Validate before materializing; a typo or
        // another parent's agent must not be resurrected out of thin air.
        target = await materializeOwnedSubagent({
          lifecycle: this.lifecycle,
          metadata: this.sessionMetadata,
          callerAgentId: this.callerAgentId,
          agentId: resumeAgentId,
        });
        if (target === undefined) {
          throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent instance "${resumeAgentId}" does not exist`, {
            details: { agentId: resumeAgentId },
          });
        }
      }
      await this.ensureOwnedIdleSubagent(resumeAgentId, target);
      agentId = target.id;
      profileName =
        target.accessor.get(IAgentProfileService).data().profileName ?? RESUMED_LABEL;
    } else {
      const requestedProfileName = args.subagent_type?.length
        ? args.subagent_type
        : DEFAULT_PROFILE_NAME;
      await this.catalog.ready;
      const own = this.profile.data();
      const allowlist = subagentAllowlistFor(this.catalog, own);
      if (allowlist !== undefined && !allowlist.includes(requestedProfileName)) {
        throw new Error2(
          ErrorCodes.AGENT_TYPE_NOT_ALLOWED,
          subagentTypeNotAllowedMessage(requestedProfileName, allowlist),
          { details: { profileName: requestedProfileName, allowlist } },
        );
      }
      const profile = this.catalog.get(requestedProfileName);
      if (profile === undefined) {
        throw new Error2(ErrorCodes.PROFILE_UNKNOWN, `Unknown agent type: "${requestedProfileName}"`, {
          details: { profileName: requestedProfileName },
        });
      }
      // Team mode: reuse a parked idle subagent of the same profile (resume
      // semantics — context preserved) instead of always creating a fresh
      // one. The pick goes through the DutyScheduler (LRU standby pool).
      // Explicit `resume` is unaffected; when team mode is off this block is
      // skipped and behavior is identical to a plain spawn.
      let reused: IAgentScopeHandle | undefined;
      if (resolveTeamMode(this.config)) {
        const pick = await this.duty.pick({
          callerAgentId: this.callerAgentId,
          profileName: requestedProfileName,
          claimInto: this.reservedForReuse,
        });
        if (pick.kind === 'busy') {
          // Same-profile serialization: an owned instance of this profile is
          // already running (or reserved by a batch sibling). Do not create a
          // parallel one — signal `execution` to enqueue a detached wait that
          // reuses this SAME instance once its current run settles.
          throw new BusyDispatchError(pick.agentId);
        }
        if (pick.kind === 'reuse') {
          const target = this.lifecycle.get(pick.agentId);
          if (target === undefined) {
            throw new Error(`Agent instance "${pick.agentId}" does not exist`);
          }
          await this.ensureOwnedIdleSubagent(pick.agentId, target);
          reused = target;
        }
      }

      // An explicit `model` is a single-dispatch override. Reuse honors it only
      // when the parked member's binding already matches the requested model;
      // otherwise the run would silently keep the member's old binding (the
      // reported bug: the requested model is ignored and its usage is never
      // recorded) and re-binding the member would make the override sticky on
      // a shared standby instance while running inside its previous
      // conversation. Force a fresh spawn instead (same spirit as
      // RESUME_WITH_TYPE_UNAVAILABLE): the override stays per-dispatch and the
      // parked member is left untouched.
      if (reused !== undefined && args.model !== undefined) {
        const binding = resolveSubagentBinding(
          this.config,
          this.flags,
          { modelAlias: own.modelAlias ?? '', thinkingLevel: own.thinkingLevel },
          args.model,
          profile.name,
          'model-param',
          profile,
        );
        const parkedAlias = reused.accessor.get(IAgentProfileService).data().modelAlias;
        if (parkedAlias !== binding.model) {
          reused = undefined;
        }
      }

      if (reused !== undefined) {
        agentId = reused.id;
        profileName =
          reused.accessor.get(IAgentProfileService).data().profileName ?? RESUMED_LABEL;
        // No prompt prefix: the reused agent keeps its own system prompt and
        // context from its previous run (same as an explicit resume).
      } else {
        if (own.modelAlias === undefined) {
          throw new Error2(ErrorCodes.MODEL_NOT_CONFIGURED, 'Caller agent has no model bound', {
            details: { agentId: this.callerAgentId },
          });
        }
        const binding = resolveSubagentBinding(
          this.config,
          this.flags,
          { modelAlias: own.modelAlias, thinkingLevel: own.thinkingLevel },
          args.model ?? profile.modelPreference,
          profile.name,
          args.model !== undefined ? 'model-param' : 'model-preference',
          profile,
        );
        let created: IAgentScopeHandle;
        try {
          this.modelCatalog.get(binding.model);
          created = await this.lifecycle.create({
            binding: {
              profile: profile.name,
              model: binding.model,
              thinking: binding.thinking,
              temperature: binding.temperature,
            },
            labels: subagentLabels(this.callerAgentId, { profileName: profile.name }),
          });
        } catch (error) {
          throw wrapSubagentModelError(error, binding.model, own.modelAlias, binding.source, this.config);
        }
        created.accessor.get(IAgentPermissionModeService).setMode(this.permissionMode.mode);
        created.accessor
          .get(IAgentUserToolService)
          .inheritUserTools(requester.accessor.get(IAgentUserToolService));
        agentId = created.id;
        profileName = profile.name;
        promptText = await applyProfilePromptPrefix(profile, args.prompt, {
          cwd: this.workspace.workDir,
          runner: this.processRunner,
          log: this.log,
        });
      }
    }

    const runInBackground = this.resolveRunInBackground(args);
    emitAgentRunSpawned(requester, agentId, {
      profileName,
      parentToolCallId: toolCallId,
      description: args.description,
      runInBackground,
    });

    let run: AgentRunHandle;
    try {
      run = await this.subagents.run(
        agentId,
        { kind: 'prompt', prompt: await this.withPerformanceCard(profileName, promptText) },
        { signal: controller.signal },
      );
    } finally {
      // Release the reuse claim once the run has started (or failed to start):
      // from then on the instance's own running loop state excludes it from
      // reuse, and a released claim re-exposes a parked member after a failed
      // start. Harmless for fresh/resume ids (not in the claim set).
      this.reservedForReuse.delete(agentId);
    }
    const mirrored = mirrorAgentRun(requester, run, {
      profileName,
      prompt: promptText,
      signal: controller.signal,
      cancel: (reason) => {
        controller.abort(reason);
      },
    });
    const completion = mirrored.then((r) => ({ result: r.summary, usage: r.usage }));
    // Todo writeback on success: once the run completes, close the unit's
    // todo with a brief outcome and the member's profile. Fire-and-forget —
    // the completion promise is consumed by the task machinery, so a failed
    // writeback must never fail the already-finished run (rejection side
    // swallows aborts/failures — only a success writes back).
    const todoId = args.todo_id?.trim();
    if (todoId !== undefined && todoId.length > 0) {
      void completion
        .then(
          (r) => {
            this.todo.setTodoCompleted(todoId, {
              whatDone: summarizeDispatchWhatDone(r.result, args.description),
              assignee: profileName,
            });
          },
          () => {},
        )
        .catch(() => {});
    }
    // Team-mode standby pool: once this run settles the member is idle again
    // and becomes a dispatch candidate (LRU pick). No-op when team mode is off.
    this.duty.observeSettle(agentId, profileName, this.callerAgentId, completion);
    return {
      agentId,
      profileName,
      completion,
    };
  }

  private async ensureOwnedIdleSubagent(
    agentId: string,
    target: IAgentScopeHandle,
  ): Promise<void> {
    const meta = (await this.sessionMetadata.read()).agents?.[agentId];
    if (!isSubagentMeta(meta)) {
      throw new Error2(ErrorCodes.AGENT_NOT_A_SUBAGENT, `Agent instance "${agentId}" is not a subagent`, {
        details: { agentId },
      });
    }
    if (subagentParentAgentId(meta) !== this.callerAgentId) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_OWNED,
        `Agent instance "${agentId}" does not belong to this parent agent`,
        { details: { agentId, callerAgentId: this.callerAgentId } },
      );
    }
    if (target.accessor.get(IAgentLoopService).status().state === 'running') {
      throw new Error2(
        ErrorCodes.AGENT_ALREADY_RUNNING,
        `Agent instance "${agentId}" is already running and cannot run concurrently`,
        { details: { agentId } },
      );
    }
  }

  private async execution(
    args: SubagentToolInput,
    { toolCallId, signal }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      signal.throwIfAborted();
      this.assertDispatchTodo(args.todo_id);
      const runInBackground = this.resolveRunInBackground(args);
      const requestedProfileName = args.subagent_type?.length ? args.subagent_type : undefined;
      const resumeAgentId = args.resume?.trim();
      const isResume = resumeAgentId !== undefined && resumeAgentId.length > 0;

      if (isResume && requestedProfileName !== undefined) {
        return { output: RESUME_WITH_TYPE_UNAVAILABLE, isError: true };
      }

      const allowBackground = this.canRunInBackground();
      if (runInBackground && !allowBackground) {
        return { output: BACKGROUND_AGENT_UNAVAILABLE, isError: true };
      }
      const timeoutMs = (await this.isDutyProfile(requestedProfileName, resumeAgentId))
        ? undefined
        : resolveSubagentTimeoutMs(this.config);

      // Pool-full: a foreground spawn at the concurrency ceiling must not pin
      // the supervisor turn on `pool.acquire`. Enqueue it as a detached task
      // (已入队,稍后自动开跑) — it starts automatically once a slot frees and
      // its completion arrives via the task's automatic notification.
      if (!runInBackground && !isResume && this.isPoolAtCapacity()) {
        return this.enqueuePoolFullRun(args, toolCallId, timeoutMs);
      }

      const controller = new AbortController();
      const abortBeforeRegister = (): void => {
        controller.abort(signal.reason);
      };
      if (!runInBackground) {
        signal.addEventListener('abort', abortBeforeRegister, { once: true });
      }

      let handle: SubagentHandle;
      try {
        handle = await this.launch(args, toolCallId, controller);
      } catch (error) {
        signal.removeEventListener('abort', abortBeforeRegister);
        if (error instanceof BusyDispatchError) {
          // Same-profile serialization: the profile already has a running
          // instance. Enqueue a detached wait that reuses it once its run
          // settles — never block the supervisor turn on the wait, and never
          // create a parallel instance.
          return this.enqueueBusyWait(error.busyAgentId, args, toolCallId, timeoutMs);
        }
        this.log.warn('subagent launch failed', {
          toolCallId,
          runInBackground,
          operation: isResume ? 'resume' : 'spawn',
          subagentType: requestedProfileName ?? DEFAULT_PROFILE_NAME,
          resumeAgentId: isResume ? resumeAgentId : undefined,
          error,
        });
        throw error;
      }

      let taskId: string;
      try {
        const registerOptions: RegisterAgentTaskOptions = {
          detached: runInBackground,
          timeoutMs,
          signal: runInBackground ? undefined : signal,
        };
        taskId = this.tasks.registerTask(
          new SubagentTask(handle, args.description, controller),
          registerOptions,
        );
        signal.removeEventListener('abort', abortBeforeRegister);
      } catch (error) {
        controller.abort();
        void handle.completion.catch(() => {});
        signal.removeEventListener('abort', abortBeforeRegister);
        this.log?.warn('background agent task registration failed', {
          toolCallId,
          agentId: handle.agentId,
          subagentType: handle.profileName,
          error,
        });
        const message = error instanceof Error ? error.message : String(error);
        return {
          output:
            isError2(error) && error.code === ErrorCodes.TASK_LIMIT_EXCEEDED
              ? 'Too many background tasks are already running.'
              : message,
          isError: true,
        };
      }

      if (runInBackground) {
        return {
          output: formatBackgroundAgentResult(taskId, handle, args.description, allowBackground),
        };
      }

      const release = await this.tasks.waitForForegroundRelease(taskId);
      if (release === 'detached') {
        return {
          output: formatBackgroundAgentResult(taskId, handle, args.description, allowBackground),
        };
      }
      return await this.formatForegroundResult(taskId, handle, timeoutMs);
    } catch (error) {
      return { output: `subagent error: ${launchErrorMessage(error, signal)}`, isError: true };
    }
  }

  /**
   * Whether the session concurrency pool is at its ceiling. `undefined` limit
   * (unlimited) is never "full". Foreground spawns bail out to the queue when
   * this is true — see {@link enqueuePoolFullRun}.
   */
  private isPoolAtCapacity(): boolean {
    const state = this.pool.state();
    return state.limit !== undefined && state.active >= state.limit;
  }

  /**
   * 池满语义 — a foreground spawn at the concurrency ceiling is enqueued as a
   * detached task instead of blocking the supervisor turn on `pool.acquire`.
   * The task defers the whole launch into `start`: it acquires a slot
   * (blocking inside the task — never on the supervisor turn), runs, and its
   * terminal notification delivers the completion. Returns the immediate
   * "已入队,稍后自动开跑" result with the task id. The deferred launch also
   * waits out any same-profile busy (serialization) before re-planning.
   */
  private enqueuePoolFullRun(
    args: SubagentToolInput,
    toolCallId: string,
    timeoutMs: number | undefined,
  ): Promise<ExecutableToolResult> {
    const controller = new AbortController();
    const task = new QueuedSubagentTask(
      (signal) => this.launchWhenProfileFree(undefined, args, toolCallId, controller, signal),
      args.description,
      controller,
    );
    try {
      const taskId = this.tasks.registerTask(task, {
        detached: true,
        timeoutMs,
        signal: undefined,
      });
      return Promise.resolve({ output: formatQueuedAgentResult(taskId, args.description) });
    } catch (error) {
      controller.abort();
      const message = error instanceof Error ? error.message : String(error);
      return Promise.resolve({
        output:
          message === 'Too many background tasks are already running.'
            ? 'Too many background tasks are already running.'
            : message,
        isError: true,
      });
    }
  }

  /**
   * 同 profile 串行语义 — a dispatch whose profile already has a running (or
   * reserved) instance is enqueued as a detached task instead of creating a
   * parallel one. The task waits for the busy instance's current run to
   * settle, then re-enters the launch path, which now finds the same instance
   * idle and reuses it (context preserved). Never blocks the supervisor turn;
   * the completion arrives via the task's automatic notification.
   */
  private enqueueBusyWait(
    busyAgentId: string,
    args: SubagentToolInput,
    toolCallId: string,
    timeoutMs: number | undefined,
  ): Promise<ExecutableToolResult> {
    const controller = new AbortController();
    const task = new QueuedSubagentTask(
      (signal) => this.launchWhenProfileFree(busyAgentId, args, toolCallId, controller, signal),
      args.description,
      controller,
    );
    try {
      const taskId = this.tasks.registerTask(task, {
        detached: true,
        timeoutMs,
        signal: undefined,
      });
      return Promise.resolve({ output: formatBusyWaitAgentResult(taskId, args.description) });
    } catch (error) {
      controller.abort();
      const message = error instanceof Error ? error.message : String(error);
      return Promise.resolve({
        output:
          message === 'Too many background tasks are already running.'
            ? 'Too many background tasks are already running.'
            : message,
        isError: true,
      });
    }
  }

  /**
   * Launch the dispatch, waiting out any same-profile busy first.
   * `initialBusyAgentId` (from the caller's pre-pick) skips the first pick;
   * the loop chases the busy instance as its run settles and a later dispatch
   * re-runs it — the same-profile serialization chain. Throws for any
   * non-busy launch error.
   */
  private async launchWhenProfileFree(
    initialBusyAgentId: string | undefined,
    args: SubagentToolInput,
    toolCallId: string,
    controller: AbortController,
    signal: AbortSignal,
  ): Promise<SubagentHandle> {
    let busyAgentId = initialBusyAgentId;
    for (;;) {
      if (busyAgentId !== undefined) {
        await this.duty.waitForSettle(busyAgentId, signal, this.reservedForReuse);
        signal.throwIfAborted();
      }
      try {
        return await this.launch(args, toolCallId, controller);
      } catch (error) {
        if (error instanceof BusyDispatchError) {
          busyAgentId = error.busyAgentId;
          continue;
        }
        throw error;
      }
    }
  }

  private async formatForegroundResult(
    taskId: string,
    handle: SubagentHandle,
    timeoutMs: number | undefined,
  ): Promise<ExecutableToolResult> {
    const info = this.tasks.getTask(taskId);
    if (info?.status === 'completed') {
      return {
        output: formatForegroundAgentSuccess(handle, await this.tasks.readOutput(taskId)),
      };
    }
    const timedOut = info?.status === 'timed_out';
    const message =
      timedOut && timeoutMs !== undefined
        ? `Agent timed out after ${formatSubagentTimeoutDescription(timeoutMs)}.`
        : formatSubagentStoppedMessage(info?.stopReason);
    return {
      output: formatForegroundAgentFailure(handle, message, timedOut),
      isError: true,
    };
  }
}

registerAgentToolService(ISubagentTool, SubagentTool, { name: 'Agent', domain: 'subagent' });


function buildProfileDescriptions(
  profiles: readonly AgentProfile[],
  tools: readonly ToolReference[],
  isToolActive: (
    profile: { readonly tools?: readonly string[]; readonly disallowedTools?: readonly string[] },
    name: string,
    source: ToolReference['source'],
  ) => boolean,
  showModelPreferences: boolean,
  perfByProfile?: ReadonlyMap<string, PerformanceSummary>,
): string {
  return profiles
    .map((profile) => {
      const details = [profile.description, profile.whenToUse].filter(
        (part): part is string => part !== undefined && part.length > 0,
      );
      const roleSuffix = profile.role === undefined ? '' : ` — ${profile.role}`;
      const dutySuffix = profile.duty === true ? ' [duty: no timeout; stop via TaskStop]' : '';
      // Append performance score suffix when team-mode data is available.
      const perfSuffix = perfByProfile !== undefined
        ? buildPerfSuffix(perfByProfile.get(profile.name))
        : '';
      const header =
        details.length === 0
          ? `- ${profile.name}${roleSuffix}${dutySuffix}${perfSuffix}`
          : `- ${profile.name}${roleSuffix}${dutySuffix}${perfSuffix}: ${details.join(' ')}`;
      const headerLines =
        !showModelPreferences || profile.modelPreference === undefined
          ? header
          : `${header}\n  Model preference: ${profile.modelPreference}`;
      const activeTools = resolveActiveToolNames(profile);
      const externallyRestricted = tools.some(
        (tool) =>
          evaluateToolActive(profile, tool.name, tool.source) &&
          !isToolActive(profile, tool.name, tool.source),
      );
      if (externallyRestricted) {
        const effectiveTools = tools
          .filter((tool) => isToolActive(profile, tool.name, tool.source))
          .map((tool) => tool.name);
        if (effectiveTools.length === 0) {
          return `${headerLines}\n  Tools: none`;
        }
        return `${headerLines}\n  Tools: ${effectiveTools.join(', ')}`;
      }
      if (activeTools === undefined) {
        if ((profile.disallowedTools?.length ?? 0) > 0) {
          return `${headerLines}\n  Tools: all except ${profile.disallowedTools!.join(', ')}`;
        }
        return `${headerLines}\n  Tools: all`;
      }
      if (activeTools.length === 0) {
        return `${headerLines}\n  Tools: none`;
      }
      return `${headerLines}\n  Tools: ${activeTools.join(', ')}`;
    })
    .join('\n');
}

/**
 * Build a short performance suffix for a profile line.
 * Returns empty string when the profile has no scored entries.
 */
function buildPerfSuffix(summary: PerformanceSummary | undefined): string {
  if (summary === undefined || summary.count === 0 || summary.average === undefined) {
    return '';
  }
  const avg = Math.round(summary.average);
  return ` — avg score ${avg} (${summary.count} scored)`;
}

/** Minimum score count before a profile's rank is considered meaningful. */
export const MIN_SCORED_COUNT = 3;

/**
 * Build the spawn-time `<performance_card>` for one profile: its own average
 * over the last `count` scores plus a team rank among profiles with at least
 * `MIN_SCORED_COUNT` scores. English, neutral tone; never names or shows
 * another member's scores. Returns `undefined` (no card) when the profile has
 * no scored entries. The lowest-scored member is flagged neutrally only when
 * at least two members are scored.
 */
export function buildPerformanceCard(
  profileName: string,
  perfByProfile: ReadonlyMap<string, PerformanceSummary>,
): string | undefined {
  const summary = perfByProfile.get(profileName);
  if (summary === undefined || summary.count === 0 || summary.average === undefined) {
    return undefined;
  }
  const scored = [...perfByProfile.entries()]
    .filter(
      (entry): entry is [string, PerformanceSummary & { average: number }] =>
        entry[1].count >= MIN_SCORED_COUNT && entry[1].average !== undefined,
    )
    .sort((a, b) => b[1].average - a[1].average);
  const rank = scored.findIndex(([name]) => name === profileName);
  const countLabel = summary.count === 1 ? 'score' : 'scores';
  const averageLine = `average: ${summary.average} (last ${summary.count} ${countLabel})`;
  let rankLine: string;
  if (rank >= 0) {
    const total = scored.length;
    rankLine = `rank: ${rank + 1}/${total}`;
    if (total >= 2 && rank === total - 1) {
      rankLine += ` — currently the lowest among ${total} scored members (reference only)`;
    }
  } else {
    rankLine = `rank: insufficient data (need at least ${MIN_SCORED_COUNT} scores)`;
  }
  return [
    '<performance_card>',
    `profile: ${profileName}`,
    averageLine,
    rankLine,
    '</performance_card>',
  ].join('\n');
}

/** How many characters of a subagent summary are kept for the todo writeback. */
const WHAT_DONE_MAX_CHARS = 500;

/**
 * Brief completion summary for the todo writeback: the subagent's own result
 * summary, truncated; falls back to the dispatch description when the summary
 * is empty.
 */
function summarizeDispatchWhatDone(result: string | undefined, description: string): string {
  const summary = result?.trim();
  if (summary !== undefined && summary.length > 0) {
    return summary.length > WHAT_DONE_MAX_CHARS
      ? `${summary.slice(0, WHAT_DONE_MAX_CHARS)}…`
      : summary;
  }
  return description;
}

/** 池满入队 — a foreground spawn enqueued as a detached task. */
function formatQueuedAgentResult(taskId: string, description: string): string {
  return [
    `task_id: ${taskId}`,
    'status: queued',
    'automatic_notification: true',
    '',
    `description: ${description}`,
    '',
    'Enqueued (已入队,稍后自动开跑): the concurrency pool is full — the subagent will start automatically once a slot frees, and its completion arrives via automatic notification in a later turn. Do NOT wait, poll, or call TaskOutput on it; continue with other work or hand back to the user.',
  ].join('\n');
}

/** 同 profile 串行排队 — a dispatch enqueued behind a running same-profile instance. */
function formatBusyWaitAgentResult(taskId: string, description: string): string {
  return [
    `task_id: ${taskId}`,
    'status: queued',
    'automatic_notification: true',
    '',
    `description: ${description}`,
    '',
    'Enqueued (同 profile 串行排队): another instance of this profile is already running — this dispatch starts automatically once it settles, reusing the same instance to preserve context. Do NOT wait, poll, or call TaskOutput on it; continue with other work or hand back to the user.',
  ].join('\n');
}

function formatBackgroundAgentResult(
  taskId: string,
  handle: SubagentHandle,
  description: string,
  allowBackground: boolean,
): string {
  return [
    `task_id: ${taskId}`,
    'status: running',
    `agent_id: ${handle.agentId}`,
    `actual_subagent_type: ${handle.profileName}`,
    'automatic_notification: true',
    '',
    `description: ${description}`,
    '',
    allowBackground
      ? `next_step: The completion arrives automatically in a later turn — do NOT wait, poll, or call TaskOutput on it; continue with other work or hand back to the user. (If you have nothing to do until it finishes, run such tasks in the foreground next time.)`
      : 'next_step: The completion arrives automatically in a later turn.',
    `resume_hint: To continue or recover this same subagent later, call Agent(resume="${handle.agentId}", prompt="..."). The parameter is agent_id ("${handle.agentId}"), NOT task_id ("${taskId}") or source_id from a later <notification>. Recovery cases: a later <notification type="task.lost" | "task.failed" | "task.killed"> for this subagent — its conversation history is preserved across session restarts and resume will pick it up.`,
  ].join('\n');
}

function formatForegroundAgentSuccess(handle: SubagentHandle, result: string): string {
  return [
    `agent_id: ${handle.agentId}`,
    `actual_subagent_type: ${handle.profileName}`,
    'status: completed',
    '',
    '[summary]',
    result,
  ].join('\n');
}

function formatForegroundAgentFailure(
  handle: SubagentHandle,
  message: string,
  timedOut: boolean,
): string {
  const lines = [
    `agent_id: ${handle.agentId}`,
    `actual_subagent_type: ${handle.profileName}`,
    'status: failed',
    '',
    `subagent error: ${message}`,
  ];
  if (timedOut) {
    lines.push(
      `resume_hint: Continue with Agent(resume="${handle.agentId}", prompt="continue"). Use agent_id only; do not set subagent_type. The subagent retains its prior context; redo any unfinished tool call if its result was lost.`,
    );
  }
  return lines.join('\n');
}

function launchErrorMessage(error: unknown, signal: AbortSignal): string {
  if (isUserCancellation(signal.reason)) return USER_INTERRUPTED_SUBAGENT_MESSAGE;
  if (isAbortError(error)) return formatSubagentStoppedMessage(errorMessage(signal.reason));
  return error instanceof Error ? error.message : String(error);
}

function formatSubagentStoppedMessage(reason: string | undefined): string {
  const normalized = reason?.trim();
  if (normalized === userCancellationReason().message) return USER_INTERRUPTED_SUBAGENT_MESSAGE;
  if (normalized === undefined || normalized.length === 0) return SUBAGENT_STOPPED_MESSAGE;
  return `${SUBAGENT_STOPPED_MESSAGE} Reason: ${normalized}`;
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return undefined;
}
