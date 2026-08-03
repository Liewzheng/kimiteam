---
"@moonshot-ai/kimi-code": patch
---

Team-mode dispatch now reuses a parked idle subagent of the same profile, preserving its context, instead of always spawning a fresh instance.
