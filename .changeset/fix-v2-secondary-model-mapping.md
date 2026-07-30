---
"@moonshot-ai/kimi-code-sdk": patch
---

Fix v2 `getConfig` dropping the `secondaryModel` section from the resolved config, so secondary-model settings now survive on the v2 engine (also fixes the `/config` secondary model display under v2).
