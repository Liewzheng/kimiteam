# kimiteam

在官方 [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) 基础上增加了 Subagent 团队化能力。每个 Subagent 有独立角色/模型/上下文，主模型派工默认后台并行，你可以通过 `/team` 面板管理团队。

## 快速安装

前提：**Node.js >= 24**（安装脚本会检查，不满足则退出）。

```sh
curl -fsSL https://raw.githubusercontent.com/Liewzheng/kimi-code/feat/subagent-team/scripts/install-kimiteam.sh | bash
```

脚本从 GitHub Release `kimiteam-dev` 下载分发文件到 `~/.kimi-code/lib/kimi/`，写 `~/.kimi-code/bin/kimiteam` 启动器。幂等可重复跑，自动备份旧版即升级。

## 基本用法

```sh
kimiteam                    # 启动交互式会话（与官方 kimi 参数兼容，如 -y）
```

在会话中：

| 命令 | 作用 |
|------|------|
| `/team on` | 开启团队模式 |
| `/team` | 打开团队面板（成员职位 / 生效模型 / 平均分 / 工时） |
| `/usage` | 查看主模型 + Subagent 用量统计（按模型分行、成员细分） |

**冷启动**：团队为空时，对 Kimi 说「组建我的团队」，依次回答 4 个问题（场景 / 任务类型 / 模型成本 / 规模），自动执行 TeamHire 生成初始团队。

**团队管理工具**（在会话中对 Kimi 描述需求即可调用）：

- TeamHire — 招聘新成员
- TeamFire — 解聘成员
- TeamScore — 评分回溯
- TeamMessage — 向成员留言
- TeamConcurrency — 调整并行度

## 升级

重复运行安装命令即可。脚本会备份旧版并覆盖 `~/.kimi-code/lib/kimi/` 和 `~/.kimi-code/bin/kimiteam`。

## 与官方 kimi 的关系

- **`kimi`** — 官方 CLI，保持不变
- **`kimiteam`** — 本分支产物，两套命令共存于同一系统
- 共享 `~/.kimi-code` 下的配置、会话和 agents 数据目录

## 上游

完整文档、Issue 追踪和官方特性请见：

[https://github.com/MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)
