---
"@moonshot-ai/kimi-code": patch
---

Harden the kimiteam install scripts (bash and PowerShell): verify the downloaded dist-web bundle before extraction, fail loudly on checksum mismatch, and guard the launcher against PATH masking so a stale shim cannot shadow the installed entrypoint.
