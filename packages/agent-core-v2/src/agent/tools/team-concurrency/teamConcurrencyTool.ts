/**
 * `team-concurrency` tool domain (L7) — `ITeamConcurrencyTool` implementation.
 *
 * Lets the main agent inspect the subagent pool state (`get`), set a runtime
 * concurrency limit override (`set`), or gather machine-resource / model-
 * topology / historical evidence and receive a concurrency suggestion
 * (`evaluate`). Subagent callers are rejected. Bound at Agent scope.
 */

import * as os from 'node:os';

import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ILogService } from '#/_base/log/log';
import { IConfigService } from '#/app/config/config';
import { MODELS_SECTION, PROVIDERS_SECTION } from '#/app/kosongConfig/configSection';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';
import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { IAgentPerformanceService } from '#/app/agentPerformance/agentPerformance';

import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { isSubagentMeta } from '#/session/agentLifecycle/subagentMetadata';
import { ISubagentPoolService } from '#/session/subagentPool/subagentPool';
import {
  ITeamConcurrencyTool,
  TeamConcurrencyInputSchema,
  SUBAGENT_NOT_ALLOWED_MSG,
  type TeamConcurrencyInput,
} from './team-concurrency';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

const TOOL_DESCRIPTION =
  'Manage subagent concurrency — inspect pool state, override the limit, or evaluate the optimal concurrency ceiling.\n' +
  '\n' +
  'When to use:\n' +
  '  - Before dispatching many subagents: evaluate whether the machine can handle more parallel work.\n' +
  '  - During resource pressure: tighten the limit to avoid OOM or CPU thrashing.\n' +
  '  - After adding new models: re-evaluate to see which models are local vs online.\n' +
  '\n' +
  'Priority (highest to lowest):\n' +
  '  1. `KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY` env var\n' +
  '  2. Runtime override (`set` action) — session-scoped, volatile, does NOT write to config.toml\n' +
  '  3. `[subagent] max_concurrency` in config.toml\n' +
  '  4. Unlimited (no limit)\n' +
  '\n' +
  'Actions:\n' +
  '  - `get`: Read current pool state (effective limit, source, active and queued counts).\n' +
  '  - `set <value>`: Apply a session-level runtime limit override (integer ≥ 1). Stays in effect for this session until changed.\n' +
  '  - `evaluate`: Machine snapshot + model topology + history + advice. The final decision is yours.';

