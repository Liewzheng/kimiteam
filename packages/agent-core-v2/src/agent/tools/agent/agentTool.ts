/**
 * `tools` domain (L7) — `SubagentTool` implementation (the `Agent` tool).
 *
 * The LLM-facing wrapper over the `subagent` domain: translates the tool args
 * into a Profile + Model binding, creates (or resumes) an agent through
 * `IAgentLifecycleService`, drives one turn via `ISessionSubagentService.run`,
 * and mirrors the run onto the calling agent's record stream
 * (`mirrorAgentRun`). The tool also owns the JSON schema + description,
 * approval rule, background-task registration (so the LLM can see the run
 * under TaskList/TaskOutput/TaskStop when `run_in_background=true` or after
 * detach), and terminal text formatting. The public contract (schemas,
 * constants, `ISubagentTool`) lives in `./agent`.
 *
 * Spawn bindings use an explicit tool choice first, then the target profile's
 * symbolic model preference, before `resolveSubagentBinding` falls back to the
 * configured secondary model or the caller's model. The selected alias is
 * resolved through the model catalog before lifecycle allocation. A resumed
 * agent keeps the model recorded in its own wire journal — with per-subagent
 * models there is no "child follows the parent's current model" invariant to
 * enforce.
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
import { findIdleOwnedSubagent } from '#/session/agentLifecycle/subagentReuse';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import { emitAgentRunSpawned, mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import {
  buildSubagentModelDescriptions,
  formatSubagentTimeoutDescription,
  resolveSubagentBinding,
  resolveSubagentTimeoutMs,
  resolveTeamMode,
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
import { SubagentTask, type SubagentHandle } from './subagent-task';

import AGENT_BACKGROUND_DISABLED_DESCRIPTION from './agent-background-disabled.md?raw';
import AGENT_BACKGROUND_DESCRIPTION from './agent-background-enabled.md?raw';
import AGENT_BACKGROUND_TEAM_DESCRIPTION from './agent-background-team.md?raw';
import AGENT_TEAM_LEAD_DOCTRINE from './team-lead-doctrine.md?raw';
import AGENT_DESCRIPTION_BASE from './agent.md?raw';

export class SubagentTool implements ISubagentTool {
  declare readonly _serviceBrand: undefined;
  readonly name: string = 'Agent';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SubagentToolInputSchema);

  /** How long to keep a performance cache entry before refreshing it. */
  private static readonly PERF_CACHE_TTL_MS = 60_000;

  private readonly callerAgentId: string;
  private readonly canRunInBackground: () => boolean;

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
      this.refreshPerfCache();
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
    );
    if (modelLines !== undefined) {
      description += `\n\n${modelLines}`;
    }
    return description;
  }

  /**
   * Fire-and-forget refresh of the performance cache. Does not block the
   * caller — on failure the cache stays as-is (possibly empty Map) and the
   * loaded-at timestamp is bumped so the TTL guard prevents retries for a
   * while.
   *
   * Concurrent calls during an in-flight refresh are deduplicated: only the
   * first one kicks off the request; subsequent ones piggyback on the same
   * pending promise.
   */
  private refreshPerfCache(): void {
    if (this.pendingRefresh !== undefined) return;
    const now = Date.now();
    if (this.perfCache !== undefined && now - this.perfCacheLoadedAt < SubagentTool.PERF_CACHE_TTL_MS) {
      return; // cache is fresh enough
    }
    this.pendingRefresh = this.performance
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

  private async launch(
    args: SubagentToolInput,
    toolCallId: string,
    controller: AbortController,
  ): Promise<SubagentHandle> {
    const requester = this.lifecycle.get(this.callerAgentId);
    if (requester === undefined) {
      throw new Error(`Caller agent "${this.callerAgentId}" does not exist`);
    }

    const resumeAgentId = args.resume?.trim();
    const isResume = resumeAgentId !== undefined && resumeAgentId.length > 0;

    let agentId: string;
    let profileName: string;
    let promptText = args.prompt;
    if (isResume) {
      const target = this.lifecycle.get(resumeAgentId);
      if (target === undefined) {
        throw new Error(`Agent instance "${resumeAgentId}" does not exist`);
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
        throw new Error(subagentTypeNotAllowedMessage(requestedProfileName, allowlist));
      }
      const profile = this.catalog.get(requestedProfileName);
      if (profile === undefined) {
        throw new Error(`Unknown agent type: "${requestedProfileName}"`);
      }

      // Team mode: reuse a parked idle subagent of the same profile (resume
      // semantics — context preserved) instead of always creating a fresh
      // one. Explicit `resume` is unaffected; when team mode is off this
      // block is skipped and behavior is identical to a plain spawn.
      let reused: IAgentScopeHandle | undefined;
      if (resolveTeamMode(this.config)) {
        const reuseId = await findIdleOwnedSubagent({
          lifecycle: this.lifecycle,
          metadata: this.sessionMetadata,
          callerAgentId: this.callerAgentId,
          profileName: requestedProfileName,
        });
        if (reuseId !== undefined) {
          const target = this.lifecycle.get(reuseId);
          if (target === undefined) {
            throw new Error(`Agent instance "${reuseId}" does not exist`);
          }
          await this.ensureOwnedIdleSubagent(reuseId, target);
          reused = target;
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
          throw new Error('Caller agent has no model bound');
        }
        const binding = resolveSubagentBinding(
          this.config,
          this.flags,
          { modelAlias: own.modelAlias, thinkingLevel: own.thinkingLevel },
          args.model ?? profile.modelPreference,
          profile.name,
          args.model !== undefined ? 'model-param' : 'model-preference',
        );
        let created: IAgentScopeHandle;
        try {
          this.modelCatalog.get(binding.model);
          created = await this.lifecycle.create({
            binding: {
              profile: profile.name,
              model: binding.model,
              thinking: binding.thinking,
              cwd: own.cwd,
            },
            labels: subagentLabels(this.callerAgentId),
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

    const run = await this.subagents.run(
      agentId,
      { kind: 'prompt', prompt: promptText },
      { signal: controller.signal },
    );
    const mirrored = mirrorAgentRun(requester, run, {
      profileName,
      prompt: promptText,
      signal: controller.signal,
      cancel: (reason) => {
        controller.abort(reason);
      },
    });
    return {
      agentId,
      profileName,
      completion: mirrored.then((r) => ({ result: r.summary, usage: r.usage })),
    };
  }

  private async ensureOwnedIdleSubagent(
    agentId: string,
    target: IAgentScopeHandle,
  ): Promise<void> {
    const meta = (await this.sessionMetadata.read()).agents?.[agentId];
    if (!isSubagentMeta(meta)) {
      throw new Error(`Agent instance "${agentId}" is not a subagent`);
    }
    if (subagentParentAgentId(meta) !== this.callerAgentId) {
      throw new Error(`Agent instance "${agentId}" does not belong to this parent agent`);
    }
    if (target.accessor.get(IAgentLoopService).status().state === 'running') {
      throw new Error(`Agent instance "${agentId}" is already running and cannot run concurrently`);
    }
  }

  private async execution(
    args: SubagentToolInput,
    { toolCallId, signal }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      signal.throwIfAborted();
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
            message === 'Too many detached tasks are already running.'
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
