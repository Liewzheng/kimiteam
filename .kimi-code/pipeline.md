# kimiteam 项目 Pipeline(项目级流程与方向)

> 本文件随 repo 分发、可 git-commit,与会话创建时的全局 `~/.kimi-code/pipeline.md` 一起常驻注入系统提示词,缺失静默省略,超 32KB 告警。维护规则置顶,制度随文件分发。

## 维护规则(固定置顶)

- **先 Read 再 Edit**:修改前先读全文,用 Edit 增量修改,禁止整文件 overwrite——多会话并发会互相覆盖。
- **只沉淀可复用流程与方向**:参数化、可复用的流程与用户已拍板的方向才写;一次性杂事不记。
- **每条三要素**:流程写成「触发 → 动作 → 验收」;方向条目写明「背景 → 决策 → 待确认」,注明记录日期。
- **决策当天落盘**:用户拍板的方向/决策/偏好当天写入本文件或 team-lead-doctrine,不等用户提醒(见下节)。

## 决策记录约定(主管文书职责,2026-08-07)

- 触发:用户明确拍板方向/决策/偏好(架构升级、开源、语义、权限、配置、平台等)→ 动作:当天持久化到本 pipeline(项目方向)或 team-lead-doctrine(管理职责),注明日期;未拍板项标「待确认」,不当作既定事实 → 验收:后续任意会话可查到该决策、日期与待确认项。
- 触发:方向级变更(基线升级、开源、破坏性改动)→ 动作:先向用户确认再执行与记录 → 验收:用户同意后才落笔/动 git。
- 触发:需求有歧义/存在多方案且用户未表态 → 动作:先用 AskUserQuestion 一次性列出候选方案(标注推荐项)让用户选,不自行猜测动工 → 验收:动工前意图已收敛、无未确认的分歧(2026-08-12 评审落地,治本「方案未定就动手、被拒后返工」)。

## 升级基线方向(2026-08-07 拍板)

1. 触发:对 kimiteam 产品做架构升级 → 动作:放弃旧 V1 web 架构,全面升级到官方 0.33 基线,团队特性(Clerical / TeamStatus / TodoList / TeamMessage / 配置化等)随基线迁移、不丢 → 验收:基线与官方 0.33 对齐且团队特性可用。
2. 触发:官方 web 侧闭源(待确认)→ 动作:自建开源 bundle `open-kimiteam`(Apache 2.0,README 对比官方闭源差异),发布到 github.com/Liewzheng → 验收:开源 bundle 可独立构建发布,README 含对比表。
3. **仓库维护模式(2026-08-12 用户拍板,2026-08-12 再确认)**:以后**只维护 kimiteam 仓库**(`Liewzheng/kimiteam` main + 开发分支)——**已放弃维护 kimi-code 仓库**(含官方 `MoonshotAI/kimi-code` 与 fork `Liewzheng/kimi-code`):官方仅为上游只读参考(官方更新按需评估吸收:读 CHANGELOG → 判断价值/冲突 → 需要则对照代码吸收),`Liewzheng/kimi-code` 冻结为历史/迁移源(kimiteam-dev Release 停更,新安装/CI/发布全部指向 `Liewzheng/kimiteam`)。背景:kimiteam 是做给自己用的,官方可能更新有用内容。待确认:官方 0.34.0+ 的哪些更新值得吸收(见 T28 卷启评估报告)。

## 团队状态语义(2026-08-07 拍板)

- 触发:实现/调整团队状态 → 动作:去掉「上班」态,三态=工作/休息/下班;休息=值守常驻(工作后直接进休息,保留会话)→ 验收:状态枚举、休息保留会话行为与上述一致。
- **状态称呼与语义(2026-08-07 再拍板,替代上条「值守」方案)**:不用「值守」词;三态称呼=工作/休息/下班。语义:**休息**=工作过且上下文未清除(热实例保留,可继续工作对话);**下班**=从未工作过(on-duty) 或 休息达到一定时间自动下班(TTL 到期,上下文清除) → 验收:web/TUI 均三态,未工作过的成员显示「下班」而非「休息」,休息态保留上下文可继续。
- **状态按 session 隔离(2026-08-07 拍板)**:团队面板的成员状态(工作/休息/下班)必须**按 session 隔离**——每个 session 只显示「当前 session 激活的成员状态」,不共享全局状态(runtime-status 现为全局共享,所有 session 派工写同一文件;需加 session 维度:存储结构/写入方 subagentService 带 session 标识/读取方 teams.ts 按 session 过滤/T10 写序修复适配) → 验收:两 session 同时打开团队面板,各看到自己激活的成员状态,互不串扰。
- **配色(2026-08-07 再拍板,替换蓝绿调方案)**:卡片底色纯灰度三档——工作 `rgb(230,230,230)` / 休息 `rgb(240,240,240)` / 下班 `rgb(250,250,250)`;「上班」在用户语境即「工作」态 → 验收:三态卡片底色与上述灰度一致。

## 团队显示与权限(2026-08-07 拍板)

