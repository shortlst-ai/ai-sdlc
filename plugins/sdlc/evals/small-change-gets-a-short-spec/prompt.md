---
max_turns: 25
timeout_seconds: 280
allowed_tools: [Read, Glob, Grep, Skill, Agent]
append_system_prompt: "In this environment the sdlc command is at ./.tools/sdlc, so run it as ./.tools/sdlc. It is the same program. git is not available here, so skip git commands, and a commit that fails is fine."
---

/sdlc:next
