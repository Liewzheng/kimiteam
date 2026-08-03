---
"@moonshot-ai/kimi-code": minor
---

Pipeline instructions are now loaded into every session at start: the global `~/.kimi-code/pipeline.md` and the project-level `.kimi-code/pipeline.md` are injected into the system prompt, so your build, test, release, and team workflows are followed without re-explaining them. Missing files are skipped silently. Put your standard workflow steps in either file to have them applied automatically.
