/* =====================================================================
   kimiteam · landing i18n — 简体中文（源文案 / 默认）
   Key conventions (single source of truth for every language file):
     - Dot-namespaced:  common.* / nav.* / footer.* / meta.* / vl.*
                       / index.* / quickstart.* / features.*
     - Keep untranslated (verbatim) in ALL languages:
         commands & flags (kimiteam, kimi, install-kimiteam.sh …),
         file paths, URLs, product/brand names (Kimiteam, Kimi Code,
         Subagent, AgentSwarm, TeamScore, score_gate, model_overrides),
         model ids (kimi-k2), numbers/versions, the four lifecycle states
         (working/resting/on-duty/off-duty), English section eyebrows
         (WORKFLOW, INSTALL …), terminal transcript lines, seal text.
     - HTML pages reference keys via data-i18n="key" (textContent) and
       data-i18n-attr="attr:key;attr2:key2" (attributes).
   This file is the reference: translators copy its key set and translate
   every value. Never add/remove/rename keys.
   ===================================================================== */
window.LANDING_I18N = window.LANDING_I18N || {};
LANDING_I18N['zh-CN'] = {

  /* ---------- shared ---------- */
  'skip.link': '跳到正文',
  'nav.aria': '主导航',
  'nav.toggle': '菜单',
  'nav.index': '总览',
  'nav.features': '特性',
  'nav.quickstart': '快速部署',
  'nav.docs': '文档',
  'nav.github': 'GitHub ↗',
  'lang.aria': '切换语言',
  'brand.aria': 'kimiteam 首页',
  'footer.col.site': '站点',
  'footer.col.project': '项目',
  'footer.tagline': '给官方 Kimi Code CLI 装上团队能力的社区发行版。',
  'footer.license': 'MIT · 开源，自由使用',
  'footer.baseline': '基于官方 Kimi Code 0.33 基线（v0.33.0）· Node ≥ 24',
  'footer.motto': '一个命令，一支团队。',
  'cta.quickstart': '快速部署',
  'cta.github': 'GitHub',
  'common.copy': '复制',
  'common.copied': '已复制',
  'common.copyFail': '失败',
  'common.copyAria': '复制命令',

  /* ---------- meta ---------- */
  'meta.index.title': 'kimiteam — 给官方 Kimi Code CLI 装上团队能力',
  'meta.index.desc': 'kimiteam 是官方 Kimi Code CLI 的社区发行版：多 Subagent 独立角色/模型/上下文，主模型派工默认后台并行，/team 面板管理团队，TeamScore 绩效与 score_gate 验收门禁。MIT 开源，Node ≥ 24。',
  'meta.features.title': '特性 — kimiteam',
  'meta.features.desc': 'kimiteam 核心特性：多智能体独立角色与模型分工、后台并行派工、TeamScore 绩效与通胀检测、score_gate 验收门禁、具名名册与四态生命周期、技能与 memory 复用、TUI + Web 双形态。',
  'meta.quickstart.title': '快速部署 — kimiteam',
  'meta.quickstart.desc': 'kimiteam 安装：macOS/Linux 一键脚本、Windows irm 短链、Release 手动下载；首次启动 4 问组建团队，kimiteam --version 验证。',

  /* ---------- vertical section labels ---------- */
  'vl.team': '团队',
  'vl.workflow': '工作流',
  'vl.score': '绩效',
  'vl.features': '特性',
  'vl.design': '设计',
  'vl.start': '部署',
  'vl.install': '安装',
  'vl.verify': '验证',

  /* ================= index ================= */
  'index.hero.eyebrow': 'KIMITEAM · 官方 KIMI CODE CLI · SUBAGENT 团队',
  'index.hero.title.l1': '一句话，',
  'index.hero.title.l2a': '管理一个',
  'index.hero.title.l2b': '团队',
  'index.hero.title.l2c': '。',
  'index.hero.sub': '主模型派工默认后台并行；每个 Subagent 独立角色、模型与上下文，/team 面板统一管理——绩效记账、门禁验收、全生命周期一目了然。',
  'index.hero.meta1': 'MIT 开源',
  'index.hero.meta2': '基于官方 0.33 基线',
  'index.hero.meta3': 'TUI · Web 双形态',
  'index.hero.meta4': '后台并行派工',
  'index.recLabel': 'bash · 推荐安装',
  'index.recOther': '其他平台 →',
  'index.recBinary': '下载二进制 →',
  'index.terminal.title': 'kimiteam · 团队会话',
  'index.stats.aria': '核心卖点',
  'index.stats.label1': '官方 Kimi Code 基线',
  'index.stats.label2': '停靠记忆 TTL（KV-cache 保活）',
  'index.stats.label3': '成员四态生命周期',
  'index.stats.label4': 'TeamScore 满分',
  'index.stats.note': '基于官方 0.33 基线（v0.33.0）· Node ≥ 24 · 详见',
  'index.stats.note.link': '特性',
  'index.workflow.h2': '四步，把 CLI 变成一支团队。',
  'index.workflow.lead': '从冷启动到绩效闭环，kimiteam 把「团队」变成 CLI 的一等能力。',
  'index.workflow.s1.title': '组建',
  'index.workflow.s1.desc': '首次启动 4 问快速定义团队：角色、模型、职责与工位——主模型据此派工。',
  'index.workflow.s2.title': '派工',
  'index.workflow.s2.desc': '主模型派工默认后台并行；Agent 池满入队，standby 成员按权重加权选人。',
  'index.workflow.s3.title': '验收',
  'index.workflow.s3.desc': 'score_gate 硬门禁：不达标的任务被拦截，避免低质量结果继续扩散。',
  'index.workflow.s4.title': '绩效',
  'index.workflow.s4.desc': 'TeamScore 0–100 记账：通胀检测、扣分、未计分引擎提醒，绩效可追溯。',
  'index.score.eyebrow': 'TEAMSCORE · 真实输出',
  'index.score.h2': '分数记账，团队可见。',
  'index.score.lead': '每位成员的得分进入同一本账：评分、通胀告警、扣分、门禁拦截，全部落印可查。',
  'index.seal.hero.aria': '团队绩效 88/100',
  'index.cta.h2': '装上团队，现在就跑。',
  'index.cta.p': '一条命令装好，首次启动 4 问组队，然后交给后台并行。',

  /* ================= quickstart ================= */
  'quickstart.hero.eyebrow': 'QUICKSTART · 安装 → 组队 → 派工',
  'quickstart.hero.title.l1': '一条命令，',
  'quickstart.hero.title.l2': '装好一支团队。',
  'quickstart.hero.sub': '三种安装方式任选其一；装完运行 kimiteam，4 问组队即可派工。',
  'quickstart.install.eyebrow': 'INSTALL · 三选一',
  'quickstart.install.h2': '装到官方 kimi 旁边。',
  'quickstart.recBadge': '推荐 · 你的系统',
  'quickstart.install.c1.label': 'bash · 一键脚本（macOS / Linux）',
  'quickstart.install.c1.note': '自动下载 Release kimiteam-dev 最新分发，安装到官方 kimi CLI 旁；官方二进制与 bundle 原样保留。',
  'quickstart.install.c2.label': 'powershell · Windows（irm 短链）',
  'quickstart.install.c2.m1': '# 方式 1 · irm 短链',
  'quickstart.install.c2.m2': '# 方式 2 · raw 长链（备选）',
  'quickstart.install.c2.m3': '# 方式 3 · 下载后以 -File 运行',
  'quickstart.install.c3.label': 'Release · 手动下载',

  'quickstart.install.c3.cm': '# 资产清单',  'quickstart.install.c3.desc': '从 kimiteam-dev 发布页下载资产（main-team.cjs + dist-web.zip），解压到官方 kimi 旁即可。',
  'quickstart.install.c3.link': '打开 Release 页',
  'quickstart.first.eyebrow': 'FIRST RUN · 组队与验证',
  'quickstart.first.h2': '首跑，组队，验证。',
  'quickstart.first.lead.a': '运行',
  'quickstart.first.lead.b': '完成冷启动 4 问后，用',
  'quickstart.first.lead.c': '验证安装版本。',
  'quickstart.first.cm1': '# 首跑：冷启动 4 问，组建你的团队',
  'quickstart.first.cm2': '# 验证版本',
  'quickstart.cta.h2': '团队就绪？',
  'quickstart.cta.p': '4 问组队后，主模型就开始后台并行派工。',

  /* ================= features ================= */
  'features.hero.eyebrow': 'FEATURES · 能力清单',
  'features.hero.title.l1': '每个 Subagent，',
  'features.hero.title.l2': '各司其职。',
  'features.hero.sub': '十项能力，六章讲完：从独立角色到绩效闭环，全部在官方 CLI 之上原生运行。',
  'features.f1.k': 'SUBAGENTS · 独立角色与模型分工',
  'features.f1.h3': '每个 Subagent，都有自己的角色、模型与上下文。',
  'features.f1.body': '名册里每位成员都是具名工程师：独立 role、独立 model、独立上下文窗口。模型分工用 [subagent.model_overrides] 三级优先配置，主模型按职责派工。',
  'features.f2.k': 'PARALLEL DISPATCH · 后台并行派工',
  'features.f2.h3': '派工默认后台并行。',
  'features.f2.body': '主模型派工即建 Agent / AgentSwarm 任务，默认后台并行执行；Agent 池满时任务入队等待，standby 成员按权重加权选人，不空转、不阻塞主流程。',
  'features.f3.k': 'TEAMSCORE · 绩效与通胀检测',
  'features.f3.h3': '分数记账，通胀无处遁形。',
  'features.f3.body': '每位成员按 0–100 记账：连续高分触发通胀检测，异常扣分入账，未计分引擎主动提醒。',
  'features.f3.sample': 'TeamScore 记账 · 真实输出',
  'features.f4.k': 'ACCEPTANCE GATE · score_gate 硬门禁',
  'features.f4.h3': '不达标，不放行。',
  'features.f4.body': 'score_gate 作为验收硬门禁：未达到阈值的任务被拦截，低质量结果不会继续扩散。',
  'features.f4.sample': '门禁拦截 · 真实输出',
  'features.f5.k': 'ROSTER · 具名名册与四态生命周期',
  'features.f5.h3': '谁在干活，谁在休息，一目了然。',
  'features.f5.body': '具名工程师名册 + 四态生命周期：working / resting / on-duty / off-duty。/team 面板实时呈现每位成员的岗位、模型、均分与当前状态。',
  'features.f6.k': 'SKILLS & MEMORY · 技能注入与停靠复用',
  'features.f6.h3': '会技能，也记得住。',
  'features.f6.body': '技能体系走两级 pipeline 注入 + model-roster；memory 与停靠复用（KV-cache 保活、TTL 2h）让成员记得上轮上下文。TUI 与 Web 双形态，onboarding 冷启动 4 问即可「组建我的团队」。',
  'features.cta.h2': '十项能力，六章讲完。',
  'features.cta.p': '从独立角色到绩效闭环，装好即可体验。'
};
