# lead-turn-timeout(主管回合限时打断)设计

## 背景与目标

团队模式下,主管(主 agent)常陷在「执行类」工作里:自己读文件、改代码、跑命令、长生成——烧光上下文、卡住不派工,违背 doctrine「执行不是你的活」。本设计给主管的用户回合加一个 **工具级执行预算**(按 toolCallId 累计执行类工具耗时):预算烧光即打断并注入提醒,让主管回到管理/拆单/验收职责。

## 机制说明

- **用户回合武装**:仅在用户发起的回合(用户消息之后的主管回合)武装计时;其他 agent 轮(如 subagent 回传结果触发的回合)不武装。
- **工具级执行预算**:预算按**工具调用(toolCallId)**累计「执行类」耗时(工具名/参数在 `tool.call.started` 可得,耗时自打点),达到阈值(`[subagent] lead_turn_timeout_ms`)即触发打断;无工具调用的纯生成 step 按其 LLM 生成时长计入,有工具 step 不双计。
- **打断 + 注入顺序**:`cancel → turn.ended → inject`——先取消当前正在执行的 step,再结算该 turn 的结束,最后注入提醒文本;注入走 `system_trigger` 通道,注入本身**不再武装计时**(防递归),且**同一 turnId 只注入一次**。
- **配置键**:`[subagent] lead_turn_timeout_ms`,默认 30s,`0` = 关闭。
- **分类器排除等待**:等待不计用分类器排除而非暂停计时——`AskUserQuestion` 归 `wait-user` 类不计;审批在 `tool.call.started` 之前天然不计(无 interaction 内核暂停)。

## 行为分类表

| 行为类别 | 判定依据 | 是否计入预算 |
|---|---|---|
| 执行计入 | 工具调用(toolCallId)为执行类(文件读写/编辑/跑命令);所在 step 不再额外计生成(避免双计) | 计入 |
| 管理不计 | step 工具名为派工/管理类(Agent/AgentSwarm/TeamHire/TeamFire/TeamScore/TeamMessage/TeamConcurrency 等) | 不计 |
| 等待用户不计 | `AskUserQuestion` 归 `wait-user` 类不计;审批在 `tool.call.started` 之前天然不计 | 不计 |
| 前台派工阻塞暂停 | step 为前台派工(等待 subagent 结果,`run_in_background=false`)阻塞 | 暂停计时 |

## 边界清单

- **纯生成计入**:无工具调用的 step,其 LLM 生成时长(`turn.step.completed.llmStreamDurationMs`)计入预算——长生成计入;有工具调用的 step 不额外计生成(避免双计),只计执行类工具耗时。**TTFT(首 token 延迟,`firstTokenLatencyMs`)不计入预算**——只计自首 token 到流结束的生成时长;请求挂起无首 token 时累计为 0,不会误触发打断。
- **TaskOutput 查岗不计**:后台任务快照等「查岗类」调用不计入。
- **重试累计**:同一 step 的重试耗时累计计入,不因重试重置预算。
- **ESC 去重不注入**:用户 ESC 打断后,若同一 turnId 已注入过提醒,不再重复注入。
- **默认 30s 可配 0=关**:`lead_turn_timeout_ms` 未配置时默认 30s;设为 `0` 完全关闭。
- **in-flight 豁免不打断**:预算超限时,若 in-flight 工具 ∈ {dispatch, management, wait-user},延时等待其结束,不打断——打断只针对执行类。

## 实现注意

分类观测的可行性(step 工具名识别、前台派工检测点)已由代码调查确认;实现时按本文档落地。若实现中发现观测信号与本文档不符,以实际可观测信号为准,并回更本文件。
