---
"@moonshot-ai/kimi-code": patch
---

Parked subagents now stay warm: the engine periodically wakes resting members (`[subagent] warm_interval_ms`, default 30 min) with a zero-disruption ping (thinking off, 1 token) so long idle periods no longer lose the provider KV-cache, and duty members are never reaped by default (`[subagent] duty_idle_ttl_ms`, `0` = never). Usage: tune `warm_interval_ms` and `duty_idle_ttl_ms` under `[subagent]` in config.toml.
