# agent-core-v2 架构全景报告

> 读者：kimiteam fork 维护者。定位：v2 引擎架构底稿，所有断言附 `文件:行号` 证据。
> 调研基线：`packages/agent-core-v2`（DI × Scope agent 引擎），对照 `packages/agent-core`（v1）、`packages/kap-server`、`packages/node-sdk`、`packages/klient`、`apps/kimi-code`。
> 方法：通读包级 AGENTS.md、项目级 skill、`docs/` 全部文档，再以 `registerScopedService` 全量登记点（172 处注册、167 个文件）为索引逐域读实现。
> 调研：杜衡（k3 1M），2026-08-07；主 agent 抽验 3 条事实断言全中后落盘。

## 0. 一句话结论

v2 是一个 **import 即注册的四层 DI 容器 + 每 Agent 一条可重放 Op 日志（wire）** 的引擎：没有中心装配文件，服务绑定散落在 167 个实现文件顶层；一次用户消息的全部状态变迁都先落成 `wire.jsonl` 的 Op 记录再进内存 Model；kimiteam 团队特性（subagent 域）以「Session 域协调者 + Agent 域工具 + App 域绩效/状态存储」三层形态挂在这棵树上，挂载点干净，但存在若干文档漂移与 v1 兼容噪音（详见 §9）。

## 1. 总览：四层 Scope 与 DI 容器

### 1.1 四层 LifecycleScope

`src/_base/di/scope.ts:15-20` 定义 `LifecycleScope`：`App(0) / Workspace(1) / Session(2) / Agent(3)`，数值越大寿命越短。Scope 是一棵严格递增的树（`scope.ts:187-193`：`createChild` 在 `kind <= this.kind` 时直接抛错），解析时子 scope 递归向父查找，由此**结构性**保证「短寿命可注入长寿命，反之不行」。

各层语义与主人：

| 层 | 语义 | 谁创建子 scope | 证据 |
|---|---|---|---|
| App | 进程级单例（log/config/telemetry/workspaceLifecycle/gateway…） | `Scope.createApp` | `scope.ts:168-179` |
| Workspace | 一个工作区 handler（共享 fs/git/mcp/skills/toolPolicy/trust） | `IWorkspaceLifecycleService.handlerFor`（create-or-get + in-flight join，**永不关闭**，随 App 销毁） | `app/workspaceLifecycle/workspaceLifecycleService.ts:1-16` |
| Session | 一次会话（sessionMetadata/agentLifecycle/subagent 协调者…） | handler 的 `ISessionLifecycleService` | `workspace/sessionLifecycle/sessionLifecycleService.ts:1-26` |
| Agent | 一个 agent（main 或 subagent；loop/prompt/contextMemory/wire/toolRegistry…） | `IAgentLifecycleService.create` | `session/agentLifecycle/agentLifecycleService.ts:149-162` |

「main agent 不特殊」：`MAIN_AGENT_ID` 只是按约定创建的 id（`agentLifecycleService.ts:15-17`）。

### 1.2 注册与激活机制

- `registerScopedService(scope, id, ctor, activation, domain)`（`scope.ts:37-53`）把 `(scope, ServiceIdentifier, SyncDescriptor, domain, activation)` 推进模块级 `_scopedRegistry`；**没有中心装配文件**，靠 `src/index.ts` 的 barrel re-export 触发 import 副作用完成全量注册（约定见 `docs/di.md:76-90`）。
- `ScopeActivation` 只有两种（`scope.ts:22-25`）：`OnScopeCreated`（默认，scope 创建时构造，任一构造失败则整个 scope 创建失败并回滚，`scope.ts:100-115`、`125-130`）与 `OnDemand`（首个 `get()` 时构造）。Agent 工具统一 `OnDemand`——构造器允许在宿主能力缺失时抛错（如 `WebSearchTool` 无 provider），见 `agent/toolRegistry/toolContribution.ts:5-13`。
- 创建子 scope 的统一入口是 `createScopedChildHandle(parent, kind, id, { extra })`（`scope.ts:117-136`）：筛出该层全部描述符 → `parent.createChild(collection)` → 激活 `OnScopeCreated` 服务 → 包一层 `ServicesAccessor` 返回 `IScopeHandle`。`extra` 是该 scope 的**种子**（seed），用于注入身份事实：Session 注入 `ISessionContext`（`sessionContext.ts:16-25`，含 `sessionId/workspaceId/metaScope/scope()`），Agent 注入 `IAgentScopeContext` 和绑了 `agent_id` 的 telemetry 视图（`agentLifecycleService.ts:157-160`）。
- 销毁顺序确定：子先死、同层按构造逆序，由 `Ledger` 台账执行（`scope.ts:155-161`、`217-233`）。
- 循环依赖是硬红线：容器同步构造遇环抛 `CyclicDependencyError`，激活方式不能破环（`docs/di.md:345-370`）。实例：`interactionService` 用 `invokeFunction` 懒解析 `IAgentLifecycleService` 来避开构造期环（`session/interaction/interactionService.ts:12-14`）。

### 1.3 Composition root

`bootstrap(input, extraSeeds)`（`app/bootstrap/bootstrap.ts:178-184`）= 解析 `BootstrapInput`（homeDir/configPath/env/clientIdentity，`bootstrap.ts:152-168`）→ `createAppScope({ extra: bootstrapSeed + storageSeed + skillSeed + extraSeeds })`。kap-server 与 node-sdk 两条宿主路径都从这里分叉（§7）。

另有横切基建值得一提：

