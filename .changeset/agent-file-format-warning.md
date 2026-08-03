---
"@moonshot-ai/kimi-code": patch
---

The CLI now warns when it finds a `.yaml`/`.yml` agent profile and suggests the `.md` rename — YAML agent files are never loaded (only Markdown is), so the warning surfaces the misconfiguration instead of silently ignoring the file.
