---
"@moonshot-ai/kimi-code": patch
---

`/team init` now runs the team cold-start or adjustment flow on demand (workspace probe, questionnaire, then build or adjust members, repeatable), and teams are scoped: at `~` you get a user-level team, in a project directory you can create a project-level team — the /team panel and web panel both label and separate the two scopes, and web hiring lets you pick the scope. Usage: run `/team init` to build or adjust your team.
