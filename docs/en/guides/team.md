---
url: /kimiteam/docs/en/guides/team.md
---
# Build your team

Coding solo works fine — but when a task grows complex, an AI team lets you assemble roles the way you would in real life: each member gets a title, a system prompt, and a model suited to their work. Then you direct them all from one place.

## Hiring: recruit with a sentence

Tell the main Agent "I need a mail checker" and it auto-decides the name, role, system prompt, and model — writing everything to `~/.kimi-code/agents/<name>.md`. You don't have to author any agent file yourself. If a same-name profile exists, the tool errors instead of silently overwriting.

> **Autonomous team-building discipline**: When a needed capability doesn't have an existing member, the main Agent should autonomously decide the new member's name / role / description / prompt / model and execute the hire directly — without asking you item by item.

The write takes effect immediately. The directory watcher auto-reloads, making the new member dispatchable right away — no CLI restart needed.

Want a subagent to stay on standby in the background while you work elsewhere? Add `duty: true` to that member's agent file. They will run without timeout (polling emails, watching repos, whatever) and won't auto-stop on timeout. You "clock them out" by having the main Agent send `TaskStop`.

## Assigning models: match the task to the tool

Your `[models]` list (defined in `config.toml`) is the pool of available models for your team. Different tasks can be routed to different models:

```toml
[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
max_context_size = 262144

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144
```

To swap a member's model, say: "Coder is too slow on k3, switch to kimi-for-coding." The main Agent updates `[subagent.model_overrides]` — this override **takes priority over the profile's `model_preference`, but below explicitly passed tool parameters**. To pin a member to a specific model permanently, set that id in the agent file's `model_preference` field instead.

| Level | Who controls | Scope |
| --- | --- | --- |
| Tool parameter | Agent on each dispatch | Single call only |
| `[subagent.model_overrides]` | Main Agent via chat command or TeamHire | Persistent, overrides profile default |
| frontmatter `model_preference` | Written into the agent file itself | Persistent |

## Managing on duty: deliver messages, break tasks

Once dispatched, how do you manage?

* **Background by default**: In team mode, the main Agent dispatches subagents to run in the background by default — `run_in_background` is treated as `true` when omitted from the `Agent` tool. The dispatch returns a `task_id` immediately, and the result arrives automatically as a system message. The main Agent stays unblocked and can keep talking to you. Only an explicit `run_in_background=false` makes it wait synchronously.
* **Check progress**: Use `/tasks` (`TaskList`) and `TaskOutput` to inspect running background tasks and their output.
* **Deliver mid-task corrections**: Notice the agent veering off course? The main Agent can use `TeamMessage` to send a note directly into the running subagent's current turn — default is a soft reminder; pass `interrupt: true` to cancel the current turn first, then inject the new instruction (equivalent to pressing ESC twice in the terminal).
* **Adjust concurrency**: Use `TeamConcurrency` to view and dynamically adjust the session-level subagent concurrency cap — run 4 when the machine is idle, dial it down when resources are tight. Combine with the `[subagent] max_concurrency` config in `config.toml` for flexible team throughput control.
* **Clock out**: Use `TaskStop` to stop a running instance. Members with `duty: true` require an explicit `TaskStop` — they won't auto-stop on timeout.

## Performance: score on completion

When work finishes, the main Agent reminds you with the current average score + model used. You can also score manually at any time with `TeamScore` (0–100 with notes).

Each score entry is attributed to the model id actually running at scoring time, persisted to `$KIMI_CODE_HOME/agents/performance.json` — grouped by profile name, each entry carrying timestamp, score, note, and the running model id. In team mode, each subagent run also records an automatic shift entry (duration, work summary, model, concurrency level) in the same file alongside the scores (both capped at FIFO 50), helping you estimate future scheduling. Once team mode is on, the `Agent` tool shows each member's average score directly in the member list.

When a member consistently scores low on a certain model, it signals a poor "member × model" pairing; the main Agent should switch via `[subagent.model_overrides]` or recommend another available id from your `[models]` list.

## /team: status at a glance

Team mode is off by default. Type `/team on` to enable it — the five management tools (`TeamHire`, `TeamFire`, `TeamScore`, `TeamMessage`, `TeamConcurrency`) become visible to the main Agent. Use `/team off` to disable it at any time.

Type `/team` in the terminal to open the team overview panel — every member's role, effective model, average score and count, all visible. Each subagent's call card also shows "name · role · model · last score".

## Next steps

* [Agent field reference](../customization/agents.md) — Complete frontmatter field documentation
* [Configuration — `model_overrides`](../configuration/config-files.md#subagent) — `[subagent.model_overrides]` config details
