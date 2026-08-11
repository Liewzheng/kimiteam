---
"@moonshot-ai/kimi-web": patch
---

Fix the session-switch lag in the web chat: derived views (turns / tasks / todos / todo-history / swarms) are now cached per session, so switching back to a session whose data is unchanged hands the pane stable prop references and Vue skips the whole-subtree re-render instead of rebuilding every message. Long transcripts also lazy-mount off-screen turns (a sized placeholder is shown until each turn scrolls near the viewport), so opening a large session no longer parses and tokenizes every message's markdown on the main thread.
