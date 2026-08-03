---
"@moonshot-ai/kimi-code": patch
---

Parked subagents now stay resident for 2 hours by default before being reaped (previously 10 minutes), so warm model caches are kept around longer; tune it with `[subagent] idle_ttl_ms` in config.toml.

Usage: add `idle_ttl_ms = 7200000` under `[subagent]` in `~/.kimi-code/config.toml` (milliseconds, positive integer).
