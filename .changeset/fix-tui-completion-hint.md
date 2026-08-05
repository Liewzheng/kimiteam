---
"@moonshot-ai/kimi-code": patch
---

Fix the completion hint disappearing after a subagent finishes: the notification is no longer dropped by an event race, so you always see when a background task completes.
