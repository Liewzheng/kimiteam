---
"@moonshot-ai/kimi-code": patch
---

TeamScore now supports a penalty action: after acceptance, defects or faults found on a delivered work can deduct a member's performance — an appended negative entry (score = max(0, average − points), note marked `[penalty]` with the reason, model required) that lowers the average without rewriting history, with graded deductions by severity (minor 5-10, moderate 15-20, severe → score below 80 triggering stop-and-observe). Usage: call TeamScore with the penalty action and the defect severity.