- 触发:涉及团队显示/权限 → 动作:中文名走 `display_name` 字段;TodoList 仅主管可用;TeamMessage 渲染 Markdown → 验收:display_name 生效、TodoList 权限受控、TeamMessage Markdown 渲染。

## 配置化(2026-08-07 拍板)

- 触发:实现配置入口 → 动作:web 的 providers/model 设置页替代手写 config.toml(小白友好);隐藏开关进 web 高级设置 → 验收:设置页可完成 providers/model 配置,隐藏开关在高级设置。

## Windows 支持(2026-08-07 拍板)

- 触发:提供 Windows 安装/卸载 → 动作:提供 `uninstall-kimiteam.ps1`,安装/卸载/验证齐全;官方 kimi 基线 0.33 → 验收:Windows 上可安装/卸载/验证,基线版本 0.33。

## 验收卡控:引擎级硬门禁(2026-08-07 用户拍板)

- **背景**:主管「读 diff/重跑测试后再计分」此前是 doctrine 软约束——引擎无法证明主管真的验收,TeamScore 不验收也能调成功;放水无追溯。用户现场询问卡控现状后拍板做引擎级硬门禁(主管曾建议 TeamScore 加必填验收字段的软方案,用户选择硬门禁)。
- **决策**:TeamScore `record` 动作在执行前校验**验收证据**——主 agent 自该成员交付完成后,须有可检测的验收动作(读交付产出/读 diff/重跑测试),无证据则拒绝计分并提示缺什么;`penalty` 动作豁免(针对已验收交付的追加扣分);配置 `[subagent] score_gate = "off" | "warn" | "enforce"`,默认 `enforce`,off 为逃生门。
- **待确认**:① 证据分类的检测规则(命令正则)上线后按误伤情况校准;② 与 worktree 双闸门(A.4 主管验收 + A.5 严戈合并验证)的职责边界——硬门禁管计分,合并门禁管主树。

## 主管响应时限(2026-08-07 用户拍板)

- **决策**:主管必须在 **30s 内响应人类的任何输入**;执行类工作预计超时时,先 **ask permission 向用户说明需要续多久**,获准后再继续(等待用户的时间按既有分类不计入预算)。用户发起回合由 `lead_turn_timeout_ms`(默认 30s)引擎武装计时,主管自身纪律:能派工不执行、回合保持精简。
- **量化纪律(2026-08-12 评审落地)**:回合内预估 >5 次工具调用或需读写 >3 个文件前,先 ask permission 说明预计耗时与必要性,或把读取/编辑拆派给 lu-yao/对应工程师;已连续 3 次工具调用时自检一次预算。能派工不执行是硬纪律,不靠临场感觉。
- **代码层限制(2026-08-07 用户再拍板)**:30s 响应不停留在提示词纪律,要做成**引擎级硬限制**——预算耗尽不止注入提醒,要在代码层阻断主管继续执行类工作,续时须经用户许可(交互通道授权 N 时长后重新武装)。设计+实现已立项。
- **实现状态(2026-08-12 查实)**:`LeadTurnTimeoutService` 已完整实现(agent-core-v2,enforce 默认:预算耗尽 lock→toolExecutor veto 执行类工具→AskUserQuestion 授权续时→lock-cap 强杀);但 `default_permission_mode="auto"` 使 enforce 被短路为「仅提醒+自动续时」(wire 实证 lead_turn_auto_extend_warning)——**用户 2026-08-12 拍板保持 auto 提醒**,硬阻断仅 manual 模式才生效,本条维持现状记录。

## 团队协作:全面 worktree 工作流(2026-08-07 用户拍板)