- **State 注册表**：纯数据运行态不进服务字段，而是 `defineState` + `IAgentStateService.register/get/set`（如 `loopService.ts:92-100` 注册 `loop.nextReservedTurnId`），产物是 `docs/state-manifest.d.ts` 四级快照。
- **持久化分层**：业务域不碰 fs，只依赖按访问模式命名的 Store（`IAppendLogStore` / `IAtomicDocumentStore` / `IBlobStore` / `ISessionIndex`），见包级 `AGENTS.md:49-58`。
- **Telemetry**：一切业务事件走 `ITelemetryService.track2`，事件必须先注册进 `app/telemetry/events.ts`，编译器拒绝未注册事件名（包级 `AGENTS.md:37-47`）。

## 2. 核心运行链路：一条用户消息的完整路径

以 main agent 收到用户 prompt 为例（subagent 路径见 §6，差别仅在入口是 `runAgentTurn`）：

```
用户输入
  │  (kap-server REST / node-sdk klient facade / TUI)
  ▼
① IAgentPromptService.enqueue(input)            agent/prompt/promptService.ts:101-129
   - 分配 promptId，入 pending FIFO；active 槽空闲则 startNext()
   - fullCompaction 进行中且 loop 空闲 → 只排队（promptService.ts:118-122）
  ▼
② startNext() → loop.enqueue(new PromptStepRequest(...))   promptService.ts:186-211
  ▼
③ IAgentLoopService.enqueue/admit/pumpTurns      agent/loop/loopService.ts:179-231, 439-447
   - admission 四态：newTurn / activeOrNewTurn / activeOrNextTurn / activeTurnOnly（loopService.ts:196-219）
   - turn id 由 TurnModel.nextTurnId 预约（loopService.ts:356-361）
  ▼
④ startTurn：wire.dispatch(promptTurn(...)) → 发 'turn.started' 事件   loopService.ts:449-461
  ▼
⑤ run() 步循环（loopService.ts:608-634）：
   a. beginLoopStep：取一批 StepRequest（可合并），materializeBatch → context.append（loopService.ts:783-798）
   b. onWillBeginStep hooks → 发 'turn.step.started' + context.appendLoopEvent('step.begin')（loopService.ts:846-867）
   c. llmRequester.start：组装 ModelRequestInput（profile 系统提示 + contextProjector 历史投影
      + toolRegistry 工具表 + toolSelect 渐进披露），经 IModelCatalog 解析的 ModelRequester 发请求
      （agent/llmRequester/llmRequesterService.ts:1-29）
   d. 流式 part → eventBus 发 'assistant.delta' / 'thinking.delta' / 'tool.call.delta'
      （loopService.ts:1078-1108）
   e. 响应内容 → appendLoopEvent('content.part')（loopService.ts:869-885）
   f. executeStepTools → IAgentToolExecutorService.execute（loopService.ts:907-951）：
      每个 call 先记 'tool.call'、结果记 'tool.result'（均进 context 的 loop 事件流）
   g. finishStep：记 'step.end'（含 usage 与七项 LLM 计时）→ 发 'turn.step.completed'（loopService.ts:953-991）
   h. runAfterStep → onDidFinishStep hooks；finishReason=='tool_calls' 时由
      AgentLoopContinuationService  enqueue ContinuationStepRequest 续下一步
      （agent/loop/loopContinuationService.ts:29-37——loop 自身永不 enqueue）
  ▼
⑥ turn 收尾（runTurn finally，loopService.ts:493-543）：
   wire.dispatch(endTurn(...)) → 发 'turn.ended'（+失败时 'error'）→ telemetry → pumpTurns 下一棒
  ▼
⑦ promptService.settle：completionDeferred 落定、steered 子 prompt 跟随、发 'prompt.completed'/'prompt.aborted'
   （promptService.ts:213-222）
```

每环的关键服务与接口：

| 环节 | 服务（接口） | 文件 |
|---|---|---|
| prompt 调度 | `IAgentPromptService`（active 槽 + FIFO + steer/inject/retry） | `agent/prompt/prompt.ts`；实现 `promptService.ts:68-277` |
| 上下文事实 | `IAgentContextMemoryService`（get/append/appendLoopEvent/clear/undo/applyCompaction，全部经 wire） | `agent/contextMemory/contextMemoryService.ts:56-176` |
| 步循环 | `IAgentLoopService`（Turn FIFO + StepRequestQueue + 错误处理器链 + quiescence） | `agent/loop/loop.ts:138-166` |
| LLM 请求 | `IAgentLLMRequesterService`（每 turn 快照 prepareTurnConfig） | `llmRequesterService.ts:1-29` |
| 工具执行 | `IAgentToolExecutorService`（veto→readiness→ordered hooks→截断→遥测） | `agent/toolExecutor/toolExecutorService.ts:1-14` |
| 事件 | `IEventBus`（Agent 域事实总线） | `app/event/eventBus.ts:30-39` |
| 落盘 | `IWireService`（dispatch 即 reducer + journal） | `wire/wire.ts:22-33` |

**cancel/steer 机制**：

- cancel：`loop.cancel(turnId?)` → 先发 `cancelTurn` Op（active 或 queued 分开记，`loopService.ts:275-299`）→ abort controller。用户 ESC 与机制性打断的区分靠 reason 类型：`UserCancellationError` → `interruptReason: 'user_cancelled'`，普通对象 → `'aborted'`（leadTurnTimeout 利用这一点，`leadTurnTimeoutService.ts:22-27`）。
- steer：pending prompt 被合并为一条 user 消息包进 `SteerStepRequest`（admission=`activeTurnOnly` 语义），materialize 时落 `turn.steer` Op（`promptService.ts:135-157`）。`inject` 用 `activeOrNewTurn`——无活动 turn 就新开一个（`promptService.ts:170-176`），这是 TeamMessage、autoInitiative、dailyReview、leadTurnTimeout 四个团队机制共同的注入通道。
- 工具结果也能触发 steer：`toolExecutor` 的 `onDidExecuteTool` 钩子里 promptService 检查 `result.delivery.kind === 'steer'` 并 inject（`promptService.ts:87-90, 255-259`）。

