# lead-turn-timeout(主管回合限时:软提醒 + 代码层硬限制)

## 背景与目标

团队模式下,主管(主 agent)常陷在「执行类」工作里:自己读文件、改代码、跑命令、长生成——烧光上下文、卡住不派工,违背 doctrine「执行不是你的活」。本设计给主管的用户回合加一个 **回合预算**(执行类工具耗时 + 全部 step 的 LLM 生成时长):预算烧光后,`warn` 模式打断并注入提醒,`enforce`(默认)模式在代码层阻断执行类工具调用,只允许派工/管理/等待用户,续时须经用户许可。

## 机制说明

- **用户回合武装**:仅在用户发起的回合(用户消息之后的主管回合)武装计时;其他 agent 轮(如 subagent 回传结果触发的回合)**不武装**(见「已知缺口」)。武装门槛:main agent + team mode + 预算 > 0 + `lead_turn_gate ≠ off`。
- **回合预算**:预算 = 执行类工具耗时(按 toolCallId 自打点累计 `tool.call.started` → `tool.result`)+ **全部已完成 step 的 LLM 生成时长**(`turn.step.completed.llmStreamDurationMs`,无论该 step 是否调用工具)。LLM 流式段只覆盖生成区间,工具执行发生在 step 之间,两者墙钟区间不重叠——同时计入**不是重复计费**;达到阈值(`[subagent] lead_turn_timeout_ms`)即触发。
- **两档模式**:
  - **`warn`(软提醒)**:`cancel → turn.ended → inject`——先取消当前正在执行的 step,再结算该 turn 的结束,最后注入提醒文本;注入走 `system_trigger` 通道,注入本身**不再武装计时**(防递归),且**同一 turnId 只注入一次**。提醒可被继续忽略,这是软约束。
  - **`enforce`(硬限制,默认)**:预算超限后**不 cancel**,而是 `lock()` 锁定该回合;此后每个「执行类」工具调用在 executor 的 `onBeforeExecuteTool` 被 **veto**(代码层阻断,模型收到一条 `isError` 结果,只能改走派工/管理/等待类)。首个被拦的执行类调用发起**用户续时授权**;拒绝/超时后本轮锁定期内不再重复弹问,静默锁到回合结束;`lead_turn_lock_cap_ms` 兜底强制取消跑飞(如纯文本生成不停)的锁定回合。
- **配置键**:`[subagent] lead_turn_timeout_ms`(默认 30s,`0`=关闭)、`lead_turn_gate`(`off|warn|enforce`,默认 `enforce`)、`lead_turn_grant_ms`(默认 30s,`0`=不提供续时)、`lead_turn_grant_timeout_ms`(默认 60s,`0`=不发问)、`lead_turn_max_grants`(默认 5)、`lead_turn_lock_cap_ms`(默认 120s,`0`=不设)。
- **分类器排除等待**:等待不计用分类器排除而非暂停计时——`AskUserQuestion` 归 `wait-user` 类不计;审批在 `tool.call.started` 之前天然不计(无 interaction 内核暂停)。

## 行为分类表

| 行为类别 | 判定依据 | 是否计入预算 |
|---|---|---|
| 执行计入 | 执行类工具调用(toolCallId)耗时 + 全部 step 的 LLM 生成时长(流式段与工具执行墙钟区间不重叠,双计非重复) | 计入 |
| 管理不计 | step 工具名为派工/管理类(Agent/AgentSwarm/TeamHire/TeamFire/TeamScore/TeamMessage/TeamConcurrency 等)——工具耗时不计,该 step 的生成时长仍计入 | 工具不计、生成计入 |
| 等待用户不计 | `AskUserQuestion` 归 `wait-user` 类——工具耗时不计,该 step 的生成时长仍计入;审批在 `tool.call.started` 之前天然不计 | 工具不计、生成计入 |
| 前台派工 in-flight 豁免 | step 为前台派工(等待 subagent 结果,`run_in_background=false`)阻塞 | 不打断:预算超限时延时等待其结束,打断只针对执行类 |

## 边界清单

- **全部 step 生成计入**:每个已完成 step 的 LLM 生成时长(`turn.step.completed.llmStreamDurationMs`)都计入预算——无论该 step 是否调用工具,长生成计入(doctrine「long generations count」)。流式段与工具执行墙钟区间不重叠,工具耗时 + 生成时长同时计入不构成重复计费。**TTFT(首 token 延迟,`firstTokenLatencyMs`)不计入预算**——只计自首 token 到流结束的生成时长;请求挂起无首 token 时累计为 0,不会误触发打断。
- **TaskOutput 查岗不计**:后台任务快照等「查岗类」调用不计入。
- **重试累计**:同一 step 的重试耗时累计计入,不因重试重置预算。
- **ESC 去重不注入**:用户 ESC 打断后,若同一 turnId 已注入过提醒,不再重复注入。
- **默认 30s 可配 0=关**:`lead_turn_timeout_ms` 未配置时默认 30s;设为 `0` 完全关闭(无论 `lead_turn_gate` 为何值)。
- **in-flight 豁免不打断/不锁定**:预算超限时,若 in-flight 工具 ∈ {dispatch, management, wait-user},延时等待其结束——打断/锁定只针对执行类;执行类 in-flight 则让其跑完(硬阻断只挡「后续调用」)。
- **enforce 授权窗不叠加**:每次授权 = 重新武装一个**全新**窗口(`consumedMs=0`),授权从不叠加到已耗尽预算上;同一回合可多次「耗尽↔授权」,但每回合授权次数上限 `lead_turn_max_grants`(默认 5),超限后静默锁定到回合结束。
- **enforce 下 auto 权限模式不发问**:auto 模式没有用户审批回路,授权问句直接跳过,执行类调用直接 veto、锁定到回合结束。
- **锁定回合允许的出口**:dispatch / management / wait-user 工具在锁定期间始终放行;锁定回合以模型给出最终答复、派工完成、用户 ESC 或 `lead_turn_lock_cap_ms` 兜底取消收尾。
- **enforce 下不 inject**:执行负载由 veto 错误消息 + 授权问句承担,不再注入可被忽略的提醒(减少递归面)。

## 已知缺口

- **通知回合不武装**:subagent 回传结果等 `system_trigger` 回合无预算。武装它们会与 score_gate 验收流冲突(读交付输出/跑测试多发生在这些回合)且存在 inject 递归风险,故 enforce v1 维持不武装;若要覆盖,只允许以 warn 类或显著更长的预算武装。

## 迁移提示

- **默认 `enforce` 是行为变更**:现有装 `lead_turn_timeout_ms` 且未配 `lead_turn_gate` 的实例,升级后从「软提醒打断」切到「代码层硬封锁」。需要软提醒的安装显式设 `lead_turn_gate = "warn"` 即可恢复旧行为。

## 实现注意

分类观测的可行性(step 工具名识别、前台派工检测点)已由代码调查确认;阻断点选型为 toolExecutor 的 `onBeforeExecuteTool` veto 事件(异步、带 turnId、支持 `waitUntil(factory)` 承载用户授权),授权直调 `ISessionQuestionService`(AskUserQuestion 内核)。若实现中发现观测信号与本文档不符,以实际可观测信号为准,并回更本文件。
