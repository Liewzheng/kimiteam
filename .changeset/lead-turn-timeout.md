---
"@moonshot-ai/kimi-code": patch
---

Interrupt the tech-lead's turn when it spends too long on execution (file reads/writes, edits, commands) and remind it to dispatch instead; dispatch, management, and wait-for-user time never counts toward the budget. Usage: tune it with `[subagent] lead_turn_timeout_ms` (default 30s, `0` disables).