**错误处理**：步内错误按序派发给 `registerLoopErrorHandler` 注册的处理器，first-match-wins；认领会自行 enqueue 续跑请求，loop 只感知「认领与否」（`loopService.ts:706-773`）。已注册方：`stepRetryService`、`fullCompactionService`（grep 证据：`src` 下仅这两处加 loop 自身调用 `registerLoopErrorHandler`）。未认领错误 → turn failed。

## 3. wire 与恢复

### 3.1 记录模型

- 每个 Agent 一条 `wire.jsonl`（key 常量 `AGENT_WIRE_RECORD_KEY`，`wire/record.ts:14`），首行是 `metadata` 信封（`protocol_version` + `created_at`，`record.ts:37-43`）。当前协议版本 **1.5**（`wire/migration/migration.ts:19`）。
- Op = `{ type, payload, descriptor }`；`defineOp` 在 import 时登记进全局 `OP_REGISTRY`（`wire/op.ts:100-122`），重复 type 抛 `DuplicateOpError`。schema（zod）是 payload 的单一事实源，但只在**边界**（restore 校验、manifest 生成）使用，运行路径不查（`op.ts:12-17`）。
- Op 可带 `toEvent(payload, state)`——live dispatch 时派生 IEventBus 事件，**restore 时永不发**（`wireService.ts:249-258` 的 silent 分支）。`persist: false` 的 Op 只进内存不落盘；归属由 `PersistedOpMap`/`TransientOpMap` 模块增强做编译期分类，同一 type 同时进两图会被 `ConflictingOpType` 判 never（`wire/types.ts:14-42`）。
- Model = `defineModel(name, initial, { blobs, reducers })`（`wire/model.ts:67-80`）。`reducers` 是跨模型 reducer，按外域 op type 登记进 `MODEL_CROSS_REDUCERS`（`model.ts:65`），dispatch 与 restore 都跑——**这是 v1 派生效果保持可重放而不需额外落盘的关键机制**（`model.ts:29-31`），实例：`TurnModel` 观察 `context.append_loop_event` 推进时钟（`turnOps.ts:34-49`）、`interruptionReminder` 投影 `turn.cancel`（`interruptionReminderOps.ts:20`）。
- 会话撤销（undo）：唯一持久事实是 `context.undo`；随 undo 走的状态必须用 `defineCheckpointedModel`（`agent/contextMemory/conversationTime.ts:50`）并自动进 `CHECKPOINTED_MODELS`；测试 `test/index.test.ts:175-206` 强制所有响应 `context.*` 的 model 要么 checkpointed 要么显式豁免（目前仅 `goalForkNotice`）。
- 大媒体走 blob：`ModelBlobCodec.dehydrate/rehydrate` 在落盘前把 data URI 卸到 blob store、replay 后只从**存活**状态回灌（`model.ts:11-24`；wireService `appendToJournal/rehydrateModels`，`wireService.ts:279-325`）。

### 3.2 restore/replay 流程（`wireService.ts:135-206`）

1. 顺序读 journal；首条非 metadata → 视为 v1.4 无信封日志，前置补写信封并只应用 `migrateV1_4ToV1_5`（`wireService.ts:159-163`）；首条是 metadata 但版本更新 → 原样 replay 不迁移（`170-171`）；版本更旧 → `resolveWireMigrations` 链式补齐（`migration.ts:41-62`，链：1.0→1.1→…→1.5，缺环抛 `WIRE_MIGRATION_MISSING`）。
2. 有版本漂移或补信封时，整个 journal **原子重写**（`log.rewrite`，`wireService.ts:195-197`）。
3. 逐条 replay：`replayRecord`（`213-228`）→ OP_REGISTRY 查 descriptor → zod `safeParse` 校验 payload → `execute(silent: true)`（不发事件、不再落盘）。
4. `rehydrateModels` → `restorePhase='ready'` → 跑 `hooks.onDidRestore`（`wire.ts:18-20` 唯一 wire hook）。

### 3.3 v1 兼容策略与 micro_compaction.apply 告警

策略是「**宽进**」三件套：

1. **未知类型跳过 + 告警，永不 fail**：`reportSkippedRecord` 把未知/畸形记录包成 `WIRE_UNKNOWN_RECORD` 走 `onUnexpectedError`（`wireService.ts:213-242`）。v1 同理（`test/index.test.ts:82-83` 注释：replay 容忍未知类型，旧 reader 优雅降级）。
2. **共享词汇表**：v2 落盘的每个持久 Op 必须属于 v1 词汇 / v2-only / v2 新增三集之一，测试强制（`test/index.test.ts:121-131`）。v1 词汇表在 `test/index.test.ts:32-66`。
3. **已知分叉**：`profile.bind` 与 `tools.reset_active_tools` 被刻意划为 v2-only——v1 replay 会静默跳过，`profile.bind` 丢失后 v1 的空 prompt 回退会把内建默认写回共享 wire 污染 v2——已接受 tradeoff，注释在 `test/index.test.ts:67-73`。

**`micro_compaction.apply` 告警的机制（已核实）**：v1 定义了该记录类型（`packages/agent-core/src/agent/records/types.ts:127`），v2 **完全没有 micro compaction**——v2 src 全量 grep `micro.?compaction` 零命中；v2 的压缩只有 fullCompaction（`full_compaction.begin/cancel/complete`，`compactionOps.ts:89-104`）。同理 `context.update_token_count`（v1 有，`records/types.ts:131`；v2 零命中，被 tokenCounting 域的 rebase/truncate Op 取代）。因此用 v2 resume 一份 v1 写过的会话时，这两条记录走未知类型分支 → 告警。**结论：告警是预期行为的噪音，不是数据损坏；消灭噪音的办法是在 OP_REGISTRY 注册这两个类型的 no-op 兼容 Op，或接受现状。**

## 4. 事件体系

### 4.1 双总线

