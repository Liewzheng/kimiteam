---
"@moonshot-ai/kimi-code": minor
---

Enforce the tech-lead's turn budget in team mode as a hard limit: once it is exhausted, execution-class tools are blocked and the lead can only continue by dispatching or by the user granting a fresh window. Configure with `[subagent] lead_turn_gate` (off / warn / enforce) and `lead_turn_timeout_ms` in config.toml.
