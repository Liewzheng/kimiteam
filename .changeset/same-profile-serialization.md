---
"@moonshot-ai/kimi-code": patch
---

Serialize team dispatch per profile: when a member of a profile is already working, further dispatches to that profile wait and reuse the same instance instead of running a parallel one, so each profile has a single active instance at a time while different profiles keep running concurrently.