- `IEventBus`：**Agent scope**，每 agent 一条，「这个 agent 发生了什么」的事实总线。域通过 `declare module '#/app/event/eventBus'` 增强 `DomainEventMap` 贡献事件形状（`app/event/eventBus.ts:1-17`）。订阅方只见本 agent 的事件，边缘层（server/SDK）负责扇出并打 `agentId/sessionId` 标签。
- `IEventService`：App scope 遗留全局总线（`app/event/eventService.ts:14-27`），进程级事件（模型目录、会话生命周期、auth）仍走这里；kap-server 的 `event.session.*`/`event.workspace.*`/`event.config.*` 全局族即源于此（`kap-server/AGENTS.md:27`）。

### 4.2 Agent 域事件目录（按增强点归组，证据均为 `declare module` 行号）

| 族 | 事件 | 发射方 | 证据 |
|---|---|---|---|
| turn 生命周期 | `turn.started/ended/step.started/step.completed/step.interrupted` | loopService | `agent/loop/turnEvents.ts:118-122` |
| 流式增量 | `assistant.delta/thinking.delta/tool.call.delta` | loopService（loopService.ts:1078-1108） | `turnEvents.ts:123-125` |
| 步重试 | `turn.step.retrying` | stepRetryService | `stepRetryService.ts:57` |
| prompt 调度 | `prompt.queued/steered/completed/aborted` | promptService（260-265） | `promptService.ts:51-54` |
| 工具 | `tool.call.started/tool.result/tool.progress` | toolExecutor | `toolExecutorEvents.ts:37-39` |
| 审批 | `permission.approval.requested/resolved` | toolApprovalService | `toolApprovalService.ts:56-57` |
| 压缩 | `compaction.started/blocked/cancelled/completed` | fullCompaction | `compactionOps.ts:74-77` |
| 上下文 | `context.spliced`（仅 live 路径，replay 静默） | contextMemoryService | `contextMemoryService.ts:45-54` |
| 撤销 | `context.undone` | undoService | `undoService.ts:44` |
| subagent | `subagent.spawned/started/completed/failed` + `subagent.suspended` | mirrorAgentRun / sessionSwarmService | `mirrorAgentRun.ts:66-71`、`sessionSwarmService.ts:74-78` |
| 任务 | `task.started/terminated/notified` | taskService/taskOps | `taskOps.ts:39-40`、`taskService.ts:213` |
| 计划 | `plan.revision` | planService | `planOps.ts:98` |
| goal | `goal.updated` | goalService | `goalOps.ts:71` |
| skill | `skill.activated` | skillService | `skillOps.ts:22` |
| usage | `agent.status.updated` | usageService | `usageOps.ts:28` |
| 活动视图 | `agent.activity.updated` | activityViewService | `activityView.ts:89` |
| shell | `shell.started/output/completed` | shellCommandService | `shellCommandService.ts:64-66` |
| mcp | `mcp.server.status/tool.list.updated` | mcpService | `mcpService.ts:80-81` |
| hooks | `hook.result` | externalHooksService | `agent/externalHooks/externalHooksService.ts:72` |
| cron | `cron.fired` | sessionCron | `session/cron/cronOps.ts:32` |
| 错误 | `error` | loopService（loopService.ts:514） | — |

**典型订阅方**：① kap-server 的 `SessionEventBroadcaster`（按 session/agent 粒度 + transcript 抑制规则扇出，`kap-server/AGENTS.md:24-27`）；② node-sdk 的 per-session wiring（`node-sdk/src/v2/session-wiring.ts:7-13`，含 `onDidCreate` 覆盖中途出现的 subagent）；③ 引擎内部——`leadTurnTimeoutService` 订 `tool.call.started/tool.result/turn.*` 自算执行预算（`leadTurnTimeoutService.ts:12-19`）、`externalHooksService` 把 `turn.started→TurnStarted` 等翻译成外部 hook 命令（`agent/externalHooks/externalHooksService.ts:1-13`）、`agentLifecycle` 订 `turn.ended` 清理 pending interaction（`agentLifecycleService.ts:110-116`）。

## 5. 配置体系

### 5.1 注册与解析

- 域用 `registerConfigSection` 在 import 时登记 section（`configSectionContributions`），`IConfigService`（App scope，`app/config/configService.ts:1-28`）按 **defaults → 用户 config.toml → 内存覆盖（最高，不持久）** 解析；写只落 `User` target。
- 每个 section 维护五层视图：`rawSnake`（盘上 snake_case 写基）/ `raw`（camelCase、无 env）/ `validated` / `effective`（+env overlay，每次 load/set 重算）/ `memory`；`delivered` 快照做深 diff 驱动 `onDidSectionChange`（`configService.ts:9-18`）。
- `envBindings`：env > 用户配置 > 默认；env 生效期间 `set` 会被 `stripEnvBoundFields` 还原成无 env 值再持久，防止 env 值漏进 config.toml（`app/config/config.ts:12-24`、`87-100`）。
- `deprecations`：旧 TOML 键忽略 + 告警；`deprecatedEnv` 旧 env 名仍作 fallback + 告警（`config.ts:56-67`）。
- 产物 `docs/config-manifest.toml` 由生成器产出、测试锁鲜；当前 **25 个 section + 3 个 overlay**（`config-manifest.toml:11-39`）。团队配置是其中之一：`subagent`，owner `src/session/subagent/configSection.ts`。

### 5.2 `[subagent]` 团队配置节（`session/subagent/configSection.ts`）

schema 在 `configSection.ts:74-159`，键位（盘上 snake_case）：`timeout_ms`（子 agent 超时，env `KIMI_SUBAGENT_TIMEOUT_MS` 覆盖）、`max_concurrency`（会话级并发上限）、`team_mode`（团队模式开关）、`idle_ttl_ms`（默认 2h）、`team_auto` / `auto_idle_ms`（默认 5min）、`lead_turn_timeout_ms`（默认 30s，`0`=关）、`model_overrides`（per-profile 模型覆盖）、`warm_interval_ms`（默认 30min，`0`=关）、`duty_idle_ttl_ms`（默认 0=永不收割）、`max_standby`（默认 8）、`standby_keepalive_ms`（默认 15min）。

