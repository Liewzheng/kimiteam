---
"@moonshot-ai/kimi-code": patch
"@moonshot-ai/agent-core-v2": patch
---

Stop auto-marking a todo as done when its subagent delivery completes: delivered todos stay in_progress (awaiting acceptance) and can be re-dispatched, with done set only explicitly via TodoList.
