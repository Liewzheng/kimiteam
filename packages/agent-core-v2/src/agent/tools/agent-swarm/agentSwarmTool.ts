/**
 * `tools` domain — `AgentSwarmTool` implementation (the `AgentSwarm`
 * tool).
 *
 * Launches a batch of child agents (an ordinary Agent scope each) through the
 * session swarm coordinator (`ISessionSwarmService`) and renders the
 * per-subagent XML result. Reads persisted swarm item labels through the
 * Session-scoped coordinator so later `resume_agent_ids` calls relabel
 * resumed subagents like v1. When the caller has a model bound, the tool
 * resolves the explicit or target-profile model preference up front via
 * `resolveSubagentBinding` (against `IConfigService`, `IFlagService`,
 * `ISessionAgentProfileCatalog`, and the caller's `IAgentProfileService`) and
 * threads it through the swarm tasks; otherwise binding is left to the
 * service, which keeps its own "no model bound" check and inherit-caller
 * fallback. The advertised `model` parameter lists the secondary/primary
 * pair via `buildSubagentModelDescriptions`, suffixing each line with the
 * entry's capability flags resolved through `IModelCatalog`. Swarm mode is
 * entered through `IAgentSwarmService`; the caller's agent id comes from
 * `IAgentScopeContext`. Pure tool — owns no scoped state.
 *
 * The team-lead doctrine is injected once, into the Agent tool description;
 * this tool's team-mode description carries a one-line pointer to it instead
 * of duplicating the full doctrine.
 *
 * Registered via the module-level `registerAgentToolService(IAgentSwarmTool,
 * AgentSwarmTool)` at the bottom of this file — the same "import = register"
 * pattern used by every agent tool. Bound at Agent scope.
 */

import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { Error2, ErrorCodes } from '#/errors';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IModelCatalog } from '#/kosong/model/catalog';
import { ISessionSwarmService, type SessionSwarmRunResult, type SessionSwarmTask } from '#/session/swarm/sessionSwarm';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { isAbortError } from '#/_base/utils/abort';
import {
  type AgentTask,
  type AgentTaskInfoBase,
  type AgentTaskSink,
} from '#/agent/task/types';
import type { SubagentTaskInfo } from '#/agent/tools/agent/subagent-task';
import {
  subagentAllowlistFor,
  subagentTypeNotAllowedMessage,
} from '#/app/agentProfileCatalog/profile-shared';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentSwarmService } from '#/agent/swarm/swarm';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import {
  buildSubagentModelDescriptions,
  resolveSubagentBinding,
  resolveSubagentTimeoutMs,
  resolveTeamMode,
  stripSubagentModelParameter,
  type SubagentSpawnBinding,
} from '#/session/subagent/configSection';
import { SECONDARY_MODEL_FLAG_ID } from '#/session/subagent/flag';
import {
  AgentSwarmToolInputSchema,
  IAgentSwarmTool,
  MAX_AGENT_SWARM_SUBAGENTS,
  PROMPT_TEMPLATE_PLACEHOLDER,
  SWARM_BACKGROUND_UNAVAILABLE,
  type AgentSwarmToolInput,
} from './agent-swarm';
import AGENT_SWARM_DESCRIPTION from './agent-swarm.md?raw';

const DEFAULT_SUBAGENT_TYPE = 'coder';

const AGENT_SWARM_TEAM_DOCTRINE_POINTER =
  'Team-lead doctrine (dispatch, work orders, scoring): see the Agent tool description.';

const AGENT_SWARM_PARAMETERS = toInputJsonSchema(AgentSwarmToolInputSchema);
const AGENT_SWARM_PARAMETERS_NO_MODEL = stripSubagentModelParameter(AGENT_SWARM_PARAMETERS);

interface AgentSwarmSpawnSpec {
  readonly kind: 'spawn';
  readonly index: number;
  readonly item: string;
  readonly prompt: string;
}

interface AgentSwarmResumeSpec {
  readonly kind: 'resume';
  readonly index: number;
  readonly agentId: string;
  readonly item?: string;
  readonly prompt: string;
}

type AgentSwarmSpec = AgentSwarmSpawnSpec | AgentSwarmResumeSpec;

interface SwarmRunResult {
  readonly spec: AgentSwarmSpec;
  readonly agentId?: string;
  readonly status: 'completed' | 'failed' | 'aborted';
  readonly state?: 'started' | 'not_started';
  readonly result?: string;
  readonly error?: string;
}

