---
"@moonshot-ai/kimi-code": patch
---

Speed up session switching in the web UI: cache the chat pane per session, resume event-stream subscriptions instead of re-fetching the snapshot, and cache server-side message folds so re-opens skip full transcript reads. Member work status is now isolated per session.
