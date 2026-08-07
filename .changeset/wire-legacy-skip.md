---
"@moonshot-ai/kimi-code": patch
---

Silently skip known legacy v1 wire record types (such as `micro_compaction.apply` and `context.update_token_count`) when restoring old sessions instead of logging `[unexpected]` warnings; genuinely unknown record types are still reported.