- **背景**:多名队员并发派工时同改一个工作树(`feat/subagent-team` 主树（本地开发分支）),存在文件区冲突与互相踩踏风险;已完成的工作与进行中的工作混在同一棵树里,验收/回滚粒度粗。
- **同 profile 串行约束(2026-08-12 用户拍板,待代码落实)**:设计意图=**同一 profile 同一时刻只允许一个活跃实例(时序阻塞,任务排队等它完成),不同 profile 之间才并行**;禁止同 profile 复制多实例并行(如 swarm 渐被滥用成「十个顾晚晴同时工作」);目的=保留实例上下文、让成员专注在细分领域;UI 一 profile 一卡片(已实现)。**当前引擎允许同 profile 多实例并行(如 lu-yao 曾 agent-155+agent-176 双实例),需代码层落实串行化约束**(T39)。
- **决策**:全面转向 worktree 工作流——**一个成员(一次派工)一个 git worktree**,在独立 worktree 内完成工作;完工后**由其他员工收尾合并**回主树,**同时清理临时 worktree**。主树只接受经收尾验证的合并,安装构建(全局 pipeline #6)仍只从主树出。
- **落地规程(2026-08-07 已产出)**:设计稿 `.tmp/team-worktree-design-20260807.md`(杜衡,评 95)——分类闸(只读免树)、主管建树、队员树内完工、严戈按退出码机械收尾(merge --no-ff/clean/reap,冲突 exit 3 打回原作者)、`.tmp/team-worktrees.json` JSONL 注册表;手册 `.agents/skills/team-worktree/SKILL.md` 与脚本 `scripts/team-worktree.sh` 均已落地(韩述,评 94,沙箱全链路实测);**install 探针实测 8s**(2026-08-07,pnpm 硬链接 store,远低于 2min 阈值)→ `create` 默认开 install,仅 ≤2 文件微改用 `--no-install`。
- **触发规则(已转强制,2026-08-12 用户拍板)**:触发:派工前 → 动作:分类闸——只读/探索/评审类免树,写代码/写文档/changeset 类主管先跑 `sh scripts/team-worktree.sh create <member> <slug>` 并把输出的「工作树段」一字不改粘进派工单首段;完工后主管在树内验收(diff+重跑测试),通过计分后派严戈 merge/clean/reap 按退出码机械分流(exit 3 原样上报、打回原作者 rebase) → 验收:合并 commit 在主树、`git worktree list` 无残留、主树 status 干净、注册表状态一致。**试点状态(2026-08-12 查实)**:08-07 即满 5 单真实任务+2 探针、08-11 又 10 单,试点早已超额;本会话(08-12)写代码派工未建树属执行疏漏——自本日起**写代码类派工一律强制建树**,机械细节查 `.agents/skills/team-worktree/SKILL.md`。

## 引擎路线:全面 v2(2026-08-07 用户提出,主管附议落盘)

- **背景**:0.33 迁移后出现 v1/v2 双引擎摩擦——老会话 wire 日志中 v1 写入的 `micro_compaction.apply` 记录,v2 回放时不认识只跳过并打 `[unexpected]` 告警;`lead_turn_timeout` 等团队特性疑似迁移掉队。用户提出「全面转向 v2,不要用 v1」。
- **事实**:官方 0.33 基线本身已默认 v2(`apps/kimi-code/src/cli/experimental-v2.ts`,v1 仅在 `KIMI_CODE_LEGACY_FLAG` 下启用;`kimi web` 只跑 kap-server/v2);团队特性 v2 侧已有实现(agent-core-v2/src/agent/tools/agent-swarm 等)。
- **决策**:kimiteam 以 v2 为唯一支持引擎路径——安装链路/launcher 不得设 `KIMI_CODE_LEGACY_FLAG`;新特性只在 v2 路径开发与验证;v1 路径不测试不保证。
- **待确认**:① 是否物理删除 `packages/agent-core`(v1 包)——主管建议**不删**:node-sdk 约 84 处 re-export 依赖它,vis/acp-adapter/migration-legacy 也依赖,且官方仓库仍保留 v1,删除会造成 rebase 官方时巨大分叉;② ~~老会话 wire 记录兼容策略~~ **已定案(2026-08-07)**:v2 wire 层封闭白名单 `LEGACY_SKIPPED_RECORD_TYPES` 静默跳过(`micro_compaction.apply`、`context.update_token_count`),真未知 type 仍上报,韩述落地;③ 迁移丢失特性清单以迁移审计结果为准补齐(已完成 43/44,唯一断线 lead_turn_timeout 已按方向 A 修复)。

## 构建安装授权(2026-08-07 用户拍板)

- **决策**:用户原话「可以随时编译、安装、验证」——全局 pipeline #6 构建安装链(备份、覆盖 `main-team.cjs`、同步 dist-web、grep 验证)无需逐次确认,可随时执行;git commit/push 仍需逐次确认(全局 #5 不变),官方 `main.cjs` 红线不变。

## 已知现象(2026-08-07 排查定案)

- **web 首启输入短暂不回显(自愈)** → 触发:0.33 升级后首启 web,在首屏 snapshot 未加载完(spinner)期间提交消息,乐观气泡被在途快照覆盖,文本暂不显示 → 动作:重启即自愈(新快照含已落盘消息),数据无损坏,属「快照覆盖乐观消息」竞态(`apps/kimi-web/src/lib/snapshotMessages.ts:11-41`,代码注释自带承认 `useKimiWebClient.ts:1588-1601`);**本次不修**;若再现,应用最小修复:mergeSnapshotMessages 保留 `kimiWeb.optimisticUserMessage` 标记的本地乐观消息 → 验收:现象再现时按上述修复,否则维持记录。

## 待办挂账(记录日期 2026-08-07,未启动)

- **官方 0.34.0 升级评估 + 快速 rebase 规程**:背景:kimiteam 在官方 0.33 基线上分叉出团队特性(硬门禁/worktree/状态三态/display_name/lead 时限/Clerical 等),官方 0.34.0 发布后需评估升级内容并 rebase;**决策(用户,2026-08-07):现在不做,挂账**;启动时两件事:① 看 0.34.0 升级了啥(对比 0.33→0.34 changelog/代码事实);② 设计「快速 rebase」规程——产出**团队特性清单化盘点**(分叉面台账,哪些文件/模块是我们的特性)与**可交接的 rebase 操作手册**(步骤化、验收=特性零丢失检查表),目标是**交给任何人执行 rebase 都不丢特性**(弱模型可照表机械执行,与 worktree/SKILL 机械手册同思路) → 验收:0.34.0 评估报告 + 特性台账 + rebase 手册,且手册经一次实操验证零丢失。