`team_mode` 的解析优先级值得单独记住：**显式配置值 > `KIMI_CODE_TEAM_MODE` env > off**（`resolveTeamMode`，`configSection.ts:326-331`；env 是 kimiteam launcher 注入的默认值，`/team off` 写入 `team_mode=false` 后可压过 env，见文件头 `configSection.ts:13-18`）。`teamMode` 刻意**没有** envBindings——env 默认值活在配置文件之外。

## 6. 团队（subagent）域全貌

这是 fork 的命脉，逐服务给职责与挂载点。总结构：**两个 LLM 面工具（Agent/AgentSwarm，Agent scope）→ 三个 Session 域协调者（subagent/swarm/duty + pool）→ 四个 SessionSubagentService 私有的计时器助手（idleReaper/warm/dailyReview/autoInitiative）→ 两个 App 域持久存储（performance/runtimeStatus）→ 一个 Agent 域看守（leadTurnTimeout）**。

### 6.1 工具层

- **`Agent` 工具**（`agent/tools/agent/agentTool.ts`，1023 行）：LLM 面 wrapper。参数→Profile+Model binding→`IAgentLifecycleService.create`（或 resume）→`ISessionSubagentService.run`→`mirrorAgentRun` 把运行镜像回调用者的记录流（`agentTool.ts:1-26`）。kimiteam 深侵入点：注入 team-lead-doctrine（`agentTool.ts:115` `import AGENT_TEAM_LEAD_DOCTRINE from './team-lead-doctrine.md?raw'`），以及 **`todo_id` 派工强校验**（`agentTool.ts:369-379`：「派工必须携带 todo_id（/todo 创建或选择）」，`573/629` 行调用点）。
- **`AgentSwarm` 工具**（`agent/tools/agent-swarm/agentSwarmTool.ts`）：批量派生，委托 `ISessionSwarmService`；doctrine 不重复注入，只放一行指针（`agentSwarmTool.ts:21-23`）。
- **Team\* 工具 5 件**：`team-hire/team-fire/team-score/team-message/team-concurrency`（`agent/tools/team-*/`），同名 `registerAgentToolService` 注册；`TEAM_TOOL_NAMES` 清单在 `configSection.ts:308`，非团队模式时由 `toolPolicyService` 从 main agent 工具表隐藏（`agent/toolPolicy/toolPolicyService.ts:27-29`）——**门控的是可见性，模型绑定/duty 等机制不受门控**（`configSection.ts:85-92`）。
- 模型绑定解析链：显式 tool 参数 > profile `model_preference` > `[subagent.model_overrides]` > `[secondary_model]` 派生 > 继承调用者（`agentTool.ts:13-19`、`configSection.ts:20-41`）。

### 6.2 Session 域协调者

- **`ISessionSubagentService`**（`session/subagent/subagentService.ts:55-379`）：唯一的「驱动另一个 agent 跑一轮」入口 `run()`。**所有派遣路径（Agent 工具、AgentSwarm、显式 resume、复用认领）都汇聚于此**（`subagentService.ts:62-70`），因此它是团队监督的天然挂载点：run 开始=取消收割/保活计时+`runtimeStatus.markWorking`（`179-181`），run 落定=记录 `PerformanceShift`+arm 收割/保活+未计分提醒基线对比（`subagentService.ts:212-260`）。并发由 `ISubagentPoolService` 闸门（`pool.acquire`，`subagentService.ts:184-192`）。
- **`ISubagentPoolService`**（`session/subagentPool/subagentPoolService.ts:31-50`）：FIFO 等待队列；上限来源优先级 env/runtime override/config；调高即放人、调低不抢占。
- **`ISessionSwarmService`**（`session/swarm/sessionSwarmService.ts:82-100`）：批量运行协调者，内嵌 `AgentRunBatch` 调度器（burst-then-throttle 启动斜坡 + provider 限流恢复循环 + requeue 时发 `subagent.suspended`，`agentRunBatch.ts:1-8`）；`reservedForReuse` 集合保证同批次不重复认领同一停靠实例（`sessionSwarmService.ts:86-92`）。
- **`IDutySchedulerService`**（`session/duty/dutyScheduler.ts:62-76`）：standby 池（Phase-1 纯内存）+ LRU 加权选人——recency 权重 2、per-model 绩效分权重 1、负载权重 0.5（`dutyScheduler.ts:46-53`）；每次 pick 都以 lifecycle registry + session metadata 复核，陈旧池条目永远赢不了（`dutyScheduler.ts:7-10`）；无候选时回退冷重启路径 `findIdleOwnedSubagent`（`session/agentLifecycle/subagentReuse.ts:20-24`：从持久化 metadata + runtime-status 冷物化）。
- **`runAgentTurn`**（`session/subagent/runAgentTurn.ts:45-60`）：非 Service 的纯函数，借目标 agent scope 的 prompt/contextMemory/usage 跑一轮并蒸馏 summary——刻意不用 turn hooks（只有一个观察者，`runAgentTurn.ts:10-13`）。
- **`mirrorAgentRun`**（`session/subagent/mirrorAgentRun.ts:1-19`）：请求者侧镜像——发射 `subagent.*` 事件、触发 `SubagentStart/SubagentStop` 外部 hooks、记遥测；lifecycle registry 保持扁平，父子关联只存在于这一层。

### 6.3 四个计时器助手（均挂在 SessionSubagentService 构造器，`subagentService.ts:116-144`）

