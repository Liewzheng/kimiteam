# 组建你的团队

一个人写代码是单打独斗。有了 AI 团队，你可以像搭班子一样——给每个成员挂上职位、配好提示词、挑趁手的模型，然后随时指挥。

## 雇佣：一句话就能招人

对主 Agent 说"我需要一个邮件收发的文员"，它会根据你的需求自动决定名字、职位（`role`）、系统提示词和模型，直接写入 `~/.kimi-code/agents/<name>.md`——整个过程不需要你手写任何 agent 文件。同名已存在会报错，不会静默覆盖。

> **自主组队纪律**：当任务需要的能力没有现成成员时，主 Agent 应自主决定新成员的 name / role / description / prompt / model，并直接执行雇佣，无需逐项请示用户。

写完即生效。目录 watcher 自动 reload 后，新成员立即可被派遣——不需要重启 CLI。

让某个子 Agent 一直在后台待命，不给你的前台对话添堵？给这个成员的 agent 文件加上 `duty: true`，它就会免超时运行（一直轮询邮件、监控仓库都可以）。你需要它下班时，主 Agent 用 `TaskStop` 停止即可——它们不会因为超时被自动中断。

## 排兵布阵：按模型分工

你的 `[models]`（`config.toml` 中定义的模型列表）就是整个团队的可用"人力池"。不同任务可以交给不同的模型来执行：

```toml
[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
max_context_size = 262144

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144
```

换将只需一句话："coder 用 kimi2.5 太差，换成 kimi-for-coding。"主 Agent 会通过 `[subagent.model_overrides]` 更新配置——这个覆盖**优先级高于 profile 的 `model_preference`，但低于工具调用时显式传入的具体值**。如果你想让某个成员永远绑定一个型号，在 agent 文件的 `model_preference` 字段填上对应 id 即可。

| 层级 | 谁决定 | 范围 |
| --- | --- | --- |
| 工具参数 | Agent 每次派发时指定 | 单次调用 |
| `[subagent.model_overrides]` | 主 Agent 在对话中通过 `TeamHire`/聊天指令更新 | 永久生效，覆盖 profile 默认 |
| frontmatter `model_preference` | 写进 agent 文件本人 | 永久生效 |

## 在岗管理：随时递话、随时打断

派出去之后你怎么管？

- **看进度**：用已有 `/tasks`（即 `TaskList`）和 `TaskOutput`，查后台任务的输出与状态。
- **递话指正**：发现跑偏了？主 Agent 可以用 `TeamMessage` 直接给运行中的子 Agent 递话——默认软提醒插入当前轮次，设 `interrupt: true` 则先取消再注入新指令（效果等同你在终端连按两次 ESC）。
- **下班**：用 `TaskStop` 停止运行中实例。`duty: true` 的成员需要主 Agent 主动派 `TaskStop` 才能停——它们自己不会超时自动中断。

## 绩效：完工评分

任务完成了？主 Agent 会用当前平均分 + 所用模型提醒你打分。你也可以随时用 `TeamScore` 手动评分（0-100 加评语）。

每条评分记录归因到当时所用的模型 id，持久化在 `$KIMI_CODE_HOME/agents/performance.json`——按 profile 名分组、每条包含时间戳、分数、备注和运行模型。当某个成员在当前模型下持续低分时，说明这个"成员 × 模型"搭配不合适，主 Agent 应通过 `[subagent.model_overrides]` 自动换模型或建议你从 `[models]` 列表中换一个试试。

## /team：一目了然

在终端输入 `/team`，打开团队总览面板——全员职位、生效模型、平均分和评分次数一览无余。每个子 Agent 的调用卡片也会显示"名字 · 职位 · 模型 · 上次评分"。

## 接下来

- [Agent 字段参考](../customization/agents.md) — Frontmatter 字段的完整说明
- [配置文件 — `model_overrides`](../configuration/config-files.md#子代理) — `[subagent.model_overrides]` 配置详情
