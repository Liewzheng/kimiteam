---
"@moonshot-ai/kimi-code": patch
---

The built-in `agent` profile now renders two distinct roles from one binding: the tech-lead role when bound to the main agent, and a dedicated executor role when dispatched as a subagent. Subagents are explicitly instructed to complete the assigned task end-to-end, never hand it off or substitute process reports for delivery, and to request a reassignment only when the task is truly out of scope. This fixes the agent-archive role conflict where subagents previously inherited the lead's general-manager prompt.
