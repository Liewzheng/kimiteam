---
"@moonshot-ai/kimi-code": minor
---

Gate TeamScore records behind verifiable acceptance evidence: before recording a score, the tech-lead must have performed a detectable acceptance action (reading the delivery output or diff, or rerunning tests) since the member finished; records without evidence are rejected. Penalty entries are exempt. Tune with `[subagent] score_gate` (`off` / `warn` / `enforce`, default `enforce`).
