---
"@moonshot-ai/kimi-code": patch
---

Attach the originating session id to every TeamScore performance entry (both `record` and `penalty`), filled from the session context rather than the caller's arguments so it cannot be forged — useful for tracing which session produced a score.
