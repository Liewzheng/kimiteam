---
"@moonshot-ai/kimi-code": patch
---

Interrupt the tech-lead's turn when it spends too long on hands-on work and remind it to dispatch instead. The budget counts execution-class tool time plus every step's LLM generation time (long thinking burns budget even before a tool runs); only dispatch, management, and wait-for-user tool durations are exempt. Usage: tune it with `[subagent] lead_turn_timeout_ms` (default 30s, `0` disables).
