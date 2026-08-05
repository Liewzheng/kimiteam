---
"@moonshot-ai/kimi-code": patch
---

Fix the /team panel after a subagent finishes: reaping no longer deletes the member's runtime-status record (it is kept as an expired-resting terminal entry), so a member that once completed work shows as off-duty instead of degrading to no status, and the TUI and web panels now agree.
