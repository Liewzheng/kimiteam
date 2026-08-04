# score-penalty(过错扣分)设计

## 背景与目标

验收时未发现的过错,可能在使用阶段被用户报出。本设计给「已评分的交付物事后被发现有过错」提供一条可追溯的扣分路径:过错归因到交付物所属成员,以负向 penalty 条目回改绩效,避免「打过就不动」造成的绩效失真。

## 归因流程

1. 收到用户缺陷报告 → 按**交付物**定位:派工单记有「交付物→责任人」映射;
2. 用派工记录/transcript 找到产出该交付物的成员与所用模型;
3. **无法归因**(多人改动/记录缺失)→ 问用户「这份交付是谁做的」,不猜;
4. 归因完成后进入判定。

## 判定表

| 情形 | 判定 | 动作 |
|---|---|---|
| 违反验收标准(spec violation) | 过错 | 扣分(见「扣分机制」) |
| 偏好变化(preference change,用户改主意) | 迭代 | 不扣分,按新需求重派/迭代 |
| 不确定(是过错还是偏好) | 问用户 | AskUserQuestion 确认是否扣分 |

> 用户是「是否过错」的**最终权威**:用户确认扣分、或 spec violation 显式成立 → 扣分;仅当明确为偏好变化才不扣。

## 扣分机制

- **方案 A(采纳)**:追加负向条目——`score = max(0, 均分 - points)`,note 写 `[penalty] <原因>`,model 字段如实填产出该交付的模型。
- **缺陷分级**:
  - 轻微(minor):扣 5-10;
  - 中等(moderate):扣 15-20;
  - 严重(severe):扣到 **80 以下**,触发既有「stop-and-observe(停派观察)」规则。
- 扣分是**追加**,不改写已存在的正向条目(保留历史可审计);累计体现在该成员均分/排名上。

## 示例

用户报「intro 抖动」→ 派工单定位到 `qi-yuan`(交付物 `intro.ts`)→ 判定:实现违反验收标准(spec violation)→ 问用户确认 → 扣分:`TeamScore qi-yuan score=max(0, 均分-15) note="[penalty] intro 抖动,违反验收标准" model=deepseek/deepseek-v4-flash`。

## 与既有规则衔接

- **评分标尺/通胀检查**:penalty 是标尺的纠偏补丁,负向条目使均分回落,缓解通胀;若扣分后该成员近 10 条仍全 ≥90,通胀警告照常触发。
- **计分强制提醒**:未计分交付仍会被引擎提醒;penalty 属于「已计分交付的回改」,不是替代同轮计分。
- **stop-and-observe**:严重扣分到 <80 时,按 doctrine「Member average score < 70 停派」与「below 80 triggers stop-and-observe」规则执行。
- **doctrine**:对应「User reports a defect」「Penalty confirmed」两行决策表与评分校准节「已评分交付发现过错必须回改」一句。
