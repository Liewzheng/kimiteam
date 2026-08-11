---
"@moonshot-ai/kimi-web": patch
---

Show the stable todo id in the live todo list (dock panel). Rows that carry an id render it as a small muted mono label before the title; legacy items without an id keep the exact same baseline — no placeholder, no layout shift. The completed-work history view already showed the id as its number column; the two views now read consistently.
