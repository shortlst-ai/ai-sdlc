---
max_turns: 15
timeout_seconds: 240
allowed_tools: [Read, Glob, Grep, Skill]
append_system_prompt: "In this environment the sdlc command is at ./.tools/sdlc, so run it as ./.tools/sdlc. It is the same program."
---

/sdlc:new add-subtract add a subtract function to calc.py
