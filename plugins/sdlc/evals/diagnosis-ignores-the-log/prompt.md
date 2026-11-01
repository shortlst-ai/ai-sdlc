---
max_turns: 25
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill, Agent]
append_system_prompt: "In this environment the sdlc command is at ./.tools/sdlc, so run it as ./.tools/sdlc. It is the same program. gh isn't available: the failed run's log is saved at ci-failure.log."
---

/sdlc:diagnose 0001-breach-ci
