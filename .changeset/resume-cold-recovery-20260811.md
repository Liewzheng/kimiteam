---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/agent-core-v2": patch
---

Explicitly resuming a lost subagent after a restart now rebuilds it from the persisted session metadata and its saved context, instead of failing with an agent-not-found error.