| 助手 | 职责 | 关键参数 | 证据 |
|---|---|---|---|
| `SubagentIdleReaper` | run 落定后 arm 空闲倒计时（默认 2h），到期仍空闲则 `lifecycle.remove` 下岗；run 开始即取消；main 永不 arm；duty profile 用 `duty_idle_ttl_ms`（默认 0=永不） | `idle_ttl_ms` | `session/subagent/idleReaper.ts:1-16, 87-90` |
| `SubagentWarmService` | 停靠实例周期发**零扰动**保活请求（完整前缀 + `thinkingEffort:'off'` + `maxCompletionTokens:1`，直打 `IModelCatalog.getRequester`，绕过 context/usage/loop/hooks），维持 provider 侧 KV cache；会话级在途上限 2 | `warm_interval_ms`（默认 30min，0=关） | `subagentWarmService.ts:1-31, 60-62` |
| `DailyReviewService` | 每本地日历日一次（锚定下一个本地午夜），团队模式下提醒 main 复盘最低分成员并施加一项优化；当天跳过即记账不重发 | 无配置键 | `dailyReviewService.ts:1-22` |
| `AutoInitiativeService` | `team_auto` 开 + main 空闲超 `auto_idle_ms` → 注入「review the project and apply ONE bounded improvement」；60s 一查，10min 防刷；`/team auto` 运行时切换经 `onDidSectionChange` 重 arm | `team_auto` / `auto_idle_ms` | `autoInitiativeService.ts:1-24, 43-46, 67-78` |

四个助手共享一套生命周期约定：Disposable+timer、session close 全清、冷恢复经 `agentLifecycle.onDidRestore` 统一 `reconcile`（`subagentService.ts:128-144`——onDidRestore 刻意在创建末尾发，handler 只见完整 handle，`agentLifecycleService.ts:178-184`）。三个提醒类机制（auto/daily/leadTimeout）用非 user 的 reminder origin 绕过 `UserPromptSubmit` 过滤器（`autoInitiativeService.ts:41` 等）。

### 6.4 App 域持久存储与 Agent 域看守

- **`IAgentPerformanceService`**（App scope，`app/agentPerformance/agentPerformanceService.ts:22-45`）：`<homeDir>/agents/performance.json`，每 profile 最多 50 条；进程内串行队列防丢更新，**跨进程 lost update 被显式接受**（分数是 advisory 数据，`agentPerformanceService.ts:25-31`）。
- **`IRuntimeStatusService`**（App scope，`app/runtimeStatus/runtimeStatusService.ts:63-80`）：`<homeDir>/agents/runtime-status.json`，键 `sessionId:profileName`；`markResting` 带实例代际检查防止旧实例的迟到 settle 覆盖新实例的 working（`runtimeStatusService.ts:14-27`）。驱动 `/team` 面板与 web 面板的 roster。
- **`ILeadTurnTimeoutService`**（Agent scope，`agent/leadTurnTimeout/leadTurnTimeoutService.ts:1-37`）：团队模式下对 main 的 displayable user turn arm 预算；自计时 `tool.call.started→tool.result` 按 `classifyToolCall` 只计 execution 类（dispatch/management/wait-user 不计，`leadTurnTimeoutService.ts:72-90`）；纯生成步（零工具调用）按 `llmStreamDurationMs` 计费；超预算→`loop.cancel({kind:'lead_turn_timeout'})`（非 UserCancellationError，记为 `aborted`）→**等 turn.ended 后**才 inject「派工别自己干」提醒。注意：此域计费口径已于 2026-08-07 改为「执行类工具耗时 + 全部 step 生成时长」（方向 A，韩述）。
- **`todoCounterService`**（App scope，`app/todoCounter/todoCounterService.ts`）：todo 号自增（T1/T2…），配合 agentTool 的 `todo_id` 强校验闭环。

### 6.5 深侵入点清单（与官方引擎编译期耦合，fork 必须随分支维护）

对照 `docs/kimiteam-kimi-coupling.md` 的红层，在 v2 代码中核实到：`agentTool.ts` doctrine 注入 + todo_id 强校验（§6.1）；`configSection.ts` 整个 `[subagent]` 节（§5.2）；`agent/profile/context.ts` 的 pipeline.md 两级注入与 model-roster 仅 main 注入（`context.ts:12-17, 35-39`）；`sessionTodo`/`todoItem` 扩展（`session/todo/`）。耦合文档称 externalHooks 有「21 事件」——**未逐一核实数量**。

## 7. 外围集成

### 7.1 两条宿主路径，同一个引擎

```
                        bootstrap(BootstrapInput) → Scope(App)     agent-core-v2/src/app/bootstrap/bootstrap.ts:178
                        ├── kap-server（进程外服务）
                        │     start.ts: composition root，route handler 用 core.accessor.get(IXxx)
                        │     REST /api/v1（全量）+ /api/v2（首个端点 GET /api/v2/sessions）
                        │     WS  /api/v1/ws（全局族全连接扇出 + 会话/agent 粒度订阅 + transcript 通道）
                        │     /api/v1/debug/* 反射全 DI registry（--debug-endpoints + loopback + bearer）
                        └── node-sdk（进程内嵌）
                              SDKRpcClientV2：bootstrap 引擎 + createKlient({ scope: app })（内存 transport）
                              未迁移方法 fall through 到 v1 getRpc() → 响亮报 not_implemented
```

证据：`kap-server/src/start.ts:1-8, 40-41`；`kap-server/AGENTS.md:3, 8, 10-12`；`node-sdk/src/sdk-rpc-client-v2.ts:1-12, 231-232, 442`。

### 7.2 kap-server 组合方式