export class TeamConcurrencyTool implements ITeamConcurrencyTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TeamConcurrency';
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TeamConcurrencyInputSchema);
  private readonly callerAgentId: string;

  constructor(
    @ISessionMetadata private readonly sessionMeta: ISessionMetadata,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @ISubagentPoolService private readonly pool: ISubagentPoolService,
    @IAgentPerformanceService private readonly perf: IAgentPerformanceService,
    @IConfigService private readonly config: IConfigService,
    @ILogService private readonly log: ILogService,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  get description(): string {
    return TOOL_DESCRIPTION;
  }

  async resolveExecution(args: TeamConcurrencyInput): Promise<ToolExecution> {
    if (await this._isCallerSubagent()) {
      return { output: SUBAGENT_NOT_ALLOWED_MSG, isError: true };
    }

    const actionLabel = args.action === 'set' ? `set ${args.value}` : args.action;
    return {
      description: `Subagent concurrency — ${actionLabel}`,
      accesses: ToolAccesses.none(),
      display: { kind: 'generic', summary: `concurrency: ${actionLabel}` },
      approvalRule: this.name,
      execute: async (ctx) => this._execute(args, ctx),
    };
  }

  private async _isCallerSubagent(): Promise<boolean> {
    const meta = (await this.sessionMeta.read()).agents?.[this.callerAgentId];
    return isSubagentMeta(meta);
  }

  private async _execute(
    args: TeamConcurrencyInput,
    _ctx: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    switch (args.action) {
      case 'get':
        return this._handleGet();
      case 'set':
        return this._handleSet(args.value);
      case 'evaluate':
        return this._handleEvaluate();
    }
  }

  private _handleGet(): ExecutableToolResult {
    const state = this.pool.state();
    const lines: string[] = [
      `[TeamConcurrency] Subagent pool state:`,
      `  Limit:   ${state.limit ?? 'unlimited'}`,
      `  Source:  ${this._formatSource(state.limitSource)}`,
      `  Active:  ${state.active}`,
      `  Queued:  ${state.queued}`,
    ];
    if (state.limit === undefined) {
      lines.push(`  (No ceiling — all dispatches proceed immediately.)`);
    } else if (state.active >= state.limit) {
      lines.push(`  ⚠️  Pool is saturated — new dispatches will queue.`);
    }
    return { output: lines.join('\n') };
  }

  private _formatSource(source: string): string {
    switch (source) {
      case 'env':
        return 'Environment variable (KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY)';
      case 'runtime':
        return 'Runtime override (TeamConcurrency set)';
      case 'config':
        return 'Configuration file ([subagent] max_concurrency)';
      case 'none':
        return 'No limit configured — effectively unlimited';
      default:
        return source;
    }
  }

  private _handleSet(value?: number): ExecutableToolResult {
    if (value === undefined) {
      return {
        output:
          '[TeamConcurrency] `value` is required when `action` is "set". Usage: { action: "set", value: <integer ≥ 1> }',
        isError: true,
      };
    }

    this.pool.setRuntimeLimit(value);
    const state = this.pool.state();
    const lines: string[] = [
      `[TeamConcurrency] Runtime limit set to ${value}. New state:`,
      `  Limit:   ${state.limit ?? 'unlimited'}`,
      `  Source:  ${this._formatSource(state.limitSource)}`,
      `  Active:  ${state.active}/${state.limit ?? '∞'}`,
      `  Queued:  ${state.queued}`,
    ];
    lines.push(
      ``,
      `This override is session-scoped and volatile — it does NOT write to config.toml.`,
      `To make it permanent, update [subagent] max_concurrency in your configuration file.`,
    );
    return { output: lines.join('\n') };
  }

  private async _handleEvaluate(): Promise<ExecutableToolResult> {
    const parts: string[] = [
      `[TeamConcurrency] Concurrency evaluation`,
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ];

    // a) Machine snapshot
    const cpus = os.cpus().length;
    const totalMemGB = os.totalmem() / 1024 ** 3;
    const freeMemGB = os.freemem() / 1024 ** 3;
    const loads = os.loadavg();
    const load1 = loads[0] ?? 0;
    const load5 = loads[1] ?? 0;
    const load15 = loads[2] ?? 0;
    parts.push(
      `── Machine snapshot ──`,
      `  CPUs:        ${cpus} logical cores`,
      `  Total RAM:   ${totalMemGB.toFixed(2)} GB`,
      `  Free RAM:    ${freeMemGB.toFixed(2)} GB`,
      `  Load avg:    ${load1.toFixed(2)} (1m) / ${load5.toFixed(2)} (5m) / ${load15.toFixed(2)} (15m)`,
    );

    // b) Model classification — group by whether the effective endpoint is
    //    loopback (local) or remote (online).
    const models = this._getRawConfig(MODELS_SECTION);
    const providers = this._getRawConfig(PROVIDERS_SECTION);
    const local: string[] = [];
    const online: string[] = [];
    const unknown: string[] = [];

    for (const [modelId, modelCfg] of Object.entries(models)) {
      if (typeof modelCfg !== 'object' || modelCfg === null) {
        unknown.push(modelId);
        continue;
      }
      const entry = modelCfg as Record<string, unknown>;
      let baseUrl: string | undefined;

      // Direct model-level baseUrl takes precedence.
      if (typeof entry['baseUrl'] === 'string') {
        baseUrl = entry['baseUrl'];
      }
      // Fall back to the provider's baseUrl via providerId.
      if (baseUrl === undefined && typeof entry['providerId'] === 'string') {
        const providerEntry = providers[entry['providerId']];
        if (typeof providerEntry === 'object' && providerEntry !== null) {
          const pUrl = (providerEntry as Record<string, unknown>)['baseUrl'];
          if (typeof pUrl === 'string') {
            baseUrl = pUrl;
          }
        }
      }

      if (baseUrl === undefined) {
        unknown.push(modelId);
      } else {
        try {
          const hostname = new URL(baseUrl).hostname;
          if (LOOPBACK_HOSTS.has(hostname)) {
            local.push(modelId);
          } else {
            online.push(modelId);
          }
        } catch {
          unknown.push(modelId);
        }
      }
    }

    const classifyLine = (label: string, items: string[]): string => {
      if (items.length === 0) return `  ${label}: (none)`;
      return `  ${label} (${items.length}):\n${items.map((id) => `    - ${id}`).join('\n')}`;
    };
    parts.push(
      `── Model topology ──`,
      classifyLine('Local (loopback)', local),
      classifyLine('Online (remote)', online),
      classifyLine('Unknown (no baseUrl)', unknown),
    );

    // c) Historical evidence — profiles with timing or by-model breakdowns.
    const profiles = await this.perf.list();
    const perfLines: string[] = [];
    for (const entry of profiles) {
      const s = entry.summary;
      const detail: string[] = [`    ${entry.profileName}`];
      if (s.avgDurationMs !== undefined) {
        detail.push(`avg duration: ${s.avgDurationMs.toFixed(0)} ms`);
      }
      if (s.byModel !== undefined) {
        const modelParts = Object.entries(s.byModel).map(([m, stats]) => {
          const parts = [`${m}: ${stats.count}x`];
          if (stats.average !== undefined) {
            parts.push(`avg ${stats.average.toFixed(0)}`);
          }
          return parts.join(' ');
        });
        detail.push(`by model: [${modelParts.join('; ')}]`);
      }
      if (s.count > 0) {
        detail.push(`total scores: ${s.count}`);
        if (s.average !== undefined) detail.push(`avg score: ${s.average.toFixed(1)}`);
      }
      if (detail.length > 1) {
        perfLines.push(detail.join(' — '));
      }
    }
    parts.push(
      `── Historical performance evidence ──`,
      perfLines.length > 0
        ? perfLines.join('\n')
        : '  (No performance history yet — scores will appear after TeamScore is used.)',
    );

    // d) Concurrency advice
    const suggestedLocal = Math.max(1, Math.floor(freeMemGB / 16));
    const suggestedOnline = Math.min(online.length, 8);
    const suggestedTotal = suggestedLocal + suggestedOnline;

    const adviceLines: string[] = [
      `── Concurrency advice ──`,
      `  Local models share unified memory bandwidth — too many concurrent local`,
      `  inferences can cause OOM or severe slowdown.  Suggested local concurrency:`,
      `  ≤ ${suggestedLocal} (max(1, floor(${freeMemGB.toFixed(1)} GB free / 16)).`,
      ``,
      `  Online models do not consume local GPU/CPU resources for inference, but may`,
      `  have API rate limits and cost implications.`,
    ];

    if (local.length > 0 && online.length > 0) {
      adviceLines.push(
        `  Recommended distribution: local ${suggestedLocal} + online ${suggestedOnline}.`,
      );
    } else if (local.length > 0) {
      adviceLines.push(
        `  All models are local — consider a conservative limit of ${suggestedLocal}.`,
      );
    } else {
      adviceLines.push(
        `  All models are online — concurrency is mainly limited by API rate limits and cost.`,
      );
    }
    adviceLines.push(
      ``,
      `  Final decision: use \`set\` to apply your chosen limit.  This advice is for`,
      `  reference only — adjust based on your actual workload and observed behavior.`,
    );

    parts.push(...adviceLines);
    return { output: parts.join('\n') };
  }

  /** Read a raw config section, returning {} on missing or non-object values. */
  private _getRawConfig(section: string): Record<string, unknown> {
    try {
      const raw = this.config.get(section);
      return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
}

registerAgentToolService(ITeamConcurrencyTool, TeamConcurrencyTool, { name: 'TeamConcurrency', domain: 'team' });
