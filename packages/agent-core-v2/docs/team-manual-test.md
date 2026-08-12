# kimiteam 面向用户的手工测试用例文档

## 0. 头部

### 0.1 裁剪声明(29119-3 Tailored Conformance)

本文件基于 **ISO/IEC/IEEE 29119-3** 测试文档标准,按团队规模做裁剪,将三份规范合一:

| 29119-3 规范 | 本文档对应 |
|---|---|
| Test Case Specification(用例规范) | 每一节「用例」的 步骤 / 预期结果 |
| Test Procedure Specification(过程规范) | 头部「约定块」+ 每节的 前置条件 / 模块 / 优先级 |
| Test Execution Log(执行日志) | 每一条的 实际结果 / 状态 / 证据 / 关联特性 |

裁剪范围:不单独维护 traceability matrix(以「关联特性」字段内联)、不强制独立环境隔离用例(团队功能在同一 `~/.kimi-code` 目录内自洽)、TUI 交互类用例标注「需人工」而不驱动交互终端。

### 0.2 适用范围

- 被测对象:kimiteam 命令行(Subagent 团队化构建)。
- 版本:**0.31.1**(已装 bundle `~/.kimi-code/lib/kimi/main-team.cjs`,sha256 前缀 `9137e53611e895a5c317`;`kimiteam --version` 输出 `0.31.1`)。
- 关联分支:`main`(仓库 `/Users/isletspace/Workspace/github.com/kimi-code`)。
- 测试基准:**以「本地已装 bundle」为准**,不以仓库源码为准;涉及安装/升级的用例以发布产物为观测对象。

### 0.3 测试环境(本次执行)

| 项 | 值 |
|---|---|
| 主机 | macOS(Apple Silicon);Node v24.17.0;pnpm 10.33.0 |
| 已装 | `~/.kimi-code/bin/kimiteam`(launcher)、`~/.kimi-code/lib/kimi/main-team.cjs`(bundle 0.31.1) |
| 运行开关 | launcher 固定导出 `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=1`、`KIMI_CODE_EXPERIMENTAL_FLAG=1` |
| 数据目录 | `~/.kimi-code/`(config.toml、agents/、logs/、cache/) |
| 现役团队 | `~/.kimi-code/agents/` 下有现役成员,**禁止删改**;hire/fire/score 等写路径用例标注「未实测(避免动现役团队)」 |

### 0.4 维护说明

- 特性变更时由**测试员**负责维护本文件:新增/删除用例、校准「预期结果」为真实行为、更新状态表与「批次 summary」。
- 「预期结果」一律以**已装 bundle 实测行为 + 代码事实**为准,不得照功能提案/任务描述猜写。
- 每轮回归新增一节 `## YYYY-MM-DD 批次`;批末写该批 summary(执行数 / 通过 / 失败 / 需人工 / 不符点)。
- 发现行为与文档不符时,如实记录「不符点清单」,并更新相应用例的预期结果或标注待修。

---

## 1. 约定块(文档头统一约定)

### 1.1 编号前缀

