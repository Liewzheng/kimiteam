---
"@moonshot-ai/kimi-code": minor
---

Background dispatch is now fully supported and self-scheduling: AgentSwarm batches run in the background and queue automatically when the pool is full without blocking the lead's turn, and a standby pool picks the next member by least-recently-used rotation weighted by per-model score and load (duty scheduling). Usage: dispatch at high concurrency and the batch queues and runs in the background automatically.
