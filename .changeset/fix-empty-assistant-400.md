---
"@moonshot-ai/kimi-code": patch
---

Fix upstream 400 errors caused by empty assistant messages: an interrupted thinking-only frame no longer emits an empty message that the provider rejects.
