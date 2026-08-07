---
name: team-worktree
description: Use when dispatching tasks in the kimi-code team session and the team-worktree workflow applies: 派工建树、创建 worktree、worktree 合并、收尾合并、清理 worktree、reap 烂尾回收。Covers the read-only dispatch gate (只读派工免树), the five subcommands (create/merge/clean/reap/list) with prechecks and exit codes, the 严戈 merge/clean/reap finishing role's mechanical exit-code dispatch (0/1/2/3, exit 3 = 冲突打回原作者 rebase), the dispatch-sheet 工作树段 template, the .tmp/team-worktrees.json registry state machine, and rollback via list+reap. One dispatch = one tree.
---

# Team Worktree 工作流手册

机械手册:只给步骤、命令、查表答案,不做设计论证。论证与风险清单见 `.tmp/team-worktree-design-20260807.md`(设计稿)。

核心原则:**一派工单一棵树**——写代码的派工强制进独立 worktree,分支 `team/<member>-<slug>-<YYYYMMDD>`,合并收尾由严戈按退出码机械分流。

## 角色与分流

### 分类闸(每次派工前,主管)

| 任务类别 | 是否进 worktree |
|---|---|
| 只读 / 探索 / 评审类(explore、审计、文档核查) | **不进**(无写入,建树纯成本) |
| 写代码 / 写文档 / 写 changeset | **强制进** |

验收:派工单带「工作树段」,或标注「只读免树」。

### 角色分工

| 角色 | 职责 | 关键动作 |
|---|---|---|
| **主管** | 建树 create + 验收 + TeamScore 计分 | `create`(归入开单动作,对 doctrine「主管不执行」的最小豁免);合并前在 worktree 内验收;验收标准由主管在派工单里前馈定义,收尾角色不重新定义 |
| **队员** | 树内完工 + commit + 汇报 | 树内自测 → commit → 汇报(摘要 + 分支名 + 测试结果);验收标准:worktree `git status` 干净、分支领先主树 ≥1 commit |
| **收尾严戈** | merge / clean / reap 按退出码机械分流 | 见「退出码速查」;独立派工单 + 独立 todo_id + 独立计分;不解任何冲突 |

返工:验收不过 → 主管 `resume` 原队员在**同一 worktree** 继续改(worktree 存续期 = 派工到验收通过)。验收(主管,合并前,在 worktree 内):

```sh
git -C <worktree> diff feat/subagent-team...HEAD   # 读全量 diff
```

读全量 diff、按前科抽查、已 install 则重跑关键测试 → 通过则同 turn 计分;不过则 resume 返工。

## 五子命令(`scripts/team-worktree.sh`)

统一前置(脚本内):解析 `MAIN_ROOT=$(git worktree list --porcelain | head -1 | cut -d' ' -f2)`;**断言主树当前分支是 `feat/subagent-team`**,否则中止(防在错误基线操作)。

### `create <member> <slug> [--no-install]` —— 建树(主管,派工前)

- 用途:为一条写代码派工开独立 worktree,并输出派工单「工作树段」模板。
- 参数:`<member>` 成员名;`<slug>` 任务 slug;`--no-install` 跳过 install(纯文案 / ≤2 文件微改)。
- 行为:
  1. `name=<member>-<slug>-<YYYYMMDD>`,`git worktree add .worktrees/<name> -b team/<name>`(从主树当前 HEAD 切出)。
  2. 默认续跑 `pnpm -C <dir> install --frozen-lockfile --prefer-offline` 并计时输出。
  3. 打印「工作树段」模板 → 主管**一字不改**粘贴进派工 prompt。
- precheck:dir 已存在 / 分支已存在(`git show-ref --verify`)→ 中止并提示换 slug;member/slug 校验 `^[a-z0-9][a-z0-9-]*$`(非空、仅小写字母/数字/中划线、不以 `-` 开头)且 slug ≤40 字符;merge/clean/reap 的 `<name>` 同规则(不合法一律 exit 1 用法错)。
- 退出码:0 成功(输出工作树段)/ 1 用法错 / 2 precheck 失败。

### `merge <name>` —— 收尾合并(严戈)

