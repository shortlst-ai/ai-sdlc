---
description: How the lead spawns the factory's roles. Use when a stage skill says to spawn a role.
user-invocable: false
---

You stay the team lead. Only you can talk to the person, so every gate stays with you.

Call the Agent tool with both a `name` and a `subagent_type`, such as `name: builder-api` and `subagent_type: sdlc:builder`. With agent teams on, the `name` is what makes it a teammate. Don't pass `isolation`, which would make it a plain subagent.

When teams are off, as in CI, the same call runs a subagent, so nothing else changes.

Always use the `sdlc:` agent type. In a team, a teammate without one can't write files.

Rules for either way:

- Give each role the work item folder and everything it needs. It can't see this conversation
- Wait for it to finish, and don't do its job yourself
- Before spawning, check that role isn't still running. Being run again doesn't mean it stopped, and a second builder on one slice overwrites the first
- A resumed session loses its teammates. The work is in Git, so spawn them again
- Shut teammates down when the stage is finished
- Tell each role to run one command at a time, because a chained command stops at a permission prompt
