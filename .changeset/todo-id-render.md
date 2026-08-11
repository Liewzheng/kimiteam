---
"@moonshot-ai/kimi-code": patch
---

Show the stable todo id in every rendered TodoList line (query and update modes) and in the todo-list stale reminder, replacing the positional "1. / 2." numbering that invited bogus `todo_id` guesses. The lead can now copy the id straight from the output and dispatch with it; explicit ids already written are echoed back unchanged.
