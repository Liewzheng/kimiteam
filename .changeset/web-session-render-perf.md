---
"@moonshot-ai/kimi-code": patch
---

Make the web UI rebuild only the active streaming turn instead of the whole transcript on each text delta, and size off-screen turn placeholders by line count so mounting long code and tool output no longer jumps the layout.
