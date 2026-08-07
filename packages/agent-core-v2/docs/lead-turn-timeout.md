# lead-turn-timeout(主管回合限时打断)设计

## 背景与目标

团队模式下,主管(主 agent)常陷在「执行类」工作里:自己读文件、改代码、跑命令、长生成——烧光上下文、卡住不派工,违背 doctrine「执行不是你的活」。本设计给主管的用户回合加一个 **回合预算**(执行类工具耗时 + 全部 step 的 LLM 生成时长):预算烧光即打断并注入提醒,让主管回到管理/拆单/验收职责。

## 机制说明

- **用户回合武装**:仅在用户发起的回合(用户消息之后的主管回合)武装计时;其他 agent 轮(如 subagent 回传结果触发的回合)不武装。
- **回合预算**:预算 = 执行类工具耗时(按 toolCallId 自打点累计 `tool.call.started` → `tool.result`)+ **全部已完成 step 的 LLM 生成时长**(`turn.step.completed.llmStreamDurationMs`,无论该 step 是否调用工具)。LLM 流式段只覆盖生成区间,工具执行发生在 step 之间,两者墙钟区间不重叠——同时计入**不是重复计费**;达到阈值(`[subagent] lead_turn_timeout_ms`)即触发打断。
- **打断 + 注入顺序**:`cancel → turn.ended → inject`——先取消当前正在执行的 step,再结算该 turn 的结束,最后注入提醒文本;注入走 `system_trigger` 通道,注入本身**不再武装计时**(防递归),且**同一 turnId 只注入一次**。
- **配置键**:`[subagent] lead_turn_timeout_ms`,默认 30s,`0` = 关闭。
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
- **默认 30s 可配 0=关**:`lead_turn_timeout_ms` 未配置时默认 30s;设为 `0` 完全关闭。
- **in-flight 豁免不打断**:预算超限时,若 in-flight 工具 ∈ {dispatch, management, wait-user},延时等待其结束,不打断——打断只针对执行类。

## 实现注意

分类观测的可行性(step 工具名识别、前台派工检测点)已由代码调查确认;实现时按本文档落地。若实现中发现观测信号与本文档不符,以实际可观测信号为准,并回更本文件。