- 路由handler 沿 **session 路由链** 解析：`ISessionIndex → IWorkspaceLifecycleService.handlerFor → handler 的 ISessionLifecycleService`，fs 路由同样 session→handler→Workspace 域 fs 服务（`kap-server/AGENTS.md:7`）。这正好对应 §1 的 Scope 树——**HTTP 层没有自己的状态，只是 scope 树的寻址器**。
- 会话工作聚合（busy/pending_interaction/last_turn_reason）由核心 `ISessionActivityView`（Session scope）持有，边缘只调度发射时机，**禁止在边缘折叠 per-agent 活动**（`kap-server/AGENTS.md:26`）。
- v1 兼容姿态：与 released client 保持 `/api/v1` wire 字节兼容，v1-only 行为隔离在 `<domain>Legacy` 边缘适配器（`.agents/skills/agent-core-dev/server-align.md`）。

### 7.3 node-sdk / TUI 接法

- `SDKRpcClientV2 extends SDKRpcClientBase`（v1 方法面）；已迁移域逐一 override（迁移清单见 `sdk-rpc-client-v2.ts:14-80` 文件头，含 config/plugins/session lifecycle/agent 控制/MCP 等大批）；`deleteSession` 仍 `not_implemented`——**v2 引擎没有任何会话删除能力**（`sdk-rpc-client-v2.ts:37-38`）。
- facade 够不到的地方走 `engineAccessor` 逃生舱直取 scope 服务（`sdk-rpc-client-v2.ts:511-518`：刻意为之的迁移便利，每处要注明它替代的 klient 方法）。
- 事件/交互桥接：每个 live session 一个 wiring（`v2/session-wiring.ts`）——订阅全部 live agent 的 IEventBus（含 `onDidCreate` 后出现的 subagent），事件经 `translateDomainEvent` 同步推给 client；v2 的 pending-interaction（pull）被桥回 v1 的 approval/question/toolCall 回调（push）语义。
- resume 回放：v1 的 per-agent 快照中 `replay`/`toolStore` 两片是**用 v1 引擎自己的 restore 管线**折叠 v2 的 `wire.jsonl` 得到的（`sdk-rpc-client-v2.ts:40-45`，`src/v2/resume-replay.ts`）——v1 回放器仍能读 v2 wire 的实证。
- TUI 引擎选择：`isKimiV2Enabled()` 默认 true（v2 为默认路径），`KIMI_CODE_LEGACY_FLAG` truthy 才回 v1；`kimi web` 永远起 kap-server 不看开关（`apps/kimi-code/src/cli/experimental-v2.ts:1-12, 31-35`；`run-shell.ts:84-90`）。

### 7.4 两条路径的服务注册差异

**注册本身无差异**——同一份 `_scopedRegistry`，同一个 `bootstrap()`。差异只在：① seed（node-sdk 可传 `extraSeeds`；kap-server 从 `BootstrapInput` 组装 clientIdentity 等）；② 取数方式（kap-server 路由直取 `core.accessor`；node-sdk 优先 klient facade、不足走 engineAccessor）；③ kap-server 多了边缘进程内服务（TranscriptService、broadcaster、全局搜索等，**不进核心 DI**，由 start.ts 手工组合）；④ node-sdk 的 SDKRpcClientV2 自己持有 `KimiAuthFacade`/telemetry 包装层。

## 8. 与 v1 的对照

### 8.1 概念映射表

| v1（`packages/agent-core/src`） | v2 | 证据 |
|---|---|---|
| `Agent` 类（上帝对象：ContextMemory/ToolManager/TurnFlow/AgentRecords/Micro+FullCompaction/GoalMode/PlanMode/SwarmMode…，`agent/index.ts:28-60`） | **Agent scope 全域服务**（loop/prompt/contextMemory/toolExecutor/wire/profile/goal/plan/swarm…） | §1-2 |
| `Session`（subagent-host/subagent-binding/subagent-batch） | **Session scope**：`agentLifecycle` + `subagent` + `sessionSwarm` + `duty` + `subagentPool` | §6.2 |
| `agent/records`（AgentRecords + replay switch） | **wire 域**：Op/Model/OP_REGISTRY + restore；v1 的 replay switch → v2 的 OP_REGISTRY 查表 + 跨模型 reducer | §3 |
| `Loop`/`TurnFlow` | `agent/loop`（Turn/Step 两级 + StepRequest admission） | §2 |
| `config`（KimiConfig） | `app/config` section registry + 五层视图 | §5 |
| `flags`（FlagResolver） | `app/flag` + `registerFlagDefinition` + `[experimental]` section | `docs/flag.md` |
| `session/hooks`（HookEngine） | `agent/externalHooks`（Agent 域适配器）+ `app/externalHooksRunner` | `externalHooksService.ts:1-13` |
| `MicroCompaction` | **不存在**（已核实：v2 src 零命中；只有 fullCompaction） | §3.3 |
| `KimiCore` RPC 对 | `agent/rpc` + klient facade + kap-server REST/WS | §7 |
| records 单 Agent 日志 | 同样每 Agent 一条 `wire.jsonl`，协议 1.5，v1.4 无信封日志可升级 | §3.2 |

### 8.2 迁移状态

- **已迁**：核心运行链路全部（§2）；配置/插件/session lifecycle/agent 控制/MCP/cron/goal/skills（node-sdk 迁移清单 `sdk-rpc-client-v2.ts:14-80`）；团队域整体（本 fork 特性在 v2 上是原生一等公民，见 §6）。
- **明确未迁/无等价物**：micro compaction；`deleteSession`（引擎无删除能力）；image ingestion limits（`sdk-rpc-client-v2.ts:2230-2232`，落回 env/默认）；print 模式的 waitForBackgroundTasks 策略（在 SDK 侧重建，引擎无归属服务，`sdk-rpc-client-v2.ts:72-76`）。
- **不再需要**：v1 的 records replay switch（被 OP_REGISTRY + 跨模型 reducer 取代）、`MicroCompaction`、`ConfigState`（被 section registry 取代）、v1 上帝 Agent 的手动组合（被 scope 激活取代）。
- **注意**：v1 引擎仍是 node-sdk 的编译依赖——`SDKRpcClientBase` 类型面与 `resume-replay.ts` 都 import `@moonshot-ai/agent-core`（`session-wiring.ts:25-34`）。「全面转向 v2」在 SDK 类型面收口前，v1 包不能从依赖树删除。