- 用途:把已验收分支合回主树(产生本地 merge commit,**不 push**)。
- precheck(任一失败即中止):主树 `git status --porcelain` **必须为空**(硬中止,主树污染防火墙);worktree 干净;分支存在。
- 行为:`git -C "$MAIN_ROOT" merge --no-ff --no-edit team/<name>`;冲突 → 脚本自动 `git merge --abort`、打印冲突文件、退出码 3。
- 合并成功后(退出码 0)继续:
  1. 在主树跑派工单指定验证(受影响包 `pnpm -C <pkg> test`)。
  2. 验证涉及 CLI 行为且按 `build:packages` 需求(见设计稿 F8)时:由主管另派韩述,收尾不自己跑构建链。
  3. 红 → `git reset --hard ORIG_HEAD` 回退合并(此刻主树无其他改动,reset 安全)→ 按 doctrine 追溯罚分、打回队员。
  4. 绿 → 下一步执行 `clean <name>`。
- 退出码:0 合并成功 / 1 用法错 / 2 precheck 失败 / **3 合并冲突(已自动 abort,打回)**。

### `clean <name>` —— 合并后删树删支(严戈)

- 用途:合并验证通过后,删除 worktree 与已合并分支。
- precheck:`git merge-base --is-ancestor team/<name> HEAD` 未合并 → 中止;worktree 脏 → 中止并提示 reap。
- 行为:`git worktree remove` + `git branch -d`。
- 退出码:0 成功 / 1 用法错 / 2 precheck 失败。

### `reap <name> [--keep-branch]` —— 烂尾回收(严戈,需显式确认)

- 用途:回收未合并/已放弃的 worktree。
- 参数:`--keep-branch` 保留分支、只删树(改动日后可 cherry-pick);**必须带 `--yes` 显式确认,否则不执行**。
- 行为:先打印未合并 commit 清单存档,再 `worktree remove --force` + `branch -D`。
- 退出码:0 回收成功 / 1 用法错(如缺 `--yes`)/ 2 precheck 失败。

### `list` —— 只读审计

- 用途:列出全部 worktree 及每个 `team/*` 分支的 ahead 数与最后提交时间,并 join 注册表。
- 输出:`name | member | todo_id | status | ahead | last_commit`。
- 退出码:0。

## 退出码速查(严戈机械分流)

| 退出码 | 含义 | 对应动作 |
|---|---|---|
| 0 | 成功 | 按子命令续跑(merge 绿 → clean;clean/reap 完成 → 记注册表) |
| 1 | 用法错 | 读 `--help` 自查补参数,或原样上报 |
| 2 | precheck 失败 | **不做任何 git 操作**,原样上报(主树脏/树脏/分支不存在/未合并) |
| 3 | 合并冲突(仅 merge) | 脚本已 `git merge --abort`,**原样上报**,见下方话术模板 |

merge/clean/reap 三者按退出码的动作表:

| 子命令 | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| merge | 主树已合 → 跑验证(绿→clean / 红→reset 回退) | 用法错 | precheck 失败,上报 | 冲突已 abort,原样上报 |
| clean | 收口完成,记 merged | 用法错 | 未合并 / 树脏,上报(树脏提示 reap) | — |
| reap | 回收完成,记 reaped | 用法错(缺 `--yes`) | precheck 失败,上报 | — |

### exit 3 打回话术模板(严戈零判断,原样上报)

> 【merge 冲突打回】`scripts/team-worktree.sh merge <name>` 退出码 3,脚本已自动 `git merge --abort`,冲突文件:<脚本打印的清单原样列出>。
> 处理:请主管 resume 原队员 <member> 在其 worktree 内 `git rebase feat/subagent-team` 解冲突(谁写的谁解),重新交付后轻量复验、重走 merge。收尾不解冲突。

## 派工单「工作树段」模板

`create` 成功时脚本输出;主管把 `<name>` 已替换好的成品**一字不改**粘贴进派工 prompt 首段(派工单 = 既有五要素 + todo_id + 工作树段):

