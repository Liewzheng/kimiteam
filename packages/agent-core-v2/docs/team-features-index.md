# kimiteam 团队特性索引

> **维护说明**:本文件是 kimiteam 全部用户可见特性的总索引。**新特性落地时,必须同步在本表加一行**(设计文档 / doctrine 决策行 / 配置键 / 测试用例四栏各自更新);设计文档不存在时标「待补」,不得留空。
> 配置键均为 `[subagent]` 节(config.toml);测试用例前缀见 `team-manual-test.md` 约定块(`TC-<模块>-<序号>`)。

| 特性 | 设计文档 | doctrine 决策行(节) | 配置键 | 测试用例 | 说明 |
|---|---|---|---|---|---|
| 团队模式与 `/team` 命令族 | 待补(命令在 `apps/kimi-code/src/tui/commands/team.ts`) | Trigger→Action 决策表 | `team_mode` | TC-TEAM-001~003、012~017 | `/team on` / `/team init` / 面板;Team* 工具门控 |
| `/usage` 用量面板 | 待补 | 无 | 无 | TC-USAGE-001~003 | 按模型/成员统计;resume 恢复;真实 secondary id |
| 绩效体系(计分/通胀/penalty/未计分提醒) | [score-penalty.md](score-penalty.md)(过错扣分);计分/通胀/提醒无独立文档(doctrine + teamScoreTool) | Controlling 节 + 决策表 Member delivers / Score inflation / Penalty confirmed | 无(TeamScore 工具) | TC-TEAM-009~011、018 | 0-100;通胀窗口 10;penalty 追加负向条目;未计分自动提醒 |
| 两级 pipeline 注入 | 待补(注入在 `src/agent/profile/context.ts`) | Innovation 节 + 决策表 Same workflow seen twice | 无(pipeline.md 文件) | TC-PIPELINE-001 | 全局 `~/.kimi-code/pipeline.md` + 项目 `.kimi-code/pipeline.md` |
| 主管限时打断 | [lead-turn-timeout.md](lead-turn-timeout.md) | Controlling 节 Budget your turn + 决策表 Long-running task | `lead_turn_timeout_ms` | TC-LEAD-001~004 | 默认 30s,`0`=关;执行类才计入 |
| 过错扣分(penalty) | [score-penalty.md](score-penalty.md) | 决策表 User reports a defect / Penalty confirmed + 校准节 | 无(TeamScore penalty 动作) | 待补 | 追加负向条目;分级扣分;<80 停派观察 |
| 团队作用域(全局/项目) | 待补(onboarding skill) | 无(onboarding skill) | 无 | 待补 | 全局=`user` `~/.kimi-code/agents`;项目=`project` `<项目根>/.kimi-code/agents` |
| Web 团队面板 | 待补(`apps/kimi-web/src/components/team/TeamPanel.vue`) | 无 | 无 | TC-WEB-001~005 | `/web`;只读 roster + hire/fire/评分/递话/并发/teamMode |
| Onboarding(冷启动/调整/受控探测) | 技能本体 `src/app/skillCatalog/builtin/team-onboarding.md` | 无(onboarding skill) | 无 | TC-TEAM-004~008 | `/team init` 触发;4 问+追问;探测经同意;调整模式 |
| KV-cache 保活(停靠复用/冷回退/TTL/周期唤醒) | 待补(实现 `src/session/subagent/subagentWarmService.ts` + `src/session/duty/`;设计见 `.changeset/team-warm-keepalive.md`) | 决策表 Member finishes a unit + Controlling 长任务 | `idle_ttl_ms`、`warm_interval_ms`、`duty_idle_ttl_ms` | TC-TEAM-015~017 | 默认 2h;resting 复用、重启找回;周期唤醒保活 KV 缓存;duty 成员默认不收割 |
| 流水线调度(拆单/选人/后台队列) | 待补(实现 `src/session/duty/dutyScheduler.ts` + `src/session/swarm/sessionSwarmService.ts`) | 决策表 New task to dispatch / Multiple members / Queue backlog 等 | 无 | 待补 | ≤5min 拆单;standby 池 LRU 加权选人(得分+负载);swarm 后台批处理、池满自动入队;先看瓶颈 |
| /todo 派工挂钩与已完成工作面板 | 待补(制度条目:team-lead-doctrine.md 决策表) | 决策表 Any dispatch + Decision 工作单 + Controlling 回写 | 无(TodoList 工具) | 待补 | 每项派工必须带 `todo_id`(引擎强校验,缺失拒绝);todo 号自增(T1/T2…);完成回写 whatDone/assignee;/todo 面板查看已完成工作 |
| 手工测试用例 | [team-manual-test.md](team-manual-test.md) | 无 | 无 | (本文档即全集) | 45 条,ISO/IEC/IEEE 29119-3 Tailored Conformance 裁剪 |
