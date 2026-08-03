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

## Windows 支持

- **原生 PowerShell 一键安装(首选)**:免下载,短链脚本为 ASCII-only,安全经 `irm|iex` 管道执行:

  ```powershell
  irm https://liewzheng.github.io/kimi-code/install.ps1 | iex
  ```

  若公司/系统限制 `irm|iex`,可下载脚本后用 `-File` 方式执行(仓库内中文版):

  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts/install-kimiteam.ps1
  ```

  (原始 raw 长链备选:`irm https://raw.githubusercontent.com/Liewzheng/kimi-code/feat/subagent-team/scripts/install-kimiteam.ps1 | iex`。)`-ExecutionPolicy Bypass` 只对本条命令生效,无需改动系统策略。安装后启动器位于 `~\.kimi-code\bin\kimiteam.ps1`,在 PowerShell 中运行:

  ```powershell
  & ~\.kimi-code\bin\kimiteam.ps1
  ```

  (把 `~\.kimi-code\bin` 加入 PATH 后可直接运行 `kimiteam`。)

- **WSL(完整交互推荐)**:原生 Windows 的 TUI 交互(流式刷新、Ctrl+C 中断等)尚未实测;若在意完整交互体验或遇到交互异常,建议优先使用 WSL(或 Git Bash)。安装 WSL 后,在 WSL 终端里执行与 Linux 相同的安装命令:

  ```sh
  curl -fsSL https://raw.githubusercontent.com/Liewzheng/kimi-code/feat/subagent-team/scripts/install-kimiteam.sh | bash
  ```

  之后用 `kimiteam` 启动,行为与 Linux 一致。

## 与官方 kimi 的关系

- **`kimi`** — 官方 CLI，保持不变
- **`kimiteam`** — 本分支产物，两套命令共存于同一系统
- 共享 `~/.kimi-code` 下的配置、会话和 agents 数据目录

## 上游

完整文档、Issue 追踪和官方特性请见：

[https://github.com/MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)
