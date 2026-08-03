---
"@moonshot-ai/kimi-code": patch
---

Team-mode dispatch now survives a process restart: a subagent parked as resting before the restart is found again and reused by profile, preserving its context, instead of being lost to a fresh spawn. Older sessions that predate profile labels degrade to a fresh spawn rather than erroring.