/**
 * Detached background task for a whole swarm batch. `start` drives the batch
 * through the session swarm service (per-subagent concurrency acquires happen
 * inside this task — never on the supervisor's turn), renders the batch result
 * as output, and settles; TaskStop aborts the batch via the sink signal.
 */
class SwarmTask implements AgentTask {
  readonly kind = 'agent' as const;
  readonly idPrefix = 'agent' as const;
  readonly subagentType = 'swarm' as const;

  constructor(
    private readonly launch: (
      signal: AbortSignal,
    ) => Promise<readonly SessionSwarmRunResult<AgentSwarmSpec>[]>,
    private readonly render: (
      results: readonly SessionSwarmRunResult<AgentSwarmSpec>[],
    ) => string,
    readonly description: string,
    private readonly subagentCount: number,
  ) {}

  async start(sink: AgentTaskSink): Promise<void> {
    try {
      const results = await this.launch(sink.signal);
      sink.appendOutput(this.render(results));
      await sink.settle({ status: 'completed' });
    } catch (error) {
      if (sink.signal.aborted && (isAbortError(error) || error === sink.signal.reason)) {
        await sink.settle({ status: 'killed' });
        return;
      }
      await sink.settle({
        status: 'failed',
        stopReason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  toInfo(base: AgentTaskInfoBase): SubagentTaskInfo {
    return {
      ...base,
      kind: 'agent',
      agentId: undefined,
      subagentType: this.subagentType,
    };
  }
}

export class AgentSwarmTool implements IAgentSwarmTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'AgentSwarm' as const;

  /**
   * The `model` choice only exists while the `secondary-model` experiment is
   * on; off, the advertised schema drops it so the concept never enters the
   * prompt. Read live per request (same as `description`).
   */
  get parameters(): Record<string, unknown> {
    return this.flags.enabled(SECONDARY_MODEL_FLAG_ID)
      ? AGENT_SWARM_PARAMETERS
      : AGENT_SWARM_PARAMETERS_NO_MODEL;
  }

  private readonly callerAgentId: string;

  constructor(
    @ISessionSwarmService private readonly swarmService: ISessionSwarmService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAgentSwarmService private readonly swarmMode: IAgentSwarmService,
    @IConfigService private readonly config: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @ISessionTodoService private readonly todo: ISessionTodoService,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  /** Background swarm needs the task-management tools so the LLM can list,
   *  read and stop the detached batch. */
  private canRunInBackground(): boolean {
    return (
      this.toolPolicy.isToolActive('TaskList') &&
      this.toolPolicy.isToolActive('TaskOutput') &&
      this.toolPolicy.isToolActive('TaskStop')
    );
  }

  get description(): string {
    const teamMode = resolveTeamMode(this.config);
    const modelLines = buildSubagentModelDescriptions(
      this.config,
      this.flags,
      this.profile.data().modelAlias,
      this.modelCatalog,
    );
    let description = modelLines === undefined
      ? AGENT_SWARM_DESCRIPTION
      : `${AGENT_SWARM_DESCRIPTION}\n\n${modelLines}`;
    if (teamMode) {
      description += `\n\n${AGENT_SWARM_TEAM_DOCTRINE_POINTER}`;
    }
    return description;
  }

  resolveExecution(args: AgentSwarmToolInput): ToolExecution {
    const agentCount = (args.items?.length ?? 0) + Object.keys(args.resume_agent_ids ?? {}).length;
    return {
      accesses: ToolAccesses.all(),
      description: `Launching agent swarm: ${args.description}`,
      display: {
        kind: 'agent_call',
        agent_name: `swarm (${agentCount} subagents)`,
        prompt: args.description,
      },
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: AgentSwarmToolInput,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      this.swarmMode.enter('tool');
      if (args.run_in_background === true) {
        if (!this.canRunInBackground()) {
          return { output: SWARM_BACKGROUND_UNAVAILABLE, isError: true };
        }
        const taskId = await this.enqueueSwarm(args, context.toolCallId);
        return { output: taskId };
      }
      const result = await this.runSwarm(args, context.signal, context.toolCallId);
      return {
        output: result,
      };
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  /**
   * Background swarm: validate + build the batch up front (so bad input errors
   * surface in this turn), then register one detached task whose start drives
   * the whole batch. The tool returns immediately with a task id — the
   * supervisor turn is never pinned on a concurrency acquire; the batch starts
   * as slots free up and its completion arrives via the task's automatic
   * notification.
   */
  private async enqueueSwarm(
    args: AgentSwarmToolInput,
    toolCallId: string,
  ): Promise<string> {
    const { tasks, count } = await this.prepareSwarm(args, toolCallId, undefined);
    const todoId = args.todo_id;
    const assignee = normalizeOptionalString(args.subagent_type) ?? DEFAULT_SUBAGENT_TYPE;
    const launch = async (
      signal: AbortSignal,
    ): Promise<readonly SessionSwarmRunResult<AgentSwarmSpec>[]> => {
      const results = await this.swarmService.run({
        callerAgentId: this.callerAgentId,
        tasks: tasks.map((task) => ({ ...task, signal })),
      });
      this.writeTodoCompletion(todoId, renderSwarmWhatDone(results, args.description), assignee);
      return results;
    };
    const render = (results: readonly SessionSwarmRunResult<AgentSwarmSpec>[]): string =>
      renderSwarmResults(
        results.map(({ task, ...result }) => ({ spec: task.data as AgentSwarmSpec, ...result })),
      );
    const taskId = this.tasks.registerTask(
      new SwarmTask(launch, render, args.description, count),
      { detached: true },
    );
    return formatSwarmBackgroundResult(taskId, args.description, count);
  }

  private async runSwarm(
    args: AgentSwarmToolInput,
    signal: AbortSignal,
    toolCallId: string,
  ): Promise<string> {
    const { tasks } = await this.prepareSwarm(args, toolCallId, signal);
    const results = await this.swarmService.run({
      callerAgentId: this.callerAgentId,
      tasks,
    });
    this.writeTodoCompletion(
      args.todo_id,
      renderSwarmWhatDone(results, args.description),
      normalizeOptionalString(args.subagent_type) ?? DEFAULT_SUBAGENT_TYPE,
    );
    return renderSwarmResults(
      results.map(({ task, ...result }) => ({ spec: task.data as AgentSwarmSpec, ...result })),
    );
  }

  /** Shared validation + task-building for foreground and background swarms.
   *  `signal` is linked into the spawn tasks (foreground: the tool's abort
   *  signal; background: the detached task's sink signal, re-linked in the
   *  launch closure). */
  private async prepareSwarm(
    args: AgentSwarmToolInput,
    toolCallId: string,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly tasks: SessionSwarmTask<AgentSwarmSpec>[]; readonly count: number }> {
    this.assertDispatchTodo(args.todo_id);
    const profileName = normalizeOptionalString(args.subagent_type) ?? DEFAULT_SUBAGENT_TYPE;
    let spawnDuty = false;
    let resolveBindingFor: (item: string) => SubagentSpawnBinding | undefined =
      () => undefined;
    if ((args.items?.length ?? 0) > 0) {
      await this.catalog.ready;
      const own = this.profile.data();
      const allowlist = subagentAllowlistFor(this.catalog, own);
      if (allowlist !== undefined && !allowlist.includes(profileName)) {
        throw new Error2(
          ErrorCodes.AGENT_TYPE_NOT_ALLOWED,
          subagentTypeNotAllowedMessage(profileName, allowlist),
          { details: { profileName, allowlist } },
        );
      }
      const targetProfile = this.catalog.get(profileName);
      if (targetProfile === undefined) {
        throw new Error2(ErrorCodes.PROFILE_UNKNOWN, `Unknown agent type: "${profileName}"`, {
          details: { profileName },
        });
      }
      // On-duty members (`duty: true`) are exempt from the subagent timeout;
      // they go off duty via an explicit TaskStop.
      spawnDuty = targetProfile.duty === true;
      const itemModels = args.item_models ?? {};
      for (const key of Object.keys(itemModels)) {
        if (!args.items!.includes(key)) {
          throw new Error(`item_models key "${key}" does not match any item.`);
        }
      }
      const callerModelAlias = own.modelAlias;
      if (callerModelAlias !== undefined) {
        resolveBindingFor = (item) => {
          const perItem = itemModels[item];
          const binding = resolveSubagentBinding(
            this.config,
            this.flags,
            { modelAlias: callerModelAlias, thinkingLevel: own.thinkingLevel },
            perItem ?? args.model ?? targetProfile.modelPreference,
            targetProfile.name,
            perItem !== undefined
              ? 'item-models'
              : args.model !== undefined
                ? 'model-param'
                : 'model-preference',
          );
          return binding;
        };
      }
    }
    const timeoutMs = resolveSubagentTimeoutMs(this.config);
    const specs = await createAgentSwarmSpecs(args, (agentId) =>
      this.swarmService.getSwarmItem({ callerAgentId: this.callerAgentId, agentId }),
    );
    const runInBackground = args.run_in_background ?? false;
    const tasks: SessionSwarmTask<AgentSwarmSpec>[] = specs.map((spec) => {
      const descriptionName = spec.kind === 'resume' ? 'resume' : profileName;
      const common = {
        data: spec,
        profileName: spec.kind === 'resume' ? 'subagent' : profileName,
        parentToolCallId: toolCallId,
        prompt: spec.prompt,
        description: childDescription(args.description, spec.index, descriptionName),
        swarmIndex: spec.index,
        runInBackground,
        swarmItem: spec.item,
        signal,
      };
      if (spec.kind === 'resume') {
        return {
          ...common,
          kind: 'resume' as const,
          resumeAgentId: spec.agentId,
          timeout: timeoutMs,
        };
      }
      return {
        ...common,
        kind: 'spawn' as const,
        binding: resolveBindingFor(spec.item),
        timeout: spawnDuty ? undefined : timeoutMs,
      };
    });
    return { tasks, count: specs.length };
  }

  /**
   * Hard dispatch gate: every swarm dispatch must carry a `todo_id` that
   * exists and is not done. Missing / unknown / already-done todos are
   * rejected before any subagent starts — the same Error2 pattern as the
   * allowlist rejection.
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

  /**
   * Close the unit's todo once the swarm batch has run to completion (success
   * only — callers invoke it after `swarmService.run` resolves; a throwing
   * batch never reaches it). A failed writeback must not fail an already
   * completed batch, so it is swallowed here.
   */
  private writeTodoCompletion(
    todoId: string | undefined,
    whatDone: string,
    assignee: string,
  ): void {
    const id = todoId?.trim();
    if (id === undefined || id.length === 0) return;
    try {
      this.todo.setTodoCompleted(id, { whatDone, assignee });
    } catch {
      // Completion already succeeded; the writeback is best-effort.
    }
  }
}

registerAgentToolService(IAgentSwarmTool, AgentSwarmTool, { name: 'AgentSwarm', domain: 'swarm' });

async function createAgentSwarmSpecs(
  args: AgentSwarmToolInput,
  getResumeItem: (agentId: string) => Promise<string | undefined>,
): Promise<AgentSwarmSpec[]> {
  const resumeEntries = Object.entries(args.resume_agent_ids ?? {}).map(([agentId, prompt]) => ({
    agentId: agentId.trim(),
    prompt: prompt.trim(),
  }));
  const items = (args.items ?? []).map((item) => item.trim());
  const itemCount = items.length;
  const resumeCount = resumeEntries.length;
  const totalCount = resumeCount + itemCount;
  if (!hasMinimumAgentSwarmInputs(itemCount, resumeCount)) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      'AgentSwarm requires at least 2 items unless resume_agent_ids is provided.',
    );
  }
  if (totalCount > MAX_AGENT_SWARM_SUBAGENTS) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `AgentSwarm supports at most ${String(MAX_AGENT_SWARM_SUBAGENTS)} subagents.`,
      { details: { total: totalCount, max: MAX_AGENT_SWARM_SUBAGENTS } },
    );
  }
  const promptTemplate = normalizeOptionalString(args.prompt_template);
  if (items.length > 0 && promptTemplate === undefined) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      'prompt_template is required when items are provided.',
    );
  }
  if (promptTemplate !== undefined && !promptTemplate.includes(PROMPT_TEMPLATE_PLACEHOLDER)) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `prompt_template must include the ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder.`,
      { details: { placeholder: PROMPT_TEMPLATE_PLACEHOLDER } },
    );
  }

  const seenPrompts = new Map<string, number>();
  const specs: AgentSwarmSpec[] = [];
  for (const entry of resumeEntries) {
    specs.push({
      kind: 'resume',
      index: specs.length + 1,
      agentId: entry.agentId,
      item: await getResumeItem(entry.agentId),
      prompt: entry.prompt,
    });
  }
  if (items.length > 0) {
    const itemPromptTemplate = promptTemplate!;
    items.forEach((item, index) => {
      const prompt = itemPromptTemplate.split(PROMPT_TEMPLATE_PLACEHOLDER).join(item);
      const previousIndex = seenPrompts.get(prompt);
      if (previousIndex !== undefined) {
        throw new Error2(
          ErrorCodes.VALIDATION_FAILED,
          `Duplicate subagent prompts from items ${String(previousIndex)} and ${String(index + 1)}. AgentSwarm requires distinct subagents.`,
          { details: { previousIndex, index: index + 1 } },
        );
      }
      seenPrompts.set(prompt, index + 1);
      specs.push({
        kind: 'spawn',
        index: specs.length + 1,
        item,
        prompt,
      });
    });
  }
  return specs;
}