```
【工作树】你的独立工作树：/Users/isletspace/Workspace/github.com/kimi-code/.worktrees/<name>（分支 team/<name>）
- 全程且仅在该路径内操作：Bash 每次调用必须传 cwd=<上述路径>；Read/Edit/Write/Glob/Grep 一律用该路径开头的绝对路径。
- 禁止读写主树 /Users/isletspace/Workspace/github.com/kimi-code 下不属于你工作树的任何文件；git 命令只在你工作树内执行。
- 系统提示中的 git 状态/目录列表以主树为准，忽略它，以你的工作树为准。
- 红线：禁止安装构建链任何步骤（build:packages、kimi-web build、copy-web-assets、build:native、install-kimiteam、写 ~/.kimi-code）；禁止起常驻服务/占端口（dev:kap-server 等），验证只跑 vitest 单次 / tsc --noEmit。
- 完工定义：改动 git commit 到本分支（conventional commit，无 co-author），git status 干净；如改动用户可感知，已按 gen-changesets 生成 .changeset/<task-slug>.md 并一并提交。
```

## 注册表 `.tmp/team-worktrees.json`

- 载体:主树 `.tmp/team-worktrees.json`(`.tmp/` 已 gitignore,AGENTS.md 既定 scratch 位;不污染仓、不进 diff)。
- 格式:**JSONL,一行一记录**(并发追加不整文件重写)。

```jsonl
{"name":"yan-ge-t10-write-order-20260807","branch":"team/yan-ge-t10-write-order-20260807","dir":".worktrees/yan-ge-t10-write-order-20260807","member":"yan-ge","slug":"t10-write-order","todo_id":"12","install":true,"status":"active","created_at":"2026-08-07T10:00:00+08:00"}
```

- 字段:`name / branch / dir / member / slug / todo_id / install / status / created_at`;merge 后补 `merged_at / merge_sha`。

### 状态机

```
active → delivered → merged
               ↘ reaped
```

| 变迁 | 写入时机 | 写状态行 |
|---|---|---|
| active | `create` | create |
| delivered | 队员汇报后、主管验收时 | 主管/脚本 |
| merged | `clean` 成功 | clean |
| reaped | `reap` 成功 | reap |

- 维护:脚本五个子命令各自写一行状态变迁,**只追加、不改历史行**;当前状态取每个 `name` 的最后一行。
- `list` 输出 join 注册表:`name | member | todo_id | status | ahead | last_commit`——烂尾审计与主管跨会话重建上下文都靠它。
- 不做:不进 `.git/` 元数据、不进仓内跟踪文件。

## 异常路径速查

| 症状 | 处理 |
|---|---|
| 主树 `git status` 非空 | merge 硬中止(precheck 失败,退出码 2)——主树污染防火墙;上报主管,不 merge |
| worktree 脏 | `clean` 拒(precheck 失败)并提示 `reap`;主管决定 `reap` 或 resume |
| 分支未合并 | `clean` 拒;走 merge 或按烂尾评估 reap |
| 烂尾(有未合并 commit 且有残值) | `reap <name> --keep-branch --yes`(保留分支可 cherry-pick) |
| 烂尾(无残值) | `reap <name> --yes` |
| 合并冲突 | merge 退出码 3,已自动 abort,原样上报 → 原作者 rebase 解冲突 |
| 非 auto 权限模式 | 主管预批 `git -C .worktrees/*` 规则后才开 worktree 批次,否则不开 |

### 红字警告

- **主树内禁止 `git clean -fdx`**——会连 `.worktrees/` 一起 nuke。
- 严戈不解任何冲突(exit 3 原样上报)。
- 队员红线:禁止安装构建链任何步骤、禁止起常驻服务/占端口(写死在派工单工作树段)。
- 只读/探索/评审派工不进 worktree。
- 收尾只产生本地 commit,push 仍需用户确认(全局 pipeline #5 不变)。

## 回退预案

系统性故障 → 一句话退回现行「同树分区纪律」(doctrine 原文仍在);在制 worktree 分支用 `list` + `reap` 逐个收口,无不可逆状态。

## 验证清单(每批收口前)

1. `sh scripts/team-worktree.sh list` 审计:每个在制 worktree 的 `member / todo_id / status` 与派工单对应;烂尾项已进 reap 流程。
2. `git worktree list`:无本批之外的残留 worktree。
3. 主树 `git status` 干净:脏了即「纪律失效事件」,记录并追查后再继续 merge。