| 前缀 | 模块 |
|---|---|
| INSTALL- | 安装三通道(macOS bash / Windows PowerShell / WSL) |
| CONFIG- | `[subagent]` 配置键 schema 与默认值 |
| FILE- | 数据/状态文件效果(agents/*.md、performance.json、runtime-status.json、model-roster.md) |
| TEAM- | `/team` 开关与面板、onboarding、TeamHire/Fire/Score、绩效卡、派工、停靠/TTL/冷回退、计分提醒 |
| USAGE- | `/usage` 面板(按模型 / resume 恢复 / secondary 模型 id) |
| PIPELINE- | pipeline 两级注入(全局 + 项目) |
| SKILLS- | skills 白名单 |
| LEAD- | 主管限时打断(lead turn timeout) |
| WEB- | Web 端 `/web` 团队面板 |
| DOC- | 发布文档(README / Windows 安装说明)准确性 |

### 1.2 优先级

| 级别 | 语义 |
|---|---|
| P0 | 阻断级:核心路径失效即不可发布 |
| P1 | 高:主要特性,回归必查 |
| P2 | 中:次要交互 / 边界 |
| P3 | 低:文案 / 文档 / 已知待修项 |

### 1.3 三值状态(每批执行后填写)

| 状态 | 语义 |
|---|---|
| 通过 | 实测「实际结果」与「预期结果」一致,证据可复核 |
| 失败 | 实测与预期不一致,证据附原始输出/截图 |
| 需人工 | 依赖真实交互终端 / 外部网络 / 现役团队写操作,本次未自动执行;已给精确步骤 |

### 1.4 证据路径约定

- 已装 bundle: `~/.kimi-code/lib/kimi/main-team.cjs`
- launcher: `~/.kimi-code/bin/kimiteam`
- 配置: `~/.kimi-code/config.toml`
- 团队数据: `~/.kimi-code/agents/{name}.md`、`performance.json`、`runtime-status.json`、`model-roster.md`、`call-log.jsonl`、`call-record.csv`
- 全局 pipeline: `~/.kimi-code/pipeline.md`;项目 pipeline: `<projectRoot>/.kimi-code/pipeline.md`
- 源码事实(仅供校准): `packages/agent-core-v2/docs/config-manifest.toml`、`packages/agent-core-v2/src/session/subagent/configSection.ts`、`packages/agent-core-v2/src/agent/tools/team-score/teamScoreTool.ts` 等

---

## 2. 2025-08-04 批次

### 2.1 安装三通道

#### TC-INSTALL-001 — macOS/Linux bash 安装(macOS bash)
- **模块**:安装; **优先级**:P0
- **前置条件**:本机已装 Node.js ≥ 24、curl;`~/.kimi-code/bin/` 存在(或脚本自建)
- **步骤**:
  1. 执行 `curl -fsSL https://raw.githubusercontent.com/Liewzheng/kimi-code/feat/subagent-team/scripts/install-kimiteam.sh | bash`(或 `bash scripts/install-kimiteam.sh`)
  2. 观察输出:预检 node/curl → 备份旧 bundle(若存在)→ 下载 `main-team.cjs` + `main-team.cjs.sha256` → sha256 校验 → 写 launcher `~/.kimi-code/bin/kimiteam`
  3. 运行 `kimiteam --version`
- **预期结果**:输出 `0.31.1`;launcher 存在且可执行;官方 `~/.kimi-code/bin/kimi` 与 `~/.kimi-code/lib/kimi/main.cjs` 未被触碰(RED LINE);`main-team.cjs` sha256 与发布文件一致。
- **实际结果**:——
- **状态**:——
- **证据**:本次**未重新下载**(避免触碰已装 bundle);以「已装结构 + 脚本静态核」替代:
  - `bash -n scripts/install-kimiteam.sh` → `syntax OK`
  - 已装 `~/.kimi-code/bin/kimiteam`、`~/.kimi-code/lib/kimi/main-team.cjs`(0.31.1)存在
- **关联特性**:`.changeset/kimiteam-windows-installer.md`、`scripts/install-kimiteam.sh`

#### TC-INSTALL-002 — Windows PowerShell 短链 irm|iex
- **模块**:安装; **优先级**:P1
- **前置条件**:Windows PowerShell(5.1+),Node.js ≥ 24
- **步骤**:
  1. 执行 `irm https://liewzheng.github.io/kimi-code/install.ps1 | iex`
  2. 或下载后 `powershell -ExecutionPolicy Bypass -File scripts/install-kimiteam.ps1`
  3. 安装后运行 `& ~\.kimi-code\bin\kimiteam.ps1 --version`
- **预期结果**:安装 `~\.kimi-code\lib\kimi\main-team.cjs` + `bin\kimiteam.ps1`;sha256 校验通过;`--version` 输出 `0.31.1`;官方 `bin\kimi` / `lib\kimi\main.cjs` 未被触碰。
- **实际结果**:——
- **状态**:需人工(本机无 Windows / 无 pwsh,无法实跑)
- **证据**:`scripts/install-kimiteam.ps1` 静态审阅通过(纯 ASCII launcher、TLS 1.2 抬高、Get-FileHash 校验);README 短链 `liewzheng.github.io/kimi-code/install.ps1` 在仓库内不存在(外部发布物,需联网人工核)
- **关联特性**:`.changeset/kimiteam-windows-installer.md`、`README.md`「Windows 支持」

#### TC-INSTALL-003 — WSL 安装
- **模块**:安装; **优先级**:P2
- **前置条件**:WSL(或 Git Bash)终端,Node.js ≥ 24
- **步骤**:WSL 内执行与 Linux 相同的 `curl -fsSL .../install-kimiteam.sh | bash`;用 `kimiteam` 启动。
- **预期结果**:与 Linux 行为一致(README 明示原生 Windows TUI 交互未实测,推荐 WSL 走完整交互)。
- **实际结果**:——
- **状态**:需人工(无 WSL 环境)
- **证据**:`README.md` 第 65-71 行
- **关联特性**:`README.md`

### 2.2 配置键 schema 与默认值

#### TC-CONFIG-001 — `[subagent]` 键 schema 与默认值
- **模块**:配置; **优先级**:P1
- **前置条件**:无
- **步骤**:读取 `packages/agent-core-v2/docs/config-manifest.toml` 的 `[subagent]` 段,与源码 `configSection.ts` 核对。
- **预期结果**:键齐全:`timeout_ms`(默认 `7200000`)、`max_concurrency`(integer min 1,无注册默认)、`team_mode`(boolean,默认 off)、`idle_ttl_ms`(integer min 1,默认 `7200000`)、`lead_turn_timeout_ms`(integer min 0,默认 `30000`,`0`=关闭)、`model_overrides`(record<string,string>)。
- **实际结果**:通过。config-manifest 列出 `[subagent] timeout_ms = 7200000`,其余字段注释;源码常量 `DEFAULT_SUBAGENT_TIMEOUT_MS = 2*60*60*1000`、`DEFAULT_SUBAGENT_IDLE_TTL_MS = 2*60*60*1000`、`DEFAULT_LEAD_TURN_TIMEOUT_MS = 30_000`、`resolveTeamMode` 默认 `false`。
- **状态**:通过
- **证据**:`packages/agent-core-v2/docs/config-manifest.toml`(`[subagent]` 段);`packages/agent-core-v2/src/session/subagent/configSection.ts:106-112`
- **关联特性**:`.changeset/team-idle-ttl.md`、`.changeset/team-lead-doctrine-dispatch.md`

#### TC-CONFIG-002 — 未配置时默认值生效(当前安装)
- **模块**:配置; **优先级**:P1
- **前置条件**:当前用户 `~/.kimi-code/config.toml`
- **步骤**:读取 `~/.kimi-code/config.toml` 的 `[subagent]` 段。
- **预期结果**:该段为空(未显式配置)时,引擎按默认值运行:team_mode=off、idle_ttl_ms=7200000、lead_turn_timeout_ms=30000。
- **实际结果**:通过。`~/.kimi-code/config.toml` 的 `[subagent]` 段为空(无键)。
- **状态**:通过
- **证据**:`awk '/^\[subagent\]/,/^\[/' ~/.kimi-code/config.toml` 输出空段
- **关联特性**:同上

#### TC-CONFIG-003 — `lead_turn_timeout_ms = 0` 关闭打断
- **模块**:配置; **优先级**:P3
- **前置条件**:可安全修改 `~/.kimi-code/config.toml`(本机现役配置,需人工确认)
- **步骤**:在 `[subagent]` 加 `lead_turn_timeout_ms = 0`,重启 `kimiteam`,主管长时间执行类工作。
- **预期结果**:不再触发限时打断(源码 `resolveLeadTurnTimeoutMs` 语义:`0` 关闭)。
- **实际结果**:——
- **状态**:需人工(修改现役配置,本次不做)
- **证据**:`configSection.ts:163-168`
- **关联特性**:`docs/lead-turn-timeout.md`

### 2.3 数据 / 状态文件效果(可实跑)

#### TC-FILE-001 — agents 成员文件结构
- **模块**:文件效果; **优先级**:P1
- **前置条件**:`~/.kimi-code/agents/` 有现役成员
- **步骤**:读取任一 `agents/*.md`。
- **预期结果**:frontmatter 含 `name` / `description` / `role` / `whenToUse` / `tools` / `model_preference`(可选);正文为角色提示词。
- **实际结果**:通过。以 `yan-ge.md` 为例:frontmatter 六字段齐全,`model_preference: secondary`。
- **状态**:通过
- **证据**:`~/.kimi-code/agents/yan-ge.md`
- **关联特性**:`.changeset/agent-file-format-warning.md`(仅 Markdown 会被加载)

#### TC-FILE-002 — performance.json 结构
- **模块**:文件效果; **优先级**:P1
- **前置条件**:有历史计分
- **步骤**:读取 `~/.kimi-code/agents/performance.json`。
- **预期结果**:顶层为 per-profile 对象,每 profile 含 `entries`(含 `profileName`/`ts`/`score`/`note`/`model`/`agentId`)与 `shifts`(含 `startedAt`/`endedAt`/`durationMs`/`workSummary`)。
- **实际结果**:通过。顶层键如 `mu-chuan`/`lu-yao`/`yan-ge`/`agent`;`yan-ge.entries[0]` 含 score 90、note、model `deepseek/deepseek-v4-flash`、agentId;`shifts[0]` 含 workSummary 等。
- **状态**:通过
- **证据**:`~/.kimi-code/agents/performance.json`(只读,Python json 解析)
- **关联特性**:`.changeset/subagent-performance-card.md`

#### TC-FILE-003 — runtime-status.json 结构
- **模块**:文件效果; **优先级**:P1
- **前置条件**:团队曾派工/停靠
- **步骤**:读取 `~/.kimi-code/agents/runtime-status.json`。
- **预期结果**:per-profile 对象,字段 `state`(`working`/`resting`)/`agentId`/`updatedAt`/`restExpiresAt`(resting 时有)。
- **实际结果**:通过。现 5 条:4 条 `resting` 各带 `restExpiresAt`,1 条 `working`(wen-hui)无 `restExpiresAt`。
- **状态**:通过
- **证据**:`~/.kimi-code/agents/runtime-status.json`(只读)
- **关联特性**:`.changeset/team-idle-subagent-cleanup.md`、`.changeset/team-idle-ttl.md`

#### TC-FILE-004 — model-roster.md 性能档案
- **模块**:文件效果; **优先级**:P1
- **前置条件**:团队存在
- **步骤**:确认 `~/.kimi-code/agents/model-roster.md` 存在并含各模型能力档案。
- **预期结果**:文件存在(doctrine 引用其为派工候选模型能力来源)。
- **实际结果**:通过。`model-roster.md` 存在(9234 字节)。
- **状态**:通过
- **证据**:`ls -la ~/.kimi-code/agents/model-roster.md`
- **关联特性**:`src/agent/tools/agent/team-lead-doctrine.md`

#### TC-FILE-005 — 派工流水(call-log / call-record)
- **模块**:文件效果; **优先级**:P3
- **前置条件**:团队曾派工
- **步骤**:确认 `~/.kimi-code/agents/call-log.jsonl`、`call-record.csv` 存在。
- **预期结果**:两文件存在且持续追加。
- **实际结果**:通过。`call-log.jsonl`(1.4MB)、`call-record.csv`(21KB)。
- **状态**:通过
- **证据**:`ls -la ~/.kimi-code/agents/`
- **关联特性**:——

### 2.4 `/team` 开关与面板

#### TC-TEAM-001 — `/team on` 开启团队模式
- **模块**:团队; **优先级**:P0
- **前置条件**:`kimiteam` 会话内;`[subagent] team_mode` 默认 off
- **步骤**:输入 `/team on`,确认开关;随后让主 agent 尝试调用 5 个 Team* 工具。
- **预期结果**:team mode 开启后,`TeamHire`/`TeamFire`/`TeamScore`/`TeamMessage`/`TeamConcurrency` 从工具策略放行;关闭时隐藏(`configSection.ts` 工具门控)。
- **实际结果**:——
- **状态**:需人工(交互终端;避免动现役团队写路径)
- **证据**:`configSection.ts:170-177`(`TEAM_TOOL_NAMES`)
- **关联特性**:`.changeset/team-panel-command.md`、`.changeset/team-lead-doctrine.md`

#### TC-TEAM-002 — `/team` 面板(职位/模型/均分/四态)
- **模块**:团队; **优先级**:P0
- **前置条件**:团队非空
- **步骤**:输入 `/team`;核对每行:名称 / 职位与焦点两列 / 生效模型(真实 id,非 `__secondary__`)/ 平均分(1 位小数,无分显示「无」)/ 生命周期状态。
- **预期结果**:四态 `working`(工作中)/ `resting`(停靠)/ `on-duty`(上班)/ `off-duty`(下班,含被 fire 成员的灰化档案行);模型列显示真实 secondary 模型 id。
- **实际结果**:——
- **状态**:需人工
- **证据**:`apps/kimi-code/src/tui/commands/team.ts:96`(`MemberStatus = 'working'|'resting'|'on-duty'|'off-duty'`)、`:541-542`(上班/下班)、`:710`(off-duty 灰化)
- **关联特性**:`.changeset/team-panel-command.md`、`team-panel-role-columns.md`、`team-panel-member-status.md`、`team-secondary-model-id.md`

#### TC-TEAM-003 — `/team` 流式可用
- **模块**:团队; **优先级**:P2
- **前置条件**:agent 正在流式输出
- **步骤**:流式过程中输入 `/team`;观察面板自动刷新;在面板内按 Ctrl+C。
- **预期结果**:面板可在流式中打开并自动刷新;Crtl+C 取消当前正在进行的回合。
- **实际结果**:——
- **状态**:需人工
- **证据**:`.changeset/team-panel-live-streaming.md`
- **关联特性**:同上

### 2.5 Onboarding

#### TC-TEAM-004 — 冷启动 4 问 + 一轮追问
- **模块**:onboarding; **优先级**:P0
- **前置条件**:team mode 开、团队为空(需要临时环境,勿动现役)
- **步骤**:对 Kimi 说「组建我的团队」;依次回答 4 个问题(场景/任务类型/模型成本/规模);如需要再答一轮 1-2 个追问。
- **预期结果**:每问在 AskUserQuestion 4 选项硬上限内(超出进 Other);允许一轮 1-2 题追问;回答完才 hire。
- **实际结果**:——
- **状态**:需人工(需要空团队环境)
- **证据**:`.changeset/team-onboarding.md`、`team-onboarding-qna.md`
- **关联特性**:同上

#### TC-TEAM-005 — 人名命名(非岗位名)
- **模块**:onboarding; **优先级**:P2
- **前置条件**:同上
- **步骤**:观察 hire 出的成员 `name`。
- **预期结果**:成员名为 pinyin kebab 或英文人名(如 `yan-ge`),不是「测试工程师」「coder」等岗位名。
- **实际结果**:——
- **状态**:需人工
- **证据**:`.changeset/team-onboarding-qna.md`
- **关联特性**:同上

#### TC-TEAM-006 — 放弃回答即终止
- **模块**:onboarding; **优先级**:P1
- **前置条件**:同上
- **步骤**:回答问题前直接表示「不想回答/退出」。
- **预期结果**:不创建任何成员、不 fallback 到通用模板团队,onboarding 终止。
- **实际结果**:——
- **状态**:需人工
- **证据**:`.changeset/team-onboarding-interview-gate.md`
- **关联特性**:同上

### 2.6 团队管理工具

#### TC-TEAM-007 — TeamHire
- **模块**:团队工具; **优先级**:P0
- **前置条件**:team mode on;临时环境(勿动现役)
- **步骤**:让主 agent 对候选成员执行 TeamHire(name/role/description/whenToUse/model/tools/skills)。
- **预期结果**:生成 `agents/{name}.md`,面板出现该成员;name 为真实人名风格。
- **实际结果**:——
- **状态**:需人工(未实测:避免动现役团队)
- **证据**:`.changeset/team-panel-command.md`;`agentProfileCatalog.ts` profile schema
- **关联特性**:——

#### TC-TEAM-008 — TeamFire
- **模块**:团队工具; **优先级**:P0
- **前置条件**:team mode on;临时环境
- **步骤**:对某成员执行 TeamFire。
- **预期结果**:该成员退出现役,`/team` 面板转为灰化档案行,保留绩效历史(`performance.json` 不清空)。
- **实际结果**:——
- **状态**:需人工(未实测:避免动现役团队)
- **证据**:`.changeset/team-panel-member-status.md`
- **关联特性**:——

#### TC-TEAM-009 — TeamScore 0-100
- **模块**:团队工具; **优先级**:P0
- **前置条件**:team mode on;临时环境
- **步骤**:对成员提交 score(0-100 整数)+ note + model。
- **预期结果**:schema `z.number().int().min(0).max(100)`;`performance.json` 对应 profile 的 `entries` 新增一条;工具回显 `[TeamScore] Scored "X" — score/100`。
- **实际结果**:——
- **状态**:需人工(未实测:避免动现役团队)
- **证据**:`packages/agent-core-v2/src/agent/tools/team-score/team-score.ts:16`、`teamScoreTool.ts:113-116`
- **关联特性**:`.changeset/subagent-performance-card.md`

#### TC-TEAM-010 — 通胀警告(最近全 ≥90)
- **模块**:团队工具; **优先级**:P2
- **前置条件**:临时环境,构造某成员近 10 条内 ≥5 条高分
- **步骤**:连续给出高分(如 5 条以上 ≥90)后再次 TeamScore。
- **预期结果**:样本 ≥5 且窗口(最近 10 条)内「全部 ≥90」或「平均 ≥90」时,回显警告:`Score inflation detected: the last {n} scores for {profile} are all >= 90. Recalibrate against the rubric — 90s are passing grades, 95+ reserved for exceptional work.`(或平均口径文案);仅 1-2 条高分不算(ramp-up);警告只提醒不拒收。
- **实际结果**:——
- **状态**:需人工(未实测:避免动现役团队)
- **证据**:`teamScoreTool.ts:30-57`(`INFLATION_MIN_SAMPLE=5`、`INFLATION_HIGH_SCORE=90`、`INFLATION_WINDOW=10`)
- **关联特性**:`.changeset/subagent-performance-card.md`

#### TC-TEAM-011 — 绩效卡(派工时 subagent 见自己均分/排名)
- **模块**:绩效卡; **优先级**:P1
- **前置条件**:某成员已有计分
- **步骤**:派工该成员;观察其收到 prompt 中的绩效卡。
- **预期结果**:卡含「自己」的平均分(计分窗口内)+ 团队排名;排名需 ≥3 条才有;不出现其他成员分数。
- **实际结果**:——
- **状态**:需人工(派工写路径,避免动现役)
- **证据**:`.changeset/subagent-performance-card.md`、`subagent-card-member-info.md`(派工卡显示 role + 均分)
- **关联特性**:——

### 2.7 `/usage`

#### TC-USAGE-001 — 按模型分行 + 成员细分
- **模块**:usage; **优先级**:P1
- **前置条件**:有 subagent 用量
- **步骤**:输入 `/usage`;查看 subagent 部分。
- **预期结果**:subagent token 用量按模型分行,含 per-member 细分。
- **实际结果**:——
- **状态**:需人工
- **证据**:`.changeset/usage-subagent-by-model.md`
- **关联特性**:——

#### TC-USAGE-002 — resume 后用量不归零
- **模块**:usage; **优先级**:P1
- **前置条件**:会话有 subagent 用量
- **步骤**:记录当前 subagent 累计用量;`resume` 恢复会话;再次查看 `/usage`。
- **预期结果**:恢复的会话累计用量保留(不重置为 0)。
- **实际结果**:——
- **状态**:需人工
- **证据**:`.changeset/usage-subagent-resume-restore.md`
- **关联特性**:——

#### TC-USAGE-003 — 真实 secondary 模型 id
- **模块**:usage; **优先级**:P1
- **前置条件**:secondary model 已配置并派工
- **步骤**:查看 `/usage` 的 subagent 行。
- **预期结果**:显示真实 secondary 模型 id,而非内部 `__secondary__` 占位符。
- **实际结果**:——
- **状态**:需人工
- **证据**:`.changeset/usage-subagent-secondary-model-id.md`
- **关联特性**:`.changeset/team-secondary-model-id.md`

### 2.8 派工

#### TC-TEAM-012 — 派工后台默认
- **模块**:派工; **优先级**:P1
- **前置条件**:team mode on
- **步骤**:主 agent 派工(不显式指定前台/后台)。
- **预期结果**:team mode 下 `run_in_background` 默认 `true`(源码:`args.run_in_background ?? (resolveTeamMode(config) && canRunInBackground())`)。
- **实际结果**:——
- **状态**:需人工
- **证据**:`packages/agent-core-v2/src/agent/tools/agent/agentTool.ts:181`
- **关联特性**:`.changeset/team-lead-doctrine-dispatch.md`

#### TC-TEAM-013 — TeamMessage 递话 / interrupt
- **模块**:派工; **优先级**:P1
- **前置条件**:有 working/resting 成员
- **步骤**:对成员执行 TeamMessage(message,可选 interrupt)。
- **预期结果**:消息递到成员;interrupt=true 时打断其当前回合;interrupt=false 静默递话。
- **实际结果**:——
- **状态**:需人工
- **证据**:工具名在 `TEAM_TOOL_NAMES`;web 面板 message 带 interrupt 开关
- **关联特性**:——

#### TC-TEAM-014 — TaskStop
- **模块**:派工; **优先级**:P1
- **前置条件**:有后台任务
- **步骤**:对某后台任务执行 TaskStop。
- **预期结果**:任务被停止,不再占用并发槽。
- **实际结果**:——
- **状态**:需人工
- **证据**:`agentTool.ts:10`(TaskList/TaskOutput/TaskStop)
- **关联特性**:——

### 2.9 停靠复用 / TTL / 冷回退

#### TC-TEAM-015 — 停靠复用(同 profile)
- **模块**:停靠; **优先级**:P1
- **前置条件**:某成员 resting
- **步骤**:再次派工同 profile 成员。
- **预期结果**:复用该 resting 实例(保留上下文),而非新建。
- **实际结果**:——
- **状态**:需人工
- **证据**:`.changeset/team-idle-subagent-reuse.md`
- **关联特性**:——

#### TC-TEAM-016 — TTL 2h
- **模块**:停靠; **优先级**:P1
- **前置条件**:resting 成员存在
- **步骤**:观察 `runtime-status.json` 的 `restExpiresAt`;等待 2h(或改 `idle_ttl_ms` 缩短)。
- **预期结果**:默认 `idle_ttl_ms=7200000`(2h);`restExpiresAt = 停靠时刻 + TTL`;到期后成员转 off-duty 被 reap;新 run 重置计时。
- **实际结果**:——
- **状态**:需人工(需等待/改配置;runtime-status 现状为 resting 且 restExpiresAt≈+2h,证据见 TC-FILE-003)
- **证据**:`.changeset/team-idle-ttl.md`、`team-idle-subagent-cleanup.md`;`runtime-status.json` 现条目 restExpiresAt 距 updatedAt 约 2h
- **关联特性**:——

#### TC-TEAM-017 — 冷回退(重启后找回)
- **模块**:停靠; **优先级**:P1
- **前置条件**:某成员以 resting 状态被保存;进程将重启
- **步骤**:重启 `kimiteam`,再次派工该 profile。
- **预期结果**:重启后按 profile 找回 resting 实例并复用(保留上下文);旧 session(无 profile label)降级为 fresh spawn 而非报错。
- **实际结果**:——
- **状态**:需人工
- **证据**:`.changeset/subagent-cold-fallback.md`
- **关联特性**:——

### 2.10 计分强制提醒

#### TC-TEAM-018 — 未计分交付触发引擎提醒
- **模块**:计分; **优先级**:P1
- **前置条件**:受管派工(supervised dispatch)结算
- **步骤**:派工某成员,交付完成但主 agent 未立即 TeamScore。
- **预期结果**:引擎注入 `system_trigger`(name=`team_score_reminder`),文案:`Member {profileName} finished a dispatch but no TeamScore was recorded for it — review the delivery and score it with TeamScore (0-100, note, truthful model).`;若已计分则不提醒。
- **实际结果**:——
- **状态**:需人工
- **证据**:`packages/agent-core-v2/src/session/subagent/subagentService.ts:267-294`
- **关联特性**:`team-lead-doctrine.md`(第 49 行「engine reminds you when a score is missing」)

### 2.11 pipeline 两级注入

#### TC-PIPELINE-001 — 全局 + 项目 pipeline 注入
- **模块**:pipeline; **优先级**:P1
- **前置条件**:`~/.kimi-code/pipeline.md` 存在(已装环境:存在,3143 字节);项目级 `.kimi-code/pipeline.md` 可选
- **步骤**:启动会话;让 agent 描述其 system prompt 中的 pipeline 内容;或对项目新建 `.kimi-code/pipeline.md` 后重启。
- **预期结果**:全局 `~/.kimi-code/pipeline.md` 与项目 `<root>/.kimi-code/pipeline.md` 均注入 system prompt(标 `Global` / `Project`);文件缺失时静默跳过。
- **实际结果**:——
- **状态**:需人工(验证 system prompt 需交互)
- **证据**:`packages/agent-core-v2/src/agent/profile/context.ts:177-214`;已装全局 `~/.kimi-code/pipeline.md` 存在(本次实跑核)
- **关联特性**:`.changeset/pipeline-instructions.md`

### 2.12 skills 白名单

#### TC-SKILLS-001 — 白名单越权被拦
- **模块**:skills; **优先级**:P1
- **前置条件**:某成员 profile 声明 `skills` 白名单(如 `["skill-a"]`);主 agent 尝试让其调用白名单外 skill
- **步骤**:派工并让该成员调用白名单外 skill。
- **预期结果**:调用被拦,报错 `Skill "{skill}" is not in this profile's skills allowlist.`;未声明(`undefined`)或 `*` 时不拦。
- **实际结果**:——
- **状态**:需人工
- **证据**:`packages/agent-core-v2/src/agent/tools/skill/skillTool.ts:110-123`;`agentProfileCatalog.ts:69/86`
- **关联特性**:`.changeset/agent-skills-allowlist.md`

### 2.13 主管限时打断

#### TC-LEAD-001 — 执行类超时打断
- **模块**:主管限时; **优先级**:P1
- **前置条件**:team mode on;`lead_turn_timeout_ms` 默认 30000(未显式关闭)
- **步骤**:主管自己连续做执行类工作(读文件/改码/跑命令)超过预算。
- **预期结果**:按 toolCallId 累计执行类工具耗时,超预算触发 `cancel → turn.ended → inject`;注入 `system_trigger` 提醒;同一 turnId 只注入一次。
- **实际结果**:——
- **状态**:需人工
- **证据**:`docs/lead-turn-timeout.md`、`src/agent/leadTurnTimeout/leadTurnTimeoutService.ts`
- **关联特性**:——

#### TC-LEAD-002 — 派工/管理不打断
- **模块**:主管限时; **优先级**:P1
- **前置条件**:同上
- **步骤**:主管执行派工(Agent/AgentSwarm)或管理类(Team*)工具。
- **预期结果**:派工/管理类工具不计入预算;前台派工阻塞期暂停计时。
- **实际结果**:——
- **状态**:需人工
- **证据**:`docs/lead-turn-timeout.md` 行为分类表
- **关联特性**:——

#### TC-LEAD-003 — AskUserQuestion 不计
- **模块**:主管限时; **优先级**:P2
- **前置条件**:同上
- **步骤**:主管调用 AskUserQuestion 等待用户。
- **预期结果**:`wait-user` 类不计入预算;审批在 `tool.call.started` 之前天然不计。
- **实际结果**:——
- **状态**:需人工
- **证据**:`docs/lead-turn-timeout.md`
- **关联特性**:——

#### TC-LEAD-004 — in-flight 豁免
- **模块**:主管限时; **优先级**:P3
- **前置条件**:同上
- **步骤**:预算超限瞬间,若 in-flight 工具为 dispatch/management/wait-user。
- **预期结果**:延时等待其结束,不打断(只打断执行类)。
- **实际结果**:——
- **状态**:需人工
- **证据**:`docs/lead-turn-timeout.md` 边界清单
- **关联特性**:——

### 2.14 Web 端 `/web` 团队面板

#### TC-WEB-001 — 只读 roster(名/角色/状态/模型/均分)
- **模块**:web; **优先级**:P1
- **前置条件**:web 会话(会话 id);后端已启用 team 路由
- **步骤**:打开 `/web` 团队面板;观察列表。
- **预期结果**:只读 roster 含名称/角色/状态徽标/模型/平均分;每 2.5s 轮询 `GET /teams/{session_id}/members`。
- **实际结果**:——
- **状态**:需人工(需真实 web 会话)
- **证据**:`apps/kimi-web/src/components/team/TeamPanel.vue`(POLL_MS=2500、getTeamMembers)
- **关联特性**:——

#### TC-WEB-002 — hire / fire / 评分 / 递话
- **模块**:web; **优先级**:P1
- **前置条件**:web 会话
- **步骤**:在面板内执行 hire(表单)、fire(两步确认)、score、message(带 interrupt 开关)、model 修改。
- **预期结果**:各操作成功并经 2.5s 轮询反映;fire 为两步确认;message 可带 interrupt。
- **实际结果**:——
- **状态**:需人工(写路径;避免动现役团队)
- **证据**:`TeamPanel.vue` submitHire / doFire / submitScore / submitMessage / submitModel
- **关联特性**:——

#### TC-WEB-003 — 并发(TeamConcurrency)
- **模块**:web; **优先级**:P2
- **前置条件**:web 会话
- **步骤**:设置并发上限(正整数);再重置。
- **预期结果**:设置/重置经 `setTeamConcurrency` 生效;非法输入(非整数/<1)被面板拦截。
- **实际结果**:——
- **状态**:需人工
- **证据**:`TeamPanel.vue` applyConcurrency / resetConcurrency
- **关联特性**:——

#### TC-WEB-004 — teamMode 开关
- **模块**:web; **优先级**:P2
- **前置条件**:web 会话
- **步骤**:面板内切换 teamMode。
- **预期结果**:乐观更新 + 2.5s 轮询自纠;失败回滚并显示错误。
- **实际结果**:——
- **状态**:需人工
- **证据**:`TeamPanel.vue` toggleTeamMode
- **关联特性**:——

#### TC-WEB-005 — web 评分刻度与 0-100 契约一致性
- **模块**:web; **优先级**:P3
- **前置条件**:web 会话
- **步骤**:在 web 评分表单输入 1-5 并提交,对照服务端记录。
- **预期结果**:**已知不符点**——web 表单 `min=1 max=5`,服务端 schema `score: z.number().int().min(0).max(100)`(0-100),web 客户端直发不换算;输入 5 将记为 5/100。需产品裁决统一刻度。
- **实际结果**:——
- **状态**:需人工(记录为待修)
- **证据**:`TeamPanel.vue:308`(1-5)、`packages/kap-server/src/routes/teams.ts:85-87`(0-100)、`apps/kimi-web/src/api/daemon/client.ts:1381-1389`(直发)
- **关联特性**:——

### 2.15 发布文档准确性

#### TC-DOC-001 — README 安装命令与脚本一致
- **模块**:文档; **优先级**:P2
- **前置条件**:仓库 README.md
- **步骤**:对照 README「快速安装 / Windows 支持」与 `scripts/install-kimiteam.sh`、`scripts/install-kimiteam.ps1`。
- **预期结果**:bash 安装命令指向 `scripts/install-kimiteam.sh`,仓库内脚本存在;Windows 两条路径(`-File scripts/install-kimiteam.ps1` 与 irm|iex 短链)与安装物一致。
- **实际结果**:通过(部分)。bash 路径与脚本一致;Windows 短链 `https://liewzheng.github.io/kimi-code/install.ps1` 在仓库内**不存在**(外部发布物,需联网人工核内容)。
- **状态**:需人工(短链部分)
- **证据**:`README.md:10/48/54/57`;`ls scripts/install-kimiteam.{sh,ps1}`
- **关联特性**:`.changeset/kimiteam-windows-installer.md`

#### TC-DOC-002 — lib package.json 版本号一致性
- **模块**:文档; **优先级**:P3
- **前置条件**:已装 `~/.kimi-code/lib/kimi/package.json`
- **步骤**:对比 `lib/kimi/package.json` 版本与 `kimiteam --version`。
- **预期结果**:**已知不符点**——`lib/kimi/package.json` 版本为 `0.30.0`,而运行 `kimiteam --version` 为 `0.31.1`;该 package.json 为遗留物,建议随发布更新或移除。
- **实际结果**:通过(不符点已记录)
- **状态**:需人工(决定是否修复)
- **证据**:`cat ~/.kimi-code/lib/kimi/package.json`;`kimiteam --version`
- **关联特性**:——

---

## 3. 批次 summary(2025-08-04)

| 维度 | 值 |
|---|---|
| 用例总数 | 45(INSTALL 3 / CONFIG 3 / FILE 5 / TEAM 18 / USAGE 3 / PIPELINE 1 / SKILLS 1 / LEAD 4 / WEB 5 / DOC 2) |
| 本次可实跑并通过 | CONFIG-001/002、FILE-001/002/003/004/005、INSTALL-001(静态核)、DOC-001(部分)、DOC-002(记录) |
| 需人工 | INSTALL-002/003、CONFIG-003、TEAM-001…018、USAGE-001…003、PIPELINE-001、SKILLS-001、LEAD-001…004、WEB-001…005 |
| 记录的不符点 | WEB-005(web 1-5 vs 服务端 0-100)、DOC-002(lib package.json 0.30.0 vs bundle 0.31.1)、INSTALL-002/短链(仓库内无 install.ps1) |
| 未实测原因 | 全部 Team*/usage/派工写路径均「未实测(避免动现役团队)」;TUI/Web 交互类不驱动交互终端 |
