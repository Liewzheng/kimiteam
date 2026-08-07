---
"@moonshot-ai/kimi-code": minor
---

Upgrades the team build to the official 0.33 baseline (v2 engine default with `KIMI_CODE_LEGACY_FLAG` fallback, UTF-16 text reads, Kimi Computer Use on Windows, v2 sessions API) while keeping the team web UI (`apps/kimi-web`) and its build chain. Also tolerates standalone bundles without a package.json (`~/.kimi-code/lib/kimi/`): `kimi web` starts API-only and version/update-source detection degrades to `unsupported` instead of crashing.
