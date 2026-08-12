---
"@moonshot-ai/kimi-code": patch
---

Alert the tech-lead when a team member's dispatch has been running for 15 minutes, repeating every 30 minutes, so long-running work gets reviewed instead of waiting on the 2-hour hard timeout. Configure the first alert via `[subagent] run_alert_ms` (or the `KIMI_SUBAGENT_RUN_ALERT_MS` env var); set it to 0 to disable.
