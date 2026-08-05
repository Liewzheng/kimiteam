---
"@moonshot-ai/kimi-code": minor
---

Add proactive team management: with `/team auto` on, once the lead stays idle past `[subagent] auto_idle_ms` (default 300s) the engine prompts it to review the project and apply one bounded improvement, and the doctrine now treats every user request as a dispatch opportunity by default, never waiting for the words "dispatch" or "派工". Usage: run `/team auto` to toggle, tune `auto_idle_ms` under `[subagent]`.