function hasMinimumAgentSwarmInputs(itemCount: number, resumeCount: number): boolean {
  return resumeCount > 0 || itemCount >= 2;
}

function childDescription(swarmDescription: string, index: number, profileName: string): string {
  return `${swarmDescription} #${String(index)} (${profileName})`;
}

function renderSwarmResults(results: readonly SwarmRunResult[]): string {
  const completed = results.filter((result) => result.status === 'completed').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const aborted = results.filter((result) => result.status === 'aborted').length;
  const shouldRenderResumeHint =
    results.some((result) => result.status !== 'completed') &&
    results.some((result) => result.agentId !== undefined);
  const lines = [
    '<agent_swarm_result>',
    `<summary>${renderSwarmSummary(completed, failed, aborted)}</summary>`,
  ];

  if (shouldRenderResumeHint) {
    lines.push(
      '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
    );
  }

  for (const result of results) {
    const agentId = result.agentId === undefined ? '' : ` agent_id="${result.agentId}"`;
    const mode = result.spec.kind === 'resume' ? ' mode="resume"' : '';
    const item = result.spec.item === undefined ? '' : ` item="${escapeXmlAttribute(result.spec.item)}"`;
    const state = result.state === undefined ? '' : ` state="${result.state}"`;
    const body = result.status === 'completed' ? (result.result ?? '') : (result.error ?? 'unknown error');
    lines.push(
      `<subagent${mode}${agentId}${item}${state} outcome="${result.status}">${body}</subagent>`,
    );
  }

  lines.push('</agent_swarm_result>');
  return lines.join('\n');
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function renderSwarmSummary(completed: number, failed: number, aborted = 0): string {
  const parts: string[] = [];
  if (completed > 0) parts.push(`completed: ${String(completed)}`);
  if (failed > 0) parts.push(`failed: ${String(failed)}`);
  if (aborted > 0) parts.push(`aborted: ${String(aborted)}`);
  return parts.join(', ');
}

/** How many characters of a swarm completion summary are kept for the todo
 *  writeback. */
const SWARM_WHAT_DONE_MAX_CHARS = 500;

/**
 * Brief completion summary for the swarm todo writeback: the batch description
 * plus the completed/failed/aborted tally (empty tally → description alone),
 * truncated.
 */
function renderSwarmWhatDone(
  results: readonly SessionSwarmRunResult<AgentSwarmSpec>[],
  description: string,
): string {
  const completed = results.filter((result) => result.status === 'completed').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const aborted = results.filter((result) => result.status === 'aborted').length;
  const tally = renderSwarmSummary(completed, failed, aborted);
  const base = tally.length > 0 ? `${description}: ${tally}` : description;
  return base.length > SWARM_WHAT_DONE_MAX_CHARS
    ? `${base.slice(0, SWARM_WHAT_DONE_MAX_CHARS)}…`
    : base;
}

/** Immediate result of a background swarm dispatch — one detached task wraps
 *  the whole batch; completion arrives via automatic notification. */
function formatSwarmBackgroundResult(
  taskId: string,
  description: string,
  subagentCount: number,
): string {
  return [
    `task_id: ${taskId}`,
    'status: running',
    `subagents: ${String(subagentCount)}`,
    'automatic_notification: true',
    '',
    `description: ${description}`,
    '',
    'next_step: The swarm is enqueued (已入队) — subagents start as concurrency slots free up, and the completion arrives automatically in a later turn. Do NOT wait, poll, or call TaskOutput on it; continue with other work or hand back to the user.',
    'resume_hint: When the completion notification arrives, continue unfinished subagents with AgentSwarm(resume_agent_ids=...) using the agent_id values in the result.',
  ].join('\n');
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