## 9. 风险与观察

按严重度排序，均附证据；每条给了验证方法或处置建议。

1. **文档漂移（确定性问题，建议立即修）**
   - 包级 `AGENTS.md:3` 引用 `plan/PLAN.md` 与 `GAP_ANALYSIS.md`，两者**均不存在**（glob `{GAP_ANALYSIS.md,plan/*,PLAN.md}` 零命中；`docs/flag.md` 也引用 GAP_ANALYSIS）。新维护者按图索骥会扑空。→ 删引用或补文件。
   - `docs/di.md` 场景 5/8 以 `gatewayService.ts` 的 `IScopeRegistry`/`ScopeRegistry` 为参考实现，但 `ScopeRegistry` 在 v2 全仓只在 di.md 自身出现（grep 证据）；实际 `app/gateway/gatewayService.ts` 是 RestGateway/WSGateway。di.md 是教学文档，示例可虚构，但点名了真实文件路径，构成误导。→ 把参考换成真实文件或标注为示意。
2. **v1 兼容告警噪音（预期行为，但会反复吓到用户）**：`micro_compaction.apply` / `context.update_token_count` 无 v2 Op，resume v1 会话必告警（§3.3）。处置二选一：注册 no-op 兼容 Op 消音（小改动，但要在 `V1_RECORD_TYPES` 测试语义里说清「认识但忽略」），或在告警文案层降噪。**未核实**：`onUnexpectedError` 的最终呈现形态（toast/log/telemetry），降噪前先看它落到哪。
3. **四个团队计时器助手不是 DI 服务**：idleReaper/warm/dailyReview/autoInitiative 由 `SessionSubagentService` 构造器手工 `new` 并手传依赖（`subagentService.ts:116-127`）。这是有意设计（header 解释了汇聚点理由），但代价是：无法用 DI stub 单独替换其一做测试、依赖变更要改两处的风险。当前可接受；若助手继续增多（第 5 个），建议抽一个 `subagentSupervisors` 聚合。**暂不动**。
4. **模块级可变全局 `nextAgentId`**（`agentLifecycleService.ts:61`）：进程内跨 session 共享的序号计数器，靠 metadata 扫描兜底正确性，但多 session 并存时序号会跨 session 消耗（`agent-7` 可能属于另一个 session）。语义上无害（id 只需唯一），但如果任何 UI/运维假设「序号小=同 session 早创建」，会误判。→ 观察项，暂不动。
5. **wire 落盘失败静默**：`appendRecord` 的 `onError` 是 `onUnexpectedError`（`wireService.ts:309-313`），`appendToJournal` 的异步队列失败也只 `onUnexpectedError`（`302`）。写盘失败不阻塞业务是对的，但意味着「以为持久化了其实没有」时只有一条错误上报。风险评估：appendLogStore 层是否有自己的重试/告警未核实。
6. **跨进程持久数据丢更新被显式接受**：runtimeStatus（`runtimeStatusService.ts:71-73`）与 performance（`agentPerformanceService.ts:28-31`）都只防进程内并发。两个 kimi 进程同时开同一团队会话时 roster/分数可能互相覆盖。注释已声明 advisory，但 kimiteam 若把绩效用于真实考核，这个上限要写进团队文档。
7. **interaction pending 不可恢复**：interaction kernel 的 pending 纯内存，冷恢复后只有 journal 能重建实体，pending promise 永远丢失（`interactionService.ts:14-16`）——进程重启时挂起的审批/提问静默消失。kap-server 的 transcript 有补偿路径，TUI 重启场景下用户感知是「审批弹窗没了」。设计内取舍，列为已知行为。
8. **死代码/未竟项**：`node-sdk` 的 `deleteSession` 显式 not_implemented 且引擎无能力（`sdk-rpc-client-v2.ts:37-38`）；`sdk-rpc-client-v2.ts:2230-2232` imageLimits 传 undefined 的窟窿；kap-server `/api/v2` 目前只有 sessions 一个端点。均为已知迁移尾巴，非隐患。
9. **未核实项汇总**：externalHooks「21 事件」数量（coupling 文档说法）；`agentRunBatch` 的限流恢复参数是否与 v1 subagent-batch 完全一致（只读了文件头）；`klient` 包 ipc transport 的成熟度（只确认存在 `transports/ipc/`，未读实现）。

---

## 附：关键证据索引（速查）

- DI 内核：`src/_base/di/scope.ts:15-25, 37-53, 117-136, 168-211`
- Composition root：`src/app/bootstrap/bootstrap.ts:178-201`
- 运行链路：`agent/prompt/promptService.ts:101-277` → `agent/loop/loopService.ts:179-1108` → `agent/llmRequester/llmRequesterService.ts` → `agent/toolExecutor/toolExecutorService.ts`
- wire：`wire/wire.ts:22-33`、`wireService.ts:105-325`、`op.ts:100-122`、`migration/migration.ts:19-62`
- 事件总线：`app/event/eventBus.ts:24-39`
- 团队域：`session/subagent/{subagentService,idleReaper,subagentWarmService,dailyReviewService,autoInitiativeService,runAgentTurn,mirrorAgentRun,configSection}.ts`、`session/{duty,swarm,subagentPool}/`、`agent/leadTurnTimeout/`、`app/{agentPerformance,runtimeStatus,todoCounter}/`
- 宿主集成：`kap-server/src/start.ts`、`node-sdk/src/sdk-rpc-client-v2.ts`、`node-sdk/src/v2/session-wiring.ts`、`apps/kimi-code/src/cli/experimental-v2.ts`
